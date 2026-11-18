import { Worker } from "node:worker_threads"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostWarn } from "../base/host-log.js"

/** One row a streamed flush writes: a block whole (its appends cleared), or what a block grew by, at its place among its appends. */
export type JournalWriteOp =
  | ["block", index: number, value: string, turn: [type: string, steering: number, request: string | null, message: string | null] | null]
  | ["append", index: number, sequence: number, value: string]

/** A journal's streamed writes, in the writer's hands. */
export interface JournalWrites {
  /** Rows of one flush, written after every one given before. While a write is under way they join the next, one transaction for all that came meanwhile. */
  write(revision: number, ops: readonly JournalWriteOp[], indexed: boolean): void
  /** Whether any of them isn't written yet. */
  pending(): boolean
  /**
   * Waits, on this thread, until everything given is written, and says why if any of it wasn't: what a reader of the
   * journal's rows, and a write its host makes itself, call first.
   */
  settle(): string | undefined
  /** `settle`, then the writer's connection closed before this returns: the journal's own is the last to close. */
  close(): string | undefined
}

/** How long `settle` waits for one write before it reads it as failed: a write this late is a disk that isn't answering. */
const SETTLE_MS = 30_000

const ReplySchema = z.object({ key: z.number(), seq: z.number(), error: z.string().optional() })

interface Handle {
  key: number
  cell: Int32Array
  /** The last message sent, and what waits for it to be done. */
  posted: number
  next: { revision: number; ops: JournalWriteOp[]; indexed: boolean } | undefined
  failure: string | undefined
  closed: boolean
}

/**
 * Writes what running turns stream to their journals on a thread of its own. A streamed flush's commit was the host's
 * thread waiting on a file write: 14 of them over 100 ms in five minutes with 30 Fins at work, each one every window's
 * tokens held. A journal hands its streamed rows here (`LiveJournal.writeWith`); they are written in order, one
 * transaction a message, and while one is being written what comes meanwhile waits as one message more, so a slow
 * disk grows a transaction and no queue. What the host must know written before it goes on (a request, a status, a
 * turn's end) it still commits itself, after `settle`.
 */
export class JournalWriter {
  private worker: Worker | undefined
  private readonly handles = new Map<number, Handle>()
  private nextKey = 0
  private stopped = false
  private dead: string | undefined
  private readonly entry: URL

  constructor(entry = new URL("./journal-writer-worker.js", import.meta.url)) {
    this.entry = entry
  }

  /** `path`'s streamed writes; undefined once stopped, or after the writer was lost, when its journal writes its own. */
  open(path: string, keptBytes: number): JournalWrites | undefined {
    if (this.stopped || this.dead !== undefined) return undefined
    const worker = this.thread()
    const handle: Handle = { key: (this.nextKey += 1), cell: new Int32Array(new SharedArrayBuffer(8)), posted: 0, next: undefined, failure: undefined, closed: false }
    this.handles.set(handle.key, handle)
    worker.postMessage({ kind: "open", key: handle.key, path, cell: handle.cell.buffer, keptBytes })
    const settle = (): string | undefined => {
      for (;;) {
        while (Atomics.load(handle.cell, 0) < handle.posted) {
          if (this.dead !== undefined) return handle.failure ??= this.dead
          const done = Atomics.load(handle.cell, 0)
          if (Atomics.wait(handle.cell, 0, done, SETTLE_MS) === "timed-out") return handle.failure ??= "its writer didn't answer"
        }
        if (Atomics.load(handle.cell, 1) !== 0) return handle.failure ??= "a write of it failed on its writer"
        if (!handle.next || handle.closed) return handle.failure
        this.send(handle)
      }
    }
    return {
      write: (revision, ops, indexed) => {
        if (handle.closed) return
        if (handle.next) {
          handle.next.revision = revision
          handle.next.indexed = indexed
          handle.next.ops.push(...ops)
        } else handle.next = { revision, ops: [...ops], indexed }
        if (Atomics.load(handle.cell, 0) >= handle.posted) this.send(handle)
      },
      pending: () => handle.next !== undefined || Atomics.load(handle.cell, 0) < handle.posted,
      settle,
      close: () => {
        if (handle.closed) return handle.failure
        const failure = settle()
        handle.closed = true
        handle.next = undefined
        if (this.dead === undefined && this.worker) {
          handle.posted += 1
          this.worker.postMessage({ kind: "close", key: handle.key, seq: handle.posted })
          while (Atomics.load(handle.cell, 0) < handle.posted && this.dead === undefined)
            if (Atomics.wait(handle.cell, 0, Atomics.load(handle.cell, 0), SETTLE_MS) === "timed-out") break
        }
        this.handles.delete(handle.key)
        return failure
      },
    }
  }

  /** Ends the writer. Every journal has closed its writes by then (`LiveClosing.stop`); one that hasn't reads them as lost. */
  async stop(): Promise<void> {
    this.stopped = true
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
    this.dead ??= "the host stopped"
  }

  private send(handle: Handle): void {
    const next = handle.next
    if (!next || !this.worker) return
    handle.next = undefined
    handle.posted += 1
    this.worker.postMessage({ kind: "write", key: handle.key, seq: handle.posted, revision: next.revision, ops: next.ops, indexed: next.indexed })
  }

  private thread(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.entry, { resourceLimits: { maxOldGenerationSizeMb: 256 } })
    worker.unref()
    worker.on("message", (message) => {
      const reply = ReplySchema.safeParse(message)
      if (!reply.success) return
      const handle = this.handles.get(reply.data.key)
      if (!handle) return
      if (reply.data.error !== undefined) handle.failure ??= reply.data.error
      // What came while that one was written goes now, as one.
      if (handle.next && !handle.closed && Atomics.load(handle.cell, 0) >= handle.posted) this.send(handle)
    })
    const lost = (why: string) => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.dead = why
      if (!this.stopped) hostWarn("journal", "the journal writer was lost; journals write their own streamed rows from here", { why })
    }
    worker.on("error", (error) => lost(errorMessage({ error })))
    worker.on("exit", (code) => lost(`it exited with ${code}`))
    this.worker = worker
    return worker
  }
}
