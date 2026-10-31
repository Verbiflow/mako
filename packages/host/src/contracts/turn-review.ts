import { z } from "zod"

/*
 * Reviewing and undoing what a turn changed, from its request's record
 * (`LiveRequest.changes`, `turn-changes.ts`) and the attribution journal.
 * Changes › Turn lists the record's files, draws each one's diff with who
 * wrote each changed line beside it, and can hide every line that isn't the
 * Thread's; "Undo this turn" takes the turn's own lines back out of the
 * files as they are now and keeps everyone else's.
 */

/**
 * Who last wrote a changed line of a turn's diff, as the turn's review names
 * them: the turn itself; the turn, perhaps (timing alone names it: a save of
 * the person's while it ran fits as well); the same Thread in another turn
 * (its background work, say); the person; another Thread; or nobody the
 * journal can name (a change it heard between two of its entries, or before
 * it tracked the file).
 */
export type TurnWriter = "turn" | "maybe" | "thread" | "person" | "other" | "unknown"

/** A run of changed lines one writer wrote last, 1-based on its side of the diff. */
export interface WriterRun {
  side: "additions" | "deletions"
  start: number
  length: number
  writer: TurnWriter
  /** Another Thread's id, for `other`, when the journal names one. */
  thread?: string
}

/** One file of a turn: its changed lines' writers, on the sides the turn's diff of it shows. */
export interface TurnFileWriters {
  /** Relative to the repository the review shows. */
  path: string
  runs: WriterRun[]
  /** What the diff was drawn from: the turn's checkpoints, or the journal's versions either side of its entries. */
  body: "checkpoints" | "journal"
}

/** What an undo takes back: one turn's own lines, or every line the Thread wrote in this checkout. */
export type TurnUndoScope = { kind: "turn"; requestId: string } | { kind: "thread" }

/** Lines that stay, by whose they are. */
export interface KeptLines {
  person: number
  other: number
  /** The same Thread's, from another turn (only an undo of one turn keeps these). */
  thread: number
  maybe: number
  unknown: number
}

/** A file the undo writes. */
export interface TurnUndoFile {
  /** Relative to the checkout. */
  path: string
  /**
   * What the undo does to it: takes lines out and puts lines back
   * (`lines`), removes a file the turn made, puts back one it removed, or
   * moves one it renamed back to `from`.
   */
  kind: "lines" | "remove" | "restore" | "rename"
  /** For `rename`: the path it goes back to, relative to the checkout. */
  from?: string
  /** The scope's own lines it takes out. */
  removes: number
  /** Lines the scope removed that it puts back. */
  restores: number
  /** Others' lines in the file it keeps. */
  kept: KeptLines
}

/** A file whose lines by others the undo keeps, or that it leaves whole. */
export interface TurnUndoKept {
  path: string
  kept: KeptLines
  /**
   * Why none of it is undone, when none is: its lines only might be the
   * turn's, or someone else rewrote the scope's lines since.
   */
  why?: "maybe" | "rewritten"
}

/**
 * A stretch of a file the undo can't take apart, so it leaves it as it is:
 * someone else edited the scope's lines since (`edited-since`); a writer put
 * back a line the scope removed (`line-restored-by-another-writer`, as a
 * move names it); a binary or unkept file someone changed since, or whose
 * version before isn't kept.
 */
export interface TurnUndoLeft {
  path: string
  /** Lines of the file as it is now; absent for a whole file. */
  lines?: { start: number; length: number }
  reason: "edited-since" | "line-restored-by-another-writer" | "whole-file-changed-since" | "content-not-kept"
  /** Who edited there besides the scope. */
  by: TurnWriter[]
}

export interface TurnUndoPreview {
  scope: TurnUndoScope
  /** The checkout the undo writes in. */
  checkout: string
  undo: TurnUndoFile[]
  kept: TurnUndoKept[]
  left: TurnUndoLeft[]
  /** Why it can't run now (a run in the checkout); the preview still shows what it would do. */
  refused?: string
  /** The plan's fingerprint: an undo refuses when the files changed after the preview was read. */
  token: string
}

export interface TurnUndoResult {
  files: number
  /** The checkout's state before, kept as a Git ref (`refs/mako/moves/…`) for 14 days. */
  backup: string
  left: TurnUndoLeft[]
}

/**
 * A turn's undo, kept on its request (`LiveRequest.undone`) beside the
 * record of what it changed, so the line under its answer and Changes ›
 * Turn say it was undone, live and reopened, and offer no second undo. The
 * record's counts stay what the turn did; this says what happened since.
 * An undo of every change of the Thread marks each turn of the
 * conversation whose lines it took out.
 */
export interface TurnUndone {
  /** When it ran (epoch milliseconds). */
  at: number
  /** This turn alone, or every change of the Thread. */
  scope: TurnUndoScope["kind"]
  /** Files it wrote. */
  files: number
  /** Stretches it left as they were, since someone else had edited them. */
  left: number
  /** The checkout as it was before, as a Git ref (`TurnUndoResult.backup`). */
  backup: string
}

/** A request's undo as its conversation's journal keeps it; one this build can't read is dropped. */
export const TurnUndoneSchema: z.ZodType<TurnUndone | undefined> = z.object({
  at: z.number().nonnegative(),
  scope: z.enum(["turn", "thread"]),
  files: z.number().int().nonnegative(),
  left: z.number().int().nonnegative(),
  backup: z.string(),
}).optional().catch(undefined)

/**
 * One stretch of a turn's diff of a file, as a phone reads it: the lines
 * that changed and a few unchanged ones around them, never the files whole.
 * `kinds` has one letter per row: " " unchanged, "-" removed, "+" added.
 * `oldStart` and `newStart` are the stretch's first line on each side,
 * 1-based; a side with no rows in it names the line it follows (0 before
 * the first).
 */
export interface TurnHunk {
  oldStart: number
  newStart: number
  kinds: string
  /** Each row's text, without its line ending. */
  lines: string[]
}

/**
 * A turn's diff of one file in stretches (`mako:live-turn-hunks`): what a
 * device that isn't the turn's own reads instead of the two versions whole,
 * bounded by `TURN_HUNK_LIMITS` so a reply stays small over a phone's link.
 * Its writers ride along when another writer shares a change block, so one
 * read draws the file.
 */
export type TurnFileHunks =
  | {
      kind: "text"
      path: string
      /** A renamed file's path before the turn, relative as `path` is. */
      from?: string
      hunks: TurnHunk[]
      /** Lines on each side, whole: what the diff's line numbers run to. */
      oldLines: number
      newLines: number
      /** Rows past the bound were left out; the stretches given are whole. */
      limited: boolean
      /** Who wrote each changed line, present only when someone besides the turn wrote one. */
      writers?: WriterRun[]
      body: TurnFileWriters["body"]
    }
  | { kind: "binary"; path: string; before: number | null; after: number | null }
  | { kind: "unavailable"; path: string; reason: string }

/** How much of a file `mako:live-turn-hunks` answers with, and the unchanged lines around each change. */
export const TURN_HUNK_LIMITS = { rows: 4_000, chars: 256 * 1024, context: 3, maxContext: 20 } as const
