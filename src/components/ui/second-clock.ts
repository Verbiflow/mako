import { useCallback, useSyncExternalStore } from "react"
import { everyWhileShown } from "@/lib/window-shown"

/**
 * One clock for every elapsed time on screen. A row counting up subscribes
 * while it is mounted and active; the interval runs only while someone
 * listens and the window shows (`everyWhileShown`), so a hundred background
 * tasks tick on one timer, not a hundred, nothing ticks when none is shown,
 * and a hidden window's rows read the time again the moment it's back.
 */
const listeners = new Set<() => void>()
let timer: (() => void) | undefined
let now = Date.now()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = everyWhileShown(1_000, () => {
      now = Date.now()
      for (const notify of listeners) notify()
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      timer()
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

/**
 * A label drawn from the shared clock. Subscribes only while `live`, and
 * re-renders only when `label` returns a different string, so a minute
 * ("18m") doesn't repaint every second the clock ticks.
 */
export function useTickingText(
  live: boolean,
  label: (now: number) => string
): string {
  const get = useCallback(
    () => (live ? label(read()) : label(0)),
    [live, label]
  )
  return useSyncExternalStore(live ? subscribe : still, get, get)
}
