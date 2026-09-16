// Drives a hidden Electron window through the desk browser bridge with the
// production BrowserService: observe, click, type with clear and submit,
// scroll, viewport and element screenshots, and window teardown. Run after
// `npm run build:electron`: electron scripts/test-desk-browser-electron.mjs
import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DeskBrowser } from "../dist-electron/desk-browser.js"
import { deskPageForWindow } from "../dist-electron/desk-browser-window.js"
import { BrowserService } from "../dist-electron/browser-service.js"
import { BrowserCommandSchema } from "../dist-electron/contracts/browser-control.js"

const root = mkdtempSync(join(tmpdir(), "mako-desk-browser-"))
app.setPath("userData", join(root, "profile"))
const html = `<!doctype html><title>Desk check</title><body style="margin:0;height:3000px"><h1>Desk check</h1><button id="b" onclick="document.getElementById('out').textContent='clicked'">Press me</button><input id="i" aria-label="Name" value="old"><select id="s" aria-label="Colour"><option value="r">Red</option><option value="b">Blue</option></select><a id="dl" href="data:text/plain,hello%20download" download="hello.txt">Download</a><iframe name="embed" srcdoc="<p>inner frame text</p>"></iframe><div id="out"></div><script>document.getElementById('i').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('out').textContent+=' enter'});document.getElementById('s').addEventListener('change',e=>{document.getElementById('out').textContent+=' colour='+e.target.value});setTimeout(()=>{const late=document.createElement('p');late.id='late';late.textContent='late arrival';document.body.appendChild(late)},700)</script></body>`
const second = `<!doctype html><title>Second page</title><body><p>second</p></body>`
const watchdog = setTimeout(() => {
  console.error("Desk browser check timed out")
  app.exit(2)
}, 60_000)

// Electron emits ready only after the ESM entry finishes evaluating, so the
// work runs from a function instead of a top-level await.
async function main() {
  await app.whenReady()
  const desk = new DeskBrowser({
    allowsUrl: (url) => url.startsWith("data:") || url === "about:blank",
    createPage: async () => {
      const window = new BrowserWindow({
        width: 1600,
        height: 1000,
        show: false,
        enableLargerThanScreen: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      })
      window.setContentSize(1600, 1000)
      await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html))
      return deskPageForWindow(window)
    },
  })
  const service = new BrowserService(() => [desk.definition])
  const run = (input) => service.execute("agent", BrowserCommandSchema.parse(input), new AbortController().signal)
  await run({ action: "connect", browser: "mako" })
  const { navigation: _navigation, ...target } = await run({ action: "open", browser: "mako" })
  const observed = await run({ action: "observe", target, interactiveOnly: true })
  assert.deepEqual([...new Set(observed.nodes.map((node) => node.role))].sort(), ["button", "combobox", "link", "option", "textbox"])
  assert.deepEqual([observed.viewport.width, observed.viewport.height], [1600, 1000])
  const button = observed.nodes.find((node) => node.role === "button")
  const input = observed.nodes.find((node) => node.role === "textbox")
  await run({ action: "click", target, at: { ref: button.ref } })
  const typed = await run({ action: "type", target, ref: input.ref, text: "new value", clear: true, submit: true })
  assert.deepEqual(typed, { field: "input", cleared: 3, inserted: 9, submitted: true })
  const state = await run({ action: "evaluate", target, expression: "({out: document.getElementById('out').textContent, value: document.getElementById('i').value})" })
  assert.deepEqual(state.result.value, { out: "clicked enter", value: "new value" })
  const scrolled = await run({ action: "scroll", target, deltaY: 700 })
  assert.equal(scrolled.scrollY, 700)

  // Dialogs: raise one from the page, read it, answer it; then auto-dismiss.
  await run({ action: "evaluate", target, expression: "setTimeout(() => { window.confirmed = confirm('Continue?') }, 10); 1" })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const pending = await run({ action: "dialog", target })
  assert.equal(pending.pending?.message, "Continue?")
  await assert.rejects(run({ action: "observe", target }), /confirm dialog is open/)
  await run({ action: "dialog", target, respond: "accept" })
  const confirmed = await run({ action: "evaluate", target, expression: "window.confirmed" })
  assert.equal(confirmed.result.value, true)
  await run({ action: "dialog", target, auto: "dismiss" })
  await run({ action: "evaluate", target, expression: "setTimeout(() => { window.second = confirm('Again?') }, 10); 1" })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const dismissed = await run({ action: "evaluate", target, expression: "window.second" })
  assert.equal(dismissed.result.value, false)

  // selectOption fires change handlers.
  const select = observed.nodes.find((node) => node.role === "combobox") ?? (await run({ action: "observe", target, query: "Colour" })).nodes[0]
  const picked = await run({ action: "selectOption", target, ref: select.ref, label: "Blue" })
  assert.deepEqual(picked, { value: "b", label: "Blue" })
  const afterSelect = await run({ action: "evaluate", target, expression: "document.getElementById('out').textContent" })
  assert.match(afterSelect.result.value, /colour=b/)

  // wait resolves once the late element exists.
  const waited = await run({ action: "wait", target, for: { selector: "#late", text: "late arrival" }, timeoutMs: 5000 })
  assert.equal(waited.satisfied, true)

  // Frames: the srcdoc iframe is listed and observable by frameId.
  const frames = await run({ action: "frames", target })
  const child = frames.frames.find((frame) => frame.name === "embed")
  assert.ok(child, "iframe listed")
  const inner = await run({ action: "observe", target, frameId: child.id })
  assert.ok(inner.nodes.some((node) => String(node.name ?? "").includes("inner frame text")), "frame text observed")
  const innerEval = await run({ action: "evaluate", target, expression: "document.body.textContent.trim()", frameId: child.id })
  assert.equal(innerEval.result.value, "inner frame text")

  // PDF export.
  const pdf = await run({ action: "pdf", target, path: join(root, "page.pdf") })
  assert.ok(pdf.bytes > 1000, "pdf has content")

  // Download through the anchor.
  const dlObserved = await run({ action: "observe", target, query: "Download" })
  let download
  try {
    download = await run({ action: "download", target, directory: root, at: { ref: dlObserved.nodes[0].ref }, timeoutMs: 15000 })
  } catch (error) {
    const recent = await run({ action: "events", target, limit: 128 })
    console.error("download failed; recent events:", recent.events.slice(-12).map((event) => event.method + " " + JSON.stringify(event.params).slice(0, 120)).join("\n"))
    console.error("observed refs:", JSON.stringify(dlObserved.nodes.slice(0, 3)))
    throw error
  }
  assert.equal(download.state, "completed")
  assert.equal(download.path, join(root, "hello.txt"))

  // History: a second document, then back.
  await run({ action: "navigate", target, url: "data:text/html;charset=utf-8," + encodeURIComponent(second) })
  const back = await run({ action: "history", target, go: "back" })
  assert.equal(back.moved, true)
  const title = await run({ action: "evaluate", target, expression: "document.title" })
  assert.equal(title.result.value, "Desk check")
  const shot = await run({ action: "screenshot", target, format: "png", maxSide: 800 })
  writeFileSync(join(root, "viewport.png"), Buffer.from(shot.data, "base64"))
  assert.equal(shot.coordinates.imageWidth, 800)
  assert.equal(shot.coordinates.devicePixelRatio > 0, true)
  // History navigation replaced the document, so refs come from a new observation.
  const again = await run({ action: "observe", target, interactiveOnly: true })
  const buttonAgain = again.nodes.find((node) => node.role === "button")
  const element = await run({ action: "screenshot", target, format: "png", ref: buttonAgain.ref })
  assert.ok(element.coordinates.imageWidth < 200, "element capture is scoped to the button")
  await run({ action: "close", target })
  assert.equal(desk.openPages, 0)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  service.close()
  desk.close()
  console.log(`Desk browser (Electron): hidden window observed, clicked, typed with clear and Enter, scrolled, answered dialogs, selected options, waited, read frames, printed a PDF, downloaded a file, went back in history, captured and closed. Evidence: ${root}`)
}

main().then(
  () => {
    clearTimeout(watchdog)
    app.exit(0)
  },
  (error) => {
    console.error("Desk browser check failed:", error?.stack ?? error)
    clearTimeout(watchdog)
    app.exit(1)
  }
)
