import type { ChatMessage } from "@/lib/types"
import type { ResponseSection } from "@/lib/exchanges"
import { eventWords, isBoundary } from "@/lib/transcript-events"

/**
 * What a settled turn folds away: everything it did on the way to its
 * answer, behind one row ("Worked for 3m 12s"), with the answer itself left
 * in view. A steer starts a new stretch, folded on its own ("Continued for
 * 40s"), so the person's words mid-turn stay where they were said.
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
  /** When its last message landed, the answer's included. */
  to?: number
  /** The messages it hides: what its row counts. */
  messages: ChatMessage[]
}

/**
 * A note a fold never hides: one that wants attention (a failure, a
 * warning), marks a boundary in the conversation (a compaction, a model
 * change, a stop), or says what the turn was answering (background work
 * that settled). Folding those would hide why the answer reads as it does.
 */
export function stillDrawn(section: ResponseSection): boolean {
  // What the agent showed the person is part of the answer wherever it stands.
  if (section.kind === "shown") return true
  if (section.kind !== "note") return false
  const note = section.message.note
  if (!note) return false
  if (note.cause) return true
  const words = eventWords(note)
  return Boolean(words.tone) || isBoundary(words)
}

function messagesOf(section: ResponseSection): ChatMessage[] {
  return section.kind === "work" ? section.messages : section.kind === "shown" ? [] : [section.message]
}

/** A section that answers: the agent's words, or what it showed the person. */
const answers = (section: ResponseSection) => section.kind === "prose" || section.kind === "shown"

/**
 * The folds of a settled turn's sections, in order. `began` is when the
 * turn began (its prompt). A stretch folds when it worked on the way to its
 * answer: a stretch of words alone has nothing to fold. Its answer is the
 * prose it ends on; a stretch that ends on work has no answer and folds
 * whole.
 */
export function turnFolds(sections: readonly ResponseSection[], began?: number): TurnFold[] {
  const folds: TurnFold[] = []
  let start = 0
  let from = began
  let continued = false
  let part = 0
  const close = (end: number) => {
    let answer = end
    while (answer > start && sections[answer - 1]!.kind === "note") answer--
    if (answer > start && answers(sections[answer - 1]!)) {
      while (answer > start && answers(sections[answer - 1]!)) answer--
    } else {
      answer = end
    }
    const hidden = sections.slice(start, answer)
    if (hidden.some((section) => section.kind === "work")) {
      const kept: number[] = []
      for (let index = start; index < answer; index++) if (stillDrawn(sections[index]!)) kept.push(index)
      const last = sections.slice(start, end).flatMap(messagesOf).findLast((message) => message.timestamp !== undefined)
      folds.push({ part, start, end: answer, kept, continued, from, to: last?.timestamp, messages: hidden.flatMap(messagesOf) })
    }
  }
  for (const [index, section] of sections.entries()) {
    if (section.kind !== "steer") continue
    close(index)
    part += 1
    start = index + 1
    from = section.message.timestamp
    continued = true
  }
  close(sections.length)
  return folds
}
