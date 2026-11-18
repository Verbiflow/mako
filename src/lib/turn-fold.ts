import type { ChatMessage } from "@/lib/types"
import type { PlacedSection } from "@/lib/exchanges"
import { stillDrawn, turnRows } from "@/lib/turn-rows"

export { stillDrawn }

/**
 * What a settled turn folds away: everything it did on the way to its
 * answer, behind one row ("Worked for 3m 12s"), with the answer itself left
 * in view. A steer starts a new stretch, folded on its own ("Continued for
 * 40s"), so the person's words mid-turn stay where they were said. A
 * continuation of a turn cut short doesn't: the turn went on, so its work
 * is one stretch, timed without the wait before it went on.
 */
export interface TurnFold {
  /** Which stretch of the turn it folds: 0 before any steer, then one more after each. */
  part: number
  /** The first section it hides; its row stands here. */
  start: number
  /** One past the last section it hides: the stretch's answer, when it has one. */
  end: number
  /** Sections inside it that stay drawn while it is closed (`stillDrawn`). */
  kept: number[]
  /** It follows a steer, so its row says the turn continued. */
  continued: boolean
  /** When the stretch began: the prompt, or the steer that continued it. */
  from?: number
  /**
   * How long it worked: from `from` to its last message, less the time a cut-short turn
   * waited before it went on (a continuation inside the stretch).
   */
  worked?: number
  /** The messages it hides: what its row counts. */
  messages: ChatMessage[]
}

/**
 * The folds of a settled turn's sections, in order, by where each stands among them: `turnRows`' folds for a turn
 * nothing but a prompt opened. `began` is when the turn began.
 */
export function turnFolds(sections: readonly PlacedSection[], began?: number): TurnFold[] {
  return turnRows({ sections, began }).flatMap((row) => {
    if (row.kind !== "fold") return []
    const at = row.members.flatMap((entry) => (entry.kind === "section" ? [entry.index] : []))
    const kept = row.kept.flatMap((entry) => (entry.kind === "section" ? [entry.index] : []))
    return [{ part: row.part, start: at[0]!, end: at.at(-1)! + 1, kept, continued: row.continued, from: row.from, ...(row.worked !== undefined && { worked: row.worked }), messages: row.messages }]
  })
}
