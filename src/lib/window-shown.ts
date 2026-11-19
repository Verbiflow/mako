/**
 * Whether anyone can see this window: `document.visibilityState`, which Chromium turns to hidden for a window that's
 * minimized, on another Space, in a hidden app or wholly covered. One reader of it, so everything that exists only to
 * be looked at stops and catches up together: a hidden window draws nothing, so it ticks no clock, projects no
 * transcript and asks its host for nothing it would only paint.
 */

type Listener = (shown: boolean) => void

const listeners = new Set<Listener>()
let shown = true
let watching = false

/** The page, where there is one: a test or a worker has none, and is never hidden. */
function page(): Document | undefined {
  return globalThis.document
}

function read(): boolean {
  return page()?.visibilityState !== "hidden"
}

function watch(): void {
  const document = page()
  if (watching || !document) return
  watching = true
  shown = read()
  const heard = () => setWindowShown(read())
  document.addEventListener("visibilitychange", heard)
  // A page put away whole (the back-forward cache) says nothing of its visibility.
  window.addEventListener("pagehide", () => setWindowShown(false))
  window.addEventListener("pageshow", heard)
}

/** As it stands now. True wherever there is no document to hide (a test, a worker). */
export function windowShown(): boolean {
  watch()
  return shown
}

/** Said to every listener once per change; the page's own events call it, and a test stands in for them. */
export function setWindowShown(next: boolean): void {
  if (shown === next) return
  shown = next
  for (const listener of listeners) listener(next)
}

/** Hears each change, hidden and shown; returns the stop. */
export function onWindowShown(listener: Listener): () => void {
  watch()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * `run` every `ms` while the window shows, and never while it's hidden: the timer itself is gone then, so a hidden
 * window wakes for nothing. Coming back runs it once at once, so what it keeps (an elapsed time, an age) is current in
 * the frame the person sees, and the timer starts again from there. Returns the stop.
 */
export function everyWhileShown(ms: number, run: () => void): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const start = () => {
    timer ??= setInterval(run, ms)
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  if (windowShown()) start()
  const unheard = onWindowShown((visible) => {
    if (!visible) return stop()
    run()
    start()
  })
  return () => {
    unheard()
    stop()
  }
}
