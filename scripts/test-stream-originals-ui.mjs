import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// "Original" on a live conversation, against the mock bridge's streams scene
// (`?mock&app=streams`), light and dark: an answer still streaming shows the
// stream lines it came from and says the record hasn't written it yet; an
// answer whose record has landed shows the record's bytes and the stream
// lines beside them. Checks each and writes the screenshots.
//
//   node scripts/test-stream-originals-ui.mjs [out]
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), "mako-stream-originals-ui-"))
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, watch: null } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-stream-originals-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_ORIGINALS_CHECK_ROOT: root, MAKO_ORIGINALS_CHECK_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Stream originals UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ORIGINALS_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const timer = setTimeout(() => app.exit(1), 120_000)
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const capture = async (name, selector) => {
    const end = Date.now() + 2000
    while (Date.now() < end && !(await evaluate("document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)")))
      await pause(25)
    await evaluate("document.fonts.ready")
    await frame()
    const bounds = selector
      ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)} })()`)
      : undefined
    await writeFile(join(root, name), (await page.capturePage(bounds)).toPNG())
  }
  const until = async (code, what = code, ms = 15_000) => {
    const end = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${what}`)
      }
      await pause(25)
    }
  }
  const press = async (key, code = key, keyCode = 13) => {
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
  }
  const field = "[data-composer] textarea"
  const send = async (text) => {
    await evaluate(`document.querySelector(${JSON.stringify(field)}).focus()`)
    await page.debugger.sendCommand("Input.insertText", { text })
    await press("Enter")
  }
  /** The first Original button after the text `said`, in the answer's own footer. */
  const openOriginal = (said) => evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) && !node.textContent.includes(${JSON.stringify(said)})) {}
    if (!node) return false
    const button = [...document.querySelectorAll("[data-show-original]")].find((each) => node.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_FOLLOWING)
    button?.click()
    return Boolean(button)
  })()`)
  const side = (name) => evaluate(`document.querySelector("[data-original-dialog] [data-original-side=${name}]")?.innerText ?? null`)
  const closeDialog = async () => {
    await press("Escape", "Escape", 27)
    await until("!document.querySelector('[data-original-dialog]')", "the dialog closed")
  }
  const first = "The rail selected the entire store object"
  const second = "Finished: Then look at the status bar"

  try {
    for (const theme of ["dark", "light"]) {
      await window.loadURL(`${process.env.MAKO_ORIGINALS_CHECK_URL}?mock&app=streams`)
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer")
      // The theme is a preference the app paints again whenever preferences change; Original is a debugging aid,
      // offered only once Settings › Diagnostics turns it on.
      await evaluate(`localStorage.setItem("mako.prefs.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("mako.prefs.v1") ?? "{}"), theme: ${JSON.stringify(theme)}, showOriginals: true })); true`)
      await window.loadURL(`${process.env.MAKO_ORIGINALS_CHECK_URL}?mock&app=streams`)
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer again")
      assert.equal(await evaluate("document.documentElement.classList.contains('light')"), theme === "light", `the window is ${theme}`)
      await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
      await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")

      // The first turn's record lands when the second is sent; the second is still only streamed.
      await send("Find out why the session rail re-renders on every token")
      await until(`document.body.textContent.includes(${JSON.stringify(first)})`, "the first reply")
      await send("Then look at the status bar")
      await until(`document.body.textContent.includes(${JSON.stringify(second)})`, "the second reply")

      assert.ok(await openOriginal(second), "the live answer offers its original")
      await until("Boolean(document.querySelector('[data-original-dialog] [data-original-side=stream]'))", "the live answer's two sides")
      assert.match(await side("record"), /In the session's record\s+Not in the record yet: the harness hasn't written this turn\./)
      const streamed = await side("stream")
      assert.match(streamed, /As it streamed/)
      assert.match(streamed, /~\/\.mako\/records\/streams\/\w+\/\s*mock-/, "the stream side names its file")
      assert.match(streamed, new RegExp(second), "the stream side holds the line the answer came from")
      await capture(`live-${theme}.png`, "[data-original-dialog]")
      await closeDialog()

      assert.ok(await openOriginal(first), "the landed answer offers its original")
      await until("Boolean(document.querySelector('[data-original-dialog] [data-original-side=stream]'))", "the landed answer's two sides")
      const record = await side("record")
      assert.match(record, /In the session's record/)
      assert.match(record, /bytes \d[\d,]*–\d[\d,]*/, "the record side shows the record's bytes")
      assert.match(record, new RegExp(first), "the record side holds the record's line")
      assert.doesNotMatch(record, /Not in the record yet/)
      assert.match(await side("stream"), new RegExp(first), "the stream side still holds what streamed")
      assert.match(await evaluate("document.querySelector('[data-original-dialog]').innerText"), /~\/\.\w+\/sessions\/\s*mock-/, "the header names the record file")
      await capture(`merged-${theme}.png`, "[data-original-dialog]")
      await closeDialog()
    }
    console.log("✓ a streaming answer shows its stream lines and no record yet; a landed one shows both, light and dark")
    clearTimeout(timer)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timer)
    app.exit(1)
  }
}
