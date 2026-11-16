import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { serveRuntime } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { SessionPublisher } from "@mako/host/conversations/session-report"
import { mock } from "node:test"
import { AppKeySchema } from "@mako/host/contracts/thread-environments"
import { AppOutputHints } from "@mako/host/workspaces/app-output-hints"
import { ThreadAppSampler } from "@mako/host/workspaces/app-sampler"
import { ViewHints } from "@mako/host/workspaces/view-hints"
import type { WatchListener, WatchSubscription } from "@mako/host/workspaces/watch-backend"
import type { AppSamplingDemand } from "@mako/host/contracts/thread-app"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { DeskRefetch } from "../src/state/desk-refetch"
import { ViewRefetch } from "../src/lib/view-refetch"
import { appOutputReader } from "../src/state/thread-app-output"

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 })
const tick = async (ms: number) => { mock.timers.tick(ms); await flush(); mock.timers.tick(0); await flush() }
const app = AppKeySchema.parse(randomUUID())
let needed = true, opens = 0, closes = 0
const signals: string[][] = []
const listeners: WatchListener[] = []
const pending = Promise.withResolvers<WatchSubscription>()
const watcher = new AppOutputHints({ wanted: () => new Set(needed ? [app] : []), watch: (_app, listener) => { opens++; listeners.push(listener); return pending.promise }, changed: fields => signals.push(fields), warn: () => {}, now: Date.now })
watcher.reconcile()
await flush()
needed = false; watcher.reconcile()
needed = true; watcher.reconcile()
assert.equal(opens, 1, "a hide/return during opening cannot accumulate late subscriptions")
pending.resolve({ unsubscribe: async () => { closes++ } })
await flush()
// Its replacement uses the same injected promise, but returns a new lease after the old lease is closed.
assert.equal(closes, 1)
assert.equal(opens, 2)
assert.equal(watcher.ready(), true)
const active = listeners.at(-1)!
signals.length = 0
for (let i = 0; i < 100; i++) active.events([{ path: "/fixture/run/web.log", type: "update" }])
await tick(1_999)
assert.equal(signals.length, 0)
await tick(1)
assert.deepEqual(signals, [["output"]], "a burst has one hint, with no log path or content")
signals.length = 0
active.events([{ path: "/fixture/run/runs.json", type: "update" }])
await tick(3_000)
assert.equal(signals.length, 0, "records that are not output files do not invalidate output")
active.muted(true); assert.equal(watcher.ready(), false)
active.muted(false); assert.equal(watcher.ready(), true)
active.late?.(true); assert.equal(watcher.ready(), false)
active.late?.(false); assert.equal(watcher.ready(), true)
active.events([{ path: "/fixture/run/web.log.1", type: "create" }])
needed = false; watcher.reconcile(); await flush()
const atClose = signals.length
await tick(10_000)
assert.equal(signals.length, atClose, "last-reader close cancels queued output hints")
assert.equal(closes, 2)
listeners[0]!.events([{ path: "/fixture/old.log", type: "update" }])
await tick(2_000)
assert.equal(signals.length, atClose, "retired watcher callbacks cannot invalidate a later generation")
await watcher.close()

// A deadline releases its caller without forgetting the late subscription, and close before start opens nothing.
let lateCloses = 0
const late = Promise.withResolvers<WatchSubscription>()
const bounded = new AppOutputHints({ wanted: () => new Set([app]), watch: () => late.promise, changed: () => {}, warn: () => {} })
bounded.reconcile(); await flush()
let closed = false
const closing = bounded.close().then(() => { closed = true })
await tick(1_999); assert.equal(closed, false)
await tick(1); await closing; assert.equal(closed, true)
late.resolve({ unsubscribe: async () => { lateCloses++ } }); await flush()
assert.equal(lateCloses, 1, "a late acquired handle stays owned after the close deadline")
let obsoleteStarts = 0
const obsolete = new AppOutputHints({ wanted: () => new Set([app]), watch: async () => { obsoleteStarts++; return { unsubscribe: async () => {} } }, changed: () => {}, warn: () => {} })
obsolete.reconcile(); const neverStarted = obsolete.close(); await flush(); await neverStarted
assert.equal(obsoleteStarts, 0, "close before the opening microtask cannot start a child watch")


// Demand is a union of actual log owners, deduplicated across visible windows and generation-fenced.
const other = AppKeySchema.parse(randomUUID())
const streams = new Map([["one", randomUUID()], ["two", randomUUID()]])
const demandSampler = new ThreadAppSampler({ connection: client => streams.get(client), look: async () => ({ marks: [], signature: "", settling: false, alive: false }), publish: () => {} })
const follow = (client: string, generation: number, outputs: typeof app[], visible = true) => demandSampler.follow(client, { connection: streams.get(client)!, generation, visible, apps: false, outputs })
assert.equal(follow("one", 1, [app, app]), true)
assert.equal(follow("two", 1, [app, other]), true)
assert.deepEqual([...demandSampler.outputWanted()].sort(), [app, other].sort())
assert.equal(follow("one", 2, [], false), true)
assert.equal(follow("one", 1, [app]), false, "a late output list cannot undo a hide")
assert.deepEqual([...demandSampler.outputWanted()].sort(), [app, other].sort())
streams.delete("two")
assert.equal(demandSampler.outputWanted().size, 0, "disconnected windows retain no app watches")

// Independent app slots: changing one visible output does not retire another, and same-app readers share it.
let wanted = new Set([app])
const opened: typeof app[] = [], retired: typeof app[] = []
const grouped = new AppOutputHints({ wanted: () => wanted, watch: async app => { opened.push(app); return { unsubscribe: async () => { retired.push(app) } } }, changed: () => {}, warn: () => {} })
grouped.reconcile(); await flush()
assert.deepEqual(opened, [app])
wanted = new Set([app, other]); grouped.reconcile(); await flush()
assert.deepEqual(opened, [app, other])
grouped.reconcile(true); await flush()
assert.equal(opened.length, 2, "confirming unchanged demand opens no duplicate watches")
wanted = new Set([other]); grouped.reconcile(); await flush()
assert.deepEqual(retired, [app]); assert.equal(grouped.ready([other]), true)
wanted = new Set(); grouped.reconcile(); await grouped.close()
assert.deepEqual(retired, [app, other])

// Actual sampler -> host hints -> bridge owner -> shared reader, including compatibility and hidden/return.
interface Result { mode: string; data: number; controls: number; hidden: number }
const results: Result[] = []
for (const mode of ["poll", "hints", "no-frames", "old-host"] as const) {
  let data = 0, controls = 0, looked = 0, watched = 0, released = 0
  const connection = randomUUID(), subscribers = new Set<(event: HostEvent) => void>()
  const publisher = new ViewHints(event => { if (mode !== "no-frames") for (const subscriber of subscribers) subscriber(event) })
  let listener: WatchListener | undefined
  const sampler = new ThreadAppSampler({ connection: client => client === "window" ? connection : undefined, now: Date.now, demandChanged: () => output?.reconcile(true), look: async () => { looked++; return { marks: [], signature: "", settling: false, alive: false } }, publish: () => {} })
  const output = new AppOutputHints({ wanted: () => sampler.outputWanted(), watch: async (_app, next) => { watched++; listener = next; return { unsubscribe: async () => { released++ } } }, changed: fields => publisher.changed("output", fields), warn: () => {}, now: Date.now })
  const reads = new ViewRefetch({ now: () => Date.now(), after: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer) } })
  const owner = new DeskRefetch({ onEvent: subscriber => { subscribers.add(subscriber); return () => { subscribers.delete(subscriber) } }, viewHints: async () => ({ ...publisher.status(), domains: mode === "old-host" || mode === "poll" ? ["apps", "sync"] : ["apps", "sync", "output"] }), followThreadApps: async (demand?: AppSamplingDemand) => {
    controls++
    if (!demand) return { kind: "ready", connection, generation: sampler.generation("window") }
    if (mode === "old-host" || mode === "poll") assert.equal(demand.outputs, undefined, "older hosts receive their original exact payload")
    if (!sampler.follow("window", demand)) return { kind: "unavailable" }
    return { kind: "following", ...(demand.outputs && { outputs: output.ready(demand.outputs) }) }
  } }, reads)
  const subscribe = appOutputReader(owner, async (_cwd, _key, cursor) => { data++; return { app, text: "", cursor: cursor ?? { file: "fixture", offset: 0 }, reset: !cursor } })
  const stopOutput = subscribe("/fixture", "process:web", () => {})
  await flush()
  for (let second = 0; second < 43; second++) { await tick(1_000); await sampler.tick() }
  assert.equal(looked, 0, "output-only demand does not run the app sampler")
  const before = data
  listener?.events([{ path: "/fixture/run/web.log", type: "update" }])
  listener?.events([{ path: "/fixture/run/web.log", type: "update" }])
  await tick(2_000)
  if (mode === "hints") {
    assert.equal(owner.outputFollowing(), true)
    assert.equal(data, before + 1, "one batched file hint refreshes the subscribed output")
  }
  reads.setVisible(false); await flush()
  const parked = data
  await tick(60_000)
  assert.equal(data, parked)
  assert.equal(sampler.outputWanted().size, 0)
  assert.equal(output.ready(), false)
  reads.setVisible(true); await tick(0)
  for (let second = 0; second < 15; second++) { await tick(1_000); await sampler.tick() }
  if (mode === "no-frames" || mode === "old-host") assert.ok(data > 20, "ACKs or unsupported peers alone cannot suppress fallback reads")
  stopOutput(); await flush(); await output.close(); owner.close(); reads.dispose()
  assert.equal(watched, released, "every acquired watcher is released after its final demand")
  results.push({ mode, data, controls, hidden: 0 })
}
assert.ok(results.find(r => r.mode === "hints")!.data < results.find(r => r.mode === "poll")!.data)
console.log("OUTPUT_HINT_COMPARISON", JSON.stringify({ secondsVisible: 60, secondsHidden: 60, outputs: 1, results, scope: "actual sampler/watcher owner/hint/bridge scheduler; controlled clock and backend; no CPU or deployed-UI claim" }))
mock.timers.reset()
// Output is a desktop-only projection today. It must not turn into a kept or ephemeral remote app-preview hint.
const remoteConversation = randomUUID(), remoteEpoch = randomUUID()
const gateway = createFakeGateway(), link = await gateway.connectRuntime()
const served = await serveRuntime(link, { runtimeId: "fixture-output", build: "fixture", handle: async () => { throw new Error("no remote calls") } })
let remoteHints = 0, kept = 0
mock.method(served, "ephemeral", () => { remoteHints++; return true })
mock.method(served, "live", () => { kept++; return true })
const remote = new SessionPublisher({ rows: () => [], schedule: () => {}, appsFollowing: () => new Set([remoteConversation]) })
remote.linked({ link, served }); remote.watch(link, [remoteConversation])
remote.own({ type: "view-hint", hint: { domain: "apps", epoch: remoteEpoch, revision: 1, fields: ["state"] } })
assert.equal(remoteHints, 1, "the remote hint observer sees actual app-preview forwarding")
remote.own({ type: "view-hint", hint: { domain: "output", epoch: remoteEpoch, revision: 2, fields: ["output"] } })
assert.equal(remoteHints, 1, "output-only changes do not wake remote app previews that show none of it")
assert.equal(kept, 0, "no projection hints use numbered live frames")
served.close(); link.close(); mock.restoreAll()
console.log("output hints: bounded owner, coalescing, health, close and compatibility pass")
