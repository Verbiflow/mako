import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { FileResolution, MovedPaths } from "../contracts/file-references.js"
import type { ChangeUsage, ThreadChangeSummary } from "../contracts/thread-changes.js"
import { TurnChangesSchema, type TurnChanges } from "../contracts/turn-changes.js"
import type { TurnUndoScope, WriterRun } from "../contracts/turn-review.js"
import type { CollectPlan, Row } from "./journal-store.js"
import type { CheckoutShares, Partition, PartitionOptions } from "./queries.js"
import type { ReferenceGit, ReferenceSource } from "./thread-files.js"
import type { ShownPair, TurnFileSpan, UndoPlan } from "./turn-lines.js"

/** How long a read may take before its generation is retired and the request rejects. */
const READ_TIMEOUT_MS = 30_000

/** Whose message a resolve reads for (`ReferenceSource`), as the host worked it out from its conversations. */
const ReferenceSourceSchema = z.object({ thread: z.string().optional(), cwd: z.string().optional(), current: z.array(z.string()), asOf: z.number().optional() })

/** A turn's file as its review and undo read it (`TurnFileSpan`): where it is, and the turn's entries that span it. */
const TurnFileSpanSchema = z.object({ path: z.string(), root: z.string(), relative: z.string(), from: z.string().optional(), entries: z.object({ first: z.number(), last: z.number() }) })
const ShownLinesSchema = z.array(z.string()).nullable()
const TurnUndoScopeSchema = z.union([z.object({ kind: z.literal("turn"), requestId: z.string() }), z.object({ kind: z.literal("thread") })])

/** What the journal's reader is asked (`journal-reader-worker.ts`). */
export const JournalReadSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.number(), kind: z.literal("thread-changes"), thread: z.string() }),
  z.object({ id: z.number(), kind: z.literal("resolve-files"), source: ReferenceSourceSchema, spellings: z.array(z.string()) }),
  z.object({ id: z.number(), kind: z.literal("moved-paths"), thread: z.string(), from: z.string(), to: z.string() }),
  z.object({ id: z.number(), kind: z.literal("activity-overlapping"), from: z.number(), to: z.number() }),
  z.object({ id: z.number(), kind: z.literal("blobs"), refs: z.array(z.string()).max(100_000) }),
  z.object({ id: z.number(), kind: z.literal("checkpoint-fingerprint"), checkout: z.string(), thread: z.string() }),
  z.object({ id: z.number(), kind: z.literal("partition"), checkout: z.string(), thread: z.string(), bring: z.boolean().optional() }),
  z.object({ id: z.number(), kind: z.literal("shares"), checkout: z.string(), thread: z.string() }),
  z.object({ id: z.number(), kind: z.literal("turn-writers"), thread: z.string(), turn: z.string(), file: TurnFileSpanSchema, shown: z.object({ before: ShownLinesSchema, after: ShownLinesSchema }).optional() }),
  z.object({ id: z.number(), kind: z.literal("turn-only"), thread: z.string(), turn: z.string(), file: TurnFileSpanSchema }),
  z.object({ id: z.number(), kind: z.literal("undo-plan"), thread: z.string(), scope: TurnUndoScopeSchema, checkout: z.string() }),
  z.object({ id: z.number(), kind: z.literal("change-usage"), since: z.number() }),
  z.object({ id: z.number(), kind: z.literal("count-turn"), thread: z.string(), turn: z.string(), state: z.enum(["settling", "settled"]) }),
])
type JournalRead = z.infer<typeof JournalReadSchema>

/**
 * A Git read the reader asks its host to run, and the answer: resolving file names reads a repository's folder and
 * renames, and the host's Git has the helper, the queue and the log those go through. The worker starts no Git itself.
 */
export const GitAskSchema = z.object({ git: z.number(), cwd: z.string(), args: z.array(z.string()), timeoutMs: z.number().optional() })
export const GitAnswerSchema = z.union([
  z.object({ git: z.number(), ok: z.literal(true), stdout: z.instanceof(Uint8Array) }),
  z.object({ git: z.number(), ok: z.literal(false), error: z.string() }),
])

const CountSchema = z.number()
const ThreadChangeSummarySchema = z.object({
  files: z.object({ created: CountSchema, changed: CountSchema, deleted: CountSchema, renamed: CountSchema }),
  lines: z.object({ added: CountSchema, removed: CountSchema }),
  commands: CountSchema,
  outside: z.object({ named: CountSchema, maybe: CountSchema }),
  maybe: CountSchema,
  keptSince: z.number().optional(),
})
const ChangeTotalsSchema = z.object({ files: CountSchema, added: CountSchema, removed: CountSchema, threads: CountSchema })
const ChangeUsageSchema = z.object({
  days: CountSchema,
  total: ChangeTotalsSchema,
  projects: z.array(ChangeTotalsSchema.extend({ path: z.string() })),
  certainty: z.object({ exact: CountSchema, named: CountSchema, window: CountSchema, ambiguous: CountSchema, person: CountSchema, mako: CountSchema }),
  moves: z.object({ moves: CountSchema, came: CountSchema, guessed: CountSchema, putBack: CountSchema, offered: CountSchema, brought: CountSchema }),
})

/**
 * What the worker posted of one of the journal's own functions' answers: the fields that say which answer it is are
 * checked, and the rest passes through, as a partition's files do.
 */
const PostedResolutionSchema = z.object({ kind: z.enum(["file", "choice", "none"]) }).loose()
const PostedMoveSchema = z.object({ root: z.object({ from: z.string(), to: z.string() }), more: z.number() }).loose()
const PostedSharesSchema = z.object({ thread: z.unknown(), likely: z.unknown(), others: z.unknown() }).loose()
const PostedRunSchema = z.object({ side: z.enum(["additions", "deletions"]), start: z.number(), length: z.number() }).loose()
const PostedUndoSchema = z.object({ writes: z.array(z.unknown()), undo: z.array(z.unknown()), kept: z.array(z.unknown()), left: z.array(z.unknown()) }).loose()

/** A value as SQLite gives it. */
const SqlValueSchema = z.union([z.string(), z.number(), z.bigint(), z.null(), z.instanceof(Uint8Array)])
const ReplySchema = z.union([
  z.object({ id: z.number(), ok: z.literal(true), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ id: z.number(), ok: z.literal(true), rows: z.array(z.record(z.string(), SqlValueSchema)) }),
  z.object({ id: z.number(), ok: z.literal(true), blobs: z.array(z.object({ ref: z.string(), bytes: z.instanceof(Uint8Array) })) }),
  // A partition, as `partition()` made it in the worker from the same journal: its shape checked, its files passed through.
  z.object({ id: z.number(), ok: z.literal(true), partition: z.object({ checkout: z.string(), thread: z.string(), files: z.array(z.unknown()) }).loose() }),
  z.object({ id: z.number(), ok: z.literal(true), count: TurnChangesSchema.nullable() }),
  // Answers the worker made with the function the host called before, each named for its question. Counts are checked
  // whole; an answer built from the journal's own rows has its shape checked and its members passed through, as a partition's.
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("thread-changes"), value: ThreadChangeSummarySchema }),
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("change-usage"), value: ChangeUsageSchema }),
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("resolve-files"), value: z.array(PostedResolutionSchema) }),
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("moved-paths"), value: PostedMoveSchema.nullable() }),
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("shares"), value: PostedSharesSchema }),
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("turn-writers"), value: z.array(PostedRunSchema).nullable() }),
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("turn-only"), value: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable() }),
  z.object({ id: z.number(), ok: z.literal(true), answered: z.literal("undo-plan"), value: PostedUndoSchema }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
])
type Reply = z.infer<typeof ReplySchema>
type Answer = Extract<Reply, { answered: string }>
type AnswerOf<K extends Answer["answered"]> = Extract<Answer, { answered: K }>["value"]

interface Pending {
  settle(reply: Reply): void
  fail(error: Error): void
  timer: NodeJS.Timeout
}

/**
 * Big reads of the record of changes, on a worker of their own. SQLite reads on the host's thread wait on the disk
 * there: on a journal of 1.7 GB, finding a few minutes of activity read the whole table (152 MB) and held the loop
 * 1.8 s cold, 2.7 s on the person's host. The worker starts at the first read and stays while reads come; it never
 * keeps the process alive. A failed read rejects; turn counts never fall back to the host's thread.
 */
export class JournalReader {
  private worker: Worker | undefined
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private closed = false
  private readonly path: string
  private readonly git: ReferenceGit | undefined
  private closing: Promise<void> | undefined
  private readonly retiring = new Set<Promise<void>>()
  private releaseFailure: Error | undefined

  /** `git`: the host's Git, which the worker's resolving of file names asks through; without it those reads go without Git. */
  constructor(path: string, git?: ReferenceGit) {
    this.path = path
    this.git = git
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
  partition(checkout: string, thread: string, options: PartitionOptions = {}): Promise<Partition> {
    return new Promise((resolve, reject) => {
      this.ask((id) => ({ id, kind: "partition", checkout, thread, ...(options.bring !== undefined && { bring: options.bring }) }), (reply) => {
        if (!reply.ok) reject(new Error(reply.error))
        else if ("partition" in reply) resolve(partitionOf(reply.partition))
        else reject(new Error("The journal's reader answered another question."))
      }, reject)
    })
  }

  /** Checkpoint identity without transporting or hashing the partition's bodies on the caller. */
  checkpointFingerprint(checkout: string, thread: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.ask((id) => ({ id, kind: "checkpoint-fingerprint", checkout, thread }), (reply) => {
        if (!reply.ok) reject(new Error(reply.error))
        else if ("fingerprint" in reply) resolve(reply.fingerprint)
        else reject(new Error("The journal's reader answered another question."))
      }, reject)
    })
  }

  /** A turn's complete count, including its SQLite content reads and decompression, on the reader. No main-thread fallback. */
  countTurn(thread: string, turn: string, state: TurnChanges["state"]): Promise<TurnChanges | undefined> {
    return new Promise((resolve, reject) => {
      this.ask((id) => ({ id, kind: "count-turn", thread, turn, state }), (reply) => {
        if (!reply.ok) reject(new Error(reply.error))
        else if ("count" in reply) resolve(reply.count ?? undefined)
        else reject(new Error("The journal's reader answered another question."))
      }, reject)
    })
  }

  /**
   * "Changes made" by a Thread (`threadSummary`). Its turns' summaries and its calls are as many as its history is
   * long, and the popover asks each time it opens and each time a turn settles.
   */
  threadChanges(thread: string): Promise<ThreadChangeSummary> {
    return this.answer("thread-changes", (id) => ({ id, kind: "thread-changes", thread }), (value) => value)
  }

  /**
   * Which file each spelling of a message means (`ThreadFiles.resolve`), asked once a message drawn: the worker keeps
   * the Thread's work, its places' indexes and their renames between questions, as the host's thread did.
   */
  resolveFiles(source: ReferenceSource, spellings: readonly string[]): Promise<FileResolution[]> {
    return this.answer("resolve-files", (id) => ({ id, kind: "resolve-files", source: { ...source, current: [...source.current] }, spellings: [...spellings] }),
      (value) => resolutionsOf(value))
  }

  /** What a Thread's agent hears of its paths when its checkout moves (`ThreadFiles.movedPaths`). */
  movedPaths(thread: string, from: string, to: string): Promise<MovedPaths | undefined> {
    return this.answer("moved-paths", (id) => ({ id, kind: "moved-paths", thread, from, to }),
      (value) => (value === null ? undefined : movedPathsOf(value)))
  }

  /** How `checkout`'s changes divide by whose they are (`shares()`): the same files and writers a partition reads, for a move's report. */
  shares(checkout: string, thread: string): Promise<CheckoutShares> {
    return this.answer("shares", (id) => ({ id, kind: "shares", checkout, thread }),
      (value) => sharesOf(value))
  }

  /** Who wrote each changed line of a turn's diff of a file (`turnWriters`): its versions are read, decompressed and walked on the reader. */
  turnWriters(thread: string, turn: string, file: TurnFileSpan, shown?: ShownPair): Promise<WriterRun[] | undefined> {
    const sides = shown && { before: shown.before && [...shown.before], after: shown.after && [...shown.after] }
    return this.answer("turn-writers", (id) => ({ id, kind: "turn-writers", thread, turn, file: spanOf(file), ...(sides && { shown: sides }) }),
      (value) => (value === null ? undefined : runsOf(value)))
  }

  /** A turn's diff of a file with only its own lines changed (`turnOnlyPair`). */
  turnOnly(thread: string, turn: string, file: TurnFileSpan): Promise<{ before: string | null; after: string | null } | undefined> {
    return this.answer("turn-only", (id) => ({ id, kind: "turn-only", thread, turn, file: spanOf(file) }), (value) => value ?? undefined)
  }

  /** How to take a turn's or a Thread's own lines back out of `checkout` (`undoPlan`): every file it wrote is walked from the journal. */
  undoPlan(thread: string, scope: TurnUndoScope, checkout: string): Promise<UndoPlan> {
    return this.answer("undo-plan", (id) => ({ id, kind: "undo-plan", thread, scope, checkout }),
      (value) => undoPlanOf(value))
  }

  /** Every Thread's changes made since `since` (`changeUsage`): three scans of the journal's window of entries. */
  changeUsage(since: number): Promise<ChangeUsage> {
    return this.answer("change-usage", (id) => ({ id, kind: "change-usage", since }), (value) => value)
  }

  /** The worker's answer to `kind`, its shape checked as it arrived (`ReplySchema`), as `read` makes of it; any other reply rejects. */
  private answer<K extends Answer["answered"], T>(kind: K, request: (id: number) => JournalRead, read: (value: AnswerOf<K>) => T): Promise<T> {
    return new Promise((resolve, reject) => {
      this.ask(request, (reply) => {
        if (!reply.ok) return reject(new Error(reply.error))
        if (!("answered" in reply) || reply.answered !== kind) return reject(new Error("The journal's reader answered another question."))
        // SAFETY: the reply is the union's member named `kind`, checked on the line above; its value is that member's.
        resolve(read(reply.value as AnswerOf<K>))
      }, reject)
    })
  }

  /** Refuse new reads immediately; completion joins every retired worker before its folder can be reused. */
  close(): Promise<void> {
    return this.closing ??= this.closeReader()
  }

  private async closeReader(): Promise<void> {
    this.closed = true
    this.stop(new Error("The record of changes closed."))
    await Promise.all(this.retiring)
    if (this.releaseFailure) throw this.releaseFailure
  }

  private ask(request: (id: number) => JournalRead, settle: (reply: Reply) => void, fail: (error: Error) => void): void {
    if (this.closed) return fail(new Error("The record of changes closed."))
    if (this.retiring.size) {
      void Promise.all(this.retiring).then(() => this.begin(request, settle, fail)).catch(fail)
      return
    }
    try { this.begin(request, settle, fail) }
    catch (error) { fail(error instanceof Error ? error : new Error("The journal's reader could not start.", { cause: error })) }
  }

  private begin(request: (id: number) => JournalRead, settle: (reply: Reply) => void, fail: (error: Error) => void): void {
    if (this.closed) return fail(new Error("The record of changes closed."))
    if (this.releaseFailure) return fail(this.releaseFailure)
    const worker = this.worker ?? this.start()
    const id = ++this.nextId
    const timer = setTimeout(() => {
      if (this.pending.has(id)) this.stop(new Error("The record of changes took too long to read."))
    }, READ_TIMEOUT_MS)
    timer.unref?.()
    this.pending.set(id, { settle, fail, timer })
    worker.ref()
    worker.postMessage(request(id))
  }

  private start(): Worker {
    const worker = new Worker(new URL("./journal-reader-worker.js", import.meta.url), {
      workerData: { path: this.path },
      // Room for what resolving file names keeps between questions (the work of up to 16 Threads, tens of MB for one of
      // 84,000 calls), which the host's own heap held before: past the limit the worker ends and every read waiting fails.
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 16 },
    })
    this.worker = worker
    worker.unref()
    worker.on("message", (message) => {
      if (this.worker !== worker) return
      const reply = ReplySchema.safeParse(message)
      if (!reply.success) {
        const asked = GitAskSchema.safeParse(message)
        if (asked.success) this.runGit(worker, asked.data)
        return
      }
      const pending = this.pending.get(reply.data.id)
      if (!pending) return
      this.pending.delete(reply.data.id)
      clearTimeout(pending.timer)
      if (!this.pending.size) worker.unref()
      pending.settle(reply.data)
    })
    worker.once("error", (error) => { if (this.worker === worker) this.stop(error) })
    worker.once("exit", (code) => {
      if (this.worker === worker) this.stop(new Error(`The journal's reader exited with ${code}.`))
    })
    return worker
  }

  /** A Git read the worker asked for, run by the host's Git and answered to that worker. */
  private runGit(worker: Worker, asked: z.infer<typeof GitAskSchema>): void {
    const { git, cwd, args, timeoutMs } = asked
    const answer = (reply: { git: number; ok: true; stdout: Uint8Array } | { git: number; ok: false; error: string }) => { if (this.worker === worker) worker.postMessage(reply) }
    if (!this.git) return answer({ git, ok: false, error: "This reader has no Git." })
    this.git.run({ cwd, args, read: true, ...(timeoutMs !== undefined && { timeoutMs }) }).then(
      (result) => answer({ git, ok: true, stdout: result.stdout }),
      (error: Error) => answer({ git, ok: false, error: error.message }),
    )
  }

  private stop(error: Error): void {
    const worker = this.worker
    this.worker = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.fail(error)
    }
    this.pending.clear()
    if (worker) {
      const released = (async () => {
        try { await worker.terminate() }
        catch (error) { this.releaseFailure ??= new Error("The journal's reader could not be released.", { cause: error }) }
      })()
      this.retiring.add(released)
      void released.then(() => this.retiring.delete(released))
    }
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

/** Only what a turn's lines are read by goes to the worker, not the file's counts. */
const spanOf = (file: TurnFileSpan): TurnFileSpan => ({ path: file.path, root: file.root, relative: file.relative, ...(file.from !== undefined && { from: file.from }), entries: { first: file.entries.first, last: file.entries.last } })

// Each answer below is what the function its question names returned in `journal-reader-worker.ts`, posted unchanged;
// the fields that tell the answers apart were checked as the reply arrived.
function resolutionsOf(posted: { kind: FileResolution["kind"] }[]): FileResolution[] {
  // SAFETY: only `journal-reader-worker.ts` answers, and it posts what `ThreadFiles.resolve` returned, unchanged.
  return posted as FileResolution[]
}

function movedPathsOf(posted: Pick<MovedPaths, "root" | "more">): MovedPaths {
  // SAFETY: only `journal-reader-worker.ts` answers, and it posts what `ThreadFiles.movedPaths` returned, unchanged.
  return posted as MovedPaths
}

function sharesOf(posted: { thread: unknown; likely: unknown; others: unknown }): CheckoutShares {
  // SAFETY: only `journal-reader-worker.ts` answers, and it posts what `shares()` returned, unchanged.
  return posted as CheckoutShares
}

function runsOf(posted: Pick<WriterRun, "side" | "start" | "length">[]): WriterRun[] {
  // SAFETY: only `journal-reader-worker.ts` answers, and it posts what `turnWriters` returned, unchanged.
  return posted as WriterRun[]
}

function undoPlanOf(posted: { writes: unknown[]; undo: unknown[]; kept: unknown[]; left: unknown[] }): UndoPlan {
  // SAFETY: only `journal-reader-worker.ts` answers, and it posts what `undoPlan` returned, unchanged.
  return posted as UndoPlan
}

/** A partition the reader posted back. */
function partitionOf(posted: { checkout: string; thread: string; files: unknown[] }): Partition {
  // SAFETY: only `journal-reader-worker.ts` answers, and it posts what `partition()` returned, unchanged.
  return posted as Partition
}
