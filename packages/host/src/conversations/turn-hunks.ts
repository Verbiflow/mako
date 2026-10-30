import { diffLines } from "../attribution/index.js"
import type { GitDiff } from "../contracts/git-workspace-search.js"
import { TURN_HUNK_LIMITS, type TurnFileHunks, type TurnFileWriters, type TurnHunk, type WriterRun } from "../contracts/turn-review.js"

/*
 * A turn's diff of one file as stretches (`mako:live-turn-hunks`): the
 * changed lines and a few unchanged ones around each, from the same diff
 * Changes › Turn draws. A phone reads these instead of both versions whole:
 * a one-line change in a long file is a few hundred bytes, not two copies
 * of the file. The diff is the attribution journal's own line diff, so its
 * line numbers are the ones the writer runs name.
 */

/** A text's lines without their endings; LF and CRLF both end a line, and a last empty line isn't one. */
function textLines(text: string | null): string[] {
  if (text === null || text === "") return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** A text diff's stretches, the lines on each side, and whether rows past the bound were left out. */
export type TextHunks = Pick<Extract<TurnFileHunks, { kind: "text" }>, "hunks" | "oldLines" | "newLines" | "limited">

/** Stretches of `before` → `after`, each change with `context` unchanged lines either side, cut at the bound. */
export function textHunks(before: string | null, after: string | null, context: number = TURN_HUNK_LIMITS.context): TextHunks {
  const old = textLines(before)
  const next = textLines(after)
  const edits = diffLines(old, next)
  const hunks: TurnHunk[] = []
  let rows = 0
  let chars = 0
  let limited = false
  // Edits close enough that their context touches go in one stretch.
  let index = 0
  while (index < edits.length) {
    let last = index
    while (last + 1 < edits.length && edits[last + 1]!.a - (edits[last]!.a + edits[last]!.removed) <= context * 2) last++
    const first = edits[index]!
    const end = edits[last]!
    const lead = Math.min(context, first.a, first.b)
    const oldFrom = first.a - lead
    const newFrom = first.b - lead
    const oldTo = Math.min(old.length, end.a + end.removed + context)
    const kinds: string[] = []
    const lines: string[] = []
    const push = (kind: string, line: string) => {
      kinds.push(kind)
      lines.push(line)
    }
    let a = oldFrom
    let b = newFrom
    for (let at = index; at <= last; at++) {
      const edit = edits[at]!
      while (a < edit.a) {
        push(" ", old[a++]!)
        b++
      }
      for (let removed = 0; removed < edit.removed; removed++) push("-", old[a++]!)
      for (let added = 0; added < edit.added; added++) push("+", next[b++]!)
    }
    while (a < oldTo && b < next.length) {
      push(" ", old[a++]!)
      b++
    }
    const size = lines.reduce((total, line) => total + line.length + 1, 0)
    if (hunks.length && (rows + lines.length > TURN_HUNK_LIMITS.rows || chars + size > TURN_HUNK_LIMITS.chars)) {
      limited = true
      break
    }
    // The first stretch alone past the bound is cut at it, by rows and by characters, so the first change always
    // shows and the answer stays within the bound; a row cut short or left out says so.
    const kept: string[] = []
    let keptChars = 0
    for (const line of lines) {
      // Each row counts its line ending, as `size` does.
      const room = TURN_HUNK_LIMITS.chars - keptChars - 1
      if (kept.length === TURN_HUNK_LIMITS.rows || room < 0) break
      kept.push(line.length > room ? line.slice(0, room) : line)
      keptChars += Math.min(line.length, room) + 1
      if (line.length > room) break
    }
    const keep = kept.length
    if (keep < lines.length || kept.at(-1)!.length < lines[keep - 1]!.length) limited = true
    const hunk = { oldStart: oldFrom + 1, newStart: newFrom + 1, kinds: kinds.slice(0, keep).join(""), lines: kept }
    if (!hunk.kinds.includes("-") && !hunk.kinds.includes(" ")) hunk.oldStart = oldFrom
    if (!hunk.kinds.includes("+") && !hunk.kinds.includes(" ")) hunk.newStart = newFrom
    hunks.push(hunk)
    rows += keep
    chars += keptChars
    if (limited) break
    index = last + 1
  }
  return { hunks, oldLines: old.length, newLines: next.length, limited }
}

/** A shortened unified patch (a large file's checkpoints) as stretches; its own `@@` lines say where each starts. */
export function patchHunks(patch: string): TurnHunk[] {
  const hunks: TurnHunk[] = []
  let current: { oldStart: number; newStart: number; kinds: string[]; lines: string[] } | undefined
  for (const line of patch.split(/\r?\n/)) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (head) {
      if (current) hunks.push({ oldStart: current.oldStart, newStart: current.newStart, kinds: current.kinds.join(""), lines: current.lines })
      current = { oldStart: Number(head[1]), newStart: Number(head[2]), kinds: [], lines: [] }
      continue
    }
    if (!current) continue
    const kind = line[0]
    if (kind === " " || kind === "-" || kind === "+") {
      current.kinds.push(kind)
      current.lines.push(line.slice(1))
    }
  }
  if (current) hunks.push({ oldStart: current.oldStart, newStart: current.newStart, kinds: current.kinds.join(""), lines: current.lines })
  return hunks
}

/** A turn's diff of a file, as stretches, with its writers when another writer shares a change. */
export function turnFileHunks(diff: GitDiff, writers: TurnFileWriters | null, options: { context?: number; from?: string } = {}): TurnFileHunks {
  const path = diff.path
  if (diff.binary) return { kind: "binary", path, before: diff.before?.bytes ?? null, after: diff.after?.bytes ?? null }
  if (diff.preview?.kind === "unavailable") return { kind: "unavailable", path, reason: diff.preview.reason }
  const shared: WriterRun[] | undefined = writers?.runs.some((run) => run.writer !== "turn") ? writers.runs : undefined
  const body = writers?.body ?? "journal"
  const from = options.from ?? (diff.oldFile && diff.oldFile.name !== path ? diff.oldFile.name : undefined)
  if (diff.preview?.kind === "patch") {
    const hunks = patchHunks(diff.preview.contents)
    const last = hunks.at(-1)
    const ends = (side: "-" | "+") => (last ? (side === "-" ? last.oldStart : last.newStart) + [...last.kinds].filter((kind) => kind === " " || kind === side).length - 1 : 0)
    return { kind: "text", path, ...(from && { from }), hunks, oldLines: ends("-"), newLines: ends("+"), limited: true, ...(shared && { writers: shared }), body }
  }
  const context = Math.max(0, Math.min(TURN_HUNK_LIMITS.maxContext, Math.round(options.context ?? TURN_HUNK_LIMITS.context)))
  const counted = textHunks(diff.oldFile?.contents ?? null, diff.newFile?.contents ?? null, context)
  return { kind: "text", path, ...(from && { from }), ...counted, ...(shared && { writers: shared }), body }
}
