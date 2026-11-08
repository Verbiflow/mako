import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * What a long transcript costs on the desk, through the production panel on the mock bridge's Apex
 * (`?mock&app=apex`): with `--turns N` earlier turns made up, or with `--journal <url>` a real conversation's blocks
 * and requests served by the dev server (`{ blocks, requests }`, as a journal holds them). Each run opens the Apex
 * from its row, then measures:
 *
 * - open: the first click on its row (its panel never drawn) and a click back from another Thread (its pane kept
 *   warm): to the first frame that paints its turns, and to the frame its end stops moving;
 * - projection: the store's whole projection of the conversation, and one token's re-projection of its newest turn;
 * - memory: the JS heap after a collection, and the document's nodes, once open;
 * - scroll: frame intervals while a wheel climbs through its history for four seconds, and the long tasks;
 * - stream: frame intervals while 120 batches of words land through the window's batch path, one a frame, and the
 *   main thread's task and script time for each batch;
 * - send: from Enter to the frame that paints the sent message.
 *
 * Numbers only, the median of `--runs` (default 3); nothing here passes or fails. `--json <file>` writes them.
 *
 *   node scripts/bench-transcript-ui.mjs http://127.0.0.1:21230/ --turns 260
 *   node scripts/bench-transcript-ui.mjs http://127.0.0.1:21230/ --journal /node_modules/.tmp/bench-real/apex.json
 */
if (process.versions.electron) {
  void bench().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-transcript-bench-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-transcript-bench", main: fileURLToPath(import.meta.url) }))
  const args = process.argv.slice(2)
  const given = args.find((arg) => /^https?:/.test(arg))
  const option = (name) => {
    const at = args.indexOf(`--${name}`)
    return at < 0 ? undefined : args[at + 1]
  }
  let server
  if (!given) {
    const { createServer } = await import("vite")
    server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const query = option("journal") ? `&journal=${encodeURIComponent(option("journal"))}` : `&turns=${option("turns") ?? 260}`
  const env = { ...process.env, MAKO_BENCH_ROOT: root, MAKO_BENCH_URL: given ?? server.resolvedUrls.local[0], MAKO_BENCH_QUERY: query, MAKO_BENCH_RUNS: option("runs") ?? "3", MAKO_BENCH_JSON: option("json") ?? "" }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), ["--js-flags=--expose-gc", root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
}

// The Apex's own panel: its conversation's ID ends in "ead" (`APEX_CONVERSATION`), no Fin's does.

/** Frames and long tasks from now on, read by `frames()`; each frame's time is read after its resize observers. */
const WATCH = `(() => {
  const times = window.__frameTimes = []
  const tasks = window.__longTasks = []
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push(entry.duration) }).observe({ type: 'longtask' })
  const tick = (at) => { times.push(at); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  return true
})()`

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
}
const percentile = (values, p) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0
}

async function bench() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_BENCH_ROOT
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  app.on("window-all-closed", () => undefined)
  await app.whenReady()
  const runs = []
  for (let run = 0; run < Number(process.env.MAKO_BENCH_RUNS); run += 1) runs.push(await once(BrowserWindow))
  const numbers = {}
  for (const key of Object.keys(runs[0])) numbers[key] = Math.round(median(runs.map((each) => each[key])) * 10) / 10
  console.log(`BENCH ${JSON.stringify(numbers)}`)
  if (process.env.MAKO_BENCH_JSON) await writeFile(process.env.MAKO_BENCH_JSON, `${JSON.stringify({ numbers, runs }, null, 2)}\n`)
  app.exit(0)
}

async function once(BrowserWindow) {
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const evaluate = (code) => page.executeJavaScript(code)
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, what) => {
    const deadline = Date.now() + 60_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await wait(25)
    }
  }
  await window.loadURL(`${process.env.MAKO_BENCH_URL}?mock&app=apex&idle=1${process.env.MAKO_BENCH_QUERY}`).catch((error) => {
    if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
  })
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
  await evaluate("document.fonts.ready.then(() => true)")
  await wait(500)
  /** The click on the Apex's row, the first frame that paints its turns, and the frame after which its end held for 10 frames. */
  const OPEN = `new Promise((done) => {
    const start = performance.now()
    let painted = 0, last = -1, still = 0, lastChange = 0
    const row = [...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish'))
    row.click()
    const look = () => {
      const at = performance.now()
      const node = document.querySelector('[data-live-conversation$=ead] [data-transcript-viewport]')
      const turns = node ? node.querySelectorAll('[data-exchange]').length : 0
      if (turns && !painted) painted = at
      if (painted) {
        const end = node.scrollHeight - node.scrollTop
        if (Math.abs(end - last) < 0.5) still += 1
        else { still = 0; lastChange = at; last = end }
        if (still >= 10) return done({ paint: painted - start, settled: lastChange - start })
      }
      if (at - start > 30000) return done({ paint: -1, settled: -1 })
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  })`
  // Cold: the Apex's panel has never been drawn in this window (it opens on a Fin).
  assert.ok(!(await evaluate("Boolean(document.querySelector('[data-live-conversation$=ead]'))")), "the window opens on another conversation")
  if (process.env.MAKO_BENCH_PROFILE) {
    await send("Profiler.enable")
    await send("Profiler.setSamplingInterval", { interval: 200 })
    await send("Profiler.start")
  }
  const cold = await evaluate(OPEN)
  if (process.env.MAKO_BENCH_PROFILE) await writeFile(`${process.env.MAKO_BENCH_PROFILE}-open.cpuprofile`, JSON.stringify((await send("Profiler.stop")).profile))
  await wait(500)
  // Warm: away to another Thread and back.
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Refactor the composer')).click(), true")
  await until("!document.querySelector('[data-live-conversation$=ead]')", "another Thread open")
  await wait(500)
  if (process.env.MAKO_BENCH_PROFILE) await send("Profiler.start")
  const opened = await evaluate(OPEN)
  if (process.env.MAKO_BENCH_PROFILE) await writeFile(`${process.env.MAKO_BENCH_PROFILE}-switch.cpuprofile`, JSON.stringify((await send("Profiler.stop")).profile))
  await wait(1000)
  if (process.env.MAKO_BENCH_SHOT) await writeFile(process.env.MAKO_BENCH_SHOT, (await page.capturePage()).toPNG())

  // Memory, once open and collected.
  await send("HeapProfiler.collectGarbage")
  const heap = await send("Runtime.getHeapUsage")
  const nodes = await evaluate("document.getElementsByTagName('*').length")
  const mounted = await evaluate("document.querySelectorAll('[data-live-conversation$=ead] [data-exchange]').length")
  const rows = await evaluate("Math.max(0, ...[...document.querySelectorAll('[data-live-conversation$=ead] [data-index]')].map((row) => Number(row.dataset.index))) + 1")
  const columnPx = await evaluate("document.querySelector('[data-live-conversation$=ead] [data-virtual-transcript]')?.offsetHeight ?? 0")

  // Scroll: a wheel toward earlier turns, one notch a frame, for four seconds.
  await evaluate(WATCH)
  const box = await evaluate("(() => { const r = document.querySelector('[data-live-conversation$=ead] [data-transcript-viewport]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()")
  const scrollStart = Date.now()
  while (Date.now() - scrollStart < 4_000) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -120 })
    await wait(16)
  }
  await wait(300)
  const scroll = await evaluate("(() => { const t = window.__frameTimes; const gaps = t.slice(1).map((at, i) => at - t[i]); return { gaps, tasks: window.__longTasks.slice(), climbed: document.querySelector('[data-live-conversation$=ead] [data-transcript-viewport]').scrollHeight - document.querySelector('[data-live-conversation$=ead] [data-transcript-viewport]').scrollTop } })()")

  // Projection: the store's whole projection of the conversation, as a snapshot arriving makes it, and one token's
  // re-projection of the newest turn, as each streamed batch makes it.
  const projection = await evaluate(`(async () => {
    const { acpStore } = await import('/src/state/acp-state.ts')
    const { projectAcp } = await import('/src/state/live-projection.ts')
    const conversation = Object.values(acpStore.get().conversations).find((each) => each.kind === 'live' && each.session.id.endsWith('ead'))
    const times = (run) => { const all = []; for (let i = 0; i < 5; i += 1) { const start = performance.now(); run(); all.push(performance.now() - start) } return all.sort((a, b) => a - b)[2] }
    const full = times(() => projectAcp({ ...conversation, projection: undefined }))
    const last = conversation.blocks.at(-1)
    const grown = last?.type === 'text' ? [...conversation.blocks.slice(0, -1), { ...last, text: last.text + ' token' }] : [...conversation.blocks, { type: 'text', text: 'token' }]
    const tail = times(() => projectAcp({ ...conversation, blocks: grown }))
    return { full, tail, blocks: conversation.blocks.length }
  })()`)

  // Streaming: 120 batches of a few words each, one a frame, through the window's own batch path, at the end.
  await evaluate("(() => { const node = document.querySelector('[data-live-conversation$=ead] [data-transcript-viewport]'); node.scrollTop = node.scrollHeight; return true })()")
  await wait(300)
  await send("Performance.enable")
  const metric = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((each) => [each.name, each.value]))
  const before = await metric()
  if (process.env.MAKO_BENCH_PROFILE) await send("Profiler.start")
  const stream = await evaluate(`(async () => {
    const { acpStore } = await import('/src/state/acp-state.ts')
    const { applyLiveBatch } = await import('/src/state/live-recovery.ts')
    const id = Object.values(acpStore.get().conversations).find((each) => each.kind === 'live' && each.session.id.endsWith('ead')).session.id
    const revision = () => Object.values(acpStore.get().conversations).find((each) => each.kind === 'live' && each.session.id === id).revision ?? 0
    const session = Object.values(acpStore.get().conversations).find((each) => each.kind === 'live' && each.session.id === id).session
    applyLiveBatch({ id, revision: revision() + 1, updates: [], session: { ...session, status: 'running' } })
    const gaps = [], tasks = []
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push(entry.duration) }).observe({ type: 'longtask' })
    let previous = 0
    for (let batch = 0; batch < 120; batch += 1) {
      const at = await new Promise((done) => requestAnimationFrame(done))
      if (previous) gaps.push(at - previous)
      previous = at
      applyLiveBatch({ id, revision: revision() + 1, updates: [{ kind: 'text', text: batch % 12 === 11 ? ' and the next paragraph.\\n\\nNew ' : ' streamed words ' }] })
    }
    applyLiveBatch({ id, revision: revision() + 1, updates: [], session: { ...session, status: 'ready' } })
    return { gaps, tasks }
  })()`)
  const after = await metric()
  if (process.env.MAKO_BENCH_PROFILE) await writeFile(`${process.env.MAKO_BENCH_PROFILE}-stream.cpuprofile`, JSON.stringify((await send("Profiler.stop")).profile))
  await wait(500)

  // Send: back at the end, Enter, and the frame that paints the message.
  await evaluate("document.querySelector('[data-live-conversation$=ead] [data-transcript-viewport]').dispatchEvent(new Event('mako:transcript-end', { bubbles: true })), true")
  await evaluate("(() => { const node = document.querySelector('[data-live-conversation$=ead] [data-transcript-viewport]'); node.scrollTop = node.scrollHeight; return true })()")
  await wait(500)
  await evaluate("document.querySelector('.composer-input').focus(), true")
  await send("Input.insertText", { text: "Bench: which of the queued ones goes next?" })
  await evaluate(`(() => {
    window.__sentPaint = null
    const kick = document.createElement('div')
    kick.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px;opacity:0;pointer-events:none'
    document.body.append(kick)
    const observer = new ResizeObserver(() => {
      if (window.__sentPaint !== null || window.__sentAt === undefined) return
      const shown = [...document.querySelectorAll('[data-live-conversation$=ead] [data-exchange]')].some((turn) => turn.textContent.includes('Bench: which of the queued'))
      if (shown) window.__sentPaint = performance.now() - window.__sentAt
    })
    observer.observe(kick)
    const tick = () => { kick.style.width = kick.style.width === '1px' ? '2px' : '1px'; if (window.__sentPaint === null) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    document.addEventListener('keydown', (event) => { if (event.key === 'Enter' && window.__sentAt === undefined) window.__sentAt = performance.now() }, { capture: true })
    return true
  })()`)
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await until("window.__sentPaint !== null", "the sent message painted")
  const sent = await evaluate("window.__sentPaint")
  window.destroy()
  return {
    coldPaintMs: cold.paint,
    coldSettledMs: cold.settled,
    projectFullMs: projection.full,
    projectTailMs: projection.tail,
    blocks: projection.blocks,
    switchPaintMs: opened.paint,
    switchSettledMs: opened.settled,
    heapMB: heap.usedSize / 1048576,
    domNodes: nodes,
    turns: rows,
    columnPx,
    mountedTurns: mounted,
    scrollFrameP50Ms: percentile(scroll.gaps, 0.5),
    scrollFrameP95Ms: percentile(scroll.gaps, 0.95),
    scrollFrameMaxMs: Math.max(...scroll.gaps),
    scrollFramesOver33: scroll.gaps.filter((gap) => gap > 33.4).length,
    scrollLongTaskMs: scroll.tasks.reduce((sum, ms) => sum + ms, 0),
    streamFrameP50Ms: percentile(stream.gaps, 0.5),
    streamFrameP95Ms: percentile(stream.gaps, 0.95),
    streamFrameMaxMs: Math.max(...stream.gaps),
    streamLongTaskMs: stream.tasks.reduce((sum, ms) => sum + ms, 0),
    streamTaskMsPerBatch: ((after.TaskDuration - before.TaskDuration) * 1000) / 120,
    streamScriptMsPerBatch: ((after.ScriptDuration - before.ScriptDuration) * 1000) / 120,
    sendPaintMs: sent,
  }
}
