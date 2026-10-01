/** Page verbs an agent reaches for, driven through the js MCP tool against a
 * real headless Chromium: waits, name patterns, page scripts, inspection,
 * hover, HTML5 and pointer drags, scrolling, refs across screenshots and
 * compact discovery. Run: tsx scripts/test-control-page-verbs.ts */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createControlRuntime } from "@mako/control-runtime"
import { createControlMcpServer } from "@mako/control-runtime/mcp"
import {
  readControlSession,
  invokeControlSession,
  serveControlSession,
} from "@mako/control-runtime/session"

const executable =
  process.env.CHROMIUM_EXECUTABLE ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium")
if (!existsSync(executable)) {
  console.log(
    `Page verbs skipped: no Chromium at ${executable}; set CHROMIUM_EXECUTABLE`
  )
  process.exit(0)
}

const html = `<title>Live</title>
<button>Inbox <span>3</span></button>
<div role=button aria-label="Hover zone" onmouseenter="document.getElementById('menu').hidden=false" style="padding:10px;width:120px">Hover me</div>
<div id=menu hidden role=menu aria-label="Actions"><button>Rename</button></div>
<ul><li id=h5 draggable=true aria-label="Card A">Card A</li></ul>
<div id=drop role=region aria-label="Done column" style="width:200px;height:80px;border:1px solid">Drop</div>
<div id=p role=button aria-label="Pointer card" style="position:absolute;left:300px;top:20px;width:80px;height:40px;background:#ccc;touch-action:none">P</div>
<div id=ptarget role=region aria-label="Pointer target" style="position:absolute;left:300px;top:200px;width:120px;height:80px;border:1px solid">T</div>
<a href="/docs" style="color: rgb(255, 0, 0)">Docs</a>
<div style="height:3000px"></div>
<button>Far away</button>
<script>
const drop=document.getElementById('drop');drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',e=>{e.preventDefault();document.title='dropped:'+e.dataTransfer.getData('text/plain')});
document.getElementById('h5').addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','A'));
let dragging=false;const p=document.getElementById('p');
p.addEventListener('pointerdown',e=>{dragging=true;p.setPointerCapture(e.pointerId)});
p.addEventListener('pointermove',e=>{if(dragging){p.style.left=(e.clientX-40)+'px';p.style.top=(e.clientY-20)+'px'}});
p.addEventListener('pointerup',e=>{dragging=false;const t=document.getElementById('ptarget').getBoundingClientRect();window.pointerDropped=e.clientX>=t.left&&e.clientX<=t.right&&e.clientY>=t.top&&e.clientY<=t.bottom});
setTimeout(()=>{const d=document.createElement('p');d.textContent='Loaded later';document.body.prepend(d)},800);
</script>`
// A data URL longer than the observation's URL limit: shortening the tab URL
// must not mark element text incomplete.
const url = `data:text/html,${encodeURIComponent(html)}`
assert.ok(url.length > 2048)

const root = await mkdtemp(join(tmpdir(), "mako-page-verbs-"))
const chromium = spawn(
  executable,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(root, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
)
const endpoint = await new Promise<string>((resolve, reject) => {
  let stderr = ""
  const timeout = setTimeout(
    () => reject(new Error("Chromium startup timed out")),
    15_000
  )
  chromium.once("error", reject)
  chromium.once("exit", () =>
    reject(new Error("Chromium exited before its endpoint"))
  )
  chromium.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384)
    const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
    if (match) {
      clearTimeout(timeout)
      resolve(match[1]!)
    }
  })
})
const runtime = createControlRuntime({
  artifacts: join(root, "artifacts"),
  browsers: [
    { id: "live", name: "Live Chromium", endpoint: async () => endpoint },
  ],
})
const owner = await serveControlSession(runtime)
const descriptor = await readControlSession(owner.file)
const server = createControlMcpServer((operation, signal) =>
  invokeControlSession(
    descriptor,
    operation,
    signal ?? new AbortController().signal
  )
)
const client = new Client({ name: "page-verbs", version: "1" })
const [agentTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
await client.connect(agentTransport)
const js = async (code: string) => {
  const result = (await client.callTool({
    name: "js",
    arguments: { code, timeout_ms: 30_000 },
  })) as {
    isError?: boolean
    content: Array<{ type: string; text?: string }>
  }
  const texts = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
  return {
    error: result.isError === true,
    text: texts.join("\n"),
    value: () => JSON.parse(texts.at(-1)!),
  }
}
try {
  assert.match(
    (await js("await control.browsers()")).text,
    /Mako browser and computer use/
  )
  const open = await js(
    `await control.connectBrowser("live"); const tab = await control.openTab({browser:"live", url:${JSON.stringify(url)}}); await tab.observe({interactive:true})`
  )
  assert.equal(open.error, false, open.text)
  assert.doesNotMatch(
    open.text,
    /Mako browser and computer use|Observation has nodes/,
    "action results carry no guides"
  )

  const waited = await js(
    `await tab.waitFor({text:"Loaded later"},{timeoutMs:10000})`
  )
  assert.equal(waited.error, false, waited.text)
  const missed = await js(
    `await tab.waitFor({text:"Never shown"},{timeoutMs:300})`
  )
  assert.equal(missed.error, true)
  assert.equal(JSON.parse(missed.text).code, "assertion-failed")

  const live = await js(
    `await tab.locator({role:"button",name:{prefix:"inbox"}}).click(); (await tab.observe({match:{role:"button",name:/^Inbox \\d+$/}})).nodes.map((node) => node.name)`
  )
  assert.equal(live.error, false, live.text)
  assert.deepEqual(live.value(), ["Inbox 3"])

  assert.equal(
    (await js(`await tab.evaluate((a, b) => a + b, 2, 3)`)).value(),
    5
  )
  const thrown = await js(`await tab.evaluate("null.x")`)
  assert.equal(thrown.error, true)
  assert.match(
    JSON.parse(thrown.text).message,
    /^Page script threw TypeError: Cannot read properties of null .* at line 1, column \d+/
  )

  const inspected = await js(
    `await tab.locator({role:"link",name:"Docs"}).inspect({attributes:["href"],styles:["color"]})`
  )
  assert.equal(inspected.error, false, inspected.text)
  const facts = inspected.value()
  assert.deepEqual(
    [facts.tag, facts.attributes.href, facts.styles.color, facts.visible],
    ["a", "/docs", "rgb(255, 0, 0)", true]
  )

  const hovered = await js(
    `await tab.locator({role:"button",name:"Hover zone"}).hover(); await tab.expect({role:"menu",name:"Actions"},{timeoutMs:2000})`
  )
  assert.equal(hovered.error, false, hovered.text)

  const html5 = await js(
    `const html5 = await tab.locator({role:"listitem",name:"Card A"}).dragTo(tab.locator({role:"region",name:"Done column"})); [html5.status, html5.result.mode, await tab.evaluate("document.title")]`
  )
  assert.equal(html5.error, false, html5.text)
  assert.deepEqual(html5.value(), ["dispatched", "html5", "dropped:A"])
  const pointer = await js(
    `const pointer = await tab.locator({role:"button",name:"Pointer card"}).dragTo(tab.locator({role:"region",name:"Pointer target"})); [pointer.status, pointer.result.mode, await tab.evaluate("window.pointerDropped")]`
  )
  assert.equal(pointer.error, false, pointer.text)
  assert.deepEqual(pointer.value(), ["dispatched", "pointer", true])

  const scrolled = await js(
    `(await tab.locator({role:"button",name:"Far away"}).scrollIntoView()).result.scrollY`
  )
  assert.equal(scrolled.error, false, scrolled.text)
  assert.ok(scrolled.value() > 1000)

  const kept = await js(
    `const view = await tab.observe({interactive:true}); await tab.screenshot(); await tab.click(view.get({role:"button",name:"Far away"}).ref); true`
  )
  assert.equal(kept.error, false, `a page screenshot keeps refs: ${kept.text}`)
  const blind = await js(`await tab.click({x:5,y:5,view:"viewport"})`)
  assert.equal(blind.error, true)
  assert.equal(JSON.parse(blind.text).code, "missing-view")

  const listed = (await js(`await control.tabs("live")`)).value()
  assert.ok(listed.pages.length >= 1)
  for (const page of listed.pages)
    assert.deepEqual(Object.keys(page).sort(), [
      "claimed",
      "tab",
      "title",
      "url",
    ])

  const saved = await js(
    `artifacts.save("buttons", await tab.evaluate(() => [...document.querySelectorAll("button")].map((button) => button.innerText)))`
  )
  assert.equal(saved.error, false, saved.text)
  assert.match(saved.value().path, /buttons/)
  console.log(
    "Page verbs: waitFor, name patterns, evaluate, inspect, hover, HTML5 and pointer drag, scrollIntoView, refs across screenshots, view tokens, compact tabs and artifacts passed against real Chromium"
  )
} finally {
  await client.close()
  await server.close()
  await owner.close()
  await runtime.close()
  const exited = new Promise((resolve) => chromium.once("exit", resolve))
  chromium.kill()
  await exited
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
