import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mock } from "node:test"
import { problem, type Operation } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { HostMethods } from "@mako/host/transport/methods"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import { SessionPublisher, type SessionLink } from "@mako/host/conversations/session-report"
import { ViewHints } from "@mako/host/workspaces/view-hints"
import { declareRemoteAppMethods, declareThreadAppMethods } from "@mako/host/workspaces/app-methods"
import { ThreadAppSampler } from "@mako/host/workspaces/app-sampler"
import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { ownerCall } from "../src/web-client/start"
import { fromHostOperation } from "@mako/host/contracts/host-operations"
import { unwatchedWork } from "@mako/host/base/event-loop"
import type { DeskApp } from "@mako/host/workspaces/environment-tools"
import type { ThreadAppView } from "@mako/host/contracts/thread-app"
import { REMOTE_APP_LEASE_MS, RemoteAppDemandSchema } from "@mako/host/contracts/remote-app"
import { ViewRefetch, type RefetchClock } from "../src/lib/view-refetch"
import { RemoteAppViews } from "../src/web-client/app-views"
import { Gateway } from "../src/web-client/gateway"
import { WebConversations } from "../src/web-client/conversations"
import { appsStore, appKey, followLegacyApp } from "../src/web-client/previews"

const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
class Clock implements RefetchClock {
  time = 1_000_000
  next = 0
  timers = new Map<number, { at: number; run: () => void }>()
  now = () => this.time
  after = (run: () => void, ms: number) => {
    const id = ++this.next
    this.timers.set(id, { at: this.time + ms, run })
    return () => { this.timers.delete(id) }
  }
  async tick(ms: number) {
    const end = this.time + ms
    for (;;) {
      await settle()
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      this.time = next[1].at; this.timers.delete(next[0]); next[1].run()
    }
    this.time = end; await settle()
  }
}
const conversation = randomUUID(), device = randomUUID(), browser = randomUUID()
const owner = { kind: "mac", deviceId: device } as const
const clock = new Clock()
let phase: "starting" | "running" = "running"
let snapshots = 0, samplerLooks = 0
let held: (() => void) | undefined
let hold = false
const view = async (folder: string): Promise<ThreadAppView> => {
  assert.equal(folder, "/fixture/app")
  snapshots++
  if (hold) await new Promise<void>((resolve) => { held = resolve })
  return { kind: "ready", project: "fixture", phase, processes: [{ name: "web", state: phase, port: 21363 }], checks: [] }
}
const unused = (): never => { throw new Error("This fixture never starts an app or reads a real process/file") }
const desk: DeskApp = { view, start: unused, stop: unused, restart: unused, check: unused, makeRoom: unused, takeTurn: unused, output: unused, probe: unused, marks: unused, room: unused, stopApps: unused, setup: unused }
const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb() {}, declaring: async () => {}, work: unwatchedWork })
const publisher = new SessionPublisher({ appsFollowing: () => sampler.remoteConversations(), appPosition: () => hints.position("apps"), rows: () => [], now: clock.now, schedule: () => {} })
const hints = new ViewHints((event) => publisher.own(event))
const sampler = new ThreadAppSampler({ now: clock.now, look: async () => { samplerLooks++; return { marks: [], signature: phase, settling: phase === "starting", alive: true } }, publish: () => hints.changed("apps") })
declareThreadAppMethods(methods, desk, sampler)
declareRemoteAppMethods(methods, { apps: desk, sampler, cwd: (id) => id === conversation ? "/fixture/app" : undefined, position: () => hints.position("apps"), confirm: (id) => publisher.appReady(id) })
const gateway = createFakeGateway()
const link = await gateway.connectRuntime()
const served = await serveHostThroughGateway(link, { runtimeId: `d-${device}`, build: "fixture", invoke: (channel, args, client) => methods.invoke(channel, args, client), watch: (ids, after, forms) => publisher.watch(link, ids, after, forms) })
publisher.linked({ link, served })
const forwarded: string[] = []
const live = served.live
mock.method(served, "live", (...args: Parameters<typeof served.live>) => {
  if (forwarded.length < 32) forwarded.push(args[1].text)
  return live(...args)
})
const session = await gateway.connectClient({ kind: "client", client: "web", deviceId: browser })
const webGateway = new Gateway({ origin: "https://fixture.invalid", connect: async () => { throw new Error("No HTTP, token or account is used") } })
mock.method(webGateway.session, "subscribe", (request: Parameters<typeof webGateway.session.subscribe>[0]) => session.subscribe(request))
let lastView = ""
let oldOwner = false
let lose = 0
let asleep = false
let calls = 0
mock.method(webGateway.session, "call", (operation: Operation) => {
  calls++
  assert.equal(operation.passive, true, "snapshots and demand controls neither wake a cloud owner nor count as person activity")
  if (lose > 0) { lose--; return Promise.resolve({ v: operation.v, id: operation.id, ok: false, problem: problem("unavailable", "A lost reply", operation.correlationId, "unknown") }) }
  if (asleep) return Promise.resolve({ v: operation.v, id: operation.id, ok: false, problem: problem("owner-unavailable", "Its machine is asleep", operation.correlationId, "not-applied") })
  const call = fromHostOperation(operation)
  if (call.kind === "call" && call.channel === "mako:conversation-app-demand") {
    lastView = RemoteAppDemandSchema.parse(call.args[1]).view
    if (oldOwner) return Promise.resolve({ v: operation.v, id: operation.id, ok: false, problem: problem("not-found", "This host has no such call", operation.correlationId, "not-applied", { detail: operation.op }) })
  }
  return session.call(operation)
})
const client = { gateway: webGateway, deviceId: browser }
const reads = new ViewRefetch(clock)
const apps = new RemoteAppViews(client, reads, clock)
const recipients = new Set([apps])
let dropHints = false
const conversations = new WebConversations({ gateway: webGateway, deviceId: browser, row: () => undefined, appHint: (place, hint) => { if (!dropHints) for (const receiver of recipients) receiver.heard(place, hint) }, appsReconnected: (place) => { for (const receiver of recipients) receiver.reconnected(place) } })
const stopStream = conversations.followMac(device, conversation)
await settle()
let stop = apps.watch(conversation, owner, "/fixture/app")
await clock.tick(0)
assert.equal(appsStore.get().apps.get(appKey(owner, "/fixture/app"))?.servers[0]?.state, "ready", appsStore.get().apps.get(appKey(owner, "/fixture/app"))?.reason)
assert.equal(snapshots, 1)
await assert.rejects(methods.invoke("mako:conversation-app", [conversation, lastView], "gateway:web:another-browser"), /no longer followed/)
await assert.rejects(methods.invoke("mako:conversation-app-demand", [conversation, { view: randomUUID(), generation: "wrong", visible: true }], "gateway:web:another-browser"))
await clock.tick(60_000)
assert.equal(snapshots, 1, "a quiet visible preview renews demand, not its snapshot")
assert.equal(apps.readings().demandCalls, 3)
phase = "starting"
hints.changed("apps", ["state"], ["/private/not-forwarded"])
await clock.tick(2_000)
assert.equal(snapshots, 2, "the actual publisher, gateway stream and web parser invalidate the matching preview")
assert.equal(apps.readings().demandCalls, 3, "an ordinary hint needs one data read, not another lease handshake")
assert.ok(forwarded.some((line) => line.includes("conversation-app-hint")))
assert.ok(forwarded.every((line) => !line.includes("/private/not-forwarded")), "local hint keys never reach the gateway")
assert.equal(appsStore.get().apps.get(appKey(owner, "/fixture/app"))?.servers[0]?.state, "starting")
reads.setVisible(false)
await settle()
const parked = snapshots, controls = apps.readings().demandCalls
hints.changed("apps")
await clock.tick(120_000)
assert.equal(snapshots, parked)
assert.equal(apps.readings().demandCalls, controls, "hidden pages neither poll snapshots nor renew demand")
const looks = samplerLooks
await sampler.tick()
assert.equal(samplerLooks, looks, "an expired hidden remote view cannot keep sampling alive")
reads.setVisible(true)
await clock.tick(0)
assert.equal(snapshots, parked + 1, "one return snapshot reacquires its own lease")
hold = true
hints.changed("apps")
await clock.tick(2_000)
assert.ok(held)
reads.setVisible(false)
hold = false; held!()
await settle()
reads.setVisible(true)
await clock.tick(0)
assert.equal(reads.readings().staleAnswers, 1, "an answer from the retired visible generation cannot land")
// A missing ephemeral hint is caught by the revision in the next lease renewal.
stopStream()
await settle()
const missing = snapshots
hints.changed("apps")
await clock.tick(30_000)
assert.equal(snapshots, missing + 1)
stop(); apps.close(); reads.dispose()
await settle()
await clock.tick(REMOTE_APP_LEASE_MS + 1)
assert.equal(clock.timers.size, 0)
// Same legacy policy extracted from #810's hook, compared with the hint reader on the same gateway and clock.
interface Measurement { state: "running" | "starting"; policy: "legacy" | "hints" | "older-owner" | "no-stream"; dataReads: number; controls: number; hiddenDataReads: number }
const resumeStream = conversations.followMac(device, conversation)
await settle()
const comparison: Measurement[] = []
for (const state of ["running", "starting"] as const) {
  for (const policy of ["legacy", "hints", "older-owner", "no-stream"] as const) {
    await clock.tick(REMOTE_APP_LEASE_MS + 1)
    phase = state; oldOwner = policy === "older-owner"; dropHints = policy === "no-stream"
    const pages = Array.from({ length: 3 }, () => new ViewRefetch(clock))
    const owners = pages.map((page) => new RemoteAppViews(client, page, clock))
    for (const receiver of owners) recipients.add(receiver)
    const before = snapshots
    const stops = pages.map((page, index) => policy === "legacy" ? followLegacyApp(client, owner, "/fixture/app", page) : owners[index]!.watch(conversation, owner, "/fixture/app"))
    await clock.tick(45_000)
    for (const page of pages) page.setVisible(false)
    await settle()
    const hidden: number = snapshots
    await clock.tick(60_000)
    assert.equal(snapshots, hidden, `${policy}: no hidden data requests`)
    for (const page of pages) page.setVisible(true)
    await clock.tick(15_000)
    const dataReads = snapshots - before
    for (const stop of stops) stop()
    const counters = owners.map((owner) => owner.readings())
    for (const owner of owners) { owner.close(); recipients.delete(owner) }
    for (const page of pages) page.dispose()
    await settle()
    comparison.push({ state, policy, dataReads, controls: counters.reduce((sum, row) => sum + row.demandCalls, 0), hiddenDataReads: 0 })
  }
}
for (const state of ["running", "starting"]) {
  const before = comparison.find((row) => row.state === state && row.policy === "legacy")!
  const after = comparison.find((row) => row.state === state && row.policy === "hints")!
  const fallback = comparison.find((row) => row.state === state && row.policy === "older-owner")!
  assert.equal(after.dataReads, 6, "each view reads once on opening and once on return; renewals are data-free")
  assert.ok(after.dataReads < before.dataReads)
  assert.equal(comparison.find((row) => row.state === state && row.policy === "no-stream")?.dataReads, before.dataReads, "an accepted RPC without a delivered stream retains visible reads")
  assert.equal(fallback.dataReads, before.dataReads, "an older owner retains the original visible policy")
}
console.log("REMOTE_APP_POLICY_COMPARISON", JSON.stringify({ virtualSecondsPerCase: 120, viewOwners: 3, visibleSeconds: 60, hiddenSeconds: 60, result: comparison, scope: "Actual legacy/hint readers and methods over in-process gateway; controlled clocks, no real browser or hosted gateway/CPU claim" }))

oldOwner = false; dropHints = false
lose = 1
const began = calls
await assert.rejects(ownerCall(client.gateway, browser, owner, "mako:thread-app", ["/fixture/app"], { passive: true }), RuntimeDisconnectedError)
assert.equal(calls, began + 1, "a passive Mac read never retries behind a hidden view")
asleep = true
const cloud = { kind: "cloud", threadId: "t-0123456789abcdef" } as const
const sleepingReads = new ViewRefetch(clock)
const sleeping = new RemoteAppViews(client, sleepingReads, clock)
const stopSleeping = sleeping.watch(conversation, cloud, "/fixture/app")
await clock.tick(0)
assert.equal(appsStore.get().apps.get(appKey(cloud, "/fixture/app"))?.asleep, true, "a confirmed sleeping owner retains the existing passive preview state")
stopSleeping(); sleeping.close(); sleepingReads.dispose(); await settle(); asleep = false

const closingReads = new ViewRefetch(clock)
const closingViews = new RemoteAppViews(client, closingReads, clock)
const lateCleanup = closingViews.watch(conversation, owner, "/fixture/app")
await clock.tick(0)
closingViews.close()
const afterClose = calls
lateCleanup()
await clock.tick(120_000)
assert.equal(calls, afterClose, "unmount after client shutdown cannot send another release or renew")
closingReads.dispose()

const bounded = new ThreadAppSampler({ now: clock.now, look: unused, publish: unused })
const command = { view: randomUUID(), generation: 1, visible: true, confirm: false }
assert.equal(bounded.followRemote("a", conversation, command), true)
assert.equal(bounded.followRemote("a", conversation, { ...command, generation: 2, visible: false }), true)
assert.equal(bounded.followRemote("a", conversation, command), false)
assert.equal(bounded.remoteActive("a", conversation, command.view), false)
for (let i = 0; i < 127; i++) assert.equal(bounded.followRemote("a", conversation, { ...command, view: randomUUID() }), true)
assert.equal(bounded.followRemote("a", conversation, { ...command, view: randomUUID() }), false, "invented view IDs cannot grow the host's lease map")
await clock.tick(REMOTE_APP_LEASE_MS + 1)
assert.equal(bounded.followRemote("a", conversation, { ...command, view: randomUUID() }), true, "expired leases release capacity")
// Metadata is ephemeral: it cannot evict or occupy the critical live-update replay tail.
const replayed: string[] = []
const replay = new SessionPublisher({ rows: () => [], now: clock.now, schedule: () => {}, appsFollowing: () => new Set([conversation]) })
const replayLink: SessionLink = { link, served: { version: served.version, sessions: () => true, live: (_id, event) => { replayed.push(event.text); return true } } }
replay.linked(replayLink)
replay.watch(link, [conversation])
replay.event("event", { type: "live-batch", conversation, payload: JSON.stringify({ type: "live-batch", batch: { id: conversation, revision: 1, updates: [] } }) })
replayed.length = 0
for (let i = 0; i < 1100; i++) replay.own({ type: "view-hint", hint: { ...hints.position("apps"), domain: "apps", fields: ["all"] } })
assert.equal(replayed.length, 1100)
replayed.length = 0
replay.watch(link, [conversation], { [conversation]: 0 })
assert.equal(replayed.length, 1)
assert.ok(replayed[0]?.includes('"live-batch"'), "only the retained live update replays")

resumeStream()
await methods.close()
served.close(); link.close(); mock.restoreAll()
console.log("remote app views: actual method validation/gateway/publisher/web parser, passive demand, hidden expiry, stale answers and missed-hint recovery pass")
