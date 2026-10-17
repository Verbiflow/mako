import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// A fork's view, against the mock bridge's fork-opening scene
// (`?mock&app=fork-opening`), light and dark: the parent's turns are its
// history, and what the fork's own session said as it opened (two MCP
// servers that failed) is drawn under its first prompt. Checks the order and
// writes the screenshots.
//
//   node scripts/test-fork-opening-ui.mjs [out]
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), "mako-fork-opening-ui-"))
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, watch: null } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fork-opening-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_FORK_CHECK_ROOT: root, MAKO_FORK_CHECK_URL: server.resolvedUrls.local[0] }
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
  console.log(`Fork opening UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_FORK_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const timer = setTimeout(() => app.exit(1), 120_000)
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
  const transcript = () => evaluate("(document.querySelector('main') ?? document.body).innerText")
  const first = "The rail selected the entire store object"
  const asked = "And what about the status bar?"
  const forked = "Finished: And what about the status bar?"

  try {
    for (const theme of ["dark", "light"]) {
      await window.loadURL(`${process.env.MAKO_FORK_CHECK_URL}?mock&app=fork-opening`)
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer")
      // The theme is a preference the app paints again whenever preferences change.
      await evaluate(`localStorage.setItem("mako.prefs.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("mako.prefs.v1") ?? "{}"), theme: ${JSON.stringify(theme)} })); true`)
      await window.loadURL(`${process.env.MAKO_FORK_CHECK_URL}?mock&app=fork-opening`)
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer again")
      assert.equal(await evaluate("document.documentElement.classList.contains('light')"), theme === "light", `the window is ${theme}`)
      await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
      await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")

      await send("Find out why the session rail re-renders on every token")
      await until(`document.body.textContent.includes(${JSON.stringify(first)})`, "the first reply")
      await until("Boolean(document.querySelector('button[title^=\"Fork after this answer\"]'))", "the answer's Fork button")
      await evaluate("document.querySelector('button[title^=\"Fork after this answer\"]').click(); true")
      await until(`!document.body.textContent.includes(${JSON.stringify(asked)}) && document.querySelectorAll('[data-composer] textarea').length > 0`, "the fork")
      await pause(300)
      await send(asked)
      await until(`document.body.textContent.includes(${JSON.stringify(forked)})`, "the fork's reply")
      await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")

      const text = await transcript()
      const history = text.indexOf(first)
      const prompt = text.indexOf(asked)
      const notes = text.indexOf("2 MCP servers didn't start")
      const reply = text.indexOf(forked)
      assert.ok(history >= 0 && history < prompt, "the fork shows its parent's turns above its own")
      assert.ok(prompt < notes && notes < reply, "what the fork's session said as it opened sits under the prompt it opened for, above its answer")
      assert.match(text.slice(notes, reply), /paper, wisprflow/, "as one line naming both servers")
      assert.equal(await evaluate("document.querySelectorAll('[data-event-line]').length"), 1, "and nothing else draws a note")
      await capture(`fork-${theme}.png`)
    }
    console.log("✓ a fork draws what its session said as it opened under its first prompt, after its parent's turns, light and dark")
    clearTimeout(timer)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timer)
    app.exit(1)
  }
}
