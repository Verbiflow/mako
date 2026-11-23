import { useState } from "react"
import type { Exchange } from "@/lib/exchanges"

/**
 * `exchanges`, the same array while every turn's prompt stays as it was. An answer streaming rebuilds the exchanges a
 * batch at a time, but no prompt moves, so the navigator (and its virtualizer over every prompt of a long session) has
 * nothing to redo: on a 2,000-turn conversation it took a sixth of the main thread a streamed answer cost. Labels are
 * still read only for the ticks drawn (`promptLabel`), from what this compares.
 */
export function useNavigatorPrompts(exchanges: readonly Exchange[]): readonly Exchange[] {
  const [held, setHeld] = useState(exchanges)
  if (held === exchanges || samePrompts(held, exchanges)) return held
  setHeld(exchanges)
  return exchanges
}

/** Whether two lists of turns draw the same navigator: the same turns, each with what its label reads (`promptLabel`). */
function samePrompts(before: readonly Exchange[], after: readonly Exchange[]): boolean {
  if (before.length !== after.length) return false
  return after.every((exchange, index) => {
    const held = before[index]!
    return held.id === exchange.id && held.prompt === exchange.prompt && held.opener === exchange.opener &&
      held.unloaded === exchange.unloaded && held.direct === exchange.direct && held.run?.label === exchange.run?.label && (held.response.length > 0) === (exchange.response.length > 0)
  })
}
