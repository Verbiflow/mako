import { statSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { z } from "zod"

const IDLE_MS = 5_000
const REQUEST_MS = 10_000
const MAX_OPEN = 32
const MAX_PENDING = 128
/** Leave headroom below the foreground's usual 1,000-page threshold. */
const CHECKPOINT_PAGES = 750
/** This exits background mode; a reader can still pin the WAL after foreground checkpoints resume. */
export const CHECKPOINT_WAL_LIMIT = 4 * 1024 * 1024

/** Workers use this process's SQLite build. Unknown NOOP used to mean PASSIVE before SQLite 3.51. */
function checkpointCountersAvailable(): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.sqlite ?? "")
  if (!parts) return false
  const [major, minor, patch] = parts.slice(1).map(Number)
  return [major, minor, patch].every(Number.isSafeInteger) && (major! > 3 || (major === 3 && minor! >= 51))
}

const PRIMER_SOURCE = `
const { DatabaseSync } = require("node:sqlite")
const { parentPort } = require("node:worker_threads")
const { statSync } = require("node:fs")
const journals = new Map()
parentPort.on("message", ({ id, kind, path, lease, pages }) => {
  try {
    if (kind === "prime") {
      const db = new DatabaseSync(path)
      try {
        db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL")
        const { user_version } = db.prepare("PRAGMA user_version").get()
        db.exec("PRAGMA user_version=" + Number(user_version))
      } finally { db.close() }
    } else if (kind === "open") {
      if (journals.size >= ${MAX_OPEN}) throw new Error("Checkpoint connection limit")
      const db = new DatabaseSync(path)
      try {
        db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=-128")
        const progress = db.prepare("PRAGMA wal_checkpoint(NOOP)")
        const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)")
        const row = progress.get()
        if (row.log < 0) throw new Error("No WAL to checkpoint")
        journals.set(lease, { db, path, progress, checkpoint })
      } catch (error) { db.close(); throw error }
    } else if (kind === "check") {
      const journal = journals.get(lease)
      if (!journal) throw new Error("Checkpoint lease has closed")
      let row = journal.progress.get()
      if (row.log >= pages && row.log > row.checkpointed) row = journal.checkpoint.get()
      const bytes = statSync(journal.path + "-wal", { throwIfNoEntry: false })?.size ?? 0
      parentPort.postMessage({ id, kind, ok: true, bytes, log: row.log, checkpointed: row.checkpointed })
      return
    } else if (kind === "release") {
      const journal = journals.get(lease)
      journals.delete(lease)
      journal?.db.close()
    } else throw new Error("Unknown checkpoint request")
    parentPort.postMessage({ id, kind, ok: true })
  } catch { parentPort.postMessage({ id, kind, ok: false }) }
})
`

const ReplyId = z.number().int().positive()
const Reply = z.union([
  z.object({ id: ReplyId, kind: z.enum(["prime", "open", "release"]), ok: z.boolean() }),
  z.object({ id: ReplyId, kind: z.literal("check"), ok: z.literal(true), bytes: z.number().nonnegative(), log: z.number().int(), checkpointed: z.number().int() }),
  z.object({ id: ReplyId, kind: z.literal("check"), ok: z.literal(false) }),
])
type Answer = z.infer<typeof Reply>
type Ask = { kind: "prime"; path: string } | { kind: "open"; lease: number; path: string } | { kind: "check"; lease: number; pages: number } | { kind: "release"; lease: number }
interface Generation {
  thread: Worker
  exited: Promise<void>
  closing?: Promise<void>
}
interface Pending { kind: Ask["kind"]; generation: Generation; timer: NodeJS.Timeout; settle(answer: Answer | undefined): void }
interface Lease {
  id: number
  path: string
  generation: Generation
  active: boolean
  disposed: boolean
  checking: boolean
  dirty: boolean
  pages: number
  changed(): void
  closing?: Promise<void>
}

/** A journal's checkpoint ownership, distinct from its data-writing connection on the host. */
export interface WalCheckpoint {
  active(): boolean
  committed(): void
  pages(pages: number): void
  close(): Promise<void>
}

/**
 * The existing slim SQLite primer also checks live journals on its own thread. Acknowledged leases alone may
 * disable the host's autocheckpoint. Lost/dead/timed-out ownership restores the foreground policy before another
 * write; a per-commit byte guard exits background mode too. No journal data or publish ordering moves here.
 */
export class WalPrimer {
  private generation: Generation | undefined
  private nextId = 1
  private readonly waiting = new Map<number, Pending>()
  private readonly leases = new Set<Lease>()
  private idle: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private closing?: Promise<void>
  private readonly retiring = new Set<Promise<void>>()
  private readonly options: { source?: string; requestMs?: number }
  /** Source/deadline injection keeps worker death and timeout tests on the actual message/lifetime path. */
  constructor(options: { source?: string; requestMs?: number } = {}) { this.options = options }

  /** The old header primer: a nonempty WAL is unchanged. */
  async prime(path: string): Promise<boolean> {
    if (this.stopped || !walEmpty(path)) return false
    return Boolean((await this.ask(this.worker(), { kind: "prime", path }))?.ok)
  }

  /** Foreground until this path's own connection is acknowledged; capacity refusal changes no policy. */
  watch(path: string, changed: () => void): WalCheckpoint | undefined {
    if (this.stopped || this.leases.size >= MAX_OPEN || !checkpointCountersAvailable()) return undefined
    const generation = this.worker()
    const lease: Lease = { id: this.nextId++, path, generation, active: false, disposed: false, checking: false, dirty: false, pages: CHECKPOINT_PAGES, changed }
    this.leases.add(lease)
    void this.ask(generation, { kind: "open", lease: lease.id, path }).then(answer => {
      if (lease.disposed || generation.closing) return
      if (!answer?.ok) { void this.release(lease); return }
      lease.active = true
      changed()
      this.check(lease)
    })
    return {
      active: () => lease.active,
      pages: pages => { lease.pages = Math.min(CHECKPOINT_PAGES, pages) },
      committed: () => {
        if (!lease.active || lease.disposed) return
        try {
          if ((statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0) >= CHECKPOINT_WAL_LIMIT) {
            void this.release(lease)
            return
          }
        } catch { void this.release(lease); return }
        if (lease.checking) lease.dirty = true
        else this.check(lease)
      },
      close: () => this.release(lease),
    }
  }

  stop(): Promise<void> {
    this.stopped = true
    this.closing ??= (async () => {
      await Promise.all([...this.leases].map(lease => this.release(lease)))
      if (this.generation) void this.retire(this.generation)
      await Promise.all([...this.retiring])
    })()
    return this.closing
  }

  private check(lease: Lease): void {
    if (!lease.active || lease.disposed) return
    lease.checking = true
    lease.dirty = false
    void this.ask(lease.generation, { kind: "check", lease: lease.id, pages: lease.pages }).then(answer => {
      lease.checking = false
      if (lease.disposed) return
      if (answer?.kind !== "check" || !answer.ok || answer.bytes >= CHECKPOINT_WAL_LIMIT) { void this.release(lease); return }
      if (lease.dirty) this.check(lease)
    })
  }

  private release(lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing
    lease.disposed = true
    lease.active = false
    lease.changed()
    lease.closing = (async () => {
      // A release reply follows every earlier check on this worker. A lost worker must actually exit before a
      // journal's file can be reclaimed, not merely before the caller was told it failed.
      if (lease.generation.closing) await lease.generation.closing
      else {
        const answer = await this.ask(lease.generation, { kind: "release", lease: lease.id })
        if (!answer?.ok) await this.retire(lease.generation)
      }
      this.leases.delete(lease)
      this.rest()
    })()
    return lease.closing
  }

  private worker(): Generation {
    if (this.generation) return this.generation
    clearTimeout(this.idle)
    const thread = new Worker(this.options.source ?? PRIMER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 } })
    const generation: Generation = { thread, exited: new Promise(resolve => thread.once("exit", () => resolve())) }
    this.generation = generation
    thread.on("message", raw => {
      const reply = Reply.safeParse(raw)
      if (!reply.success) return
      const pending = this.waiting.get(reply.data.id)
      if (!pending || pending.generation !== generation) return
      if (reply.data.kind !== pending.kind) { void this.retire(generation); return }
      clearTimeout(pending.timer)
      this.waiting.delete(reply.data.id)
      pending.settle(reply.data)
      this.rest()
    })
    thread.once("error", () => { void this.retire(generation) })
    thread.once("exit", () => { void this.retire(generation) })
    thread.unref()
    return generation
  }

  private ask(generation: Generation, request: Ask): Promise<Answer | undefined> {
    if (generation.closing || this.waiting.size >= MAX_PENDING) return Promise.resolve(undefined)
    clearTimeout(this.idle)
    const id = this.nextId++
    return new Promise(resolve => {
      const timer = setTimeout(() => { void this.retire(generation) }, this.options.requestMs ?? REQUEST_MS)
      this.waiting.set(id, { kind: request.kind, generation, timer, settle: resolve })
      generation.thread.ref()
      try { generation.thread.postMessage({ ...request, id }) }
      catch { void this.retire(generation) }
    })
  }

  private retire(generation: Generation): Promise<void> {
    if (generation.closing) return generation.closing
    if (this.generation === generation) this.generation = undefined
    clearTimeout(this.idle)
    generation.closing = generation.thread.terminate().then(() => generation.exited)
    this.retiring.add(generation.closing)
    void generation.closing.finally(() => this.retiring.delete(generation.closing!))
    // Invalidate every lease before settling callers: reentrant opens belong to a new generation.
    for (const lease of this.leases) if (lease.generation === generation && !lease.disposed) {
      lease.active = false
      lease.changed()
      void this.release(lease)
    }
    for (const [id, pending] of this.waiting) if (pending.generation === generation) {
      clearTimeout(pending.timer)
      this.waiting.delete(id)
      pending.settle(undefined)
    }
    return generation.closing
  }

  private rest(): void {
    if (this.waiting.size) return
    this.generation?.thread.unref()
    if (this.leases.size || this.stopped || !this.generation) return
    clearTimeout(this.idle)
    this.idle = setTimeout(() => { if (this.generation) void this.retire(this.generation) }, IDLE_MS)
    this.idle.unref()
  }
}

function walEmpty(path: string): boolean {
  const size = statSync(`${path}-wal`, { throwIfNoEntry: false })?.size
  return size === undefined || size <= 32
}
