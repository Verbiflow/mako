// The computer-use driver's topology under load, measured the way the host
// composes it: its own embedded daemon under a temporary root (never the
// person's), one `DriverBroker`, the person's `Appshots` and three tasks'
// `ControlSessions`, each in a real worker process, against a fixture window
// shown without focus. It prints the first Appshot on a new daemon, a warm
// Appshot, a task's first screenshot while an Appshot runs, an Appshot while a
// task's slow call runs, a warm task screenshot, and every process on the
// driver's side with its memory, then the broker's readout.
//
//   npm run build:control-runtime && node --import tsx scripts/benchmark-control-driver.mjs [--json]
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Appshots } from "@mako/host/control/appshots"
import { CuaEmbedded } from "@mako/host/control/cua-embedded"
import { ControlSessions } from "@mako/host/control/sessions"
import { resolveExecutable } from "@mako/host/base/executable"
import { DriverBroker } from "@mako/control-runtime/host"
import { ControlWorkers, startDesktopControlSession } from "../packages/control-runtime/dist/session.js"
import { driverProcesses, driverReadout } from "./lib/driver-readout.mjs"

const root = await mkdtemp(join(tmpdir(), "mako-driver-bench-"))
const ms = (since) => Math.round(performance.now() - since)
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const main = join(root, "fixture.cjs")
await writeFile(
  main,
  `const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(join(root, "user-data"))});
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const window = new BrowserWindow({show:false, width:1000, height:700});
  await window.loadFile(${JSON.stringify(resolve("scripts/fixtures/appshot/window.html"))});
  window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  window.showInactive();
  console.log('ready ' + process.pid);
});
app.on('window-all-closed', () => app.quit());`
)
const fixture = spawn(resolve("node_modules/.bin/electron"), [main], { stdio: ["ignore", "pipe", "inherit"] })
const cua = new CuaEmbedded()
const results = {}
let broker
let sessions
try {
  const pid = await new Promise((done) => fixture.stdout.on("data", (chunk) => {
    const ready = /ready (\d+)/.exec(String(chunk))
    if (ready) done(Number(ready[1]))
  }))
  await new Promise((done) => setTimeout(done, 1500))
  if (!resolveExecutable("cua-driver")) throw new Error("The computer-use driver isn't installed")
  broker = new DriverBroker({ socket: () => cua.ensure(join(root, "cua"), "com.mako.driver-bench"), own: () => [pid] })
  const appshots = new Appshots({ connect: () => broker.connect({ kind: "appshots", label: "appshots" }, { parallel: true }), warm: () => broker.warm() })

  // The first Appshot on a new daemon: the chooser lists windows, then the person picks one at once.
  let since = performance.now()
  const listed = (await appshots.windows()).find((window) => window.pid === pid)
  const target = { pid, windowId: listed.windowId }
  await appshots.capture(target, listed)
  results.firstAppshotOnNewDaemonMs = ms(since)
  await broker.warm()
  const warm = []
  for (let run = 0; run < 5; run++) {
    since = performance.now()
    await appshots.capture(target, listed)
    warm.push(ms(since))
  }
  results.warmAppshotMs = { median: median(warm), runs: warm }

  // Three tasks, each a session in a worker process, as the host starts them.
  sessions = new ControlSessions(
    (binding) => broker.grant(`agent ${binding}`),
    startDesktopControlSession,
    new ControlWorkers({}),
    (binding) => broker.revoke(`agent ${binding}`)
  )
  const bindings = ["bench-1", "bench-2", "bench-3"]
  for (const binding of bindings) await sessions.start(binding)
  const window = { kind: "window", pid, window_id: target.windowId }
  const shot = (binding) => sessions.request(binding, { method: "shot", target: window, options: {} }, AbortSignal.timeout(60_000))

  // A task's first screenshot (its worker starting included) while an Appshot runs.
  const alongside = (async () => {
    const started = performance.now()
    await appshots.capture(target, listed)
    return ms(started)
  })()
  await new Promise((done) => setTimeout(done, 20))
  since = performance.now()
  await shot(bindings[0])
  results.agentFirstShotDuringAppshotMs = ms(since)
  results.appshotAlongsideAgentFirstShotMs = await alongside
  since = performance.now()
  await shot(bindings[1])
  results.agentFirstShotAloneMs = ms(since)

  // An Appshot while a task's driver call runs for 3 s (a read that waits for a predicate the page never meets).
  const slow = sessions
    .request(bindings[2], { method: "exec", source: `return await control.window({pid:${pid},window_id:${target.windowId}}).raw("verify_state", {expect:[{element:{selector:{label_contains:"never-on-this-page"},exists:true}}], timeout_ms:3000})` }, AbortSignal.timeout(60_000))
    .catch((error) => error)
  await new Promise((done) => setTimeout(done, 1500))
  since = performance.now()
  await appshots.capture(target, listed)
  results.appshotDuringAgentSlowCallMs = ms(since)
  await slow
  const warmShots = []
  for (let run = 0; run < 6; run++) {
    since = performance.now()
    await shot(bindings[run % 3])
    warmShots.push(ms(since))
  }
  results.warmAgentShotMs = { median: median(warmShots), runs: warmShots }

  const status = { ...broker.status(), host: process.pid, workers: await sessions.processes() }
  const processes = driverProcesses(status)
  results.processes = processes
  results.total = { count: processes.length - 1, rssMB: processes.filter((row) => row.role !== "host").reduce((sum, row) => sum + (row.rssMB ?? 0), 0) }
  results.proxies = execFileSync("/bin/ps", ["-axo", "ppid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes(root) && /\bmcp\b/.test(line)).length
  if (process.argv.includes("--json")) console.log(JSON.stringify({ results, status }, null, 2))
  else {
    console.log(JSON.stringify(results, null, 1))
    console.log(driverReadout(status, { recent: 10 }))
  }
} finally {
  await sessions?.close()
  await broker?.close()
  cua.stop()
  fixture.kill()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
