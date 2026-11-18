import type { ReactElement } from "react"
import { warmProse } from "@/lib/prose-parser-client"

/**
 * Settled prose, rendered once per text. `Markdown` is a pure function of
 * its input, and the elements it returns read references and the transcript
 * source from context when they render, so a thread switched back to or a
 * turn scrolled back into view reuses them instead of parsing again.
 */
const SETTLED_PROSE_ENTRIES = 600
const SETTLED_PROSE_CHARS = 6_000_000
export const settledProse = new Map<string, ReactElement>()
let settledProseChars = 0

export function rememberSettledProse(text: string, element: ReactElement) {
  settledProse.set(text, element)
  settledProseChars += text.length
  while (
    settledProse.size > SETTLED_PROSE_ENTRIES ||
    settledProseChars > SETTLED_PROSE_CHARS
  ) {
    const oldest = settledProse.keys().next().value
    if (oldest === undefined) break
    settledProse.delete(oldest)
    settledProseChars -= oldest.length
  }
}

/**
 * Parses these settled answers ahead of their turns mounting (`warmProse`), the nearest first: the ones whose
 * elements aren't already kept from an earlier draw.
 */
export function warmSettledProse(texts: readonly string[]): void {
  warmProse(texts.filter((text) => !settledProse.has(text)))
}
