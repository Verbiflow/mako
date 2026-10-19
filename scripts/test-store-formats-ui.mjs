import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"

// Shared stores a newer Mako changed, in the window, against the mock bridge, light and dark:
//
// - `?mock&app=newer-stores`: Mako 0.163.0 changed the Thread store and the
//   session ledger, and 0.170.0 the record store past what this build reads.
//   The rail lists every Thread with one quiet line above its footer and
//   Update; Update checks for the release and turns into Install update.
//   Settings › Diagnostics says the same of each store, one line each. A
//   catalogued session's composer says, before a reply, that this build
//   doesn't resume it and a reply goes on from its transcript, with Update.
// - `&later=1`: the window opens on stores this build writes, and the line
//   appears when the host says a newer Mako changed the Thread store.
//
// Checks the words and writes the screenshots.
//
//   node scripts/test-store-formats-ui.mjs [out]
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), "mako-store-formats-ui-"))
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, watch: null, fs: { strict: false } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-store-formats-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_STORE_FORMATS_CHECK_ROOT: root, MAKO_STORE_FORMATS_CHECK_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(electronExit("The store formats UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
  console.log(`Shared store formats UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_STORE_FORMATS_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  // Two themes of rail, composer, Diagnostics and a late change: well under this, even beside a whole suite.
  const guard = guardElectronCheck({ app, page: window.webContents, name: "The store formats UI check", ms: 300_000 })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const capture = async (name, rect) => {
    const end = Date.now() + 2000
    while (Date.now() < end && !(await evaluate("document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)")))
      await pause(25)
    await evaluate("document.fonts.ready")
    await frame()
    await writeFile(join(root, name), (await page.capturePage(rect)).toPNG())
  }
  const until = async (code, what = code, ms = 15_000) => {
    guard.at(what)
    const end = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${what}`)
      }
      await pause(25)
    }
  }
  const mouse = async (type, point) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 })
  const center = (selector) => evaluate(`(() => { const node = ${selector}; if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)}); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const click = async (selector) => {
    const point = await center(selector)
    await mouse("mouseMoved", point)
    await mouse("mousePressed", point)
    await mouse("mouseReleased", point)
  }
  const bounds = (selector, pad = 12) => evaluate(`(() => { const r = (${selector}).getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x - ${pad})), y: Math.max(0, Math.floor(r.y - ${pad})), width: Math.ceil(r.width + ${pad * 2}), height: Math.ceil(r.height + ${pad * 2}) } })()`)
  const field = "[data-composer] textarea"
  const railLine = "document.querySelector('aside [data-store-format=\"threads\"]')"
  const open = async (query, theme) => {
    guard.at(`opening ${query} in ${theme}`)
    await window.loadURL(`${process.env.MAKO_STORE_FORMATS_CHECK_URL}?mock&${query}`)
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
    await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer")
    await evaluate(`localStorage.setItem("mako.prefs.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("mako.prefs.v1") ?? "{}"), theme: ${JSON.stringify(theme)} })); true`)
    await window.loadURL(`${process.env.MAKO_STORE_FORMATS_CHECK_URL}?mock&${query}`)
    await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer again")
    assert.equal(await evaluate("document.documentElement.classList.contains('light')"), theme === "light", `the window is ${theme}`)
    await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
    await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")
  }

  try {
    for (const theme of ["dark", "light"]) {
      // The rail: every Thread still listed, one quiet line above the footer.
      await open("app=newer-stores", theme)
      await until(`Boolean(${railLine})`, "the rail's line")
      assert.ok(await evaluate("document.querySelectorAll('[data-thread-row]').length > 0"), "the rail lists the Threads")
      assert.equal(await evaluate(`${railLine}.querySelector('p').textContent`), "A newer Mako (0.163.0) updated your Threads; this one can show them but not change them. Update Mako to edit.")
      assert.equal(await evaluate(`${railLine}.querySelector('[data-update-mako]').textContent`), "Update")
      assert.equal(await evaluate(`getComputedStyle(${railLine}).color === getComputedStyle(document.querySelector('[data-thread-row]')).color`), false, "the line is quieter than a row")
      await capture(`rail-${theme}.png`)
      await capture(`rail-line-${theme}.png`, await bounds(railLine, 8))
      // Update checks for the release, and then installs it.
      await click(`${railLine}.querySelector('[data-update-mako]')`)
      await until(`${railLine}.querySelector('[data-update-mako]').textContent === 'Install update'`, "the update to be ready")
      await capture(`rail-line-ready-${theme}.png`, await bounds(railLine, 8))

      // A catalogued session: the composer says before a reply what the plan says, with Update.
      const notice = "document.querySelector('[data-ledger-notice]')"
      const rows = await evaluate("document.querySelectorAll('[data-thread-row]').length")
      for (let index = 0; index < rows && !(await evaluate(`Boolean(${notice})`)); index++) {
        await click(`document.querySelectorAll('[data-thread-row]')[${index}]`)
        await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer for the row")
        await pause(300)
      }
      await until(`Boolean(${notice})`, "the ledger line above the composer")
      assert.equal(await evaluate(`${notice}.dataset.ledgerNotice`), "handoff")
      assert.deepEqual(await evaluate(`[...${notice}.querySelectorAll('span')].map((span) => span.textContent)`), [
        "A newer Mako (0.163.0) updated how Mako keeps track of sessions; this one can show this session but can't resume it.",
        "A reply goes on from its transcript in a new session.",
      ], "what changed, then what a reply does, as the version notice says them")
      assert.ok(["Update", "Install update"].includes(await evaluate(`${notice}.querySelector('[data-update-mako]').textContent`)), "with Update")
      await capture(`composer-ledger-${theme}.png`, await bounds(`${notice}.closest('[data-composer]') ?? ${notice}.parentElement`, 16))

      // Settings › Diagnostics: one line for each store a newer Mako changed.
      // The shell listens for this from an effect, which runs after the composer first paints: two frames, then it's there.
      await frame()
      await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "diagnostics" })); true`)
      await until("[...document.querySelectorAll('h1, h2, h3')].some((node) => node.textContent === 'Diagnostics')", "Settings to open on Diagnostics after mako:settings")
      await until("document.querySelectorAll('[data-store-formats] [data-store-format]').length === 3", "the shared stores in Diagnostics")
      const lines = await evaluate("[...document.querySelectorAll('[data-store-formats] [data-store-format] p')].map((node) => node.textContent)")
      assert.deepEqual(lines, [
        "A newer Mako (0.163.0) updated your Threads; this one can show them but not change them. Update Mako to edit.",
        "A newer Mako (0.163.0) updated how Mako keeps track of sessions; this one can show your sessions but can't resume them. Update Mako to resume them.",
        "Your session records need Mako 0.170.0 or later, so this one leaves them as they are. Update Mako to open them.",
      ])
      assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-store-formats] [data-store-format]')].map((node) => node.dataset.storeAccess)"), ["read", "read", "refused"])
      assert.equal(await evaluate("document.querySelectorAll('[data-store-formats] [data-update-mako]').length"), 1, "one Update for the list")
      await capture(`diagnostics-stores-${theme}.png`, await bounds("document.querySelector('[data-store-formats]')", 16))
      await capture(`diagnostics-${theme}.png`)
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })

      // Raised while the window is open: the line arrives with the host's event, no reload.
      await open("app=newer-stores&later=1", theme)
      // The host's own answer had every store this build's: whatever shows came with the event.
      assert.equal(await evaluate("window.mako.storeFormats().then((formats) => formats.stores.every((row) => row.access === 'write'))"), true, "nothing is said of stores this build writes")
      await until(`Boolean(${railLine})`, "the line after a newer Mako changed the store", 8000)
      await capture(`rail-line-later-${theme}.png`, await bounds(railLine, 8))
    }
    console.log("✓ the rail and Settings › Diagnostics say which shared stores a newer Mako changed, quietly, with Update, light and dark")
    guard.done()
    app.exit(0)
  } catch (error) {
    console.error(error)
    guard.done()
    app.exit(1)
  }
}
