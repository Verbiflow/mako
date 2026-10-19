import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// A switch to another harness, against the mock bridge (`?mock`), light and
// dark: the person's words keep their own bubble, and one quiet line above
// them says where the conversation came from and how much of it went
// ("Continued from Claude Code · 1 turn"). No message of Mako's stands in
// the transcript; the line's action opens the transcript the agent was given.
// Checks the line, its place and what it opens, and writes the screenshots.
//
//   node scripts/test-carried-history-ui.mjs [out]
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), "mako-carried-history-ui-"))
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, watch: null } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-carried-history-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_CARRIED_CHECK_ROOT: root, MAKO_CARRIED_CHECK_URL: server.resolvedUrls.local[0] }
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
  console.log(`Carried history UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_CARRIED_CHECK_ROOT
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
  const useHarness = (id) => evaluate(`import('/src/state/threads.ts').then(m => m.setComposerHarness(${JSON.stringify(id)}))`)
  const first = "Find out why the session rail re-renders on every token"
  const asked = "Now review what you found"
  const line = "document.querySelector('[data-carried-history]')"

  try {
    for (const theme of ["dark", "light"]) {
      await window.loadURL(`${process.env.MAKO_CARRIED_CHECK_URL}?mock`)
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer")
      await evaluate(`localStorage.setItem("mako.prefs.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("mako.prefs.v1") ?? "{}"), theme: ${JSON.stringify(theme)} })); true`)
      await window.loadURL(`${process.env.MAKO_CARRIED_CHECK_URL}?mock`)
      await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer again")
      assert.equal(await evaluate("document.documentElement.classList.contains('light')"), theme === "light", `the window is ${theme}`)
      await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
      await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")

      await useHarness("claude")
      await send(first)
      await until("document.querySelectorAll('[data-exchange]').length === 1 && !document.querySelector('[data-exchange] [data-streaming]')", "the first answer")
      await until(`!${line}`, "no line before a switch", 2000)
      await useHarness("codex")
      await pause(200)
      await send(asked)
      await until(`Boolean(${line})`, "the line above the switched prompt")
      await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")

      const words = await evaluate(`${line}.innerText`)
      assert.match(words, /Continued from Claude Code/, "it names where the conversation came from")
      assert.match(words, /1 turn\b/, "and how much of it went")
      const text = await transcript()
      assert.ok(text.indexOf(first) < text.indexOf("Continued from") && text.indexOf("Continued from") < text.lastIndexOf(asked), "between the first turn and the person's words")
      assert.equal(await evaluate(`[...document.querySelectorAll('[data-exchange]')].at(-1).innerText.includes(${JSON.stringify(asked)})`), true, "the person's words are their own")
      assert.ok(!/Read the conversation|transcript\.md/.test(text), "no handoff text stands in the transcript")
      assert.equal(await evaluate("document.querySelectorAll('[data-carried-history]').length"), 1, "once")

      // The action shows on hover, as the transcript's other line actions do.
      const point = await evaluate(`(() => { const r = ${line}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
      await until(`getComputedStyle(${line}.querySelector('[data-open-transcript]').parentElement).opacity === '1'`, "the Transcript action on hover")
      await capture(`carried-${theme}.png`)
      await evaluate(`${line}.querySelector('[data-open-transcript]').click(); true`)
      await until("document.body.innerText.includes('The conversation so far, from claude')", "the transcript the agent was given, opened")
      await capture(`carried-transcript-${theme}.png`)
    }
    console.log("✓ a switch to another harness draws one quiet line above the person's words, naming where it came from and how much, and opens the transcript the agent got, light and dark")
    clearTimeout(timer)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timer)
    app.exit(1)
  }
}
