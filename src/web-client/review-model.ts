import type { FileDiffMetadata } from "@pierre/diffs"
import type { TurnFileHunks, TurnHunk, TurnWriter, WriterRun } from "@mako/host/contracts/turn-review"
import type { TurnChangedFile, TurnChanges } from "@mako/host/contracts/turn-changes"
import type { CommentDetail } from "@/lib/context-detail"
import { COMMENT_TEXT_LIMIT } from "@/lib/line-comments"

/*
 * What the phone's Changes screen draws, worked out without a page: a turn's
 * files from its record, each file's stretches as rows with both line
 * numbers, the words that changed inside a line, who wrote a line where
 * another writer shares its block, which files wait behind "Load diff", and
 * the comment a picked range of rows becomes.
 */

/** A file as the screen lists it, from the turn's record: what every count on it reads. */
export interface ReviewFile {
  /** Relative to its repository, as the host's turn calls name it. */
  path: string
  /** Absolute, after the turn. */
  absolute: string
  kind: TurnChangedFile["kind"]
  /** A renamed file's path before, relative to its repository. */
  from?: string
  /** The Thread's own lines; null when it isn't counted by lines (binary, too large). */
  added: number | null
  removed: number | null
  /** Lines only timing names the Thread for. */
  unsure: number
}

/** The turn's files, in the record's order, each with its own counts. */
export function reviewFiles(record: TurnChanges): ReviewFile[] {
  return record.files.map((file) => {
    const root = file.path.slice(0, file.path.length - file.relative.length - 1)
    const own = file.own
    const entry: ReviewFile = {
      path: file.relative,
      absolute: file.path,
      kind: file.kind,
      added: own === null ? null : own?.added ?? 0,
      removed: own === null ? null : own?.removed ?? 0,
      unsure: (file.maybe?.added ?? 0) + (file.maybe?.removed ?? 0),
    }
    if (file.from) entry.from = file.from.startsWith(`${root}/`) ? file.from.slice(root.length + 1) : file.from
    return entry
  })
}

/** Past either, a file's diff waits behind "Load diff": a phone draws it only when asked. */
export const LOAD_LIMITS = { lines: 400, chars: 24_000 } as const

/** Whether the record alone already says the file is too long to draw unasked, so it isn't even read. */
export function largeByRecord(file: ReviewFile): boolean {
  return (file.added ?? 0) + (file.removed ?? 0) + file.unsure > LOAD_LIMITS.lines
}

export type RowKind = " " | "-" | "+"

/** A stretch of characters inside a line, `[start, end)`. */
export interface WordRange {
  start: number
  end: number
}

/** Who wrote a changed row, drawn only in a block another writer shares. */
export interface RowWriter {
  writer: TurnWriter
  thread?: string
  /** On the last row of one writer's stretch: how many lines the stretch has. */
  lines?: number
}

export interface DiffRow {
  kind: RowKind
  /** Line numbers on each side; null on the side the row isn't on. */
  old: number | null
  new: number | null
  text: string
  /** The words that changed, when few enough to read as an edit (`wordRanges`). */
  words?: readonly WordRange[]
  writer?: RowWriter
}

export interface DiffHunkView {
  oldStart: number
  newStart: number
  rows: DiffRow[]
}

export interface FileView {
  hunks: DiffHunkView[]
  rows: number
  chars: number
  /** Rows past the host's bound were left out. */
  limited: boolean
  /** The widest line number, for the gutter's width in digits. */
  digits: number
}

/** A file's stretches as rows, numbered on each side, with the words that changed and who wrote what. */
export function fileView(hunks: Extract<TurnFileHunks, { kind: "text" }>): FileView {
  let rows = 0
  let chars = 0
  let widest = 1
  const views = hunks.hunks.map((hunk) => {
    const view = hunkRows(hunk)
    rows += view.rows.length
    for (const row of view.rows) {
      chars += row.text.length + 1
      widest = Math.max(widest, row.old ?? 0, row.new ?? 0)
    }
    return view
  })
  for (const view of views) markWords(view.rows)
  if (hunks.writers?.length) for (const view of views) markWriters(view.rows, hunks.writers)
  return { hunks: views, rows, chars, limited: hunks.limited, digits: String(widest).length }
}

function hunkRows(hunk: TurnHunk): DiffHunkView {
  const rows: DiffRow[] = []
  // A side with no rows here names the line it follows, so its next line is one past it.
  let old = hunk.kinds.includes("-") || hunk.kinds.includes(" ") ? hunk.oldStart : hunk.oldStart + 1
  let next = hunk.kinds.includes("+") || hunk.kinds.includes(" ") ? hunk.newStart : hunk.newStart + 1
  for (let index = 0; index < hunk.kinds.length; index++) {
    // SAFETY: `kinds` is one of " ", "-", "+" per row, as the host writes it (`turn-hunks.ts`).
    const kind = hunk.kinds[index] as RowKind
    const text = hunk.lines[index] ?? ""
    if (kind === " ") rows.push({ kind, old: old++, new: next++, text })
    else if (kind === "-") rows.push({ kind, old: old++, new: null, text })
    else rows.push({ kind, old: null, new: next++, text })
  }
  return { oldStart: hunk.oldStart, newStart: hunk.newStart, rows }
}

/** Whether the file's rows are past what a phone draws unasked. */
export function largeByView(view: FileView): boolean {
  return view.rows > LOAD_LIMITS.lines || view.chars > LOAD_LIMITS.chars
}

/** The change blocks of a stretch: each run of removed rows and the added rows right after them. */
function changeBlocks(rows: readonly DiffRow[]): { removed: number[]; added: number[] }[] {
  const blocks: { removed: number[]; added: number[] }[] = []
  let block: { removed: number[]; added: number[] } | undefined
  rows.forEach((row, index) => {
    if (row.kind === " ") {
      block = undefined
      return
    }
    if (!block || (row.kind === "-" && block.added.length)) {
      block = { removed: [], added: [] }
      blocks.push(block)
    }
    ;(row.kind === "-" ? block.removed : block.added).push(index)
  })
  return blocks
}

/*
 * Word highlights, T3 Code's rule: a removed line and the added line it
 * became are compared word by word, and the changed words are marked only
 * when they read as an edit, at most 4 stretches covering at most 45% of
 * the line. Past that the line was rewritten, and marks would be noise.
 */
const WORDS = { ranges: 4, coverage: 0.45, lineLength: 1_000, comparisons: 1_000, tokens: 400 } as const

function markWords(rows: DiffRow[]): void {
  let compared = 0
  for (const block of changeBlocks(rows)) {
    const pairs = Math.min(block.removed.length, block.added.length)
    for (let pair = 0; pair < pairs && compared < WORDS.comparisons; pair++, compared++) {
      const removed = rows[block.removed[pair]!]!
      const added = rows[block.added[pair]!]!
      const found = wordRanges(removed.text, added.text)
      if (found && readsAsEdit(removed.text, found.removed)) removed.words = found.removed
      if (found && readsAsEdit(added.text, found.added)) added.words = found.added
    }
  }
}

const TOKEN = /\w+|\s+|[^\w\s]/gu

/** The stretches of each line not in the other, by words; undefined when the lines are too long to compare. */
export function wordRanges(before: string, after: string): { removed: WordRange[]; added: WordRange[] } | undefined {
  if (before.length > WORDS.lineLength || after.length > WORDS.lineLength) return undefined
  const a = before.match(TOKEN) ?? []
  const b = after.match(TOKEN) ?? []
  if (a.length > WORDS.tokens || b.length > WORDS.tokens) return undefined
  // Longest common subsequence of tokens, from the end so the walk below goes forwards.
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  const removed: WordRange[] = []
  const added: WordRange[] = []
  let i = 0
  let j = 0
  let atA = 0
  let atB = 0
  const mark = (ranges: WordRange[], start: number, end: number) => {
    const last = ranges.at(-1)
    if (last && start - last.end <= 1) last.end = end
    else ranges.push({ start, end })
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      atA += a[i]!.length
      atB += b[j]!.length
      i++
      j++
    } else if (j < b.length && (i === a.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
      mark(added, atB, atB + b[j]!.length)
      atB += b[j]!.length
      j++
    } else {
      mark(removed, atA, atA + a[i]!.length)
      atA += a[i]!.length
      i++
    }
  }
  return { removed: trimRanges(before, removed), added: trimRanges(after, added) }
}

function trimRanges(text: string, ranges: WordRange[]): WordRange[] {
  return ranges.flatMap((range) => {
    let { start, end } = range
    while (start < end && /\s/u.test(text[start]!)) start++
    while (end > start && /\s/u.test(text[end - 1]!)) end--
    return end > start ? [{ start, end }] : []
  })
}

const visible = (text: string) => text.replace(/\s/gu, "").length

/** At most 4 stretches, covering at most 45% of the line's visible characters. */
export function readsAsEdit(text: string, ranges: readonly WordRange[]): boolean {
  if (ranges.length === 0 || ranges.length > WORDS.ranges) return false
  const meaningful = visible(text)
  if (meaningful === 0) return false
  const marked = ranges.reduce((total, range) => total + visible(text.slice(range.start, range.end)), 0)
  return marked / meaningful <= WORDS.coverage
}

/**
 * Who wrote each changed row, only in a block where someone besides the turn
 * wrote a line, as the desk's review names them (`writerNotes`): a block only
 * the turn wrote gets nothing, so its rows read as they always did; in a
 * shared block every row has its writer, and the last row of each writer's
 * stretch says how many lines it has.
 */
function markWriters(rows: DiffRow[], runs: readonly WriterRun[]): void {
  const hands = { additions: new Map<number, WriterRun>(), deletions: new Map<number, WriterRun>() }
  for (const run of runs) for (let line = run.start; line < run.start + run.length; line++) hands[run.side].set(line, run)
  const runOf = (row: DiffRow) => (row.kind === "-" ? hands.deletions.get(row.old!) : hands.additions.get(row.new!))
  for (const block of changeBlocks(rows)) {
    const indexes = [...block.removed, ...block.added]
    if (indexes.every((index) => runOf(rows[index]!)?.writer === "turn")) continue
    let stretch: DiffRow[] = []
    const close = () => {
      const last = stretch.at(-1)?.writer
      if (last) last.lines = stretch.length
      stretch = []
    }
    for (const index of indexes) {
      const row = rows[index]!
      const run = runOf(row)
      row.writer = { writer: run?.writer ?? "unknown", ...(run?.thread && { thread: run.thread }) }
      const before = stretch.at(-1)?.writer
      if (before && (before.writer !== row.writer.writer || before.thread !== row.writer.thread)) close()
      stretch.push(row)
    }
    close()
  }
}

/** One end of a picked range: a row of one stretch. */
export interface RowPick {
  hunk: number
  row: number
}

/**
 * The rows picked, as the comment chips they become: one per side the range
 * covers, as the desk's diff comments make them (`diffCommentDetails`). A
 * range of removed rows is the old file's lines; added and unchanged rows
 * are the new file's; a range across both is one of each.
 */
export function commentDetails({ path, base, view, from, to, comment }: { path: string; base: string; view: FileView; from: RowPick; to: RowPick; comment: string }): CommentDetail[] {
  const [first, last] = from.hunk < to.hunk || (from.hunk === to.hunk && from.row <= to.row) ? [from, to] : [to, from]
  const picked: DiffRow[] = []
  for (let hunk = first.hunk; hunk <= last.hunk; hunk++) {
    const rows = view.hunks[hunk]?.rows ?? []
    const start = hunk === first.hunk ? first.row : 0
    const end = hunk === last.hunk ? last.row : rows.length - 1
    picked.push(...rows.slice(start, end + 1))
  }
  const clip = (text: string) => (text.length > COMMENT_TEXT_LIMIT ? text.slice(0, COMMENT_TEXT_LIMIT) : text)
  const make = (side: CommentDetail["side"], rows: DiffRow[]): CommentDetail => {
    const numbers = rows.map((row) => (side === "old" ? row.old! : row.new!))
    return { kind: "comment", path, startLine: Math.min(...numbers), endLine: Math.max(...numbers), side, source: "diff", base, code: clip(rows.map((row) => row.text).join("\n")), comment: clip(comment.trim()) }
  }
  const removed = picked.filter((row) => row.kind === "-")
  const reached = picked.filter((row) => row.kind !== "-")
  const details: CommentDetail[] = []
  if (removed.length) details.push(make("old", removed))
  if (reached.length) details.push(make("new", reached))
  return details
}

/** `app.ts:12`, `app.ts:12–18`, the old side's named as such when both sides are picked. */
export function rangeLabel(details: readonly CommentDetail[]): string {
  return details
    .map((detail) => {
      const name = detail.path.slice(detail.path.lastIndexOf("/") + 1) || detail.path
      const lines = detail.startLine === detail.endLine ? `${detail.startLine}` : `${detail.startLine}–${detail.endLine}`
      return `${name}:${lines}${details.length > 1 ? ` ${detail.side === "old" ? "before" : "after"}` : ""}`
    })
    .join(", ")
}

/**
 * A host from before `mako:live-turn-hunks` answers a turn's diff with both
 * versions whole: the same stretches, made here from the diff engine's parse.
 */
export function hunksFromParsed(path: string, parsed: FileDiffMetadata | null, writers: readonly WriterRun[] | undefined, body: "checkpoints" | "journal"): Extract<TurnFileHunks, { kind: "text" }> {
  const bare = (line: string | undefined) => (line ?? "").replace(/\r?\n$/u, "")
  const hunks: TurnHunk[] = (parsed?.hunks ?? []).map((hunk) => {
    const kinds: string[] = []
    const lines: string[] = []
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index++) {
          kinds.push(" ")
          lines.push(bare(parsed!.additionLines[content.additionLineIndex + index]))
        }
        continue
      }
      for (let index = 0; index < content.deletions; index++) {
        kinds.push("-")
        lines.push(bare(parsed!.deletionLines[content.deletionLineIndex + index]))
      }
      for (let index = 0; index < content.additions; index++) {
        kinds.push("+")
        lines.push(bare(parsed!.additionLines[content.additionLineIndex + index]))
      }
    }
    return { oldStart: hunk.deletionStart, newStart: hunk.additionStart, kinds: kinds.join(""), lines }
  })
  const shared = writers?.some((run) => run.writer !== "turn") ? [...writers] : undefined
  return { kind: "text", path, hunks, oldLines: parsed?.deletionLines.length ?? 0, newLines: parsed?.additionLines.length ?? 0, limited: false, ...(shared && { writers: shared }), body }
}

/** "1 file", "12 files"; "+1,204 −33" reads with the noun beside it. */
export const fileWords = (count: number) => `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`
export const commentWords = (count: number) => `${count.toLocaleString()} ${count === 1 ? "comment" : "comments"}`
export const turnWordsCount = (count: number) => `${count.toLocaleString()} ${count === 1 ? "turn" : "turns"}`

/** The folder and the name of a path, for a header that cuts the folder from its start so the name always shows. */
export function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? { folder: "", name: path } : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

/**
 * A file's path as the Session's folder names it, which a comment carries and the agent reads: relative to the
 * folder it works in when the file is inside it, else relative to its repository. macOS names the same temporary
 * folder two ways (`/tmp`, `/private/tmp`); either matches.
 */
export function sessionPath(file: Pick<ReviewFile, "path" | "absolute">, cwd: string | undefined): string {
  const plain = (path: string) => path.replace(/^\/private(?=\/(?:tmp|var)\/)/u, "")
  const absolute = plain(file.absolute)
  const folder = cwd ? plain(cwd).replace(/\/$/u, "") : undefined
  return folder && absolute.startsWith(`${folder}/`) ? absolute.slice(folder.length + 1) : file.path
}
