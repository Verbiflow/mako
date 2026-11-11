import { hostExecFile } from "./host-command.js"
import { access, readdir, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import type { Capability } from "@mako/protocol/borrow"
import type { SimulatorAvailability, SimulatorSummary } from "../contracts/simulators.js"
import { nodePlatform } from "./platform.js"

/**
 * What this device can serve another place, as borrowing's advertisement names it (`borrow.ts`): its OS and
 * architecture, Xcode by version, each simulator it can run (runtime and device), its Android emulators, its GPU, and
 * its command-line tools by name and installed version, as Mako's readings have them (`CliReadings`). Each is a fact
 * read from the device, never a value: nothing a tool is signed in with is read or sent.
 */
export const ADVERTISED_CLIS = ["git", "gh", "node", "npm", "bun", "python3", "docker", "kubectl", "terraform", "aws", "gcloud", "az", "fastlane", "xcodebuild", "adb"] as const

/** The most capabilities one advertisement carries (`advertise`'s bound): simulators past it are left out, oldest runtime first. */
export const MAX_CAPABILITIES = 64

/** What the simulator host reads of this Mac's simulators: whether iOS ones run here, and which. */
export interface SimulatorFacts {
  ios: SimulatorAvailability
  simulators: readonly SimulatorSummary[]
  /** Xcode's version, from the setup line. */
  xcode?: string
}

export interface CapabilityProbeDeps {
  platform: NodeJS.Platform
  arch: string
  /** Runs a read-only command, its output or undefined when it fails or isn't there. */
  run(file: string, args: readonly string[]): Promise<string | undefined>
  /** Whether `command` is an executable on the PATH (for a GPU's own tool). */
  onPath(command: string): Promise<boolean>
  /** The command-line tools here with the version Mako read of each (`CliReadings`); one with no version read is left out. */
  clis?(): Promise<ReadonlyArray<{ command: string; version: string }>>
  simulators?(): Promise<SimulatorFacts | undefined>
  /** This device's Android virtual devices: each AVD's name and its API level when its config says. */
  androidEmulators?(): Promise<Array<{ avd: string; api?: string }>>
}

/** Every capability this device has now, in a stable order, never more than `MAX_CAPABILITIES`. */
export async function probeCapabilities(deps: CapabilityProbeDeps): Promise<Capability[]> {
  const [system, gpu, clis, simulators, android] = await Promise.all([
    systemCapability(deps),
    gpuCapability(deps),
    deps.clis?.().catch(() => []) ?? [],
    deps.simulators?.().catch(() => undefined),
    deps.androidEmulators?.().catch(() => []) ?? [],
  ])
  const found: Capability[] = []
  if (system) found.push(system)
  if (simulators?.xcode) found.push({ capability: "xcode", version: simulators.xcode })
  if (gpu) found.push(gpu)
  for (const { command, version } of clis) found.push({ capability: "cli", version: clip(version), attributes: { command: clip(command) } })
  for (const emulator of android) found.push({ capability: "android-emulator", ...(emulator.api && { version: emulator.api }), attributes: { avd: clip(emulator.avd), ...(emulator.api && { api: emulator.api }) } })
  const room = MAX_CAPABILITIES - found.length
  return [...found, ...simulatorCapabilities(simulators).slice(0, Math.max(0, room))]
}

/**
 * One `ios-simulator` per simulator this Mac can run now, newest runtime first: only while iOS simulators are ready
 * here, so a Mac without Xcode, a runtime or Mako's tools advertises none (its blocker stays its own Settings' to say).
 */
export function simulatorCapabilities(facts: SimulatorFacts | undefined): Capability[] {
  if (!facts?.ios.ready) return []
  const seen = new Set<string>()
  return facts.simulators
    .filter((simulator) => simulator.platform === "ios" && !simulator.standIn)
    .map((simulator): Capability => {
      const version = /(\d+(?:\.\d+)*)/.exec(simulator.runtime)?.[1]
      return { capability: "ios-simulator", ...(version && { version }), attributes: { runtime: clip(simulator.runtime), device: clip(deviceName(simulator.name)), form: simulator.form } }
    })
    .filter((capability) => {
      const key = JSON.stringify(capability)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => compareVersions(right.version ?? "0", left.version ?? "0") || (left.attributes!.device! < right.attributes!.device! ? -1 : 1))
}

/** The device a simulator is, without the name Mako gives its own ("Mako iPhone 17 Pro" is an iPhone 17 Pro). */
function deviceName(name: string): string {
  return name.replace(/^Mako /, "")
}

async function systemCapability(deps: CapabilityProbeDeps): Promise<Capability | undefined> {
  if (deps.platform === "darwin") {
    const version = (await deps.run("/usr/bin/sw_vers", ["-productVersion"]))?.trim()
    return { capability: "macos", ...(version && { version }), attributes: { arch: deps.arch } }
  }
  if (deps.platform === "linux") return { capability: "linux", attributes: { arch: deps.arch } }
  return undefined
}

async function gpuCapability(deps: CapabilityProbeDeps): Promise<Capability | undefined> {
  if (deps.platform === "darwin") {
    const chip = (await deps.run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]))?.trim()
    return { capability: "gpu", attributes: { api: "metal", ...(chip && { chip: clip(chip) }) } }
  }
  if (deps.platform === "linux" && (await deps.onPath("nvidia-smi").catch(() => false))) {
    const name = (await deps.run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]))?.split("\n")[0]?.trim()
    return { capability: "gpu", attributes: { api: "cuda", ...(name && { chip: clip(name) }) } }
  }
  return undefined
}

function clip(text: string): string {
  return text.slice(0, 128)
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0)
    if (difference) return difference
  }
  return 0
}


/** This device's own reads for the probe: commands with a short timeout, the PATH as the host has it. */
export function deviceProbe(simulators?: () => Promise<SimulatorFacts | undefined>, clis?: CapabilityProbeDeps["clis"]): CapabilityProbeDeps {
  return {
    platform: nodePlatform(),
    arch: process.arch,
    run: (file, args) => new Promise((resolve) => void hostExecFile(file, args, { timeout: 3_000 }, (error, stdout) => resolve(error ? undefined : stdout))),
    onPath: (command) => onPath(command),
    ...(simulators && { simulators }),
    ...(clis && { clis }),
    androidEmulators: () => androidEmulators(),
  }
}

async function onPath(command: string): Promise<boolean> {
  for (const folder of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const found = await access(join(folder, command), constants.X_OK).then(() => true, () => false)
    if (found) return true
  }
  return false
}

/**
 * The AVDs Android's emulator can start: each `<name>.ini` in `~/.android/avd`, while the SDK's emulator is there, with
 * the API level its system image names (`image.sysdir.1=system-images/android-35/…`).
 */
async function androidEmulators(): Promise<Array<{ avd: string; api?: string }>> {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), nodePlatform() === "darwin" ? "Library/Android/sdk" : "Android/Sdk")
  const emulator = await access(join(sdk, "emulator", "emulator"), constants.X_OK).then(() => true, () => false)
  if (!emulator) return []
  const avds = join(homedir(), ".android", "avd")
  const names = (await readdir(avds).catch((): string[] => [])).filter((name) => name.endsWith(".ini")).map((name) => name.slice(0, -".ini".length))
  return Promise.all(
    names.slice(0, 8).map(async (avd) => {
      const config = await readFile(join(avds, `${avd}.avd`, "config.ini"), "utf8").catch(() => "")
      const api = /^image\.sysdir\.1\s*=\s*system-images\/android-(\d+)/m.exec(config)?.[1]
      return api ? { avd, api } : { avd }
    })
  )
}
