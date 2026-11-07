import type {
  CheckState,
  RuntimeFound,
  SetupConsent,
  SetupProgress,
  SetupSimulator,
  SetupStep,
  SetupStepId,
  SetupTool,
  SimulatorSetup,
  XcodeFound,
} from "../../contracts/simulator-setup.js"
import { z } from "zod"
import { NEEDED_STEPS } from "../../contracts/simulator-setup.js"

/**
 * What the setup line is read from, as Xcode's own tools and Mako's folders said it. Pure, so every state a Mac can
 * be in is a fixture (`scripts/test-simulator-setup.ts`); `readSetupFacts` reads the real ones.
 */
export interface SetupFacts {
  platform: NodeJS.Platform
  /** `macOS 26.6.2, arm64`. */
  mac: string
  freeBytes: number
  /** `xcode-select -p`; null when it printed nothing. */
  developerDir: string | null
  xcodes: XcodeFound[]
  /** For the Xcode Mako uses (`chooseXcode`); `unknown` without one. */
  license: CheckState
  firstLaunch: CheckState
  /** iOS runtimes, from `simctl list -j`; empty until the license lets `simctl` answer. */
  runtimes: RuntimeFound[]
  /** The simulator SDK's iOS version this Xcode builds for (`xcodebuild -showsdks -json`). */
  wantedRuntime?: string
  devices: SimDevice[]
  deviceTypes: SimDeviceType[]
  /** Each runtime's device types, by identifier: a device's own runtime runs only it. */
  runtimeTypes?: Record<string, string[]>
  tools: SetupTool[]
  consent: SetupConsent[]
  tried?: { at: number; firstFrameMs?: number }
  /** A host here can boot a simulator and stream it, so the try can run. */
  canTry: boolean
  /** Setup was ready once on this Mac, so anything missing now is a breakage to repair, not a step not yet taken. */
  wasReady: boolean
  /** The person pressed Get Xcode and Mako watches for it to land. */
  waitingForXcode: boolean
  progress?: SetupProgress
  checkedAt: number
}

export interface SimDevice {
  udid: string
  name: string
  runtime: string
  type: string
  state: string
  available: boolean
}

export interface SimDeviceType {
  identifier: string
  name: string
  family: string
  /** The oldest iOS it runs, as simctl numbers it (`27.0` is 1769472): newer models run only newer iOS. */
  minRuntime?: number
}

/** Room to ask for before each download: Xcode expands its App Store download to about 12 GB, and an iOS runtime is about 8 GB. */
export const XCODE_NEEDS_BYTES = 30e9
export const RUNTIME_NEEDS_BYTES = 10e9

/** Mako's own simulators are named for it, so the person's own are never changed. */
export const MAKO_SIMULATOR_PREFIX = "Mako "

/** `xcode-select -p`: the active developer folder, or null. */
export function parseDeveloperDir(stdout: string): string | null {
  const line = stdout.trim().split("\n")[0]?.trim()
  return line ? line : null
}

/** Whether the active developer folder is inside this Xcode, rather than the Command Line Tools or another Xcode. */
export function selects(developerDir: string | null, xcode: XcodeFound): boolean {
  return developerDir !== null && (developerDir === xcode.path || developerDir.startsWith(`${xcode.path}/`))
}

/** The Xcode Mako uses: the one the developer folder points into, else the newest. */
export function chooseXcode(xcodes: readonly XcodeFound[], developerDir: string | null): XcodeFound | undefined {
  return xcodes.find((xcode) => selects(developerDir, xcode)) ?? [...xcodes].sort((a, b) => compareVersions(b.version, a.version))[0]
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

/**
 * `xcodebuild -license check` and `-checkFirstLaunchStatus`: exit 0 is done. Anything that names the license or the
 * first launch is needed; anything else (no Xcode, a tool that couldn't start) couldn't be asked.
 */
export function parseCheck(code: number | null, output: string, about: "license" | "first-launch"): CheckState {
  if (code === 0) return "done"
  if (/requires Xcode|command line tools instance|unable to find utility/i.test(output)) return "unknown"
  if (about === "license" ? /licen[cs]e/i.test(output) : code !== null) return "needed"
  return "unknown"
}

/** One entry of a list, or null when simctl writes it in a shape this doesn't know, so one odd entry isn't a failed read. */
function entries<Entry extends z.ZodType>(entry: Entry) {
  return z.array(entry.nullable().catch(null)).catch([])
}

const SimctlListing = z.object({
  runtimes: entries(
    z.object({
      identifier: z.string(),
      platform: z.string().optional(),
      name: z.string().optional(),
      version: z.string().optional(),
      buildversion: z.string().optional(),
      isAvailable: z.boolean().optional(),
      supportedDeviceTypes: z.array(z.object({ identifier: z.string() }).nullable().catch(null)).optional().catch(undefined),
    })
  ).default([]),
  devices: z.record(z.string(), entries(z.object({ udid: z.string(), name: z.string(), deviceTypeIdentifier: z.string().optional(), state: z.string().optional(), isAvailable: z.boolean().optional() }))).catch({}).default({}),
  devicetypes: entries(z.object({ identifier: z.string(), name: z.string(), productFamily: z.string().optional(), minRuntimeVersion: z.number().optional() })).default([]),
})

const ShowSdks = entries(z.object({ platform: z.string().optional(), sdkVersion: z.string().optional() }))

export interface SimctlList {
  runtimes: RuntimeFound[]
  devices: SimDevice[]
  deviceTypes: SimDeviceType[]
  runtimeTypes: Record<string, string[]>
}

/** `xcrun simctl list -j`: the iOS runtimes, every iOS simulator, and the iPhone and iPad types. */
export function parseSimctlList(stdout: string): SimctlList {
  const parsed = SimctlListing.safeParse(JSON.parse(stdout))
  if (!parsed.success) throw new Error("simctl list printed something other than an object")
  const list = parsed.data
  const runtimes = list.runtimes.flatMap((entry): RuntimeFound[] =>
    entry?.platform === "iOS"
      ? [{ identifier: entry.identifier, name: entry.name ?? entry.identifier, version: entry.version ?? "", ...(entry.buildversion !== undefined && { build: entry.buildversion }), available: entry.isAvailable === true }]
      : []
  )
  const runtimeTypes = Object.fromEntries(
    list.runtimes.flatMap((entry) => (entry?.platform === "iOS" && entry.supportedDeviceTypes ? [[entry.identifier, entry.supportedDeviceTypes.flatMap((type) => (type ? [type.identifier] : []))]] : []))
  )
  const ios = new Set(runtimes.map((runtime) => runtime.identifier))
  const devices = Object.entries(list.devices).flatMap(([runtime, listed]) =>
    ios.has(runtime)
      ? listed.flatMap((entry): SimDevice[] =>
          entry ? [{ udid: entry.udid, name: entry.name, runtime, type: entry.deviceTypeIdentifier ?? "", state: entry.state ?? "Shutdown", available: entry.isAvailable === true }] : []
        )
      : []
  )
  const deviceTypes = list.devicetypes.flatMap((entry): SimDeviceType[] =>
    entry && (entry.productFamily === "iPhone" || entry.productFamily === "iPad")
      ? [{ identifier: entry.identifier, name: entry.name, family: entry.productFamily, ...(entry.minRuntimeVersion !== undefined && { minRuntime: entry.minRuntimeVersion }) }]
      : []
  )
  return { runtimes, devices, deviceTypes, runtimeTypes }
}

/** `xcodebuild -showsdks -json`: the iOS simulator SDK's version, the runtime this Xcode wants. */
export function parseWantedRuntime(stdout: string): string | undefined {
  const versions = ShowSdks.parse(JSON.parse(stdout)).flatMap((entry) => (entry?.platform === "iphonesimulator" && entry.sdkVersion !== undefined ? [entry.sdkVersion] : []))
  return versions.sort(compareVersions).at(-1)
}

export interface DownloadLine {
  fraction: number
  doneBytes?: number
  totalBytes?: number
}

/**
 * One line of `xcodebuild -downloadPlatform iOS`, as `Downloading iOS 26.1 Simulator (23B80): 7.8% (572.8 MB of 7.35
 * GB)`. Some locales write `7,8 %` and `572,8 MB`. Lines without a percentage say nothing about progress.
 */
export function parseDownloadLine(line: string): DownloadLine | undefined {
  const percent = /(\d+(?:[.,]\d+)?)\s?%/.exec(line)
  if (!percent?.[1]) return undefined
  const fraction = Math.min(1, Number(percent[1].replace(",", ".")) / 100)
  const sizes = /\((\d+(?:[.,]\d+)?)\s?([KMGT]?B) of (\d+(?:[.,]\d+)?)\s?([KMGT]?B)\)/.exec(line)
  if (!sizes?.[1] || !sizes[2] || !sizes[3] || !sizes[4]) return { fraction }
  return { fraction, doneBytes: bytes(sizes[1], sizes[2]), totalBytes: bytes(sizes[3], sizes[4]) }
}

const UNITS = new Map([
  ["B", 1],
  ["KB", 1e3],
  ["MB", 1e6],
  ["GB", 1e9],
  ["TB", 1e12],
])

function bytes(amount: string, unit: string): number {
  return Math.round(Number(amount.replace(",", ".")) * (UNITS.get(unit) ?? 1))
}

/** The device type each form is made as, when this Xcode has one. */
export interface FormTypes {
  phone?: SimDeviceType
  tablet?: SimDeviceType
}

/**
 * The newest iPhone Pro and the newest 13-inch iPad Pro this Xcode knows that `runs` (the runtime's types, when simctl
 * says), the forms the suite grades on. Newest is the one needing the newest iOS, then the plain model over a memory
 * variant, then the later in simctl's list, which older Xcodes write oldest first and Xcode 27 newest first.
 */
export function chooseForms(types: readonly SimDeviceType[], runs?: readonly string[]): FormTypes {
  const runnable = runs?.length ? types.filter((type) => runs.includes(type.identifier)) : types
  const newest = (test: RegExp, family: string) =>
    runnable
      .map((type, index) => ({ type, index }))
      .filter(({ type }) => type.family === family && test.test(type.name))
      .sort((a, b) => (a.type.minRuntime ?? 0) - (b.type.minRuntime ?? 0) || b.type.name.length - a.type.name.length || a.index - b.index)
      .at(-1)?.type
  const phone = newest(/^iPhone \d+ Pro$/, "iPhone") ?? newest(/^iPhone \d+/, "iPhone")
  const tablet = newest(/^iPad Pro 13-inch/, "iPad") ?? newest(/^iPad Pro/, "iPad")
  return { ...(phone && { phone }), ...(tablet && { tablet }) }
}

/** Mako's simulator for each form: the one it made, if it's there on an available runtime, else the one it would make. */
export function makoSimulators(facts: Pick<SetupFacts, "devices" | "deviceTypes" | "runtimes" | "runtimeTypes" | "wantedRuntime">): SetupSimulator[] {
  const runtime = chooseRuntime(facts.runtimes, facts.wantedRuntime, facts.runtimeTypes)
  const forms = chooseForms(facts.deviceTypes, runtime && facts.runtimeTypes?.[runtime.identifier])
  const available = new Set(facts.runtimes.filter((runtime) => runtime.available).map((runtime) => runtime.identifier))
  return (["phone", "tablet"] as const).flatMap((form): SetupSimulator[] => {
    const type = forms[form]
    const family = form === "phone" ? "iPhone" : "iPad"
    const made = facts.devices.find(
      (device) =>
        device.name.startsWith(`${MAKO_SIMULATOR_PREFIX}${family}`) && device.available && available.has(device.runtime) && (!type || device.type === type.identifier)
    ) ?? facts.devices.find((device) => device.name.startsWith(`${MAKO_SIMULATOR_PREFIX}${family}`) && device.available && available.has(device.runtime))
    if (made)
      return [{ form, name: made.name, type: made.type, udid: made.udid, runtime: made.runtime, state: simulatorState(made.state) }]
    if (!type) return []
    return [{ form, name: `${MAKO_SIMULATOR_PREFIX}${type.name}`, type: type.identifier }]
  })
}

function simulatorState(state: string): NonNullable<SetupSimulator["state"]> {
  switch (state) {
    case "Booted":
      return "booted"
    case "Booting":
      return "booting"
    case "Shutting Down":
      return "shutting-down"
    default:
      return "shutdown"
  }
}

/**
 * The runtime Mako's simulators use: the available one matching what Xcode wants, else the newest available. Of two
 * with one version, the one running the most device types: Xcode 27 adds runtimes made for a single device.
 */
export function chooseRuntime(runtimes: readonly RuntimeFound[], wanted: string | undefined, runtimeTypes: Record<string, string[]> = {}): RuntimeFound | undefined {
  const runs = (runtime: RuntimeFound) => runtimeTypes[runtime.identifier]?.length ?? 0
  const available = runtimes.filter((runtime) => runtime.available).sort((a, b) => runs(b) - runs(a))
  return (
    (wanted ? available.find((runtime) => runtime.version === wanted || runtime.version.startsWith(`${wanted}.`)) : undefined) ??
    [...available].sort((a, b) => compareVersions(b.version, a.version))[0]
  )
}

/** The setup line from the facts: every step, its state and the one fix the window offers beside it. */
export function setupFromFacts(facts: SetupFacts): SimulatorSetup {
  const base = { checkedAt: facts.checkedAt, mac: facts.mac, ...(facts.progress && { progress: facts.progress }) }
  const working = (step: SetupStep["id"]) => facts.progress?.step === step
  const xcode = chooseXcode(facts.xcodes, facts.developerDir)
  const disk = { freeBytes: facts.freeBytes, needBytes: (xcode ? 0 : XCODE_NEEDS_BYTES) + RUNTIME_NEEDS_BYTES }
  const steps: SetupStep[] = []

  if (xcode) steps.push({ id: "xcode", state: "done", xcode, ...(facts.developerDir && { developerDir: facts.developerDir }), disk })
  else
    steps.push({
      id: "xcode",
      state: facts.waitingForXcode ? "working" : "yours",
      fix: "get-xcode",
      ...(facts.developerDir && { developerDir: facts.developerDir }),
      disk,
      ...(facts.freeBytes < XCODE_NEEDS_BYTES && { problem: `Xcode needs about ${gigabytes(XCODE_NEEDS_BYTES)} free while it installs; this Mac has ${gigabytes(facts.freeBytes)}.` }),
    })

  const selected = xcode ? selects(facts.developerDir, xcode) : false
  // Mako runs this Xcode's tools through its own folder (`DEVELOPER_DIR`), so a Mac left on the Command Line Tools is
  // finished once the license and first launch are: switching the active folder would cost a password for nothing.
  const finished = Boolean(xcode) && facts.license === "done" && facts.firstLaunch === "done"
  steps.push({
    id: "finish",
    state: !xcode ? "later" : finished ? "done" : working("finish") ? "working" : "yours",
    selected,
    license: facts.license,
    firstLaunch: facts.firstLaunch,
    ...(xcode && !finished && { fix: "finish-xcode" as const }),
  })

  const runtime = chooseRuntime(facts.runtimes, facts.wantedRuntime, facts.runtimeTypes)
  // simctl answers once the license is accepted, whichever folder is active, since Mako asks through this Xcode's own.
  const canList = Boolean(xcode) && facts.license === "done"
  steps.push({
    id: "runtime",
    state: !canList ? "later" : runtime ? "done" : working("runtime") ? "working" : "yours",
    ...(runtime && { runtime }),
    ...(facts.wantedRuntime && { wanted: facts.wantedRuntime }),
    ...(canList && !runtime && { fix: "download-runtime" as const }),
    ...(canList && !runtime && facts.freeBytes < RUNTIME_NEEDS_BYTES && { problem: `The iOS runtime needs about ${gigabytes(RUNTIME_NEEDS_BYTES)} free; this Mac has ${gigabytes(facts.freeBytes)}.` }),
  })

  const simulators = runtime ? makoSimulators(facts) : []
  const made = simulators.length === 2 && simulators.every((simulator) => simulator.udid)
  steps.push({
    id: "simulators",
    state: !runtime ? "later" : made ? "done" : working("simulators") ? "working" : "yours",
    simulators,
    ...(runtime && !made && { fix: "create-simulators" as const }),
    ...(runtime && simulators.length < 2 && { problem: "This Xcode doesn't list an iPhone Pro and a 13-inch iPad Pro to make." }),
  })

  // The tools don't need Xcode, so they can install while it downloads.
  const toolsDone = facts.tools.every((tool) => tool.installed === tool.version)
  steps.push({
    id: "tools",
    state: toolsDone ? "done" : working("tools") ? "working" : "yours",
    tools: facts.tools,
    ...(!toolsDone && { fix: "install-tools" as const }),
  })

  steps.push({
    id: "agents",
    state: facts.consent.length ? "done" : "yours",
    projects: facts.consent,
    ...(!facts.consent.length && { fix: "allow-agents" as const }),
  })

  const needed = NEEDED_STEPS.every((id) => steps.find((step) => step.id === id)?.state === "done")
  steps.push({
    id: "try",
    state: !needed || !facts.canTry ? "later" : facts.tried ? "done" : working("try") ? "working" : "yours",
    ...(facts.tried && { at: facts.tried.at, ...(facts.tried.firstFrameMs !== undefined && { firstFrameMs: facts.tried.firstFrameMs }) }),
    ...(needed && facts.canTry && !facts.tried && { fix: "try" as const }),
    ...(!facts.canTry && { problem: "Booting and streaming a simulator from Mako is built next, on a Mac with Xcode." }),
  })

  if (facts.platform !== "darwin") return { ...base, phase: "unavailable", steps }
  const broken = !needed && facts.wasReady
  return { ...base, phase: needed ? "ready" : broken ? "broken" : "setting-up", steps: steps.map((step) => held(step, broken)) }
}

/** A step waiting on the person is stuck when a problem holds it, or when it was done once and went. */
function held(step: SetupStep, broken: boolean): SetupStep {
  if (step.state !== "yours") return step
  if (step.problem) return { ...step, state: "stuck" }
  if (broken && NEEDED_STEPS.includes(step.id)) return { ...step, state: "stuck", problem: WENT.get(step.id) ?? "This was set up before and isn't now." }
  return step
}

const WENT = new Map<SetupStepId, string>([
  ["xcode", "Xcode isn't in Applications any more."],
  ["finish", "Xcode changed, as an update does, and wants its license and first launch again."],
  ["runtime", "The iOS runtime isn't installed any more."],
  ["simulators", "One of Mako's simulators was deleted."],
  ["tools", "Mako's simulator tools are missing or not the pinned versions."],
])

export function gigabytes(value: number): string {
  return `${Math.round(value / 1e9)} GB`
}
