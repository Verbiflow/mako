/**
 * Why the host may have been away: the machine slept or its process was
 * paused (the wall clock jumped between two ticks), or the desktop app saw the
 * Mac resume or the screen unlock.
 */
export type WakeSource = "clock" | "resume" | "unlock-screen"

export interface WakeWatch {
  /** For the desktop app, which hears the Mac resume and the screen unlock before the clock shows a gap. */
  notify(source: Exclude<WakeSource, "clock">): void
  stop(): void
}

/**
 * Watches for the host coming back. The clock needs nothing from the platform,
 * so a host with no desktop app, on the Mac or a paused cloud machine, still
 * reconnects its terminals and refreshes its sign-in. Wakes within `quietMs`
 * of the last are one wake, as a resume is usually followed by an unlock and
 * by the clock's own notice.
 */
export function watchWake(
  onWake: (source: WakeSource) => void,
  { tickMs = 5_000, gapMs = 30_000, quietMs = 10_000, now = Date.now } = {}
): WakeWatch {
  let last = now()
  let woke = -Infinity
  const wake = (source: WakeSource) => {
    const at = now()
    if (at - woke < quietMs) return
    woke = at
    onWake(source)
  }
  const timer = setInterval(() => {
    const at = now()
    const gap = at - last
    last = at
    if (gap > tickMs + gapMs) wake("clock")
  }, tickMs)
  timer.unref()
  return {
    notify: wake,
    stop: () => clearInterval(timer),
  }
}
