import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveRuntime, type Advertisement } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { CapabilitySchema, satisfies, type Capability, type CapabilityQuery, type Grant, type Need } from "@mako/protocol/borrow"
import { ADVERTISE_EVERY_MS, Advertiser } from "@mako/host/base/advertiser"
import { ADVERTISED_CLIS, MAX_CAPABILITIES, probeCapabilities, simulatorCapabilities, type CapabilityProbeDeps, type SimulatorFacts } from "@mako/host/base/capabilities"
import { LentHere } from "@mako/host/base/lent"
import { CliReadings } from "@mako/host/harnesses/cli-readings"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { LocalBorrowing } from "@mako/host/base/local-borrowing"
import { readSetupFacts, type Run } from "@mako/host/control/simulators/setup"
import { setupFromFacts } from "@mako/host/control/simulators/setup-facts"
import { LocalSimulatorHost, localDriving } from "@mako/host/control/simulators/local-host"
import { PINNED_TOOLS, toolEntry, toolsRoot } from "@mako/host/control/simulators/tools"
import { setupStep } from "@mako/host/contracts/simulator-setup"

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
    onPath: async () => false,
    clis: async () => [{ command: "git", version: "2.51.0" }, { command: "gh", version: "2.83.1" }, { command: "node", version: "24.19.0" }, { command: "xcodebuild", version: "26.1" }],
    simulators: async () => ready,
    androidEmulators: async () => [{ avd: "Pixel_9", api: "35" }],
    ...overrides,
  }
}

/** A grant over capable devices that wants each of `requires`: what the person lends. */
function lend(requires: [CapabilityQuery, ...CapabilityQuery[]], devices?: string[]): Grant {
  return {
    id: `g-${JSON.stringify(requires)}-${devices?.join() ?? ""}`, resource: { kind: "operation", ref: "ios-simulator" }, source: { kind: "capable", requires, ...(devices && { devices }) },
    scope: { level: "account", account: "acct" }, mode: "relay", access: "run", lifetime: { until: "revoked" }, ask: "never", secret: false,
    grantedBy: { kind: "person", account: "acct" }, grantedAt: 1, version: 1,
  }
}
const lendsMacs = { lending: async () => [lend([{ capability: "macos" }, { capability: "xcode" }])], devices: async () => ["d-mac"] }

{
  // A Mac with Xcode, Mako's simulators, an emulator and a few CLIs: each a fact, in a stable order.
  const found = await probeCapabilities(mac())
  for (const capability of found) CapabilitySchema.parse(capability)
  assert.deepEqual(found, [
    { capability: "macos", version: "26.1", attributes: { arch: "arm64" } },
    { capability: "xcode", version: "26.1" },
    { capability: "gpu", attributes: { api: "metal", chip: "Apple M3 Max" } },
    { capability: "cli", version: "2.51.0", attributes: { command: "git" } },
    { capability: "cli", version: "2.83.1", attributes: { command: "gh" } },
    { capability: "cli", version: "24.19.0", attributes: { command: "node" } },
    { capability: "cli", version: "26.1", attributes: { command: "xcodebuild" } },
    { capability: "android-emulator", version: "35", attributes: { avd: "Pixel_9", api: "35" } },
    { capability: "ios-simulator", version: "26.1", attributes: { runtime: "iOS 26.1", device: "iPad Air", form: "tablet" } },
    { capability: "ios-simulator", version: "26.1", attributes: { runtime: "iOS 26.1", device: "iPhone 17 Pro", form: "phone" } },
  ])
  // A CLI is its name and version: nothing it's signed in as is read, so nothing of it can be sent.
  assert.ok(found.filter((capability) => capability.capability === "cli").every((capability) => Object.keys(capability.attributes ?? {}).join() === "command"))
}

{
  // A CLI is advertised by name and the version Mako reads of it, so a need for "git 2.*" can be matched.
  const found = await probeCapabilities(mac({ clis: async () => [{ command: "git", version: "2.51.0" }, { command: "node", version: "24.19.0" }] }))
  const git = found.find((capability) => capability.capability === "cli" && capability.attributes?.command === "git")
  assert.deepEqual(git, { capability: "cli", version: "2.51.0", attributes: { command: "git" } })
  assert.ok(satisfies(found, [{ capability: "cli", version: "2.*", where: { command: "git" } }]), "a versioned need for git matches")
  assert.equal(found.some((capability) => capability.capability === "cli" && capability.attributes?.command === "gh"), false, "a tool Mako read no version of isn't advertised")
}

{
  // A place advertises only what the person lends: nothing lent, nothing advertised; a grant over capable devices
  // that wants a simulator, and names this device or none, lends its simulators and nothing else.
  const probed: Capability[] = [
    { capability: "macos", version: "26.1", attributes: { arch: "arm64" } },
    { capability: "cli", version: "2.51.0", attributes: { command: "git" } },
    { capability: "ios-simulator", version: "26.1", attributes: { runtime: "iOS 26.1", device: "iPhone 17 Pro", form: "phone" } },
  ]
  const told = async (grants: Grant[]) => {
    const heard: Advertisement[] = []
    const advertiser = new Advertiser({ probe: async () => probed, lending: async () => grants, devices: async () => ["mac-1"], room: () => ({ slots: { used: 0, of: 4 } }), sinks: [(advertisement) => void heard.push(advertisement)] })
    await advertiser.probe()
    return heard.at(-1)?.capabilities ?? []
  }
  assert.deepEqual(await told([]), [], "nothing lent, nothing advertised")
  assert.deepEqual((await told([lend([{ capability: "ios-simulator" }])])).map((capability) => capability.capability), ["ios-simulator"], "a simulator lent, and only that")
  assert.deepEqual(await told([lend([{ capability: "ios-simulator" }], ["mac-2"])]), [], "a grant that names another device lends nothing here")
  assert.deepEqual((await told([lend([{ capability: "ios-simulator" }], ["mac-1"])])).length, 1, "one naming this device does")
}

{
  // CLI readings: what RuntimeUpdates already read is taken as it is, and each other advertised tool has its version
  // read once, again only when its binary changed. A tool that isn't here, or says no version, is left out.
  const here = new Map([["git", "/usr/bin/git"], ["node", "/opt/node/bin/node"], ["docker", "/usr/local/bin/docker"]])
  const signatures = new Map([["/usr/bin/git", "git-1"], ["/opt/node/bin/node", "node-1"], ["/usr/local/bin/docker", "docker-1"]])
  const spawned: string[] = []
  const readings = new CliReadings({
    installed: () => ({ "claude-code": { binary: "/Users/me/.local/bin/claude", installed: "2.1.3" }, codex: { binary: "/opt/node/bin/codex" }, git: { binary: "/usr/bin/git", installed: "2.51.0" } }),
    processes: new DiscoveryProcesses(),
    resolve: (command) => here.get(command) ?? null,
    signature: async (binary) => signatures.get(binary) ?? "",
    version: async (binary, args) => {
      spawned.push(`${binary} ${args.join(" ")}`)
      if (binary.endsWith("docker")) throw new Error("the daemon isn't running")
      return "v24.19.0\n"
    },
  })
  assert.deepEqual(await readings.read(), [{ command: "claude", version: "2.1.3" }, { command: "git", version: "2.51.0" }, { command: "node", version: "24.19.0" }])
  assert.deepEqual(spawned, ["/opt/node/bin/node --version", "/usr/local/bin/docker --version"], "git came from RuntimeUpdates' reading, with no second read")
  await readings.read()
  assert.equal(spawned.length, 2, "an unchanged binary isn't read again, even one that said no version")
  signatures.set("/opt/node/bin/node", "node-2")
  await readings.read()
  assert.deepEqual(spawned.slice(2), ["/opt/node/bin/node --version"], "a changed binary is read again")
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
  const bounded = await probeCapabilities(mac({ simulators: async () => many, clis: async () => ADVERTISED_CLIS.map((command) => ({ command, version: "1.0.0" })) }))
  assert.equal(bounded.length, MAX_CAPABILITIES)
  const simulators = bounded.filter((capability) => capability.capability === "ios-simulator")
  assert.equal(simulators.filter((capability) => capability.version === "26.1").length, 40, "every simulator of the newest runtime stays")
  assert.ok(simulators.length < 80 && simulators.slice(40).every((capability) => capability.version === "18.4"), "what's left out is the oldest runtime's")
  assert.equal(bounded.filter((capability) => capability.capability === "cli").length, ADVERTISED_CLIS.length)
}

{
  // A Mac whose xcode-select names the Command Line Tools, with Xcode kept where only Spotlight finds it: its simulators
  // still run through that Xcode's own developer folder, so it still advertises Xcode and each simulator by its runtime.
  const dataRoot = join(root, "setup")
  const xcodeApp = join(root, "Developer", "Xcode-27.app")
  const developer = join(xcodeApp, "Contents", "Developer")
  mkdirSync(join(developer, "usr", "bin"), { recursive: true })
  writeFileSync(join(developer, "usr", "bin", "xcodebuild"), "")
  for (const spec of PINNED_TOOLS) {
    const entry = toolEntry(toolsRoot(dataRoot), spec)
    mkdirSync(join(entry, ".."), { recursive: true })
    writeFileSync(entry, "")
    writeFileSync(join(toolsRoot(dataRoot), spec.name, spec.version, ".install-complete"), spec.version)
  }
  const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-2"
  const phone = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"
  const tablet = "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5"
  const listing = {
    runtimes: [{ identifier: runtime, platform: "iOS", name: "iOS 27.2", version: "27.2", isAvailable: true, supportedDeviceTypes: [{ identifier: phone }, { identifier: tablet }] }],
    devicetypes: [{ identifier: phone, name: "iPhone 18 Pro", productFamily: "iPhone" }, { identifier: tablet, name: "iPad Pro 13-inch (M5)", productFamily: "iPad" }],
    devices: { [runtime]: [{ udid: "PHONE-UDID", name: "Mako iPhone 18 Pro", deviceTypeIdentifier: phone, state: "Shutdown", isAvailable: true }, { udid: "TABLET-UDID", name: "Mako iPad Pro 13-inch (M5)", deviceTypeIdentifier: tablet, state: "Shutdown", isAvailable: true }] },
  }
  const developerDirs: string[] = []
  const run: Run = async (file, args, options) => {
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })
    if (file === "/usr/bin/xcode-select") return ok("/Library/Developer/CommandLineTools\n")
    if (file === "/usr/bin/mdfind") return ok(`${xcodeApp}\n`)
    if (file === "/usr/bin/plutil") return ok(args.at(-1)!.endsWith("Info.plist") ? JSON.stringify({ CFBundleShortVersionString: "27.0" }) : JSON.stringify({ ProductBuildVersion: "27A100" }))
    if (options?.env?.DEVELOPER_DIR) developerDirs.push(options.env.DEVELOPER_DIR)
    if (file === "/usr/bin/xcrun" && args[0] === "simctl") return ok(JSON.stringify(listing))
    if (args.includes("-showsdks")) return ok(JSON.stringify([{ platform: "iphonesimulator", sdkVersion: "27.2" }]))
    return ok("")
  }
  const setup = setupFromFacts(await readSetupFacts({ dataRoot, run, platform: "darwin", state: { wasReady: false }, consent: [], canTry: true, applications: [join(root, "no-applications")], now: Date.now() }))
  assert.equal(setupStep(setup, "xcode")?.xcode?.path, xcodeApp, "Spotlight's Xcode is the one used")
  assert.ok(developerDirs.length && developerDirs.every((dir) => dir === developer), "every Xcode tool runs through its own developer folder, never xcode-select's")
  // The real driving, over the same fake commands: a listing reads screens and drives nothing.
  const driving = localDriving({ dataRoot, hub: { entry: join(root, "no-hub.js") }, run })
  const host = new LocalSimulatorHost({ setup: async () => setup, folder: join(root, "sims"), driving })
  const facts: SimulatorFacts = { ios: (await host.summary()).platforms.ios, simulators: await host.list(), xcode: setupStep(setup, "xcode")!.xcode!.version }
  assert.deepEqual(facts.ios, { ready: true })
  const advertised = await probeCapabilities(mac({ simulators: async () => facts }))
  assert.deepEqual(advertised.filter((capability) => capability.capability === "xcode" || capability.capability === "ios-simulator"), [
    { capability: "xcode", version: "27.0" },
    { capability: "ios-simulator", version: "27.2", attributes: { runtime: "iOS 27.2", device: "iPad Pro 13-inch (M5)", form: "tablet" } },
    { capability: "ios-simulator", version: "27.2", attributes: { runtime: "iOS 27.2", device: "iPhone 18 Pro", form: "phone" } },
  ])
}

{
  // The advertiser: first said once probed; an unchanged room says nothing; a freed slot says it; the hour says it anyway.
  let now = 1_000
  let room = { slots: { used: 1, of: 6 }, load: "14 cores, 36 GB" }
  let capabilities = [{ capability: "macos", version: "26.1" }]
  const heard: Advertisement[] = []
  const advertiser = new Advertiser({
    probe: async () => capabilities,
    ...lendsMacs,
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
  const advertiser = new Advertiser({ probe: async () => [{ capability: "macos", version: "26.1" }], ...lendsMacs, room: () => ({ slots: { used: 2, of: 6 } }), sinks: [(advertisement) => runtime.advertise(advertisement)] })
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
    // A borrower at a device borrows only under a grant naming it: this Mac's own Threads, here.
    devices: ["mac"],
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
