import { tokenize, type Segment } from "./mentions"

/**
 * What the composer's textarea shows for a draft.
 *
 * A draft keeps a conversation as its `@thread:<harness>:<id>` token: that is
 * what is saved, sent, recovered and reused. The token is 50 to 100
 * characters of ids, and the textarea's own characters are what the caret
 * steps through and what wraps, so the textarea shows the conversation's
 * label instead (`@` and its title) and the painted layer draws exactly
 * those characters as the chip. Before this the token stayed in the textarea
 * as transparent text with the title laid over its start: the rest of the
 * token showed as blank space the caret moved through one character at a
 * time, and a token longer than the line split the chip across two lines.
 *
 * A label is one unit. An edit that reaches inside it removes the whole
 * conversation, as Backspace does at its end.
 */
export interface DraftSpan {
  draftStart: number
  draftEnd: number
  viewStart: number
  viewEnd: number
}

export interface DraftView {
  text: string
  spans: DraftSpan[]
}

export type DraftPiece = Segment & { start: number }

/** The draft in reading order, each piece with its offset; a record's anchor is a `context` piece. */
export function draftPieces(text: string): DraftPiece[] {
  const pieces: DraftPiece[] = []
  let at = 0
  for (const segment of tokenize(text)) {
    pieces.push({ ...segment, start: at })
    at += segment.kind === "text" ? segment.text.length : segment.raw.length
  }
  return pieces
}

const LABEL_LIMIT = 48

/**
 * The characters a chip shows as in the composer: `@`, which its mark covers,
 * then its words, cut to one short line.
 */
export function chipLabel(words: string): string {
  const flat = words.replace(/\s+/g, " ").trim() || "Untitled"
  return `@${flat.length > LABEL_LIMIT ? `${flat.slice(0, LABEL_LIMIT - 1).trimEnd()}…` : flat}`
}

/** The characters a referenced conversation shows as in the composer. */
export function threadLabel(title: string | undefined): string {
  const flat = (title ?? "").replace(/\s+/g, " ").trim() || "Untitled conversation"
  return `@${flat.length > LABEL_LIMIT ? `${flat.slice(0, LABEL_LIMIT - 1).trimEnd()}…` : flat}`
}

/** `labels` maps a chip's raw text (a conversation token, a record's anchor) to its label; one without stays as typed. */
export function draftView(
  draft: string,
  labels: ReadonlyMap<string, string>
): DraftView {
  const spans: DraftSpan[] = []
  let text = ""
  let copied = 0
  for (const piece of draftPieces(draft)) {
    if (piece.kind !== "thread" && piece.kind !== "context") continue
    const label = labels.get(piece.raw)
    if (label === undefined) continue
    text += draft.slice(copied, piece.start)
    const viewStart = text.length
    text += label
    spans.push({ draftStart: piece.start, draftEnd: piece.start + piece.raw.length, viewStart, viewEnd: text.length })
    copied = piece.start + piece.raw.length
  }
  return { text: text + draft.slice(copied), spans }
}

/** The span whose inside (not its edges) holds this view offset. */
export function spanInside(view: DraftView, offset: number): DraftSpan | undefined {
  return view.spans.find((span) => span.viewStart < offset && offset < span.viewEnd)
}

/** A view offset in the draft. Inside a label it lands on the label's end, or its start with `toStart`. */
export function toDraftOffset(view: DraftView, offset: number, toStart = false): number {
  let shift = 0
  for (const span of view.spans) {
    if (offset <= span.viewStart) break
    if (offset < span.viewEnd) return toStart ? span.draftStart : span.draftEnd
    shift = span.draftEnd - span.viewEnd
  }
  return offset + shift
}

/** A draft offset in the view. Inside a token it lands on the label's end, or its start with `toStart`. */
export function toViewOffset(view: DraftView, offset: number, toStart = false): number {
  let shift = 0
  for (const span of view.spans) {
    if (offset <= span.draftStart) break
    if (offset < span.draftEnd) return toStart ? span.viewStart : span.viewEnd
    shift = span.viewEnd - span.draftEnd
  }
  return offset + shift
}

export interface TextRange {
  start: number
  end: number
}

export interface DraftEdit {
  draft: string
  /** Where the caret goes in the edited draft. */
  caret: number
}

/**
 * The draft after the textarea's text became `next`.
 *
 * `replaced` is the selection the edit replaced, read just before it: typing
 * over a selection, pasting, a select-all and type. Without it the edit is
 * found by comparing the two texts around `caret`, the textarea's caret after
 * the edit, which tells a typed letter from the same letter beside it. A
 * comparison can't tell typed characters from a label's own, though, so a
 * replacement that begins like a label needs the selection. An edit that
 * reaches inside a label takes the whole conversation with it.
 */
export function editDraftView(
  draft: string,
  view: DraftView,
  next: string,
  caret: number,
  replaced?: TextRange
): DraftEdit {
  const before = view.text
  let prefix = 0
  let suffix = 0
  if (
    replaced &&
    replaced.start < replaced.end &&
    replaced.end <= before.length &&
    next.length >= replaced.start + before.length - replaced.end &&
    next.startsWith(before.slice(0, replaced.start)) &&
    next.endsWith(before.slice(replaced.end))
  ) {
    // Inside the selection, what the replacement left as it was stays, a
    // whole label at a time: the comparison never stops partway into one.
    let kept = replaced.start
    while (kept < replaced.end && kept < next.length - (before.length - replaced.end) && before[kept] === next[kept]) kept++
    const into = spanInside(view, kept)
    prefix = into && into.viewStart >= replaced.start ? into.viewStart : kept
    let keptEnd = replaced.end
    const room = next.length - before.length
    while (keptEnd > prefix && keptEnd + room > prefix && before[keptEnd - 1] === next[keptEnd - 1 + room]) keptEnd--
    const out = spanInside(view, keptEnd)
    suffix = before.length - (out && out.viewEnd <= replaced.end ? out.viewEnd : keptEnd)
  } else {
    while (
      suffix < before.length &&
      suffix < next.length - Math.min(caret, next.length) &&
      before[before.length - 1 - suffix] === next[next.length - 1 - suffix]
    )
      suffix++
    const most = Math.min(before.length, next.length) - suffix
    while (prefix < most && before[prefix] === next[prefix]) prefix++
  }
  let start = prefix
  let end = before.length - suffix
  for (const span of view.spans) {
    const touches = start === end
      ? span.viewStart < start && start < span.viewEnd
      : span.viewStart < end && start < span.viewEnd
    if (!touches) continue
    start = Math.min(start, span.viewStart)
    end = Math.max(end, span.viewEnd)
  }
  const inserted = next.slice(prefix, next.length - suffix)
  const from = toDraftOffset(view, start, true)
  const to = toDraftOffset(view, end)
  // The caret is the textarea's own, carried into the new draft: inside
  // what was put in, after it, or before the change.
  const typedEnd = next.length - suffix
  const at = Math.min(caret, next.length)
  const draftCaret =
    at <= prefix
      ? Math.min(toDraftOffset(view, at), from)
      : at <= typedEnd
        ? from + (at - prefix)
        : from + inserted.length + (toDraftOffset(view, at - (next.length - before.length)) - to)
  return { draft: draft.slice(0, from) + inserted + draft.slice(to), caret: draftCaret }
}
