import { useEffect, useState } from "react"

/** A status shows once it has held this long: a reconnect that's over in a moment never paints its words. */
export const STATUS_SHOW_AFTER_MS = 400
/** Once shown, it stays at least this long: words that arrive never blink straight back out. */
export const STATUS_HOLD_MS = 400

/**
 * Where a status word stands on screen: `idle` (nothing to say), `pending` (something to say, not yet for long enough),
 * or `shown` (said, and held until `holdUntil`). `key` names what it's about, a conversation say: a new one starts over.
 */
export type DelayedStatus<Value> =
  | { phase: "idle"; key: string }
  | { phase: "pending"; key: string; showAt: number }
  | { phase: "shown"; key: string; value: Value; holdUntil: number }

/**
 * One step of a status word: what it wants to say now (`value`, null for nothing) against what's on screen. Returns
 * `state` itself when nothing changes, so it can run on every render. `now` reads the clock, only when a step needs it.
 */
export function stepDelayedStatus<Value>(state: DelayedStatus<Value> | null, key: string, value: Value | null, now: () => number): DelayedStatus<Value> {
  const idle = (): DelayedStatus<Value> => ({ phase: "idle", key })
  const pending = (): DelayedStatus<Value> => ({ phase: "pending", key, showAt: now() + STATUS_SHOW_AFTER_MS })
  const shown = (said: Value): DelayedStatus<Value> => ({ phase: "shown", key, value: said, holdUntil: now() + STATUS_HOLD_MS })
  if (state === null || state.key !== key) return value === null ? idle() : pending()
  switch (state.phase) {
    case "idle":
      return value === null ? state : pending()
    case "pending":
      if (value === null) return idle()
      return now() >= state.showAt ? shown(value) : state
    case "shown":
      if (value === null) return now() >= state.holdUntil ? idle() : state
      // Another word (Connecting… to Reconnecting…) replaces it in place, held afresh.
      return Object.is(value, state.value) ? state : shown(value)
  }
}

/** The wall clock, read by a status's steps as they need it: never during a render that has nothing to stamp. */
const clock = () => Date.now()

/** When a status next needs looking at again, if ever. */
export function delayedStatusDeadline(state: DelayedStatus<unknown>): number | undefined {
  return state.phase === "pending" ? state.showAt : state.phase === "shown" ? state.holdUntil : undefined
}

/**
 * A status word that shows only once it has lasted `STATUS_SHOW_AFTER_MS`, and then stays at least `STATUS_HOLD_MS`:
 * a connection that drops and comes straight back never flickers "Reconnecting…". Compare `value` by identity: strings.
 */
export function useDelayedStatus<Value>(value: Value | null, key = ""): Value | null {
  const [state, setState] = useState<DelayedStatus<Value>>(() => stepDelayedStatus<Value>(null, key, value, clock))
  const next = stepDelayedStatus(state, key, value, clock)
  if (next !== state) setState(next)
  const deadline = delayedStatusDeadline(next)
  useEffect(() => {
    if (deadline === undefined) return
    const timer = setTimeout(() => setState((current) => stepDelayedStatus(current, key, value, clock)), Math.max(0, deadline - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [deadline, key, value])
  return next.phase === "shown" && next.key === key ? next.value : null
}
