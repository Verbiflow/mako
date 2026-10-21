import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { claudeTelemetryOptionsCompatible } from "./approval-telemetry-settings.js"

/** A check that takes longer is answered "not compatible", and its worker replaced. */
const CHECK_MS = 2_000
/** A worker no check has asked of for this long is stopped; the next check starts another. */
const IDLE_MS = 10 * 60_000

const Answer = z.union([z.object({ ready: z.literal(true) }), z.object({ id: z.number(), compatible: z.boolean() })])

interface Loaded {
  thread: Worker
  /** Whether it loaded the SDK. */
  ready: Promise<boolean>
}

/**
 * Whether Claude's own settings leave its telemetry to Mako, so its approvals can be observed through it: the Agent
 * SDK's `resolveSettings`, in a worker thread kept for the driver, each check under its launch's environment. A worker
 * per start loaded the SDK each time, 0.3–0.44 s before every Claude process could spawn on a copy (2026-10-20); kept,
 * a check takes about 1 ms, and a start run ahead loads it as the machine boots (`warm`).
 */
export class ClaudeSettingsReader {
  private loaded: Loaded | undefined
  private nextId = 0
  private readonly waiting = new Map<number, (compatible: boolean) => void>()
  private idle: NodeJS.Timeout | undefined
  private readonly entry: URL

  constructor(entry = new URL("./approval-settings-worker.js", import.meta.url)) {
    this.entry = entry
  }

  /** Loads the worker ahead of the first check; resolves whether it loaded. */
  warm(): Promise<boolean> {
    return this.load().ready
  }

  async compatible(config: Options): Promise<boolean> {
    if (!claudeTelemetryOptionsCompatible(config)) return false
    const loaded = this.load()
    const id = this.nextId++
    const env = Object.fromEntries(Object.entries(config.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // A check stuck past its time leaves the worker unknown: it's replaced, and this start goes on without.
        this.stop(loaded)
        finish(false)
      }, CHECK_MS)
      const finish = (compatible: boolean) => {
        clearTimeout(timer)
        this.waiting.delete(id)
        resolve(compatible)
      }
      this.waiting.set(id, finish)
      loaded.thread.postMessage({ id, env, cwd: config.cwd ?? process.cwd(), settingSources: config.settingSources })
    })
  }

  /** Stops the worker; the next check starts another. */
  close(): void {
    if (this.loaded) this.stop(this.loaded)
  }

  private load(): Loaded {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), IDLE_MS)
    this.idle.unref()
    if (this.loaded) return this.loaded
    const thread = new Worker(this.entry, { resourceLimits: { maxOldGenerationSizeMb: 64 } })
    thread.unref()
    let loadedSdk!: (ready: boolean) => void
    const loaded: Loaded = { thread, ready: new Promise<boolean>((resolve) => { loadedSdk = resolve }) }
    thread.on("message", (message) => {
      const answer = Answer.safeParse(message)
      if (!answer.success) return
      if ("ready" in answer.data) return loadedSdk(true)
      this.waiting.get(answer.data.id)?.(answer.data.compatible)
    })
    const gone = () => {
      loadedSdk(false)
      if (this.loaded === loaded) this.stop(loaded)
    }
    thread.once("error", gone)
    thread.once("exit", gone)
    this.loaded = loaded
    return loaded
  }

  private stop(loaded: Loaded): void {
    if (this.loaded !== loaded) return
    this.loaded = undefined
    clearTimeout(this.idle)
    void loaded.thread.terminate()
    for (const finish of this.waiting.values()) finish(false)
  }
}
