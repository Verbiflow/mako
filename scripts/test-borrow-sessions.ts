import assert from "node:assert/strict"
import { serveRuntime } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { emptyBroker, GrantSchema, liveLeases, step, type BorrowAnswer, type Lease, type Progress, type SourceAnswer, type SourceAsk } from "@mako/protocol/borrow"
import { LentHere } from "@mako/host/base/lent"
import { Lending } from "@mako/host/usage/lending"

/**
 * The sessions a device lends as their source: it answers what it can answer itself and leaves its person's asks to
 * them, serves each lease the broker issues it with a slot and a heartbeat, lets go of it however it ends (told, or
 * found ended on connecting), and answers another place's call only under a live lease of that Thread from that place.
 */

const DEVICE = "mac-1"
const MACHINE = "m-00000000000000a1"
const borrower = { account: "acct", repository: "acme/shop", thread: "t1", place: { kind: "machine" as const, machine: MACHINE } }

function lease(id: string, overrides: Partial<Lease> = {}): Lease {
  return {
    id,
    grant: "simulators",
    grantVersion: 1,
    borrower,
    resource: { kind: "operation", ref: "ios-simulator" },
    source: { kind: "capable", requires: [{ capability: "ios-simulator" }] },
    mode: "relay",
    access: "run",
    version: "g1",
    issuedAt: 1,
    expiresAt: Date.now() + 60 * 60_000,
    delivery: { transfer: "none", secret: false },
    device: DEVICE,
    session: { state: "starting", heartbeatMs: 60_000, lastBeat: 1 },
    ...overrides,
  }
}

const ask = (id: string, askPerson: boolean): SourceAsk => ({ ask: id, grant: "simulators", resource: { kind: "operation", ref: "ios-simulator" }, ref: "ios-simulator", mode: "relay", borrower, why: "check the sign-in page", askPerson })

function world(options: { serve?: SourceAnswer; live?: Lease[] } = {}) {
  const lent = new LentHere()
  const answered: Array<[string, SourceAnswer]> = []
  const beats: Array<[string, Progress | undefined]> = []
  const endedHere: string[] = []
  const lending = new Lending({
    device: async () => DEVICE,
    answer: async (id, answer): Promise<BorrowAnswer> => {
      answered.push([id, answer])
      return answer.answer === "yes" ? { lease: lease(`lease-${id}`) } : { refusal: { refused: "unavailable", reason: "not-found" } }
    },
    leases: async () => options.live ?? [],
    serve: async () => options.serve ?? { answer: "yes", version: "ready" },
    beat: (id, progress) => (beats.push([id, progress]), true),
    lent,
    words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }),
    ended: (held) => void endedHere.push(held.id),
  })
  return { lending, lent, answered, beats, endedHere }
}

{
  // An ask its person isn't asked is answered at once, and the lease it makes is served: a slot, and alive.
  const { lending, lent, answered, beats } = world()
  await lending.asked(ask("a1", false))
  assert.deepEqual(answered, [["a1", { answer: "yes", version: "ready" }]])
  assert.deepEqual(lent.words(), ["an iOS simulator for a cloud Thread"])
  assert.deepEqual(beats, [["lease-a1", undefined]], "alive from the moment it's served")
  // One that asks its person waits for them in Setup: nothing answers it here.
  await lending.asked(ask("a2", true))
  assert.equal(answered.length, 1)
  // A Mac that can't serve it says so, and serves nothing.
  const blocked = world({ serve: { answer: "unavailable", reason: "not-found" } })
  await blocked.lending.asked(ask("a3", false))
  assert.deepEqual(blocked.answered, [["a3", { answer: "unavailable", reason: "not-found" }]])
  assert.equal(blocked.lent.count(), 0)
}

{
  // The broker's word that a lease is issued: served once, only when it's this device's and a session.
  const { lending, lent, beats, endedHere } = world()
  await lending.lent(lease("l1"))
  await lending.lent(lease("l1"))
  await lending.lent(lease("other", { device: "mac-2" }))
  await lending.lent(lease("copy", { session: undefined }))
  assert.deepEqual(lending.served().map((each) => each.id), ["l1"])
  // Progress goes with a beat when it changes; opening reads as booting, then running.
  lending.used("l1", "open")
  lending.used("l1", "open")
  lending.used("l1", "act")
  lending.beat()
  assert.deepEqual(beats.slice(1), [["l1", { phase: "booting" }], ["l1", { phase: "running" }], ["l1", undefined]])
  // However it ends, its slot is free and what it held here lets go.
  lending.ended("l1", "revoked")
  lending.ended("l1", "revoked")
  assert.equal(lent.count(), 0)
  assert.deepEqual(endedHere, ["l1"])
}

{
  // On connecting, the account's leases are the truth: one ended while away goes as lost, one issued meanwhile is served.
  const live = [lease("kept"), lease("new")]
  const { lending, endedHere } = world({ live })
  await lending.lent(lease("kept"))
  await lending.lent(lease("gone"))
  await lending.sync()
  assert.deepEqual(lending.served().map((each) => each.id).sort(), ["kept", "new"])
  assert.deepEqual(endedHere, ["gone"])
}

{
  // Another place's call is answered only under a live lease of its Thread, from where its borrower runs.
  const { lending } = world()
  await lending.lent(lease("l1"))
  await lending.lent(lease("phone", { borrower: { ...borrower, thread: "t2", place: { kind: "device", device: "mac-2" } } }))
  await lending.lent(lease("late", { borrower: { ...borrower, thread: "t3" }, expiresAt: 1 }))
  assert.equal(lending.leaseOf({ from: `runtime:${MACHINE}.g3` }, "t1", "ios-simulator")?.id, "l1", "any generation of the borrower's machine")
  assert.equal(lending.leaseOf({ from: "runtime:m-00000000000000b2.g1" }, "t1", "ios-simulator"), undefined, "another machine, though it names the Thread")
  assert.equal(lending.leaseOf({ from: `runtime:${MACHINE}.g3` }, "t9", "ios-simulator"), undefined, "another Thread from the same place")
  assert.equal(lending.leaseOf({ from: `runtime:${MACHINE}.g3` }, "t1", "android-emulator"), undefined, "another operation")
  assert.equal(lending.leaseOf({ from: "desktop:mac-2" }, "t2", "ios-simulator")?.id, "phone")
  assert.equal(lending.leaseOf({ from: "runtime:d-mac-2" }, "t2", "ios-simulator")?.id, "phone")
  assert.equal(lending.leaseOf({ from: "runtime:x:mac-2" }, "t2", "ios-simulator"), undefined, "a runtime isn't a device by its name's end")
  assert.equal(lending.leaseOf({ from: `runtime:${MACHINE}.g1` }, "t3", "ios-simulator"), undefined, "a lapsed lease answers nothing")
}

{
  // Over the runtime link: the gateway's frames reach the device's lending, and its beats reach the gateway.
  const gateway = createFakeGateway()
  const { lending } = world()
  let served: Awaited<ReturnType<typeof serveRuntime>> | undefined
  const runtime = await serveRuntime(await gateway.connectRuntime(), {
    runtimeId: `d-${DEVICE}`,
    build: "test",
    handle: async () => {
      throw new Error("no calls")
    },
    lending: { asked: (each) => void lending.asked(each), lent: (each) => void lending.lent(each), ended: (id, why) => lending.ended(id, why) },
  })
  served = runtime
  const linked = new Lending({
    device: async () => DEVICE,
    answer: async () => undefined,
    leases: async () => [],
    serve: async () => ({ answer: "yes", version: "ready" }),
    beat: (id, progress) => served!.beat(id, progress),
    lent: new LentHere(),
    words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }),
  })
  await linked.lent(lease("l1"))
  linked.used("l1", "open")
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(gateway.beats(`d-${DEVICE}`), [{ lease: "l1" }, { lease: "l1", progress: { phase: "booting" } }])
  assert.equal(gateway.lend(`d-${DEVICE}`, { type: "lent", lease: lease("l2") }), true)
  assert.equal(gateway.lend(`d-${DEVICE}`, { type: "lent-ended", lease: "l2", why: "cancelled" }), true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(lending.served(), [], "issued and ended, as the link said")
  await lending.lent(lease("l2"))
  assert.deepEqual(lending.served(), [], "word of its issue after its end serves nothing")
  runtime.close()
  await gateway.close()
}

{
  // A served lease's first beat names what it streams its borrower, as the contract's session lists it.
  const said: unknown[] = []
  const lending = new Lending({
    device: async () => DEVICE,
    answer: async () => undefined,
    leases: async () => [],
    serve: async () => ({ answer: "yes", version: "ready" }),
    beat: (id, progress, streams) => (said.push({ id, ...(progress && { progress }), ...(streams && { streams }) }), true),
    streams: () => [{ name: "screen", kind: "video" }],
    lent: new LentHere(),
    words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }),
  })
  await lending.lent(lease("l1"))
  lending.beat()
  assert.deepEqual(said, [{ id: "l1", streams: [{ name: "screen", kind: "video" }] }, { id: "l1" }])
}


{
  // pr-review's lifecycle controls on #415. A sync whose read began before a lease was issued doesn't end that lease:
  // only what was served when the read began can have ended while away.
  let reply!: (leases: Lease[]) => void
  const lent = new LentHere()
  const endedHere: string[] = []
  const lending = new Lending({ device: async () => DEVICE, answer: async () => undefined, leases: () => new Promise<Lease[]>((resolve) => (reply = resolve)), serve: async () => ({ answer: "yes", version: "ready" }), beat: () => true, lent, words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }), ended: (held) => void endedHere.push(held.id) })
  const sync = lending.sync()
  await lending.lent(lease("new"))
  reply([])
  await sync
  assert.equal(lent.count(), 1, "a lease issued during the read is still served")
  assert.deepEqual(endedHere, [])
}

{
  // A renewal at the broker is taken here, from the broker's own core: heartbeats kept current and a renew before the
  // first hour is up move its expiry, and a call after the first expiry is still answered, on the same one slot.
  let now = 1
  let live: Lease[] = []
  const lent = new LentHere()
  const lending = new Lending({ device: async () => DEVICE, answer: async () => undefined, leases: async () => live, serve: async () => ({ answer: "yes", version: "ready" }), beat: () => true, lent, words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }), now: () => now })
  const grant = GrantSchema.parse({ id: "simulators", resource: { kind: "operation", ref: "ios-simulator" }, source: { kind: "capable", requires: [{ capability: "ios-simulator" }] }, scope: { level: "account", account: "acct" }, mode: "relay", access: "run", lifetime: { until: "revoked" }, ask: "never", secret: false, grantedBy: { kind: "person", account: "acct" }, grantedAt: 1, version: 1 })
  let state = step(emptyBroker("acct"), { type: "grant", grant, at: 1 }).state
  state = step(state, { type: "advertise", device: DEVICE, capabilities: [{ capability: "ios-simulator" }], slots: { used: 0, of: 4 }, at: 2 }).state
  state = step(state, { type: "borrow", need: { kind: "operation", ref: "ios-simulator", for: borrower, why: "check the sign-in page", correlationId: "one" }, at: 3, lease: "renewed", ask: "ask" }).state
  state = step(state, { type: "source-answer", ask: "ask", answer: { answer: "yes", version: "ready" }, at: 4 }).state
  const issued = liveLeases(state)[0]!
  await lending.lent(issued)
  for (now = 30_000; now < issued.expiresAt - 10_000; now += 30_000) state = step(state, { type: "heartbeat", lease: issued.id, device: DEVICE, at: now }).state
  now = issued.expiresAt - 10_000
  const renewed = step(state, { type: "renew", lease: issued.id, at: now })
  state = renewed.state
  assert.ok(renewed.answer && "lease" in renewed.answer)
  live = liveLeases(state)
  await lending.sync()
  now = issued.expiresAt + 1
  assert.equal(lending.served()[0]?.expiresAt, live[0]?.expiresAt, "the broker's renewed expiry is the one held here")
  assert.ok(lending.leaseOf({ from: `runtime:${MACHINE}.g1` }, "t1", "ios-simulator"), "a call after the first expiry is still under the lease")
  assert.equal(lent.count(), 1, "a renewal takes no second slot")
  // Heard as the broker's word again (a `lent` frame with the renewed lease), the same.
  const again = { ...live[0]!, expiresAt: live[0]!.expiresAt + 60_000 }
  await lending.lent(again)
  assert.equal(lending.served()[0]?.expiresAt, again.expiresAt)
  assert.equal(lent.count(), 1)
  // An older word of it never shortens it.
  await lending.lent(issued)
  assert.equal(lending.served()[0]?.expiresAt, again.expiresAt)
  // A lease near its end is asked of the broker as it beats, and a renewal there is taken before it lapses.
  live = [{ ...again, expiresAt: again.expiresAt + 3_600_000 }]
  now = again.expiresAt - 1_000
  lending.beat()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(lending.served()[0]?.expiresAt, live[0]!.expiresAt, "renewed before it lapsed")
}

{
  // A lease that expires while the link is down ends here at its expiry: its slot is free and what it held lets go.
  let now = 1
  const lent = new LentHere()
  const endedHere: string[] = []
  const lending = new Lending({ device: async () => DEVICE, answer: async () => undefined, leases: async () => null, serve: async () => ({ answer: "yes", version: "ready" }), beat: () => false, lent, words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }), ended: (held, why) => void endedHere.push(`${held.id} ${why}`), now: () => now })
  await lending.lent(lease("offline", { expiresAt: 1_000 }))
  assert.equal(lent.count(), 1)
  now = 1_001
  lending.beat()
  assert.equal(lent.count(), 0, "no Fin slot or keep-awake is held for it")
  assert.deepEqual(endedHere, ["offline expired"])
  assert.equal(lending.served().length, 0)
}
{
  // A session's streams are said with its beats until a beat is heard: a first beat lost on a link that was down
  // doesn't lose its screen for good.
  let up = false
  const said: Array<[string, number]> = []
  const lending = new Lending({ device: async () => DEVICE, answer: async () => undefined, leases: async () => [], serve: async () => ({ answer: "yes", version: "ready" }), beat: (id, _progress, streams) => (said.push([id, streams?.length ?? 0]), up), streams: () => [{ name: "screen", kind: "video" }], lent: new LentHere(), words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }) })
  await lending.lent(lease("screen"))
  assert.deepEqual(said, [["screen", 1]])
  up = true
  lending.beat()
  assert.deepEqual(said.at(-1), ["screen", 1], "the next beat says the stream again")
  lending.beat()
  assert.deepEqual(said.at(-1), ["screen", 0], "and once heard, not again")
}

console.log("borrow sessions: ok")
