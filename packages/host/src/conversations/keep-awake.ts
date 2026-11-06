import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { trackProviderChild } from "../base/provider-children.js"
import { KEEP_AWAKE_BATTERY_FLOOR, type KeepAwakeHold, type KeepAwakeSettings, type KeepAwakeState } from "../contracts/keep-awake.js"
import type { LiveBatch } from "../contracts/live-conversations.js"

const SettingsFileSchema = z.object({ version: z.literal(1), on: z.boolean(), lidClosed: z.boolean() })
const DEFAULTS: KeepAwakeSettings = { on: true, lidClosed: false }
/** Batches that can change whether an agent works arrive in bursts as a turn starts or ends: one count for each burst. */
const COALESCE_MS = 150
/** How long the helper stays, holding nothing, after the last agent stops: a Fin's next turn doesn't start it again. */
const LINGER_MS = 60_000
/** How long the helper has to say it's ready and where the power comes from. */
const READY_MS = 5_000
/** Restarts after the helper exits on its own: at most this many in `RESTART_WINDOW_MS`, then it's left down. */
const RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

/** Where this Mac's power comes from, as the helper last said; `percent` is -1 when the charge can't be read. */
export type PowerSource = { kind: "ac" } | { kind: "battery"; percent: number }

export type KeepAwakeOptions = {
  /** Where the person's choice is kept: `<data root>/keep-awake.json`. */
  file: string
  /** The helper's path (`sleepWatchHelper`); undefined where there is none. */
  helper(): Promise<string | undefined>
  /** How many of this Mac's Threads have an agent at work now (`workingThreads`, waits on the person left out). */
  working(): number
  /** What every window shows changed. */
  changed(state: KeepAwakeState): void
  /** How a test starts the helper; the real one by default. */
  spawn?(path: string, args: readonly string[]): ChildProcessWithoutNullStreams
  lingerMs?: number
  coalesceMs?: number
}

/**
 * What to hold for this many agents at work, by the person's choice and the power: idle sleep held off while any
 * works; with the lid closed too only when they chose it and the Mac is on power (macOS honours that hold only on
 * power anyway); nothing on a battery below the floor, which is said rather than held.
 */
export function keepAwakeHold(settings: KeepAwakeSettings, agents: number, power: PowerSource | undefined): KeepAwakeHold {
  if (!settings.on || agents === 0) return { kind: "rest" }
  if (power?.kind === "battery" && power.percent >= 0 && power.percent < KEEP_AWAKE_BATTERY_FLOOR) {
    return { kind: "low-battery", agents, percent: power.percent, floor: KEEP_AWAKE_BATTERY_FLOOR }
  }
  return { kind: settings.lidClosed && power?.kind === "ac" ? "lid" : "idle", agents }
}

/** Whether a batch can change whether its conversation's agent works: its status, requests, approvals, background work or subagents. */
export function mayChangeWork(batch: LiveBatch): boolean {
  if (batch.session || batch.requests || batch.requestChanges || batch.permissions || batch.nativeAgents) return true
  const changes = batch.sessionChanges
  if (changes && ("status" in changes || "backgroundTasks" in changes)) return true
  return batch.sessionCleared?.includes("backgroundTasks") === true
}

/** The assertion's name in `pmset -g assertions`. */
export function assertionName(agents: number): string {
  return `Mako: ${agents} ${agents === 1 ? "agent" : "agents"} working`
}

/**
 * Keeps this Mac awake while its agents work. A power assertion, held by the native helper
 * (`native/sleep-watch-macos`, run with `--keep-awake`), keeps idle sleep off from the moment an agent here starts
 * working until the moment none does; the person can let it hold a closed lid too, on power. The helper runs only
 * while agents work (and a minute after, holding nothing), and an assertion never outlives it, so a host that's gone
 * holds nothing.
 *
 * It follows the live batches that can change who works (`mayChangeWork`), counted once per burst, and the helper's
 * word on the power source; nothing polls.
 */
export class KeepAwake {
  readonly #options: KeepAwakeOptions
  #settings: KeepAwakeSettings | undefined
  #hold: KeepAwakeHold = { kind: "rest" }
  #unavailable: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  #ready: Promise<boolean> | undefined
  #power: PowerSource | undefined
  /** What the helper was last told to hold, as `hold <kind> <name>`, or undefined when it holds nothing. */
  #told: string | undefined
  #running: Promise<void> = Promise.resolve()
  #coalesce: ReturnType<typeof setTimeout> | undefined
  #linger: ReturnType<typeof setTimeout> | undefined
  #restarts: number[] = []
  /** The helper couldn't be had (`sleepWatchHelper` said so once); it isn't built again until Mako restarts. */
  #noHelper = false
  #stopped = false

  constructor(options: KeepAwakeOptions) {
    this.#options = options
  }

  /** Something that may change who works happened: counted once the burst settles. */
  changed(): void {
    if (this.#stopped || this.#coalesce) return
    this.#coalesce = setTimeout(() => {
      this.#coalesce = undefined
      void this.refresh()
    }, this.#options.coalesceMs ?? COALESCE_MS)
    this.#coalesce.unref?.()
  }

  /** Counts the agents at work now and holds, or lets go, to match. One at a time, in order. */
  refresh(): Promise<void> {
    const run = this.#running.then(() => this.#refresh())
    this.#running = run.catch((error: unknown) => hostWarn("keep-awake", "keeping this Mac awake failed", { error: errorMessage({ error }) }))
    return this.#running
  }

  async state(): Promise<KeepAwakeState> {
    return { settings: await this.#readSettings(), hold: this.#hold, ...this.#unavailable && { unavailable: this.#unavailable } }
  }

  async set(change: Partial<KeepAwakeSettings>): Promise<KeepAwakeState> {
    const settings = { ...(await this.#readSettings()), ...change }
    this.#settings = settings
    await mkdir(dirname(this.#options.file), { recursive: true })
    await writeFile(`${this.#options.file}.tmp`, JSON.stringify(SettingsFileSchema.parse({ version: 1, ...settings })), { mode: 0o600 })
    await rename(`${this.#options.file}.tmp`, this.#options.file)
    await this.refresh()
    const state = await this.state()
    this.#options.changed(state)
    return state
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#coalesce)
    clearTimeout(this.#linger)
    this.#end()
  }

  async #refresh(): Promise<void> {
    if (this.#stopped) return
    const settings = await this.#readSettings()
    const agents = settings.on ? this.#options.working() : 0
    if (agents === 0) {
      this.#tell(undefined)
      this.#lingerThenEnd()
      this.#publish({ kind: "rest" })
      return
    }
    clearTimeout(this.#linger)
    this.#linger = undefined
    if (!(await this.#start())) {
      this.#publish({ kind: "rest" })
      return
    }
    const hold = keepAwakeHold(settings, agents, this.#power)
    this.#tell(hold.kind === "idle" || hold.kind === "lid" ? `hold ${hold.kind} ${assertionName(agents)}` : undefined)
    this.#publish(hold)
  }

  /** Tells the helper what to hold, only when that changed. */
  #tell(line: string | undefined): void {
    if (line === this.#told) return
    const child = this.#child
    if (!child || child.stdin.destroyed) {
      this.#told = undefined
      return
    }
    child.stdin.write(`${line ?? "release"}\n`)
    this.#told = line
  }

  #publish(hold: KeepAwakeHold): void {
    const before = this.#hold
    this.#hold = hold
    if (JSON.stringify(before) === JSON.stringify(hold)) return
    if (hold.kind !== before.kind) {
      if (hold.kind === "idle" || hold.kind === "lid") hostLog("keep-awake", "keeping this Mac awake", { agents: hold.agents, lid: hold.kind === "lid" })
      else if (hold.kind === "low-battery") hostWarn("keep-awake", "the battery is low: this Mac may sleep while agents work", { percent: hold.percent })
      else hostLog("keep-awake", "this Mac may sleep again")
    }
    void this.state().then((state) => this.#options.changed(state))
  }

  /** The helper, started if it isn't running, ready once it said where the power comes from. False when there's none. */
  async #start(): Promise<boolean> {
    if (this.#ready) return this.#ready
    if (this.#noHelper) return false
    const helper = await this.#options.helper().catch(() => undefined)
    if (!helper) {
      this.#noHelper = true
      this.#unavailable = "Mako couldn't start its power helper on this Mac."
      return false
    }
    const child = (this.#options.spawn ?? spawnHelper)(helper, ["--keep-awake"])
    this.#child = child
    this.#told = undefined
    trackProviderChild(child, { kind: "keep-awake", owner: "host" })
    child.stderr.on("data", (chunk: Buffer) => hostWarn("keep-awake", "the power helper said", { text: chunk.toString("utf8").trim().slice(0, 500) }))
    this.#ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_MS)
      timer.unref?.()
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (this.#heard(line)) {
          clearTimeout(timer)
          resolve(true)
        }
      })
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    child.once("exit", (code) => this.#exited(child, code))
    const ready = await this.#ready
    if (ready) this.#unavailable = undefined
    else {
      this.#unavailable = "Mako's power helper didn't start."
      this.#end()
    }
    return ready
  }

  /** One line from the helper; true once it said where the power comes from. */
  #heard(line: string): boolean {
    const [word, kind, percent] = line.trim().split(" ")
    if (word === "failed") {
      hostWarn("keep-awake", "macOS refused to keep this Mac awake", { code: kind ?? "" })
      this.#told = undefined
      return false
    }
    if (word !== "power") return false
    const known = this.#power !== undefined
    this.#power = kind === "battery" ? { kind: "battery", percent: Number(percent ?? -1) } : { kind: "ac" }
    if (known) void this.refresh()
    return true
  }

  #exited(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.#child !== child) return
    this.#child = undefined
    this.#ready = undefined
    this.#told = undefined
    this.#power = undefined
    if (this.#stopped || this.#hold.kind === "rest") return
    const now = Date.now()
    this.#restarts = [...this.#restarts.filter((at) => now - at < RESTART_WINDOW_MS), now]
    if (this.#restarts.length > RESTARTS) {
      hostWarn("keep-awake", "the power helper keeps exiting; this Mac may sleep while agents work until Mako restarts", { code: code ?? "signal" })
      this.#unavailable = "Mako's power helper keeps stopping. Restart Mako to try again."
      this.#publish({ kind: "rest" })
      return
    }
    hostWarn("keep-awake", "the power helper exited while agents work; starting it again", { code: code ?? "signal" })
    void this.refresh()
  }

  #lingerThenEnd(): void {
    if (!this.#child || this.#linger) return
    this.#linger = setTimeout(() => {
      this.#linger = undefined
      this.#end()
    }, this.#options.lingerMs ?? LINGER_MS)
    this.#linger.unref?.()
  }

  /** Ends the helper; whatever it held goes with it. */
  #end(): void {
    const child = this.#child
    this.#child = undefined
    this.#ready = undefined
    this.#told = undefined
    this.#power = undefined
    child?.stdin.end()
  }

  async #readSettings(): Promise<KeepAwakeSettings> {
    if (this.#settings) return this.#settings
    const saved = SettingsFileSchema.safeParse(JSON.parse(await readFile(this.#options.file, "utf8").catch(() => "null")))
    this.#settings = saved.success ? { on: saved.data.on, lidClosed: saved.data.lidClosed } : DEFAULTS
    return this.#settings
  }
}

function spawnHelper(path: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawnProcess(path, args, { stdio: ["pipe", "pipe", "pipe"] })
}
