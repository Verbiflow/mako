import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveRuntime, type Advertisement } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { CapabilitySchema, type Grant, type Need } from "@mako/protocol/borrow"
import { ADVERTISE_EVERY_MS, Advertiser } from "@mako/host/base/advertiser"
import { ADVERTISED_CLIS, MAX_CAPABILITIES, probeCapabilities, simulatorCapabilities, type CapabilityProbeDeps, type SimulatorFacts } from "@mako/host/base/capabilities"
import { LentHere } from "@mako/host/base/lent"
import { LocalBorrowing } from "@mako/host/base/local-borrowing"

/**
 * What a device advertises to borrowing's brokers: what it can serve, probed from the device and never a value, and its
 * room under the one pool its Fins and lent operations share. It says so on a change, as its runtime link enrols, and
 * hourly; its own broker routes a need over capable devices to it by what it said.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-borrow-capabilities-")))
const ios = (name: string, runtime = "iOS 26.1", form: "phone" | "tablet" = "phone") => ({ hostId: "local", id: `${name}-udid`, name, platform: "ios" as const, runtime, form, state: "shutdown" as const })
const ready: SimulatorFacts = { ios: { ready: true }, xcode: "26.1", simulators: [ios("Mako iPhone 17 Pro"), ios("Mako iPad Air", "iOS 26.1", "tablet")] }

function mac(overrides: Partial<CapabilityProbeDeps> = {}): CapabilityProbeDeps {
  return {
    platform: "darwin",
    arch: "arm64",
    run: async (file) => (file.endsWith("sw_vers") ? "26.1\n" : file.endsWith("sysctl") ? "Apple M3 Max\n" : undefined),
    onPath: async (command) => ["git", "gh", "node", "xcodebuild"].includes(command),
    simulators: async () => ready,
    androidEmulators: async () => [{ avd: "Pixel_9", api: "35" }],
    ...overrides,
  }
}

{
  // A Mac with Xcode, Mako's simulators, an emulator and a few CLIs: each a fact, in a stable order.
  const found = await probeCapabilities(mac())
  for (const capability of found) CapabilitySchema.parse(capability)
  assert.deepEqual(found, [
    { capability: "macos", version: "26.1", attributes: { arch: "arm64" } },
    { capability: "xcode", version: "26.1" },
    { capability: "gpu", attributes: { api: "metal", chip: "Apple M3 Max" } },
    { capability: "cli", attributes: { command: "git" } },
    { capability: "cli", attributes: { command: "gh" } },
    { capability: "cli", attributes: { command: "node" } },
    { capability: "cli", attributes: { command: "xcodebuild" } },
    { capability: "android-emulator", version: "35", attributes: { avd: "Pixel_9", api: "35" } },
    { capability: "ios-simulator", version: "26.1", attributes: { runtime: "iOS 26.1", device: "iPad Air", form: "tablet" } },
    { capability: "ios-simulator", version: "26.1", attributes: { runtime: "iOS 26.1", device: "iPhone 17 Pro", form: "phone" } },
  ])
  // A CLI is there or not: nothing it's signed in as is read, so nothing of it can be sent.
  assert.ok(found.filter((capability) => capability.capability === "cli").every((capability) => Object.keys(capability.attributes ?? {}).join() === "command"))
}

{
  // Simulators are advertised only while they run here: a Mac without Mako's tools advertises none, and says why itself.
  const blocked: SimulatorFacts = { ...ready, ios: { ready: false, blocker: "no-tools", why: "Mako's simulator tools aren't installed yet." } }
  assert.deepEqual(simulatorCapabilities(blocked), [])
  const found = await probeCapabilities(mac({ simulators: async () => blocked }))
  assert.equal(found.some((capability) => capability.capability === "ios-simulator"), false)
  assert.equal(found.some((capability) => capability.capability === "xcode"), true, "Xcode is still Xcode")
  // A failing read leaves its capability out rather than failing the probe.
  const quiet = await probeCapabilities(mac({ run: async () => undefined, simulators: async () => { throw new Error("simctl hung") } }))
  assert.deepEqual(quiet.slice(0, 2), [{ capability: "macos", attributes: { arch: "arm64" } }, { capability: "gpu", attributes: { api: "metal" } }])
  // Linux says its architecture, and CUDA when nvidia-smi is there.
  const linux = await probeCapabilities({ platform: "linux", arch: "x64", run: async () => "NVIDIA L4\n", onPath: async (command) => command === "nvidia-smi" })
  assert.deepEqual(linux, [{ capability: "linux", attributes: { arch: "x64" } }, { capability: "gpu", attributes: { api: "cuda", chip: "NVIDIA L4" } }])
  // However many simulators, one advertisement holds at most its bound, the newest runtimes kept.
  const many: SimulatorFacts = { ios: { ready: true }, simulators: Array.from({ length: 80 }, (_, at) => ios(`iPhone ${at}`, at < 40 ? "iOS 18.4" : "iOS 26.1")) }
  const bounded = await probeCapabilities(mac({ simulators: async () => many, onPath: async () => true }))
  assert.equal(bounded.length, MAX_CAPABILITIES)
  const simulators = bounded.filter((capability) => capability.capability === "ios-simulator")
  assert.equal(simulators.filter((capability) => capability.version === "26.1").length, 40, "every simulator of the newest runtime stays")
  assert.ok(simulators.length < 80 && simulators.slice(40).every((capability) => capability.version === "18.4"), "what's left out is the oldest runtime's")
  assert.equal(bounded.filter((capability) => capability.capability === "cli").length, ADVERTISED_CLIS.length)
}

{
  // The advertiser: first said once probed; an unchanged room says nothing; a freed slot says it; the hour says it anyway.
  let now = 1_000
  let room = { slots: { used: 1, of: 6 }, load: "14 cores, 36 GB" }
  let capabilities = [{ capability: "macos", version: "26.1" }]
  const heard: Advertisement[] = []
  const advertiser = new Advertiser({
    probe: async () => capabilities,
    room: () => room,
    now: () => now,
    sinks: [
      () => {
        throw new Error("a broken sink")
      },
      (advertisement) => void heard.push(advertisement),
    ],
  })
  assert.equal(advertiser.current(), undefined, "nothing to say before the first probe")
  await advertiser.probe()
  assert.deepEqual(heard, [{ capabilities, slots: { used: 1, of: 6 }, load: "14 cores, 36 GB", at: 1_000 }], "a sink that throws keeps no other from hearing")
  now += 15_000
  advertiser.roomChanged()
  await advertiser.probe()
  assert.equal(heard.length, 1, "the same capabilities and room aren't said again")
  room = { ...room, slots: { used: 0, of: 6 } }
  advertiser.roomChanged()
  assert.deepEqual(heard.at(-1)?.slots, { used: 0, of: 6 }, "a freed slot is said at once")
  capabilities = [...capabilities, { capability: "xcode", version: "26.1" }]
  await advertiser.probe()
  assert.equal(heard.at(-1)?.capabilities.length, 2, "an install is said")
  const count = heard.length
  now += ADVERTISE_EVERY_MS
  await advertiser.due()
  assert.equal(heard.length, count + 1, "the hour says it, though nothing changed")
  assert.equal(advertiser.current()?.at, now, "a link enrolling now hears it as it stands")
}

{
  // Over the runtime link: said as it enrols, then on change, as the gateway hears it.
  const gateway = createFakeGateway()
  const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "d-mac", build: "test", handle: async () => { throw new Error("no calls") } })
  const advertiser = new Advertiser({ probe: async () => [{ capability: "macos", version: "26.1" }], room: () => ({ slots: { used: 2, of: 6 } }), sinks: [(advertisement) => runtime.advertise(advertisement)] })
  await advertiser.probe()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(gateway.advertisements("d-mac").map((advertisement) => advertisement.slots), [{ used: 2, of: 6 }])
  runtime.close()
  await gateway.close()
}

{
  // This device's own broker takes the advertisement, and a need under a grant over capable devices routes to it.
  const broker = new LocalBorrowing({ folder: join(root, "broker"), device: "mac", account: "acct", sources: { operation: async () => ({ answer: "yes", version: "g1" }) } })
  const grant: Grant = {
    id: "simulators",
    resource: { kind: "operation", ref: "ios-simulator" },
    source: { kind: "capable", requires: [{ capability: "ios-simulator", where: { runtime: "iOS 26*" } }] },
    scope: { level: "account", account: "acct" },
    mode: "relay",
    access: "run",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: false,
    grantedBy: { kind: "person", account: "acct" },
    grantedAt: 1,
    version: 1,
  }
  assert.equal(await broker.grant(grant), undefined)
  const need: Need = { kind: "operation", ref: "ios-simulator", for: { account: "acct", repository: "acct/shop", thread: "t1", place: { kind: "device", device: "mac" } }, why: "check the sign-in page on an iPhone", correlationId: "sim-1" }
  const before = await broker.borrow(need)
  assert.ok("pending" in before && before.pending === "capacity" && before.why === "none-capable", `nothing advertised yet: ${JSON.stringify(before)}`)
  const facts = await probeCapabilities(mac())
  await broker.advertise(facts, { used: 0, of: 6 })
  await broker.advertise(facts, { used: 0, of: 6 })
  const leased = await broker.borrow({ ...need, correlationId: "sim-2" })
  assert.ok("lease" in leased && leased.lease.device === "mac" && leased.lease.session?.state === "starting", `the device that advertised it serves it: ${JSON.stringify(leased)}`)
}

{
  // What a device lends: each lease one place, said in words, and its end frees it.
  const lent = new LentHere()
  let changes = 0
  lent.subscribe(() => changes++)
  lent.add({ lease: "l1", what: "an iOS simulator", for: "a cloud Thread", since: 1 })
  lent.add({ lease: "l1", what: "an iOS simulator", for: "a cloud Thread", since: 1 })
  assert.equal(lent.count(), 1)
  assert.deepEqual(lent.words(), ["an iOS simulator for a cloud Thread"])
  lent.remove("l1")
  lent.remove("l1")
  assert.equal(lent.count(), 0)
  assert.equal(changes, 2, "each real change is heard once")
}

console.log("borrow capabilities: ok")
