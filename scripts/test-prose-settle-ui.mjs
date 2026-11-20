import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A long reply streaming into the transcript's prose, and settling, holds the page no longer than its newest words do.
 * A 250 KB agent reply is mounted as streamed so far, its last 6 KB streamed in a few words at a time, then settled:
 *
 * - while it streams, no style recalculation reaches past the blocks being added. A `.mako-prose > * + *` rule once
 *   restyled the whole answer for each block added, 45 ms an append at this length (`index.css`).
 * - settling parses nothing on the page longer than the answer's last piece: the whole answer is parsed in the prose
 *   worker (`useSettledProse`). Parsed on the page it held it 225 ms at 300 KB.
 * - what's drawn once the worker's tree lands is what the answer drawn anew, parsed whole on the page, draws.
 *
 * `--url <base>` uses a running Vite server instead of starting one.
 */

const NAME = "The prose settle UI check"
const CHARS = 250_000
const TAIL = 6_000
/** The most elements a style recalculation may reach while the answer streams: the blocks added, never the answer. */
const STREAM_RESTYLE_ELEMENTS = 1_000

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
  guard.at("loading the page")
  await window.loadURL(`${base}/scripts/prose-settle-browser.html`)
  for (let waited = 0; page.getTitle() !== "ready"; waited += 100) {
    assert.ok(waited < 60_000, "the page never said it was ready")
    await new Promise((done) => setTimeout(done, 100))
  }
  guard.at("mounting the answer as streamed so far")
  const { chars } = await run(`window.proseSettle.prepare(${CHARS}, ${TAIL})`)

  guard.at("streaming its last words")
  const debug = page.debugger
  debug.attach("1.3")
  const events = []
  let traced
  debug.on("message", (_event, method, params) => {
    if (method === "Tracing.dataCollected") events.push(...params.value)
    if (method === "Tracing.tracingComplete") traced?.()
  })
  await debug.sendCommand("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] }, transferMode: "ReportEvents" })
  const { chunks } = await run("window.proseSettle.stream(40)")
  const complete = new Promise((done) => (traced = done))
  await debug.sendCommand("Tracing.end")
  await complete
  const restyles = events.filter((event) => event.name === "UpdateLayoutTree" && event.ph === "X")
  const widest = Math.max(0, ...restyles.map((event) => event.args?.elementCount ?? 0))
  const styleMs = restyles.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000
  console.log(`Streamed ${chunks} batches into a ${Math.round(chars / 1000)} KB answer: ${restyles.length} style recalculations, ${Math.round(styleMs)} ms, the widest ${widest} elements`)
  assert.ok(restyles.length > 0, "the trace saw the answer restyled as it grew")
  assert.ok(widest <= STREAM_RESTYLE_ELEMENTS, `a block added to the answer restyled ${widest} elements: more than the block`)

  guard.at("settling it")
  const settled = await run("window.proseSettle.settle()")
  const longest = Math.max(0, ...settled.mainParses)
  console.log(`Settled in ${settled.syncMs.toFixed(1)} ms with ${settled.mainParses.length} parses on the page, the longest ${longest} characters`)
  assert.ok(longest < TAIL, `settling parsed ${longest} characters on the page: the whole answer, not its last piece`)

  guard.at("drawing the worker's tree")
  const whole = await run("window.proseSettle.whole()")
  console.log(`Worker tree drawn: ${whole.byWorker}; same as the answer drawn anew: ${whole.sameAsFresh}; long tasks after settling: ${JSON.stringify(whole.longTasks.map(Math.round))}`)
  assert.ok(whole.byWorker, "the settled answer was drawn from the worker's tree")
  assert.ok(whole.sameAsFresh, `the settled answer draws what the answer drawn anew draws: ${JSON.stringify(whole.difference, null, 1)}`)
  assert.deepEqual(errors, [], "the page logged no errors")
  console.log(`${NAME} passed`)
  guard.done()
  app.exit(0)
}
