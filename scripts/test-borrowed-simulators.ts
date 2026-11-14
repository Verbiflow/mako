import "./test-borrowed-simulator-io.mjs"
/**
 * iOS simulators from a cloud Thread (design 7.8), end to end without Xcode: a borrower on a cloud machine waits in
 * words, gets a session lease on one of the person's Macs, and drives that Mac's simulator through its real dispatcher
 * over a fake gateway. The far Mac answers only under the lease, from the place the gateway stamps; a lapsed claim is
 * re-opened once, an act whose outcome is unknown is never sent again, a large picture comes back as the lease's
 * artifact, and the lease's end lets go of everything on both sides.
 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { decodeOperation, encodeOperation, encodeReply, type Actor } from "@mako/protocol"
import { hostCallInput, hostSuccess } from "@mako/host/contracts/host-operations"
import { encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import type { BorrowAnswer, Lease, Need, Progress } from "@mako/protocol/borrow"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import { HostMethods } from "@mako/host/transport/methods"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { LentHere } from "@mako/host/base/lent"
import { Lending } from "@mako/host/usage/lending"
import { LOCAL_HOST, macHostId, type SimulatorAction, type SimulatorAgent, type SimulatorCaller, type SimulatorSummary } from "@mako/host/contracts/simulators"
import type { SimulatorHost } from "@mako/host/control/simulators/host"
import { declareSimulatorMethods } from "@mako/host/control/simulators/methods"
import { Simulators } from "@mako/host/control/simulators/simulators"
import { accountBorrowing, BorrowedSimulators, LeaseEnded, type SimulatorBorrowing } from "@mako/host/control/simulators/borrowed"

const scratch = await mkdtemp(join(tmpdir(), "mako-borrowed-simulators-"))
after(() => rm(scratch, { recursive: true, force: true }))

const DEVICE = "11111111-1111-4111-8111-111111111111"
const MAC_RUNTIME = `d-${DEVICE}`
const MACHINE = "m-00000000000000c1"
const PHONE: SimulatorSummary = { hostId: LOCAL_HOST, id: "MAKO-PHONE", name: "Mako iPhone 17 Pro", platform: "ios", runtime: "iOS 26.1", form: "phone", state: "booted" }
const borrower = { account: "acct", repository: "acme/shop", thread: "cloud-thread", place: { kind: "machine" as const, machine: MACHINE } }
const agentOnMachine: SimulatorAgent = { thread: "cloud-thread", session: "s-cloud", folder: "/workspace/shop", title: "Check sign-in" }

function lease(id: string): Lease {
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
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60 * 60_000,
    delivery: { transfer: "none", secret: false },
    device: DEVICE,
    session: { state: "starting", heartbeatMs: 60_000, lastBeat: Date.now() },
  }
}

/** The Mac's simulator: it does what it's told, its pictures as large as asked, and its acts can hang. */
function macHost() {
  const done: string[] = []
  let hang: Promise<void> | undefined
  let picture = 1024
  const host: SimulatorHost = {
    id: LOCAL_HOST,
    label: "This Mac",
    kind: "local",
    summary: async () => ({ id: LOCAL_HOST, label: "This Mac", kind: "local", platforms: { ios: { ready: true }, android: { ready: false, blocker: "not-built", why: "later" } } }),
    list: async () => [PHONE],
    boot: async (simulator) => void done.push(`boot ${simulator}`),
    act: async (simulator, action: SimulatorAction) => {
      if (hang) await hang
      done.push(`${action.kind} ${simulator}`)
    },
    read: async () => ({ state: { url: "https://app.runmako.co/sign-in" } }),
    screenshot: async () => {
      const path = join(scratch, `shot-${picture}.png`)
      await writeFile(path, new Uint8Array(picture).fill(7))
      return { path, width: 402, height: 874 }
    },
    record: async () => ({}),
    release: async (simulator) => void done.push(`release ${simulator}`),
    close: async () => {},
  }
  return { host, done, hangActs: (until: Promise<void>) => (hang = until), pictures: (bytes: number) => (picture = bytes) }
}

test("a cloud Thread waits for a Mac in words, borrows one, drives its simulator under the lease, and lets go as the lease ends", async () => {
  // The person's Mac: its simulators, its lending, and its host's dispatcher on its runtime link.
  const mac = macHost()
  const beats: Array<[string, Progress | undefined]> = []
  const uploaded: Array<{ lease: string; file: string }> = []
  const lending = new Lending({
    device: async () => DEVICE,
    answer: async () => undefined,
    leases: async () => [],
    serve: async () => ({ answer: "yes", version: "ready" }),
    beat: (id, progress) => (beats.push([id, progress]), true),
    lent: new LentHere(),
    words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }),
    upload: async (id, file, name) => {
      uploaded.push({ lease: id, file })
      return { name, hash: "a".repeat(64), size: (await readFile(file)).length }
    },
    ended: (held) => farSimulators.releaseThread({ thread: held.borrower.thread }),
  })
  const farSimulators: Simulators = new Simulators({
    hosts: [mac.host],
    consent: async () => [],
    agent: () => undefined,
    leases: { leaseOf: (via, thread) => lending.leaseOf(via, thread, "ios-simulator")?.id, used: (id, verb) => lending.used(id, verb), artifact: (id, file, name) => lending.artifact(id, file, name) },
  })
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  const unusedSetup = { phase: "unavailable" as const, checkedAt: 0, mac: "test", steps: [] }
  declareSimulatorMethods(methods, { read: async () => unusedSetup, press: async () => unusedSetup }, farSimulators)
  const gateway = createFakeGateway()
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), { runtimeId: MAC_RUNTIME, build: "test", invoke: methods.invoke.bind(methods) })

  // The cloud machine: its calls go as its runtime, which the gateway stamps; the broker's answers are scripted.
  const asMachine = async (runtimeId: string) => {
    const actor: Actor = { kind: "runtime", runtimeId }
    const session = await gateway.connectClient(actor)
    return async (text: string) => encodeReply(await session.call({ ...decodeOperation(text), actor, target: { kind: "runtime", runtimeId: MAC_RUNTIME } }))
  }
  const machineCall = await asMachine(`${MACHINE}.g2`)
  let answers: BorrowAnswer[] = [{ pending: "capacity", why: "all-busy", position: 2, since: Date.now(), deadline: Date.now() + 29 * 60_000 }]
  const needs: Array<Omit<Need, "for">> = []
  const ended = new Set<string>()
  const port: SimulatorBorrowing = {
    need: async (need) => {
      needs.push(need)
      return answers.shift() ?? { lease: lease("l1") }
    },
    release: async (id) => {
      ended.add(id)
      lending.ended(id, "released")
    },
    renew: async (id) => ({ lease: lease(id) }),
    call: async (id, text) => {
      if (ended.has(id)) throw new LeaseEnded("released")
      return machineCall(text)
    },
    artifact: async (_id, hash) => {
      assert.equal(hash, "a".repeat(64))
      return new Uint8Array(900 * 1024).fill(7)
    },
    devices: async () => [{ id: DEVICE, name: "Ada's Studio", online: true, lastSeen: Date.now() }],
  }
  const borrowed = new BorrowedSimulators({ port, shots: join(scratch, "borrowed") })
  const here = new Simulators({ hosts: [], consent: async () => [], agent: (session) => (session === "s-cloud" ? agentOnMachine : undefined), remotes: () => borrowed.remotes(), borrowing: borrowed })
  const caller: SimulatorCaller = { kind: "agent", session: "s-cloud" }
  const hostId = macHostId(DEVICE)

  // Queued: the agent reads its wait where it looks.
  const waiting = await here.list(caller)
  assert.ok("hosts" in waiting)
  assert.equal(waiting.consent, "allowed", "the person's grant is the consent here")
  const wait = waiting.hosts.find((host) => host.id === "borrowing")?.platforms.ios
  assert.ok(wait && !wait.ready)
  assert.equal(wait.why, "iOS simulator: on Ada's Studio, queued (2nd), starts when it's free; waiting up to 29 min.")

  // Leased: the broker tells the Mac, and the Thread sees its simulators.
  await lending.lent(lease("l1"))
  const listed = await here.list(caller)
  assert.ok("hosts" in listed)
  assert.deepEqual(listed.simulators.map((simulator) => [simulator.hostId, simulator.id]), [[hostId, "MAKO-PHONE"]])
  assert.equal(needs[0]!.correlationId, needs[1]!.correlationId, "one need, asked again, until its lease")

  const opened = await here.open(caller, { host: hostId, simulator: "MAKO-PHONE", url: "https://app.runmako.co/sign-in" })
  assert.ok("claim" in opened, JSON.stringify(opened))
  const tapped = await here.act(caller, { host: hostId, simulator: "MAKO-PHONE", action: { kind: "tap", at: { x: 10, y: 20 } } })
  assert.ok("ms" in tapped, JSON.stringify(tapped))
  assert.deepEqual(mac.done, ["boot MAKO-PHONE", "open-url MAKO-PHONE", "tap MAKO-PHONE"])
  assert.deepEqual(beats.map(([, progress]) => progress?.phase ?? "beat"), ["beat", "booting", "running"], "the lease's progress follows what's driven")

  // Another machine, naming the same Thread, isn't the lease's borrower: refused there, by the far Mac itself.
  const stranger = await asMachine("m-00000000000000ff.g1")
  const home = { v: 1 as const, id: crypto.randomUUID(), op: "host.simulators-act", target: { kind: "runtime" as const, runtimeId: MAC_RUNTIME }, input: hostCallInput([{ kind: "agent", session: "s-cloud", agent: agentOnMachine }, { host: LOCAL_HOST, simulator: "MAKO-PHONE", action: { kind: "home" } }], false), correlationId: crypto.randomUUID(), actor: { kind: "runtime" as const, runtimeId: "x" }, attempt: 1 }
  const foreign = await stranger(encodeOperation(home))
  assert.match(foreign, /not-offered/)
  assert.equal(mac.done.filter((each) => each.startsWith("home")).length, 0)

  // The Mac let the claim go (idle, or the person took it): the next act re-opens once and goes through, done once.
  farSimulators.releaseThread({ thread: "cloud-thread" })
  const again = await here.act(caller, { host: hostId, simulator: "MAKO-PHONE", action: { kind: "tap", at: { x: 1, y: 1 } } })
  assert.ok("ms" in again, JSON.stringify(again))
  assert.equal(mac.done.filter((each) => each === "tap MAKO-PHONE").length, 2)

  // A large picture comes back as the lease's artifact, fetched here.
  mac.pictures(900 * 1024)
  const shot = await here.shot(caller, { host: hostId, simulator: "MAKO-PHONE" })
  assert.ok("path" in shot, JSON.stringify(shot))
  assert.equal((await readFile(shot.path)).length, 900 * 1024)
  assert.equal(uploaded[0]!.lease, "l1")

  // The lease ends: the Mac lets go, the next call finds it ended, and the next look borrows afresh.
  await port.release("l1")
  assert.ok(mac.done.includes("release MAKO-PHONE"), "the far Mac released the Thread's claim")
  const gone = await here.act(caller, { host: hostId, simulator: "MAKO-PHONE", action: { kind: "home" } })
  assert.ok("refused" in gone)
  answers = [{ pending: "capacity", why: "no-device-online", position: 1, since: Date.now(), deadline: Date.now() + 30 * 60_000 }]
  const relisted = await here.list(caller)
  assert.ok("hosts" in relisted && relisted.hosts.some((host) => host.id === "borrowing"))
  assert.notEqual(needs.at(-1)!.correlationId, needs[0]!.correlationId, "a new need once the lease ended")

  served.close()
  await gateway.close()
})

test("an act whose outcome is unknown is never sent again; the agent is told to read the screen first", async () => {
  const mac = macHost()
  const lending = new Lending({ device: async () => DEVICE, answer: async () => undefined, leases: async () => [], serve: async () => ({ answer: "yes", version: "ready" }), beat: () => true, lent: new LentHere(), words: () => ({ what: "an iOS simulator", for: "a cloud Thread" }) })
  const farSimulators = new Simulators({ hosts: [mac.host], consent: async () => [], agent: () => undefined, leases: { leaseOf: (via, thread) => lending.leaseOf(via, thread, "ios-simulator")?.id } })
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  const unusedSetup = { phase: "unavailable" as const, checkedAt: 0, mac: "test", steps: [] }
  declareSimulatorMethods(methods, { read: async () => unusedSetup, press: async () => unusedSetup }, farSimulators)
  const gateway = createFakeGateway()
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), { runtimeId: MAC_RUNTIME, build: "test", invoke: methods.invoke.bind(methods) })
  const actor: Actor = { kind: "runtime", runtimeId: `${MACHINE}.g1` }
  const session = await gateway.connectClient(actor)
  let calls = 0
  let lost = false
  const port: SimulatorBorrowing = {
    need: async () => ({ lease: lease("l2") }),
    release: async () => {},
    renew: async (id) => ({ lease: lease(id) }),
    call: async (_id, text) => {
      calls++
      const operation = decodeOperation(text)
      // The act goes out, and its answer never comes back: the link drops on the way.
      if (operation.op === "host.simulators-act" && lost) {
        void session.call({ ...operation, actor, target: { kind: "runtime", runtimeId: MAC_RUNTIME } })
        throw new Error("the link dropped")
      }
      return encodeReply(await session.call({ ...operation, actor, target: { kind: "runtime", runtimeId: MAC_RUNTIME } }))
    },
    artifact: async () => new Uint8Array(),
    devices: async () => [{ id: DEVICE, name: "Ada's Studio", online: true, lastSeen: Date.now() }],
  }
  await lending.lent(lease("l2"))
  const borrowed = new BorrowedSimulators({ port, shots: join(scratch, "unknown") })
  const here = new Simulators({ hosts: [], consent: async () => [], agent: () => agentOnMachine, remotes: () => borrowed.remotes(), borrowing: borrowed })
  const caller: SimulatorCaller = { kind: "agent", session: "s-cloud" }
  await here.list(caller)
  assert.ok("claim" in (await here.open(caller, { host: macHostId(DEVICE), simulator: "MAKO-PHONE" })))
  lost = true
  const before = calls
  const unknown = await here.act(caller, { host: macHostId(DEVICE), simulator: "MAKO-PHONE", action: { kind: "type", text: "hello" } })
  assert.ok("refused" in unknown && unknown.refused === "unreachable")
  assert.match(unknown.why, /whether that was done is unknown\. Read the screen .* it isn't sent twice/)
  assert.equal(calls - before, 1, "sent once, never again")
  served.close()
  await gateway.close()
})

/** pr-review's lifecycle controls on #417: a borrowing port that does what each case needs, and nothing else. */
function port(patch: Partial<SimulatorBorrowing> = {}): SimulatorBorrowing {
  return {
    need: async () => ({ lease: lease("A") }),
    release: async () => {},
    renew: async (id) => ({ lease: { ...lease(id), expiresAt: Date.now() + 2 * 60 * 60_000 } }),
    call: async () => {
      throw new Error("no operation expected")
    },
    artifact: async () => new Uint8Array(),
    devices: async () => [],
    ...patch,
  }
}
const borrowed = (patched: SimulatorBorrowing, now?: () => number) => new BorrowedSimulators({ port: patched, shots: join(scratch, "lifecycle"), ...(now && { now }) })

test("a lease that comes after its borrowing was let go, or after it ended, holds nothing, and a late one is released", async () => {
  let answer!: (answer: BorrowAnswer) => void
  const released: string[] = []
  const late = borrowed(port({ need: () => new Promise((resolve) => (answer = resolve)), release: async (id) => void released.push(id) }))
  const acquiring = late.ensure("look")
  await late.release()
  answer({ lease: lease("A") })
  await acquiring
  assert.equal(late.remotes().length, 0, "released while acquiring: no Mac reappears")
  assert.deepEqual(released, ["A"], "and the lease that came late is released, not left holding the Mac's slot")

  let listed!: () => void
  let devices!: (devices: []) => void
  const entered = new Promise<void>((resolve) => (listed = resolve))
  const ending = borrowed(port({ devices: () => (listed(), new Promise((resolve) => (devices = resolve))) }))
  const ensuring = ending.ensure("look")
  await entered
  ending.ended("A")
  devices([])
  await ensuring
  assert.equal(ending.remotes().length, 0, "ended while acquiring: it isn't installed after")
})

test("a renewal of a lease since replaced never overwrites the lease held now", async () => {
  let renewal!: (answer: BorrowAnswer) => void
  let needs = 0
  // Its clock a second before the first lease's end, so the keep-alive renews.
  const nearEnd = Date.now() + 60 * 60_000 - 1_000
  const simulators = borrowed(port({ need: async () => ({ lease: lease(++needs === 1 ? "A" : "B") }), renew: () => new Promise((resolve) => (renewal = resolve)) }), () => nearEnd)
  await simulators.ensure("look")
  const renewing = simulators.keepAlive()
  await new Promise((resolve) => setImmediate(resolve))
  simulators.ended("A")
  await simulators.ensure("look again")
  renewal({ lease: { ...lease("A"), expiresAt: Date.now() + 2 * 60 * 60_000 } })
  await renewing
  simulators.ended("B")
  assert.equal(simulators.remotes().length, 0, "ending B lets go of B: A's late renewal didn't take its place")
})

test("a release that fails keeps its lease to try again, and says it failed", async () => {
  let attempts = 0
  const live = new Set(["A"])
  const simulators = borrowed(port({ release: async (id) => {
    if (++attempts === 1) throw new Error("network down")
    live.delete(id)
  } }))
  await simulators.ensure("look")
  await assert.rejects(simulators.release(), /network down/, "the failure is said")
  assert.equal(simulators.remotes().length, 0, "the Thread let go: its Mac isn't used again")
  await simulators.release()
  assert.equal(attempts, 2, "tried again")
  assert.deepEqual([...live], [], "and the broker's lease is gone")
  // A keep-alive tries an unconfirmed release again too.
  let failing = true
  const later = borrowed(port({ release: async () => {
    if (failing) throw new Error("still down")
  } }))
  await later.ensure("look")
  await later.release().catch(() => undefined)
  failing = false
  await later.keepAlive()
  assert.deepEqual(later.unreleased(), [])
})

test("the account's DELETE for a release that isn't a success is a failure, not a release", async () => {
  const answers = [new Response("busy", { status: 503 }), new Response(null, { status: 204 }), new Response("gone", { status: 410 })]
  const seen: string[] = []
  const routes = accountBorrowing(() => ({ gatewayUrl: "https://gateway.test", machine: MACHINE, credential: "test-credential" }), async (url, init) => {
    seen.push(`${init?.method} ${new URL(String(url)).pathname}`)
    return answers.shift()!
  })
  await assert.rejects(routes.release("A"), /503/)
  await routes.release("A")
  await routes.release("A")
  assert.deepEqual(seen, Array(3).fill(`DELETE /v1/machines/${MACHINE}/borrow/leases/A`))
})

test("closing the simulators releases what this host borrowed, a lease taken by a list alone included", async () => {
  const released: string[] = []
  const simulators = borrowed(port({ release: async (id) => void released.push(id) }))
  await simulators.ensure("list only")
  const here = new Simulators({ hosts: [], consent: async () => [], agent: () => undefined, remotes: () => simulators.remotes(), borrowing: simulators })
  await here.close()
  assert.deepEqual(released, ["A"])
  assert.equal(simulators.remotes().length, 0)
  // And one still being acquired as it closes is released when it comes.
  let answer!: (answer: BorrowAnswer) => void
  const pending = borrowed(port({ need: () => new Promise((resolve) => (answer = resolve)), release: async (id) => void released.push(id) }))
  const acquiring = pending.ensure("look")
  await new Simulators({ hosts: [], consent: async () => [], agent: () => undefined, remotes: () => pending.remotes(), borrowing: pending }).close()
  answer({ lease: lease("C") })
  await acquiring
  assert.deepEqual(released, ["A", "C"])
})

test("a release the Thread asked for that the account refuses is logged and kept to try again, never an unhandled rejection", async () => {
  const unhandled: Error[] = []
  const heard = (reason: Error) => void unhandled.push(reason)
  process.on("unhandledRejection", heard)
  try {
    const answering: SimulatorBorrowing = {
      ...port({ release: async () => {
        throw new Error("network down")
      } }),
      // The far Mac's answer to simulator_release: released.
      call: async (_lease, text) => encodeReply(hostSuccess(decodeOperation(text).id, encodeRuntimeValue({ released: true }))),
    }
    const simulators = borrowed(answering)
    await simulators.ensure("look")
    const [mac] = simulators.remotes()
    assert.ok(mac)
    const caller: SimulatorCaller = { kind: "agent", session: "s-cloud", agent: agentOnMachine }
    assert.deepEqual(await mac.release(caller, { host: mac.id, simulator: PHONE.id }), { released: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [], "the failed release isn't left unhandled")
    assert.deepEqual(simulators.unreleased(), ["A"], "it's kept for the keep-alive to try again")
  } finally {
    process.off("unhandledRejection", heard)
  }
})
