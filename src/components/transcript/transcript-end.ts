/**
 * Asked of a transcript's scroller (`data-transcript-viewport`) by a surface that brings a conversation back in front,
 * a phone returning to the app or a Thread tapped again: land on the newest message, following it from there.
 */
export const TRANSCRIPT_END_EVENT = "mako:transcript-end"

/** Every transcript drawn within `root` lands on its newest message. */
export function landTranscriptsAtEnd(root: ParentNode = document): void {
  for (const viewport of root.querySelectorAll("[data-transcript-viewport]")) viewport.dispatchEvent(new Event(TRANSCRIPT_END_EVENT))
}
