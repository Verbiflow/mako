import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * A cloud Thread archived from the sidebar, and restored, against the production components and the fixture desk
 * signed in with the cloud. The host's side is played through the window's own bridge and event path: archiving
 * reports its steps (its machine packing, its machine ending), then the cloud's outcome, and the account's word that it's
 * archived. The row leaves the current threads at once and shows with the archived ones; restoring brings it back. A
 * Thread at work can't be archived yet and says so; one whose machine can't start offers to archive it anyway.
 * Screenshots of each, dark and light, stay in the printed directory (`MAKO_UI_SHOTS` copies them there too).
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-archive-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-archive-check", main: fileURLToPath(import.meta.url) }))
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
  const shots = process.env.MAKO_UI_SHOTS
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Cloud archive UI verification exceeded its 120-second limit")
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
  const save = async (name, image) => {
    await writeFile(join(root, `${name}.png`), image.toPNG())
    if (shots) await writeFile(join(shots, `cloud-archive-${name}.png`), image.toPNG())
  }
  const capture = async (name, around) => {
    await settle()
    if (!around) return save(name, await page.capturePage())
    const rect = await evaluate(`(() => {
      const nodes = ${JSON.stringify(around)}.flatMap(selector => [...document.querySelectorAll(selector)])
      if (!nodes.length) return null
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = 16
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
    await save(name, rect ? await page.capturePage(rect) : await page.capturePage())
  }
  const theme = async (next) => {
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(next)}}))`)
    await evaluate(`new Promise(resolve => { const check = () => document.documentElement.classList.contains('light') === ${next === "light"} ? resolve(true) : requestAnimationFrame(check); check() })`)
  }
  const both = async (name, around) => {
    await capture(`${name}-dark`, around)
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
  const away = () => page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 40 })
  const hostEvent = (event) => evaluate(`(globalThis.makoMockHost.emit(${JSON.stringify(event)}), true)`)
  const THREAD = "t-4f1c9a5208d4e6b2"
  const ID = "6c3e9b2a-1d4f-4a8e-9b7c-2e5f0a1d3c84"
  const BUSY = "8a1f3c5e-7b9d-4e2a-8c6f-0d1b3e5a7c92"
  const title = "Prove the move on Grok"
  const busyTitle = "Run the full proof on all six harnesses"
  const listed = (id, rowTitle, status) => ({
    session: { id, harness: "grok", cwd: "/Users/you/mako", title: rowTitle, status, connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
    revision: 0,
    createdAt: Date.now() - 3 * 3_600_000,
    elsewhere: "a cloud machine",
  })
  const rowOf = (text) => `[...document.querySelectorAll('[data-thread-row]')].find(row => row.innerText.includes(${JSON.stringify(text)}))`
  const row = rowOf(title)
  const toast = `document.querySelector('[data-sonner-toast]')`
  /** The host's side of an archive, played through the window's own bridge: its steps, then the cloud's outcome. */
  const playHost = (script) => evaluate(`(() => {
    const emit = globalThis.makoMockHost.emit
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
    globalThis.cloudArchive = { release: undefined, asked: [] }
    window.mako.archiveThread = async (command) => {
      globalThis.cloudArchive.asked.push(command)
      ${script}
    }
    return true
  })()`)
  const openMenu = async (text) => {
    await evaluate(`(() => { ${rowOf(text)}.setAttribute('data-shot-row', ''); return true })()`)
    // Hovered first: a row at work shows its Stop beside the menu only then, which moves the menu's button.
    const at = await evaluate(`(() => { const box = document.querySelector('[data-shot-row]').getBoundingClientRect(); return { x: box.left + 40, y: box.top + box.height / 2 } })()`)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await settle()
    await click(`[data-shot-row] [aria-label^="Actions for"]`)
    await until(`Boolean(document.querySelector('[data-thread-action="archive"]'))`, "the row's menu")
  }
  const closeMenu = async () => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await until(`!document.querySelector('[data-thread-action="archive"]')`, "the menu closed")
    await evaluate(`(document.querySelectorAll('[data-shot-row]').forEach(node => node.removeAttribute('data-shot-row')), true)`)
  }
  const clearToasts = () => until(`(document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(button => button.click()), !document.querySelector('[data-sonner-toast]'))`, "the toasts closed")

  await window.loadURL(`${base}?mock&cloud=signed-in&invited&events`)
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'recent', railWidth: 300, theme: 'dark'}))`)
  await until(`Boolean(document.querySelector('[data-thread-row]')) && Boolean(globalThis.makoMockHost)`, "the rail and the fixture's host")
  await clearToasts()
  await hostEvent({ type: "live-listed", summaries: [listed(ID, title, "ready"), listed(BUSY, busyTitle, "running")] })
  await until(`Boolean(${row}) && Boolean(${rowOf(busyTitle)})`, "the cloud rows in the rail")

  // 1. A cloud Thread at work: archiving waits for its turn to end, and says so in the menu.
  await openMenu(busyTitle)
  const busyItem = await evaluate(`(() => { const item = document.querySelector('[data-thread-action="archive"]'); return { text: item.innerText, disabled: item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('data-disabled') } })()`)
  assert.deepEqual(busyItem, { text: "Archive once its turn ends", disabled: true })
  await both("busy-menu", ["[role=menu]", "[data-shot-row]"])
  await closeMenu()

  // 2. Archived: the machine packs, then ends; the row leaves the current threads, and the toast says what changed.
  await playHost(`
    emit({ type: "cloud-archive-step", step: { thread: "${THREAD}", kind: "packing" } })
    await new Promise(resolve => { globalThis.cloudArchive.release = resolve })
    emit({ type: "cloud-archive-step", step: { thread: "${THREAD}", kind: "ending" } })
    await new Promise(resolve => { globalThis.cloudArchive.release = resolve })
    const keys = ["live:${ID}"]
    const snapshot = { revision: 50, keys }
    emit({ type: "thread-archives", snapshot })
    return { ...snapshot, cloud: { kind: "archived", thread: "${THREAD}" } }
  `)
  await openMenu(title)
  assert.equal(await evaluate(`document.querySelector('[data-thread-action="archive"]').innerText`), "Archive thread")
  await both("menu", ["[role=menu]", "[data-shot-row]"])
  await click(`[data-thread-action="archive"]`)
  await until(`${toast}?.innerText.includes('Saving its checkout and history in the cloud')`, "the packing step")
  await away()
  await both("packing", ["[data-sonner-toast]"])
  await evaluate(`(globalThis.cloudArchive.release(), true)`)
  await until(`${toast}?.innerText.includes('Ending its cloud machine')`, "the ending step")
  await both("ending", ["[data-sonner-toast]"])
  await evaluate(`(globalThis.cloudArchive.release(), true)`)
  await until(`${toast}?.innerText.includes('Thread archived')`, "the outcome")
  assert.match(await evaluate(`${toast}.innerText`), /Its cloud machine is gone and its history is kept\. Restore it from Archived\./)
  await until(`!${row}`, "the row gone from the current threads")
  assert.equal(await evaluate(`globalThis.cloudArchive.asked.length`), 1, "one ask for the Thread")
  await both("archived", ["[data-sonner-toast]", "[data-thread-row]"])
  await capture("archived-window")
  await clearToasts()

  // 3. With the archived ones: it's there, and restoring brings it back to this Mac.
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'archived'}))`)
  await until(`Boolean(${row})`, "the row with the archived ones")
  await playHost(`
    emit({ type: "cloud-archive-step", step: { thread: "${THREAD}", kind: "bringing" } })
    await new Promise(resolve => { globalThis.cloudArchive.release = resolve })
    const snapshot = { revision: 51, keys: [] }
    emit({ type: "thread-archives", snapshot })
    return { ...snapshot, cloud: { kind: "restored", thread: "${THREAD}" } }
  `)
  await openMenu(title)
  assert.equal(await evaluate(`document.querySelector('[data-thread-action="archive"]').innerText`), "Restore thread")
  await both("restore-menu", ["[role=menu]", "[data-shot-row]"])
  await click(`[data-thread-action="archive"]`)
  await until(`${toast}?.innerText.includes('Bringing its checkout and history to this Mac')`, "the bringing step")
  await away()
  await both("restoring", ["[data-sonner-toast]"])
  await evaluate(`(globalThis.cloudArchive.release(), true)`)
  await until(`${toast}?.innerText.includes('Thread restored')`, "restored")
  await until(`!${row}`, "gone from the archived ones")
  await both("restored", ["[data-sonner-toast]"])
  await clearToasts()

  // 4. Its machine can't start: nothing changed, and archiving it anyway is offered, saying what it keeps.
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'recent'}))`)
  await until(`Boolean(${row})`, "back with the current threads")
  await playHost(`
    if (command.anyway) {
      const snapshot = { revision: 52, keys: ["live:${ID}"] }
      emit({ type: "thread-archives", snapshot })
      return { ...snapshot, cloud: { kind: "archived", thread: "${THREAD}" } }
    }
    emit({ type: "cloud-archive-step", step: { thread: "${THREAD}", kind: "packing" } })
    return { revision: 51, keys: [], cloud: { kind: "refused", thread: "${THREAD}", reason: "This Thread couldn't start in the cloud. Try again in a moment.", anyway: true } }
  `)
  await openMenu(title)
  await click(`[data-thread-action="archive"]`)
  await until(`${toast}?.innerText.includes("The thread wasn't archived")`, "the refusal")
  assert.match(await evaluate(`${toast}.innerText`), /couldn't start in the cloud[\s\S]*Archived anyway, its history is kept but not its checkout's changes since it moved, and it can't be restored\./)
  assert.ok(Boolean(await evaluate(`Boolean(${row})`)), "nothing changed: the row stays")
  await away()
  await both("refused-anyway", ["[data-sonner-toast]", "[data-thread-row]"])
  await click(`[data-sonner-toast] [data-button]`)
  await until(`!${row}`, "archived anyway")
  const asked = await evaluate(`globalThis.cloudArchive.asked.map(command => [command.archived, command.anyway === true])`)
  assert.deepEqual(asked, [[true, false], [true, true]], "the second ask is anyway, under its own ID")
  assert.notEqual(await evaluate(`globalThis.cloudArchive.asked[0].id`), await evaluate(`globalThis.cloudArchive.asked[1].id`))

  clearTimeout(watchdog)
  console.log("PASS: a cloud Thread is archived from its row, step by step, and leaves the current threads; it shows with the archived ones and is restored from there; one at work waits for its turn, and one whose machine can't start offers to archive it anyway")
  app.exit(0)
}
