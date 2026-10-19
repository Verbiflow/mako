import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"

// Harness versions in the window, against the mock bridge, light and dark:
//
// - `?mock&app=kept&outdated=1`: a session Mako keeps the records of that a
//   newer Codex wrote than this Mac has. Above the composer, the host's
//   restore plan says so and offers Update; the placeholder says a reply goes
//   on from the transcript. Update runs, the plan turns native, the line goes
//   and the placeholder says the session is restored and resumed.
// - `?mock&app=unread`: Settings › Diagnostics lists records Mako couldn't
//   read by harness and version, saved and live; a row's Original opens the
//   newest one's bytes, a saved one from its record and a live one from its
//   stream line.
//
// Checks the words and writes the screenshots.
//
//   node scripts/test-versions-ui.mjs [out]
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), "mako-versions-ui-"))
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, watch: null, fs: { strict: false } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-versions-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_VERSIONS_CHECK_ROOT: root, MAKO_VERSIONS_CHECK_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(electronExit("The harness versions UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
  console.log(`Harness versions UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_VERSIONS_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const guard = guardElectronCheck({ app, page: window.webContents, name: "The harness versions UI check", ms: 180_000 })
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
  const rowOf = (title) => `[...document.querySelectorAll('[data-thread-row]')].find((row) => row.textContent.includes(${JSON.stringify(title)}))`
  const field = "[data-composer] textarea"
  const notice = "document.querySelector('[data-restore-version-notice]')"
  const open = async (query, theme) => {
    await window.loadURL(`${process.env.MAKO_VERSIONS_CHECK_URL}?mock&${query}`)
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
    await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer")
    await evaluate(`localStorage.setItem("mako.prefs.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("mako.prefs.v1") ?? "{}"), theme: ${JSON.stringify(theme)} })); true`)
    await window.loadURL(`${process.env.MAKO_VERSIONS_CHECK_URL}?mock&${query}`)
    await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer again")
    assert.equal(await evaluate("document.documentElement.classList.contains('light')"), theme === "light", `the window is ${theme}`)
    await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
    await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")
  }

  try {
    for (const theme of ["dark", "light"]) {
      // The composer's offer, then the update.
      await open("app=kept&outdated=1", theme)
      const title = "Audit the webhook signatures"
      await until(`Boolean(${rowOf(title)})`, "the kept session's row")
      await click(rowOf(title))
      await until(`Boolean(${notice})`, "the restore plan's offer above the composer")
      const line = await evaluate(`${notice}.textContent`)
      assert.match(line, /Codex 0\.163\.0 wrote this session; this Mac has 0\.159\.3\./, `the offer names both versions: ${line}`)
      assert.match(line, /Update Codex to resume it here, or reply now to go on from its transcript\./)
      assert.equal(await evaluate(`${notice}.querySelector('button')?.textContent`), "Update Codex")
      assert.match(await evaluate(`document.querySelector(${JSON.stringify(field)}).placeholder`), /^Reply — continues from its transcript in a new Codex session$/, "the composer says where a reply goes before the update")
      await capture(`restore-offer-${theme}.png`)
      await capture(`restore-offer-composer-${theme}.png`, await bounds(`${notice}.closest('[data-composer]') ?? ${notice}.parentElement`, 16))
      await click(`${notice}.querySelector('button')`)
      await until(`(${notice})?.textContent.includes('Updating Codex…') ?? false`, "the update running", 4000)
      await capture(`restore-updating-${theme}.png`, await bounds(notice, 16))
      await until(`!${notice}`, "the offer gone once the update landed", 10_000)
      await until(`document.querySelector(${JSON.stringify(field)}).placeholder.startsWith('Reply — Mako restores this session and Codex resumes it')`, "the native resume")
      await capture(`restore-updated-${theme}.png`)

      // A kept session nothing names the writer of: honest about it, with no Update that couldn't settle it.
      await open("app=kept&outdated=unknown", theme)
      await until(`Boolean(${rowOf(title)})`, "the kept session's row again")
      await click(rowOf(title))
      await until(`Boolean(${notice})`, "the uncertain offer")
      const uncertain = await evaluate(`${notice}.textContent`)
      assert.match(uncertain, /Mako can't tell which Codex version wrote this session; this Mac has 0\.159\.3\./, uncertain)
      assert.match(uncertain, /A reply goes on from its transcript in a new session\./)
      assert.equal(await evaluate(`${notice}.querySelector('button')`), null, "no Update that couldn't settle it")
      await capture(`restore-unknown-writer-${theme}.png`, await bounds(notice, 16))

      // A cursor-agent store newer than the SDK Mako ships, which would import it: which build reads it, and no Update for cursor-agent.
      await open("app=kept&outdated=import", theme)
      const store = "Trace the flaky upload retry"
      await until(`Boolean(${rowOf(store)})`, "the cursor-agent session's row")
      await click(rowOf(store))
      await until(`Boolean(${notice})`, "the import's offer")
      const imported = await evaluate(`${notice}.textContent`)
      assert.match(imported, /Mako can't tell which cursor-agent version wrote this session, only that it was 2026\.10\.15 or older; Mako's @cursor\/sdk 1\.0\.31, published 2026.09.03, may not read it\./, imported)
      assert.match(imported, /It resumes here once Mako ships a build that reads cursor-agent 2026\.10\.15; a reply now goes on from its transcript\./)
      assert.equal(await evaluate(`${notice}.querySelector('button')`), null, "no Update: updating cursor-agent doesn't change what Mako's SDK reads")
      await capture(`restore-import-${theme}.png`, await bounds(notice, 16))

      // Settings › Diagnostics: unread records by version.
      await open("app=unread", theme)
      // The shell listens for this from an effect, which runs after the composer first paints: two frames, then it's there.
      await frame()
      await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "diagnostics" })); true`)
      await until("[...document.querySelectorAll('h1, h2, h3')].some((node) => node.textContent === 'Diagnostics')", "Settings to open on Diagnostics after mako:settings")
      await until("Boolean(document.querySelector('[data-unread-records] [data-unread-row]'))", "the unread records section")
      const section = "document.querySelector('[data-unread-records]')"
      const text = await evaluate(`${section}.textContent`)
      assert.match(text, /Unread records/)
      assert.match(text, /Mako couldn't read 23 saved records in 7 sessions and 3 live records since Mako started, shown by the harness version that wrote them\. 1 saved record isn't in Mako's record store yet, so its version isn't known\./)
      assert.deepEqual(await evaluate(`[...${section}.querySelectorAll('[data-unread-harness]')].map((node) => node.dataset.unreadHarness)`), ["codex", "claude", "grok"])
      const rows = await evaluate(`[...${section}.querySelectorAll('[data-unread-row]')].map((row) => row.textContent)`)
      assert.ok(rows[0].startsWith("0.163.0response_item web_search_preview_callnew kind · 14 records in 3 sessions"), rows[0])
      assert.ok(rows.some((row) => row.startsWith("version unknownsystem scheduled_wakeup")), "a record whose version isn't known says so")
      assert.ok(rows.some((row) => row.startsWith("1.0.62_x.ai/session/checkpointnew kind · 3 live records")), "a live kind counts by the version its launch reported")
      await capture(`unread-records-${theme}.png`, await bounds(section, 16))
      await capture(`diagnostics-${theme}.png`)
      // The newest saved record's bytes, from its record.
      await click(`${section}.querySelector('[data-unread-row] [data-show-original]')`)
      await until("document.querySelector('[data-original-dialog]')?.textContent.includes('zod 4 discriminated unions')", "the saved record's bytes")
      await capture(`unread-original-${theme}.png`, await bounds("document.querySelector('[data-original-dialog]')", 8))
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
      await until("!document.querySelector('[data-original-dialog]')", "the dialog closed")
      // A live record's, from the stream line it came in.
      await click(`[...${section}.querySelectorAll('[data-unread-row="live"]')].at(-1).querySelector('[data-show-original]')`)
      await until("document.querySelector('[data-original-dialog]')?.textContent.includes('\"files\": 2')", "the live record's stream line")
      assert.equal(await evaluate("document.querySelector('[data-original-side=\"record\"]')"), null, "a live record known only by its stream line shows no record side")
      await capture(`unread-stream-original-${theme}.png`, await bounds("document.querySelector('[data-original-dialog]')", 8))
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    }
    console.log("✓ the composer offers the update a kept session's records need, and Settings › Diagnostics counts unread records by version, light and dark")
    guard.done()
    app.exit(0)
  } catch (error) {
    console.error(error)
    guard.done()
    app.exit(1)
  }
}
