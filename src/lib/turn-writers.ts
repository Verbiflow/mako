import type { FileDiffMetadata } from "@pierre/diffs"
import type { TurnWriter, WriterRun } from "@mako/host/contracts/turn-review"

/** One writer's stretch of a turn's diff, as the row under it names them. */
export interface WriterNote {
  writer: TurnWriter
  thread?: string
  lines: number
}

/** Where a note sits: under the last line of its stretch, on that line's side. */
export const noteKey = (side: "additions" | "deletions", line: number) => `${side}:${line}`

/**
 * Who wrote each changed stretch of a file's diff, keyed by the line it ends
 * on, in the order the diff draws its lines (a change block's removed lines,
 * then its added ones). Each stretch is one writer's consecutive lines. A
 * change block only the turn wrote gets no note, so its lines read as they
 * always did; in a block another writer shares, the turn's stretch is named
 * too, so where one writer ends and the next begins is plain.
 */
export function writerNotes(diff: FileDiffMetadata, runs: readonly WriterRun[]): Map<string, WriterNote> {
  const notes = new Map<string, WriterNote>()
  if (!runs.some((run) => run.writer !== "turn")) return notes
  const hands = { additions: new Map<number, WriterRun>(), deletions: new Map<number, WriterRun>() }
  for (const run of runs) for (let line = run.start; line < run.start + run.length; line++) hands[run.side].set(line, run)
  for (const hunk of diff.hunks) {
    let before = hunk.deletionStart
    let after = hunk.additionStart
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        before += content.lines
        after += content.lines
        continue
      }
      const lines = [
        ...Array.from({ length: content.deletions }, (_, offset) => ({ side: "deletions" as const, line: before + offset })),
        ...Array.from({ length: content.additions }, (_, offset) => ({ side: "additions" as const, line: after + offset })),
      ]
      before += content.deletions
      after += content.additions
      if (lines.every(({ side, line }) => hands[side].get(line)?.writer === "turn")) continue
      let open: { note: WriterNote; side: "additions" | "deletions"; line: number } | undefined
      const close = () => {
        if (open) notes.set(noteKey(open.side, open.line), open.note)
        open = undefined
      }
      for (const { side, line } of lines) {
        const run = hands[side].get(line)
        const writer = run?.writer ?? "unknown"
        if (open && open.note.writer === writer && open.note.thread === run?.thread) {
          open.note.lines++
          open.side = side
          open.line = line
          continue
        }
        close()
        open = { note: { writer, ...(run?.thread && { thread: run.thread }), lines: 1 }, side, line }
      }
      close()
    }
  }
  return notes
}

/** A writer as the row under its lines names them. */
export function writerLabel(note: Pick<WriterNote, "writer">, threadTitle?: string): string {
  switch (note.writer) {
    case "turn":
      return "This thread"
    case "maybe":
      return "Maybe this thread"
    case "thread":
      return "This thread, another turn"
    case "person":
      return "You"
    case "other":
      return threadTitle ? `Another thread · ${threadTitle}` : "Another thread"
    case "unknown":
      return "Nobody Mako can name"
  }
}

/** "1 line", "4 lines". */
export const lineWords = (count: number) => `${count.toLocaleString()} ${count === 1 ? "line" : "lines"}`
