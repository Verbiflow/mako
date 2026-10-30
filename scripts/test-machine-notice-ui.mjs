import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * A cloud Thread interrupted when its machine is lost, as the person sees it, against the production components and the
 * fixture desk signed in with the cloud. A machine lost and replaced is routine: nothing shows. What does, only because
 * the person's own work is affected:
 * - in the transcript, a step that was cut and picked up again, said without naming any machine;
 * - above the composer, changes that couldn't be kept (after a save, too large to save, or never saved), said as what's
 *   missing, put away with Got it;
 * - a Thread that couldn't start again, until a message tries again.
 * Each is checked, and captured dark and light, with its detail open, into `MAKO_UI_SHOTS` (or the printed directory)
 * as `machine-loss-*.png`.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-machine-notice-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-machine-notice-check", main: fileURLToPath(import.meta.url) }))
  const shots = process.env.MAKO_UI_SHOTS ?? root
  await mkdir(shots, { recursive: true })
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_SHOTS: shots, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
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
  console.log(`UI evidence: ${shots}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const shots = process.env.MAKO_UI_SHOTS
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Machine notice UI verification exceeded its 180-second limit")
    app.exit(1)
  }, 180_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  /** A crop around the nodes `around` matches, padded, as the person's eye takes it in. */
  const capture = async (name, around) => {
    await settle()
    const rect = await evaluate(`(() => {
      const nodes = ${JSON.stringify(around)}.flatMap(selector => [...document.querySelectorAll(selector)])
      if (!nodes.length) return null
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = 28
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
    assert.ok(rect, `nothing to capture for ${name}`)
    await writeFile(join(shots, `machine-loss-${name}.png`), (await page.capturePage(rect)).toPNG())
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
      if (Date.now() > deadline) throw new Error(`UI condition timed out: ${label}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const point = (selector) =>
    evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  const click = async (selector) => {
    const at = await point(selector)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at })
  }
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const enter = async () => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  }
  /** The Thread's object's word on its machine, as the host relays it from the Thread's stream. */
  const notice = (body) => evaluate(`Promise.all([import('/src/state/cloud-machines.ts'), import('/src/state/acp-state.ts')]).then(([machines, acp]) => { const key = acp.activeAcp(acp.acpStore.get())?.key; machines.machineNoticed([key], ${JSON.stringify(body)}); return key })`)
  const row = '[data-notice-row="cloud-machine"]'
  /** The notice's detail, opened as the person opens it, captured with its line. */
  const detail = async (name) => {
    await click(`${row} [aria-label="More about this"]`)
    await until(`document.querySelector('[data-slot="popover-content"]') !== null`, "the detail open")
    const said = await evaluate(`document.querySelector('[data-slot="popover-content"]').innerText`)
    await both(name, [row, '[data-slot="popover-content"]'])
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await until(`!document.querySelector('[data-slot="popover-content"]')`, "the detail closed")
    // Closed by its key, the detail gives focus back to its button: the next shots show the line as a person left it.
    await evaluate(`document.activeElement?.blur()`)
    return said
  }

  // A Thread moved to the cloud: its chip says Cloud.
  await window.loadURL(`${base}?mock&cloud=signed-in&invited&making=fast`)
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark', newThreadsInWorktree: true}))`)
  await until(`Boolean(document.querySelector('.composer-input')) && !document.querySelector('.composer-input').readOnly`, "the composer")
  await click(".composer-input")
  await type("Make the webhook retries back off exponentially")
  await enter()
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved to the cloud")
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 200 })

  const now = Date.now()
  // A machine lost and replaced says nothing: no line above the composer, and no word of machines anywhere.
  assert.equal(await evaluate(`document.querySelector('${row}') === null`), true, "nothing above the composer")

  // 1. A step cut by the loss, picked up again on the new machine: one quiet line in the transcript.
  const { continueTurnPrompt } = await import("../packages/host/dist/contracts/turn-continuation.js")
  await click(".composer-input")
  await type(continueTurnPrompt("machine-lost", "mako"))
  await enter()
  await until(`document.querySelector('[data-turn-continued="machine-lost"]') !== null`, "the continued turn")
  assert.match(await evaluate(`document.querySelector('[data-turn-continued="machine-lost"]').innerText`), /The last step was interrupted; Claude Code picked it up again/)
  const clipped = await evaluate(`(() => { const title = document.querySelector('[data-turn-continued="machine-lost"] [data-event-title]'); return title.scrollWidth > title.clientWidth })()`)
  assert.equal(clipped, false, "the line reads whole")
  await until(`document.body.innerText.split('Finished:').length > 2`, "the continued turn answered")
  assert.doesNotMatch(await evaluate(`document.querySelector('[data-turn-continued="machine-lost"]').innerText`), /machine/i, "no machine is named")
  await both("continued", ['[data-turn-continued="machine-lost"]'])

  // 2. Changes after the last save couldn't be kept: they were too large to save.
  const conversationId = await notice({ type: "machine", at: now, state: "changes-lost", savedAt: now - 120_000, reason: "too-large" })
  assert.ok(conversationId, "the Thread on screen")
  await until(`document.querySelector('[data-cloud-machine="changes-lost"]') !== null`, "changes lost")
  assert.match(await evaluate(`document.querySelector('${row}').innerText`), /Changes after .* weren't kept/)
  await both("changes-lost", [row, "[data-composer]"])
  const tooLarge = await detail("changes-lost-detail")
  assert.match(tooLarge, /too large to keep/)
  assert.doesNotMatch(tooLarge, /machine/i)
  await click(`${row} [aria-label="Got it"]`)
  await until(`!document.querySelector('${row}')`, "put away")

  // 3. A Thread whose work was never saved (its machine ran a Mako from before saves): what wasn't pushed.
  await notice({ type: "machine", at: now + 1_000, state: "changes-lost" })
  await until(`document.querySelector('[data-cloud-machine="changes-lost"]') !== null`, "unpushed changes lost")
  assert.match(await evaluate(`document.querySelector('${row}').innerText`), /Changes not yet pushed weren't kept/)
  const unpushed = await detail("unpushed-lost-detail")
  assert.doesNotMatch(unpushed, /machine/i)

  // 4. It couldn't start again: its work is safe, and a message tries again.
  await notice({ type: "machine", at: now + 2_000, state: "failed", savedAt: now - 60_000 })
  await until(`document.querySelector('[data-cloud-machine="failed"]') !== null`, "failed")
  await both("failed", [row, "[data-composer]"])
  const failed = await detail("failed-detail")
  assert.match(failed, /Send a message to try again/)
  assert.doesNotMatch(failed, /machine/i)

  clearTimeout(watchdog)
  app.exit(0)
}
