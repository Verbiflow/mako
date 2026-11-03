import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/*
 * What the live marks cost while they move. Two pages, each watched for five seconds once settled:
 *
 * - `scripts/live-marks.html?bench=500`: 500 rows in a 600 px scroller, eight in ten of them moving.
 * - the desk on the mock bridge with 500 more Apexes (`?mock&app=apex&apexes=500`), its rail as the app draws it,
 *   then the same desk with its marks stopped, so what else on it moves is not counted against them.
 *
 * Over the window it reads the renderer's own counters (`Performance.getMetrics`: style recalculations, layouts,
 * script and task time) and React's commits, counted by a stand-in for the devtools hook. The marks move on the
 * compositor, so moving changes none of them: the bench requires no React commit, no layout and no style pass per
 * frame, every mark scrolled away paused, and every running mark at the same point of its loop.
 * `--url <base>` uses a running Vite server instead of starting one.
 */

const WATCH_MS = 5_000

if (process.versions.electron) {
  void bench().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = await mkdtemp(join(tmpdir(), "mako-live-marks-bench-"))
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { createServer } = await import("vite")
    server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0 } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-live-marks-bench", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_BENCH_ROOT: root, MAKO_BENCH_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server?.close()
  }
}

/** Counts React's commits without devtools: React reports each one to this hook when it finds it. */
const COMMIT_COUNTER = `
  window.__benchCommits = 0
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    onScheduleFiberRoot() {},
    onCommitFiberRoot() { window.__benchCommits++ },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }
`

/** How far apart the running marks of each loop length are, as a fraction of it: on one clock, none. */
const PHASE_SPREAD = `(() => {
  const byPeriod = new Map()
  for (const animation of document.getAnimations()) {
    if (animation.playState !== "running" || !animation.effect?.target?.closest?.(".live-mark")) continue
    const period = animation.effect.getComputedTiming().duration
    const phase = (((animation.currentTime % period) + period) % period) / period
    byPeriod.set(period, [...(byPeriod.get(period) ?? []), phase])
  }
  // A loop's phases on a circle: the spread is the circle less its widest gap.
  let spread = 0
  for (const phases of byPeriod.values()) {
    const sorted = phases.sort((a, b) => a - b)
    let gap = 1 - sorted.at(-1) + sorted[0]
    for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i] - sorted[i - 1])
    spread = Math.max(spread, 1 - gap)
  }
  return spread
})()`

async function bench() {
  const { app, BrowserWindow } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_BENCH_ROOT, "profile"))
  await app.whenReady()
  const base = process.env.MAKO_BENCH_URL.replace(/\/$/, "")
  const results = []
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  await window.loadURL("about:blank")
  page.debugger.attach("1.3")
  const send = (method, params) => page.debugger.sendCommand(method, params)
  await send("Page.enable")
  await send("Page.addScriptToEvaluateOnNewDocument", { source: COMMIT_COUNTER })
  await send("Performance.enable", { timeDomain: "threadTicks" })
  for (const [name, path, still] of [
    ["500 moving marks", "/scripts/live-marks.html?bench=500"],
    ["desk, 500 more Apexes", "/?mock&app=apex&apexes=500"],
    ["same desk, marks still", "/?mock&app=apex&apexes=500", true],
  ]) {
    await window.loadURL(`${base}${path}`)
    // Settled: the page has mounted, its first data has landed, and the visibility gate has seen every mark.
    await new Promise((done) => setTimeout(done, 4_000))
    if (still) await page.executeJavaScript(`for (const animation of document.getAnimations()) if (animation.effect?.target?.closest?.(".live-mark")) animation.pause(); 0`)
    const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]))
    const before = await metrics()
    const commitsBefore = await page.executeJavaScript("window.__benchCommits")
    await new Promise((done) => setTimeout(done, WATCH_MS))
    const after = await metrics()
    const commits = (await page.executeJavaScript("window.__benchCommits")) - commitsBefore
    const marks = await page.executeJavaScript(`(() => {
      const all = [...document.querySelectorAll(".live-mark")]
      const moving = document.getAnimations().filter((animation) => animation.effect?.target?.closest?.(".live-mark"))
      return { marks: all.length, moving: moving.length, running: moving.filter((animation) => animation.playState === "running").length, paused: moving.filter((animation) => animation.playState === "paused").length }
    })()`)
    const spread = await page.executeJavaScript(PHASE_SPREAD)
    const delta = (key) => after[key] - before[key]
    const result = {
      page: name,
      marks: marks.marks,
      animations: marks.moving,
      running: marks.running,
      paused: marks.paused,
      reactCommits: commits,
      styleRecalcs: delta("RecalcStyleCount"),
      layouts: delta("LayoutCount"),
      scriptMs: Math.round(delta("ScriptDuration") * 1000),
      taskMs: Math.round(delta("TaskDuration") * 1000),
      phaseSpread: Number(spread.toFixed(3)),
    }
    results.push(result)
  }
  console.table(results)
  const [stress, desk, deskStill] = results
  assert.equal(stress.reactCommits, 0, "500 moving marks render nothing in React while they move")
  // Chrome updates style once per loop of a CSS animation, whatever the count; per frame would be 300 to 600 here.
  assert.ok(stress.styleRecalcs <= WATCH_MS / 50, `moving marks cause no style pass per frame (${stress.styleRecalcs} in ${WATCH_MS} ms)`)
  assert.ok(stress.layouts <= 2, `moving marks cause no layout (${stress.layouts} in ${WATCH_MS} ms)`)
  assert.ok(stress.paused > 0 && stress.running > 0, "marks scrolled away rest while those in view move")
  assert.ok(stress.running < stress.animations / 4, `only the marks in view move (${stress.running} of ${stress.animations})`)
  for (const result of results) assert.ok(result.phaseSpread < 0.02, `${result.page}: every running mark of one loop is at one point of it (spread ${result.phaseSpread})`)
  assert.ok(desk.marks > 0, "the desk draws its rail's marks")
  assert.equal(desk.reactCommits, 0, "the desk's moving marks render nothing in React")
  assert.ok(desk.styleRecalcs - deskStill.styleRecalcs <= WATCH_MS / 50, `the desk's marks add no style pass per frame (${desk.styleRecalcs} moving, ${deskStill.styleRecalcs} still)`)
  console.log(JSON.stringify(results))
  const { app: electron } = await import("electron")
  electron.exit(0)
}
