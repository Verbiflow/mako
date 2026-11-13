/**
 * How long a piece of the window's code may take to arrive before the piece says it's slow: a download still under
 * way then hasn't failed, so the piece keeps its loading look, says "Still loading…" and offers Reload, and draws when
 * the code lands. Only a read that fails, or one still pending with the browser offline, is a failure.
 */
export const CODE_PATIENCE_MS = 8_000

/**
 * Calls `late` if `reading` is still unsettled once `CODE_PATIENCE_MS` has passed, saying whether the browser is
 * offline, and again each time the browser goes offline or back online while it stays unsettled, so what the piece
 * says follows the network.
 */
export function whenSlow(reading: Promise<unknown>, late: (offline: boolean) => void): void {
  let settled = false
  const say = () => {
    if (!settled) late(!navigator.onLine)
  }
  const timer = setTimeout(() => {
    if (settled) return
    say()
    addEventListener("online", say)
    addEventListener("offline", say)
  }, CODE_PATIENCE_MS)
  const done = () => {
    settled = true
    clearTimeout(timer)
    removeEventListener("online", say)
    removeEventListener("offline", say)
  }
  reading.then(done, done)
}

/**
 * In development, counts the reads of the window's code that started a new load (`window.__makoCodeReads`), so a check
 * can tell a new read from one handed back: the browser shares one in-flight fetch per module, so the network can't.
 */
export function noteReadStarted(): void {
  if (!import.meta.env.DEV) return
  Reflect.set(globalThis, "__makoCodeReads", Number(Reflect.get(globalThis, "__makoCodeReads") ?? 0) + 1)
}
