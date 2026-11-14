import { statSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { z } from "zod"

/** How long the primer's thread stays once it has nothing to do. */
const IDLE_MS = 5_000

/**
 * The thread's work, one journal at a time: a connection of its own writes the journal's `user_version` as it was,
 * which changes nothing a journal reads but is a frame, so SQLite writes and syncs the WAL's header here. Any failure
 * is the main connection's to meet as it would have.
 */
const PRIMER_SOURCE = `
const { DatabaseSync } = require("node:sqlite")
const { parentPort } = require("node:worker_threads")
parentPort.on("message", ({ id, path }) => {
  let primed = false
  try {
    const db = new DatabaseSync(path)
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL")
      const { user_version } = db.prepare("PRAGMA user_version").get()
      db.exec("PRAGMA user_version=" + Number(user_version))
      primed = true
    } finally {
      db.close()
    }
  } catch {}
  parentPort.postMessage({ id, primed })
})
`

const Primed = z.object({ id: z.number(), primed: z.boolean() })

/**
 * Writes a journal's WAL header off the host's thread before its first commit. A journal its last host closed has no
 * WAL, and SQLite syncs a new WAL's header, and its folder, on the first frame written into it, even at
 * `synchronous=NORMAL`: the restart's commit as each Fin's journal is read in (`LiveRecords.readIn`) did that on the
 * host's thread, 3 to 6 ms on a quiet disk and 100 to 300 ms on a busy one, a hold each. Written here first, that
 * commit appends to a WAL that already has its header, which NORMAL doesn't sync. Nothing waits on it beyond that:
 * a primer that fails or is stopped leaves the commit to sync as it did.
 */
export class WalPrimer {
  private thread: Worker | undefined
  private nextId = 1
  private readonly waiting = new Map<number, (primed: boolean) => void>()
  private idle: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  /** Primes the journal at `path` when its WAL has no frame yet; whether it did. */
  prime(path: string): Promise<boolean> {
    if (this.stopped || !walEmpty(path)) return Promise.resolve(false)
    const id = this.nextId++
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      clearTimeout(this.idle)
      this.worker().postMessage({ id, path })
    })
  }

  stop(): void {
    this.stopped = true
    this.close()
  }

  private worker(): Worker {
    if (this.thread) return this.thread
    const thread = new Worker(PRIMER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32 } })
    thread.unref()
    thread.on("message", (message) => {
      const answer = Primed.safeParse(message)
      if (!answer.success) return
      this.waiting.get(answer.data.id)?.(answer.data.primed)
      this.waiting.delete(answer.data.id)
      if (this.waiting.size === 0) {
        this.idle = setTimeout(() => this.close(), IDLE_MS)
        this.idle.unref()
      }
    })
    const gone = () => {
      if (this.thread === thread) this.thread = undefined
      this.settleAll()
    }
    thread.once("error", gone)
    thread.once("exit", gone)
    this.thread = thread
    return thread
  }

  private close(): void {
    clearTimeout(this.idle)
    this.idle = undefined
    const thread = this.thread
    this.thread = undefined
    this.settleAll()
    void thread?.terminate()
  }

  private settleAll(): void {
    for (const settle of this.waiting.values()) settle(false)
    this.waiting.clear()
  }
}

/** A WAL that no frame has been written to since its last reset: absent, or no longer than its header. */
function walEmpty(path: string): boolean {
  const size = statSync(`${path}-wal`, { throwIfNoEntry: false })?.size
  return size === undefined || size <= 32
}
