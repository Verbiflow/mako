import { hostSpawn } from "../../base/host-command.js"
import type { ChildProcess } from "node:child_process"
import { z } from "zod"
import type { SimulatorOrientation } from "../../contracts/simulators.js"
import type { Run } from "./setup.js"

/** `simctl boot` on one that's up already: CoreSimulator's "Unable to boot device in current state: Booted". */
const ALREADY_BOOTED = 149
/** A cold boot of a new runtime can take a couple of minutes; one already booted answers at once. */
const BOOT_MS = 180_000
const RECORD_STOP_MS = 15_000

/** A simctl command that ran and failed, in simctl's own words. */
export class SimctlFailure extends Error {
  override readonly name = "SimctlFailure"
  readonly args: readonly string[]
  readonly code: number | null
  readonly stderr: string
  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(`simctl ${args[0] ?? ""} failed${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : code === null ? "" : ` (exit ${code})`}`)
    this.args = args
    this.code = code
    this.stderr = stderr
  }
}

/** A screen as its device type's profile says it: pixels, and how many pixels a point is. */
export interface DeviceScreen {
  width: number
  height: number
  scale: number
}

const DeviceTypes = z.object({ devicetypes: z.array(z.object({ identifier: z.string(), bundlePath: z.string().optional() })) })
const Profile = z.object({ mainScreenWidth: z.number(), mainScreenHeight: z.number(), mainScreenScale: z.number() })
const Capabilities = z.object({
  capabilities: z.object({ ScreenDimensionsCapability: z.object({ "main-screen-width": z.number(), "main-screen-height": z.number(), "main-screen-scale": z.number() }) }),
})

/** A device type's screen in points, from its `profile.plist` (`mainScreenWidth` is in pixels). */
export function screenInPoints(profile: DeviceScreen): DeviceScreen {
  return { width: Math.round(profile.width / profile.scale), height: Math.round(profile.height / profile.scale), scale: profile.scale }
}

/** `simctl list devicetypes -j`: where each type's bundle is, so its profile can be read. */
export function parseDeviceTypeBundles(stdout: string): Map<string, string> {
  const parsed = DeviceTypes.safeParse(JSON.parse(stdout))
  return new Map((parsed.data?.devicetypes ?? []).flatMap((type) => (type.bundlePath ? [[type.identifier, type.bundlePath] as const] : [])))
}

/** A device type's `profile.plist`, as `plutil -convert json` prints it. */
export function parseProfile(stdout: string): DeviceScreen | undefined {
  const parsed = Profile.safeParse(JSON.parse(stdout))
  return parsed.success ? { width: parsed.data.mainScreenWidth, height: parsed.data.mainScreenHeight, scale: parsed.data.mainScreenScale } : undefined
}

/** A device type's `capabilities.plist`, where Xcode 27 keeps the screen its `profile.plist` no longer says. */
export function parseCapabilities(stdout: string): DeviceScreen | undefined {
  const screen = Capabilities.safeParse(JSON.parse(stdout)).data?.capabilities.ScreenDimensionsCapability
  return screen && { width: screen["main-screen-width"], height: screen["main-screen-height"], scale: screen["main-screen-scale"] }
}

/** simctl's name for each orientation, as `ui` and serve-sim spell it. */
export const ORIENTATION_NAMES = {
  portrait: "portrait",
  "portrait-upside-down": "portrait_upside_down",
  "landscape-left": "landscape_left",
  "landscape-right": "landscape_right",
} satisfies Record<SimulatorOrientation, string>

/** A recording running: `simctl io recordVideo`, stopped by SIGINT so it writes the file's index before exiting. */
export interface Recording {
  path: string
  stop(): Promise<void>
}

/**
 * Every `xcrun simctl` Mako runs, each through this Xcode's developer folder (`DEVELOPER_DIR`), so neither the active
 * developer folder nor an administrator's `xcode-select` matters. Each throws `SimctlFailure` in simctl's own words.
 */
export class Simctl {
  readonly #run: Run
  readonly #developerDir: string
  readonly #spawn: typeof hostSpawn

  constructor(options: { run: Run; developerDir: string; spawn?: typeof hostSpawn }) {
    this.#run = options.run
    this.#developerDir = options.developerDir
    this.#spawn = options.spawn ?? hostSpawn
  }

  get env(): NodeJS.ProcessEnv {
    return { ...process.env, DEVELOPER_DIR: this.#developerDir }
  }

  async #simctl(args: readonly string[], timeoutMs = 30_000): Promise<string> {
    const result = await this.#run("/usr/bin/xcrun", ["simctl", ...args], { env: this.env, timeoutMs })
    if (result.code !== 0) throw new SimctlFailure(args, result.code, result.stderr)
    return result.stdout
  }

  /** `simctl list -j`, as it printed it, for `parseSimctlList`. */
  list(): Promise<string> {
    return this.#simctl(["list", "-j"])
  }

  /**
   * Up and showing its home screen. `bootstatus` is asked without `-b`, which can stay blocked on Xcode 27 after the
   * device is booted; boot was asked already, so it only waits for the boot in progress.
   */
  async boot(udid: string): Promise<void> {
    const booted = await this.#run("/usr/bin/xcrun", ["simctl", "boot", udid], { env: this.env, timeoutMs: BOOT_MS })
    if (booted.code !== 0 && booted.code !== ALREADY_BOOTED && !/current state: Booted/i.test(booted.stderr)) throw new SimctlFailure(["boot", udid], booted.code, booted.stderr)
    await this.#simctl(["bootstatus", udid], BOOT_MS)
  }

  async shutdown(udid: string): Promise<void> {
    const result = await this.#run("/usr/bin/xcrun", ["simctl", "shutdown", udid], { env: this.env, timeoutMs: 60_000 })
    if (result.code !== 0 && !/current state: Shutdown/i.test(result.stderr)) throw new SimctlFailure(["shutdown", udid], result.code, result.stderr)
  }

  /** Opens a page in the simulator's default browser, Mobile Safari. */
  async openUrl(udid: string, url: string): Promise<void> {
    await this.#simctl(["openurl", udid, url])
  }

  async screenshot(udid: string, path: string): Promise<void> {
    await this.#simctl(["io", udid, "screenshot", "--type=png", path])
  }

  async appearance(udid: string, appearance: "light" | "dark"): Promise<void> {
    await this.#simctl(["ui", udid, "appearance", appearance])
  }

  async addMedia(udid: string, files: readonly string[]): Promise<void> {
    await this.#simctl(["addmedia", udid, ...files], 120_000)
  }

  /** The screen of each device type this Xcode has, read from the type's own profile, or its capabilities on Xcode 27. */
  async screens(types: readonly string[]): Promise<Map<string, DeviceScreen>> {
    const bundles = parseDeviceTypeBundles(await this.#simctl(["list", "devicetypes", "-j"]))
    const screens = new Map<string, DeviceScreen>()
    for (const type of types) {
      const bundle = bundles.get(type)
      if (!bundle) continue
      const read = async (file: string, parse: (stdout: string) => DeviceScreen | undefined) => {
        const plist = await this.#run("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${bundle}/Contents/Resources/${file}`])
        return plist.code === 0 ? parse(plist.stdout) : undefined
      }
      const screen = (await read("profile.plist", parseProfile)) ?? (await read("capabilities.plist", parseCapabilities))
      if (screen) screens.set(type, screen)
    }
    return screens
  }

  /** Starts recording the screen as H.264 into `path`; `stop` ends it and waits for the file to be whole. */
  async record(udid: string, path: string): Promise<Recording> {
    const child = this.#spawn("/usr/bin/xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", path], { env: this.env, stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    // simctl says "Recording started" on stderr once its first frame is in; until then a SIGINT can leave no file.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000)
      child.stderr?.on("data", () => {
        if (/Recording started/i.test(stderr)) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", (code) => {
        clearTimeout(timer)
        reject(new SimctlFailure(["io", udid, "recordVideo"], code, stderr))
      })
    })
    return { path, stop: () => stopRecording(child, () => stderr, udid) }
  }
}

async function stopRecording(child: ChildProcess, stderr: () => string, udid: string): Promise<void> {
  if (child.exitCode !== null) return
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  child.kill("SIGINT")
  const timer = setTimeout(() => child.kill("SIGKILL"), RECORD_STOP_MS)
  const code = await exited
  clearTimeout(timer)
  if (code !== 0 && code !== null) throw new SimctlFailure(["io", udid, "recordVideo"], code, stderr())
}
