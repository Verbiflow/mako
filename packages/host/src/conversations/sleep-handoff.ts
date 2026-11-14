import { hostSpawn } from "../base/host-command.js"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { trackProviderChild } from "../base/provider-children.js"
import { endChildInput, writeChildInput } from "@mako/sessions/child-input"

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
  /** The helper's path; undefined where there is none (not a Mac, or a checkout that didn't build it). */
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
 * release small), one in the project folder onto its own branch first; it lets the Mac sleep once the host answers,
 * or once its hold runs out. A Thread that can't be released in that time stays here with its turns paused, so it
 * reads idle for Continue in the cloud from another device, and goes on here once the Mac wakes and hears its account
 * (rule 4, `CloudMoves.unpark`). A shutdown hands off the same way (`machineLeaving`). Runs only while the person's
 * choice is on.
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
    if (this.#child) endChildInput(this.#child)
    this.#child?.kill()
    this.#child = undefined
  }

  async #refresh(): Promise<void> {
    if (this.#stopped) return
    const enabled = await this.#options.enabled()
    if (!enabled) {
      if (this.#child) hostLog("handoff", "the sleep watch stopped: handing off on sleep is off")
      if (this.#child) endChildInput(this.#child)
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
    // A watch gone by now lets the Mac sleep anyway, and its `exit` starts another.
    writeChildInput(child, `allow ${id}\n`).catch(() => {})
    hostLog("handoff", "this Mac may sleep", { ms: Date.now() - began })
  }
}

function spawnHelper(path: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return hostSpawn(path, args, { stdio: ["pipe", "pipe", "pipe"] })
}

/** The helper's name, in a packaged app's `Contents/MacOS` and in a checkout's build of it. */
export const SLEEP_WATCH_HELPER = "mako-sleep-watch"

/**
 * Where the sleep helper is: a packaged app's, beside its executable; a checkout's, where `build:electron` built it
 * for every host of that checkout. A host never builds it: its data root is often new and its life short, and what it
 * started would outlive it. Undefined where there is none, which leaves handing off on sleep unavailable.
 */
export async function sleepWatchHelper(environment: { appRoot: string; packaged: boolean }): Promise<string | undefined> {
  const helper = environment.packaged
    ? join(dirname(dirname(environment.appRoot)), "MacOS", SLEEP_WATCH_HELPER)
    : join(environment.appRoot, "build", SLEEP_WATCH_HELPER)
  return (await stat(helper).catch(() => undefined)) ? helper : undefined
}
