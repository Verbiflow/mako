import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"

/**
 * The Inbox, on the desk and the phone, against the Apex fixture (`?mock&app=apex`):
 * the rail's count is the needs-you facts, answering a Fin's ask there moves it to
 * working in the Inbox, the rail and the crew, Cmd+Shift+U opens the Inbox, a live
 * update repaints none of the rail's top rows, and the phone's list leads with the
 * Inbox chip, its sections, and a Fin that needs you as its own row.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const portAt = process.argv.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(process.argv[portAt + 1])
  const root = await mkdtemp(join(tmpdir(), "mako-inbox-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port, strictPort: port !== 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-inbox-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolveExit(electronExit("The Inbox UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
  console.log(`UI evidence: ${root}`)
}

/** Counts renders of the rail's top rows. Installed before React loads. */
const RENDER_COUNTER = `
const PERFORMED = 1
const NAMES = new Set(["RailTop", "InboxRow", "CommandRow", "PullsRow", "AutomationsRow"])
const began = new WeakMap()
let counts = {}
let commits = 0
const nameOf = (type) => (typeof type === "function" ? type.displayName || type.name : type && typeof type === "object" ? type.displayName || nameOf(type.type) || nameOf(type.render) : undefined)
function walk(fiber) {
  for (; fiber; fiber = fiber.sibling) {
    const name = nameOf(fiber.type)
    if (name && NAMES.has(name) && (fiber.flags & PERFORMED) && began.get(fiber) !== fiber.actualStartTime) counts[name] = (counts[name] ?? 0) + 1
    if (name) began.set(fiber, fiber.actualStartTime)
    walk(fiber.child)
  }
}
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  onCommitFiberRoot(_, root) { commits += 1; walk(root.current) },
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  checkDCE() {},
}
window.__railRenderCounts = () => ({ ...counts, commits })
window.__railRenderReset = () => { counts = {}; commits = 0 }
`

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The Inbox UI check", ms: 150_000 })
  await window.loadURL("about:blank")
  page.debugger.attach("1.3")
  await page.debugger.sendCommand("Page.enable")
  await page.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: RENDER_COUNTER })
  page.on("console-message", (details) => {
    if (details.level === "error" || details.level === "warning") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`UI condition timed out: ${label}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const click = async (selector) => {
    const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing click target ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y })
  }
  // Meta is 4, Shift is 8.
  const chord = async (key, code, modifiers) => {
    for (const type of ["rawKeyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
    await frames()
  }

  await window.loadURL(`${base}?mock&app=apex`)
  await until(`document.querySelector('[data-rail-top-row="inbox"]') !== null`, "the Inbox row")
  await until(`document.querySelector('[data-inbox-count]') !== null`, "the Inbox count")
  await frames()

  const facts = await evaluate(`import('/src/state/inbox.ts').then(({ inboxCount }) => inboxCount())`)
  const shown = await evaluate(`document.querySelector('[data-inbox-count]').textContent`)
  assert.equal(shown, String(facts), "the rail's count is the needs-you facts")
  assert.equal(facts, 2, "the Apex fixture has two Fins waiting on the person")
  const label = await evaluate(`document.querySelector('[data-rollup]')?.getAttribute('aria-label')`)
  assert.match(label, /2 need you/, "the same two the Apex's mark counts")
  console.log("PASS: the Inbox count is the needs-you facts")

  const seen = await evaluate("window.__railRenderCounts().commits")
  assert.ok(seen > 0, "the render counter saw the first paint")
  await evaluate("window.__railRenderReset()")
  await evaluate("window.apexScene.token()")
  await until(`window.__railRenderCounts().commits > 0`, "the token committed")
  const renders = await evaluate("window.__railRenderCounts()")
  console.log("RENDERS", JSON.stringify(renders))
  assert.equal(renders.RailTop ?? 0, 0, "a live update repaints none of the rail's top")
  assert.equal(renders.InboxRow ?? 0, 0, "the Inbox row holds still while the count does")
  assert.equal(renders.CommandRow ?? 0, 0)
  assert.equal(renders.PullsRow ?? 0, 0)
  assert.equal(renders.AutomationsRow ?? 0, 0)
  assert.equal(await evaluate(`document.querySelector('[data-inbox-count]').textContent`), String(facts), "the count is unchanged by the update")
  console.log("PASS: a live update repaints none of the rail's top rows")

  await chord("u", "KeyU", 12)
  await until(`document.querySelector('[data-inbox]') !== null`, "Cmd+Shift+U opens the Inbox")
  await until(`document.querySelector('[data-inbox-section="needs"] [data-inbox-item]') !== null`, "the asks are in the Inbox")
  assert.equal(await evaluate(`document.activeElement?.matches('[data-inbox-item]')`), true, "the first item is ready for Enter")
  console.log("PASS: Cmd+Shift+U opens the Inbox")

  const asking = await evaluate(`document.querySelector('[data-inbox-section="needs"] [data-inbox-item][data-fin]')?.dataset.fin`)
  assert.ok(asking, "a Fin's ask leads the Inbox")
  await click(`[data-inbox-item][data-fin="${asking}"] [data-inbox-answer="allow"], [data-inbox-item][data-fin="${asking}"] [data-inbox-answer="0"]`)
  await until(`window.apexScene.responds().length === 1`, "the answer reaching the Apex's host")
  await until(`document.querySelector('[data-inbox-item][data-fin="${asking}"]') === null`, "the answered ask leaves the Inbox")
  await until(`document.querySelector('[data-inbox-count]')?.textContent === '1'`, "the count drops by the one answered")
  await until(`(() => { const label = document.querySelector('.thread-jump-scope [data-rollup]')?.getAttribute('aria-label') ?? ''; return label.includes('1 needs you') && label.includes('6 working') })()`, "the rail's badge counts the Fin as working")

  await chord("u", "KeyU", 12)
  await until(`document.querySelector('[data-inbox]') === null`, "Cmd+Shift+U again opens the first item and leaves the Inbox")
  console.log("PASS: Cmd+Shift+U again opens the first item")

  await evaluate(`(() => { document.querySelector('.thread-jump-scope [data-rollup]')?.closest('[data-thread-row]')?.click(); return true })()`)
  await until(`document.querySelector('[data-apex-count]') !== null`, "the Apex's crew count")
  await click("[data-apex-count]")
  await until(`Boolean(document.querySelector('[data-apex-fins]'))`, "the crew")
  const groups = await evaluate(`[...document.querySelectorAll('[data-child-group]')].map((group) => group.innerText.replace(/\\s+/g, ' '))`)
  assert.ok(groups.includes("Needs you 1"), `the crew's Needs you dropped to one, received ${JSON.stringify(groups)}`)
  assert.ok(groups.includes("Working 6"), `the answered Fin joined the crew's working, received ${JSON.stringify(groups)}`)
  const moved = await evaluate(`window.apexScene.children().find((agent) => agent.child?.thread === ${JSON.stringify(asking)})?.child?.state?.kind`)
  assert.equal(moved, "working", "the Fin's own record says it is working")
  console.log("PASS: answering in the Inbox moves the Fin to working in the Inbox, the rail and the crew")

  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex`)
  await until(`document.querySelector('[data-list-chip="inbox"]') !== null`, "the phone's Inbox chip")
  const phone = await evaluate(`(() => ({
    count: document.querySelector('[data-inbox-count]')?.textContent,
    sections: [...document.querySelectorAll('[data-list-section]')].map((section) => section.dataset.listSection),
    fins: [...document.querySelectorAll('[data-fin-row]')].map((row) => row.innerText.replace(/\\s+/g, ' ')),
    chips: [...document.querySelectorAll('[data-list-chip]')].map((chip) => chip.dataset.listChip),
  }))()`)
  console.log("PHONE", JSON.stringify(phone))
  assert.deepEqual(phone.chips, ["inbox"], "a phone with no project of its own shows the Inbox chip alone")
  assert.equal(phone.count, "2")
  assert.deepEqual(phone.sections, ["needs", "working", "recent"])
  assert.equal(phone.fins.length, 2)
  for (const row of phone.fins) assert.match(row, /Mobile polish · /)
  await click('[data-list-chip="inbox"]')
  await until(`document.querySelector('[data-inbox-dock]') !== null`, "the phone's Inbox")
  const dock = await evaluate(`(() => { const button = document.querySelector('[data-inbox-dock] button'); const r = button.getBoundingClientRect(); return { height: r.height, bottom: r.bottom, inner: innerHeight } })()`)
  assert.ok(dock.height >= 44, `an answer is in thumb's reach, received ${JSON.stringify(dock)}`)
  assert.ok(dock.bottom > dock.inner * 0.6, `the answers sit at the foot, received ${JSON.stringify(dock)}`)
  const phoneFin = await evaluate(`document.querySelector('[data-inbox-item][data-fin]')?.dataset.fin`)
  const heard = await evaluate(`window.apexScene.responds().length`)
  await evaluate(`document.querySelector('[data-inbox-dock] [data-inbox-answer="allow"], [data-inbox-dock] [data-inbox-answer="0"]').click()`)
  await until(`window.apexScene.responds().length === ${heard + 1}`, "the phone's answer reaching the host")
  await until(`document.querySelector('[data-inbox-item][data-fin="${phoneFin}"]') === null`, "the phone's answer leaves the Inbox")
  await evaluate(`document.querySelector('[aria-label="Back to threads"]').click()`)
  await until(`document.querySelector('[data-list-chip="inbox"]') !== null`, "back to the list")
  const after = await evaluate(`(() => ({ count: document.querySelector('[data-inbox-count]')?.textContent, fins: [...document.querySelectorAll('[data-fin-row]')].map((row) => row.dataset.finRow), responds: window.apexScene.responds().length }))()`)
  console.log("PHONE AFTER", phoneFin, JSON.stringify(after))
  assert.ok(phoneFin && !after.fins.includes(phoneFin), `the answered Fin leaves Needs you, received ${JSON.stringify(after)}`)
  assert.equal(after.count, "1", "the phone's count drops by the one answered")
  console.log("PASS: the phone's chips, sections and Inbox")

  guard.done()
  console.log("Inbox UI checks clean")
  app.exit(0)
}
