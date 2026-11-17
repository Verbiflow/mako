import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { request } from "node:http"
import { AppSamplingDemandSchema, AppSamplingReplySchema, type AppMark, type AppSamplingDemand } from "@mako/host/contracts/thread-app"
import { ThreadAppSampler, WANTED_MS } from "@mako/host/workspaces/app-sampler"
import type { AppsLook } from "@mako/host/workspaces/environment-tools"
import { declareThreadAppMethods } from "@mako/host/workspaces/app-methods"
import { HostMethods } from "@mako/host/transport/methods"
import { startWebHost } from "@mako/host/transport/server"
import { invokeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { unwatchedWork } from "@mako/host/base/event-loop"
import type { JsonValue } from "@mako/host/contracts/json"

/**
 * The apps' marks are looked at once for every window and pushed only when they change: on 2026-11-12 the windows'
 * own looks, each reading the process table, were 17% of the person's held loop. While a window reads them the
 * sampler looks every second while an app settles, every four while one runs, every half minute with nothing running,
 * and at once after this host changed something. With nobody reading it doesn't look at all (looking for nobody took
 * main's idle host from 1.1–1.4% of a core to 3.5–4.5%), and the trace and the memory look keep their own times.
 */

let now = 0
let looks = 0
let traces = 0
let measures = 0
const pushed: AppMark[][] = []
/** What a look finds, less the signature the fake makes of it. */
type Standing = Omit<AppsLook, "signature">
let state: Standing = { marks: [{ checkout: "/work/shop", state: "running", port: 20_010 }], settling: false, alive: true }

const sampler = new ThreadAppSampler({
  look: async (): Promise<AppsLook> => {
    looks += 1
    return { ...state, signature: JSON.stringify(state) }
  },
  trace: async () => {
    traces += 1
    return 1
  },
  memory: async () => { measures += 1 },
  publish: (marks) => { pushed.push(marks) },
  now: () => now,
})

/** Ticks once a second for `seconds`, as the host's job does; `reading` has a window ask every 30 s, as windows do. */
async function run(seconds: number, reading: boolean): Promise<void> {
  for (let second = 0; second < seconds; second += 1) {
    if (reading && second % 30 === 0) sampler.wanted()
    await sampler.tick()
    now += 1_000
  }
}

// Nobody reads the apps, though one runs: no look and nothing pushed, while the trace and the memory look keep their times.
await run(120, false)
assert.equal(looks, 0, "no look with nobody reading")
assert.equal(pushed.length, 0)
assert.equal(traces, 6, "the trace every 20 seconds, as before the sampler")
assert.equal(measures, 4, "the memory look every 30 seconds, as before the sampler")
sampler.changed()
await run(5, false)
assert.equal(looks, 0, "a change here with nobody reading looks at nothing")

// A window opens: it reads the marks afresh, and from then the sampler looks for it.
assert.deepEqual(await sampler.current(), state.marks, "a window coming back reads the marks afresh")
assert.equal(looks, 1)
assert.equal(pushed.length, 1)

// Running: a look every four seconds, pushed only when something changed.
const runningLooks = looks
await run(60, true)
assert.equal(looks - runningLooks, 14, "a look every four seconds after the one just taken, while it runs and a window reads")
assert.equal(pushed.length, 1, "nothing pushed while nothing changed")

// This host starts another: the next tick looks at once and pushes it starting, then a look a second while it settles.
state = { marks: [...state.marks, { checkout: "/work/cart", state: "starting" }], settling: true, alive: true } satisfies Standing
sampler.changed()
const settlingFrom = looks
await run(5, true)
assert.equal(looks - settlingFrom, 5, "a look a second while it settles")
assert.deepEqual(pushed.at(-1), state.marks)

// Everything ends outside Mako: pushed, then one trace more closes its trace, and a look every half minute.
state = { marks: [], settling: false, alive: false } satisfies Standing
await run(5, true)
assert.deepEqual(pushed.at(-1), [], "the end is pushed")
const [endedTraces, endedLooks] = [traces, looks]
await run(60, true)
assert.ok(traces - endedTraces <= 1, "at most one trace after the last run went")
assert.equal(looks - endedLooks, 2, "a look every half minute with nothing running")

// The window closes: once its asks are older than WANTED_MS, nothing is looked at.
await run(WANTED_MS / 1000, false)
const quietLooks = looks
await run(120, false)
assert.equal(looks, quietLooks, "quiet once nobody reads")

console.log("app sampler: no look with nobody reading, the trace and memory look on their own times; while a window reads, one look for all of it, pushed only on change: a second while settling, four while running, 30 with nothing running and at once after a change here")

// A connection owns its demand without periodic data reads; old peers retain their own bounded lease.
let clock = 0
let connections = new Map([["first", randomUUID()], ["second", randomUUID()]])
let samples = 0
let marks: AppMark[] = [{ checkout: "/work/cart", state: "running" }]
const followed = new ThreadAppSampler({
  now: () => clock,
  connection: (client) => connections.get(client),
  look: async () => { samples++; return { marks, signature: JSON.stringify(marks), settling: false, alive: true } },
  publish() {},
})
const setDemand = (client: string, demand: Omit<AppSamplingDemand, "connection">) => followed.follow(client, { ...demand, connection: connections.get(client) ?? randomUUID() })
const advance = async (seconds: number) => {
  for (let i = 0; i < seconds; i++) { clock += 1_000; await followed.tick() }
}
followed.wanted("first")
assert.equal(setDemand("absent", { generation: 1, visible: true }), false)
assert.equal(setDemand("first", { generation: 1, visible: true }), true)
await followed.current("first")
await advance(180)
assert.ok(samples >= 40, "the connection is still sampled after two legacy leases, with no further reads")
assert.equal(setDemand("first", { generation: 2, visible: false }), true)
const hiddenSamples = samples
followed.wanted("first")
await followed.current("first")
await advance(180)
assert.equal(samples, hiddenSamples, "opting in replaces this reader's old lease; hidden reads cannot renew it")
assert.equal(setDemand("first", { generation: 1, visible: true }), false, "late show cannot undo hide")
assert.equal(setDemand("first", { generation: 2, visible: true }), false, "same generation cannot change its meaning")
assert.equal(setDemand("first", { generation: 2, visible: false }), true, "an identical replay is accepted")
marks = []
assert.equal(setDemand("first", { generation: 3, visible: true }), true)
assert.deepEqual(await followed.current("first"), [], "return reads afresh even though the old sample still exists")
assert.equal(setDemand("second", { generation: 1, visible: true }), true)
setDemand("first", { generation: 4, visible: false })
const sharedSamples = samples
await advance(8)
assert.ok(samples > sharedSamples, "another visible connection still owns the sampler")
connections.clear()
const disconnectedSamples = samples
await advance(180)
assert.equal(samples, disconnectedSamples, "connection loss releases demand without a final RPC")
assert.equal(setDemand("second", { generation: 2, visible: true }), false)
followed.wanted("older-peer")
await advance(4)
assert.ok(samples > disconnectedSamples, "an unopted reader keeps today's lease")
await advance(WANTED_MS / 1000)
const expiredSamples = samples
await advance(120)
assert.equal(samples, expiredSamples)

const many = Array.from({ length: 129 }, (_, i) => `window-${i}`)
connections = new Map(many.map((client) => [client, randomUUID()]))
for (const client of many.slice(0, 128)) assert.equal(setDemand(client, { generation: 0, visible: false }), true)
assert.equal(setDemand(many[128]!, { generation: 0, visible: true }), false, "demand identities are bounded")
followed.wanted("overflowing-old-peer")
const beforeOverflow = samples
await advance(4)
assert.ok(samples > beforeOverflow, "overflow retains the old bounded lease, not an omitted reader")
await advance(WANTED_MS / 1000)
const overflowSamples = samples
await advance(120)
assert.equal(samples, overflowSamples)
connections = new Map([["new-window", randomUUID()]])
assert.equal(setDemand("new-window", { generation: 0, visible: true }), true, "gone connections free the bound")
for (const invalid of [{ generation: -1, visible: true }, { generation: 1.5, visible: true }, { generation: Number.MAX_SAFE_INTEGER + 1, visible: true }, { generation: 1, visible: "true" }, { generation: 1, visible: true, client: "spoof" }])
  assert.equal(AppSamplingDemandSchema.safeParse({ connection: randomUUID(), ...invalid }).success, false)

// Real transport membership and generated argument validation, not a caller-supplied identity.
const root = mkdtempSync("/tmp/mako-app-demand-")
const socket = join(root, "host.sock")
let web: Awaited<ReturnType<typeof startWebHost>> | undefined
const stops: (() => void)[] = []
const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb() {}, declaring: async () => {}, work: unwatchedWork })
const nativeSampler = new ThreadAppSampler({ connection: (client) => web?.windowStream(client), look: async () => ({ marks: [], signature: "empty", settling: false, alive: false }), publish() {} })
declareThreadAppMethods(methods, undefined, nativeSampler)
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5_000
  while (!check()) {
    assert.ok(Date.now() < deadline, "transport condition settled")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
try {
  web = await startWebHost(socket, (channel, args, client) => methods.invoke(channel, args, client), async () => new Response(null, { status: 404 }))
  let anonymousReady = false
  let anonymousError: Error | undefined
  const anonymous = request({ socketPath: socket, path: "/events", method: "POST" }, (response) => {
    response.once("data", () => { anonymousReady = true })
    response.on("error", (error) => { if (!anonymousReady) anonymousError = error })
  })
  anonymous.on("error", (error) => { if (!anonymousReady) anonymousError = error })
  stops.push(() => anonymous.destroy())
  anonymous.end()
  await waitFor(() => anonymousReady || anonymousError !== undefined)
  assert.ifError(anonymousError)
  assert.deepEqual(await invokeRuntime(socket, "", "mako:thread-app-demand", []), { kind: "unavailable" }, "anonymous readers keep their lease, not shared persistent demand")
  anonymous.destroy()
  stops.pop()
  const client = randomUUID()
  let connection: AppSamplingDemand["connection"] = randomUUID()
  const demand = (value: Record<string, JsonValue>) => invokeRuntime(socket, client, "mako:thread-app-demand", [{ connection, ...value }])
  const bind = async () => {
    const reply = AppSamplingReplySchema.parse(await invokeRuntime(socket, client, "mako:thread-app-demand", []))
    assert.equal(reply.kind, "ready")
    if (reply.kind !== "ready") throw new Error("no connected window")
    connection = reply.connection
    return connection
  }
  assert.deepEqual(await demand({ generation: 1, visible: true }), { kind: "unavailable" }, "RPC without a window stream owns nothing")
  let ready = false
  stops.push(subscribeRuntime(socket, client, (packet) => { if (packet.channel === "ready") ready = true }, () => {}))
  await waitFor(() => ready)
  await bind()
  assert.deepEqual(await demand({ generation: 1, visible: true }), { kind: "following" })
  assert.deepEqual(await demand({ generation: 2, visible: false }), { kind: "following" })
  assert.deepEqual(await demand({ generation: 1, visible: true }), { kind: "unavailable" })
  await assert.rejects(demand({ generation: 3, visible: true, client: "spoof" }))
  await assert.rejects(demand({ generation: "3", visible: true }))
  await assert.rejects(demand({ generation: -1, visible: true }))
  await assert.rejects(demand({ generation: 1.5, visible: true }))
  await assert.rejects(demand({ generation: Number.MAX_SAFE_INTEGER + 1, visible: true }))
  const observer = randomUUID()
  ready = false
  stops.push(subscribeRuntime(socket, observer, (packet) => { if (packet.channel === "ready") ready = true }, () => {}, { observer: true }))
  await waitFor(() => ready)
  assert.deepEqual(await invokeRuntime(socket, observer, "mako:thread-app-demand", []), { kind: "unavailable" }, "an observer cannot bind demand")
  assert.deepEqual(await invokeRuntime(socket, observer, "mako:thread-app-demand", [{ connection, generation: 1, visible: true }]), { kind: "unavailable" }, "an observer cannot sustain sampling")
  const retired = connection
  ready = false
  stops.push(subscribeRuntime(socket, client, (packet) => { if (packet.channel === "ready") ready = true }, () => {}))
  await waitFor(() => ready)
  assert.notEqual(await bind(), retired, "reload gets a new incarnation even with the same window ID")
  assert.deepEqual(await demand({ generation: 0, visible: true }), { kind: "following" }, "a reloaded page may restart its counter")
  assert.deepEqual(await demand({ connection: retired, generation: 999, visible: true }), { kind: "unavailable" }, "late requests from the retired stream cannot reacquire demand")
  stops[2]!()
  await waitFor(() => web?.windowStream(`web:${client}`) === undefined)
  assert.deepEqual(await demand({ connection: retired, generation: 1_000, visible: true }), { kind: "unavailable" }, "an older surviving stream never regains authority")
  stops[0]!()
  await waitFor(() => !web?.clients().includes(`web:${client}`))
  assert.deepEqual(await demand({ generation: 3, visible: true }), { kind: "unavailable" }, "a disconnected stream cannot be revived by RPC")
} finally {
  for (const stop of stops) stop()
  web?.close()
  await waitFor(() => !existsSync(socket))
  rmSync(root, { recursive: true })
}
// With nobody reading and no app running, the sampler's job isn't needed: an idle host holds no timer for it. This host
// starting a run, or a reader asking, needs it again.
{
  let clock = 0
  let running = 0
  const needed: boolean[] = []
  const watching: boolean[] = []
  const idle = new ThreadAppSampler({
    look: async (): Promise<AppsLook> => ({ marks: [], settling: false, alive: running > 0, signature: String(running) }),
    trace: async () => running,
    memory: async () => {},
    publish: () => {},
    now: () => clock,
    needed: ({ watched, running }) => {
      needed.push(watched || running)
      watching.push(watched)
    },
  })
  await idle.tick()
  assert.equal(needed.at(-1), false, "no reader and no app running: the job isn't needed")
  running = 1
  idle.changed()
  assert.equal(needed.at(-1), true, "this host started a run: needed at once")
  clock += 20_000
  await idle.tick()
  assert.equal(needed.at(-1), true, "a run going: still needed")
  assert.equal(watching.at(-1), false, "but nobody reads, so only at the trace's times")
  running = 0
  clock += 20_000
  await idle.tick()
  assert.equal(needed.at(-1), false, "the run gone, and nobody reading: not needed")
  idle.wanted()
  assert.equal(needed.at(-1), true, "a reader asking needs it")
  clock += 1_000
  await idle.tick()
  assert.equal(needed.at(-1), true, "while it reads")
  assert.equal(watching.at(-1), true, "a second at a time while a reader watches")
  clock += 100_000
  await idle.tick()
  assert.equal(needed.at(-1), false, "its lease over, with nothing running: not needed")
  console.log("app sampler: its job is needed only while a reader watches or an app may run")
}
console.log("app sampling demand: visible connection lifetime, hidden tombstones, ordered replay, bounded legacy fallback and real socket membership/validation passed")
