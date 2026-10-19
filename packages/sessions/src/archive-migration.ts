import { threadIdentity, type ThreadRef } from "./format.js"
import type { ArchiveReclaim, SessionArchive } from "./archive.js"

/**
 * The archive's copies, moved onto the record store.
 *
 * Each row of the archive (`archive.ts`) is Mako's translation of a session
 * by some earlier build. The migration looks at every row, newest first,
 * one at a time, in the catalog worker's backfill pass right after the
 * pass has taken the rail into the record store:
 *
 * - **The harness still has the session** (the catalog lists it, by path or
 *   by the harness's own id, so a Codex rollout compressed or archived
 *   since is the same session): once a capture of it has finished in the
 *   record store and this build decodes it from the harness's records, the
 *   row goes.
 * - **The harness deleted it, and the record store holds it:** once this
 *   build decodes it from the store's records, the rail's row for it is
 *   kept with the records (`RecordStore.keepListing`) and the archive's goes.
 * - **Nothing else holds it:** the row stays, noted as all that's left
 *   (`ThreadRef.copyOnly`). It is read as before, can't be resumed natively,
 *   and no newer build can read it again.
 *
 * A row is dropped only after what replaces it was read back, in one
 * transaction with the ledger's note of why; anything that fails keeps the
 * row, and the next pass asks again. Rows of child agents stay: a child is
 * read through its parent, and the records of a parent its harness
 * deleted don't list their children yet.
 *
 * The pass ends by giving the dropped rows' space back (`SessionArchive.reclaim`).
 */

/** What the catalog answers the migration with. */
export interface ArchiveMigrationSource {
  /** Every session the harnesses list now. */
  live(): ThreadRef[]
  /**
   * Whether the last discovery of `harness` succeeded. One that failed (a
   * store a writer held, a folder gone for a moment) lists only part of what
   * the harness has, so its rows wait rather than be taken for deleted.
   */
  discovered(harness: string): boolean
  /** Whether a capture of the session ever finished in the record store. */
  captured(ref: Pick<ThreadRef, "harness" | "nativeId">): boolean
  /** How many entries this build decodes from the harness's own records at `path`, or null when it can't. */
  decodesNative(path: string): Promise<number | null>
  /** Where the record store reads the deleted session back, and how many entries this build decodes there; null when it can't. */
  decodesRecords(ref: ThreadRef): Promise<{ path: string; entries: number } | null>
  /** Keeps `ref` as the rail's row of a session its harness deleted, with its records. False when the store doesn't hold it. */
  keepListing(ref: ThreadRef): Promise<boolean>
}

export interface ArchiveMigrationReport {
  /** Rows looked at this pass. */
  rows: number
  /** Dropped this pass: the harness still has the session, or the record store holds it. */
  migrated: number
  viaHarness: number
  viaRecords: number
  /** Rows found to be all that's left; `newCopies` of them for the first time. */
  copies: number
  newCopies: number
  /** Rows the harness still has that the record store holds no finished capture of yet, or of a harness whose discovery just failed. */
  pending: number
  /** Child agents' rows, which stay. */
  children: number
  /** Rows kept because what would replace them didn't read back. */
  failed: number
  firstFailure?: string
  /** Copies the oldest builds kept as folders, moved into the database or removed as duplicates. */
  legacyFolded: number
  legacyRemoved: number
  ms: number
  yieldedMs: number
  /** The longest one row took, decode included, and whose it was. */
  longestMs: number
  longest?: string
  /** Decoding what replaces the rows: all of it, and the longest one. */
  decodeMs: number
  longestDecodeMs: number
  /** The longest drop, one SQLite transaction on this thread. */
  longestDropMs: number
  reclaim?: ArchiveReclaim
  /** Where the archive stands after the pass. */
  left: { rows: number; copies: number; pending: number; migrated: number }
}

export interface ArchiveMigrationPassOptions {
  /** Whether to end the pass at the row it's on; what it did is kept, and the next pass continues. */
  stopped: () => boolean
  /** Waits for work the person is waiting on before each row that reads a session. */
  yieldToPerson: () => Promise<void>
  /** After each row is dropped: tests stop the process here. */
  onDropped?: (path: string) => void
  reclaimMinBytes?: number
}

export class ArchiveMigration {
  constructor(
    private readonly archive: SessionArchive,
    private readonly source: ArchiveMigrationSource
  ) {}

  async pass(options: ArchiveMigrationPassOptions): Promise<ArchiveMigrationReport> {
    const started = Date.now()
    await this.archive.load()
    // A newer Mako's archive is its to migrate: this build reads it and drops nothing.
    if (!this.archive.writable) return { ...emptyReport(), left: this.archive.counts() }
    const legacy = await this.archive.foldLegacy()
    const report: ArchiveMigrationReport = {
      rows: 0, migrated: 0, viaHarness: 0, viaRecords: 0, copies: 0, newCopies: 0, pending: 0, children: 0, failed: 0,
      legacyFolded: legacy.folded, legacyRemoved: legacy.removed, ms: 0, yieldedMs: 0, longestMs: 0, decodeMs: 0, longestDecodeMs: 0, longestDropMs: 0,
      left: { rows: 0, copies: 0, pending: 0, migrated: 0 },
    }
    const live = this.source.live()
    const byPath = new Map(live.map((ref) => [ref.path, ref]))
    const byIdentity = new Map(live.map((ref) => [threadIdentity(ref), ref]))
    for (const ref of this.archive.copies()) {
      if (options.stopped()) break
      report.rows += 1
      if (ref.childOf) {
        report.children += 1
        continue
      }
      const listed = byPath.get(ref.path) ?? byIdentity.get(threadIdentity(ref))
      if (!listed && !this.source.discovered(ref.harness)) {
        report.pending += 1
        continue
      }
      const rowStarted = Date.now()
      if (listed) {
        if (!this.source.captured(listed)) {
          // Its harness has it again (a restore, an unarchive): it's no longer all that's left.
          this.archive.unmarkCopy(ref.path)
          report.pending += 1
          continue
        }
        report.yieldedMs += await yielded(options)
        if (options.stopped()) break
        const entries = await timed(report, () => this.source.decodesNative(listed.path).catch(() => null))
        if (!this.replaces(entries, ref)) {
          this.failed(report, ref, "this build doesn't read it from its harness's records")
          continue
        }
        await this.drop(report, ref, "harness")
        report.viaHarness += 1
      } else if (this.source.captured(ref)) {
        report.yieldedMs += await yielded(options)
        if (options.stopped()) break
        const found = await timed(report, () => this.source.decodesRecords(ref).catch(() => null))
        if (!found || !this.replaces(found.entries, ref)) {
          this.failed(report, ref, "this build doesn't read it back from the record store")
          continue
        }
        if (!(await this.source.keepListing({ ...ref, path: found.path }))) {
          this.failed(report, ref, "the record store no longer holds it")
          continue
        }
        await this.drop(report, ref, "records")
        report.viaRecords += 1
      } else {
        report.copies += 1
        if (this.archive.markCopy(ref.path)) report.newCopies += 1
        continue
      }
      report.migrated += 1
      options.onDropped?.(ref.path)
      const took = Date.now() - rowStarted
      if (took > report.longestMs) {
        report.longestMs = took
        report.longest = `${ref.harness} ${ref.nativeId}`
      }
    }
    if (report.migrated || report.legacyFolded || report.legacyRemoved) {
      report.reclaim = await this.archive.reclaim(options.reclaimMinBytes === undefined ? {} : { minBytes: options.reclaimMinBytes })
    }
    const counts = this.archive.counts()
    report.left = { rows: counts.rows, copies: counts.copies, pending: counts.pending, migrated: counts.migrated }
    report.ms = Date.now() - started - report.yieldedMs
    return report
  }

  private async drop(report: ArchiveMigrationReport, ref: ThreadRef, via: "harness" | "records"): Promise<void> {
    const started = performance.now()
    await this.archive.drop(ref.path, via)
    report.longestDropMs = Math.max(report.longestDropMs, performance.now() - started)
  }

  /** Whether a decode that found `entries` stands in for the copy: it read, and found something where the copy had something. */
  private replaces(entries: number | null, ref: ThreadRef): boolean {
    if (entries === null) return false
    return entries > 0 || this.archive.entryCount(ref.path) === 0
  }

  private failed(report: ArchiveMigrationReport, ref: ThreadRef, why: string): void {
    report.failed += 1
    report.firstFailure ??= `${ref.harness} ${ref.nativeId}: ${why}`
  }
}

async function timed<T>(report: ArchiveMigrationReport, decode: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await decode()
  } finally {
    const took = performance.now() - started
    report.decodeMs += took
    report.longestDecodeMs = Math.max(report.longestDecodeMs, took)
  }
}

async function yielded(options: ArchiveMigrationPassOptions): Promise<number> {
  const started = Date.now()
  await options.yieldToPerson()
  return Date.now() - started
}

function emptyReport(): ArchiveMigrationReport {
  return {
    rows: 0, migrated: 0, viaHarness: 0, viaRecords: 0, copies: 0, newCopies: 0, pending: 0, children: 0, failed: 0,
    legacyFolded: 0, legacyRemoved: 0, ms: 0, yieldedMs: 0, longestMs: 0, decodeMs: 0, longestDecodeMs: 0, longestDropMs: 0,
    left: { rows: 0, copies: 0, pending: 0, migrated: 0 },
  }
}
