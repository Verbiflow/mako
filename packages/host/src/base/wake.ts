import { performance } from "node:perf_hooks"
import type { HostJobs, JobDemand } from "./host-jobs.js"

/**
 * Why the host may have been away: the machine slept or its process was
 * paused (the wall clock jumped between two ticks), or the desktop app saw the
 * Mac resume or the screen unlock.
 */
export type WakeSource = "clock" | "resume" | "unlock-screen"

export interface WakeWatch {
  /** For the desktop app, which hears the Mac resume and the screen unlock before the clock shows a gap. */
  notify(source: Exclude<WakeSource, "clock">): void
  /**
   * Looks now whether the machine slept since the last look, and wakes if it did: before work that must not run on
   * what a sleep left stale (a harness's launch, before the sign-ins' wake refreshed them), whether or not it ticks.
   */
  check(): void
  stop(): void
}

export interface WakeOptions {
  tickMs?: number
  gapMs?: number
  quietMs?: number
  now?: () => number
  monotonic?: () => number
  /** What it ticks for: with none on it holds no timer. Absent, it always ticks. */
  needs?: readonly JobDemand[]
}

/**
 * Watches for the host coming back. The clock needs nothing from the platform,
 * so a host with no desktop app, on the Mac or a paused cloud machine, still
 * reconnects its terminals and refreshes its sign-in. Wakes within `quietMs`
 * of the last are one wake, as a resume is usually followed by an unlock and
 * by the clock's own notice.
 *
 * It ticks only while one of `needs` is on (a client watching, agents at work): what a wake does then has someone
 * to do it for. While none is, nothing ticks, and a sleep in that stretch is found when one turns on again: the wall
 * clock ran on while the machine slept and the monotonic clock didn't (`monotonic`, which stops in a sleep on macOS
 * and Linux alike), so the two have drifted apart by the time away.
 */
export function watchWake(
  jobs: HostJobs,
  onWake: (source: WakeSource) => void,
  // A tick a second: with no desktop app to hear the resume, a harness mid-turn at the sleep resumes with the host,
  // and the sign-ins' wake must hold its refresh lock before it reaches its provider.
  { tickMs = 1_000, gapMs = 30_000, quietMs = 10_000, now = Date.now, monotonic = () => performance.now(), needs = [] }: WakeOptions = {}
): WakeWatch {
  let last = now()
  let lastMonotonic = monotonic()
  let woke = -Infinity
  const wake = (source: WakeSource) => {
    const at = now()
    if (at - woke < quietMs) return
    woke = at
    onWake(source)
  }
  /** Time the wall clock ran that the monotonic one didn't: a sleep, since the last look. */
  const look = () => {
    const at = now()
    const atMonotonic = monotonic()
    const away = (at - last) - (atMonotonic - lastMonotonic)
    last = at
    lastMonotonic = atMonotonic
    return away
  }
  // Ticking through a start that holds the foreground: a tick held back by one reads its length as time away.
  const stop = jobs.every("watch for the machine waking", tickMs, () => {
    const at = now()
    const gap = at - last
    look()
    // A gap between ticks is a sleep or a paused process (whose monotonic clock ran on).
    if (gap > tickMs + gapMs) wake("clock")
  }, { runsWhileHeld: true, ...(needs.length > 0 && { needs }) })
  // A need turning on after a stretch with none: one look says whether the machine slept meanwhile.
  const stops = needs.map((demand) => demand.onChange((on) => {
    if (!on) return
    if (look() > gapMs) wake("clock")
  }))
  return { notify: wake, check: () => {
    if (look() > gapMs) wake("clock")
  }, stop: () => {
    stop()
    for (const each of stops) each()
  } }
}
