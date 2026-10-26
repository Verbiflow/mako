/**
 * Decodes kept out of the catalog's process. A large record decodes in a
 * child process of its own, which writes the record's view and exits, so
 * what a decode holds while it runs (a whole session, uncapped) never counts
 * against the catalog's heap: the sync daemon runs in 128 MB. The child is
 * `decode-aside-main.js`; one runs at a time.
 */
import { fork, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"

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

export class DecodeAside {
  private queue: Promise<unknown> = Promise.resolve()
  private children = new Set<ChildProcess>()
  private readonly script = fileURLToPath(new URL("./decode-aside-main.js", import.meta.url))

  /** `executable` runs the child as Node: Electron's Helper inside the app, which shows no Dock icon. */
  constructor(readonly executable = process.execPath) {}

  /** Decodes `job`'s record into its view, after the decodes asked before it. */
  decode(job: AsideJob): Promise<AsideOutcome> {
    const run = this.queue.then(() => this.run(job))
    this.queue = run.catch(() => undefined)
    return run
  }

  stop(): void {
    for (const child of this.children) child.kill()
  }

  private run(job: AsideJob): Promise<AsideOutcome> {
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
      let reply: AsideReply | undefined
      let stderr = ""
      let spawned = false
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEPT)
      })
      child.once("spawn", () => {
        spawned = true
        child.send(job)
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
