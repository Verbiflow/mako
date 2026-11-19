/**
 * Decodes kept out of the catalog's process. A large record decodes in a
 * child process of its own, which writes the record's view and exits, so
 * what a decode holds while it runs (a whole session, uncapped) never counts
 * against the catalog's heap: the sync daemon runs in 128 MB. The child is
 * `decode-aside-main.js`; one runs at a time, a person's first: a decode
 * someone waits on (a Thread opening) goes before every decode in the
 * background (views rebuilt for a new decoder, copies), and stops one that is
 * running, which goes again after it. After an update to a decoder the
 * background rebuilt every large Thread one by one, and the Thread the person
 * opened waited behind them all (13 to 18 s, 2026-11-19).
 */
import { fork } from "./processes.js"
import type { ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { sendToChild } from "./child-input.js"

/** Records from this size decode aside. */
export const DECODE_ASIDE_BYTES = 32 * 1024 ** 2
/** The child's heap: a 10 GB store's whole session decodes in under 1 GB. */
const ASIDE_HEAP_MB = 6144
const STDERR_KEPT = 4096

export const AsideJobSchema = z.object({
  /** The reader's index in `SAVED_HISTORY_READERS`. */
  reader: z.number().int().nonnegative(),
  path: z.string(),
  stamp: z.object({ bytes: z.number(), mtimeMs: z.number(), revision: z.string().optional() }),
  viewsPath: z.string(),
  translator: z.string(),
  /** `NativeStores.strict` of the stores the parent reads: the child's open each harness store as they do. */
  strict: z.boolean(),
  /** The parent's `ReaderPlace`, where its reader was made to read; the machine's own stores without one. */
  place: z.object({ home: z.string(), userRoot: z.string(), kept: z.string() }).optional(),
})
export type AsideJob = z.infer<typeof AsideJobSchema>

export const AsideReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), entries: z.number(), decodeMs: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AsideReply = z.infer<typeof AsideReplySchema>

/** A decode aside's end. `started` is false where no child could run, so the caller decodes in its own process instead. */
export type AsideOutcome = { ok: true; entries: number; decodeMs: number } | { ok: false; started: boolean; error: string }

/** A decode asked for and not yet done: `background` when nobody waits on it. */
interface Asked {
  job: AsideJob
  background: boolean
  settle: (outcome: AsideOutcome) => void
}

/** The decode running, its child once it started, and whether it was stopped for one someone waits on. */
interface Running {
  asked: Asked
  child?: ChildProcess
  yielded?: boolean
}

export class DecodeAside {
  /** Decodes someone waits on, then the rest, each in the order asked. */
  private readonly sooner: Asked[] = []
  private readonly later: Asked[] = []
  private running: Running | null = null
  private children = new Set<ChildProcess>()
  private stopped = false
  private readonly script = fileURLToPath(new URL("./decode-aside-main.js", import.meta.url))

  /** `executable` runs the child as Node: Electron's Helper inside the app, which shows no Dock icon. */
  constructor(readonly executable = process.execPath) {}

  /**
   * Decodes `job`'s record into its view: after the decodes someone waits on asked before it, and, unless it's
   * `background`, before every decode in the background, stopping one that runs (it goes again next).
   */
  decode(job: AsideJob, background = false): Promise<AsideOutcome> {
    return new Promise((settle) => {
      const asked = { job, background, settle }
      if (background) this.later.push(asked)
      else {
        this.sooner.push(asked)
        this.yieldRunning()
      }
      this.next()
    })
  }

  /** Someone waits now on the decode of `path` asked in the background: it goes before the rest. */
  promote(path: string): void {
    const at = this.later.findIndex((asked) => asked.job.path === path)
    if (at >= 0) {
      const [asked] = this.later.splice(at, 1)
      this.sooner.push({ ...asked!, background: false })
      this.yieldRunning()
      this.next()
    } else if (this.running?.asked.job.path === path) this.running.asked.background = false
  }

  /** The decodes waiting, someone's first: for a diagnostic, and a test. */
  waiting(): { path: string; background: boolean }[] {
    return [...this.sooner, ...this.later].map((asked) => ({ path: asked.job.path, background: asked.background }))
  }

  stop(): void {
    this.stopped = true
    for (const asked of [...this.sooner.splice(0), ...this.later.splice(0)]) asked.settle({ ok: false, started: false, error: "the catalog stopped" })
    for (const child of this.children) child.kill()
  }

  /** A decode in the background running while someone waits on another is stopped, and asked again first of the rest. */
  private yieldRunning(): void {
    const running = this.running
    if (!running?.asked.background || !running.child || running.yielded) return
    running.yielded = true
    running.child.kill()
  }

  private next(): void {
    if (this.running || this.stopped) return
    const asked = this.sooner.shift() ?? this.later.shift()
    if (!asked) return
    const running: Running = { asked }
    this.running = running
    void this.run(asked.job, (child) => { running.child = child }).then((outcome) => {
      this.running = null
      if (running.yielded && !this.stopped) this.later.unshift(asked)
      else asked.settle(outcome)
      this.next()
    })
  }

  private run(job: AsideJob, started: (child: ChildProcess) => void): Promise<AsideOutcome> {
    if (!existsSync(this.script)) return Promise.resolve({ ok: false, started: false, error: `no ${this.script}` })
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = fork(this.script, [], {
          execPath: this.executable,
          execArgv: [`--max-old-space-size=${ASIDE_HEAP_MB}`],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          serialization: "json",
        })
      } catch (error) {
        resolve({ ok: false, started: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      this.children.add(child)
      started(child)
      let reply: AsideReply | undefined
      let stderr = ""
      let spawned = false
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEPT)
      })
      child.once("spawn", () => {
        spawned = true
        // A child gone before it reads the job ends as its `exit` says.
        sendToChild(child, job).catch(() => {})
      })
      child.on("message", (message) => {
        reply = AsideReplySchema.safeParse(message).data ?? { ok: false, error: "the decode's reply doesn't parse" }
      })
      child.once("error", (error) => {
        if (!spawned) {
          this.children.delete(child)
          resolve({ ok: false, started: false, error: error.message })
        }
      })
      child.once("exit", (code, signal) => {
        this.children.delete(child)
        if (!spawned) return
        if (reply?.ok) resolve(reply)
        else resolve({ ok: false, started: true, error: reply?.error ?? `the decode ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}${stderr ? `: ${stderr.trim()}` : ""}` })
      })
    })
  }
}
