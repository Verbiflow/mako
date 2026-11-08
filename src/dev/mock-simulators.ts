import type { SetupFix, SetupStep, SimulatorSetup } from "@mako/host/contracts/simulator-setup"
import { encodeControlVideoBatch } from "@mako/control-runtime/contracts"
import type { SimulatorClaim, SimulatorsActResult, SimulatorsListed, SimulatorsOpenResult, SimulatorsWatchResult } from "@mako/host/contracts/simulators"
import type { HostEvent } from "@/lib/types"

const MAC = "macOS 26.6.2, arm64"
const CLT = "/Library/Developer/CommandLineTools"
const XCODE = { path: "/Applications/Xcode.app", version: "26.1", build: "17B55" }
const RUNTIME = { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1", name: "iOS 26.1", version: "26.1", build: "23B80", available: true }
const PHONE = { form: "phone" as const, name: "Mako iPhone 17 Pro", type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" }
const TABLET = { form: "tablet" as const, name: "Mako iPad Pro 13-inch (M5)", type: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB" }
const TOOLS = [
  { name: "serve-sim", version: "0.1.48", purpose: "streams the screen and sends touches", license: "Apache-2.0" },
  { name: "inspect-webkit", version: "0.0.5", purpose: "reads Safari's pages through WebKit's inspector", license: "MIT" },
  { name: "agent-device", version: "0.21.36", purpose: "drives iOS for agents", license: "MIT" },
]
const DISK = { freeBytes: 193e9, needBytes: 40e9 }

const SCENARIOS = ["clt", "waiting", "low-disk", "finish", "prompt-closed", "downloading", "make", "ready", "broken", "unavailable"] as const
type Scenario = (typeof SCENARIOS)[number]

/**
 * Settings › Simulators for `?mock&simulators=<scenario>`: `clt` (the default) is a Mac with only the Command Line
 * Tools, as this one; `waiting` after Get Xcode; `low-disk` without room for it; `finish` with Xcode not set up;
 * `prompt-closed` after the password prompt was closed; `downloading` the iOS runtime at 43%; `make` with Mako's
 * simulators still to make; `ready`; `broken` once ready, its runtime since removed; `unavailable` off macOS.
 * Each press moves the line on as the host would.
 */
export function mockSimulators(emit: (event: HostEvent) => void) {
  const params = new URLSearchParams(globalThis.location?.search)
  const folder = params.get("folder") ?? "/Users/you/shop"
  let current = scenario(SCENARIOS.find((named) => named === params.get("simulators")) ?? "clt", folder)
  const since = Date.now()
  let held: SimulatorClaim | undefined
  const say = (next: SimulatorSetup) => {
    current = next
    emit({ type: "simulator-setup", setup: current })
    return current
  }
  return {
    simulatorSetup: async () => current,
    simulatorSetupPress: async (fix: SetupFix, input?: { folder?: string; allowed?: boolean }) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (fix === "allow-agents" && input?.folder) {
        const projects = [{ folder: input.folder, allowed: input.allowed !== false, at: Date.now() }, ...(stepOf(current, "agents")?.projects ?? []).filter((project) => project.folder !== input.folder)]
        return say(withStep(current, { id: "agents", state: "done", projects }))
      }
      const next = new Map<SetupFix, Scenario>([
        ["get-xcode", "waiting"],
        ["finish-xcode", "downloading"],
        ["download-runtime", "make"],
        ["create-simulators", "ready"],
      ]).get(fix)
      return next ? say(scenario(next, folder)) : current
    },
    simulatorsList: async (): Promise<SimulatorsListed> => panel(params.get("panel"), since, held),
    simulatorsOpen: async (input: { simulator: string }): Promise<SimulatorsOpenResult> => {
      held = { thread: "person", title: "You", since: Date.now(), lastAt: Date.now(), generation: 3 }
      const simulator = panel("person", since, held).simulators.find((entry) => entry.id === input.simulator)
      return simulator ? { simulator, claim: held, next: "" } : { refused: "not-found", why: "No such simulator." }
    },
    simulatorsAct: async (): Promise<SimulatorsActResult> => ({ ms: 12 }),
    simulatorsRelease: async () => ({ released: true }),
    // The stand-in shows its frame as an image, never a stream.
    simulatorsWatch: async (): Promise<SimulatorsWatchResult> => ({ live: false, batch: btoa(String.fromCharCode(...encodeControlVideoBatch({ live: false, packets: [] }))) }),
  }
}

/**
 * The desk panel for `?mock&panel=<who>`: a stand-in host's iPhone and iPad (a desktop engine, labelled as not iOS),
 * the iPhone driven by a Thread (`agent`), by the person (`person`), or by nobody (`idle`); `none` lists nothing.
 */
function panel(who: string | null, since: number, held: SimulatorClaim | undefined): SimulatorsListed {
  if (who === "none" || who === null) return { hosts: [{ id: "local", label: "This Mac", kind: "local", platforms: { ios: { ready: false, blocker: "no-xcode", why: "This Mac has no Xcode, so no iOS Simulator.", fix: "Settings › Simulators" }, android: { ready: false, blocker: "not-built", why: "Android emulators come after iOS." } } }], simulators: [], consent: "allowed" }
  const claim: SimulatorClaim | undefined =
    held ?? (who === "agent" ? { thread: "t-scroll", conversation: "c-scroll", title: "Fix the jump when a reply streams", since: since - 4 * 60_000, lastAt: since - 3_000, generation: 2 } : who === "person" ? { thread: "person", title: "You", since, lastAt: since, generation: 3 } : undefined)
  const base = { hostId: "stand-in", platform: "ios" as const, state: "booted" as const, standIn: true as const }
  return {
    hosts: [{ id: "stand-in", label: "WebKit stand-in", kind: "stand-in", platforms: { ios: { ready: true }, android: { ready: false, blocker: "not-built", why: "Android emulators come after iOS." } } }],
    simulators: [
      { ...base, id: "stand-in-phone", name: "iPhone 17 Pro", form: "phone", runtime: "WebKit 26.0 at iPhone size", screen: { width: 402, height: 874, scale: 3 }, ...(claim && { claim }) },
      { ...base, id: "stand-in-tablet", name: "iPad Pro 13-inch (M5)", form: "tablet", runtime: "WebKit 26.0 at iPad size", screen: { width: 1032, height: 1376, scale: 2 } },
    ],
    consent: "allowed",
  }
}

function scenario(name: Scenario, folder: string): SimulatorSetup {
  const at = Date.now()
  const consent = [{ folder, allowed: true, at: at - 86_400_000 }]
  const xcode = (state: SetupStep["state"], extra: Partial<Extract<SetupStep, { id: "xcode" }>> = {}): SetupStep => ({ id: "xcode", state, developerDir: CLT, disk: DISK, fix: "get-xcode", ...extra })
  const toolsDone: SetupStep = { id: "tools", state: "done", tools: TOOLS.map((tool) => ({ ...tool, installed: tool.version })) }
  const toolsToDo: SetupStep = { id: "tools", state: "yours", fix: "install-tools", tools: TOOLS }
  const later = (id: "finish" | "runtime" | "simulators"): SetupStep =>
    id === "finish" ? { id, state: "later", selected: false, license: "unknown", firstLaunch: "unknown" } : id === "runtime" ? { id, state: "later" } : { id, state: "later", simulators: [] }
  const tryLater: SetupStep = { id: "try", state: "later", problem: "Booting and streaming a simulator from Mako is built next, on a Mac with Xcode." }
  const agents = (done: boolean): SetupStep => (done ? { id: "agents", state: "done", projects: consent } : { id: "agents", state: "yours", fix: "allow-agents", projects: [] })
  const xcodeDone: SetupStep = { id: "xcode", state: "done", xcode: XCODE, developerDir: `${XCODE.path}/Contents/Developer`, disk: { freeBytes: 161e9, needBytes: 10e9 } }
  const finished: SetupStep = { id: "finish", state: "done", selected: true, license: "done", firstLaunch: "done" }
  const made: SetupStep = { id: "simulators", state: "done", simulators: [{ ...PHONE, udid: "5D1C8E52-7A0B-4C35-9C1B-2E6C2F0B6A11", runtime: RUNTIME.identifier, state: "shutdown" }, { ...TABLET, udid: "A3F09B7D-14C2-4E8A-B5D0-77E1C9F4D2E3", runtime: RUNTIME.identifier, state: "shutdown" }] }
  const line = (phase: SimulatorSetup["phase"], steps: SetupStep[], extra: Partial<SimulatorSetup> = {}): SimulatorSetup => ({ phase, checkedAt: at, mac: MAC, steps, ...extra })
  switch (name) {
    case "clt":
      return line("setting-up", [xcode("yours"), later("finish"), later("runtime"), later("simulators"), toolsToDo, agents(false), tryLater])
    case "waiting":
      return line("setting-up", [xcode("working"), later("finish"), later("runtime"), later("simulators"), toolsDone, agents(true), tryLater])
    case "low-disk":
      return line("setting-up", [xcode("stuck", { disk: { freeBytes: 18e9, needBytes: 40e9 }, problem: "Xcode needs about 30 GB free while it installs; this Mac has 18 GB." }), later("finish"), later("runtime"), later("simulators"), toolsToDo, agents(false), tryLater])
    case "finish":
    case "prompt-closed":
      return line(
        "setting-up",
        [{ ...xcodeDone, developerDir: CLT }, { id: "finish", state: "yours", fix: "finish-xcode", selected: false, license: "needed", firstLaunch: "needed" }, later("runtime"), later("simulators"), toolsDone, agents(true), tryLater],
        name === "prompt-closed" ? { failure: { fix: "finish-xcode", message: "The password prompt was closed, so Xcode's setup wasn't finished. Press Finish setup when you're ready.", at } } : {}
      )
    case "downloading":
      return line("setting-up", [xcodeDone, finished, { id: "runtime", state: "working", wanted: "26.1" }, later("simulators"), toolsDone, agents(true), tryLater], {
        progress: { step: "runtime", fraction: 0.43, doneBytes: 3.16e9, totalBytes: 7.35e9, line: "Downloading iOS 26.1 Simulator (23B80): 43.0% (3.16 GB of 7.35 GB)", startedAt: at - 140_000 },
      })
    case "make":
      return line("setting-up", [xcodeDone, finished, { id: "runtime", state: "done", runtime: RUNTIME, wanted: "26.1" }, { id: "simulators", state: "yours", fix: "create-simulators", simulators: [PHONE, TABLET] }, toolsDone, agents(true), tryLater])
    case "ready":
      return line("ready", [xcodeDone, finished, { id: "runtime", state: "done", runtime: RUNTIME, wanted: "26.1" }, made, toolsDone, agents(true), tryLater])
    case "broken":
      return line("broken", [xcodeDone, finished, { id: "runtime", state: "stuck", wanted: "26.1", fix: "download-runtime", problem: "The iOS runtime isn't installed any more." }, { id: "simulators", state: "later", simulators: [] }, toolsDone, agents(true), tryLater])
    case "unavailable":
      return line("unavailable", [], { mac: "linux, x64" })
  }
}

function stepOf<Id extends SetupStep["id"]>(setup: SimulatorSetup, id: Id): Extract<SetupStep, { id: Id }> | undefined {
  return setup.steps.find((step): step is Extract<SetupStep, { id: Id }> => step.id === id)
}

function withStep(setup: SimulatorSetup, step: SetupStep): SimulatorSetup {
  return { ...setup, steps: setup.steps.map((existing) => (existing.id === step.id ? step : existing)) }
}
