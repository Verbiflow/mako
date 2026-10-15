import { stat, statfs } from "node:fs/promises"
import { homedir } from "node:os"
import type { ThreadRef } from "./format.js"
import type { SessionRecords } from "./harness-records.js"
import type { CaptureReport, RecordStore } from "./record-store.js"
import { StreamListings, withStreams } from "./record-streams.js"

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
  onCaptured?: (ref: ThreadRef, report: CaptureReport) => void
  /** A capture failed every retry; the next write tries again. */
  onError?: (ref: ThreadRef, message: string) => void
  /** See `HOLD_KEEPS_FREE`. */
  holdKeepsFree?: number
}

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

  constructor(
    private readonly store: RecordStore,
    private readonly recordsOf: (ref: ThreadRef) => Promise<SessionRecords | null>,
    private readonly options: RecordCaptureOptions = {}
  ) {
    this.home = options.home ?? homedir()
    this.gapMs = options.gapMs ?? CAPTURE_GAP_MS
    this.streams = options.streams ? new StreamListings(options.streams) : null
  }

  /** The harness wrote `ref`'s session. */
  wrote(ref: ThreadRef): void {
    if (this.stopped || ref.archived) return
    const state = this.state(ref)
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
    if (this.stopped || ref.archived) return false
    const state = this.state(ref)
    await state.running
    const tooFull = this.store.units(ref.harness, ref.nativeId).length ? null : await this.tooFullFor(ref)
    if (tooFull) {
      this.options.onError?.(ref, tooFull)
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

  /** Why the store's disk can't take `ref`'s session whole, or null when it can. */
  private async tooFullFor(ref: ThreadRef): Promise<string | null> {
    const records = await this.recordsOf(ref)
    if (!records) return null
    const paths = [...records.files, ...records.databases.flatMap((database) => [database.path, `${database.path}-wal`])]
    const sizes = await Promise.all(paths.map((path) => stat(path).then((info) => info.size, () => 0)))
    const session = sizes.reduce((total, size) => total + size, 0)
    const disk = await statfs(this.store.folder)
    const free = disk.bavail * disk.bsize
    const keep = this.options.holdKeepsFree ?? HOLD_KEEPS_FREE
    if (free - session >= keep) return null
    return `Not held: the disk has ${(free / GIB).toFixed(1)} GiB free, and the session's ${(session / GIB).toFixed(2)} GiB would leave less than ${(keep / GIB).toFixed(1)} GiB`
  }

  private state(ref: ThreadRef): Pending {
    let state = this.sessions.get(ref.path)
    if (!state) {
      state = { ref, timer: null, running: null, again: false, failures: 0, endedAt: 0, tookMs: 0 }
      this.sessions.set(ref.path, state)
    }
    state.ref = ref
    return state
  }

  /** Captures every session written but not yet taken, then closes the store. */
  async stop(): Promise<void> {
    this.stopped = true
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

  private run(state: Pending): Promise<void> {
    const ref = state.ref
    const running = (async () => {
      const started = Date.now()
      // The session's own time: listing its records, then the store's work on them. Waiting behind other sessions' captures doesn't slow its pace.
      let took: number | null = null
      try {
        const own = await this.recordsOf(ref)
        if (!own) return
        const records = this.streams ? withStreams(own, this.streams.root, await this.streams.of(ref.harness, ref.nativeId)) : own
        const listed = Date.now() - started
        const report = await this.store.capture({ harness: ref.harness, nativeId: ref.nativeId, home: this.home, records, path: ref.path })
        took = listed + report.ms
        state.failures = 0
        this.options.onCaptured?.(ref, report)
      } catch (error) {
        state.failures += 1
        if (state.failures <= RETRIES) state.again = true
        else this.options.onError?.(ref, error instanceof Error ? error.message : String(error))
      } finally {
        state.tookMs = took ?? Date.now() - started
        state.endedAt = Date.now()
      }
    })()
    state.running = running
    void running.then(() => {
      state.running = null
      if (!state.again || this.stopped) return
      state.again = false
      this.schedule(state, state.failures ? RETRY_MS : undefined)
    })
    return running
  }
}
