import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * A cloud Thread's app while its machine sleeps, against the production components and the fixture desk: the strip
 * says Asleep quietly; its menu says what sleeps, that the app paused with it, what wakes it, and the app's processes
 * as they paused; its one action says it wakes the machine. A click on it shows Waking up at once, and the app as it
 * comes back. Screenshots of asleep, waking and awake, dark and light, stay in the printed directory (or `--out`).
 *
 *   node scripts/test-cloud-app-asleep-ui.mjs [--out <dir>] [--port <port>]
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-asleep-app-ui-"))
  const out = option("--out") ? resolve(option("--out")) : root
  await mkdir(out, { recursive: true })
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: Number(option("--port") ?? 0), strictPort: option("--port") !== undefined },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-asleep-app-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_OUT: out, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`UI evidence: ${out}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const out = process.env.MAKO_UI_TEST_OUT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Cloud app asleep UI verification exceeded its 90-second limit")
    app.exit(1)
  }, 90_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    // A spinner and a shimmer run for good; wait out only what ends.
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  /** A crop around the strip's control, and its menu when open. */
  const capture = async (name) => {
    await settle()
    const rect = await evaluate(`(() => {
      const nodes = ['[data-app-control]', '[role="menu"]'].flatMap(selector => [...document.querySelectorAll(selector)])
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = 24
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad - 240))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
    await writeFile(join(out, `${name}.png`), (await page.capturePage(rect)).toPNG())
  }
  const theme = async (next) => {
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(next)}}))`)
    await evaluate(`new Promise(resolve => { const check = () => document.documentElement.classList.contains('light') === ${next === "light"} ? resolve(true) : requestAnimationFrame(check); check() })`)
  }
  const both = async (name) => {
    await capture(`${name}-dark`)
    await theme("light")
    await capture(`${name}-light`)
    await theme("dark")
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await writeFile(join(out, "failure.png"), (await page.capturePage()).toPNG())
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const click = async (selector) => {
    const at = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at })
  }
  const away = () => page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 600 })
  const escape = async () => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await until(`!document.querySelector('[role="menu"]')`, "the menu closed")
  }
  const menuText = () => evaluate(`document.querySelector('[role="menu"]').innerText.replace(/\\s+/g, ' ').trim()`)
  const open = async (scenario) => {
    await window.loadURL(`${base}?mock&app=${scenario}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railWidth: 264, theme: 'dark'}))`)
    await theme("dark")
  }

  // 1. Asleep, the app paused running: a quiet mark, and a menu that says what sleeps, how the app was left and what wakes it.
  await open("asleep")
  await until(`document.querySelector('[data-app-control="asleep"]')?.textContent === 'Asleep'`, "the strip says Asleep")
  await away()
  await both("asleep-view-asleep-strip")
  await click('[data-app-control="asleep"]')
  await until(`document.querySelector('[role="menu"] [data-app-action="open"]') !== null`, "the asleep menu")
  const asleepMenu = await menuText()
  for (const text of ["Asleep", "This Thread runs on a cloud machine, asleep while nothing needs it.", "Its app paused with it.", "Sending a message or opening the app wakes it.", "web", "Paused · :20140", "Open in browser", "Wakes the machine"])
    assert.ok(asleepMenu.includes(text), `the asleep menu says ${text}: ${asleepMenu}`)
  await both("asleep-view-asleep")
  await escape()

  // 2. Waking: what's waking, and the app coming back as it was.
  await open("waking")
  await until(`document.querySelector('[data-app-control="waking"]')?.textContent === 'Waking up'`, "the strip says Waking up")
  await click('[data-app-control="waking"]')
  await until(`document.querySelector('[role="menu"]') !== null`, "the waking menu")
  const wakingMenu = await menuText()
  for (const text of ["Waking up", "This Thread runs on a cloud machine, which is waking up.", "Its app comes back as it was.", "web", "Waking"])
    assert.ok(wakingMenu.includes(text), `the waking menu says ${text}: ${wakingMenu}`)
  assert.equal(await evaluate(`document.querySelector('[role="menu"] [role="menuitem"]')`), null, "nothing to do while it wakes")
  await both("asleep-view-waking")
  await escape()

  // 3. Asleep with the app stopped: Run wakes the machine, shown at once, then the app starts and runs.
  await open("asleep-stopped")
  await until(`document.querySelector('[data-app-control="asleep"]') !== null`, "asleep, stopped")
  await click('[data-app-control="asleep"]')
  await until(`document.querySelector('[role="menu"] [data-app-action="run"]') !== null`, "Run in the asleep menu")
  const stoppedMenu = await menuText()
  for (const text of ["Its app wasn't running.", "Sending a message or running the app wakes it.", "Run app", "Wakes the machine"])
    assert.ok(stoppedMenu.includes(text), `the stopped app's asleep menu says ${text}: ${stoppedMenu}`)
  assert.equal(await evaluate(`document.querySelector('[role="menu"] [data-app-row]')`), null, "nothing paused to list")
  await both("asleep-view-asleep-stopped")
  await click('[role="menu"] [data-app-action="run"]')
  await until(`document.querySelector('[data-app-control="waking"]')?.textContent === 'Waking up'`, "the click shows Waking up at once")
  await away()
  await capture("asleep-view-waking-strip-dark")
  await until(`document.querySelector('[data-app-control="running"]') !== null`, "the app running once awake")
  await click('[data-app-control="running"]')
  await until(`document.querySelector('[role="menu"] [data-app-action="stop"]') !== null`, "the running menu")
  assert.match(await menuText(), /Running/)
  await both("asleep-view-awake")
  await escape()

  clearTimeout(watchdog)
  console.log("Cloud app asleep: the strip says Asleep and its menu what sleeps, how the app paused, what wakes it and its processes; Waking up says the app comes back as it was; Run on a sleeping machine shows Waking up at once, then runs")
  app.exit(0)
}
