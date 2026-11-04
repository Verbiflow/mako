import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/*
 * What an Apex row's pips cost: the desk on the mock bridge with 50, then 500 more Apexes of twenty Fins each
 * (`?mock&app=apex&apexes=N`), its rail as the app draws it.
 *
 * - Churn: `window.apexScene.churn(20, 100)` moves one of "Mobile polish"'s twenty Fins every 100 ms, as its host's
 *   batches would. Over five seconds it counts React's commits and which components rendered in them (a stand-in for
 *   the devtools hook walks each commit's fibers), so a Fin's move costs its Apex's row (`ApexCrewLine`, `ApexAsks`),
 *   never the rail (`AgentThreads`) or another row (`ThreadRow`, `LiveAgentRow`).
 * - Still: no churn, five seconds of the waves moving, against the same desk with them paused, from the renderer's
 *   own counters (`Performance.getMetrics`: style recalculations, layouts): the waves add no style or layout per frame.
 *
 * `--url <base>` uses a running Vite server instead of starting one.
 */

const WATCH_MS = 5_000
const EVERY_MS = 100

if (process.versions.electron) {
  void bench().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = await mkdtemp(join(tmpdir(), "mako-fin-pips-bench-"))
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { createServer } = await import("vite")
    server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fin-pips-bench", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_BENCH_ROOT: root, MAKO_BENCH_URL: base }
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

/** React's commits, and the components each one rendered by name, read off its fibers (`PerformedWork`). */
const COMMIT_COUNTER = `
  const PERFORMED = 1
  const began = new WeakMap()
  const nameOf = (type) => (typeof type === "function" ? type.displayName || type.name : type && typeof type === "object" ? type.displayName || nameOf(type.type) || nameOf(type.render) : undefined)
  window.__bench = { commits: 0, components: {} }
  const walk = (fiber) => {
    for (; fiber; fiber = fiber.sibling) {
      if (typeof fiber.type !== "string" && fiber.flags & PERFORMED && began.get(fiber) !== fiber.actualStartTime) {
        const name = nameOf(fiber.type)
        if (name) window.__bench.components[name] = (window.__bench.components[name] ?? 0) + 1
      }
      began.set(fiber, fiber.actualStartTime)
      walk(fiber.child)
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_, root) { window.__bench.commits++; walk(root.current) },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }
`

const WAVES = `document.getAnimations().filter((animation) => animation.effect?.target?.classList?.contains("fin-pips-veil"))`

async function bench() {
  const { app, BrowserWindow } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_BENCH_ROOT, "profile"))
  await app.whenReady()
  const base = process.env.MAKO_BENCH_URL.replace(/\/$/, "")
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  await window.loadURL("about:blank")
  page.debugger.attach("1.3")
  const send = (method, params) => page.debugger.sendCommand(method, params)
  await send("Page.enable")
  await send("Page.addScriptToEvaluateOnNewDocument", { source: COMMIT_COUNTER })
  await send("Performance.enable", { timeDomain: "threadTicks" })
  const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]))
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const evaluate = (code) => page.executeJavaScript(code)
  const results = []
  for (const apexes of [50, 500]) {
    await window.loadURL(`${base}/?mock&app=apex&apexes=${apexes}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
    const deadline = Date.now() + 60_000
    while (!(await evaluate("document.querySelectorAll('[data-apex-row]').length > 3").catch(() => false))) {
      if (Date.now() > deadline) throw new Error("the rail's Apex rows never drew")
      await wait(100)
    }
    await wait(3_000)
    const rail = await evaluate(`({ apexRows: document.querySelectorAll('[data-apex-row]').length, pips: document.querySelectorAll('.fin-pip').length, asking: document.querySelectorAll('[data-asking-fin]').length, waves: ${WAVES}.length })`)

    // Moving: the waves running, no churn; then the same with them paused.
    const watch = async () => {
      const before = await metrics()
      await wait(WATCH_MS)
      const after = await metrics()
      return { styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount, layouts: after.LayoutCount - before.LayoutCount, scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000) }
    }
    const running = await evaluate(`${WAVES}.filter((animation) => animation.playState === "running").length`)
    const moving = await watch()
    await evaluate(`for (const animation of ${WAVES}) animation.pause(); 0`)
    const still = await watch()
    await evaluate(`for (const animation of ${WAVES}) animation.play(); 0`)

    // Churn: one Fin of the Apex moving every 100 ms.
    await evaluate(`window.__stopChurn = window.apexScene.churn(20, ${EVERY_MS}); 0`)
    await wait(1_500)
    await evaluate("window.__bench = { commits: 0, components: {} }; 0")
    const pipsBefore = await evaluate("document.querySelector('[data-apex-row] [data-fin-pips]')?.dataset.finPips")
    const churnBefore = await metrics()
    await wait(WATCH_MS)
    const churnAfter = await metrics()
    const tally = await evaluate("JSON.parse(JSON.stringify(window.__bench))")
    await evaluate("window.__stopChurn(); 0")
    const moves = Math.round(WATCH_MS / EVERY_MS)
    const per = (count) => Math.round(((count ?? 0) / moves) * 100) / 100
    const rendered = tally.components
    results.push({
      apexes: apexes + 1,
      ...rail,
      wavesRunning: running,
      styleRecalcsMoving: moving.styleRecalcs,
      styleRecalcsStill: still.styleRecalcs,
      layoutsMoving: moving.layouts,
      layoutsStill: still.layouts,
      finMoves: moves,
      commitsPerMove: per(tally.commits),
      apexCrewLinePerMove: per(rendered.ApexCrewLine),
      apexAsksPerMove: per(rendered.ApexAsks),
      railPerMove: per(rendered.AgentThreads),
      threadRowsPerMove: per((rendered.ThreadRow ?? 0) + (rendered.LiveAgentRow ?? 0)),
      layoutsPerMove: per(churnAfter.LayoutCount - churnBefore.LayoutCount),
      scriptMsPerMove: per(Math.round((churnAfter.ScriptDuration - churnBefore.ScriptDuration) * 1000)),
      mostRendered: Object.entries(rendered).toSorted((left, right) => right[1] - left[1]).slice(0, 8).map(([name, count]) => `${name} ${per(count)}`).join(", "),
      pipsBefore,
    })
  }
  console.table(results.map(({ mostRendered: _mostRendered, pipsBefore: _pipsBefore, ...row }) => row))
  for (const result of results) {
    console.log(`${result.apexes} Apexes, most rendered per Fin move: ${result.mostRendered}`)
    assert.ok(result.apexRows > 3 && result.pips > 0, `${result.apexes}: the rail draws Apex rows with pips`)
    assert.ok(result.waves > 0 && result.wavesRunning > 0 && result.wavesRunning < result.waves, `${result.apexes}: waves in view move and those scrolled away rest (${result.wavesRunning} of ${result.waves})`)
    // Chrome recalculates a CSS animation's style once per loop, whatever the count; per frame would be ~300 here.
    assert.ok(result.styleRecalcsMoving - result.styleRecalcsStill <= WATCH_MS / 50, `${result.apexes}: the waves add no style pass per frame (${result.styleRecalcsMoving} moving, ${result.styleRecalcsStill} still)`)
    assert.ok(result.layoutsMoving - result.layoutsStill <= 2, `${result.apexes}: the waves cause no layout (${result.layoutsMoving} moving, ${result.layoutsStill} still)`)
    assert.equal(result.railPerMove, 0, `${result.apexes}: a Fin's move never renders the rail`)
    assert.equal(result.threadRowsPerMove, 0, `${result.apexes}: a Fin's move renders no Thread row`)
    assert.ok(result.apexCrewLinePerMove > 0 && result.apexCrewLinePerMove <= 1, `${result.apexes}: a Fin's move renders its Apex's pips once at most (${result.apexCrewLinePerMove})`)
  }
  console.log(JSON.stringify(results))
  app.exit(0)
}
