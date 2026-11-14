import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { CollectPlan, Row } from "./journal-store.js"
import type { Partition } from "./queries.js"

/** How long a read may take before the caller reads on its own thread instead. */
const READ_TIMEOUT_MS = 30_000

/** What the journal's reader is asked (`journal-reader-worker.ts`). */
export const JournalReadSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.number(), kind: z.literal("activity-overlapping"), from: z.number(), to: z.number() }),
  z.object({ id: z.number(), kind: z.literal("blobs"), refs: z.array(z.string()).max(100_000) }),
  z.object({ id: z.number(), kind: z.literal("partition"), checkout: z.string(), thread: z.string() }),
])
type JournalRead = z.infer<typeof JournalReadSchema>

/** A value as SQLite gives it. */
const SqlValueSchema = z.union([z.string(), z.number(), z.bigint(), z.null(), z.instanceof(Uint8Array)])
const ReplySchema = z.union([
  z.object({ id: z.number(), ok: z.literal(true), rows: z.array(z.record(z.string(), SqlValueSchema)) }),
  z.object({ id: z.number(), ok: z.literal(true), blobs: z.array(z.object({ ref: z.string(), bytes: z.instanceof(Uint8Array) })) }),
  // A partition, as `partition()` made it in the worker from the same journal: its shape checked, its files passed through.
  z.object({ id: z.number(), ok: z.literal(true), partition: z.object({ checkout: z.string(), thread: z.string(), files: z.array(z.unknown()) }).loose() }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
])
type Reply = z.infer<typeof ReplySchema>

interface Pending {
  settle(reply: Reply): void
  fail(error: Error): void
  timer: NodeJS.Timeout
}

/**
 * Big reads of the record of changes, on a worker of their own. SQLite reads on the host's thread wait on the disk
 * there: on a journal of 1.7 GB, finding a few minutes of activity read the whole table (152 MB) and held the loop
 * 1.8 s cold, 2.7 s on the person's host. The worker starts at the first read and stays while reads come; it never
 * keeps the process alive. A read that fails or takes too long rejects, and the caller reads on its own thread.
 */
export class JournalReader {
  private worker: Worker | undefined
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private closed = false
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /** Rows of the activity overlapping `[from, to]`, as SQLite gives them (`JournalStore.activityOfRows` reads them). */
  activityOverlapping(from: number, to: number): Promise<Row[]> {
    return new Promise((resolve, reject) => {
      this.ask((id) => ({ id, kind: "activity-overlapping", from, to }), (reply) => {
        if (!reply.ok) reject(new Error(reply.error))
        else if ("rows" in reply) resolve(reply.rows)
        else reject(new Error("The journal's reader answered another question."))
      }, reject)
    })
  }

  /** Stored contents by their refs, decompressed as `JournalStore.blob` gives them; one the journal doesn't hold is missing. */
  blobs(refs: readonly string[]): Promise<Map<string, Uint8Array>> {
    if (!refs.length) return Promise.resolve(new Map())
    return new Promise((resolve, reject) => {
      this.ask((id) => ({ id, kind: "blobs", refs: [...refs] }), (reply) => {
        if (!reply.ok) reject(new Error(reply.error))
        else if ("blobs" in reply) resolve(new Map(reply.blobs.map((blob) => [blob.ref, blob.bytes])))
        else reject(new Error("The journal's reader answered another question."))
      }, reject)
    })
  }

  /**
   * How `checkout`'s uncommitted changes divide for `thread` (`partition()`), read from what the journal committed. On
   * a journal of 1.86 GB, a checkout of 553 changed files held the host's loop 558 ms cold read on its thread.
   */
  partition(checkout: string, thread: string): Promise<Partition> {
    return new Promise((resolve, reject) => {
      this.ask((id) => ({ id, kind: "partition", checkout, thread }), (reply) => {
        if (!reply.ok) reject(new Error(reply.error))
        else if ("partition" in reply) resolve(partitionOf(reply.partition))
        else reject(new Error("The journal's reader answered another question."))
      }, reject)
    })
  }

  close(): void {
    this.closed = true
    this.stop(new Error("The record of changes closed."))
  }

  private ask(request: (id: number) => JournalRead, settle: (reply: Reply) => void, fail: (error: Error) => void): void {
    if (this.closed) return fail(new Error("The record of changes closed."))
    const worker = this.worker ?? this.start()
    const id = ++this.nextId
    const timer = setTimeout(() => this.stop(new Error("The record of changes took too long to read.")), READ_TIMEOUT_MS)
    timer.unref?.()
    this.pending.set(id, { settle, fail, timer })
    worker.ref()
    worker.postMessage(request(id))
  }

  private start(): Worker {
    const worker = new Worker(new URL("./journal-reader-worker.js", import.meta.url), {
      workerData: { path: this.path },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    this.worker = worker
    worker.unref()
    worker.on("message", (message) => {
      const reply = ReplySchema.safeParse(message)
      if (!reply.success) return
      const pending = this.pending.get(reply.data.id)
      if (!pending) return
      this.pending.delete(reply.data.id)
      clearTimeout(pending.timer)
      if (!this.pending.size) worker.unref()
      pending.settle(reply.data)
    })
    worker.once("error", (error) => this.stop(error))
    worker.once("exit", (code) => {
      if (this.worker === worker) this.stop(new Error(`The journal's reader exited with ${code}.`))
    })
    return worker
  }

  private stop(error: Error): void {
    const worker = this.worker
    this.worker = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.fail(error)
    }
    this.pending.clear()
    if (worker) void worker.terminate()
  }
}

const PlanSchema = z.union([
  z.object({ ok: z.literal(true), refs: z.array(z.object({ ref: z.string(), bytes: z.number() })), before: z.object({ count: z.number(), bytes: z.number() }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
const COLLECT_TIMEOUT_MS = 10 * 60_000

/** What collecting the journal at `path` drops (`collectPlan`), read on a worker of its own (`journal-collect-worker.ts`). */
export function collectPlanOffThread(path: string, retainAfter: number, budget: number): Promise<CollectPlan> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./journal-collect-worker.js", import.meta.url), {
      workerData: { path, retainAfter, budget },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    })
    let done = false
    const finish = (outcome: CollectPlan | Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      void worker.terminate()
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    const timer = setTimeout(() => finish(new Error("Reading what to collect took too long.")), COLLECT_TIMEOUT_MS)
    timer.unref?.()
    worker.once("message", (message) => {
      const reply = PlanSchema.safeParse(message)
      if (!reply.success) return finish(new Error("The collection's worker answered what isn't a plan."))
      if (!reply.data.ok) return finish(new Error(reply.data.error))
      finish({ refs: reply.data.refs, before: reply.data.before })
    })
    worker.once("error", (error) => finish(error))
    worker.once("exit", (code) => finish(new Error(`The collection's worker exited with ${code}.`)))
  })
}

/** A partition the reader posted back. */
function partitionOf(posted: { checkout: string; thread: string; files: unknown[] }): Partition {
  // SAFETY: only `journal-reader-worker.ts` answers, and it posts what `partition()` returned, unchanged.
  return posted as Partition
}
