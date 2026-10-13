import { useSyncExternalStore } from "react"

/**
 * One clock for every elapsed time on screen. A row counting up subscribes
 * while it is mounted and active; the interval runs only while someone
 * listens, so a hundred background tasks tick on one timer, not a hundred,
 * and nothing ticks when none is shown.
 */
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let now = Date.now()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, 1_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** Stable between reads, as React requires; refreshed when no timer has moved it for a second. */
function read(): number {
  if (!timer && Date.now() - now >= 1_000) now = Date.now()
  return now
}
const still = () => () => {}

/**
 * The current time, moving once a second while `live`. A settled row does
 * not subscribe and must not read the value: it is the last tick.
 */
export function useSecondClock(live: boolean): number {
  return useSyncExternalStore(live ? subscribe : still, read, read)
}
