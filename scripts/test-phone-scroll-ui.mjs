import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

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
 * - Turned sideways at the end and back, the newest turn stays where the end shows it.
 * - An earlier page arriving under a resting finger leaves the line under it where it is.
 * - A flick makes no long tasks: no task with 50 ms of the page's own work (its main thread's CPU time, from a trace),
 *   and none that holds the thread 150 ms.
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
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = testScratch("mako-phone-scroll-ui-")
  const evidence = args[0] ? resolve(args[0]) : process.env.MAKO_TEST_EVIDENCE ? resolve(process.env.MAKO_TEST_EVIDENCE, "phone-scroll-ui") : root
  await mkdir(evidence, { recursive: true })
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
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
}

/**
 * Records the transcript's own scroll writes that move it, every `scrollTo` call on it (one that moves nothing still
 * ends a smooth wheel scroll), and long tasks; read by `written`, `scrollCalls` and `longTasks`.
 */
/** Opt-in metadata only. Native tracing and diagnostic screenshots are deliberately not requested. */
const FLICK_DIAGNOSTIC = `(() => {
  const limit = 64, observers = [], started = Date.now()
  const seen = window.__flickDiagnosticResult = { status: 'starting', start: performance.now(), timeOrigin: performance.timeOrigin,
    tasks: [], frames: [], droppedTasks: 0, droppedFrames: 0, outputDroppedTasks: 0, outputDroppedFrames: 0,
    errors: [], droppedErrors: 0, collection: {}, cleanup: 'not-requested', captureMs: 15000, outputBytes: 16384 }
  let closed = false, expiry
  const text = value => { try { return String(value ?? '').slice(0, 512) } catch { return '[unprintable]' } }
  const error = (stage, value) => { if (seen.errors.length < 8) seen.errors.push({ stage, message: text(value) }); else seen.droppedErrors += 1 }
  const items = (values, pick) => {
    const result = []
    for (let index = 0; index < Math.min(values.length, 8); index += 1) result.push(pick(values[index]))
    return result
  }
  const consume = (records, owner) => {
    const room = Math.max(0, limit - owner.output.length), count = Math.min(records.length, room)
    seen[owner.dropped] += records.length - count
    for (let index = 0; index < count; index += 1) {
      try { owner.output.push(owner.pick(records[index])) } catch (value) { error('entry', value); seen[owner.dropped] += 1 }
    }
  }
  const finish = window.__finishFlickDiagnostic = (reason = 'requested') => {
    if (closed) return seen.cleanup === 'completed'
    closed = true
    if (expiry !== undefined) clearTimeout(expiry)
    seen.finishReason = reason
    let clean = true
    for (const owner of observers) {
      try { consume(owner.observer.takeRecords(), owner) } catch (value) { error('tail', value) }
      finally { try { owner.observer.disconnect() } catch (value) { clean = false; error('disconnect', value) } }
    }
    seen.cleanup = clean ? 'completed' : 'unknown-process-exit-required'
    seen.end = performance.now()
    seen.status = reason === 'expired' ? 'capture-expired' : seen.status
    return clean
  }
  window.__readFlickDiagnostic = () => {
    let output = JSON.stringify(seen)
    // Three bytes per UTF-16 code unit is a conservative UTF-8 bound. Trim in halves, not an unbounded walk.
    for (let pass = 0; output.length * 3 > seen.outputBytes && pass < 14; pass += 1) {
      const key = seen.frames.length ? 'frames' : 'tasks', dropped = key === 'frames' ? 'outputDroppedFrames' : 'outputDroppedTasks'
      const keep = Math.floor(seen[key].length / 2)
      seen[dropped] += seen[key].length - keep
      seen[key].length = keep
      output = JSON.stringify(seen)
    }
    if (output.length * 3 > seen.outputBytes) return JSON.stringify({ status: 'output-budget-exceeded', cleanup: seen.cleanup })
    return output
  }
  if (started > (window.__flickDiagnosticRequestDeadline ?? Infinity)) { seen.status = 'expired-before-setup'; finish('expired-before-setup'); return false }
  const observe = (type, output, pick, dropped) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) { seen.collection[type] = 'unsupported'; return }
    try {
      const owner = { output, pick, dropped }
      owner.observer = new PerformanceObserver(list => {
        if (closed) return
        if (Date.now() - started >= seen.captureMs) { finish('expired'); return }
        try { consume(list.getEntries(), owner) } catch (value) { error('callback', value) }
      })
      observers.push(owner)
      owner.observer.observe({ type })
      seen.collection[type] = 'active'
    } catch (value) { seen.collection[type] = 'failed'; error('observe ' + type, value) }
  }
  try {
    observe('longtask', seen.tasks, entry => ({ at: entry.startTime, ms: entry.duration, name: text(entry.name),
      attribution: items(entry.attribution, each => ({ name: text(each.name), containerType: text(each.containerType), containerSrc: text(each.containerSrc) })) }), 'droppedTasks')
    observe('long-animation-frame', seen.frames, entry => ({ at: entry.startTime, ms: entry.duration, blockingDuration: entry.blockingDuration,
      renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
      scripts: items(entry.scripts, each => ({ duration: each.duration, executionStart: each.executionStart,
        forcedStyleAndLayoutDuration: each.forcedStyleAndLayoutDuration, sourceURL: text(each.sourceURL),
        sourceFunctionName: text(each.sourceFunctionName), invoker: text(each.invoker), invokerType: text(each.invokerType) })) }), 'droppedFrames')
    if (seen.collection.longtask !== 'active' || Object.values(seen.collection).includes('failed')) {
      seen.status = 'setup-unavailable'; finish('setup-failed'); return false
    }
    seen.status = 'active'
    if (typeof setTimeout === 'function') expiry = setTimeout(() => finish('expired'), seen.captureMs)
    return true
  } catch (value) { error('setup', value); seen.status = 'setup-unavailable'; finish('setup-failed'); return false }
})()`

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
  /**
   * The page's own work while `run` runs: each task on the page's main thread with the CPU time its thread spent in it,
   * from a Chrome trace. A long task's duration is wall time, and on a busy runner the system takes the CPU from the
   * page mid-task: traced on the macOS runner, a flick's task of 67 ms held 11 ms of the page's work, and its gaps were
   * plain script and garbage collection, no call waiting on another process.
   */
  const pageWork = async (run) => {
    const events = []
    let done
    const finished = new Promise((resolve) => { done = resolve })
    const listen = (_event, method, params) => {
      if (method === "Tracing.dataCollected") events.push(...params.value)
      if (method === "Tracing.tracingComplete") done()
    }
    page.debugger.on("message", listen)
    try {
      await send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["toplevel"], enableSampling: false } })
      await run()
      await send("Tracing.end")
      await finished
    } finally {
      page.debugger.removeListener("message", listen)
    }
    const main = new Set(events.filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain").map((event) => `${event.pid}:${event.tid}`))
    const tasks = events.filter((event) => event.ph === "X" && event.name.endsWith("RunTask") && main.has(`${event.pid}:${event.tid}`))
    assert.ok(main.size === 1 && tasks.length > 0, `the trace found the page's main thread (${main.size}) and its tasks (${tasks.length})`)
    // Chrome leaves out the thread's time of a task too short to have any; one without it counts by its wall time.
    return tasks.map((task) => ({ wall: task.dur / 1000, cpu: (task.tdur ?? task.dur) / 1000 }))
  }
  const now = () => evaluate("performance.now()")
  const centre = { x: 196, y: 380 }
  /**
   * Every touch is stamped with when the finger was there. Chromium reads a finger's speed from the stamps, not from
   * when a busy machine delivered the events: a flick sent by `Input.synthesizeScrollGesture`, paced by the clock,
   * barely glided one time in six on the macOS runner (its last moves arrived bunched, read as a stop). A touch on its
   * own is stamped now; a stroke's moves are stamped from its start, 16 ms apart, and its lift 1 ms after its last move
   * however late they arrive: a lift stamped when it arrived read as a finger that had stopped, and nothing glided.
   * A stroke sent faster than its stamps leaves them ahead of the clock, so a touch on its own first waits for the clock
   * to pass them: stamped 1 ms after them instead, twelve strokes' stamps ran a second and a half ahead, and the flick
   * down to the end moved 120 px of 1,100.
   */
  let stamp = 0
  const touch = async (type, point, at) => {
    if (at === undefined) {
      const ahead = stamp * 1000 + 1 - Date.now()
      if (ahead > 0) await wait(ahead)
      at = Date.now() / 1000
    }
    stamp = at
    return send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [], timestamp: at })
  }
  /** A finger dragged down the screen by `px` (the transcript toward earlier turns) in 16 ms steps of `step` px, still down. */
  const drag = async (from, px, step = 20) => {
    for (let moved = step; Math.abs(moved) <= Math.abs(px); moved += step) {
      await touch("touchMove", { x: from.x, y: from.y + moved })
      await wait(16)
    }
  }
  /**
   * A finger's flick: `px` down the screen at `speed` px/s, lifted while moving so the glide runs. Each stroke is at most
   * 500 px, so the finger stays on the screen.
   */
  const flick = async (px, speed) => {
    for (let left = px; Math.abs(left) >= 1; ) {
      const part = Math.sign(left) * Math.min(Math.abs(left), 500)
      left -= part
      const from = { x: centre.x, y: Math.min(Math.max(centre.y, 40 - Math.min(part, 0)), 812 - Math.max(part, 0)) }
      const steps = Math.max(2, Math.round(Math.abs(part) / speed / 0.016))
      await touch("touchStart", from)
      const start = stamp
      for (let step = 1; step <= steps; step += 1) await touch("touchMove", { x: from.x, y: from.y + (part * step) / steps }, start + step * 0.016)
      await touch("touchEnd", undefined, start + steps * 0.016 + 0.001)
    }
  }
  const phone = async (theme) => {
    await window.loadURL(`${new URL("scripts/phone-scroll.html", process.env.MAKO_SCROLL_URL).href}?theme=${theme}`)
    await until(`document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length >= 2`, "the phone's transcript")
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
    // The rest is short of the reply's long press (500 ms, replies.ts) by the test's clock, but the page times it by
    // its own: on a slow runner the lift reached the page past it, the reply's actions opened in a sheet, as a long
    // press should, and the next case's finger landed on the sheet's backdrop, not the transcript (its drag "took the
    // transcript 0 px"). Closed as a reader would close it, so the next case starts on the transcript.
    if (await evaluate("Boolean(document.querySelector('.web-sheet-backdrop'))")) {
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
      await until("!document.querySelector('.web-sheet-backdrop')", "the reply's actions closed")
      console.log("Resting at the end: the page heard a long press and opened the reply's actions; closed")
    }

    // 2. Resting, then dragging up: the end's follow, written as the finger lands, leaves the gesture the reader's.
    await wait(300)
    await evaluate("addEventListener('pointerdown', () => { window.__landed = performance.now() }, { once: true, capture: true }), true")
    await touch("touchStart", centre)
    since = await now()
    // A rest of 100 ms by the page's own clock, from when it heard the finger land, not 300 ms by the test's: the
    // reply's long press (500 ms, replies.ts) is the page's to time, and on a slow runner a rest timed here reached it.
    await evaluate("new Promise((resolve) => setTimeout(() => resolve(true), Math.max(0, 100 - (performance.now() - (window.__landed ?? performance.now())))))")
    await drag(centre, 300)
    // Where the drag settled, the finger still down, rather than a fixed 150 ms after its last move: on a busy runner
    // that read once found it 0 px from the end.
    await rest()
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
    const diagnostic = process.env.MAKO_FLICK_DIAGNOSTICS === "1"
    const packet = { mode: "instrumented diagnostic; not normative performance acceptance", status: "requested", attempts: [],
      oracle: { status: "not-run" }, tracing: "removed-not-requested", screenshot: "removed-not-requested",
      budgets: { operationMs: 1000, captureMs: 15000, rendererBytes: 16384, fileBytes: 65536, files: 1, traceBytes: 0, screenshots: 0, statusBytes: 4096 },
      limits: "IPC and write promises cannot be forcibly cancelled. Unknown completion aborts this owned process before another test scope. Late writes use a unique capture filename; no retry or late follow-up is issued." }
    const captureName = `flick-diagnostic-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    const text = value => { try { return String(value).slice(0, 512) } catch { return "[unprintable]" } }
    const emit = () => {
      try {
        const line = `FLICK_DIAGNOSTIC_STATUS ${JSON.stringify({ status: packet.status, oracle: packet.oracle.status,
          attempts: packet.attempts.map(({ name, status, lateSettlement, completion }) => ({ name, status, lateSettlement, completion })),
          file: captureName, disposition: packet.disposition })}`
        console.log(Buffer.byteLength(line, "utf8") <= packet.budgets.statusBytes ? line : 'FLICK_DIAGNOSTIC_STATUS {"status":"status-output-over-budget"}')
      } catch { /* Keep the original failure primary. */ }
    }
    const attempt = async (name, operation) => {
      const record = { name, status: "requested" }
      packet.attempts.push(record)
      let timer
      const work = Promise.resolve().then(operation).then(value => {
        if (record.status !== "requested") { record.lateSettlement = "completed-after-timeout"; return }
        record.status = "completed"
        return { status: record.status, value }
      }, error => {
        if (record.status !== "requested") { record.lateSettlement = "failed-after-timeout"; return }
        record.status = "failed"; record.error = text(error)
        return { status: record.status }
      })
      const timeout = new Promise(resolve => { timer = setTimeout(() => {
        record.status = "timed-out"; record.completion = "unknown; process exit required"
        resolve({ status: record.status })
      }, packet.budgets.operationMs) })
      const result = await Promise.race([work, timeout])
      clearTimeout(timer)
      return result
    }
    let primary, hasPrimary = false, unavailable = false, setup
    if (diagnostic) {
      emit()
      setup = await attempt("setup", () => evaluate(`window.__flickDiagnosticRequestDeadline=${Date.now() + packet.budgets.operationMs};${FLICK_DIAGNOSTIC}`))
      unavailable = setup.status !== "completed" || setup.value !== true
    }
    if (!unavailable) try {
      since = await now()
      // A long task is one with 50 ms of the page's own work, as the browser's are 50 ms of wall time. A task the page
      // waits in (a synchronous call to another process, a GPU readback) holds the thread with little work, so any task
      // of 150 ms of wall time fails too: the system taking the CPU from the page made 67 ms at most on the runner.
      const work = await pageWork(async () => {
        await flick(400, 2_500)
        await rest()
      })
      const flung = await fromEnd()
      assert.ok(flung > 600, `a flick of 400 px glided ${Math.round(flung)} px from the end`)
      const walls = await longTasks(since)
      const tasks = work.filter((task) => task.cpu >= 50).map((task) => Math.round(task.cpu))
      const blocked = work.filter((task) => task.wall >= 150).map((task) => Math.round(task.wall))
      const most = work.reduce((worst, task) => (task.cpu > worst.cpu ? task : worst), { wall: 0, cpu: 0 })
      if (diagnostic) packet.oracle = { status: "observed", since, measure: "the page's main-thread CPU time per task, from a trace", tasks: tasks.slice(0, 64), droppedTasks: Math.max(0, tasks.length - 64), blocked: blocked.slice(0, 64), wallTasks: walls.slice(0, 64) }
      assert.deepEqual(tasks, [], `a flick while streaming made long tasks: ${tasks.join(", ")} ms of the page's own work`)
      assert.deepEqual(blocked, [], `a flick while streaming held the page's thread in tasks of ${blocked.join(", ")} ms`)
      held = await holds("after a flick")
      console.log(`Flick up: glided to ${Math.round(flung)} px from the end, no long tasks (the most work in one: ${most.cpu.toFixed(1)} ms, ${most.wall.toFixed(1)} ms of wall time${walls.length ? `; wall-clock long tasks ${walls.join(", ")} ms` : ""}), held within ${Math.abs(held.worst).toFixed(1)} px`)
      if (diagnostic) packet.oracle.status = "passed-instrumented-only"
    } catch (value) {
      primary = value; hasPrimary = true
      if (diagnostic) packet.oracle = { ...packet.oracle, status: "threw", thrown: text(value) }
    }
    if (diagnostic) try {
      if (setup.status !== "timed-out") {
        const cleanup = await attempt("cleanup", () => evaluate("window.__finishFlickDiagnostic?.() === true"))
        unavailable ||= cleanup.status !== "completed" || cleanup.value !== true
        if (cleanup.status === "completed" && cleanup.value === true) {
          const readback = await attempt("readback", () => evaluate("window.__readFlickDiagnostic?.()"))
          unavailable ||= readback.status !== "completed"
          if (readback.status === "completed") try {
            if (Buffer.byteLength(readback.value, "utf8") > packet.budgets.rendererBytes) throw new Error("Renderer diagnostic exceeds byte budget")
            packet.renderer = JSON.parse(readback.value)
            unavailable ||= packet.renderer.status !== "active" || packet.renderer.cleanup !== "completed"
          } catch (value) { packet.readbackError = text(value); unavailable = true }
        }
      }
      packet.status = unavailable ? "diagnostic-unavailable" : "completed"
      packet.primaryThrown = hasPrimary
      packet.disposition = hasPrimary ? "throw-original" : unavailable ? "abort-before-next-scope" : "continue-original-test"
      packet.fileWrite = "One bounded request; final delivery state is in FLICK_DIAGNOSTIC_STATUS, not self-certified by this file. A timed-out OS write may finish later; no cancellation claim."
      let bytes = Buffer.from(JSON.stringify(packet, null, 2))
      if (bytes.length > packet.budgets.fileBytes) { delete packet.renderer; packet.retention = "renderer-omitted-for-budget"; bytes = Buffer.from(JSON.stringify(packet, null, 2)) }
      if (bytes.length <= packet.budgets.fileBytes) {
        const written = await attempt("write", () => writeFile(join(evidence, captureName), bytes, { flag: "wx" }))
        unavailable ||= written.status !== "completed"
      } else { packet.retention = "file-not-requested-over-budget"; unavailable = true }
      if (unavailable) { packet.status = "diagnostic-unavailable"; packet.disposition = hasPrimary ? "throw-original" : "abort-before-next-scope" }
    } catch (value) {
      unavailable = true
      packet.status = "diagnostic-unavailable"
      packet.finalizationError = text(value)
      packet.disposition = hasPrimary ? "throw-original" : "abort-before-next-scope"
    } finally { if (diagnostic) emit() }
    if (hasPrimary) throw primary
    if (unavailable) throw Object.assign(new Error("Flick diagnostic unavailable; invocation aborted before another scope"), { code: "FLICK_DIAGNOSTIC_UNAVAILABLE" })

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
    // pauses for the move, so it alone sets how far from the end the reader stops: paused, and its last words drawn,
    // before the finger lands. Stopped as it landed, a paint still due (up to 90 ms, markdown.tsx) grew the page under
    // the finger, which holds the end, and a 60 px move read as 110.
    await evaluate("window.scrollCheck.stop(), true")
    await evaluate(`new Promise(resolve => {
      const node = ${scroller}
      let height = node.scrollHeight, since = performance.now()
      const step = () => { if (node.scrollHeight !== height) { height = node.scrollHeight; since = performance.now() } performance.now() - since >= 200 ? resolve(true) : requestAnimationFrame(step) }
      requestAnimationFrame(step)
    })`)
    await toEnd()
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

    // 6. The phone turned sideways at the end and back: every line flows again, and the newest turn stays where the
    // end shows it, not above a blank kept from the taller column of before.
    await toEnd()
    const turn = async (sideways) => {
      await send("Emulation.setDeviceMetricsOverride", { width: sideways ? 852 : 393, height: sideways ? 393 : 852, deviceScaleFactor: 3, mobile: true })
      await rest()
    }
    const belowNewest = () => evaluate(`(() => { const node = ${scroller}; const turns = node.querySelectorAll('[data-exchange]'); return Math.round(node.getBoundingClientRect().bottom - turns[turns.length - 1].getBoundingClientRect().bottom) })()`)
    const uprightGap = await belowNewest()
    await turn(true)
    const sidewaysGap = await belowNewest()
    await capture("turned-sideways-iphone-dark.png")
    await turn(false)
    const backGap = await belowNewest()
    assert.ok(Math.abs(sidewaysGap - uprightGap) <= 2, `turned sideways at the end, the newest turn ended ${sidewaysGap} px above the transcript's bottom, upright ${uprightGap} px`)
    assert.ok(Math.abs(backGap - uprightGap) <= 2, `turned upright again, the newest turn ended ${backGap} px above the bottom, at first ${uprightGap} px`)
    console.log(`Turned sideways and back at the end: the newest turn ended ${uprightGap}, ${sidewaysGap}, ${backGap} px above the bottom`)

    // Light, read while streaming.
    await phone("light")
    await evaluate("window.scrollCheck.stream(50, 3), true")
    await flick(400, 2_500)
    await rest()
    await wait(1_500)
    await capture("reading-while-streaming-iphone-light.png")
    await evaluate("window.scrollCheck.stop(), true")

    // 7. An earlier page arriving under a resting finger: the line under it stays.
    await window.loadURL(`${new URL("scripts/transcript-scroll-browser.html", process.env.MAKO_SCROLL_URL).href}?turns=90&paged=12&answer=4000`)
    await until(`document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length >= 2`, "the paged transcript")
    await rest()
    // Flicked up to the top until its source is asked for a page ("Loading earlier turns…"; the turns it already holds
    // come in first, each placed at once). The source answers 4 s later, so the glide ends and the finger lands and
    // rests before the page does. Measured from the rest, every frame until the page is in and a second on: an
    // emulated finger's drag isn't followed 1:1 (as much as 10 px either way over 140 px, with no write of the
    // transcript's own), which would hide a page's move or fake one.
    const height = () => evaluate(`${scroller}.scrollHeight`)
    const first = await height()
    const loading = () => evaluate(`Boolean(document.querySelector('[data-earlier="loading"]'))`)
    let asking = false
    for (let flicks = 0; flicks < 40 && !asking; flicks += 1) {
      await flick(1_500, 6_000)
      asking = await loading()
    }
    assert.ok(asking, "the transcript asked its source for an earlier page")
    await rest()
    await touch("touchStart", centre)
    await rest()
    assert.ok(await loading(), "the page is still on its way once the finger rests")
    const was = await height()
    await markAnchor()
    const paged = await evaluate(`new Promise(resolve => {
      const node = ${scroller}
      const until = performance.now() + 20000
      let worst = 0, inAt
      const step = () => {
        const moved = window.__anchor.turn.isConnected ? window.__anchor.turn.getBoundingClientRect().top - window.__anchor.top : Infinity
        if (Math.abs(moved) > Math.abs(worst)) worst = moved
        if (!document.querySelector('[data-earlier="loading"]') && !node.hasAttribute('data-preserve-scroll')) inAt ??= performance.now()
        if (inAt !== undefined && performance.now() - inAt >= 1000) return resolve(node.scrollHeight > ${was} ? worst : undefined)
        performance.now() > until ? resolve(undefined) : requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })`)
    await touch("touchCancel")
    await rest()
    assert.notEqual(paged, undefined, "an earlier page arrived under the resting finger")
    assert.ok(Math.abs(paged) <= 1, `an earlier page moved the line under the resting finger ${Math.round(paged)} px`)
    console.log(`Paging under a resting finger: the transcript grew ${first} → ${await height()} px above it, the line under it moved ${Math.abs(paged).toFixed(1)} px at most`)

    // 8. A laptop's wheel leaves the end of a streaming answer, in a short transcript and a windowed one.
    await send("Emulation.setTouchEmulationEnabled", { enabled: false })
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
    for (const turns of [20, 250]) {
      await window.loadURL(`${new URL("scripts/transcript-scroll-browser.html", process.env.MAKO_SCROLL_URL).href}?turns=${turns}`)
      // A windowed transcript mounts only the rows around what's shown.
      await until(`document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length >= 2`, "the laptop's transcript")
      await evaluate(INSTRUMENT)
      await rest()
      await evaluate("window.probe.startTurn(), window.__streaming = setInterval(() => window.probe.appendToTurn('The answer keeps arriving, a few words a frame. '), 50), true")
      await wait(800)
      const windowed = await evaluate(`${scroller}.hasAttribute('data-virtualized')`)
      assert.equal(windowed, turns > 40, `${turns} turns ${windowed ? "are" : "aren't"} windowed`)
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
