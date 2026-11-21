import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { invokeRuntime, probeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"
import { helperName, hostProcesses } from "./lib/host-processes.mjs"
import { processStarts, recordProcessStarts, startsFile } from "./lib/process-starts.mjs"

/**
 * What a host keeps running, and what each process holds, as a person leaves it: started with no window, then a
 * window on a quiet project, a turn of an agent (a stand-in for Grok's CLI that streams over ACP), and the window
 * closed again. Each state is read after the helpers' idle wait (30 to 45 s), so what's listed is what stays. Memory is
 * each process's own (`scripts/lib/host-processes.mjs`): `footprint` on a Mac, PSS on Linux, the private working set
 * on Windows. Then how many processes the host starts by itself in two idle minutes, each written as it starts. Beside
 * them, what a first use after idle waits for: a call that needs the harnesses looked at, `git
 * status` with the Git helper gone, and a file's change heard through a watch just made.
 *
 *   node scripts/measure-idle-processes.mjs [--json <file>] [--quick]
 *
 * From a built checkout (`npm run build:control-runtime`). It measures and asserts nothing: `test-idle-helpers.mjs`
 * holds an idle host to no helper. `--quick` waits 5 s where it waits 75, to try the script itself.
 */
const run = promisify(execFile)
const windows = process.platform === "win32"
const repo = resolve(import.meta.dirname, "..")
const jsonAt = process.argv.indexOf("--json")
const settleMs = process.argv.includes("--quick") ? 5_000 : 75_000
const scratch = await mkdtemp(join(tmpdir(), "mako-idle-measure-"))
const dataRoot = join(scratch, "data")
const project = join(scratch, "project")
const standIn = join(scratch, "bin")
const hostCli = join(repo, "packages", "host", "dist", "mako-host.js")
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
const report = { platform: process.platform, arch: process.arch, memory: windows ? "private working set" : process.platform === "darwin" ? "footprint" : "PSS", states: [], firstUse: {} }

await Promise.all([mkdir(project, { recursive: true }), mkdir(standIn, { recursive: true })])
const agent = join(repo, "scripts", "fixtures", "acp-stream-agent.mjs")
if (windows) await writeFile(join(standIn, "grok.cmd"), `@echo off\r\n"${process.execPath}" "${join(repo, "scripts", "windows-host", "grok-stand-in.mjs")}" %*\r\n`)
else {
  await writeFile(join(standIn, "grok"), `#!/bin/sh\ncase " $* " in\n  *" --version "*) echo "grok ${GROK_VERSIONS.tested} (stand-in)"; exit 0 ;;\n  *" stdio "*) exec "${process.execPath}" "${agent}" ;;\nesac\nexit 2\n`)
  await chmod(join(standIn, "grok"), 0o755)
}
const git = (...args) => run("git", ["-c", "user.email=measure@example.invalid", "-c", "user.name=measure", ...args], { cwd: project })
await git("init", "-q", ".")
await writeFile(join(project, "a.txt"), "hello\n")
await git("add", "a.txt")
await git("commit", "-qm", "one")

// The stand-in first on a path with no other harness: this measures the host, not the CLIs a person has installed.
const env = { ...process.env, MAKO_DATA_ROOT: dataRoot, MAKO_TELEMETRY: "off", MAKO_PROD: "1", MAKO_PROOF_GROK_VERSION: GROK_VERSIONS.tested, MEASURE_STREAM_MS: "2500" }
for (const key of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "NODE_OPTIONS", "MAKO_WEB_SOCKET"]) delete env[key]
if (windows) env[pathKey] = [standIn, process.env[pathKey]].filter(Boolean).join(delimiter)
else {
  const gitAt = dirname((await run("which", ["git"])).stdout.trim())
  env[pathKey] = [...new Set([standIn, gitAt, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter)
  env.HOME = join(scratch, "home")
  await mkdir(env.HOME, { recursive: true })
}

// Every process the host and its Node children start is written as it starts (`process-starts-preload.cjs`).
const starts = startsFile(scratch)
const host = spawn(process.execPath, [hostCli], { env: { ...env, ...recordProcessStarts(starts) }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
let said = ""
host.stderr.on("data", (chunk) => { said = (said + chunk).slice(-4_000) })
const location = runtimeLocation(dataRoot)
const window = randomUUID()
const timed = async (work) => {
  const began = performance.now()
  await work()
  return Math.round(performance.now() - began)
}
const call = (channel, args, client = window) => invokeRuntime(runtimeLocation(dataRoot).socket, client, channel, args, 1, { timeoutMs: 60_000 })

/** The host's processes now, named by what each is, with what each holds. */
async function state(name) {
  const rows = (await hostProcesses(host.pid, { measured: true })).map((row) => ({
    what: row.depth === 0 ? "host" : helperName(row.command) ?? row.command.replaceAll(repo, ".").replaceAll(scratch, "<scratch>").replaceAll(dirname(process.execPath), "").slice(0, 70),
    depth: row.depth,
    mb: row.mb === undefined ? null : Math.round(row.mb * 10) / 10,
  }))
  report.states.push({ name, processes: rows })
  console.log(`\n${name}`)
  for (const row of rows) console.log(`  ${row.mb === null ? "     ?" : row.mb.toFixed(1).padStart(6)} MB  ${"  ".repeat(Math.max(0, row.depth - 1))}${row.what}`)
  console.log(`  ${rows.reduce((sum, row) => sum + (row.mb ?? 0), 0).toFixed(1).padStart(6)} MB  in ${rows.length} process${rows.length === 1 ? "" : "es"}`)
}

let failed
let unsubscribe
try {
  for (const deadline = Date.now() + 120_000; ; await delay(200)) {
    assert.ok(Date.now() < deadline, `the host's core within 120 s; it said: ${said}`)
    assert.equal(host.exitCode, null, `the host exited as it started: ${said}`)
    const probe = await probeRuntime(runtimeLocation(dataRoot).socket, { timeoutMs: 2_000 }).catch(() => undefined)
    if (probe?.state === "ready" && probe.info.domains?.find((domain) => domain.name === "core")?.state === "ready") break
  }
  console.log(`host ${host.pid} on ${process.platform} ${process.arch}; memory is each process's ${report.memory}`)

  await delay(settleMs)
  await state(`idle, no window (${settleMs / 1000} s after start)`)

  // Still nobody there: what the host starts by itself over two minutes, however briefly each runs.
  const idleFrom = Date.now()
  await delay(process.argv.includes("--quick") ? 10_000 : 120_000)
  const started = await processStarts(starts, idleFrom)
  const counts = new Map()
  for (const start of started) counts.set(start, (counts.get(start) ?? 0) + 1)
  report.idleStarts = { seconds: (Date.now() - idleFrom) / 1000, count: started.length, each: Object.fromEntries(counts) }
  console.log(`\nprocesses started in ${Math.round(report.idleStarts.seconds)} s idle with no window: ${started.length}`)
  for (const [start, count] of counts) console.log(`  ${String(count).padStart(3)} x ${start}`)

  // No window yet: a caller that must know what the harnesses' processes do, and the Git helper's first work.
  const lister = randomUUID()
  report.firstUse.threadsNoWindowMs = [await timed(() => call("mako:threads", [], lister)), await timed(() => call("mako:threads", [], lister))]

  // A window: it subscribes, opens the project, and reads its status.
  const types = []
  let heard
  unsubscribe = subscribeRuntime(runtimeLocation(dataRoot).socket, window, (packet) => {
    const type = packet.type ?? (packet.payload ? JSON.parse(packet.payload).type : undefined)
    if (type) types.push(type)
    if (type === "git" || type === "files") heard?.(type)
  }, () => undefined)
  report.firstUse.openTabMs = await timed(() => call("mako:open-tab", [{ cwd: project }]))
  report.firstUse.gitStatusMs = { helperStarted: await timed(() => call("mako:git-status", [])), next: await timed(() => call("mako:git-status", [])) }
  // A file changed in the project just opened, until the window hears of it (its Git status said again); then once more.
  await delay(2_000)
  report.firstUse.fileChangeHeardMs = []
  for (const round of [1, 2]) {
    const told = new Promise((done) => { heard = done })
    const began = performance.now()
    await appendFile(join(project, "a.txt"), `change ${round}\n`)
    const type = await Promise.race([told, delay(15_000).then(() => undefined)])
    report.firstUse.fileChangeHeardMs.push(type ? Math.round(performance.now() - began) : null)
    await delay(3_000)
  }
  heard = undefined

  await delay(settleMs)
  await state(`a quiet open project, one window (${settleMs / 1000} s quiet)`)
  // The Git helper has had its idle wait: the first status after it, and the next.
  report.firstUse.gitStatusAfterIdleMs = { first: await timed(() => call("mako:git-status", [])), next: await timed(() => call("mako:git-status", [])) }

  // One turn of an agent in the project, the window still open.
  const { stdout } = await run(process.execPath, [join(repo, "packages", "client", "dist", "cli.js"), "--json", "start", "grok", "Measure the host", "--cwd", project], { env, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 })
  const lines = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(lines.at(-1)?.status, "completed", `the stand-in's turn: ${stdout.slice(-400)}`)
  await delay(20_000)
  await state("20 s after one agent turn, the window open")

  // What follows a turn a minute on (the apps' ports looked at, fseventsd's health read) asks the probes once more:
  // read after that has had its idle wait too.
  unsubscribe()
  unsubscribe = undefined
  await delay(settleMs + 45_000)
  await state(`${(settleMs + 45_000) / 1000} s after the window closed, the conversation still open`)
  report.eventTypes = [...new Set(types)].sort()
} catch (error) {
  failed = error
} finally {
  unsubscribe?.()
  await run(process.execPath, [hostCli, "stop", "--data-root", dataRoot, "--now", "--timeout", "30"], { env, timeout: 60_000 }).catch(() => undefined)
  if (host.exitCode === null) {
    if (windows) await run("taskkill", ["/PID", String(host.pid), "/T", "/F"]).catch(() => undefined)
    else host.kill("SIGKILL")
    await Promise.race([once(host, "exit"), delay(10_000)])
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined)
  if (windows) await rm(location.directory, { recursive: true, force: true }).catch(() => undefined)
}

// A probe's first answer from a child started for it, and the next from the child then up: the wait a first look at
// the machine after idle adds. Windows runs no probe in a child.
if (!windows) {
  const { childProcessReader } = await import("@mako/host/workspaces")
  const reader = childProcessReader()
  const probe = () => reader.run("ps", ["-o", "pid=", "-p", String(process.pid)], { timeout: 10_000 })
  report.firstUse.probeMs = { childStarted: await timed(probe), next: await timed(probe) }
}
console.log(`\nfirst use, ms: ${JSON.stringify(report.firstUse)}`)
if (jsonAt > 0) {
  const file = resolve(process.argv[jsonAt + 1])
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
}
if (failed) {
  console.error(`measure-idle-processes failed: ${failed instanceof Error ? failed.stack : failed}\n${said}`)
  process.exit(1)
}
process.exit(0)
