import { homedir } from "node:os"
import type { ThreadRef } from "./format.js"
import type { SessionRecords } from "./harness-records.js"
import type { CaptureReport, RecordStore } from "./record-store.js"

/** The shortest gap between two captures of one session while it streams. */
const CAPTURE_GAP_MS = 250
/** A slow session waits this many times its last capture before the next, so capture never takes more than a fifth of a store's time. */
const GAP_PER_CAPTURE_MS = 4
const MAX_GAP_MS = 30_000
/** A capture the store refused (a writer's lock, a file mid-rename) is tried again this often, this many times, before waiting for the next write. */
const RETRY_MS = 2_000
const RETRIES = 3

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
  onCaptured?: (ref: ThreadRef, report: CaptureReport) => void
  /** A capture failed every retry; the next write tries again. */
  onError?: (ref: ThreadRef, message: string) => void
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
  private stopped = false

  constructor(
    private readonly store: RecordStore,
    private readonly recordsOf: (path: string) => Promise<SessionRecords | null>,
    private readonly options: RecordCaptureOptions = {}
  ) {
    this.home = options.home ?? homedir()
    this.gapMs = options.gapMs ?? CAPTURE_GAP_MS
  }

  /** The harness wrote `ref`'s session. */
  wrote(ref: ThreadRef): void {
    if (this.stopped || ref.archived) return
    let state = this.sessions.get(ref.path)
    if (!state) {
      state = { ref, timer: null, running: null, again: false, failures: 0, endedAt: 0, tookMs: 0 }
      this.sessions.set(ref.path, state)
    }
    state.ref = ref
    state.failures = 0
    if (state.running) state.again = true
    else this.schedule(state)
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
      try {
        const records = await this.recordsOf(ref.path)
        if (!records) return
        const report = await this.store.capture({ harness: ref.harness, nativeId: ref.nativeId, home: this.home, records })
        state.failures = 0
        this.options.onCaptured?.(ref, report)
      } catch (error) {
        state.failures += 1
        if (state.failures <= RETRIES) state.again = true
        else this.options.onError?.(ref, error instanceof Error ? error.message : String(error))
      } finally {
        state.tookMs = Date.now() - started
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
