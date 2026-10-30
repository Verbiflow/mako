import { createContext } from "react"

/**
 * Asked of a transcript's scroller (`data-transcript-viewport`) by a surface that brings a conversation back in front,
 * a phone returning to the app or a Thread tapped again: land on the newest message, following it from there.
 */
export const TRANSCRIPT_END_EVENT = "mako:transcript-end"

/** Every transcript drawn within `root` lands on its newest message. */
export function landTranscriptsAtEnd(root: ParentNode = document): void {
  for (const viewport of root.querySelectorAll("[data-transcript-viewport]")) viewport.dispatchEvent(new Event(TRANSCRIPT_END_EVENT))
}

/**
 * Who draws a transcript's way back to its newest turn, when it isn't the transcript's own "Jump to latest": the
 * phone's status capsule (`web-client/dock.tsx`). The transcript says whether the reader is away from the end and
 * hands over how to go back there; with this provided it draws no button of its own, and keeps room at its end so a
 * followed end never moves back under the reader.
 */
export interface TranscriptEnd {
  away(away: boolean): void
  bind(jump: (() => void) | null): void
}

export const TranscriptEndContext = createContext<TranscriptEnd | null>(null)
