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
  /** Whether these writes were closed, here or by the writer for every journal at once (`closeAll`): rows given now go nowhere. */
  closed(): boolean
  /**
   * Waits, on this thread, until everything given is written, and says why if any of it wasn't: what a reader of the
   * journal's rows, and a write its host makes itself, call first.
   */
  settle(): string | undefined
  /** `settle`, then the writer's connection closed before this returns: the journal's own is the last to close. */
  close(): string | undefined
  /**
   * Lets go of the writer's connection without waiting on this thread: its close follows what it was given, in order,
   * and the promise settles once the writer has closed it. For writes with nothing pending (`settle` first): a close
   * waited on the thread behind every other journal's writes, 180 to 210 ms with 30 Fins streaming.
   */
  release(): Promise<void>
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
  /** Every journal's writes are closing for the host's stop (`closeAll`): none opens again. */
  private closingAll = false
  /** Whether the worker holds the process up: only while a write of some journal is still owed its answer. */
  private holding = false
  private dead: string | undefined
  /** Who waits, off the thread, for the writer's next answer (`reached`). */
  private readonly answered = new Set<() => void>()
  private readonly entry: URL

  constructor(entry = new URL("./journal-writer-worker.js", import.meta.url)) {
    this.entry = entry
  }

  /** `path`'s streamed writes; undefined once stopped or closing, or after the writer was lost, when its journal writes its own. */
  open(path: string, keptBytes: number): JournalWrites | undefined {
    if (this.stopped || this.closingAll || this.dead !== undefined) return undefined
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
      closed: () => handle.closed,
      settle,
      close: () => {
        if (handle.closed) return handle.failure
        const failure = settle()
        handle.closed = true
        handle.next = undefined
        if (this.dead === undefined && this.worker) {
          handle.posted += 1
          this.worker.postMessage({ kind: "close", key: handle.key, seq: handle.posted })
          this.hold(true)
          while (Atomics.load(handle.cell, 0) < handle.posted && this.dead === undefined)
            if (Atomics.wait(handle.cell, 0, Atomics.load(handle.cell, 0), SETTLE_MS) === "timed-out") break
        }
        this.handles.delete(handle.key)
        return failure
      },
      release: async () => {
        if (handle.closed) return
        // Anything given and not yet sent goes first: the worker takes its messages in order.
        if (handle.next) this.send(handle)
        handle.closed = true
        if (this.dead === undefined && this.worker) {
          handle.posted += 1
          this.worker.postMessage({ kind: "close", key: handle.key, seq: handle.posted })
          this.hold(true)
          await this.reached(handle)
        }
        this.handles.delete(handle.key)
      },
    }
  }

  /**
   * Closes every journal's writes without holding the thread: what each was given is written, and its connection on
   * the writer closed, awaited. A journal closing after this finds its writes closed and waits for nothing; closed
   * one at a time as the host stopped, each waited on the thread for the writer's answer, 180 to 210 ms for a few
   * hundred. A journal that streams after this writes its own rows (`JournalWrites.closed`).
   */
  async closeAll(): Promise<void> {
    this.closingAll = true
    await Promise.all([...this.handles.values()].map(async (handle) => {
      for (;;) {
        await this.reached(handle)
        if (handle.closed || !handle.next || this.dead !== undefined) break
        this.send(handle)
      }
      if (handle.closed) return
      handle.closed = true
      handle.next = undefined
      if (this.dead === undefined && this.worker) {
        handle.posted += 1
        this.worker.postMessage({ kind: "close", key: handle.key, seq: handle.posted })
        this.hold(true)
        await this.reached(handle)
      }
      this.handles.delete(handle.key)
    }))
  }

  /** Once the writer has answered everything `handle` was posted, or is lost, or hasn't answered in `SETTLE_MS`. */
  private async reached(handle: Handle): Promise<void> {
    const until = performance.now() + SETTLE_MS
    while (Atomics.load(handle.cell, 0) < handle.posted && this.dead === undefined && performance.now() < until) {
      // The writer answers each message it has done; any answer, its loss, or the wait's end looks again.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.answered.delete(heard)
          resolve()
        }, SETTLE_MS)
        const heard = () => {
          clearTimeout(timer)
          resolve()
        }
        this.answered.add(heard)
      })
    }
  }

  private heard(): void {
    const waiting = [...this.answered]
    this.answered.clear()
    for (const heard of waiting) heard()
  }

  /** Ends the writer. Every journal has closed its writes by then (`LiveClosing.stop`); one that hasn't reads them as lost. */
  async stop(): Promise<void> {
    this.stopped = true
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
    this.dead ??= "the host stopped"
    this.heard()
  }

  private send(handle: Handle): void {
    const next = handle.next
    if (!next || !this.worker) return
    handle.next = undefined
    handle.posted += 1
    this.worker.postMessage({ kind: "write", key: handle.key, seq: handle.posted, revision: next.revision, ops: next.ops, indexed: next.indexed })
    this.hold(true)
  }

  private thread(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.entry, { resourceLimits: { maxOldGenerationSizeMb: 256 } })
    worker.on("message", (message) => {
      const reply = ReplySchema.safeParse(message)
      if (!reply.success) return
      this.heard()
      const handle = this.handles.get(reply.data.key)
      if (handle) {
        if (reply.data.error !== undefined) handle.failure ??= reply.data.error
        // What came while that one was written goes now, as one.
        if (handle.next && !handle.closed && Atomics.load(handle.cell, 0) >= handle.posted) this.send(handle)
      }
      // A journal closed on the thread is gone from `handles` by the time its close is answered.
      if (![...this.handles.values()].some((open) => open.next !== undefined || Atomics.load(open.cell, 0) < open.posted)) this.hold(false)
    })
    const lost = (why: string) => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.dead = why
      this.heard()
      if (!this.stopped) hostWarn("journal", "the journal writer was lost; journals write their own streamed rows from here", { why })
    }
    worker.on("error", (error) => lost(errorMessage({ error })))
    worker.on("exit", (code) => lost(`it exited with ${code}`))
    // Last: a "message" listener added after `unref` refs the worker's port again, and the process stays up for it.
    worker.unref()
    this.holding = false
    this.worker = worker
    return worker
  }

  /**
   * The worker holds the process up while a write is owed its answer, so a process that ends by itself doesn't end
   * with streamed rows still on their way; idle, it lets the process end, whoever forgot to stop it.
   */
  private hold(on: boolean): void {
    if (!this.worker || this.holding === on) return
    this.holding = on
    if (on) this.worker.ref()
    else this.worker.unref()
  }
}
