import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The rail's order holds from its first paint, on a desk shaped like a person's who works in many places
 * (`?mock&app=crowded`: 36 projects, an Apex with 60 Fins, a catalog that lands in two steps and another device's
 * Sessions after it). Every frame from the first paint to the last arrival is read: the projects the rail shows, in
 * its order, never change while the data lands, after a reload too. Then a project the person adds, and a Thread they
 * start in a project whose folder is collapsed and far down, lands where they're looking: in view, open, selected.
 * Screenshots stay in the printed directory; `--port` serves the page on that port.
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
  const root = testScratch("mako-rail-stable-ui-")
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port, strictPort: port !== 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-rail-stable-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolveExit(electronExit("The stable rail check", code, signal)))
    })
  } finally {
    await server.close()
  }
  console.log(`Screenshots: ${root}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  const measureOnly = process.env.MAKO_RAIL_MEASURE === "1"
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const guard = guardElectronCheck({ app, page, name: "The stable rail check", ms: 120_000 })
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message} @ ${details.sourceId}:${details.lineNumber}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all([...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].flatMap(node => node.getAnimations()).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
    const rail = await evaluate(`(() => { const r = document.querySelector('.thread-jump-scope').getBoundingClientRect(); return {x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height)} })()`)
    await writeFile(join(root, name), (await page.capturePage(rail)).toPNG())
  }
  const until = async (code, label = code, ms = 15_000) => {
    guard.at(label)
    const deadline = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const move = (x, y) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })

  /**
   * Every frame's projects from the page's start until `settledMs` after the last arrival: a recorder in the page
   * itself, installed before the app's first script, so no paint goes unread.
   */
  const RECORD = `(() => {
    const seen = []
    const read = () => {
      const order = [...document.querySelectorAll('.thread-jump-scope [data-flip-key^="folder:"]')].map(node => node.dataset.flipKey.slice(7)).join('\\n')
      if (order && seen[seen.length - 1]?.order !== order) seen.push({ at: Math.round(performance.now()), order })
      requestAnimationFrame(read)
    }
    requestAnimationFrame(read)
    window.__railOrders = seen
  })()`
  const recordFrom = async (url, label) => {
    const { identifier } = await page.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: RECORD })
    await window.loadURL(url)
    await until(`document.querySelectorAll('.thread-jump-scope [data-flip-key^="folder:"]').length >= 6`, `${label}: folders painted`)
    // The catalog's second read comes 1.5 s after its first, the other device's rows 1 s after that.
    await until(`import('/src/state/acp-state.ts').then(({acpStore}) => Object.values(acpStore.get().conversations).some(c => c.elsewhere === 'Laptop'))`, `${label}: the other device's rows arrived`, 20_000)
    await new Promise((resolveWait) => setTimeout(resolveWait, 600))
    await frames()
    await page.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier })
    return evaluate("window.__railOrders.map(entry => ({ at: entry.at, order: entry.order.split('\\n') }))")
  }

  // The pointer rests away from the rail, as on a reload: no hold.
  await window.loadURL("about:blank")
  await page.debugger.sendCommand("Page.enable")
  await move(1200, 800)
  const first = await recordFrom(`${base}?mock&app=crowded`, "first load")
  console.log(`first load: ${first.length} distinct orders`)
  for (const entry of first) console.log(`  ${entry.at} ms: ${entry.order.join(", ")}`)
  await capture("crowded-settled.png")
  const reload = await recordFrom(`${base}?mock&app=crowded`, "reload")
  console.log(`reload: ${reload.length} distinct orders`)
  for (const entry of reload) console.log(`  ${entry.at} ms: ${entry.order.join(", ")}`)
  if (!measureOnly) {
    assert.equal(reload.length, 1, `after a reload the rail paints its order once and keeps it, received ${JSON.stringify(reload)}`)
    assert.deepEqual(reload[0].order, first[first.length - 1].order, "and it's the order the last session settled on")
    console.log("PASS: the rail's order on first paint is its order once everything has landed")
  }

  if (!measureOnly) {
    // A Thread started in a project far down the list, its folder collapsed, with the rail scrolled to its top: the
    // project comes into view, open, and the unsent Thread is drawn there, lit.
    const settled = reload[0].order
    const far = settled[settled.length - 1]
    await revealCheck(far, "a Thread started in a project far down")
    // A folder the person adds goes the same way (`pickWorkspace` opens a Thread there), with no Session in it yet.
    await revealCheck("/Users/you/code/just-added", "a project just added")
    console.log("PASS: a new Thread or a project just added lands in view, open, selected")
  }

  guard.done()
  app.exit(0)

  async function revealCheck(folder, label) {
    const key = JSON.stringify(`folder:${folder}`)
    await evaluate(`import('/src/state/prefs.ts').then(({ setPref, prefsStore }) => { setPref('collapsedGroups', [...prefsStore.get().collapsedGroups.filter(k => k !== 'ws:' + ${JSON.stringify(folder)}), 'ws:' + ${JSON.stringify(folder)}]); return true })`)
    await evaluate(`(() => { document.querySelectorAll('.thread-jump-scope, .thread-jump-scope *').forEach(n => { if (n.scrollTop) n.scrollTop = 0 }); return true })()`)
    await evaluate(`import('/src/state/session.ts').then(({ actions }) => actions.newConversationIn(${JSON.stringify(folder)})).then(() => true)`)
    await until(`[...document.querySelectorAll('[data-flip-key]')].some(n => n.dataset.flipKey === ${key})`, `${label}: its folder shows`)
    await until(`(() => { const head = [...document.querySelectorAll('[data-flip-key]')].find(n => n.dataset.flipKey === ${key}); const button = head?.querySelector('[aria-expanded]'); return button?.getAttribute('aria-expanded') === 'true' })()`, `${label}: its folder is open`)
    await until(`(() => { const head = [...document.querySelectorAll('[data-flip-key]')].find(n => n.dataset.flipKey === ${key}); const row = head?.parentElement?.querySelector('[data-unsent-thread][data-active]'); if (!row) return false; const r = row.getBoundingClientRect(); const rail = document.querySelector('.thread-jump-scope').getBoundingClientRect(); return r.height > 0 && r.top >= rail.top && r.bottom <= rail.bottom })()`, `${label}: its unsent Thread is lit and in view`)
    await capture(`reveal-${folder.split('/').pop()}.png`)
  }
}
