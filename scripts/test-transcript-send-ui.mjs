import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A long Apex Thread (`?mock&app=apex&turns=260`, windowed rows, the crew card and the Fins' reports below them) on
 * the desk, the web app and the phone, with the Apex between turns (`idle=1`: a message starts one) and in one (it
 * steers or waits). It opens at its end with no blank room below its last line. Then a message is sent: from the
 * keypress until the answer has landed, no two rows of the transcript overlap in any frame, nor the last row and what
 * follows it. Each frame reads every painted turn's box; a failure names the frame, the two rows and by how much, and
 * leaves a screenshot.
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
  const root = testScratch("mako-transcript-send-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-transcript-send", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
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
      // Where the sent words are painted (in a turn, its answer there, or waiting in the queue), and when the turns'
      // geometry last moved: the send is over once its words are where they go and nothing has moved for a while.
      const sent = window.__sent
      if (sent) {
        const turn = turns.find((each) => each.textContent.includes(sent.words))
        if (turn) {
          sent.inTurn += 1
          // The person's own words carry no answer's mark.
          if (turn.querySelector('[data-answer]')) sent.answered += 1
        } else if (document.body.innerText.includes(sent.words)) sent.queued += 1
        const shape = boxes.map(({ id, box }) => id + ':' + Math.round(box.top) + ':' + Math.round(box.height)).join('|')
        if (shape !== sent.shape) { sent.shape = shape; sent.still = 0 } else sent.still += 1
      }
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
      results.push(await sendOn(BrowserWindow, base, shots, { ...surface, idle, path: `${surface.path}${idle ? "&idle=1" : ""}`, surface: `${surface.surface}${idle ? "" : " mid-turn"}` }))
  console.log(`SEND ${JSON.stringify(results)}`)
  const failed = results.filter((result) => result.overlaps.length)
  assert.deepEqual(results.filter((result) => result.room > 1).map((result) => ({ surface: result.surface, room: result.room })), [], "a long Thread opens at its end with no blank room below its last line")
  // Each send was watched through: frames painted the sent words in a turn, or in the queue mid-turn.
  assert.deepEqual(results.filter((result) => result.sent.inTurn === 0 && result.sent.queued === 0).map((result) => result.surface), [], "every send's words were painted where they go")
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

const WORDS = "Which of the queued ones goes next?"

async function sendOn(BrowserWindow, base, shots, { surface, path, width, height, mobile = false, composer, open, idle }) {
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
    const deadline = Date.now() + (process.env.MAKO_SEND_DEADLINE ? Number(process.env.MAKO_SEND_DEADLINE) : 120_000)
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await writeFile(join(shots, `${surface}-timeout.png`), (await page.capturePage()).toPNG())
        const sent = await evaluate("window.__sent && (({ inTurn, answered, queued, still }) => ({ inTurn, answered, queued, still }))(window.__sent)").catch(() => undefined)
        throw new Error(`${surface}: timed out waiting for ${what}${sent ? ` (sent ${JSON.stringify(sent)})` : ""}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      }
      await wait(40)
    }
  }
  // The viewport each surface is drawn at, whatever the screen: a runner's 1024 px screen clamps the window, and a
  // desk that narrow gives its pane to the workbench. A page first: emulating a window that has drawn nothing crashes.
  await window.loadURL("about:blank")
  await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 2, mobile })
  if (mobile) await page.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  // A cold dev server reloads the page once its dependencies are bundled, aborting this load; the waits below hold.
  await window.loadURL(new URL(path, base).href).catch((error) => {
    if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
  })
  if (open) await until(open, `the Apex on the ${surface}`)
  await until("Boolean(document.querySelector('[data-transcript-viewport][data-virtualized] [data-exchange]'))", "the long Apex's windowed transcript")
  await evaluate("document.fonts.ready.then(() => true)")
  await until(`Boolean(${composer})`, "the composer")
  // Opened at its end, once the scroller has held still for 10 frames: the column's last line meets the scroller's
  // content edge, with no room left below it (the phone's steady end keeps room only for a column that got shorter).
  const room = await evaluate(`new Promise((done) => {
    const node = document.querySelector('[data-transcript-viewport]')
    let last = -1, still = 0
    const look = () => {
      const at = node.scrollTop + node.scrollHeight
      still = Math.abs(at - last) < 0.5 ? still + 1 : 0
      last = at
      if (still < 10) return requestAnimationFrame(look)
      node.scrollTop = node.scrollHeight
      // From the scroller's content edge: the phone's padding below it is room the capsule keeps.
      requestAnimationFrame(() => done(Math.round(node.getBoundingClientRect().bottom - parseFloat(getComputedStyle(node).paddingBottom) - node.firstElementChild.getBoundingClientRect().bottom)))
    }
    requestAnimationFrame(look)
  })`)
  await writeFile(join(shots, `${surface}-opened.png`), (await page.capturePage()).toPNG())
  await wait(600)
  await evaluate(WATCH)
  await wait(300)
  const before = await evaluate("window.__overlaps.length")
  const turns = await evaluate("document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length")
  await evaluate(`${composer}.focus(), true`)
  await evaluate("window.__sent = { words: 'Which of the queued ones goes next?', inTurn: 0, answered: 0, queued: 0, still: 0, shape: '' }, true")
  await page.debugger.sendCommand("Input.insertText", { text: WORDS })
  // The phone's return key writes a new line; its send control sends, or steers mid-turn.
  if (!(await evaluate("(() => { const send = document.querySelector('[data-send-action=send],[data-send-action=steer]'); send?.click(); return Boolean(send) })()")))
    for (const type of ["keyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  // Between turns the message starts one and its answer lands below it; mid-turn the running turn takes it as a steer,
  // or it waits in the queue above the composer. Either way the send is over when the painted turns hold still.
  await until(`(() => { const sent = window.__sent; return (${idle ? "sent.answered > 0" : "sent.inTurn > 0 || sent.queued > 0"}) && sent.still >= 30 })()`, "the sent message where it goes, and the transcript still")
  await writeFile(join(shots, `${surface}-sent.png`), (await page.capturePage()).toPNG())
  const overlaps = (await evaluate("window.__overlaps")).slice(before)
  const frames = await evaluate("window.__frames")
  const sent = await evaluate("(({ inTurn, answered, queued }) => ({ inTurn, answered, queued }))(window.__sent)")
  window.destroy()
  return { surface, turns, frames, room, sent, overlaps }
}
