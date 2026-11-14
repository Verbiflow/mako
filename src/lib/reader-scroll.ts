/**
 * Sent to a transcript's scroller (`data-transcript-viewport`) just before the app scrolls it for the reader: the
 * crew card's "Fins need you" line bringing the card back, a failure row shown. The transcript takes what follows as
 * the reader's movement, as it takes a wheel's, so it keeps it. Unannounced, a scroll it doesn't own reads as layout
 * moving under the reader, and holding their place put the old place back over it, windowed or not.
 */
export const READER_SCROLL_EVENT = "mako:reader-scroll"

/** Scroll `element` into view for the reader, telling the transcript that holds it first. */
export function scrollReaderTo(element: Element, options?: ScrollIntoViewOptions): void {
  element.closest("[data-transcript-viewport]")?.dispatchEvent(new Event(READER_SCROLL_EVENT))
  element.scrollIntoView(options)
}
