import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Scrolling a transcript while its answer streams, by trusted touch at an iPhone's size on the phone's live Session
 * (`src/dev/phone-scroll-check.tsx`) and by wheel in a laptop's window on the desktop's (`transcript-scroll-check.tsx`):
 *
 * - A finger that rests on the end, then drags up, takes the transcript up: the end's own follow, landing under the
 *   finger, doesn't end the reader's gesture. Resting there, it moves nothing.
 * - A flick up while the answer streams glides and stays where it stops; a short move up stays too.
 * - Where the reader stopped holds within a pixel while the answer goes on growing, and the way back to the newest
 *   turn shows; back at the end, it follows again. A finger resting at the end lets it wait, and lifting catches up.
 * - The keyboard opening leaves what's read where it was, and the end in view when it was followed.
 * - An earlier page arriving under a dragging finger moves the line under it no more than the finger does.
 * - A flick makes no long tasks.
 * - On a laptop, the wheel leaves the end of a streaming answer in a short transcript and a windowed one, and the
 *   windowed one's rows aren't scrolled under it.
 *
 * Screenshots go to the printed directory, or to the directory given as the first argument; `--port` serves the page
 * on that port (default: any free one).
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void checkScroll().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = await mkdtemp(join(tmpdir(), "mako-phone-scroll-ui-"))
  const evidence = args[0] ? resolve(args[0]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-phone-scroll-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_SCROLL_ROOT: root, MAKO_SCROLL_EVIDENCE: evidence, MAKO_SCROLL_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Phone scroll UI evidence: ${evidence}`)
}

/**
 * Records the transcript's own scroll writes that move it, every `scrollTo` call on it (one that moves nothing still
 * ends a smooth wheel scroll), and long tasks; read by `written`, `scrollCalls` and `longTasks`.
 */
const INSTRUMENT = `(() => {
  const writes = window.__scrollWrites = []
  const calls = window.__scrollCalls = []
  const tasks = window.__longTasks = []
  const scroller = (node) => node instanceof Element && node.hasAttribute('data-transcript-viewport')
  const top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  const record = (node, write) => {
    const before = top.get.call(node)
    write()
    const moved = top.get.call(node) - before
    if (Math.abs(moved) >= 1) writes.push({ at: performance.now(), moved })
  }
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() { return top.get.call(this) },
    set(value) { if (scroller(this)) record(this, () => top.set.call(this, value)); else top.set.call(this, value) },
  })
  for (const name of ['scrollTo', 'scrollBy', 'scroll']) {
    const original = Element.prototype[name]
    Element.prototype[name] = function (...args) {
      if (!scroller(this)) return original.apply(this, args)
      calls.push({ at: performance.now() })
      record(this, () => original.apply(this, args))
    }
  }
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push({ at: entry.startTime, ms: entry.duration }) }).observe({ type: 'longtask' })
  return true
})()`

async function checkScroll() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_SCROLL_ROOT
  const evidence = process.env.MAKO_SCROLL_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 240_000)
  const window = new BrowserWindow({ width: 393, height: 852, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const capture = async (name) => writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  const until = async (code, label = code) => {
    const deadline = Date.now() + 10_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await wait(30)
    }
  }
  const scroller = "document.querySelector('[data-transcript-viewport]')"
  const fromEnd = () => evaluate(`(() => { const node = ${scroller}; return node.scrollHeight - node.scrollTop - node.clientHeight })()`)
  /** The scroller still for 10 frames: a glide, a smooth scroll or a settling page is over. */
  const rest = () => evaluate(`new Promise(resolve => {
    const node = ${scroller}
    let last = node.scrollTop, still = 0
    const step = () => { if (Math.abs(node.scrollTop - last) < 0.5) still += 1; else still = 0; last = node.scrollTop; still >= 10 ? resolve(true) : requestAnimationFrame(step) }
    requestAnimationFrame(step)
  })`)
  /** The turn under the middle of the scroller, for `anchorMoved`. */
  const markAnchor = () => evaluate(`(() => {
    const node = ${scroller}
    const box = node.getBoundingClientRect()
    const turn = [...node.querySelectorAll('[data-exchange]')].find(turn => { const r = turn.getBoundingClientRect(); return r.top <= box.top + box.height / 2 && r.bottom > box.top + box.height / 2 })
    window.__anchor = { turn, top: turn.getBoundingClientRect().top }
    return turn.getAttribute('data-exchange')
  })()`)
  /** How far the marked turn moved on screen since `markAnchor`. */
  const anchorMoved = () => evaluate("window.__anchor.turn.isConnected ? window.__anchor.turn.getBoundingClientRect().top - window.__anchor.top : Infinity")
  /** The anchor's farthest drift over `ms`, sampled each frame. */
  const drift = (ms) => evaluate(`new Promise(resolve => {
    const until = performance.now() + ${ms}
    let worst = 0
    const step = () => {
      const moved = window.__anchor.turn.isConnected ? window.__anchor.turn.getBoundingClientRect().top - window.__anchor.top : Infinity
      if (Math.abs(moved) > Math.abs(worst)) worst = moved
      performance.now() < until ? requestAnimationFrame(step) : resolve(worst)
    }
    requestAnimationFrame(step)
  })`)
  const written = (since) => evaluate(`window.__scrollWrites.filter(write => write.at >= ${since}).length`)
  const longTasks = (since) => evaluate(`window.__longTasks.filter(task => task.at >= ${since}).map(task => Math.round(task.ms))`)
  const now = () => evaluate("performance.now()")
  const centre = { x: 196, y: 380 }
  const touch = (type, point) => send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [] })
  /** A finger dragged down the screen by `px` (the transcript toward earlier turns) in 16 ms steps of `step` px, still down. */
  const drag = async (from, px, step = 20) => {
    for (let moved = step; Math.abs(moved) <= Math.abs(px); moved += step) {
      await touch("touchMove", { x: from.x, y: from.y + moved })
      await wait(16)
    }
  }
  /** A finger's flick: `px` down the screen at `speed` px/s, the glide left to run. */
  const flick = (px, speed) => send("Input.synthesizeScrollGesture", { x: centre.x, y: centre.y, yDistance: px, speed, gestureSourceType: "touch", preventFling: false })
  const phone = async (theme) => {
    await window.loadURL(`${new URL("scripts/phone-scroll.html", process.env.MAKO_SCROLL_URL).href}?theme=${theme}`)
    await until(`document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length >= 10`, "the phone's transcript")
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(INSTRUMENT)
    await rest()
  }
  /** At the end and following it, as the way back leaves the reader. */
  const toEnd = async () => {
    await evaluate("document.querySelector('.web-jump[data-shown]')?.click(), true")
    await rest()
    await until(`${scroller}.scrollHeight - ${scroller}.scrollTop - ${scroller}.clientHeight < 2`, "the end")
  }
  const jumpShown = () => evaluate("Boolean(document.querySelector('.web-jump[data-shown]'))")
  /** The reader's place holds within a pixel for `ms` while the answer streams, away from the end, the way back shown. */
  const holds = async (label, ms = 3_000) => {
    const start = await fromEnd()
    await markAnchor()
    const worst = await drift(ms)
    const end = await fromEnd()
    assert.ok(Math.abs(worst) <= 1, `${label}: the reader's place moved ${Math.round(worst)} px while the answer streamed`)
    assert.ok(end > start + 50, `${label}: the answer grew below the reader (${Math.round(start)} → ${Math.round(end)} px from the end)`)
    assert.ok(await jumpShown(), `${label}: the way back to the newest turn shows`)
    return { worst, start, end }
  }

  // A page first: emulating a window that has drawn nothing yet crashes Electron.
  await window.loadURL("about:blank")
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 3, mobile: true })
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  try {
    await phone("dark")
    assert.equal(await fromEnd() < 2, true, "the phone opens at the end")
    await evaluate("window.scrollCheck.stream(50, 3), true")
    await wait(500)

    // 1. A finger resting at the end: the end waits for it, then catches up when it lifts.
    // Short of a long press, which offers the reply's actions.
    await touch("touchStart", centre)
    let since = await now()
    await wait(350)
    assert.equal(await written(since), 0, `nothing moves the transcript under a resting finger: ${await evaluate(`JSON.stringify(window.__scrollWrites.filter(write => write.at >= ${since}))`)}`)
    const waited = await fromEnd()
    assert.ok(waited > 10, `the answer grew past the resting finger (${Math.round(waited)} px)`)
    await touch("touchEnd")
    await wait(100)
    assert.ok(await fromEnd() < 2, "lifting at the end catches up with it")
    console.log(`Resting at the end: no writes for 350 ms, ${Math.round(waited)} px caught up on lifting`)

    // 2. Resting, then dragging up: the end's follow, written as the finger lands, leaves the gesture the reader's.
    await wait(300)
    await touch("touchStart", centre)
    since = await now()
    await wait(300)
    await drag(centre, 300)
    await wait(150)
    const dragged = await fromEnd()
    await touch("touchEnd")
    assert.ok(dragged > 250, `a 300 px drag up took the transcript ${Math.round(dragged)} px from the end`)
    assert.equal(await written(since), 0, "nothing moved the transcript under the finger")
    await rest()
    let held = await holds("after a drag up")
    await capture("reading-while-streaming-iphone-dark.png")
    console.log(`Drag up from rest: ${Math.round(dragged)} px from the end, held within ${Math.abs(held.worst).toFixed(1)} px for 3 s`)

    // The keyboard opening and closing, as the visual viewport shrinks and grows: what's read stays, the end stays in view.
    const keyboard = async (open) => {
      await send("Emulation.setDeviceMetricsOverride", { width: 393, height: open ? 520 : 852, deviceScaleFactor: 3, mobile: true })
      await rest()
    }
    await markAnchor()
    await keyboard(true)
    const readKeyboard = await anchorMoved()
    await keyboard(false)
    assert.ok(Math.abs(readKeyboard) <= 1, `the keyboard opening moved what's read ${Math.round(readKeyboard)} px`)
    await toEnd()
    await keyboard(true)
    const endKeyboard = await fromEnd()
    await wait(500)
    const endTyping = await fromEnd()
    await keyboard(false)
    assert.ok(endKeyboard < 2 && endTyping < 2, `the keyboard opening at the end left it ${Math.round(endKeyboard)} px, then ${Math.round(endTyping)} px away`)
    console.log(`Keyboard: what's read moved ${Math.abs(readKeyboard).toFixed(1)} px; at the end, it stayed in view`)

    // 3. A flick up glides and stays; it makes no long tasks.
    await toEnd()
    since = await now()
    await flick(400, 2_500)
    await rest()
    const flung = await fromEnd()
    assert.ok(flung > 600, `a flick of 400 px glided ${Math.round(flung)} px from the end`)
    const tasks = await longTasks(since)
    assert.deepEqual(tasks, [], `a flick while streaming made long tasks: ${tasks.join(", ")} ms`)
    held = await holds("after a flick")
    console.log(`Flick up: glided to ${Math.round(flung)} px from the end, no long tasks, held within ${Math.abs(held.worst).toFixed(1)} px`)

    // 4. Back at the end, it follows again.
    await flick(-6_000, 4_000)
    await rest()
    assert.ok(await fromEnd() < 2, "a flick down to the end reaches it")
    await wait(1_000)
    assert.ok(await fromEnd() < 2, "back at the end, the transcript follows the answer again")
    assert.equal(await jumpShown(), false, "and the way back is gone")
    console.log("Back at the end: following again")

    // 5. A short move up, short of where the way back shows, stays where it was left.
    // Slow, and still before lifting: no glide carries it past the 96 px it used to be taken back from. The answer
    // pauses for the move, so it alone sets how far from the end the reader stops.
    await toEnd()
    await evaluate("window.scrollCheck.stop(), true")
    await touch("touchStart", centre)
    await drag(centre, 60, 4)
    await wait(200)
    await touch("touchEnd")
    await rest()
    const short = await fromEnd()
    assert.ok(short > 30 && short < 96, `a 60 px move up took the transcript ${Math.round(short)} px from the end`)
    await markAnchor()
    await evaluate("window.scrollCheck.stream(50, 3), true")
    const shortDrift = await drift(2_000)
    assert.ok(Math.abs(shortDrift) <= 1, `a short move up was taken back: the reader's place moved ${Math.round(shortDrift)} px`)
    assert.ok(await jumpShown(), "the answer grew away from the reader, and the way back shows")
    console.log(`Short move up: ${Math.round(short)} px from the end, held within ${Math.abs(shortDrift).toFixed(1)} px`)
    await evaluate("window.scrollCheck.stop(), true")

    // Light, read while streaming.
    await phone("light")
    await evaluate("window.scrollCheck.stream(50, 3), true")
    await flick(400, 2_500)
    await rest()
    await wait(1_500)
    await capture("reading-while-streaming-iphone-light.png")
    await evaluate("window.scrollCheck.stop(), true")

    // 6. An earlier page arriving under a resting finger: the line under it stays.
    await window.loadURL(`${new URL("scripts/transcript-scroll-browser.html", process.env.MAKO_SCROLL_URL).href}?turns=90&paged=12`)
    await until(`document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length >= 10`, "the paged transcript")
    await rest()
    // Drags up until a page lands during one (the source answers 300 ms after it's asked, and its turns are placed as
    // the reader scrolls). Past the touch slop the transcript follows the finger 1:1, so whatever the line under it
    // moved beyond the finger's own travel, the page moved; it lifts as a cancel, so no glide.
    const height = () => evaluate(`${scroller}.scrollHeight`)
    const first = await height()
    let paged
    for (let pull = 0; pull < 60 && paged === undefined; pull += 1) {
      await touch("touchStart", centre)
      await touch("touchMove", { x: centre.x, y: centre.y + 20 })
      await wait(32)
      const was = await height()
      await markAnchor()
      for (let step = 1; step <= 14; step += 1) {
        await touch("touchMove", { x: centre.x, y: centre.y + 20 + step * 10 })
        await wait(16)
      }
      await wait(50)
      if ((await height()) > was) paged = (await anchorMoved()) - 140
      await touch("touchCancel")
      await rest()
    }
    assert.notEqual(paged, undefined, "an earlier page arrived under the finger")
    assert.ok(Math.abs(paged) <= 1, `an earlier page moved the line under the finger ${Math.round(paged)} px`)
    console.log(`Paging under a finger: the transcript grew ${first} → ${await height()} px above it, the line under it moved ${Math.abs(paged).toFixed(1)} px beyond the finger`)

    // 7. A laptop's wheel leaves the end of a streaming answer, in a short transcript and a windowed one.
    await send("Emulation.setTouchEmulationEnabled", { enabled: false })
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
    for (const turns of [90, 250]) {
      await window.loadURL(`${new URL("scripts/transcript-scroll-browser.html", process.env.MAKO_SCROLL_URL).href}?turns=${turns}`)
      // A windowed transcript mounts only the rows around what's shown.
      await until(`document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length >= 2`, "the laptop's transcript")
      await evaluate(INSTRUMENT)
      await rest()
      await evaluate("window.probe.startTurn(), window.__streaming = setInterval(() => window.probe.appendToTurn('The answer keeps arriving, a few words a frame. '), 50), true")
      await wait(800)
      const windowed = await evaluate(`${scroller}.hasAttribute('data-virtualized')`)
      assert.equal(windowed, turns > 200, `${turns} turns ${windowed ? "are" : "aren't"} windowed`)
      const start = await fromEnd()
      since = await now()
      for (let notch = 0; notch < 30; notch += 1) {
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 550, y: 450, deltaX: 0, deltaY: -40 })
        await wait(16)
      }
      await rest()
      const wheeled = await fromEnd()
      assert.ok(wheeled > start + 900, `30 notches of 40 px up took the transcript ${Math.round(wheeled - start)} px from the end`)
      await markAnchor()
      const worst = await drift(2_000)
      assert.ok(Math.abs(worst) <= 1, `the reader's place moved ${Math.round(worst)} px while the answer streamed`)
      const calls = await evaluate(`window.__scrollCalls.filter(call => call.at >= ${since}).length`)
      assert.equal(calls, 0, `the rows were scrolled ${calls} times under the wheel`)
      await evaluate("clearInterval(window.__streaming), window.probe.finishTurn(), true")
      console.log(`Laptop wheel, ${turns} turns${windowed ? ", windowed" : ""}: ${Math.round(wheeled - start)} px up, held within ${Math.abs(worst).toFixed(1)} px`)
    }
  } finally {
    clearTimeout(watchdog)
  }
}
