import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

/**
 * What a streamed answer costs the window itself: `npm run bench:window`. It is part D of `npm run bench:vs-bare`,
 * whose `--record <file>` keeps what a window was sent in a measured turn: every batch and every line said ahead of
 * one (`LiveAhead`), each with when it came, and the conversation as it was right before the send.
 *
 * One turn of a recording is replayed into the production transcript panel, rail and composer on the mock bridge
 * (`scripts/bench-window.tsx`), in one hidden Electron window, the Chromium the app ships: the conversation is opened
 * from its snapshot, active and at its end, and each line then arrives in a task of its own at its recorded spacing,
 * decoded as the preload decodes it and handed to what `src/state/session.ts` routes it to (`applyLiveBatch`,
 * `applyLiveAhead`). Each replay is a new page. It is replayed two ways, alternating: as recorded, and with the lines
 * said ahead left out, which is what a window heard before there were any. `--turns N` puts N made-up turns before
 * the recorded ones first (`auditSnapshot`: a prompt, a call and 512 characters of answer each, in the blocks and in
 * the base, as a long conversation holds its own).
 *
 * For each line: decoding it and applying it with its projection (`performance.now` around the calls, which this page
 * reads to 0.1 ms), React's rendering between it and the next line (a `Profiler`'s `actualDuration`, which leaves out
 * the commit's DOM writes and effects; a paint the prose throttle delayed counts for the line before it, not the one
 * whose text it draws), its whole task up to the microtask after React's synchronous render and commit, the time to
 * the next frame's callbacks (`requestAnimationFrame`) and to the first task after that frame's style, layout and
 * paint (a message posted from the callback).
 *
 * For the stream: tasks past 50 ms (`longtask`); frames the main thread ran against what a 60 Hz display offered, and
 * at the display's own rate where that is faster; frames that drew a change (the transcript's nodes or text changed
 * since the frame before); the longest a line with new text waited for such a frame; and the main thread's task,
 * script, style and layout time (CDP `Performance.getMetrics`). One row says what the lines said ahead buy: how long
 * text took from the line that first told the window of it to a frame with it drawn (the answer's
 * `data-rendered-chars`), where the replay without those lines is timed against when they came. The transcript paces
 * its own draws (`ExchangePacer` in `src/lib/stream-pace.ts`, then the prose throttle), so a line is not a draw. One
 * more replay each way is traced (`contentTracing`), for the frames the compositor was offered, presented and dropped.
 * Numbers only, the median of `--runs` replays with the least and the most; a replay that didn't end on the
 * recording's last revision with all of its text fails the run.
 *
 * What it cannot say. The window is hidden, so nothing reaches a display: a frame here is the main thread's, and the
 * traced counts are the compositor's own word that it presented, not glass. The page is served by Vite's dev server
 * with React's development build unless `--production` builds it (with `react-dom/profiling`, so the `Profiler` still
 * reports): development renders cost more than the app's. The bridge is the mock, so nothing else a real host sends
 * is arriving, and the line's trip from the host through the main process to the preload is `bench:vs-bare`'s to
 * time, not this. A frame that drew a change may be another row's change, not the line's own text. The page asks for
 * every frame to count them, and a streaming turn animates anyway, so nearly every frame is drawn either way: the
 * compositor's counts say whether frames were lost, not how many a line caused.
 *
 *   npm run bench:window -- --recording <file> [--turns 300] [--runs 3] [--scenario warm] [--production] [--no-trace]
 *                           [--json <file>]
 */
if (process.versions.electron) {
  void bench().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { values } = parseArgs({
    options: {
      recording: { type: "string" },
      turns: { type: "string", default: "0" },
      runs: { type: "string", default: "3" },
      scenario: { type: "string" },
      production: { type: "boolean", default: false },
      "no-trace": { type: "boolean", default: false },
      json: { type: "string" },
    },
  })
  assert.ok(values.recording, "--recording <file>: what `npm run bench:vs-bare -- --record <file>` wrote")
  const turns = Number(values.turns)
  const runs = Number(values.runs)
  assert.ok(Number.isInteger(turns) && turns >= 0, "--turns is a count of earlier turns")
  assert.ok(Number.isInteger(runs) && runs >= 1, "--runs is a count of replays")
  const { testScratch } = await import("./lib/test-scratch.mjs")
  const root = testScratch("mako-bench-window-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-bench-window", main: fileURLToPath(import.meta.url) }))
  let server
  let close = async () => undefined
  if (values.production) {
    const { build, preview } = await import("vite")
    const config = {
      cacheDir: join(root, "cache"),
      // The profiling build is production React with the `Profiler`'s timings left in.
      resolve: { alias: { "react-dom/client": "react-dom/profiling" } },
      build: { outDir: join(root, "dist"), rolldownOptions: { input: resolve("scripts/bench-window.html") } },
      preview: { host: "127.0.0.1", port: 0 },
      logLevel: "warn",
    }
    await build(config)
    server = await preview(config)
    close = () => new Promise((done) => server.httpServer.close(done))
  } else {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    close = () => server.close()
  }
  const settings = {
    root,
    url: new URL("scripts/bench-window.html", server.resolvedUrls.local[0]).href,
    recording: resolve(values.recording),
    turns,
    runs,
    scenario: values.scenario ?? null,
    react: values.production ? "production (profiling)" : "development",
    trace: !values["no-trace"],
    json: values.json ? resolve(values.json) : null,
  }
  const env = { ...process.env, MAKO_BENCH_WINDOW: JSON.stringify(settings) }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await close()
  }
}

const FRAME_MS = 1000 / 60
const VARIANTS = [
  { name: "recorded", label: "as recorded", ahead: true },
  { name: "batches", label: "batches only", ahead: false },
]

const sorted = (values) => [...values].sort((left, right) => left - right)
const median = (values) => {
  const all = sorted(values)
  return all.length ? all[Math.floor((all.length - 1) / 2)] : undefined
}
const quantile = (values, q) => {
  const all = sorted(values)
  return all.length ? all[Math.min(all.length - 1, Math.ceil(q * all.length) - 1)] : undefined
}
const most = (values) => (values.length ? Math.max(...values) : undefined)
const sum = (values) => values.reduce((total, value) => total + value, 0)
const spread = (prefix, values) => ({ [`${prefix}P50`]: quantile(values, 0.5), [`${prefix}P95`]: quantile(values, 0.95), [`${prefix}Max`]: most(values) })

const defined = (values) => values.filter((value) => value !== null && value !== undefined)

/** One replay's numbers from what its page kept; a value that wasn't measured stays undefined. */
function summarize(raw, script) {
  const { arrivals, ticks, longTasks } = raw
  const text = arrivals.filter((arrival) => arrival.text)
  const from = arrivals[0]?.at ?? 0
  const to = arrivals.at(-1)?.at ?? 0
  const textFrom = text[0]?.at ?? 0
  const textTo = text.at(-1)?.at ?? 0
  const during = ticks.filter((tick) => tick.at >= from && tick.at <= to)
  const gaps = during.slice(1).map((tick, index) => tick.at - during[index].at)
  const interval = quantile(gaps, 0.5)
  // A 60 Hz display's frames over the stream, each a slot of time: the ones the main thread ran a frame in.
  const offered = Math.floor((to - from) / FRAME_MS)
  const slot = (tick) => Math.floor((tick.at - from) / FRAME_MS)
  const ran = new Set(during.map(slot).filter((index) => index < offered))
  const drew = new Set(during.filter((tick) => tick.changed).map(slot).filter((index) => index < offered))
  const changed = ticks.filter((tick) => tick.changed).map((tick) => tick.at)
  // For each line with new text, the next frame that drew a change; the longest is the longest stretch with text
  // waiting and nothing drawn.
  const waits = text.flatMap((arrival) => {
    const next = changed.find((at) => at >= arrival.at)
    return next === undefined ? [] : [next - arrival.at]
  })
  return {
    arrivals: arrivals.length,
    aheadArrivals: arrivals.filter((arrival) => arrival.kind === "live-ahead").length,
    textArrivals: text.length,
    arrivalsPerSecond: textTo > textFrom ? arrivals.filter((arrival) => arrival.at >= textFrom && arrival.at <= textTo).length / ((textTo - textFrom) / 1000) : undefined,
    streamMs: to - from,
    ...spread("late", arrivals.map((arrival) => arrival.at - arrival.due)),
    ...spread("take", arrivals.map((arrival) => arrival.decodeMs + arrival.applyMs)),
    ...spread("apply", arrivals.map((arrival) => arrival.applyMs)),
    ...spread("task", defined(arrivals.map((arrival) => arrival.taskMs))),
    taskTotalMs: sum(defined(arrivals.map((arrival) => arrival.taskMs))),
    takeTotalMs: sum(arrivals.map((arrival) => arrival.decodeMs + arrival.applyMs)),
    ...spread("commit", arrivals.map((arrival) => arrival.commitMs)),
    commits: sum(arrivals.map((arrival) => arrival.commits)),
    commitTotalMs: sum(arrivals.map((arrival) => arrival.commitMs)),
    transcriptCommitMs: raw.commits.transcript?.ms ?? 0,
    composerCommitMs: raw.commits.composer?.ms ?? 0,
    railCommitMs: raw.commits.rail?.ms ?? 0,
    ...spread("frame", defined(arrivals.map((arrival) => arrival.frameMs))),
    ...spread("rendered", defined(arrivals.map((arrival) => arrival.renderedMs))),
    longTasks: longTasks.length,
    longTaskTotalMs: sum(longTasks.map((task) => task.ms)),
    longTaskMaxMs: most(longTasks.map((task) => task.ms)) ?? 0,
    framesOffered: offered,
    framesPainted: ran.size,
    framesDropped: offered - ran.size,
    framesDrew: drew.size,
    frameIntervalP50: interval,
    frameIntervalMax: most(gaps),
    ownFramesRun: during.length,
    ownFramesMissed: interval ? sum(gaps.map((gap) => Math.max(0, Math.round(gap / interval) - 1))) : undefined,
    ownFramesChanged: during.filter((tick) => tick.changed).length,
    ...spread("textWait", waits),
    taskMs: script?.TaskDuration,
    scriptMs: script?.ScriptDuration,
    styleMs: script?.RecalcStyleDuration,
    layoutMs: script?.LayoutDuration,
    mountedTurns: raw.mountedTurns,
    rows: raw.rows,
    domNodes: raw.domNodes,
    blocks: raw.blocks,
  }
}

/**
 * For each point of `told` (when the window was first told of some text, in the replay that heard everything, and how
 * much of which block it then held), how long until a frame of this replay had that much of that block drawn. Both
 * replays run on the recording's clock, so the replay without the lines said ahead is timed against when they came.
 * Undefined when the page's last prose changed some other number of times than the turn's text blocks.
 */
function shownWaits(told, ticks) {
  if (!told.length || Math.max(...ticks.map((tick) => tick.segment)) !== Math.max(...told.map((point) => point.segment))) return undefined
  const waits = []
  let index = 0
  for (const point of told) {
    const shows = (tick) => tick.at >= point.due && (tick.segment > point.segment || (tick.segment === point.segment && tick.rendered !== null && tick.rendered >= point.last))
    while (index < ticks.length && !shows(ticks[index])) index += 1
    if (index < ticks.length) waits.push(ticks[index].at - point.due)
  }
  return waits
}

/**
 * The compositor's own count from a trace, between the page's two marks: each `PipelineReporter` is one frame the
 * compositor was offered, with how it ended, and `DrawFrame` each one it drew. Undefined for what the trace lacks.
 */
function traced(events) {
  const mark = (name) => events.find((event) => event.name === name && event.cat?.includes("blink.user_timing"))?.ts
  const start = mark("bench-window-start")
  const end = mark("bench-window-end")
  if (start === undefined || end === undefined) return {}
  const renderer = events.find((event) => event.name === "bench-window-start")?.pid
  const within = events.filter((event) => event.ts >= start && event.ts <= end)
  const reporters = within.filter((event) => event.name === "PipelineReporter" && (event.ph === "b" || event.ph === "X") && event.pid === renderer)
  const state = (wanted) => reporters.filter((event) => event.args?.chrome_frame_reporter?.state === wanted || event.args?.frame_reporter?.state === wanted).length
  const draws = within.filter((event) => event.name === "DrawFrame" && event.pid === renderer)
  const main = within.filter((event) => event.pid === renderer && event.ph === "X")
  const time = (name) => sum(main.filter((event) => event.name === name).map((event) => event.dur ?? 0)) / 1000
  return {
    tracedMs: (end - start) / 1000,
    compositorFrames: reporters.length || undefined,
    compositorPresented: reporters.length ? state("STATE_PRESENTED_ALL") + state("STATE_PRESENTED_PARTIAL") : undefined,
    compositorDropped: reporters.length ? state("STATE_DROPPED") : undefined,
    compositorNoUpdate: reporters.length ? state("STATE_NO_UPDATE_DESIRED") : undefined,
    drawFrames: draws.length || undefined,
    paints: main.filter((event) => event.name === "Paint").length || undefined,
    paintMs: main.some((event) => event.name === "Paint") ? time("Paint") : undefined,
    tracedLayoutMs: main.some((event) => event.name === "Layout") ? time("Layout") : undefined,
    tracedStyleMs: main.some((event) => event.name === "UpdateLayoutTree") ? time("UpdateLayoutTree") : undefined,
  }
}

const ROWS = [
  ["arrivals", "lines the window took", 0],
  ["aheadArrivals", "  of them said ahead of a batch", 0],
  ["textArrivals", "  of them with new text", 0],
  ["arrivalsPerSecond", "lines a second while text streamed", 1],
  ["lateP50", "line taken after its recorded time, ms: p50", 2],
  ["lateMax", "  max", 2],
  ["takeP50", "decode + apply + projection per line, ms: p50", 3],
  ["takeP95", "  p95", 3],
  ["takeMax", "  max", 3],
  ["applyP50", "  apply + projection alone: p50", 3],
  ["applyP95", "  p95", 3],
  ["applyMax", "  max", 3],
  ["takeTotalMs", "  the whole stream, ms", 1],
  ["taskP50", "the line's task with React's render in it, ms: p50", 2],
  ["taskP95", "  p95", 2],
  ["taskMax", "  max", 2],
  ["taskTotalMs", "  the whole stream, ms", 1],
  ["commitP50", "React render per line (Profiler), ms: p50", 2],
  ["commitP95", "  p95", 2],
  ["commitMax", "  max", 2],
  ["commits", "  commits in the stream", 0],
  ["commitTotalMs", "  the whole stream, ms", 1],
  ["transcriptCommitMs", "    transcript", 1],
  ["composerCommitMs", "    composer", 1],
  ["railCommitMs", "    rail", 1],
  ["frameP50", "line to the next frame's callbacks, ms: p50", 2],
  ["frameP95", "  p95", 2],
  ["frameMax", "  max", 2],
  ["renderedP50", "line to that frame rendered (main thread), ms: p50", 2],
  ["renderedP95", "  p95", 2],
  ["renderedMax", "  max", 2],
  ["textWaitP50", "new text to the next frame that drew a change, ms: p50", 2],
  ["textWaitP95", "  p95", 2],
  ["textWaitMax", "  max (the longest stretch with text waiting undrawn)", 2],
  ["shownP50", "text first told to the window to a frame with it drawn, ms: p50", 2],
  ["shownP95", "  p95", 2],
  ["shownMax", "  max", 2],
  ["longTasks", "tasks past 50 ms", 0],
  ["longTaskTotalMs", "  their time, ms", 1],
  ["longTaskMaxMs", "  the longest, ms", 1],
  ["streamMs", "first line to last, ms", 0],
  ["framesOffered", "frames a 60 Hz display offered", 0],
  ["framesPainted", "  of them the main thread ran a frame in", 0],
  ["framesDropped", "  dropped (no frame in them)", 0],
  ["framesDrew", "  with a frame that drew a change", 0],
  ["frameIntervalP50", "this display's frame interval, ms: p50", 2],
  ["frameIntervalMax", "  max (the longest with no frame)", 2],
  ["ownFramesRun", "  frames run at that rate", 0],
  ["ownFramesMissed", "  missed at that rate", 0],
  ["ownFramesChanged", "  that drew a change", 0],
  ["taskMs", "main thread in tasks, ms", 1],
  ["scriptMs", "  script, ms", 1],
  ["styleMs", "  style, ms", 1],
  ["layoutMs", "  layout, ms", 1],
]
const TRACE_ROWS = [
  ["compositorFrames", "traced: frames the compositor was offered", 0],
  ["compositorPresented", "  presented", 0],
  ["compositorDropped", "  dropped", 0],
  ["compositorNoUpdate", "  nothing to update", 0],
  ["drawFrames", "traced: frames the compositor drew", 0],
  ["paints", "traced: main-thread paints", 0],
  ["paintMs", "  their time, ms", 1],
  ["tracedStyleMs", "traced: style, ms", 1],
  ["tracedLayoutMs", "traced: layout, ms", 1],
]

async function bench() {
  const { app, BrowserWindow, contentTracing } = await import("electron")
  const settings = JSON.parse(process.env.MAKO_BENCH_WINDOW)
  app.setPath("userData", join(settings.root, "profile"))
  app.dock?.hide()
  app.on("window-all-closed", () => undefined)
  await app.whenReady()
  const recording = JSON.parse(await readFile(settings.recording, "utf8"))
  const startable = recording.turns.filter((turn) => turn.snapshot && (!settings.scenario || turn.scenario === settings.scenario))
  const turn = startable.find((each) => each.scenario === "warm") ?? startable[0]
  assert.ok(turn, `${settings.recording} holds no turn${settings.scenario ? ` of scenario ${settings.scenario}` : ""} with a snapshot to start from (a cold turn has none: record with --scenarios cold,warm)`)
  const events = turn.lines.map((line) => JSON.parse(line.payload))
  const lastRevision = Math.max(...events.flatMap((event) => (event.type === "live-batch" ? [event.batch.revision] : [])))
  const errors = []

  async function replay(variant, trace) {
    const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
    const page = window.webContents
    page.on("console-message", (event) => { if (event.level === "error") errors.push(event.message) })
    const evaluate = (code) => page.executeJavaScript(code)
    const watchdog = setTimeout(() => {
      console.error(`A replay passed its limit (${variant.name})`)
      app.exit(1)
    }, (turn.lines.at(-1).at - turn.lines[0].at) + 120_000)
    try {
      await window.loadURL(settings.url)
      const deadline = Date.now() + 120_000
      while (!(await evaluate("Boolean(window.benchWindow)"))) {
        assert.ok(Date.now() < deadline, "the bench page loaded")
        await new Promise((done) => setTimeout(done, 50))
      }
      const opened = await evaluate(`window.benchWindow.prepare(${JSON.stringify({ snapshot: turn.snapshot, lines: turn.lines, turns: settings.turns, ahead: variant.ahead })})`)
      page.debugger.attach("1.3")
      const send = (method, params) => page.debugger.sendCommand(method, params)
      await send("Performance.enable")
      const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((each) => [each.name, each.value]))
      if (trace) await contentTracing.startRecording({ included_categories: ["blink.user_timing", "benchmark", "devtools.timeline", "disabled-by-default-devtools.timeline.frame"], excluded_categories: ["*"] })
      const before = await metrics()
      const raw = await evaluate("window.benchWindow.stream()")
      const after = await metrics()
      const compositor = trace ? traced(JSON.parse(await readFile(await contentTracing.stopRecording(join(settings.root, `${variant.name}.trace.json`)), "utf8")).traceEvents) : {}
      const script = Object.fromEntries(["TaskDuration", "ScriptDuration", "RecalcStyleDuration", "LayoutDuration"].map((name) => [name, (after[name] - before[name]) * 1000]))
      assert.equal(raw.rereads, 0, `${variant.label}: the window read the conversation again ${raw.rereads} times, so a line didn't apply as it was sent; the first: ${raw.firstReread}`)
      assert.equal(raw.revision, lastRevision, `${variant.label}: the replay ended on revision ${raw.revision}, the recording on ${lastRevision}`)
      assert.equal(raw.characters, recording.characters, `${variant.label}: the transcript holds ${raw.characters} characters of the answer, the recording says ${recording.characters}`)
      return { opened, raw, summary: { ...summarize(raw, script), ...compositor } }
    } finally {
      clearTimeout(watchdog)
      window.destroy()
    }
  }

  const replays = { recorded: [], batches: [] }
  const traces = {}
  for (let run = 0; run < settings.runs; run += 1) {
    for (const variant of run % 2 ? VARIANTS.toReversed() : VARIANTS) {
      replays[variant.name].push(await replay(variant, false))
      console.error(`  replay ${run + 1}/${settings.runs} ${variant.label}`)
    }
  }
  if (settings.trace) for (const variant of VARIANTS) traces[variant.name] = (await replay(variant, true)).summary

  const told = replays.recorded[0].raw.arrivals.filter((arrival) => arrival.text && arrival.last !== null && arrival.segment > 0)
  for (const variant of VARIANTS) for (const each of replays[variant.name]) {
    const waits = shownWaits(told, each.raw.ticks)
    Object.assign(each.summary, { shownPoints: waits?.length })
    if (waits) Object.assign(each.summary, spread("shown", waits))
  }

  const fixed = (value, digits) => (value === undefined || value === null || Number.isNaN(value) ? "-" : value.toFixed(digits))
  const cell = (name, key, digits) => {
    const values = replays[name].map((each) => each.summary[key]).filter((value) => value !== undefined && value !== null)
    return `${fixed(median(values), digits).padStart(9)} ${`[${fixed(values.length ? Math.min(...values) : undefined, digits)}..${fixed(most(values), digits)}]`.padEnd(20)}`
  }
  const first = replays.recorded[0]
  console.log(`bench:window ${basename(settings.recording)}: ${recording.harness}, ${recording.answer} answer of ${recording.characters} characters, its ${turn.scenario} turn (run ${turn.run}), ${turn.lines.length} lines over ${Math.round(turn.lines.at(-1).at - turn.lines[0].at)} ms`)
  console.log(`  ${settings.turns} earlier turns made up; the transcript holds ${first.raw.rows || first.raw.mountedTurns} turns, ${first.raw.mountedTurns} mounted, ${first.raw.domNodes} nodes, ${first.raw.blocks} blocks; React's ${settings.react} build; Electron ${process.versions.electron} (Chromium ${process.versions.chrome}), hidden window`)
  console.log(`  ${settings.runs} replays each way, alternating: the median, then [least..most]`)
  console.log(`  ${"".padEnd(68)}${VARIANTS.map((variant) => variant.label.padEnd(31)).join("")}`)
  for (const [key, label, digits] of ROWS) console.log(`  ${label.padEnd(68)}${VARIANTS.map((variant) => cell(variant.name, key, digits)).join(" ")}`)
  if (settings.trace) {
    console.log(`  one traced replay each way (tracing costs time, so its numbers stand apart from the rows above):`)
    for (const [key, label, digits] of TRACE_ROWS) console.log(`  ${label.padEnd(68)}${VARIANTS.map((variant) => fixed(traces[variant.name][key], digits).padStart(9).padEnd(30)).join(" ")}`)
  }
  if (errors.length) console.log(`  the page logged ${errors.length} errors, the first: ${errors[0].slice(0, 300)}`)
  if (settings.json) {
    await writeFile(settings.json, `${JSON.stringify({
      recording: basename(settings.recording), harness: recording.harness, answer: recording.answer, characters: recording.characters, scenario: turn.scenario, run: turn.run,
      lines: turn.lines.length, turns: settings.turns, runs: settings.runs, react: settings.react, electron: process.versions.electron, chromium: process.versions.chrome,
      summaries: Object.fromEntries(VARIANTS.map((variant) => [variant.name, replays[variant.name].map((each) => each.summary)])),
      traced: traces,
      replays: Object.fromEntries(VARIANTS.map((variant) => [variant.name, replays[variant.name].map((each) => each.raw)])),
      errors,
    })}\n`)
    console.log(`  every line, frame and long task: ${settings.json}`)
  }
  app.exit(0)
}
