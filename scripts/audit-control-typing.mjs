import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { resolveExecutable } from "../dist-electron/executable.js"
import {
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"
import { BrowserService } from "../packages/control-runtime/dist/browser-service.js"
import { startControlService } from "../dist-electron/control-service.js"
import {
  frontmostPid,
  sampleFrontmost,
  startElectronFixture,
} from "./lib/control-fixture.mjs"

// Compare raw native driver writes with page input. Raw calls deliberately
// bypass the high-level web-text refusal so this audit can expose driver faults.
// Fixture files supply independent renderer-state oracles.
const root = await mkdtemp(join(tmpdir(), "mako-typing-audit-"))
const page = await startElectronFixture({
  root,
  name: "typing",
  title: "Mako typing audit",
  policy: "prohibited",
  start: false,
})
const client = new ControlCliProbe({ name: "typing-audit", version: "1" })
const service = await startControlService(new BrowserService([]), () => {})
let pagePid
let samples
const evidence = { status: "running", cells: [], writes: [] }
const read = async (path) => JSON.parse(await readFile(path, "utf8"))
async function until(fn) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Fixture state did not match before deadline")
}
async function cell(source, image = false) {
  const started = performance.now()
  let result = await client.request({method:"exec",arguments:{ source }}, { timeout: 70_000 })
  // Collect the runtime's text receipt without replaying source.
  
  assert.ok(!result.isError, JSON.stringify(result))
  if (image) {
    assert.ok(
      result.content.some((block) => block.type === "image"),
      "explicit image emission"
    )
    assert.ok(
      result.content.some(
        (block) => block.type === "text" && block.text.includes('"view"')
      ),
      "image preserves its coordinate view token"
    )
  }
  evidence.cells.push({
    milliseconds: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(JSON.stringify(result.content)),
    image,
  })
  return JSON.parse(
    result.content.filter((block) => block.type === "text").at(-1).text
  )
}
try {
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.audit")
  const credentials = service.mint("typing-audit", "binding")
  await client.start({native:{driver:resolveExecutable("cua-driver"),socket:socket},browser:{url:credentials.url,token:credentials.token},env:{
        ...process.env,
        MAKO_CONTROL_URL: credentials.url,
        MAKO_CONTROL_TOKEN: credentials.token,
        MAKO_TASK_ID: "typing-audit",
      }})
  const baseline = await frontmostPid()
  samples = sampleFrontmost()
  const launched = await cell(
    `return await control.native('launch_app',{app_path:${JSON.stringify(resolve("node_modules/electron/dist/Electron.app"))},additional_arguments:[${JSON.stringify(page.main)}],page_route:true})`
  )
  pagePid = launched.pid
  await until(() => read(page.status))
  const documents = launched.windows.filter((w) => w.kind === "document")
  assert.equal(documents.length, 1)
  await cell(
    `state.window=control.window({pid:${pagePid},window_id:${documents[0].window_id}});const tabs=await control.tabs(${JSON.stringify(launched.page_route.browser)});const page=tabs.pages.find(p=>p.selectable&&p.title==='Mako typing audit');if(!page)throw Error('Audit tab missing');state.tab=await control.claimTab({browser:${JSON.stringify(launched.page_route.browser)},tab:page.targetId});return true`
  )
  for (const route of ["ax", "focused-ax", "page"]) {
    for (const value of [
      "first-" + route,
      "second-" + route,
      "  padded  ",
      "00123",
      "東京 🐟",
      "",
    ]) {
      const before = await read(page.status)
      const result = await cell(
        `const handle=state.${route === "page" ? "tab" : "window"};let view=await handle.observe();let field=view.get({role:${JSON.stringify(route === "page" ? "textbox" : "TextField")},name:'Proof'});${route === "focused-ax" ? "await handle.raw('click',{element_token:field.ref});view=await handle.observe();field=view.get({role:'TextField',name:'Proof'});" : ""}try {const receipt=await ${route === "page" ? "handle.setValue(field.ref," + JSON.stringify(value) + ")" : "handle.raw('set_value',{element_token:field.ref,value:" + JSON.stringify(value) + "})"};return {receipt,observed:(await handle.observe()).get({role:${JSON.stringify(route === "page" ? "textbox" : "TextField")},name:'Proof'}).value}}catch(e){return {error:e.message,outcome:e.outcome??null}}`
      )
      const deadline = Date.now() + 1500
      let actual
      do {
        actual = await read(page.status)
        if (actual.input === value) break
        await new Promise((r) => setTimeout(r, 100))
      } while (Date.now() < deadline)
      evidence.writes.push({
        route,
        expected: value,
        before: before.input,
        actual: actual.input,
        matched: actual.input === value,
        result,
      })
    }
  }
  const seen = await samples.stop()
  samples = undefined
  evidence.frontmostUnchanged = [...seen.keys()].every(
    (pid) => pid === baseline
  )
  evidence.status = "completed"
  console.log(
    JSON.stringify({
      routes: ["ax", "focused-ax", "page"].map((route) => ({
        route,
        passed: evidence.writes.filter((w) => w.route === route && w.matched)
          .length,
        total: evidence.writes.filter((w) => w.route === route).length,
      })),
      frontmostUnchanged: evidence.frontmostUnchanged,
    })
  )
} finally {
  await samples?.stop()
  await client.close()
  service.close()
  stopCuaEmbedded()
  if (pagePid) {
    try {
      process.kill(pagePid, "SIGTERM")
    } catch {}
  }
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2)
  )
  console.log("Evidence:", root)
}
