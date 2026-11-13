/**
 * How long a piece of the window's code may take to arrive before the piece says it's slow: a download still under
 * way then hasn't failed, so the piece keeps its loading look, says "Still loading…" and offers Reload, and draws when
 * the code lands. Only a read that fails, or one still pending with the browser offline, is a failure.
 */
export const CODE_PATIENCE_MS = 8_000

/** Calls `late` if `reading` is still unsettled once `CODE_PATIENCE_MS` has passed, saying whether the browser is offline. */
export function whenSlow(reading: Promise<unknown>, late: (offline: boolean) => void): void {
  let settled = false
  const timer = setTimeout(() => {
    if (!settled) late(!navigator.onLine)
  }, CODE_PATIENCE_MS)
  const done = () => {
    settled = true
    clearTimeout(timer)
  }
  reading.then(done, done)
}
