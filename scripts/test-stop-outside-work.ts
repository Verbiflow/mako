import { mkdir, readFile, writeFile } from "node:fs/promises"
import { spawn as handoff } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { CuaDriverVersions } from "@mako/host/control/cua-driver-version"
import { testScratch } from "./lib/test-scratch.mjs"
import { hostCommand, hostExecFile, hostSpawn, hostFork } from "@mako/host/base/host-command"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { z } from "zod"
import { setImmediate as turn } from "node:timers/promises"
import { createServer } from "node:http"
import { HostStopping, HostStoppingError, hostFetch } from "@mako/host/base/host-stopping"
import { HostCallLifetime } from "@mako/host/transport/call-lifetime"
import { CursorSdkAuth, type CursorSdkProbeClient } from "@mako/host/harnesses/cursor/sdk/auth"
import { CursorCredentialStore } from "@mako/host/harnesses/cursor/sdk/credentials"
import { memorySecrets } from "@mako/host/base/secrets"
import { AccountLogins } from "@mako/host/harnesses/account-login"
import { HostJobs } from "@mako/host/base/host-jobs"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { spawnProviderProcess } from "@mako/host/harnesses/provider-process"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { AppKeySchema } from "@mako/host/contracts/thread-environments"
import { spawn as controlSpawn, fork as controlFork, command as controlCommand } from "@mako/control-runtime/processes"
import { fork as sessionFork } from "@mako/sessions/processes"
import type { SdkMethod, SdkResult } from "@mako/host/harnesses/cursor/sdk/wire"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

// Review control 1: the driver's borrowed check and Settings' joined check
// both end, without closing the session-owned client or recording a late answer.
for (const apiKey of [undefined, "fixture-key"]) {
  const asked = deferred<void>(), reply = deferred<unknown>()
  let closes = 0, changes = 0
  const client: CursorSdkProbeClient = {
    hello: async () => { throw new Error("A borrowed client already said hello") },
    request: async <Method extends SdkMethod>(_method: Method): Promise<SdkResult<Method>> => {
      asked.resolve()
      // SAFETY: this stand-in's only callers are authStatus and me; each reply below matches that request.
      return await reply.promise as SdkResult<Method>
    },
    close: async () => { closes++ },
  }
  const stopping = new HostStopping(), calls = new HostCallLifetime(stopping)
  const auth = new CursorSdkAuth({ env: async () => apiKey ? { CURSOR_API_KEY: apiKey } : {}, cliKey: async () => null, openUrl: async () => {}, credentials: new CursorCredentialStore(memorySecrets({ durable: false })) })
  auth.onChange(() => { changes++ })
  stopping.register("connection checks", () => auth.stop())
  const driver = calls.run(() => auth.status(false, { client, apiKey }))
  const driverEnded = assert.rejects(driver, HostStoppingError)
  await asked.promise
  const settings = calls.run(() => auth.status(true))
  const settingsEnded = assert.rejects(settings, HostStoppingError)
  await turn()
  const drained = calls.close()
  await stopping.stop()
  await Promise.all([driverEnded, settingsEnded, drained])
  assert.equal(closes, 0, "cancelling a borrowed request never closes another owner's client")
  assert.equal(changes, 0)
  reply.resolve(apiKey ? { apiKeyName: "fixture" } : { status: "logged-out" })
  await turn()
  assert.equal(changes, 0, "a late reply cannot change verified authentication state")
  await assert.rejects(auth.status(true), HostStoppingError)
}
console.log("borrowed Cursor checks and joined Settings calls settle before the drain, without taking the client's ownership")

// Review control 2: a real login child and its HostCallLifetime waiter.
const jobs = new HostJobs(), discovery = new DiscoveryProcesses()
const stopping = new HostStopping(), calls = new HostCallLifetime(stopping)
let discarded = 0
const logins = new AccountLogins({
  label: () => "Fixture",
  prepareLogin: async () => ({ launch: { kind: "command", executable: process.execPath, args: ["-e", 'process.stdout.write("https://example.com/sign-in\\n"); process.stdin.resume(); setInterval(() => {}, 1000)'], env: { PATH: process.env.PATH } } }),
  discardLogin: async () => { discarded++ }, loginLanded: async () => false,
  finishLogin: async () => { throw new Error("The child never signed in") },
}, jobs)
stopping.register("account sign-ins", () => logins.stop())
stopping.register("provider discovery", () => discovery.stop())
const login = await stopping.run(() => logins.start("claude"))
const waiter = calls.run(() => logins.wait(login.id))
const ended = assert.rejects(waiter, /Mako quit before sign-in finished; sign in again/)
await turn()
const drain = calls.close()
jobs.stop()
await stopping.stop()
await Promise.all([ended, drain])
assert.equal(discarded, 1)
await assert.rejects(logins.start("claude"), /Mako quit before sign-in finished/)
assert.equal(stopping.stop(), stopping.stop(), "stops join one cancellation")
console.log("a pending account-login child ends and its caller gets the quit explanation before host calls drain")

// Preparation straddling stop cannot launch a child afterward.
const preparing = deferred<void>(), prepared = deferred<void>()
const pending = new AccountLogins({
  label: () => "Fixture", prepareLogin: async () => { preparing.resolve(); await prepared.promise; return { launch: { kind: "task", run: async () => { throw new Error("must not launch") } } } },
  discardLogin: async () => {}, loginLanded: async () => false,
  finishLogin: async () => { throw new Error("must not finish") },
}, new HostJobs())
const start = assert.rejects(pending.start("claude"), /Mako quit before sign-in finished/)
await preparing.promise
const stop = pending.stop()
prepared.resolve()
await Promise.all([start, stop])

// A completed, saved result is kept when the host stops.
let removed = 0
const saved = new AccountLogins({
  label: () => "Fixture", prepareLogin: async () => ({ launch: { kind: "task", run: async (events) => { events.page("https://example.com/sign-in") } } }),
  discardLogin: async () => { removed++ }, loginLanded: async () => true,
  finishLogin: async () => ({ status: "added", name: "saved" }),
}, new HostJobs())
const complete = await saved.start("claude")
assert.deepEqual(await saved.wait(complete.id), { status: "added", name: "saved" })
await saved.stop()
assert.deepEqual(await saved.wait(complete.id), { status: "added", name: "saved" })
assert.equal(removed, 0)

// Commands really end, including a child that ignores SIGTERM; a second host is independent.
const commands = new HostStopping(), otherHost = new HostStopping()
const commandCalls = new HostCallLifetime(commands)
let commandPid: number | undefined
const ready = deferred<void>()
const running = commandCalls.run(async () => {
  const command = hostCommand(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'])
  commandPid = command.child.pid
  command.child.stdout?.once("data", () => ready.resolve())
  return command
})
const commandEnded = assert.rejects(running, HostStoppingError)
await ready.promise
const commandDrain = commandCalls.close()
await commands.stop()
await Promise.all([commandEnded, commandDrain])
const endedPid = commandPid
assert.ok(endedPid)
assert.throws(() => process.kill(endedPid, 0), { code: "ESRCH" })
assert.equal(otherHost.signal.aborted, false)
assert.equal((await otherHost.run(() => hostCommand(process.execPath, ["-e", 'process.stdout.write("other host")']))).stdout, "other host")
await otherHost.stop()
const git = new Git({ signal: commands.signal })
await assert.rejects(git.run({ cwd: process.cwd(), args: ["--version"] }), HostStoppingError)
await git.close()
console.log("commands are reaped before drain, new Git commands are refused, and another host remains independent")

// Streaming, callback and IPC starts use the same scope, preserving their Node child handles.
const runnerFolder = testScratch("mako-child-runners-")
const runnerEntry = join(runnerFolder, "child with spaces.cjs")
assert.deepEqual(await hostCommand(process.execPath, ["-e", 'process.stdout.write(process.argv[1]); process.stderr.write("diagnostic")', "a spaced λ argument"], { cwd: runnerFolder }), { stdout: "a spaced λ argument", stderr: "diagnostic" })
await new Promise<void>((resolve, reject) => hostExecFile(process.execPath, ["-e", 'process.stdout.write("partial"); process.stderr.write("why"); process.exitCode = 7'], {}, (error, stdout, stderr) => {
  try { assert.equal(error?.code, 7); assert.equal(stdout, "partial"); assert.equal(stderr, "why"); resolve() } catch (error) { reject(error) }
}))
await assert.rejects(hostCommand(join(runnerFolder, "missing-executable"), []), { code: "ENOENT" })
await assert.rejects(hostCommand(process.execPath, ["-e", 'process.stdout.write("too much output")'], { maxBuffer: 4 }), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "too " })
await assert.rejects(hostCommand(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeout: 200 }), { killed: true })
const abort = new AbortController(), abortReady = deferred<void>()
const aborted = hostCommand(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], { signal: abort.signal })
aborted.child.stdout?.once("data", () => abortReady.resolve())
const abortResult = assert.rejects(aborted, { name: "AbortError", code: "ABORT_ERR" })
await abortReady.promise
abort.abort()
await abortResult
assert.ok(aborted.child.pid)
assert.throws(() => process.kill(aborted.child.pid!, 0), { code: "ESRCH" })
await writeFile(runnerEntry, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)')
for (const kind of ["spawn", "fork", "callback"] as const) {
  const scope = new HostStopping(), calls = new HostCallLifetime(scope), ready = join(runnerFolder, kind)
  const child = scope.run(() => kind === "spawn"
    ? hostSpawn(process.execPath, [runnerEntry, ready], { stdio: ["ignore", "pipe", "pipe"] })
    : kind === "fork"
      ? hostFork(runnerEntry, [ready], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
      : hostExecFile(process.execPath, [runnerEntry, ready], {}, () => {}))
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const work = assert.rejects(calls.run(() => exited), HostStoppingError)
  for (const deadline = Date.now() + 5_000; ; await delay(10)) {
    if (await readFile(ready, "utf8").catch(() => undefined)) break
    assert.ok(Date.now() < deadline, `${kind} child started`)
  }
  const pid = child.pid
  assert.ok(pid)
  const drained = calls.close()
  await scope.stop()
  await Promise.all([work, drained])
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
}
console.log("streaming, callback and IPC child runners are cancelled and reaped before calls drain")

// A parent's exit or closed pipes cannot release its owned descendants. A raw,
// deliberate handoff in the same ambient scope has an independent lifetime.
const treeEntry = join(runnerFolder, "parent with descendants.cjs")
await writeFile(treeEntry, `
const {spawn} = require("node:child_process")
require("node:fs").writeFileSync(process.argv[2] + ".parent", String(process.pid))
const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', process.argv[2]], {stdio: ["ignore", "inherit", "inherit"]})
if (process.argv[3] === "exit") {
  const ready = setInterval(() => {
    if (require("node:fs").existsSync(process.argv[2])) { clearInterval(ready); process.exit(0) }
  }, 10)
}
setInterval(() => {}, 1000)
`)
for (const kind of ["command", "callback", "spawn", "fork", "provider", "control-command", "control-spawn", "control-fork", "session-fork"] as const) {
  for (const parent of ["running", "exit"] as const) {
    const scope = new HostStopping(), ready = join(runnerFolder, `tree-${kind}-${parent}`)
    const kept = scope.run(() => handoff(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }))
    const keptClosed = new Promise<void>((resolve) => kept.once("close", () => resolve()))
    let child: ReturnType<typeof hostSpawn> | undefined
    try {
      child = scope.run(() => {
        if (kind === "command" || kind === "control-command") {
          const result = (kind === "command" ? hostCommand : controlCommand)(process.execPath, [treeEntry, ready, parent])
          void result.catch(() => {})
          return result.child
        }
        if (kind === "callback") return hostExecFile(process.execPath, [treeEntry, ready, parent], {}, () => {})
        if (kind === "provider") return spawnProviderProcess(process.execPath, [treeEntry, ready, parent], {})
        if (kind === "control-spawn") return controlSpawn(process.execPath, [treeEntry, ready, parent], { stdio: ["ignore", "pipe", "pipe"] })
        if (kind === "control-fork" || kind === "session-fork") return (kind === "control-fork" ? controlFork : sessionFork)(treeEntry, [ready, parent], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
        if (kind === "fork") return hostFork(treeEntry, [ready, parent], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
        return hostSpawn(process.execPath, [treeEntry, ready, parent], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
      })
      for (const deadline = Date.now() + 5_000; ; await delay(10)) {
        if (await readFile(ready, "utf8").catch(() => undefined)) break
        assert.ok(Date.now() < deadline, `${kind} grandchild started`)
      }
      const grandchild = Number(await readFile(ready, "utf8"))
      if (parent === "exit") await delay(100)
      await scope.stop()
      for (const pid of [child.pid, grandchild]) {
        assert.ok(pid)
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${kind}: ${parent} parent and its SIGTERM-ignoring descendant are gone when stop returns`)
      }
      assert.ok(kept.pid)
      assert.doesNotThrow(() => process.kill(kept.pid!, 0), "the named handoff survives the host stop")
    } finally {
      if (child?.pid) try { process.kill(-child.pid, "SIGKILL") } catch { /* already reaped */ }
      if (kept.pid) process.kill(-kept.pid, "SIGKILL")
      await keptClosed
    }
  }
}
console.log("host, provider, control-runtime and sessions runners reap SIGTERM-ignoring descendants, including after parent exit; deliberate handoffs survive")

// The actual app handoff and readiness shell: stop the pending readiness tree,
// keep the persisted app running, and never schedule another readiness try.
const appScope = new HostStopping(), app = AppKeySchema.parse(randomUUID())
const processes = new ThreadProcesses({ root: join(runnerFolder, "persisted"), listening: async () => false, containers: async () => undefined, stopGraceMs: 100 })
const appReady = join(runnerFolder, "persisted-app"), probeReady = join(runnerFolder, "readiness-tree"), appEntry = join(runnerFolder, "app.cjs")
await writeFile(appEntry, `require("node:fs").writeFileSync(${JSON.stringify(appReady)}, String(process.pid)); setInterval(() => {}, 1000)`)
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
try {
  await appScope.run(() => processes.start(app, [{ kind: "process", name: "app", command: `exec ${quote(process.execPath)} ${quote(appEntry)}`, ready: `exec ${quote(process.execPath)} ${quote(treeEntry)} ${quote(probeReady)}`, cwd: runnerFolder, env: process.env }]))
  for (const deadline = Date.now() + 5_000; ; await delay(10)) {
    if (await readFile(probeReady, "utf8").catch(() => undefined)) break
    assert.ok(Date.now() < deadline, "the actual readiness descendant started")
  }
  const appPid = Number(await readFile(appReady, "utf8"))
  const probePid = Number(await readFile(`${probeReady}.parent`, "utf8")), probeChild = Number(await readFile(probeReady, "utf8"))
  await appScope.stop()
  for (const pid of [probePid, probeChild]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  assert.doesNotThrow(() => process.kill(appPid, 0), "the real persisted app survives stop")
  await delay(600)
  assert.equal(Number(await readFile(probeReady, "utf8")), probeChild, "readiness never retries after host stop")
} finally { await processes.stop(app) }
console.log("the real readiness process tree is reaped without stopping its persisted app or retrying after host stop")

// A signal that did nothing is not successful cleanup: the process-table
// check must keep the stop open and eventually reject, rather than close pipes.
const deniedScope = new HostStopping(), deniedReady = join(runnerFolder, "denied")
const deniedChild = deniedScope.run(() => hostSpawn(process.execPath, [runnerEntry, deniedReady], { stdio: "ignore" }))
const deniedClosed = new Promise<void>((resolve) => deniedChild.once("close", () => resolve()))
for (const deadline = Date.now() + 5_000; ; await delay(10)) {
  if (await readFile(deniedReady, "utf8").catch(() => undefined)) break
  assert.ok(Date.now() < deadline, "the denied-stop child started")
}
const realKill = process.kill, deniedPid = deniedChild.pid
assert.ok(deniedPid)
process.kill = (pid, signal) => pid === -deniedPid && signal !== 0 ? true : realKill(pid, signal)
try { await assert.rejects(deniedScope.stop(), /Outside work did not stop cleanly/) }
finally { process.kill = realKill; process.kill(-deniedPid, "SIGKILL"); await deniedClosed }
console.log("stop rejects when an owned process group remains alive after its signals")

// Review control: the actual CUA version and updater runners, with no injected command stub.
const cuaFolder = testScratch("mako-cua-stop-")
for (const phase of ["version", "update"] as const) {
  const folder = join(cuaFolder, phase)
  await mkdir(folder)
  const executable = join(folder, "cua-driver"), readyFile = join(folder, "ready")
  await writeFile(executable, `#!${process.execPath}
import {writeFileSync} from "node:fs"
if (${JSON.stringify(phase)} === "update" && process.argv.includes("--version")) {
  process.stdout.write("cua-driver 0.28.0\\n")
} else {
  writeFileSync(${JSON.stringify(readyFile)}, String(process.pid))
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1_000)
}
`, { mode: 0o700 })
  const scope = new HostStopping(), lifetime = new HostCallLifetime(scope), versions = new CuaDriverVersions()
  const work = lifetime.run(async () => {
    if (phase === "version") await versions.status(executable)
    else await versions.update(executable)
  })
  const ended = assert.rejects(work, HostStoppingError)
  let pid: number | undefined
  for (const deadline = Date.now() + 5_000; ; await delay(10)) {
    const text = await readFile(readyFile, "utf8").catch(() => undefined)
    if (text) { pid = Number(text); break }
    assert.ok(Date.now() < deadline, `CUA ${phase} child started`)
  }
  const childPid = pid
  assert.ok(childPid)
  const drained = lifetime.close()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    // The stop must finish before either command's own multi-second timeout.
    await Promise.race([Promise.all([scope.stop(), ended, drained]), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error(`CUA ${phase} held stop`)), 5_000) })])
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, `CUA ${phase} child is reaped`)
  } finally {
    clearTimeout(deadline)
    try { process.kill(childPid, "SIGKILL") } catch { /* Already gone. */ }
    await work.catch(() => {})
  }
}
console.log("CUA's real version and updater commands end before the call drain, with no surviving child")

// A network body that never ends is aborted, not merely raced and abandoned.
const headers = deferred<void>(), disconnected = deferred<void>()
const server = createServer((request, response) => {
  response.writeHead(200).write("waiting")
  request.on("close", () => disconnected.resolve())
})
// The installed updater and CI don't inherit the Thread's environment.
const listenPort = process.env.MAKO_THREAD_PORT ? Number(process.env.MAKO_THREAD_PORT) + 2 : 0
await new Promise<void>((resolve) => server.listen(listenPort, "127.0.0.1", resolve))
try {
  const network = new HostStopping(), lifetime = new HostCallLifetime(network)
  const { port } = z.object({ port: z.number().int().positive() }).parse(server.address())
  const body = lifetime.run(async () => { const response = await hostFetch(`http://127.0.0.1:${port}`); headers.resolve(); return response.text() })
  const interrupted = assert.rejects(body, HostStoppingError)
  await headers.promise
  const drained = lifetime.close()
  await network.stop()
  await Promise.all([interrupted, drained, disconnected.promise])
  await assert.rejects(network.run(() => hostFetch(`http://127.0.0.1:${port}`)), HostStoppingError)
} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
console.log("outside HTTP work aborts through body consumption; new work is refused")
