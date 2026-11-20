import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A long reply streaming into the transcript's prose, and settling, holds the page no longer than its newest words do.
 * A 250 KB agent reply is mounted as streamed so far, its last 6 KB streamed in a few words at a time, then settled:
 *
 * - while it streams, no style recalculation reaches past the blocks being added: none comes near a tenth of the
 *   answer's elements. A `* + *` rule anywhere in the stylesheet once restyled the whole answer for each block added,
 *   45 ms an append at this length (`index.css`). How many blocks one recalculation takes in is how many landed
 *   between two frames, which a slower machine makes more, so the bound is the answer's size, not a count of blocks.
 * - settling parses nothing on the page longer than the answer's last piece: the whole answer is parsed in the prose
 *   worker (`useSettledProse`). Parsed on the page it held it 225 ms at 300 KB.
 * - what's drawn once the worker's tree lands is what the answer drawn anew, parsed whole on the page, draws.
 *
 * It runs as a reader asking for reduced motion (no reveal), as CI's Mac does, and as one who doesn't: the whole-answer
 * restyle showed only in the first.
 *
 * `--url <base>` uses a running Vite server instead of starting one.
 */

const NAME = "The prose settle UI check"
const CHARS = 250_000
const TAIL = 6_000
/** The share of the answer's elements a style recalculation may reach while the answer streams. */
const STREAM_RESTYLE_SHARE = 0.1

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = testScratch("mako-prose-settle-ui-")
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { createServer } = await import("vite")
    server = await createServer({
      cacheDir: join(root, "cache"),
      resolve: { alias: { "react-markdown": resolve("scripts/performance-markdown-probe.tsx") } },
      optimizeDeps: { entries: ["scripts/prose-settle-browser.tsx"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } },
      logLevel: "warn",
    })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-prose-settle-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit(NAME, code, signal)))
    })
  } finally {
    await server?.close()
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 820, height: 920, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: NAME, ms: 300_000 })
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(String(event.message ?? "").slice(0, 300))
  })
  const run = (source) => page.executeJavaScript(source)
  // The debugger answers once the window holds a page.
  await window.loadURL("about:blank")
  const debug = page.debugger
  debug.attach("1.3")
  const events = []
  let traced
  debug.on("message", (_event, method, params) => {
    if (method === "Tracing.dataCollected") events.push(...params.value)
    if (method === "Tracing.tracingComplete") traced?.()
  })
  for (const motion of ["reduce", "no-preference"]) {
    await debug.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] })
    guard.at(`loading the page (${motion})`)
    await window.loadURL(`${base}/scripts/prose-settle-browser.html`)
    for (let waited = 0; page.getTitle() !== "ready"; waited += 100) {
      assert.ok(waited < 60_000, "the page never said it was ready")
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.equal(await run("matchMedia('(prefers-reduced-motion: reduce)').matches"), motion === "reduce")
    guard.at(`mounting the answer as streamed so far (${motion})`)
    const { chars } = await run(`window.proseSettle.prepare(${CHARS}, ${TAIL})`)
    const elements = await run("document.querySelectorAll('#root *').length")

    guard.at(`streaming its last words (${motion})`)
    events.length = 0
    await debug.sendCommand("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline.invalidationTracking"] }, transferMode: "ReportEvents" })
    const { chunks } = await run("window.proseSettle.stream(40)")
    const complete = new Promise((done) => (traced = done))
    await debug.sendCommand("Tracing.end")
    await complete
    const restyles = events.filter((event) => event.name === "UpdateLayoutTree" && event.ph === "X")
    const widest = Math.max(0, ...restyles.map((event) => event.args?.elementCount ?? 0))
    const styleMs = restyles.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000
    console.log(`[${motion}] Streamed ${chunks} batches into a ${Math.round(chars / 1000)} KB answer of ${elements} elements: ${restyles.length} style recalculations, ${Math.round(styleMs)} ms, the widest ${widest} elements`)
    assert.ok(restyles.length > 0, "the trace saw the answer restyled as it grew")
    const over = restyles.filter((event) => (event.args?.elementCount ?? 0) > elements * STREAM_RESTYLE_SHARE)
    if (over.length) {
      // What asked for each recalculation that reached the answer: the invalidations since the one before it.
      const said = over.map((event) => ({ ms: Math.round(event.dur / 1000), elements: event.args?.elementCount, causes: causes(events, restyles, event) }))
      // CI uploads what's under MAKO_TEST_EVIDENCE: the whole trace, for what the causes above leave out.
      const kept = process.env.MAKO_TEST_EVIDENCE ? join(process.env.MAKO_TEST_EVIDENCE, "prose-settle") : undefined
      if (kept) {
        await mkdir(kept, { recursive: true })
        await writeFile(join(kept, `stream-trace-${motion}.json`), JSON.stringify({ traceEvents: events }))
      }
      assert.fail(`[${motion}] a block added to the answer restyled ${widest} of its ${elements} elements: the answer, not the block.${kept ? ` Trace kept in ${kept}.` : ""}\n${JSON.stringify(said, null, 1)}`)
    }

    guard.at(`settling it (${motion})`)
    const settled = await run("window.proseSettle.settle()")
    const longest = Math.max(0, ...settled.mainParses)
    console.log(`[${motion}] Settled in ${settled.syncMs.toFixed(1)} ms with ${settled.mainParses.length} parses on the page, the longest ${longest} characters`)
    assert.ok(longest < TAIL, `settling parsed ${longest} characters on the page: the whole answer, not its last piece`)

    guard.at(`drawing the worker's tree (${motion})`)
    const whole = await run("window.proseSettle.whole()")
    console.log(`[${motion}] Worker tree drawn: ${whole.byWorker}; same as the answer drawn anew: ${whole.sameAsFresh}; long tasks after settling: ${JSON.stringify(whole.longTasks.map(Math.round))}`)
    assert.ok(whole.byWorker, "the settled answer was drawn from the worker's tree")
    assert.ok(whole.sameAsFresh, `the settled answer draws what the answer drawn anew draws: ${JSON.stringify(whole.difference, null, 1)}`)
  }
  assert.deepEqual(errors, [], "the page logged no errors")
  console.log(`${NAME} passed`)
  guard.done()
  app.exit(0)
}

/** The invalidations a trace records between `restyle` and the recalculation before it, counted by what they say. */
function causes(events, restyles, restyle) {
  const previous = restyles.filter((event) => event.ts + event.dur <= restyle.ts).at(-1)
  const from = previous ? previous.ts + previous.dur : 0
  const counts = new Map()
  for (const event of events) {
    if (event.ts < from || event.ts > restyle.ts || !/InvalidationTracking$/.test(event.name) || event.name.startsWith("Layout")) continue
    const data = event.args?.data ?? {}
    const selectors = (data.selectors ?? []).map((selector) => selector.selector).join(", ")
    const key = [event.name.replace("InvalidationTracking", ""), data.reason, data.nodeName, data.changedClass, data.changedAttribute, data.changedPseudo, data.changedId, selectors].filter(Boolean).join(" | ")
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, count]) => `${count}× ${key}`)
}
