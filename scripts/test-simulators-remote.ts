/**
 * A simulator on another of the person's Macs: host-scoped IDs, claims kept where the simulator runs, the screen
 * streamed as ControlVideo packets, and a call that reaches that Mac through a fake gateway the way the cloud does.
 * Nothing here needs Xcode: the remote Mac is a second host process, and its screen is the mock bridge's frames.
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { z } from "zod"
import { decodeControlVideo, decodeControlVideoBatch, type ControlVideoPacket } from "@mako/control-runtime/contracts"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import {
  LOCAL_HOST,
  macHostId,
  type SimulatorAction,
  type SimulatorAgent,
  type SimulatorCaller,
  type SimulatorSummary,
} from "@mako/host/contracts/simulators"
import { SimulatorUnsupported, type SimulatorFrameSink, type SimulatorFrameSource, type SimulatorHost } from "@mako/host/control/simulators/host"
import { declareSimulatorMethods, stampedCaller } from "@mako/host/control/simulators/methods"
import { RemoteMacSimulators } from "@mako/host/control/simulators/remote-host"
import { Simulators } from "@mako/host/control/simulators/simulators"
import { SimulatorStreams } from "@mako/host/control/simulators/stream"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import { HostMethods } from "@mako/host/transport/methods"
import { declareAgentMethods } from "@mako/host/conversations/agent-tools"
import { declareThreadMoveMethods } from "@mako/host/conversations/thread-move-tool"
import { declareThreadActMethods } from "@mako/host/conversations/thread-act-tool"
import { declareSettingsMethods } from "@mako/host/conversations/settings-tool"
import { declareAutomationToolMethods } from "@mako/host/conversations/automation-tool"
import { declareHarnessToolMethods } from "@mako/host/conversations/harness-tool"
import type { AgentOperations, PlacementOperations } from "@mako/host/contracts/agent-tools"

const scratch = await mkdtemp(join(tmpdir(), "mako-simulators-remote-"))
after(() => rm(scratch, { recursive: true, force: true }))

const PHONE: SimulatorSummary = {
  hostId: LOCAL_HOST,
  id: "MAKO-PHONE",
  name: "Mako iPhone 17 Pro",
  platform: "ios",
  runtime: "iOS 26.1",
  form: "phone",
  state: "booted",
  screen: { width: 402, height: 874, scale: 3 },
}

const agent = (session: string): SimulatorCaller => ({ kind: "agent", session })

/** Sessions as the Thread store would place them: `s-<thread>` in Thread `<thread>`, working in the folder given. */
function sessions(folders: Record<string, string>): (session: string) => SimulatorAgent | undefined {
  return (session) => {
    const thread = session.replace(/^s-/, "")
    const folder = folders[thread]
    return folder ? { thread, session, conversation: `c-${thread}`, folder, title: `Thread ${thread}` } : undefined
  }
}

/** A host that does what it's told and can stream its screen as ControlVideo packets. */
function fakeHost(options: { id?: string; label?: string; frames?: boolean } = {}): SimulatorHost & {
  done: string[]
  push: (packet: ControlVideoPacket) => void
  end: (reason: string) => void
  sinks: SimulatorFrameSink[]
  sizes: Array<{ width: number; height: number }>
  keys: number
} {
  const done: string[] = []
  const sinks: SimulatorFrameSink[] = []
  const sizes: Array<{ width: number; height: number }> = []
  let keys = 0
  return {
    id: options.id ?? LOCAL_HOST,
    label: options.label ?? "This Mac",
    kind: "local",
    done,
    sinks,
    sizes,
    get keys() {
      return keys
    },
    push(packet) {
      for (const sink of sinks) sink.packet(packet)
    },
    end(reason) {
      for (const sink of sinks.splice(0)) sink.ended(reason)
    },
    summary: async () => ({
      id: options.id ?? LOCAL_HOST,
      label: options.label ?? "This Mac",
      kind: "local",
      platforms: { ios: { ready: true }, android: { ready: false, blocker: "not-built", why: "later" } },
    }),
    list: async () => [{ ...PHONE, hostId: options.id ?? LOCAL_HOST }],
    boot: async (id) => void done.push(`boot ${id}`),
    act: async (id, action: SimulatorAction) => void done.push(`${action.kind} ${id}`),
    read: async () => ({ state: { url: "https://app.runmako.co" } }),
    screenshot: async () => {
      const path = join(scratch, `shot-${done.length}.png`)
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]))
      return { path, width: 402, height: 874 }
    },
    record: async () => {
      throw new SimulatorUnsupported("Recording comes later.")
    },
    release: async (id) => void done.push(`release ${id}`),
    close: async () => void done.push("close"),
    frames:
      options.frames === false
        ? undefined
        : async (_simulator, sink) => {
            sinks.push(sink)
            const source: SimulatorFrameSource = {
              keyFrame: () => {
                keys++
                sink.packet(keyPacket(keys))
              },
              resize: (box) => void sizes.push(box),
              stop: async () => {
                const at = sinks.indexOf(sink)
                if (at >= 0) sinks.splice(at, 1)
              },
            }
            return source
          },
  }
}

function poster(sequence = 1): ControlVideoPacket {
  return { kind: "poster", width: 402, height: 874, sequence, capturedAt: sequence, data: Uint8Array.from([0xff, 0xd8, sequence & 0xff]) }
}

function keyPacket(sequence: number): ControlVideoPacket {
  return {
    kind: "key",
    width: 402,
    height: 874,
    sequence,
    capturedAt: sequence,
    description: Uint8Array.from([1, 66, 0, 30]),
    data: Uint8Array.from([0, 0, 0, 1, sequence & 0xff]),
  }
}

function delta(sequence: number): ControlVideoPacket {
  return { kind: "delta", width: 402, height: 874, sequence, capturedAt: sequence, data: Uint8Array.from([0, 0, 0, 1, sequence & 0xff]) }
}

test("macHostId names another Mac, and a simulator's claim stays on the Mac that runs it", async () => {
  const other = fakeHost()
  const leased = { value: true }
  const consent = [{ folder: "/Users/ada/shop", allowed: true, at: 1 }]
  const lookup = sessions({ a: "/Users/ada/shop", b: "/Users/ada/shop" })
  const theirs = new Simulators({ hosts: [other], consent: async () => consent, agent: lookup, leases: { leaseOf: () => (leased.value ? "lease-1" : undefined) } })
  const device = "11111111-1111-4111-8111-111111111111"
  const hostId = macHostId(device)
  const shots = join(scratch, "shots")
  const remote = new RemoteMacSimulators({
    id: hostId,
    label: "Ada's Studio",
    shots,
    call: async (channel, args) => {
      // As that Mac's gateway path stamps: a call from this Mac arrives as another device.
      const via = "gateway:desktop:22222222-2222-4222-8222-222222222222"
      if (channel === "mako:simulators-list") {
        const [caller] = hostCallSchema("mako:simulators-list").parse(args)
        return theirs.list(stampedCaller(caller, via))
      }
      if (channel === "mako:simulators-open") {
        const [caller, input] = hostCallSchema("mako:simulators-open").parse(args)
        return theirs.open(stampedCaller(caller, via), input)
      }
      if (channel === "mako:simulators-act") {
        const [caller, input] = hostCallSchema("mako:simulators-act").parse(args)
        return theirs.act(stampedCaller(caller, via), input)
      }
      if (channel === "mako:simulators-shot") {
        const [caller, input] = hostCallSchema("mako:simulators-shot").parse(args)
        return theirs.shot(stampedCaller(caller, via), input)
      }
      if (channel === "mako:simulators-release") {
        const [caller, input] = hostCallSchema("mako:simulators-release").parse(args)
        return theirs.release(stampedCaller(caller, via), input)
      }
      if (channel === "mako:simulators-watch") {
        const [caller, input] = hostCallSchema("mako:simulators-watch").parse(args)
        return theirs.watch(stampedCaller(caller, via), input)
      }
      throw new Error(`unexpected ${channel}`)
    },
  })
  const here = new Simulators({
    hosts: [fakeHost({ id: LOCAL_HOST, label: "This Mac", frames: false })],
    remotes: () => [remote],
    consent: async () => consent,
    agent: lookup,
  })

  const listed = await here.list(agent("s-a"))
  assert.ok("hosts" in listed)
  assert.equal(listed.hosts.some((host) => host.id === hostId && host.label === "Ada's Studio"), true)
  assert.equal(listed.simulators.some((simulator) => simulator.hostId === hostId && simulator.id === "MAKO-PHONE"), true)
  assert.equal(listed.simulators.some((simulator) => simulator.hostId === LOCAL_HOST), true)

  const opened = await here.open(agent("s-a"), { host: hostId, simulator: "MAKO-PHONE", url: "https://app.runmako.co" })
  assert.ok("claim" in opened)
  assert.equal(opened.simulator.hostId, hostId)
  assert.deepEqual(other.done, ["boot MAKO-PHONE", "open-url MAKO-PHONE"])

  // That Mac holds the claim: a second Thread on this Mac is refused with that Mac's words.
  const held = await here.open(agent("s-b"), { host: hostId, simulator: "MAKO-PHONE" })
  assert.equal("refused" in held && held.refused, "held")
  assert.equal("refused" in held && held.holder?.title, "Thread a")

  const shot = await here.shot(agent("s-b"), { host: hostId, simulator: "MAKO-PHONE" })
  assert.ok("path" in shot)
  assert.equal(shot.path.startsWith(shots), true)
  assert.equal((await readFile(shot.path)).byteLength > 0, true)

  await here.release(agent("s-a"), { host: hostId, simulator: "MAKO-PHONE" })
  const reopened = await here.open(agent("s-b"), { host: hostId, simulator: "MAKO-PHONE" })
  assert.ok("claim" in reopened)

  // The lease ended: no call of that Thread is answered under it any more.
  leased.value = false
  const refused = await theirs.open(stampedCaller({ kind: "agent", session: "s-a", agent: lookup("s-a") }, "gateway:desktop:other"), { host: LOCAL_HOST, simulator: "MAKO-PHONE" })
  assert.equal("refused" in refused && refused.refused, "not-offered")
})

test("a late viewer paints from the poster and the current key frame; a slow one never stalls the others", async () => {
  const streams = new SimulatorStreams({ lingerMs: 20, queueBytes: 200 })
  const host = fakeHost()
  const start = (sink: SimulatorFrameSink) => host.frames!("MAKO-PHONE", sink)
  const screen = JSON.stringify([LOCAL_HOST, "MAKO-PHONE"])

  // Drain the key frame the host sends a first viewer.
  const first = await streams.read(screen, "panel", start, { box: { width: 200, height: 400 }, waitMs: 50 })
  assert.equal(first.live, true)
  assert.deepEqual(host.sizes[0], { width: 200, height: 400 })
  assert.equal(host.keys, 1, "a first viewer with no GOP asks for a key frame")
  assert.deepEqual(
    first.packets.map((packet) => decodeControlVideo(packet).kind),
    ["key"]
  )

  host.push(poster(1))
  host.push(keyPacket(2))
  host.push(delta(3))
  host.push(delta(4))

  // A poster starts the stream again: every viewer gets it, then the new key (one whose decoder draws ignores it), and a
  // late one gets it with the current GOP.
  const panel = await streams.read(screen, "panel", start, { waitMs: 50 })
  assert.deepEqual(
    panel.packets.map((packet) => decodeControlVideo(packet).kind),
    ["poster", "key", "delta", "delta"]
  )

  const late = await streams.read(screen, "phone", start, { box: { width: 800, height: 1600 }, waitMs: 50 })
  assert.deepEqual(
    late.packets.map((packet) => decodeControlVideo(packet).kind),
    ["poster", "key", "delta", "delta"]
  )
  assert.deepEqual(host.sizes.at(-1), { width: 800, height: 1600 }, "the host encodes for the largest viewer")

  // A slow viewer fills past its queue: it drops what it had and needs a key frame; the panel keeps getting deltas.
  for (let sequence = 5; sequence < 20; sequence++) host.push(delta(sequence))
  await Promise.resolve()
  assert.ok(host.keys >= 2, "a viewer that fell behind asks for another key frame")
  host.push(keyPacket(100))
  host.push(delta(101))

  const panelAgain = await streams.read(screen, "panel", start, { waitMs: 50 })
  assert.ok(panelAgain.packets.some((packet) => decodeControlVideo(packet).kind === "key"))
  assert.ok(panelAgain.packets.some((packet) => decodeControlVideo(packet).kind === "delta"))

  const phoneAgain = await streams.read(screen, "phone", start, { waitMs: 50 })
  const kinds = phoneAgain.packets.map((packet) => decodeControlVideo(packet).kind)
  assert.equal(kinds[0], "key", "the slow viewer starts again at a key frame")
  assert.ok(!kinds.slice(0, kinds.indexOf("key")).includes("delta"))

  await streams.close()
})

test("Simulators.watch hands a ControlVideoBatch, and stamps a gateway caller so two viewers don't collide", async () => {
  const host = fakeHost()
  const simulators = new Simulators({
    hosts: [host],
    consent: async () => [{ folder: "/Users/ada/shop", allowed: true, at: 1 }],
    agent: sessions({ a: "/Users/ada/shop" }),
    leases: { leaseOf: () => "lease-1" },
  })
  // Drain the key frame the host sends a first viewer.
  await simulators.watch({ kind: "person" }, { host: LOCAL_HOST, simulator: "MAKO-PHONE", viewer: "panel", waitMs: 50 })
  host.push(keyPacket(2))
  host.push(delta(3))
  const watched = await simulators.watch({ kind: "person" }, { host: LOCAL_HOST, simulator: "MAKO-PHONE", viewer: "panel", waitMs: 50 })
  assert.ok("batch" in watched)
  const batch = decodeControlVideoBatch(Buffer.from(watched.batch, "base64"))
  assert.equal(batch.live, true)
  assert.deepEqual(
    batch.packets.map((packet) => decodeControlVideo(packet).kind),
    ["key", "delta"]
  )

  host.push(poster(4))
  host.push(keyPacket(5))
  const phone = stampedCaller({ kind: "person" }, "gateway:web:phone-device")
  const fromPhone = await simulators.watch(phone, { host: LOCAL_HOST, simulator: "MAKO-PHONE", viewer: "panel", waitMs: 50 })
  assert.ok("batch" in fromPhone)
  const phoneBatch = decodeControlVideoBatch(Buffer.from(fromPhone.batch, "base64"))
  assert.ok(
    phoneBatch.packets.some((packet) => decodeControlVideo(packet).kind === "poster"),
    "a second device gets its own stream, even with the same viewer name"
  )
  assert.ok(phoneBatch.packets.some((packet) => decodeControlVideo(packet).kind === "key"))

  assert.equal(stampedCaller(agent("s-a"), "gateway:desktop:other").via?.from, "desktop:other")
  assert.equal(stampedCaller({ ...agent("s-a"), via: { from: "spoofed" } }, "app").via, undefined, "a local caller can't claim a via")
  await simulators.close()
})

test("a Thread on this Mac drives a simulator on another through the gateway, as the cloud will", async () => {
  const otherHost = fakeHost()
  const leased = { value: true }
  const consent = [{ folder: "/Users/ada/shop", allowed: true, at: 1 }]
  const lookup = sessions({ a: "/Users/ada/shop" })
  const otherSimulators = new Simulators({ hosts: [otherHost], consent: async () => consent, agent: lookup, leases: { leaseOf: () => (leased.value ? "lease-1" : undefined) } })
  const gateway = createFakeGateway()
  const otherRuntime = "d-11111111-1111-4111-8111-111111111111"
  const methods = new HostMethods({
    fixtureDesk: false,
    route: async () => ({ handled: false }),
    presentHistory: (value) => value,
    breadcrumb: () => {},
    declaring: async () => {},
    work: unwatchedWork,
  })
  const unusedSetup = { phase: "unavailable" as const, checkedAt: 0, mac: "test", steps: [] }
  declareSimulatorMethods(
    methods,
    {
      read: async () => unusedSetup,
      press: async () => unusedSetup,
    },
    otherSimulators
  )
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), { runtimeId: otherRuntime, build: "test", invoke: methods.invoke.bind(methods) })
  const session = await gateway.connectClient({ kind: "client", client: "desktop", deviceId: "22222222-2222-4222-8222-222222222222" })
  const calls = gatewayHostCalls(session, { runtimeId: otherRuntime, actor: { kind: "client", client: "desktop", deviceId: "22222222-2222-4222-8222-222222222222" } })
  const hostId = macHostId("11111111-1111-4111-8111-111111111111")
  const shots = join(scratch, "gateway-shots")
  await mkdir(shots, { recursive: true })
  const remote = new RemoteMacSimulators({
    id: hostId,
    label: "Ada's Studio",
    shots,
    call: async (channel, args) => {
      const value = decodeRuntimeValue(await sendWithRepeats(channel, calls.call(channel, args), { runtime: otherRuntime }))
      // SAFETY: every mako:simulators-* reply is a JSON object once decoded.
      return value as object
    },
  })
  const here = new Simulators({
    hosts: [fakeHost({ frames: false })],
    remotes: () => [remote],
    consent: async () => consent,
    agent: lookup,
  })

  const listed = await here.list(agent("s-a"))
  assert.ok("hosts" in listed)
  assert.ok(listed.hosts.some((host) => host.id === hostId))
  const opened = await here.open(agent("s-a"), { host: hostId, simulator: "MAKO-PHONE", url: "https://app.runmako.co" })
  assert.ok("claim" in opened)
  assert.deepEqual(otherHost.done, ["boot MAKO-PHONE", "open-url MAKO-PHONE"])
  const acted = await here.act(agent("s-a"), { host: hostId, simulator: "MAKO-PHONE", action: { kind: "tap", at: { x: 12, y: 34 } } })
  assert.ok("ms" in acted)
  assert.ok(otherHost.done.includes("tap MAKO-PHONE"))

  // The lease ended: no call of that Thread is answered under it any more.
  leased.value = false
  const blocked = await here.open(agent("s-a"), { host: hostId, simulator: "MAKO-PHONE" })
  assert.equal("refused" in blocked && blocked.refused, "not-offered")

  served.close()
  await here.close()
  await otherSimulators.close()
  await methods.close()
})

/** A refusal's answer, as every door that refuses says it. */
const Refused = z.object({ refused: z.string(), why: z.string() })

test("a machine runtime can't name itself the person to skip a simulator's lease", async () => {
  // pr-review's control on #415: through the fake gateway, serveHostThroughGateway, HostMethods and the declared methods.
  const host = fakeHost()
  const simulators = new Simulators({ hosts: [host], consent: async () => [], agent: () => undefined, leases: { leaseOf: () => undefined } })
  const gateway = createFakeGateway()
  const target = "d-11111111-1111-4111-8111-111111111111"
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  const setup = { phase: "unavailable" as const, checkedAt: 0, mac: "test", steps: [] }
  declareSimulatorMethods(methods, { read: async () => setup, press: async () => setup }, simulators)
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), { runtimeId: target, build: "test", invoke: methods.invoke.bind(methods) })
  const actor = { kind: "runtime" as const, runtimeId: "m-unleased.g1" }
  const calls = gatewayHostCalls(await gateway.connectClient(actor), { runtimeId: target, actor })
  try {
    const input = { host: LOCAL_HOST, simulator: "MAKO-PHONE" }
    const open = async (caller: SimulatorCaller) => decodeRuntimeValue(await sendWithRepeats("mako:simulators-open", calls.call("mako:simulators-open", [caller, input]), { runtime: target }))
    const leaseless = await open({ kind: "agent", session: "s-t1", agent: { thread: "t1", session: "s-t1", folder: "/project" } })
    assert.equal(Refused.parse(leaseless).refused, "not-offered")
    const forged = await open({ kind: "person" })
    assert.ok(Refused.safeParse(forged).success, "a machine naming its payload's caller the person is refused")
    assert.deepEqual(host.done, [], "and nothing is booted")
  } finally {
    served.close()
    await gateway.close()
    await simulators.close()
  }
})

test("a machine runtime is never the person at any door that names its caller: agents_* and threads-move", async () => {
  const heard: string[] = []
  const engine = new Proxy({}, { get: (_target, verb: string) => async () => (heard.push(verb), { refused: "unknown-thread", why: "heard" }) })
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  // SAFETY: every verb the declared methods call is a function on the proxy, answering as a refusal does.
  declareAgentMethods(methods, () => engine as AgentOperations & PlacementOperations)
  declareThreadMoveMethods(methods, () => ({ move: async () => (heard.push("threads-move"), { refused: "no-thread", why: "heard" }), asks: () => [], answer: () => {} }))
  const call = async (channel: string, args: unknown[], client: string) => decodeRuntimeValue(await methods.invoke(channel, args, client))
  const person = { kind: "person" }
  const machine = "gateway:runtime:m-1.g1"
  for (const [channel, input] of [["mako:agents-list", {}], ["mako:agents-answer", { to: "fin", answer: "Continue", clientKey: "k" }], ["mako:agents-start", { brief: { objective: "y" }, clientKey: "k" }], ["mako:threads-move", { to: "cloud", clientKey: "k" }]] as const) {
    const answer = await call(channel, [person, input], machine)
    const refusal = Refused.safeParse(answer)
    assert.ok(refusal.success && refusal.data.why !== "heard", `${channel}: a machine's person claim is refused before the engine hears it`)
  }
  assert.deepEqual(heard, [])
  await call("mako:agents-list", [person, {}], "gateway:web:phone-device")
  await call("mako:agents-list", [{ kind: "agent", session: "s-1" }, {}], machine)
  await call("mako:threads-move", [person, { to: "cloud", clientKey: "k" }], "gateway:desktop:d-1")
  assert.deepEqual(heard, ["list", "list", "threads-move"], "the person's own device, and a machine as its agent, are heard")
  await methods.close()
})

test("a machine runtime is never the person at main's later doors either: agents_settle, threads, settings, automations, harnesses", async () => {
  const heard: string[] = []
  const engine = new Proxy({}, { get: (_target, verb: string) => async () => (heard.push(verb), { refused: "unknown-thread", why: "heard" }) })
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  // SAFETY: every verb the declared methods call is a function on the proxy, answering as a refusal does.
  declareAgentMethods(methods, () => engine as AgentOperations & PlacementOperations)
  declareThreadActMethods(methods, () => ({ act: async () => (heard.push("threads-act"), { refused: "failed", why: "heard" }) }))
  declareSettingsMethods(methods, () => ({ call: async () => (heard.push("settings-act"), { refused: "failed", why: "heard" }) }))
  declareAutomationToolMethods(methods, () => ({ act: async () => (heard.push("automations-act"), { refused: "failed", why: "heard" }) }))
  declareHarnessToolMethods(methods, () => ({ act: async () => (heard.push("harnesses-act"), { refused: "failed", why: "heard" }) }))
  const call = async (channel: string, args: unknown[], client: string) => decodeRuntimeValue(await methods.invoke(channel, args, client))
  const person = { kind: "person" }
  const doors = [
    ["mako:agents-settle", { to: "fin", report: "r-1", version: 1, target: { ref: "pr", version: "v1" }, disposition: { kind: "reclaim", reason: "test" }, clientKey: "k" }],
    ["mako:threads-act", { action: "archive", clientKey: "k" }],
    ["mako:settings-act", { action: "read", clientKey: "k" }],
    ["mako:automations-act", { action: "list", clientKey: "k" }],
    ["mako:harnesses-act", { action: "read", clientKey: "k" }],
  ] as const
  for (const [channel, input] of doors) {
    const refusal = Refused.safeParse(await call(channel, [person, input], "gateway:runtime:m-1.g1"))
    assert.ok(refusal.success && refusal.data.why !== "heard", `${channel}: a machine's person claim is refused before the tool hears it`)
  }
  assert.deepEqual(heard, [])
  for (const [channel, input] of doors) await call(channel, [person, input], "gateway:desktop:d-1")
  assert.deepEqual(heard, ["settle", "threads-act", "settings-act", "automations-act", "harnesses-act"], "the person's own device is heard at each")
  await methods.close()
})

test("another place's call releases only under a live lease of its Thread, and a lease lends one simulator and ends only its own claims", async () => {
  const host = fakeHost()
  const TABLET: SimulatorSummary = { ...PHONE, id: "MAKO-TABLET", name: "Mako iPad Air", form: "tablet" }
  host.list = async () => [PHONE, TABLET]
  const leases = new Map<string, string>()
  const simulators = new Simulators({ hosts: [host], consent: async () => [], agent: () => undefined, leases: { leaseOf: (_via, thread) => leases.get(thread) } })
  const from = (thread: string): SimulatorCaller => ({ kind: "agent", session: `s-${thread}`, agent: { thread, session: `s-${thread}`, folder: "/workspace" }, via: { from: "runtime:m-00000000000000a1.g1" } })
  const phone = { host: LOCAL_HOST, simulator: "MAKO-PHONE" }
  const tablet = { host: LOCAL_HOST, simulator: "MAKO-TABLET" }
  const claimOf = async (simulator: string) => {
    const listed = await simulators.list({ kind: "person" })
    return "refused" in listed ? undefined : listed.simulators.find((each) => each.id === simulator)?.claim?.thread
  }

  // t2 holds the phone under its lease; a machine with no lease names t2 and asks to release it.
  leases.set("t2", "lease-t2")
  assert.ok(!("refused" in (await simulators.open(from("t2"), phone))))
  leases.delete("t2")
  const forged = await simulators.release(from("t2"), phone)
  assert.equal("refused" in forged && forged.refused, "not-offered", "no lease, no release, whatever Thread the call names")
  assert.equal(await claimOf("MAKO-PHONE"), "t2", "and t2 still drives it")
  leases.set("t2", "lease-t2")

  // A lease lends one simulator: t1's lease opens the tablet, and the same lease can't open another.
  leases.set("t1", "lease-a")
  await simulators.release(from("t2"), phone)
  assert.ok(!("refused" in (await simulators.open(from("t1"), tablet))))
  const second = await simulators.open(from("t1"), phone)
  assert.equal("refused" in second && second.refused, "not-offered", "one lease, one simulator")

  // Under another lease of the same Thread, the phone; neither lease drives the other's simulator.
  leases.set("t1", "lease-b")
  assert.ok(!("refused" in (await simulators.open(from("t1"), phone))))
  const across = await simulators.act(from("t1"), { ...tablet, action: { kind: "tap", at: { x: 1, y: 1 } } })
  assert.equal("refused" in across && across.refused, "not-offered", "lease-b doesn't drive lease-a's tablet")
  const releasedAcross = await simulators.release(from("t1"), tablet)
  assert.equal("refused" in releasedAcross && releasedAcross.refused, "not-offered", "nor release it")

  // lease-a ends: its tablet goes, and lease-b's phone stays.
  simulators.releaseLease("lease-a")
  assert.equal(await claimOf("MAKO-TABLET"), undefined)
  assert.equal(await claimOf("MAKO-PHONE"), "t1")
  await simulators.close()
})
