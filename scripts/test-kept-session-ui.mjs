import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"

// Sessions their harness deleted, against the mock bridge's kept scene
// (`?mock&app=kept`), light and dark: one only Mako's copy keeps
// (`ThreadRef.copyOnly`) and one whose records the record store kept. Each
// says so quietly at the top of its history, in its rail row's tip, and in
// the composer: the copy goes on from its transcript in a new session, and
// the one with records is restored for its harness to resume. Checks the
// words and writes the screenshots.
//
//   node scripts/test-kept-session-ui.mjs [out]
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), "mako-kept-session-ui-"))
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, watch: null, fs: { strict: false } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-kept-session-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_KEPT_CHECK_ROOT: root, MAKO_KEPT_CHECK_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(electronExit("The kept session UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
  console.log(`Kept session UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_KEPT_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const guard = guardElectronCheck({ app, page: window.webContents, name: "The kept session UI check", ms: 120_000 })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const capture = async (name) => {
    const end = Date.now() + 2000
    while (Date.now() < end && !(await evaluate("document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)")))
      await pause(25)
    await evaluate("document.fonts.ready")
    await frame()
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
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
  const center = (selector) => evaluate(`(() => { const node = ${selector}; if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const rowOf = (title) => `[...document.querySelectorAll('[data-thread-row]')].find((row) => row.textContent.includes(${JSON.stringify(title)}))`
  const openRow = async (title) => {
    const point = await center(rowOf(title))
    await mouse("mousePressed", point)
    await mouse("mouseReleased", point)
  }
  const field = "[data-composer] textarea"
  const copyTitle = "Plan the billing ledger migration"
  const recordsTitle = "Audit the webhook signatures"

  try {
    for (const theme of ["dark", "light"]) {
      await window.loadURL(`${process.env.MAKO_KEPT_CHECK_URL}?mock&app=kept`)
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer")
      await evaluate(`localStorage.setItem("mako.prefs.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("mako.prefs.v1") ?? "{}"), theme: ${JSON.stringify(theme)} })); true`)
      await window.loadURL(`${process.env.MAKO_KEPT_CHECK_URL}?mock&app=kept`)
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer again")
      assert.equal(await evaluate("document.documentElement.classList.contains('light')"), theme === "light", `the window is ${theme}`)
      await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
      await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")

      // The rail: each kept row wears the mark, and its tip says who keeps it.
      await until(`Boolean(${rowOf(copyTitle)})`, "the kept copy's row")
      const copyTip = await evaluate(`${rowOf(copyTitle)}.closest('[data-tip]')?.dataset.tip ?? ${rowOf(copyTitle)}.dataset.tip ?? ''`)
      assert.match(copyTip, /Mako's copy · .+ deleted this session/, "the copy's tip says it's Mako's copy")
      assert.equal(await evaluate(`${rowOf(copyTitle)}.querySelector('[data-kept]')?.dataset.kept`), "copy")
      const recordsTip = await evaluate(`${rowOf(recordsTitle)}.closest('[data-tip]')?.dataset.tip ?? ${rowOf(recordsTitle)}.dataset.tip ?? ''`)
      assert.match(recordsTip, /Kept by Mako · .+ deleted this session/, "the records' tip says Mako kept it")
      assert.equal(await evaluate(`${rowOf(recordsTitle)}.querySelector('[data-kept]')?.dataset.kept`), "records")

      // The copy, opened: its first line says what it is, and the composer offers what's possible.
      await openRow(copyTitle)
      await until("document.querySelector('[data-kept-opening]')?.textContent.includes(\"Mako's copy\")", "the copy's opening line")
      const opening = await evaluate("document.querySelector('[data-kept-opening]').textContent")
      assert.match(opening, /^Mako's copy · .+ deleted this session$/)
      const placeholder = await evaluate(`document.querySelector(${JSON.stringify(field)}).placeholder`)
      assert.match(placeholder, /continues from this transcript in a new .+ session/, `the composer offers a transcript continuation: ${placeholder}`)
      // Its tip, as a hover shows it, at the top of the history.
      await evaluate("document.querySelector('[data-kept-opening]').scrollIntoView({ block: 'center' }); true")
      await pause(200)
      const mark = await center("document.querySelector('[data-kept-opening]')")
      await mouse("mouseMoved", mark)
      await until("Boolean(document.querySelector('[data-slot=\"tooltip-content\"], [role=\"tooltip\"]'))", "the opening's tip", 4000)
      const tip = await evaluate("(document.querySelector('[data-slot=\"tooltip-content\"]') ?? document.querySelector('[role=\"tooltip\"]')).textContent")
      assert.match(tip, /can't resume it and newer versions of Mako can't read it again/)
      await capture(`kept-copy-${theme}.png`)
      await mouse("mouseMoved", { x: 640, y: 20 })

      // The session whose records Mako kept.
      await openRow(recordsTitle)
      await until("document.querySelector('[data-kept-opening]')?.textContent.startsWith('Kept by Mako')", "the records' opening line")
      await evaluate("document.querySelector('[data-kept-opening]').scrollIntoView({ block: 'center' }); true")
      assert.match(await evaluate(`document.querySelector(${JSON.stringify(field)}).placeholder`), /^Reply — Mako restores this session and .+ resumes it$/, "a session whose records Mako keeps resumes natively")
      const recordsMark = await center("document.querySelector('[data-kept-opening]')")
      await mouse("mouseMoved", recordsMark)
      await until("(document.querySelector('[data-slot=\"tooltip-content\"]') ?? document.querySelector('[role=\"tooltip\"]'))?.textContent.includes('resumes it as the same session')", "the records' tip", 4000)
      await pause(200)
      await capture(`kept-records-${theme}.png`)
      await mouse("mouseMoved", { x: 640, y: 20 })
    }
    console.log("✓ a session its harness deleted says who keeps it in its rail tip, at the top of its history and in the composer, light and dark")
    guard.done()
    app.exit(0)
  } catch (error) {
    console.error(error)
    guard.done()
    app.exit(1)
  }
}
