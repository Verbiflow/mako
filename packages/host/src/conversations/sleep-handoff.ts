import { execFile, spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { trackProviderChild } from "../base/provider-children.js"

/**
 * How long the helper holds a sleep for the host (`mako-sleep-watch --hold`). macOS waits at most 30 seconds for an
 * answer; this leaves it room.
 */
export const SLEEP_HOLD_MS = 25_000
/** What the hold leaves after the handoff: the answer reaching the helper, and the helper letting the Mac sleep. */
const ANSWER_MARGIN_MS = 1_500
/** Restarts after the helper exits on its own: at most this many in `RESTART_WINDOW_MS`, then it's left down. */
const RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

export type SleepHandOffOptions = {
  /** The helper's path, built if this checkout has none yet; undefined where there is none (not a Mac). */
  helper(): Promise<string | undefined>
  /** Whether agents at work go to the cloud as this Mac sleeps: the person's choice, and a Mac able to. */
  enabled(): Promise<boolean>
  /** Hands every Thread at work to the cloud, released by `releaseBy` or left here (`CloudHandOffs.handOff`). */
  handOff(handOff: string, releaseBy: number): Promise<void>
  /** The Mac woke. */
  woke(): void
  /** How a test starts the helper; the real one by default. */
  spawn?(path: string, args: readonly string[]): ChildProcessWithoutNullStreams
  holdMs?: number
}

/**
 * Hands agents at work to the cloud as this Mac goes to sleep. A native helper (`native/sleep-watch-macos`) hears
 * the sleep before it happens and holds it while the host hands each working Thread off (rule 3 of moves made the
 * release small); it lets the Mac sleep once the host answers, or once its hold runs out. A Thread that can't be
 * released in that time stays here untouched, its turn going on when the Mac wakes (rule 4). Runs only while the
 * person's choice is on.
 */
export class SleepHandOff {
  readonly #options: SleepHandOffOptions
  #child: ChildProcessWithoutNullStreams | undefined
  #starting: Promise<void> | undefined
  #restarts: number[] = []
  #stopped = false

  constructor(options: SleepHandOffOptions) {
    this.#options = options
  }

  /** Starts or stops the helper as the person's choice and the Mac's standing say. */
  refresh(): Promise<void> {
    const run = (this.#starting ?? Promise.resolve()).then(() => this.#refresh())
    this.#starting = run.catch((error: Error) => hostWarn("handoff", "the sleep watch couldn't start", { error: error.message }))
    return this.#starting
  }

  stop(): void {
    this.#stopped = true
    this.#child?.stdin.end()
    this.#child?.kill()
    this.#child = undefined
  }

  async #refresh(): Promise<void> {
    if (this.#stopped) return
    const enabled = await this.#options.enabled()
    if (!enabled) {
      if (this.#child) hostLog("handoff", "the sleep watch stopped: handing off on sleep is off")
      this.#child?.stdin.end()
      this.#child = undefined
      return
    }
    if (this.#child) return
    const helper = await this.#options.helper()
    if (!helper) return
    const hold = this.#options.holdMs ?? SLEEP_HOLD_MS
    const child = (this.#options.spawn ?? spawnHelper)(helper, ["--hold", String(hold / 1000)])
    this.#child = child
    trackProviderChild(child, { kind: "sleep-watch", owner: "host" })
    child.stderr.on("data", (chunk: Buffer) => hostWarn("handoff", "the sleep watch said", { text: chunk.toString("utf8").trim().slice(0, 500) }))
    createInterface({ input: child.stdout }).on("line", (line) => this.#heard(child, line, hold))
    child.once("exit", (code) => {
      if (this.#child !== child) return
      this.#child = undefined
      if (this.#stopped) return
      const now = Date.now()
      this.#restarts = [...this.#restarts.filter((at) => now - at < RESTART_WINDOW_MS), now]
      if (this.#restarts.length > RESTARTS) {
        hostWarn("handoff", "the sleep watch keeps exiting; agents won't be handed off on sleep until Mako restarts", { code: code ?? "signal" })
        return
      }
      hostWarn("handoff", "the sleep watch exited; starting it again", { code: code ?? "signal" })
      void this.refresh()
    })
  }

  #heard(child: ChildProcessWithoutNullStreams, line: string, hold: number): void {
    const [word, id] = line.trim().split(" ")
    if (word === "ready") hostLog("handoff", "the sleep watch is listening")
    else if (word === "woke") this.#options.woke()
    else if (word === "slept") hostLog("handoff", "this Mac went to sleep", { how: line.split(" ")[2] ?? "" })
    else if (word === "will-sleep" && id) void this.#sleeping(child, id, hold)
  }

  /** The Mac is about to sleep: everything at work is handed off by the hold's end, then the helper lets it sleep. */
  async #sleeping(child: ChildProcessWithoutNullStreams, id: string, hold: number): Promise<void> {
    const began = Date.now()
    const releaseBy = began + hold - ANSWER_MARGIN_MS * 2
    try {
      await Promise.race([
        this.#options.handOff(randomUUID(), releaseBy),
        new Promise((resolve) => setTimeout(resolve, hold - ANSWER_MARGIN_MS).unref()),
      ])
    } catch (error) {
      hostWarn("handoff", "agents at work couldn't be handed off as this Mac slept", { error: errorMessage({ error }) })
    }
    if (!child.stdin.destroyed) child.stdin.write(`allow ${id}\n`)
    hostLog("handoff", "this Mac may sleep", { ms: Date.now() - began })
  }
}

function spawnHelper(path: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawnProcess(path, args, { stdio: ["pipe", "pipe", "pipe"] })
}

/** The helper's name, in a packaged app's `Contents/MacOS` and in a checkout's build of it. */
export const SLEEP_WATCH_HELPER = "mako-sleep-watch"

/**
 * Where the sleep helper is: a packaged app's, beside its executable; a checkout's, built from its source into the
 * data root the first time it's needed and again whenever the source is newer. Undefined where it can't be had (the
 * Command Line Tools missing), which leaves handing off on sleep unavailable, said once.
 */
export async function sleepWatchHelper(environment: { appRoot: string; packaged: boolean; dataRoot: string }): Promise<string | undefined> {
  if (environment.packaged) {
    const packaged = join(dirname(dirname(environment.appRoot)), "MacOS", SLEEP_WATCH_HELPER)
    return (await stat(packaged).catch(() => undefined)) ? packaged : undefined
  }
  const source = join(environment.appRoot, "native", "sleep-watch-macos", "main.swift")
  const built = join(environment.dataRoot, "native", SLEEP_WATCH_HELPER)
  const [sourced, made] = await Promise.all([stat(source).catch(() => undefined), stat(built).catch(() => undefined)])
  if (!sourced) return undefined
  if (made && made.mtimeMs >= sourced.mtimeMs) return built
  await mkdir(dirname(built), { recursive: true })
  const building = `${built}.${process.pid}.building`
  try {
    await promisify(execFile)("xcrun", ["swiftc", "-O", "-swift-version", "5", source, "-o", building], { timeout: 120_000 })
    await rename(building, built)
    hostLog("handoff", "built the sleep watch for this checkout", { path: built })
    return built
  } catch (error) {
    hostWarn("handoff", "the sleep watch couldn't be built; agents won't be handed off on sleep", { error: errorMessage({ error }).slice(0, 500) })
    return undefined
  }
}
