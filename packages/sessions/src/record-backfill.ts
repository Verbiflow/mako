import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { ThreadRef } from "./format.js"
import { LockUnavailableError, takeLock } from "./record-locks.js"
import type { BackfillOutcome, RecordCapture } from "./record-capture.js"
import type { RecordStore } from "./record-store.js"
import type { RepackReport } from "./record-repack.js"
import type { ArchiveMigration, ArchiveMigrationReport } from "./archive-migration.js"
import { totals, type AttachmentSweepControl, type AttachmentSweepReport } from "./attachment-sweep.js"
import { pruneStreams, PruneMemory, type PruneReport } from "./record-stream-prune.js"

/**
 * Every session in the rail, taken into the record store, newest first.
 *
 * Live capture (`RecordCapture.wrote`) takes what a harness writes while the
 * catalog runs; a session written before then waits for this. A pass walks
 * the catalog's list and asks `RecordCapture.backfill` for each session in
 * turn:
 *
 * - **Held at its stamp:** each finished capture keeps the session's stamp
 *   (the catalog's stamp of its native records, and its streams' sizes) in
 *   the same transaction as its last versions. A session whose stamp hasn't
 *   moved is passed by for a stat of its streams, without a read. So a pass
 *   cut short by a quit or a crash continues where it stopped, and the
 *   passes after the first cost little.
 * - **Yielding:** one session at a time, each only once no live capture
 *   runs and no decode the person asked for is under way. Inside a long
 *   capture the store's turns let a waiting live capture in between slices
 *   (`RecordStore`), and the backfill never sets a session's pace.
 * - **The disk:** a session the store has none of is taken only if the disk
 *   keeps 2 GiB free with the session counted at its full size; otherwise
 *   it's passed by, counted and logged, and asked again next pass.
 * - **One process:** a pass holds the store's backfill lock
 *   (`record-locks.ts`: `backfill.lock` under `O_EXLOCK` on macOS, an
 *   abstract socket name on Linux, a named pipe on Windows), held by the
 *   kernel, so two catalogs on one store (a second Mako, another worktree's
 *   host) don't walk the same sessions side by side. One that finds it held
 *   tries again at its next wake. Where the kernel can hold no lock (no
 *   `AF_UNIX` under a sandbox's policy), no pass runs, and that's said once.
 * - **Then the streams and the packs:** each pass ends by pruning the loose
 *   stream files the store holds whole (`record-stream-prune.ts`), then
 *   repacking (`record-repack.ts`): dropping what a person's deletion and
 *   captures cut short left (`record-orphans.ts`), laying out quiet
 *   sessions together, compacting mostly-dead packs.
 *
 * Deleting: a session the person deletes in Mako leaves the list, and
 * `RecordCapture.forget` drops it from the store; a pass never brings it
 * back. One its harness deletes leaves the list too, and its records stay.
 *
 * The archive: once a pass has taken every session, the archive's copies
 * of the sessions it now holds are dropped (`archive-migration.ts`), one at
 * a time, yielding as captures do; what's left of the archive is Mako's
 * copy of sessions nothing else holds. Then the attachment files Mako keeps
 * (beside the archive's copies, each profile's `LiveAssets`, the staged
 * files) that no reader on this machine names any more go to a trash
 * folder, and a later pass deletes them (`attachment-sweep.ts`).
 *
 * A pass's progress is logged (counts, bytes, ms) and written to
 * `backfill.json` beside the store for `records.ts backfill`, which compares
 * the rail with the store's stamps itself.
 */

/** Passes after the first: a live capture that gave up, a stream whose writer has since exited. */
const PASS_EVERY_MS = 10 * 60_000
/** How often a running pass logs and writes its progress. */
const PROGRESS_MS = 30_000
/** Captures slower than this are logged one by one. */
const SLOW_SESSION_MS = 1_000
export const BACKFILL_PROGRESS = "backfill.json"

/** What a pass's linking of children's paths for sessions captured before captures named them came to (`SessionCatalog.linkChildren`). */
export const ChildLinkFillSchema = z.object({
  looked: z.number().int().nonnegative(),
  /** Sessions with a child, and the children whose paths were kept. */
  parents: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),
  /** Sessions its harness deleted, linked from their records read back. */
  kept: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
})
export type ChildLinkFill = z.infer<typeof ChildLinkFillSchema>

export const BackfillProgressSchema = z.object({
  /** Why this pass ran: `start`, `again`, `lock`. */
  reason: z.string(),
  pid: z.number(),
  startedAt: z.number(),
  /** Set once the pass walked every session; absent while it runs or after it was cut short. */
  endedAt: z.number().optional(),
  sessions: z.number(),
  /** Sessions asked so far, newest first. */
  done: z.number(),
  held: z.number(),
  captured: z.number(),
  live: z.number(),
  gone: z.number(),
  refused: z.number(),
  failed: z.number(),
  /** What the captures read and stored. */
  newBytes: z.number(),
  storedBytes: z.number(),
  /** The pass's own time, and the time it waited for live captures and decodes. */
  ms: z.number(),
  yieldedMs: z.number(),
  longestMs: z.number(),
  longestReadMs: z.number(),
  longest: z.string().optional(),
  firstRefusal: z.string().optional(),
  firstFailure: z.string().optional(),
  prune: z.object({ files: z.number(), pruned: z.number(), prunedEnded: z.number(), restamped: z.number(), bytes: z.number(), live: z.number(), unnamed: z.number(), notHeld: z.number(), differs: z.number(), unbound: z.number(), ms: z.number() }).optional(),
  repack: z.object({ dropped: z.number(), droppedBytes: z.number(), scrubbedBytes: z.number(), grouped: z.number(), alreadyGrouped: z.number(), copied: z.number(), copiedBytes: z.number(), packsWritten: z.number(), packsRemoved: z.number(), packBytesBefore: z.number(), packBytesAfter: z.number(), ms: z.number(), longestTurnMs: z.number(),
    orphans: z.object({ scanned: z.boolean(), sweep: z.boolean(), scanMs: z.number(), turnMs: z.number(), unnamed: z.number(), forgotten: z.number(), abandoned: z.number(), swept: z.number(), running: z.number(), waiting: z.number(), intentsCleared: z.number() }).optional(),
    trim: z.object({ pack: z.number().nullable(), bytes: z.number(), resumed: z.boolean(), skipped: z.string().nullable() }).optional() }).optional(),
  /** Children's paths linked for sessions captured before captures named them, when the pass ran it. */
  children: ChildLinkFillSchema.optional(),
  /** The archive's migration (`ArchiveMigrationReport`), when the pass ran it. */
  archive: z.object({
    rows: z.number(), migrated: z.number(), viaHarness: z.number(), viaRecords: z.number(), copies: z.number(), newCopies: z.number(),
    pending: z.number(), children: z.number(), failed: z.number(), firstFailure: z.string().optional(), legacyFolded: z.number(), legacyRemoved: z.number(),
    ms: z.number(), yieldedMs: z.number(), longestMs: z.number(), longest: z.string().optional(),
    decodeMs: z.number(), longestDecodeMs: z.number(), longestDropMs: z.number(),
    reclaim: z.object({ ran: z.boolean(), why: z.string().optional(), bytesBefore: z.number(), bytesAfter: z.number(), freeBytes: z.number(), ms: z.number() }).optional(),
    left: z.object({ rows: z.number(), copies: z.number(), pending: z.number(), migrated: z.number() }),
  }).optional(),
  /** Mako's attachment files (`AttachmentSweepReport`, in short, over every folder), when the pass swept them. */
  assets: z.object({
    ran: z.boolean(), stopped: z.string().optional(), files: z.number(), bytes: z.number(), named: z.number(), namedBytes: z.number(),
    held: z.number(), heldBytes: z.number(), young: z.number(), reclaimable: z.number(), trashed: z.number(), trashedBytes: z.number(), restored: z.number(),
    deleted: z.number(), deletedBytes: z.number(), trash: z.number(), trashBytes: z.number(),
    sourcesRead: z.number(), sourcesCached: z.number(), unreadable: z.number(), ms: z.number(),
    /** What held files this pass, each said once: a browser that can't be read, a running host of an older build. */
    holds: z.string().optional(),
  }).optional(),
})
export type BackfillProgress = z.infer<typeof BackfillProgressSchema>

/** What a log line names beside its words: counts, bytes, ms, ids. */
export type BackfillFields = Record<string, string | number | boolean | null>
export type BackfillLog = (message: string, fields: BackfillFields) => void

export interface RecordBackfillOptions {
  /** Every session in the rail, newest first, as the catalog lists it now. */
  sessions: () => ThreadRef[]
  /** Whether the catalog still lists `ref`: the person may delete it mid-pass. */
  listed: (ref: ThreadRef) => boolean
  /** Work the person is waiting on (the catalog's decodes), which a pass lets finish before each session. */
  foreground?: () => Promise<unknown>[]
  /** The streams folder whose loose files each pass prunes. */
  streams: string
  log?: BackfillLog
  /** The archive's migration, run once a pass has taken every session. */
  archive?: ArchiveMigration
  /** Mako's attachment files, swept right after the archive's migration (`AttachmentSweep`). */
  assets?: { pass(control: AttachmentSweepControl, options: { sweep: true }): Promise<AttachmentSweepReport> }
  /**
   * The paths of the children of sessions captured before captures named
   * them, kept once per session once a pass has taken every session
   * (`SessionCatalog`'s `linkChildren`), so a link to such a child opens
   * from its parent's records without the parent being listed first.
   */
  children?: { link(control: { stopped(): boolean; yieldToPerson(): Promise<void> }): Promise<ChildLinkFill> }
}


export class RecordBackfill {
  private running: Promise<void> | null = null
  private stopped = false
  private lastEndedAt = 0
  /** A pass found the lock held, or was cut short: the next wake runs one. */
  private owed = true
  private lockHeldLogged = false
  private lockUnavailableLogged = false
  private readonly memory = new PruneMemory()
  private current: BackfillProgress | null = null

  constructor(
    private readonly capture: RecordCapture,
    private readonly store: RecordStore,
    private readonly options: RecordBackfillOptions
  ) {}

  /** The pass running, or the last one this process ran. */
  get progress(): BackfillProgress | null {
    return this.current
  }

  /**
   * Runs a pass: at `start` always, otherwise when one is owed (cut short,
   * or the lock was held) or the last ended `PASS_EVERY_MS` ago. A wake
   * during a pass is folded into it.
   */
  wake(reason: "start" | "again" = "again"): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) return this.running
    if (reason !== "start" && !this.owed && Date.now() - this.lastEndedAt < PASS_EVERY_MS) return Promise.resolve()
    const running = this.guarded(reason).finally(() => {
      this.running = null
    })
    this.running = running
    return running
  }

  private async guarded(reason: string): Promise<void> {
    try {
      await this.pass(reason)
    } catch (error) {
      // Asked again with the passes after the first, not at every wake.
      this.owed = false
      this.lastEndedAt = Date.now()
      // No lock to be had here (`LockUnavailableError`): said once, and the passes after ask again quietly.
      if (error instanceof LockUnavailableError) {
        if (!this.lockUnavailableLogged) this.log("Session records backfill can't run without its lock", { error: error.message })
        this.lockUnavailableLogged = true
        return
      }
      this.log("Session records backfill failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Ends the pass at the session it's on; what it took is kept, and the next start continues from there. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.running
  }

  private log(message: string, fields: BackfillFields): void {
    ;(this.options.log ?? defaultLog)(message, fields)
  }

  private async pass(reason: string): Promise<void> {
    // A store a newer Mako raised is its to fill; nothing to pass over, and nothing to log every ten minutes.
    if (this.capture.declined()) return
    const lock = await takeLock(join(this.store.folder, "backfill.lock"))
    if (lock === null) {
      this.owed = true
      if (!this.lockHeldLogged) this.log("Session records backfill: another process is running it", { folder: this.store.folder })
      this.lockHeldLogged = true
      return
    }
    this.lockHeldLogged = false
    try {
      await this.walk(reason)
    } finally {
      await lock.release()
    }
  }

  private async walk(reason: string): Promise<void> {
    const refs = this.options.sessions().filter((ref) => !ref.archived)
    const started = Date.now()
    const progress: BackfillProgress = {
      reason, pid: process.pid, startedAt: started, sessions: refs.length, done: 0,
      held: 0, captured: 0, live: 0, gone: 0, refused: 0, failed: 0,
      newBytes: 0, storedBytes: 0, ms: 0, yieldedMs: 0, longestMs: 0, longestReadMs: 0,
    }
    this.current = progress
    this.log("Session records backfill started", { reason, sessions: refs.length })
    let reported = started
    for (const ref of refs) {
      // A newer Mako raised the store's format: the pass ends, and an updated build's takes the rest.
      if (this.stopped || this.capture.declined()) break
      const yielded = Date.now()
      await this.yieldToPerson()
      progress.yieldedMs += Date.now() - yielded
      if (this.stopped) break
      const asked = Date.now()
      const outcome = this.options.listed(ref) ? await this.capture.backfill(ref) : { kind: "gone" as const }
      this.count(progress, ref, outcome, Date.now() - asked)
      progress.done += 1
      progress.ms = Date.now() - started - progress.yieldedMs
      if (Date.now() - reported >= PROGRESS_MS) {
        reported = Date.now()
        this.log("Session records backfill progress", fields(progress))
        await this.save(progress)
      }
    }
    const complete = progress.done === refs.length
    if (complete && !this.stopped) {
      const prune = await this.prune()
      if (prune) {
        progress.prune = { ...prune, differs: prune.differs.length }
        for (const path of prune.differs) this.log("A stream differs from what the record store holds of it; kept", { path })
      }
      const archive = await this.migrateArchive()
      if (archive) progress.archive = archive
      const assets = await this.sweepAssets()
      if (assets) progress.assets = assets
      const children = await this.linkChildren()
      if (children) progress.children = children
      const repack = await this.repack()
      if (repack?.ran) {
        const { ran: _ran, leftovers: _leftovers, ...counts } = repack
        progress.repack = counts
      }
      progress.endedAt = Date.now()
    }
    progress.ms = Date.now() - started - progress.yieldedMs
    this.owed = !complete
    this.lastEndedAt = Date.now()
    this.log(complete ? "Session records backfill done" : "Session records backfill stopped", fields(progress))
    await this.save(progress)
  }

  /** The archive's copies of what the store now holds, dropped (`archive-migration.ts`); null without an archive or when it failed. */
  private async migrateArchive(): Promise<ArchiveMigrationReport | null> {
    const migration = this.options.archive
    if (!migration) return null
    try {
      const report = await migration.pass({ stopped: () => this.stopped, yieldToPerson: () => this.yieldToPerson() })
      if (report.rows || report.legacyFolded || report.legacyRemoved) this.log("Session archive migration", archiveFields(report))
      return report
    } catch (error) {
      this.log("Session archive migration failed", { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** Attachment files no reader names, trashed, and those trashed long enough deleted; null without an archive, or when it failed. */
  private async sweepAssets(): Promise<BackfillProgress["assets"] | null> {
    const assets = this.options.assets
    if (!assets) return null
    try {
      const report = await assets.pass({ stopped: () => this.stopped, yieldToPerson: () => this.yieldToPerson() }, { sweep: true })
      const short = assetFields(report)
      if (report.ran && (short.trashed || short.restored || short.deleted || short.stopped || short.held)) this.log("Attachment files swept", short)
      return short
    } catch (error) {
      this.log("Attachment files sweep failed", { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** Children's paths kept for sessions captured before captures named them; null without a catalog to ask, or when it failed. */
  private async linkChildren(): Promise<ChildLinkFill | null> {
    const children = this.options.children
    if (!children) return null
    try {
      const report = await children.link({ stopped: () => this.stopped, yieldToPerson: () => this.yieldToPerson() })
      if (report.looked) this.log("Session children linked", { ...report })
      return report
    } catch (error) {
      this.log("Session children could not be linked", { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** The store's packs, compacted and laid out by session (`record-repack.ts`), once the pass has taken every session. */
  private async repack(): Promise<RepackReport | null> {
    try {
      return await this.store.repack()
    } catch (error) {
      this.log("Session records repack failed", { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  private async prune(): Promise<PruneReport | null> {
    try {
      return await pruneStreams(this.store, this.options.streams, this.memory)
    } catch (error) {
      this.log("Session stream pruning failed", { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** Waits until no live capture runs and nothing the person asked of the catalog is being decoded. */
  private async yieldToPerson(): Promise<void> {
    for (;;) {
      await this.capture.idle()
      const busy = this.options.foreground?.() ?? []
      if (!busy.length || this.stopped) return
      await Promise.allSettled(busy)
    }
  }

  private count(progress: BackfillProgress, ref: ThreadRef, outcome: BackfillOutcome, ms: number): void {
    const session = `${ref.harness} ${ref.nativeId}`
    switch (outcome.kind) {
      case "held":
      case "live":
      case "gone":
        progress[outcome.kind] += 1
        return
      case "refused":
        progress.refused += 1
        progress.firstRefusal ??= `${session}: ${outcome.reason}`
        this.log("Session records backfill passed a session by: the disk is too full", { harness: ref.harness, nativeId: ref.nativeId, bytes: outcome.bytes, reason: outcome.reason })
        return
      case "failed":
        progress.failed += 1
        progress.firstFailure ??= `${session}: ${outcome.message}`
        this.log("Session records backfill failed a session", { harness: ref.harness, nativeId: ref.nativeId, error: outcome.message })
        return
      case "captured": {
        const report = outcome.report
        progress.captured += 1
        progress.newBytes += report.newBytes
        progress.storedBytes += report.storedBytes
        progress.longestReadMs = Math.max(progress.longestReadMs, report.longestReadMs)
        if (ms > progress.longestMs) {
          progress.longestMs = ms
          progress.longest = session
        }
        if (ms >= SLOW_SESSION_MS)
          this.log("Session records backfill took a session", {
            harness: ref.harness, nativeId: ref.nativeId, ms, storeMs: report.ms, waitedMs: report.waitedMs,
            versions: report.taken, newBytes: report.newBytes, storedBytes: report.storedBytes, longestReadMs: report.longestReadMs,
          })
      }
    }
  }

  private async save(progress: BackfillProgress): Promise<void> {
    const path = join(this.store.folder, BACKFILL_PROGRESS)
    const temporary = `${path}.${process.pid}.tmp`
    try {
      await mkdir(this.store.folder, { recursive: true })
      await writeFile(temporary, JSON.stringify(progress))
      await rename(temporary, path)
    } catch {
      // Progress is for reading; the stamps in the store are what a pass continues from.
    }
  }
}

/** The last pass's progress beside the store at `folder`, as a pass wrote it. */
export async function backfillProgress(folder: string): Promise<BackfillProgress | null> {
  const text = await readFile(join(folder, BACKFILL_PROGRESS), "utf8").catch(() => null)
  if (text === null) return null
  try {
    return BackfillProgressSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/** The archive's migration as a log line's fields. */
function archiveFields(report: ArchiveMigrationReport) {
  const { reclaim, left, firstFailure, longest, ...counts } = report
  return {
    ...counts,
    firstFailure: firstFailure ?? null,
    longest: longest ?? null,
    copiesLeft: left.copies, pendingLeft: left.pending, rowsLeft: left.rows, migratedEver: left.migrated,
    ...reclaim && (reclaim.ran
      ? { archiveMiBBefore: mib(reclaim.bytesBefore), archiveMiBAfter: mib(reclaim.bytesAfter), reclaimMs: Math.round(reclaim.ms) }
      : { archiveMiBFree: mib(reclaim.freeBytes), notReclaimed: reclaim.why ?? null }),
  } satisfies BackfillFields
}

/** The attachments' sweep as the progress keeps it and a log line names it: counts, bytes, ms. */
function assetFields(report: AttachmentSweepReport) {
  const all = totals(report)
  return {
    ran: report.ran, ...report.stopped && { stopped: report.stopped }, files: all.files, bytes: all.bytes, named: all.named.files, namedBytes: all.named.bytes,
    held: all.held.files, heldBytes: all.held.bytes, young: all.young.files, reclaimable: all.reclaimable.files, trashed: all.trashed.files, trashedBytes: all.trashed.bytes, restored: all.restored,
    deleted: all.deleted.files, deletedBytes: all.deleted.bytes, trash: all.trash.files, trashBytes: all.trash.bytes,
    sourcesRead: report.sources.read, sourcesCached: report.sources.cached, unreadable: report.sources.unreadable, ms: Math.round(report.ms),
    ...report.holds.length && { holds: report.holds.map((hold) => hold.why).join("; ") },
  } satisfies BackfillFields & NonNullable<BackfillProgress["assets"]>
}

/** A pass's progress as a log line's fields. */
function fields(progress: BackfillProgress) {
  const { prune, repack, archive, assets, children, endedAt, longest, firstRefusal, firstFailure, ...counts } = progress
  return {
    ...counts,
    endedAt: endedAt ?? null,
    longest: longest ?? null,
    firstRefusal: firstRefusal ?? null,
    firstFailure: firstFailure ?? null,
    newMiB: mib(progress.newBytes),
    storedMiB: mib(progress.storedBytes),
    ...prune && { streamFiles: prune.files, streamsPruned: prune.pruned, streamsPrunedEnded: prune.prunedEnded, streamsRestamped: prune.restamped, streamBytesPruned: prune.bytes, streamsLive: prune.live, streamsUnnamed: prune.unnamed, streamsNotHeld: prune.notHeld, streamsDiffer: prune.differs, pruneMs: prune.ms },
    ...archive && { archiveMigrated: archive.migrated, archiveCopies: archive.left.copies, archivePending: archive.left.pending },
    ...assets && { assetsTrashed: assets.trashed, assetsTrashedBytes: assets.trashedBytes, assetsDeleted: assets.deleted, assetsDeletedBytes: assets.deletedBytes, assetsRestored: assets.restored, assetsStopped: assets.stopped ?? null },
    ...children && { childrenLooked: children.looked, childrenParents: children.parents, childrenLinked: children.children, childrenKept: children.kept, childrenFailed: children.failed, childrenMs: children.ms },
    ...repack?.orphans?.scanned && { orphansForgotten: repack.orphans.forgotten, orphansAbandoned: repack.orphans.abandoned, orphansSwept: repack.orphans.swept, orphansRunning: repack.orphans.running, orphansWaiting: repack.orphans.waiting, orphansScanMs: repack.orphans.scanMs },
    ...repack?.trim && { tailTrimmedBytes: repack.trim.bytes, tailTrimSkipped: repack.trim.skipped },
    ...repack && { chunksDropped: repack.dropped, sessionsGrouped: repack.grouped, chunksCopied: repack.copied, packsRemoved: repack.packsRemoved, packBytesBefore: repack.packBytesBefore, packBytesAfter: repack.packBytesAfter, repackMs: repack.ms, repackLongestTurnMs: repack.longestTurnMs },
  } satisfies BackfillFields
}

const mib = (bytes: number) => Math.round((bytes / 1024 ** 2) * 10) / 10

const defaultLog: BackfillLog = (message, values) => console.log(message, JSON.stringify(values))
