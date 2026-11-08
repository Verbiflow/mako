import { hostCommand } from "@mako/host/base/host-command"
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
git.close()
console.log("commands are reaped before drain, new Git commands are refused, and another host remains independent")

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
