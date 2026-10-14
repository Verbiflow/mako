import type { FileDiffMetadata } from "@pierre/diffs"
import type { CommentDetail, ContextInput } from "@/lib/context-detail"

/**
 * Selected lines as a context chip: the range a person picked in the file
 * viewer or a diff, turned into the `CommentDetail` the composer carries.
 *
 * Kept free of the renderer so the mapping can be checked without a page.
 * A range arrives the way the diff engine reports it (`SelectedLineRange`):
 * either end first, each end on a side of the diff when it is one.
 */

/** The diff engine's names for a diff's two sides. */
export type DiffSide = "additions" | "deletions"

/** A picked range of lines; the diff engine's `SelectedLineRange` fits it. */
export interface LineRange {
  start: number
  end: number
  side?: DiffSide
  endSide?: DiffSide
}

/** What `CommentDetail` admits for `code` and `comment`. */
export const COMMENT_TEXT_LIMIT = 64_000

/** A diff's `deletions` are its old side; anything else, a file included, is new. */
export function commentSide(side: DiffSide | undefined): CommentDetail["side"] {
  return side === "deletions" ? "old" : "new"
}

/** A text's lines without their endings; LF and CRLF both end a line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** One line as the diff engine keeps it, ending included, without the ending. */
function bare(line: string): string {
  return line.replace(/\r?\n$/, "")
}

function clip(text: string): string {
  return text.length > COMMENT_TEXT_LIMIT ? text.slice(0, COMMENT_TEXT_LIMIT) : text
}

/** `path` relative to the workspace when it lies inside it; otherwise as given. */
export function workspacePath(path: string, workspace: string | undefined): string {
  if (!workspace) return path
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** `review.ts:200–208`, or `review.ts:200` for one line. */
export function commentLabel(detail: Pick<CommentDetail, "path" | "startLine" | "endLine">): string {
  const name = detail.path.slice(detail.path.lastIndexOf("/") + 1) || detail.path
  return detail.startLine === detail.endLine
    ? `${name}:${detail.startLine}`
    : `${name}:${detail.startLine}–${detail.endLine}`
}

/** The chip `addContext` takes for a detail. The comment travels in the detail alone. */
export function commentInput(detail: CommentDetail): ContextInput {
  return { detail, label: commentLabel(detail) }
}

/** Lines of a file picked in the viewer. `null` when the range lies past the file's end. */
export function fileCommentDetail({ path, contents, range, comment = "" }: {
  path: string
  contents: string
  range: Pick<LineRange, "start" | "end">
  comment?: string
}): CommentDetail | null {
  const lines = splitLines(contents)
  const start = Math.max(1, Math.min(range.start, range.end))
  const end = Math.min(lines.length, Math.max(range.start, range.end))
  if (start > end) return null
  return {
    kind: "comment",
    path,
    startLine: start,
    endLine: end,
    side: "new",
    source: "file",
    code: clip(lines.slice(start - 1, end).join("\n")),
    comment: clip(comment.trim()),
  }
}

/** One row of a diff read top to bottom, as its unified view shows it. */
interface Row {
  old?: number
  new?: number
  oldText?: string
  newText?: string
}

/**
 * The diff's rows in unified order. A diff read from both files also has
 * the unchanged lines between and around its hunks, which the viewer can
 * expand; a diff read from a patch has its hunks alone.
 */
function diffRows(diff: FileDiffMetadata): Row[] {
  const rows: Row[] = []
  let old = 1
  let next = 1
  const gap = (oldUntil: number, newUntil: number) => {
    if (diff.isPartial) return
    while (old < oldUntil && next < newUntil) {
      rows.push({ old, new: next, oldText: diff.deletionLines[old - 1], newText: diff.additionLines[next - 1] })
      old += 1
      next += 1
    }
  }
  for (const hunk of diff.hunks) {
    gap(hunk.deletionStart, hunk.additionStart)
    old = Math.max(hunk.deletionStart, 1)
    next = Math.max(hunk.additionStart, 1)
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            old,
            new: next,
            oldText: diff.deletionLines[content.deletionLineIndex + index],
            newText: diff.additionLines[content.additionLineIndex + index],
          })
          old += 1
          next += 1
        }
        continue
      }
      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({ old, oldText: diff.deletionLines[content.deletionLineIndex + index] })
        old += 1
      }
      for (let index = 0; index < content.additions; index += 1) {
        rows.push({ new: next, newText: diff.additionLines[content.additionLineIndex + index] })
        next += 1
      }
    }
  }
  gap(diff.deletionLines.length + 1, diff.additionLines.length + 1)
  return rows
}

/** Each side's line text by line number. */
interface SideText {
  old: Map<number, string>
  new: Map<number, string>
}

function sideText(rows: readonly Row[]): SideText {
  const text: SideText = { old: new Map(), new: new Map() }
  for (const row of rows) {
    if (row.old !== undefined && row.oldText !== undefined) text.old.set(row.old, bare(row.oldText))
    if (row.new !== undefined && row.newText !== undefined) text.new.set(row.new, bare(row.newText))
  }
  return text
}

/**
 * Lines picked in a diff, as one detail per side the selection covers.
 *
 * A selection on one side is that side's lines. One that starts on a
 * removed line and ends on an added one (or the reverse) covers rows of both
 * files; it becomes the old lines it removed and the new lines it reaches,
 * each numbered in its own file, because one range cannot name lines of two
 * files. Lines the diff does not hold (a patch's collapsed context) are left
 * out of `code`; the range still says where they are.
 */
export function diffCommentDetails({ path, base, diff, range, comment = "" }: {
  path: string
  base?: string
  diff: FileDiffMetadata
  range: LineRange
  comment?: string
}): CommentDetail[] {
  const rows = diffRows(diff)
  const text = sideText(rows)
  const startSide = commentSide(range.side)
  const endSide = commentSide(range.endSide ?? range.side)
  const make = (side: CommentDetail["side"], from: number, to: number): CommentDetail => {
    const startLine = Math.max(1, Math.min(from, to))
    const endLine = Math.max(1, from, to)
    const lines: string[] = []
    for (let line = startLine; line <= endLine; line += 1) {
      const found = text[side].get(line)
      if (found !== undefined) lines.push(found)
    }
    const detail: CommentDetail = {
      kind: "comment",
      path,
      startLine,
      endLine,
      side,
      source: "diff",
      code: clip(lines.join("\n")),
      comment: clip(comment.trim()),
    }
    if (base) detail.base = base
    return detail
  }
  if (startSide === endSide) return [make(startSide, range.start, range.end)]

  const at = (side: CommentDetail["side"], line: number) => rows.findIndex((row) => row[side] === line)
  const first = at(startSide, range.start)
  const last = at(endSide, range.end)
  if (first < 0 || last < 0) return [make(endSide, range.end, range.end)]
  const covered = rows.slice(Math.min(first, last), Math.max(first, last) + 1)
  const removed = covered.flatMap((row) => (row.old !== undefined && row.new === undefined ? [row.old] : []))
  const reached = covered.flatMap((row) => (row.new === undefined ? [] : [row.new]))
  const details: CommentDetail[] = []
  if (removed.length > 0) details.push(make("old", Math.min(...removed), Math.max(...removed)))
  if (reached.length > 0) details.push(make("new", Math.min(...reached), Math.max(...reached)))
  return details
}

/** One end of a picked range, where its field sits. */
export interface PickEnd {
  lineNumber: number
  side: DiffSide
}

/** Where the field for a picked range of a diff sits: under its lowest line. */
export function pickEnd(range: LineRange): PickEnd {
  const side = range.endSide ?? range.side ?? "additions"
  if ((range.side ?? "additions") !== side) return { lineNumber: range.end, side }
  return { lineNumber: Math.max(range.start, range.end), side }
}

/** Whether an annotation slot is the one a picked range's field sits in. */
export function isPickEnd(range: LineRange | null | undefined, annotation: PickEnd): boolean {
  if (!range) return false
  const end = pickEnd(range)
  return end.lineNumber === annotation.lineNumber && end.side === annotation.side
}

/**
 * The line of a node inside a rendered file: the row it sits in carries
 * `data-line`, its gutter cell `data-column-number`.
 */
export function lineOfNode(node: Node | null): number | null {
  let element: Element | null = node instanceof Element ? node : node?.parentElement ?? null
  while (element) {
    const value = element.getAttribute("data-line") ?? element.getAttribute("data-column-number")
    if (value !== null && /^\d+$/.test(value)) return Number(value)
    element = element.parentElement
  }
  return null
}
