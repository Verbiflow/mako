import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Sending a message at the end of a long Apex Thread (`?mock&app=apex&turns=260`, windowed rows, the crew card and
 * the Fins' reports below them) on the desk, the web app and the phone, with the Apex between turns (`idle=1`: the
 * message starts one) and in one (it steers or waits): from the keypress until the answer has landed, no two rows of the transcript overlap in any frame, nor the last row and what follows it. Each frame reads
 * every painted turn's box; a failure names the frame, the two rows and by how much, and leaves a screenshot.
 *
 * Pass a dev server's URL to use it; with none it serves its own. Screenshots go to the printed directory, or to
 * `MAKO_SEND_SHOTS`.
 */
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-transcript-send-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-transcript-send", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { createServer } = await import("vite")
    server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_SEND_ROOT: root, MAKO_SEND_URL: given ?? server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
  console.log(`Transcript send evidence: ${root}`)
}

/**
 * Installed in the page: each frame, every painted turn's box in document order, and the first thing after the
 * transcript's rows (the footer: activity, crew card). Two neighbours overlapping by more than a pixel is a fault.
 */
const WATCH = `(() => {
  const faults = window.__overlaps = []
  let frames = 0
  const scroller = () => document.querySelector('[data-transcript-viewport]')
  const look = () => {
    const node = scroller()
    if (node) {
      frames += 1
      const view = node.getBoundingClientRect()
      const turns = [...node.querySelectorAll('[data-exchange]')].filter((turn) => !turn.parentElement.closest('[data-exchange]'))
      const boxes = turns.map((turn) => ({ id: turn.getAttribute('data-exchange'), box: turn.getBoundingClientRect() }))
        .filter(({ box }) => box.height > 0 && box.bottom > view.top && box.top < view.bottom)
      const list = node.querySelector('[data-virtual-transcript]')
      const after = list?.nextElementSibling
      if (after && boxes.length) {
        const box = after.getBoundingClientRect()
        if (box.height > 0 && box.top < view.bottom) boxes.push({ id: 'after the rows', box })
      }
      boxes.sort((left, right) => left.box.top - right.box.top)
      for (let index = 1; index < boxes.length; index += 1) {
        const above = boxes[index - 1], below = boxes[index]
        const by = above.box.bottom - below.box.top
        if (by > 1) faults.push({ frame: frames, above: above.id, below: below.id, by: Math.round(by) })
      }
    }
    window.__frames = frames
  }
  // Read where a frame paints it: after its animation frames and the page's resize observers (created before this
  // one, so called before it), which is where a virtualizer places what it measured.
  const kick = document.createElement('div')
  kick.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px;pointer-events:none;opacity:0'
  document.body.append(kick)
  new ResizeObserver(look).observe(kick)
  const tick = () => {
    kick.style.width = kick.style.width === '1px' ? '2px' : '1px'
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})()`

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_SEND_ROOT
  const shots = process.env.MAKO_SEND_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  // Each surface has a window of its own; between them none is open, which isn't the end.
  app.on("window-all-closed", () => undefined)
  await app.whenReady()
  const base = process.env.MAKO_SEND_URL
  const results = []
  for (const surface of SURFACES)
    for (const idle of [true, false])
      results.push(await sendOn(BrowserWindow, base, shots, { ...surface, path: `${surface.path}${idle ? "&idle=1" : ""}`, surface: `${surface.surface}${idle ? "" : " mid-turn"}` }))
  console.log(`SEND ${JSON.stringify(results)}`)
  const failed = results.filter((result) => result.overlaps.length)
  assert.deepEqual(failed.map((result) => ({ surface: result.surface, first: result.overlaps.slice(0, 3) })), [], "no two rows of the transcript overlap in any frame of a send")
  app.exit(0)
}

const SURFACES = [
  {
    surface: "desk", path: "?mock&app=apex&turns=260", width: 1440, height: 900, composer: "document.querySelector('.composer-input')",
    open: "(() => { const row = [...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')); row?.click(); return Boolean(row) })()",
  },
  { surface: "web", path: "scripts/web-desk.html?app=apex&thread=apex&turns=260", width: 1280, height: 800, composer: "document.querySelector('textarea')" },
  {
    surface: "phone", path: "scripts/phone-apex.html?app=apex&turns=260", width: 390, height: 844, mobile: true, composer: "document.querySelector('.web-dock textarea')",
    open: "(() => { const row = document.querySelector('[data-thread]'); row?.click(); return Boolean(row) })()",
  },
]

async function sendOn(BrowserWindow, base, shots, { surface, path, width, height, mobile = false, composer, open }) {
  const window = new BrowserWindow({ width, height, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, what = code) => {
    // Generous: a cold dev server bundles its dependencies and reloads the page first. Nothing here is timed.
    const deadline = Date.now() + 120_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await writeFile(join(shots, `${surface}-timeout.png`), (await page.capturePage()).toPNG())
        throw new Error(`${surface}: timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      }
      await wait(40)
    }
  }
  if (mobile) {
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 3, mobile: true })
    await page.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  }
  // A cold dev server reloads the page once its dependencies are bundled, aborting this load; the waits below hold.
  await window.loadURL(new URL(path, base).href).catch((error) => {
    if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
  })
  if (open) await until(open, `the Apex on the ${surface}`)
  await until("Boolean(document.querySelector('[data-transcript-viewport][data-virtualized] [data-exchange]'))", "the long Apex's windowed transcript")
  await evaluate("document.fonts.ready.then(() => true)")
  await until(`Boolean(${composer})`, "the composer")
  await wait(600)
  await evaluate(WATCH)
  await wait(300)
  const before = await evaluate("window.__overlaps.length")
  const turns = await evaluate("document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length")
  await evaluate(`${composer}.focus(), true`)
  await page.debugger.sendCommand("Input.insertText", { text: "Which of the queued ones goes next?" })
  // The phone's return key writes a new line; its send control sends, or steers mid-turn.
  if (!(await evaluate("(() => { const send = document.querySelector('[data-send-action=send],[data-send-action=steer]'); send?.click(); return Boolean(send) })()")))
    for (const type of ["keyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  // Mid-turn, a message the turn can't take yet waits in its queue above the composer.
  await until("document.body.innerText.includes('Which of the queued ones goes next?')", "the sent message")
  await wait(2_500)
  await writeFile(join(shots, `${surface}-sent.png`), (await page.capturePage()).toPNG())
  const overlaps = (await evaluate("window.__overlaps")).slice(before)
  const frames = await evaluate("window.__frames")
  window.destroy()
  return { surface, turns, frames, overlaps }
}
