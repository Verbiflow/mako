import { hostSpawn } from "../../base/host-command.js"
import { hostExecFile } from "../../base/host-command.js"
import { mkdir, readdir, readFile, stat, statfs, writeFile } from "node:fs/promises"
import { arch, homedir } from "node:os"
import { dirname, join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { z } from "zod"
import type { SetupConsent, SetupFix, SetupProgress, SetupStepId, SimulatorSetup, XcodeFound } from "../../contracts/simulator-setup.js"
import { XCODE_APP_STORE_URL, setupStep } from "../../contracts/simulator-setup.js"
import type { HostJobs } from "../../base/host-jobs.js"
import { hostLog, hostWarn } from "../../base/host-log.js"
import { nodePlatform, systemVersion } from "../../base/platform.js"
import {
  chooseRuntime,
  chooseXcode,
  makoSimulators,
  parseCheck,
  parseDeveloperDir,
  parseDownloadLine,
  parseSimctlList,
  parseWantedRuntime,
  setupFromFacts,
  type SetupFacts,
} from "./setup-facts.js"
import { installTools, readTools, toolsRoot } from "./tools.js"

/** One command's answer; a command that exits non-zero answers too, since its words are what's read. */
export type Run = (file: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>

export const runCommand: Run = (file, args, options = {}) =>
  new Promise((resolve) => {
    hostExecFile(file, [...args], { env: options.env ?? process.env, timeout: options.timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (Number.isInteger(error.code) ? Number(error.code) : null) : 0
      resolve({ code, stdout: String(stdout), stderr: error && !stderr && code === null ? error.message : String(stderr) })
    })
  })

/** Where an App Store Xcode lands, and a person's own Applications folder. */
const APPLICATION_FOLDERS = ["/Applications", join(homedir(), "Applications")]
/** How often to look for Xcode in the Applications folders while the person gets it, and for how long. */
const XCODE_LOOK_MS = 30_000
const XCODE_WAIT_MS = 12 * 60 * 60_000
const PROGRESS_EMIT_MS = 250

const FIX_STEP = {
  "get-xcode": "xcode",
  "finish-xcode": "finish",
  "download-runtime": "runtime",
  "create-simulators": "simulators",
  "install-tools": "tools",
  "allow-agents": "agents",
  try: "try",
} satisfies Record<SetupFix, SetupStepId>
/** Steps over in a moment, answered done rather than started. */
const QUICK: ReadonlySet<SetupFix> = new Set(["get-xcode", "allow-agents"])

const StateSchema = z.object({
  wasReady: z.boolean().default(false),
  waitingSince: z.number().optional(),
  tried: z.object({ at: z.number(), firstFrameMs: z.number().optional() }).optional(),
})
const XcodeInfo = z.object({ CFBundleShortVersionString: z.string() })
const XcodeVersion = z.object({ ProductBuildVersion: z.string() })
const ConsentSchema = z.object({ projects: z.record(z.string(), z.object({ allowed: z.boolean(), at: z.number() })).default({}) })

/** The developer folder inside an Xcode bundle, which every Xcode tool Mako runs is pointed at. */
export function developerFolder(xcode: XcodeFound): string {
  return join(xcode.path, "Contents", "Developer")
}

/** Spotlight's query for every Xcode on this Mac, wherever it was put: an Xcode kept outside Applications counts too. */
const XCODE_QUERY = "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"

/**
 * Each complete Xcode on this Mac: in the Applications folders, and anywhere Spotlight finds one. A bundle counts once
 * its `xcodebuild` is there, which an App Store download's isn't until it's done. Whichever folder `xcode-select` names,
 * Mako runs a found Xcode's tools through its own developer folder (`DEVELOPER_DIR`).
 */
export async function findXcodes(run: Run, folders: readonly string[]): Promise<XcodeFound[]> {
  const [listed, spotlight] = await Promise.all([
    Promise.all(folders.map(async (folder) => (await readdir(folder).catch(() => [])).filter((name) => /^Xcode.*\.app$/.test(name)).map((name) => join(folder, name)))),
    run("/usr/bin/mdfind", [XCODE_QUERY], { timeoutMs: 5_000 }).then(
      (found) => (found.code === 0 ? found.stdout.split("\n").map((line) => line.trim()).filter((line) => line.endsWith(".app")) : []),
      () => []
    ),
  ])
  const bundles = [...new Set([...listed.flat(), ...spotlight])]
  const found = await Promise.all(
    bundles.map(async (path): Promise<XcodeFound | undefined> => {
      if (!(await stat(join(path, "Contents", "Developer", "usr", "bin", "xcodebuild")).then(() => true, () => false))) return undefined
      const version = (await plist(run, join(path, "Contents", "Info.plist"), XcodeInfo))?.CFBundleShortVersionString
      if (!version) return undefined
      const build = (await plist(run, join(path, "Contents", "version.plist"), XcodeVersion))?.ProductBuildVersion
      return { path, version, ...(build !== undefined && { build }) }
    })
  )
  return found.filter((xcode) => xcode !== undefined)
}

async function plist<Schema extends z.ZodType>(run: Run, file: string, schema: Schema): Promise<z.infer<Schema> | undefined> {
  const { code, stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])
  if (code !== 0) return undefined
  try {
    return schema.safeParse(JSON.parse(stdout)).data
  } catch {
    return undefined
  }
}

/** The facts on this Mac now: Xcode's own tools are asked through the chosen Xcode, whichever folder is active. */
export async function readSetupFacts(options: {
  dataRoot: string
  run: Run
  platform: NodeJS.Platform
  state: z.infer<typeof StateSchema>
  consent: SetupConsent[]
  progress?: SetupProgress
  canTry: boolean
  applications: readonly string[]
  now: number
}): Promise<SetupFacts> {
  const { run, platform } = options
  const mac = platform === "darwin" ? `macOS ${systemVersion()}, ${arch()}` : `${platform}, ${arch()}`
  const freeBytes = await statfs(options.dataRoot).catch(() => statfs(dirname(options.dataRoot))).then((fs) => fs.bavail * fs.bsize, () => 0)
  const tools = await readTools(toolsRoot(options.dataRoot))
  const facts: SetupFacts = {
    platform,
    mac,
    freeBytes,
    developerDir: null,
    xcodes: [],
    license: "unknown",
    firstLaunch: "unknown",
    runtimes: [],
    devices: [],
    deviceTypes: [],
    tools,
    consent: options.consent,
    ...(options.state.tried && { tried: options.state.tried }),
    canTry: options.canTry,
    wasReady: options.state.wasReady,
    waitingForXcode: options.state.waitingSince !== undefined && options.now - options.state.waitingSince < XCODE_WAIT_MS,
    ...(options.progress && { progress: options.progress }),
    checkedAt: options.now,
  }
  if (platform !== "darwin") return facts
  const [select, xcodes] = await Promise.all([run("/usr/bin/xcode-select", ["-p"]), findXcodes(run, options.applications)])
  facts.developerDir = select.code === 0 ? parseDeveloperDir(select.stdout) : null
  facts.xcodes = xcodes
  const xcode = chooseXcode(xcodes, facts.developerDir)
  if (!xcode) return facts
  const env = { ...process.env, DEVELOPER_DIR: developerFolder(xcode) }
  const xcodebuild = join(developerFolder(xcode), "usr", "bin", "xcodebuild")
  const [license, firstLaunch] = await Promise.all([run(xcodebuild, ["-license", "check"], { env }), run(xcodebuild, ["-checkFirstLaunchStatus"], { env })])
  facts.license = parseCheck(license.code, license.stdout + license.stderr, "license")
  facts.firstLaunch = parseCheck(firstLaunch.code, firstLaunch.stdout + firstLaunch.stderr, "first-launch")
  if (facts.license !== "done") return facts
  const [list, sdks] = await Promise.all([run("/usr/bin/xcrun", ["simctl", "list", "-j"], { env, timeoutMs: 30_000 }), run(xcodebuild, ["-showsdks", "-json"], { env })])
  try {
    if (list.code === 0) Object.assign(facts, parseSimctlList(list.stdout))
    if (sdks.code === 0) {
      const wanted = parseWantedRuntime(sdks.stdout)
      if (wanted) facts.wantedRuntime = wanted
    }
  } catch (error) {
    hostWarn("simulators", "setup read unparsed", { error: error instanceof Error ? error.message : String(error) })
  }
  return facts
}

/**
 * Follows setting simulators up on this Mac: reads the line from Xcode's own tools and Mako's folders, runs each step
 * the person presses, and tells every window as the line changes. What it keeps of its own is whether the line was
 * ever ready (so a missing part is a breakage), when the person went for Xcode, the last try, and per-project consent.
 */
export class SimulatorSetupFollower {
  readonly #dataRoot: string
  readonly #run: Run
  readonly #emit: (setup: SimulatorSetup) => void
  readonly #platform: NodeJS.Platform
  readonly #now: () => number
  readonly #waiting
  readonly #stopLooking: () => void
  #last: SimulatorSetup | undefined
  #lastText: string | undefined
  #reading: Promise<SimulatorSetup> | undefined
  #again: Promise<SimulatorSetup> | undefined
  #progress: SetupProgress | undefined
  #failure: SimulatorSetup["failure"]
  #pressing: SetupFix | undefined
  #working: Promise<void> | undefined
  #xcodePaths: string | undefined
  readonly #tryIt: (() => Promise<{ firstFrameMs: number }>) | undefined
  readonly #applications: readonly string[]

  /** `tryIt`: boots one of Mako's simulators, opens Safari and waits for its first streamed frame; without it there's no try. */
  constructor(options: { dataRoot: string; jobs: HostJobs; emit: (setup: SimulatorSetup) => void; run?: Run; platform?: NodeJS.Platform; now?: () => number; tryIt?: () => Promise<{ firstFrameMs: number }>; applications?: readonly string[] }) {
    this.#dataRoot = options.dataRoot
    this.#applications = options.applications ?? APPLICATION_FOLDERS
    this.#tryIt = options.tryIt
    this.#run = options.run ?? runCommand
    this.#emit = options.emit
    this.#platform = options.platform ?? nodePlatform()
    this.#now = options.now ?? Date.now
    this.#waiting = options.jobs.demand("Xcode is on its way")
    // Only while the person is getting Xcode: a list of two folders, with a full read once a new Xcode is in one.
    this.#stopLooking = options.jobs.every("simulator-setup-xcode", XCODE_LOOK_MS, () => this.#lookForXcode(), { needs: [this.#waiting] })
    void this.#state().then((state) => this.#waiting.set(state.waitingSince !== undefined && this.#now() - state.waitingSince < XCODE_WAIT_MS))
  }

  get #stateFile(): string {
    return join(this.#dataRoot, "simulators", "setup.json")
  }

  get #consentFile(): string {
    return join(this.#dataRoot, "simulators", "consent.json")
  }

  /**
   * The line now, read once however many ask at once. `refresh` reads it again; asked while a read goes, it waits for
   * one more after it, since what changed may have changed after that read began.
   */
  read(refresh = false): Promise<SimulatorSetup> {
    if (this.#reading)
      return refresh
        ? (this.#again ??= this.#reading.catch(() => undefined).then(() => {
            this.#again = undefined
            return this.read(true)
          }))
        : this.#reading
    if (this.#last && !refresh) return Promise.resolve(this.#last)
    this.#reading = this.#read().finally(() => (this.#reading = undefined))
    return this.#reading
  }

  async #read(): Promise<SimulatorSetup> {
    const started = this.#now()
    const state = await this.#state()
    const facts = await readSetupFacts({ dataRoot: this.#dataRoot, run: this.#run, platform: this.#platform, state, consent: await this.consent(), ...(this.#progress && { progress: this.#progress }), canTry: this.#tryIt !== undefined, applications: this.#applications, now: this.#now() })
    const setup: SimulatorSetup = { ...setupFromFacts(facts), ...(this.#failure && { failure: this.#failure }) }
    if (setup.phase === "ready" && !state.wasReady) await this.#saveState({ ...state, wasReady: true })
    if (setupStep(setup, "xcode")?.state === "done" && state.waitingSince !== undefined) {
      await this.#saveState({ ...state, waitingSince: undefined })
      this.#waiting.set(false)
    }
    this.#xcodePaths = facts.xcodes.map((xcode) => xcode.path).join("\n")
    this.#publish(setup, this.#now() - started)
    return setup
  }

  #publish(setup: SimulatorSetup, ms?: number): void {
    const text = JSON.stringify({ ...setup, checkedAt: 0 })
    this.#last = setup
    if (text === this.#lastText) return
    const changed = this.#lastText !== undefined
    this.#lastText = text
    if (!setup.progress || !changed)
      hostLog("simulators", "setup", { phase: setup.phase, steps: setup.steps.map((step) => `${step.id}:${step.state}`).join(" "), ...(ms !== undefined && { ms }) })
    this.#emit(setup)
  }

  /**
   * Starts one step the person pressed; one runs at a time. A quick one is answered done; a long one (a download, a
   * password prompt the person may leave open) is answered as started, its progress and end said by `simulator-setup`
   * events, since a window's host call gives up on a silent answer long before a download ends.
   */
  async press(fix: SetupFix, input: { folder?: string; allowed?: boolean } = {}): Promise<SimulatorSetup> {
    if (this.#pressing) throw new Error("Mako is still on the step before; this one can start once it ends.")
    this.#pressing = fix
    this.#failure = undefined
    const setup = await this.read()
    this.#progress = { step: FIX_STEP[fix], startedAt: this.#now() }
    this.#working = this.#settle(fix, input, setup)
    if (QUICK.has(fix)) {
      await this.#working
      return this.read()
    }
    return this.read(true)
  }

  /** Until the step pressed last has ended, for whoever needs it over (a test, the host closing). */
  async settled(): Promise<void> {
    await this.#working
  }

  async #settle(fix: SetupFix, input: { folder?: string; allowed?: boolean }, setup: SimulatorSetup): Promise<void> {
    const started = this.#now()
    try {
      await this.#do(fix, input, setup)
      hostLog("simulators", "setup press", { fix, outcome: "done", ms: this.#now() - started })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#failure = { fix, message, at: this.#now() }
      hostWarn("simulators", "setup press", { fix, outcome: "failed", ms: this.#now() - started, error: message })
    } finally {
      this.#pressing = undefined
      this.#progress = undefined
    }
    await this.read(true)
  }

  async #do(fix: SetupFix, input: { folder?: string; allowed?: boolean }, setup: SimulatorSetup): Promise<void> {
    const xcode = setupStep(setup, "xcode")?.xcode
    switch (fix) {
      case "get-xcode": {
        const opened = await this.#run("/usr/bin/open", [XCODE_APP_STORE_URL])
        if (opened.code !== 0) throw new Error(`The App Store didn't open: ${opened.stderr.trim() || `open exited ${opened.code}`}`)
        await this.#saveState({ ...(await this.#state()), waitingSince: this.#now() })
        this.#waiting.set(true)
        return
      }
      case "finish-xcode":
        if (!xcode) throw new Error("There's no Xcode on this Mac to finish setting up.")
        return this.#finishXcode(xcode)
      case "download-runtime":
        if (!xcode) throw new Error("The iOS runtime comes with Xcode, which isn't on this Mac yet.")
        return this.#downloadRuntime(xcode)
      case "create-simulators":
        if (!xcode) throw new Error("Simulators need Xcode, which isn't on this Mac yet.")
        return this.#createSimulators(xcode)
      case "install-tools":
        return installTools(toolsRoot(this.#dataRoot), (name) => hostLog("simulators", "tool installed", { name }))
      case "allow-agents": {
        if (!input.folder) throw new Error("Say which project agents may use simulators in.")
        const consent = await this.#consentFileRead()
        consent.projects[input.folder] = { allowed: input.allowed !== false, at: this.#now() }
        await mkdir(dirname(this.#consentFile), { recursive: true })
        await writeFile(this.#consentFile, `${JSON.stringify(consent, null, 2)}\n`)
        hostLog("simulators", "consent", { folder: input.folder, allowed: input.allowed !== false })
        return
      }
      case "try": {
        if (!this.#tryIt) throw new Error("Booting and streaming a simulator from Mako is built next, on a Mac with Xcode.")
        const tried = await this.#tryIt()
        await this.#saveState({ ...(await this.#state()), tried: { at: this.#now(), firstFrameMs: tried.firstFrameMs } })
        return
      }
    }
  }

  /**
   * The three things only an administrator can do, in one macOS password prompt: point the active developer folder at
   * this Xcode, accept its license, and install its first-launch components. The prompt is macOS's own; Mako never
   * sees the password.
   */
  async #finishXcode(xcode: XcodeFound): Promise<void> {
    const developer = developerFolder(xcode)
    if (/['"\\]/.test(developer)) throw new Error(`Mako won't pass ${developer} to an administrator's shell; rename the Xcode bundle without quotes or backslashes.`)
    const xcodebuild = `${developer}/usr/bin/xcodebuild`
    const command = `/usr/bin/xcode-select -s '${developer}' && '${xcodebuild}' -license accept && '${xcodebuild}' -runFirstLaunch`
    const version = /^[\w.]+$/.test(xcode.version) ? ` ${xcode.version}` : ""
    const script = `do shell script "${command}" with prompt "Mako is finishing Xcode's setup so simulators can run: choosing Xcode${version}, accepting its license and installing its components." with administrator privileges`
    const result = await this.#run("/usr/bin/osascript", ["-e", script], { timeoutMs: 15 * 60_000 })
    if (result.code === 0) return
    if (/-128|User canceled/i.test(result.stderr)) throw new Error("The password prompt was closed, so Xcode's setup wasn't finished. Press Finish setup when you're ready.")
    throw new Error(`Xcode's setup didn't finish: ${result.stderr.trim().split("\n").slice(-2).join(" ") || `osascript exited ${result.code}`}`)
  }

  /** `xcodebuild -downloadPlatform iOS`, its progress said as it goes. */
  async #downloadRuntime(xcode: XcodeFound): Promise<void> {
    const developer = developerFolder(xcode)
    let said = 0
    let last = ""
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = hostSpawn(join(developer, "usr", "bin", "xcodebuild"), ["-downloadPlatform", "iOS"], { env: { ...process.env, DEVELOPER_DIR: developer }, stdio: ["ignore", "pipe", "pipe"] })
      const heard = (chunk: Buffer) => {
        // It redraws one line with carriage returns and terminal codes.
        for (const raw of stripVTControlCharacters(chunk.toString("utf8")).split(/[\r\n]+/)) {
          const line = raw.trim()
          if (!line) continue
          last = line
          const progress = parseDownloadLine(line)
          if (!this.#progress) continue
          this.#progress = { ...this.#progress, line, ...(progress && { fraction: progress.fraction }), ...(progress?.doneBytes !== undefined && { doneBytes: progress.doneBytes, totalBytes: progress.totalBytes }) }
          if (this.#now() - said < PROGRESS_EMIT_MS || !this.#last) continue
          said = this.#now()
          this.#publish({ ...this.#last, progress: this.#progress })
        }
      }
      child.stdout.on("data", heard)
      child.stderr.on("data", heard)
      child.once("error", reject)
      child.once("close", resolve)
    })
    if (code !== 0) throw new Error(`The iOS runtime didn't download: ${last || `xcodebuild exited ${code}`}`)
  }

  /** Makes each of Mako's simulators not made yet, on the runtime this Xcode wants. */
  async #createSimulators(xcode: XcodeFound): Promise<void> {
    const env = { ...process.env, DEVELOPER_DIR: developerFolder(xcode) }
    const list = await this.#run("/usr/bin/xcrun", ["simctl", "list", "-j"], { env, timeoutMs: 30_000 })
    if (list.code !== 0) throw new Error(`simctl didn't list this Mac's simulators: ${list.stderr.trim()}`)
    const parsed = parseSimctlList(list.stdout)
    const wanted = setupStep(this.#last, "runtime")?.wanted
    const runtime = chooseRuntime(parsed.runtimes, wanted, parsed.runtimeTypes)
    if (!runtime) throw new Error("There's no iOS runtime to make the simulators on yet.")
    for (const simulator of makoSimulators({ ...parsed, ...(wanted && { wantedRuntime: wanted }) })) {
      if (simulator.udid) continue
      const made = await this.#run("/usr/bin/xcrun", ["simctl", "create", simulator.name, simulator.type, runtime.identifier], { env, timeoutMs: 60_000 })
      if (made.code !== 0) throw new Error(`simctl didn't make ${simulator.name}: ${made.stderr.trim()}`)
      hostLog("simulators", "simulator made", { name: simulator.name, udid: made.stdout.trim(), runtime: runtime.identifier })
    }
  }

  /** While the person gets Xcode: whether a new complete Xcode is in an Applications folder, then the whole line once it is. */
  async #lookForXcode(): Promise<void> {
    const state = await this.#state()
    if (state.waitingSince === undefined || this.#now() - state.waitingSince >= XCODE_WAIT_MS) {
      this.#waiting.set(false)
      return
    }
    const paths = (await findXcodes(this.#run, this.#applications)).map((xcode) => xcode.path).join("\n")
    if (paths !== this.#xcodePaths) await this.read(true)
  }

  /** Each project's answer, newest first. */
  async consent(): Promise<SetupConsent[]> {
    const consent = await this.#consentFileRead()
    return Object.entries(consent.projects)
      .map(([folder, answer]) => ({ folder, ...answer }))
      .sort((a, b) => b.at - a.at)
  }

  async #consentFileRead(): Promise<z.infer<typeof ConsentSchema>> {
    return readJson(this.#consentFile, ConsentSchema, { projects: {} })
  }

  async #state(): Promise<z.infer<typeof StateSchema>> {
    return readJson(this.#stateFile, StateSchema, { wasReady: false })
  }

  async #saveState(state: z.infer<typeof StateSchema>): Promise<void> {
    await mkdir(dirname(this.#stateFile), { recursive: true })
    await writeFile(this.#stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** The line as last read, without reading. */
  current(): SimulatorSetup | undefined {
    return this.#last
  }

  stop(): void {
    this.#stopLooking()
  }
}

async function readJson<Schema extends z.ZodType>(file: string, schema: Schema, fallback: z.infer<Schema>): Promise<z.infer<Schema>> {
  const text = await readFile(file, "utf8").catch(() => null)
  if (text === null) return fallback
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    if (parsed.success) return parsed.data
  } catch {
    /* fall through */
  }
  hostWarn("simulators", "unreadable file", { file })
  return fallback
}
