import { createHash } from "node:crypto"
import { rm, stat, statfs } from "node:fs/promises"
import { homedir } from "node:os"
import { basename } from "node:path"
import type { ThreadRef } from "./format.js"
import type { SessionRecords } from "./harness-records.js"
import type { CaptureReport, RecordStore } from "./record-store.js"
import { StreamListings, withStreams } from "./record-streams.js"
import { carriedFiles, carriedStamp, withCarried } from "./record-carried.js"

/** The shortest gap between two captures of one session while it streams. */
const CAPTURE_GAP_MS = 250
/** A slow session waits this many times its last capture before the next, so capture never takes more than a fifth of a store's time. */
const GAP_PER_CAPTURE_MS = 4
const MAX_GAP_MS = 30_000
/** A capture the store refused (a writer's lock, a file mid-rename) is tried again this often, this many times, before waiting for the next write. */
const RETRY_MS = 2_000
const RETRIES = 3
/**
 * What a hold of a session the store has none of yet leaves free on the
 * store's disk, counting the session's files at their full size. The store
 * keeps them compressed, at about a fifth, so this is the most it can take.
 */
const HOLD_KEEPS_FREE = 2 * 1024 ** 3
const GIB = 1024 ** 3

interface Pending {
  ref: ThreadRef
  /** Made for one backfill capture, and dropped after it unless the harness wrote meanwhile. */
  passing: boolean
  timer: NodeJS.Timeout | null
  running: Promise<void> | null
  /** A write arrived while a capture ran: take one more when it ends. */
  again: boolean
  failures: number
  /** When the last capture ended, and how long it took. */
  endedAt: number
  tookMs: number
}

export interface RecordCaptureOptions {
  home?: string
  gapMs?: number
  /** The streams folder (`record-streams.ts`) whose files of each session are taken with its records. */
  streams?: string
  /** The record store's folder, where it notes the transcripts each session was given (`record-carried.ts`), taken with its records too. */
  carried?: string
  onCaptured?: (ref: ThreadRef, report: CaptureReport) => void
  /** A capture failed every retry; the next write tries again. */
  onError?: (ref: ThreadRef, message: string) => void
  /** See `HOLD_KEEPS_FREE`. */
  holdKeepsFree?: number
  /**
   * The catalog's stamp of the native records it lists for `ref` (`SessionCatalog`
   * keeps it per path: bytes, mtime, revision), or null when it lists none.
   * With it, each finished capture keeps the session's stamp, and the
   * backfill passes a session whose stamp hasn't moved without reading it.
   */
  stampOf?: (ref: ThreadRef) => string | null
  /**
   * The rail's row for `ref` as the catalog lists it now, as JSON, or null
   * when it lists none: kept with each capture (`CaptureInput.listing`), so
   * a session its harness deletes stays in the rail, read back from the store.
   */
  listingOf?: (ref: ThreadRef) => string | null
  /**
   * The bytes of the session's own rows in a database it shares with other
   * sessions (`SessionProvider.recordBytes`), or null where the reader can't
   * say. The disk check counts these, not the whole database: a Devin CLI
   * session is a few rows of a 5 GB database with a 15 GB write-ahead log.
   */
  rowBytesOf?: (ref: ThreadRef) => Promise<number | null>
  /**
   * The version of `harness` installed as a write lands, where every
   * installation the host read agrees (`observedInstall`), or null. Asked
   * only for a write heard as it landed, of records whose harness declares
   * that its installed CLI is what writes them (`RecordWriterRule.installed`),
   * and stamped on what states no version of its own.
   */
  observedInstall?: (harness: string) => string | null
}

/** What a backfill asked of one session came to (`RecordCapture.backfill`). */
export type BackfillOutcome =
  /** The store holds it at its current stamp: a stat of its streams, no read. */
  | { kind: "held" }
  /** The harness is writing it: live capture has it. */
  | { kind: "live" }
  /** The catalog no longer lists it, or the person deleted it. */
  | { kind: "gone" }
  /** The disk can't take it whole (`HOLD_KEEPS_FREE`). */
  | { kind: "refused"; reason: string; bytes: number }
  | { kind: "captured"; report: CaptureReport }
  | { kind: "failed"; message: string }

/**
 * Takes each session into the record store as the harness writes it. A write
 * schedules a capture; writes that land while one is scheduled or running
 * fold into a single capture after it, so a reply that streams for a minute
 * costs a capture every quarter second or so, each reading only the appended
 * bytes, and the turn's last write is always followed by one.
 */
export class RecordCapture {
  /** Every session written since start, kept so a slow store's pace survives between writes. */
  private readonly sessions = new Map<string, Pending>()
  private readonly home: string
  private readonly gapMs: number
  private readonly streams: StreamListings | null
  private stopped = false
  /** Live captures running: the backfill waits for none before it takes a session. */
  private live = 0
  private idleWaiters: (() => void)[] = []
  /** Sessions the person deleted in Mako, by `<harness>\n<native id>`: never captured again in this process. */
  private readonly forgotten = new Set<string>()

  constructor(
    private readonly store: RecordStore,
    private readonly recordsOf: (ref: ThreadRef) => Promise<SessionRecords | null>,
    private readonly options: RecordCaptureOptions = {}
  ) {
    this.home = options.home ?? homedir()
    this.gapMs = options.gapMs ?? CAPTURE_GAP_MS
    this.streams = options.streams ? new StreamListings(options.streams) : null
  }

  /**
   * Whether the store turned read-only under this capture: another build
   * raised its format while this one runs. Nothing is captured from then
   * on, said once; an updated build picks the sessions up again.
   */
  declined(): boolean {
    if (this.store.access !== "read") return false
    if (!this.declinedSaid) console.warn("Session records read only: a newer Mako changed the store's format, so nothing is captured until this build is updated")
    this.declinedSaid = true
    return true
  }
  private declinedSaid = false

  /** The harness wrote `ref`'s session. */
  wrote(ref: ThreadRef): void {
    if (this.stopped || ref.archived || this.forgotten.has(sessionKey(ref)) || this.declined()) return
    const state = this.state(ref)
    state.passing = false
    state.failures = 0
    if (state.running) state.again = true
    else this.schedule(state)
  }

  /**
   * Takes `ref`'s session now, after any capture of it already running, for
   * a caller about to rely on the store having it. Whether the store then
   * holds its records.
   */
  async hold(ref: ThreadRef): Promise<boolean> {
    if (this.stopped || ref.archived || this.forgotten.has(sessionKey(ref))) return false
    const state = this.state(ref)
    state.passing = false
    await state.running
    const tooFull = await this.tooFullFor(ref)
    if (tooFull) {
      this.options.onError?.(ref, tooFull.reason)
      return false
    }
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    state.again = false
    state.failures = 0
    await this.run(state)
    return state.failures === 0 && this.store.units(ref.harness, ref.nativeId).length > 0
  }

  /**
   * Why the store's disk can't take `ref`'s session whole, or null when it
   * can. Asked only of a session the store has none of yet: one it holds
   * grows by what's new.
   */
  private async tooFullFor(ref: ThreadRef): Promise<{ reason: string; bytes: number } | null> {
    if (this.store.units(ref.harness, ref.nativeId).length) return null
    const records = await this.recordsOf(ref)
    if (!records) return null
    const size = (path: string) => stat(path).then((info) => info.size, () => 0)
    const sum = (sizes: number[]) => sizes.reduce((total, bytes) => total + bytes, 0)
    const rows = records.databases.length ? await this.options.rowBytesOf?.(ref).catch(() => null) ?? null : 0
    const databases = rows ?? sum(await Promise.all(records.databases.flatMap((database) => [size(database.path), size(`${database.path}-wal`)])))
    const session = sum(await Promise.all(records.files.map(size))) + databases
    const disk = await statfs(this.store.folder)
    const free = disk.bavail * disk.bsize
    const keep = this.options.holdKeepsFree ?? HOLD_KEEPS_FREE
    if (free - session >= keep) return null
    return {
      reason: `Not held: the disk has ${(free / GIB).toFixed(1)} GiB free, and the session's ${(session / GIB).toFixed(2)} GiB would leave less than ${(keep / GIB).toFixed(1)} GiB`,
      bytes: session,
    }
  }

  /**
   * The session's stamp as the store keeps it with a capture: the catalog's
   * stamp of its native records, and each of its streams' name, size and
   * mtime, so a stream that grew while no capture ran moves it too. Null
   * without a catalog stamp.
   */
  async stamp(ref: ThreadRef): Promise<string | null> {
    const native = this.options.stampOf?.(ref) ?? null
    if (native === null) return null
    const files = this.streams ? await this.streams.of(ref.harness, ref.nativeId) : []
    const carried = this.options.carried ? carriedStamp(await carriedFiles(this.options.carried, ref.harness, ref.nativeId)) : ""
    return `${native}${await streamsStamp(files)}${carried && `\n${carried}`}`
  }

  /**
   * Takes `ref`'s session for the backfill, unless the store holds it at
   * its current stamp, the harness is writing it (live capture has it), or
   * the disk can't take it. One session at a time is the caller's to keep;
   * the capture takes turns with live ones in the store, and doesn't set the
   * session's pace: a first capture is long, the next live one is short.
   */
  async backfill(ref: ThreadRef): Promise<BackfillOutcome> {
    const key = sessionKey(ref)
    if (this.stopped || ref.archived || this.forgotten.has(key) || this.declined()) return { kind: "gone" }
    const existing = this.sessions.get(ref.path)
    if (existing && (existing.running || existing.timer)) return { kind: "live" }
    const stamp = await this.stamp(ref)
    if (stamp === null) return { kind: "gone" }
    if (stamp === this.store.heldStamp(ref.harness, ref.nativeId)) {
      // Held before captures kept the rail's row: the row is kept now, without a capture.
      const listing = this.options.listingOf?.(ref) ?? null
      if (listing !== null && this.store.listing(ref.harness, ref.nativeId) === null) await this.store.keepListing(ref.harness, ref.nativeId, ref.path, listing)
      return { kind: "held" }
    }
    const tooFull = await this.tooFullFor(ref)
    if (tooFull) return { kind: "refused", ...tooFull }
    // The checks above awaited: the harness may have written, or the person deleted it, since.
    if (this.stopped || this.forgotten.has(key)) return { kind: "gone" }
    const state = this.sessions.get(ref.path) ?? this.state(ref, true)
    if (state.running || state.timer) return { kind: "live" }
    const outcome = await this.run(state, { stamp, paced: false })
    if (state.passing && !state.again && !state.timer && !state.running) this.sessions.delete(ref.path)
    return outcome
  }

  /** Resolves once no live capture is running: the backfill's turn to take a session. */
  async idle(): Promise<void> {
    while (this.live > 0 && !this.stopped) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * The person deleted `ref`'s session in Mako: the store forgets it, its
   * streams' files go, and nothing captures it again in this process. Waits
   * for a capture of it in progress, so none brings it back.
   */
  async forget(ref: ThreadRef): Promise<{ units: number; versions: number; streams: number }> {
    this.forgotten.add(sessionKey(ref))
    const state = this.sessions.get(ref.path)
    if (state?.timer) clearTimeout(state.timer)
    if (state) {
      state.timer = null
      state.again = false
      await state.running
      this.sessions.delete(ref.path)
    }
    const files = this.streams ? await this.streams.of(ref.harness, ref.nativeId) : []
    await Promise.all(files.map((file) => rm(file, { force: true })))
    const dropped = await this.store.forget(ref.harness, ref.nativeId)
    return { ...dropped, streams: files.length }
  }

  private state(ref: ThreadRef, passing = false): Pending {
    let state = this.sessions.get(ref.path)
    if (!state) {
      state = { ref, passing, timer: null, running: null, again: false, failures: 0, endedAt: 0, tookMs: 0 }
      this.sessions.set(ref.path, state)
    }
    state.ref = ref
    return state
  }

  /** Captures every session written but not yet taken, then closes the store. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const resolve of this.idleWaiters.splice(0)) resolve()
    const flushes = [...this.sessions.values()].map(async (state) => {
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = null
        state.again = true
      }
      await state.running
      if (!state.again) return
      state.again = false
      await this.run(state)
    })
    await Promise.allSettled(flushes)
    this.sessions.clear()
    await this.store.close()
  }

  private schedule(state: Pending, delay?: number): void {
    if (state.timer || this.stopped) return
    const gap = Math.min(MAX_GAP_MS, Math.max(this.gapMs, state.tookMs * GAP_PER_CAPTURE_MS))
    const wait = delay ?? Math.max(0, state.endedAt + gap - Date.now())
    state.timer = setTimeout(() => {
      state.timer = null
      void this.run(state)
    }, wait)
    state.timer.unref?.()
  }

  /**
   * One capture of the session. A live one (`paced`) sets the session's pace
   * and retries a refusal; a backfill's reports its outcome, and the next
   * pass asks again.
   */
  private run(state: Pending, { stamp, paced }: { stamp?: string | null; paced: boolean } = { paced: true }): Promise<BackfillOutcome> {
    const ref = state.ref
    if (paced) this.live += 1
    const running = (async (): Promise<BackfillOutcome> => {
      const started = Date.now()
      // The session's own time: listing its records, then the store's work on them. Waiting behind other sessions' captures doesn't slow its pace.
      let took: number | null = null
      // A capture scheduled before another build raised the store's format stands down, as a new one does.
      if (this.declined()) return { kind: "gone" }
      try {
        // Taken before the records are read, so a write landing during the capture leaves the stamp behind, and the next pass looks again.
        const held = stamp === undefined ? await this.stamp(ref) : stamp
        const own = await this.recordsOf(ref)
        if (!own) return { kind: "gone" }
        const streamed = this.streams ? withStreams(own, this.streams.root, await this.streams.of(ref.harness, ref.nativeId)) : own
        const records = this.options.carried ? withCarried(streamed, await carriedFiles(this.options.carried, ref.harness, ref.nativeId)) : streamed
        const listed = Date.now() - started
        const listingOf = this.options.listingOf
        // Only a write heard as it landed was made by what's installed now; a backfill reads what older builds wrote.
        const observed = paced && own.writer?.installed ? this.options.observedInstall?.(ref.harness) ?? null : null
        const report = await this.store.capture({ harness: ref.harness, nativeId: ref.nativeId, home: this.home, records, path: ref.path, ...held !== null && { stamp: held }, ...listingOf && { listing: () => listingOf(ref) }, ...observed !== null && { observed } })
        took = listed + report.ms
        state.failures = 0
        this.options.onCaptured?.(ref, report)
        return { kind: "captured", report }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!paced) return { kind: "failed", message }
        state.failures += 1
        if (state.failures <= RETRIES) state.again = true
        else this.options.onError?.(ref, message)
        return { kind: "failed", message }
      } finally {
        if (paced) {
          state.tookMs = took ?? Date.now() - started
          state.endedAt = Date.now()
        }
      }
    })()
    state.running = running.then(() => undefined)
    void running.then(() => {
      state.running = null
      if (paced) {
        this.live -= 1
        if (this.live === 0) for (const resolve of this.idleWaiters.splice(0)) resolve()
      }
      if (!state.again || this.stopped) return
      state.again = false
      this.schedule(state, state.failures ? RETRY_MS : undefined)
    })
    return running
  }
}

/**
 * What a session's stamp says of its stream files, in the order the folder
 * lists them: each one's name, size and mtime, digested; nothing for none.
 * The suffix of the held stamp, which pruning a file replaces
 * (`RecordStore.restamp`).
 */
export async function streamsStamp(files: readonly string[]): Promise<string> {
  if (!files.length) return ""
  const digest = createHash("sha256")
  for (const file of files) {
    const info = await stat(file).catch(() => null)
    digest.update(`${basename(file)}\t${info?.size ?? -1}\t${info?.mtimeMs ?? -1}\n`)
  }
  return `|${files.length}:${digest.digest("hex").slice(0, 16)}`
}

function sessionKey(ref: Pick<ThreadRef, "harness" | "nativeId">): string {
  return `${ref.harness}\n${ref.nativeId}`
}
