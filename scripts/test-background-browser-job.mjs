import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BrowserService } from "../dist-electron/browser-service.js"
import { sampleFrontmost } from "./lib/control-fixture.mjs"
import { BrowserCommandSchema } from "../dist-electron/contracts/browser-control.js"

// Uses an already connected browser, opens only task-owned local fixture tabs,
// and checks persisted saves at the server, independently of page observations.
const root = await mkdtemp("/private/tmp/mako-browser-job-")
const rounds = Number(process.env.MAKO_TEST_BROWSER_ROUNDS ?? 6)
assert.ok(Number.isInteger(rounds) && rounds >= 6 && rounds <= 100)
const saved = []
const page = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/save") {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    saved.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.end("ok")
    return
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.end(`<title>Mako disposable background job</title><h1>Background job proof</h1>
 <form aria-label="Proof form"><input aria-label="Proof"><button>Save</button></form><output aria-label="Saved result"></output>
 <script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!confirm('Save this value?'))return;const value=document.querySelector('input').value;await fetch('/save',{method:'POST',body:JSON.stringify({value})});document.querySelector('output').textContent=value}</script>`)
})
await new Promise((r) => page.listen(0, "127.0.0.1", r))
const endpoint = process.env.MAKO_TEST_BROWSER_ENDPOINT
const service = new BrowserService(
    endpoint
      ? [
          {
            id: "fixture-cdp",
            kind: "chromium",
            name: "Disposable Chromium CDP fixture",
            requiresApproval: false,
            endpoint: async () => endpoint,
          },
        ]
      : undefined
  ),
  owner = "background-job-" + Date.now()
const run = (input) =>
  service.execute(
    owner,
    BrowserCommandSchema.parse(input),
    AbortSignal.timeout(15000)
  )
const evidence = { rounds: [], refusals: [], screenshots: [], targets: [] }
let samples
async function until(check) {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 40))
  }
  throw Error("Independent browser fixture condition timed out")
}
try {
  const browsers = (await run({ action: "status" })).filter(
    (b) => b.kind === "chromium"
  )
  const browser =
    process.env.MAKO_TEST_BROWSER ??
    (browsers.length === 1 ? browsers[0].id : null)
  assert.ok(
    browser,
    "Set MAKO_TEST_BROWSER to an exact registered browser ID when more than one is available"
  )
  if (process.env.MAKO_TEST_EXTENSION_ONLY === "1")
    assert.equal(browsers.find(b => b.id === browser)?.transport, "extension", "Acceptance requires the extension, never a direct fallback")
  await run({ action: "connect", browser })
  evidence.browser = browser
  samples = sampleFrontmost()
  const url = `http://127.0.0.1:${page.address().port}`
  const targets = []
  for (let i = 0; i < 2; i++) {
    const opened = await run({
      action: "open",
      browser,
      url,
      background: true,
      lifetime: "task",
      disposition: "tab",
    })
    const {
      browser: browserId,
      tab,
      generation,
      lease,
    } = opened.target ?? opened
    targets.push({ browser: browserId, tab, generation, lease })
    evidence.targets.push({ browser: browserId, tab })
  }
  for (let round = 0; round < rounds; round++) {
    const target = targets[round % 2],
      value = `saved-${round}-東京`
    const view = await run({ action: "observe", target })
    const field = view.nodes.find((n) => n.role === "textbox"),
      save = view.nodes.find((n) => n.role === "button" && n.name === "Save")
    assert.ok(field && save, "Fixture controls must be observed")
    await run({
      action: "type",
      target,
      ref: field.ref,
      text: value,
      clear: true,
    })
    // Rejecting a confirmation must leave the server untouched.
    await run({ action: "dialog", target, auto: "dismiss" })
    await run({ action: "click", target, at: { ref: save.ref } })
    assert.equal(saved.length, round, "Canceled confirmation must not save")
    await run({ action: "dialog", target, auto: "accept" })
    await run({ action: "click", target, at: { ref: save.ref } })
    await until(() => saved.length === round + 1)
    assert.deepEqual(saved[round], { value })
    const after = await run({ action: "observe", target })
    assert.ok(
      after.nodes.some((n) => n.name === value || n.value === value),
      "Saved result or field must be readable"
    )
    evidence.rounds.push({ round, value, saves: saved.length })
    if (round === 0 && process.env.MAKO_TEST_RESTRICTED_FRAME_URL) {
      const frameUrl = process.env.MAKO_TEST_RESTRICTED_FRAME_URL
      await run({
        action: "evaluate",
        target,
        expression: `(()=>{const frame=document.createElement('iframe');frame.id='mako-interference-fixture';frame.src=${JSON.stringify(frameUrl)};document.body.appendChild(frame);return true})()`,
      })
      let frame
      await until(async () => {
        const tree = await run({
          action: "cdp",
          target,
          method: "Page.getFrameTree",
        })
        evidence.restrictedFrameTree = tree.frameTree
        const visit = (node) =>
          node.frame.url === frameUrl
            ? node.frame
            : (node.childFrames ?? []).map(visit).find(Boolean)
        frame = visit(tree.frameTree)
        if (!frame) {
          const tabs = await run({ action: "tabs", browser })
          const document = await run({
            action: "cdp",
            target,
            method: "DOM.getDocument",
            params: { depth: 0 },
          })
          const selected = await run({
            action: "cdp",
            target,
            method: "DOM.querySelector",
            params: {
              nodeId: document.root.nodeId,
              selector: "iframe#mako-interference-fixture",
            },
          })
          const owner = await run({
            action: "cdp",
            target,
            method: "DOM.describeNode",
            params: { nodeId: selected.nodeId, depth: 0 },
          })
          const separate = tabs.find(
            (tab) =>
              tab.type === "iframe" &&
              tab.url === frameUrl &&
              tab.targetId === owner.node.frameId
          )
          if (separate)
            frame = {
              url: separate.url,
              id: separate.targetId,
              owner: owner.node.backendNodeId,
            }
        }
        return Boolean(frame)
      })
      evidence.restrictedFrame = frame
    }

    if (round === 0 || round === rounds - 1) {
      const started = Date.now(),
        image = await run({
          action: "screenshot",
          target,
          format: "jpeg",
          quality: 70,
          maxSide: 1280,
          fullPage: false,
        })
      await writeFile(
        join(root, `round-${round}.jpg`),
        Buffer.from(image.data, "base64")
      )
      evidence.screenshots.push({
        round,
        ms: Date.now() - started,
        coordinates: image.coordinates,
      })
    }
  }
  await run({ action: "close", target: targets[1] })
  await assert.rejects(
    run({
      action: "type",
      target: targets[1],
      ref: "stale",
      text: "must-not-save",
      clear: true,
    })
  )
  evidence.refusals.push("closed target refused")
  assert.equal(saved.length, rounds)
  evidence.status = "passed"
  console.log(
    `PASS: ${rounds} saved browser jobs across two background tabs, canceled confirmations, screenshots and closed-target refusal`
  )
} catch (error) {
  evidence.status = "failed"
  evidence.error = String(error)
  throw error
} finally {
  if (samples) evidence.foreground = [...(await samples.stop())]
  evidence.saved = saved
  evidence.cleanup = await service.releaseOwner(owner)
  await service.close()
  page.close()
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2)
  )
  console.log("Evidence:", root)
}
