import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * Another device's cloud Thread, as this Mac's window shows it, against the production components and the fixture
 * desk signed in with the cloud: the host's `live-listed` arrives (the account's list said it), and the conversation
 * is in the rail at once, unopened, under its project; it changes as the list does, working then done; and when it
 * leaves the list it leaves the rail, and the one on screen says so. Screenshots of each, dark and light, stay in the
 * printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-account-threads-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-account-threads-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
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
  console.log(`UI evidence: ${root}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Account Threads UI verification exceeded its 120-second limit")
    app.exit(1)
  }, 120_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  const capture = async (name, around) => {
    await settle()
    await writeFile(join(root, `${name}.png`), (await page.capturePage()).toPNG())
    if (!around) return
    const rect = await evaluate(`(() => {
      const nodes = ${JSON.stringify(around)}.flatMap(selector => [...document.querySelectorAll(selector)])
      if (!nodes.length) return null
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = 16
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
    if (rect) await writeFile(join(root, `${name}-crop.png`), (await page.capturePage(rect)).toPNG())
  }
  const theme = async (next) => {
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(next)}}))`)
    await evaluate(`new Promise(resolve => { const check = () => document.documentElement.classList.contains('light') === ${next === "light"} ? resolve(true) : requestAnimationFrame(check); check() })`)
  }
  const both = async (name, around) => {
    await capture(name, around)
    await theme("light")
    await capture(`${name}-light`, around)
    await theme("dark")
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const click = async (selector) => {
    const at = await evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })()`)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at })
  }
  /** An event as this Mac's host sends it, through the window's own event path. */
  const hostEvent = (event) => evaluate(`(globalThis.makoMockHost.emit(${JSON.stringify(event)}), true)`)
  const ID = "4d2f8e61-3c7a-4b9e-8f10-6a5b2c9d7e31"
  const title = "Reproduce the flaky upload on Linux"
  const listed = (status) => ({
    session: { id: ID, harness: "codex", cwd: "/Users/you/api", title, status, connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
    revision: 0,
    createdAt: Date.now() - 90_000,
    elsewhere: "a cloud machine",
  })
  const row = `[...document.querySelectorAll('[data-thread-row]')].find(row => row.innerText.includes(${JSON.stringify(title)}))`

  {
    await window.loadURL(`${base}?mock&cloud=signed-in&invited&events`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark'}))`)
    await until(`Boolean(document.querySelector('[data-thread-row]')) && Boolean(globalThis.makoMockHost)`, "the rail and the fixture's host")
    assert.equal(await evaluate(`Boolean(${row})`), false, "not listed before the account says so")
    // The fixture desk's own toast (its deliberately broken plugin) isn't what's shown here.
    await until(`(document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(button => button.click()), !document.querySelector('[data-sonner-toast]'))`, "the fixture's toasts closed")
    const reading = () => evaluate(`[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(tab => tab.innerText).join(" | ")`)
    const before = await reading()
    await both("before", ["[data-thread-row]"])

    // 1. The account's list says another device's cloud conversation, at work: it's in the rail at once, unopened.
    await hostEvent({ type: "live-listed", summaries: [listed("running")] })
    await until(`Boolean(${row})`, "the listed conversation in the rail")
    await settle()
    assert.equal(await reading(), before, "what the person was reading stays on screen: a listing selects nothing")
    assert.equal(await evaluate(`import('/src/state/acp-state.ts').then(({ acpStore }) => acpStore.get().activeKey)`), null, "nor opens anything")
    await both("listed-working", ["[data-thread-row]"])

    // 2. It finished there: the row says so as the list changes.
    await hostEvent({ type: "live-listed", summaries: [listed("ready")] })
    await settle()
    await both("listed-done", ["[data-thread-row]"])

    // 3. Opened, then it left the list (it went back to the computer it came from): gone from the rail, and said.
    await evaluate(`(() => { ${row}.setAttribute('data-listed-row', ''); return true })()`)
    await click("[data-listed-row]")
    await settle()
    await capture("opened")
    await hostEvent({ type: "live-unlisted", ids: [ID] })
    await until(`!${row}`, "gone from the rail")
    await until(`document.body.innerText.includes('That conversation left the cloud')`, "the one on screen says it left")
    await both("unlisted", ["[data-sonner-toast]", "[data-thread-row]"])
    console.log("Account Threads UI: another device's cloud conversation is listed in the rail at once, unopened, changes as the list does, and leaves it, saying so on screen")
  }
  clearTimeout(watchdog)
  app.exit(0)
}
