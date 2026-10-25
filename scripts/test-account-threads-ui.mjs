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
 * leaves the list it leaves the rail, and the one on screen says so. Another Mac's conversation opened while that Mac is
 * off reads from the copy it keeps in the account: the composer says what it's reading, how old, and when a message can
 * go. Screenshots of each, dark and light, stay in the printed directory.
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

    // 1b. Another Mac's Session, waiting on an approval there: the row needs the person here too, says for what, and where.
    const STUDIO = "7e3a9d14-2b6c-4f8e-9a1d-5c0b3e2f4a61"
    const studioTitle = "Bump the harness versions"
    const studioRow = `[...document.querySelectorAll('[data-thread-row]')].find(row => row.innerText.includes(${JSON.stringify(studioTitle)}))`
    await hostEvent({ type: "live-listed", summaries: [{ ...listed("running"), session: { ...listed("running").session, id: STUDIO, harness: "claude", title: studioTitle }, elsewhere: "Studio", waitingOn: "Approve: npm test" }] })
    await until(`Boolean(${studioRow})`, "the Studio's Session in the rail")
    const studioLabel = await evaluate(`${studioRow}.getAttribute('aria-label')`)
    assert.match(studioLabel, /on Studio/, "it says where it runs")
    assert.match(studioLabel, /Approve: npm test/, "and what it waits on, as a local approval is said")
    assert.equal(await evaluate(`${studioRow}.getAttribute('data-tip')`), `${studioTitle} · on Studio · Approve: npm test`)
    await settle()
    await both("listed-waiting", ["[data-thread-row]"])

    // 1c. The Studio is off: opened here, its conversation reads from the copy the Studio keeps in the account, and the
    // window says what it's reading, how old it is, and that a message waits for the Studio.
    await evaluate(`(() => { ${studioRow}.setAttribute('data-studio-row', ''); return true })()`)
    await click("[data-studio-row]")
    const copyAt = Date.now() - 4 * 60_000
    const entries = [
      { id: "u-1", type: "user", text: "Bump the harness versions and run the tests" },
      { id: "a-1", type: "text", text: "I bumped Codex to 0.163.2 and Grok to 1.0.52, then ran the suite. Two decoder fixtures changed; I re-recorded them and the tests pass. Should I open the pull request?" },
      { id: "u-2", type: "user", text: "Yes, and say which fixtures changed" },
      { id: "a-2", type: "text", text: "Opened it with both fixtures named in the description. Waiting on CI." },
    ]
    const copySnapshot = {
      session: { id: STUDIO, harness: "claude", cwd: "/Users/you/api", title: studioTitle, status: "ready", connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
      revision: copyAt, epoch: `copy-${copyAt}`, createdAt: copyAt - 3_600_000, copy: { at: copyAt }, elsewhere: "Studio",
      base: { ref: { harness: "claude", nativeId: "0b7e", path: `copy:${STUDIO}`, title: studioTitle, revision: "n:7" }, entries, start: 0, total: entries.length, hasEarlier: false, translator: "t-1" },
      blocks: [], permissions: [], requests: [],
    }
    await evaluate(`import('/src/state/live-recovery.ts').then(({ applyLiveSnapshot }) => (applyLiveSnapshot(${JSON.stringify(copySnapshot)}), true))`)
    await until(`Boolean(document.querySelector('[data-copy-notice]'))`, "the copy's notice above the composer")
    const notice = await evaluate(`document.querySelector('[data-copy-notice]').innerText`)
    assert.match(notice, /Studio is off/, "where it runs, and that it's off")
    assert.match(notice, /copy it keeps in your account, from 4 minutes ago/, "what's on screen, and how old")
    assert.match(notice, /once Studio is back/, "and that a message waits for it")
    await until(`document.body.innerText.includes('Waiting on CI.')`, "the copy's history on screen")
    assert.equal(await evaluate(`document.querySelector('textarea')?.getAttribute('placeholder')`), "Draft a message — it can go once Studio is back", "the composer says when a message can go")
    // The pointer off the rail, so no row's tip covers the pictures.
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 40 })
    await settle()
    await both("read-from-copy", ["[data-copy-notice]", "[data-thread-row]"])
    await capture("read-from-copy-window")

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
