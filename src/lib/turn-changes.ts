import type { GitFile } from "@/lib/types"
import { countedChanges, type RequestChanges, type TurnChangedFile } from "@mako/host/contracts/turn-changes"

/** What one finished turn changed: the line under its answer. */
export interface TurnChangeSummary {
  files: number
  /** Lines added across the files that report a count; null when none does (all binary, say). */
  insertions: number | null
  deletions: number | null
  /** Files with changes that might be the person's or another app's rather than the agent's; counted apart, never in `files`. */
  maybe: number
  /** Counted before the journal settled every change: the numbers may still move. */
  settling: boolean
}

/**
 * A turn's line from its request's record (`LiveRequest.changes`), the one
 * the journal counted: the agent's own files and net lines. Undefined
 * while the record is pending, or for a turn from before Mako kept one.
 */
export function recordedTurnChanges(changes: RequestChanges | undefined): TurnChangeSummary | undefined {
  const counted = countedChanges(changes)
  if (!counted) return undefined
  const lines = counted.own.added + counted.own.removed > 0
  return {
    files: counted.own.files,
    insertions: lines ? counted.own.added : null,
    deletions: lines ? counted.own.removed : null,
    maybe: counted.maybe.files,
    settling: counted.state === "settling",
  }
}

/** The files a turn from before the journal counted turns changed, from its checkpoints; a file without a count (a binary) adds to the files and nothing else. */
export function turnChangeSummary(files: readonly Pick<GitFile, "insertions" | "deletions">[]): TurnChangeSummary {
  let insertions: number | null = null
  let deletions: number | null = null
  for (const file of files) {
    if (file.insertions !== null) insertions = (insertions ?? 0) + file.insertions
    if (file.deletions !== null) deletions = (deletions ?? 0) + file.deletions
  }
  return { files: files.length, insertions, deletions, maybe: 0, settling: false }
}

/** The line's words: "Changed a file", "Changed 4 files". */
export function turnChangeWords(files: number): string {
  return files === 1 ? "Changed a file" : `Changed ${files.toLocaleString()} files`
}

/** What might be the person's: "1 maybe yours", "3 maybe yours". */
export function maybeWords(files: number): string {
  return `${files.toLocaleString()} maybe yours`
}

/** The repository a record's file is in: its path less its path inside the journal's root. */
export function fileRoot(file: Pick<TurnChangedFile, "path" | "relative">): string {
  return file.path.slice(0, file.path.length - file.relative.length - 1)
}

/**
 * The repositories a turn's record names, in its order: what Review opens
 * when its checkpoints weren't both saved. Empty while the record is
 * pending, or for a turn that changed nothing.
 */
export function recordRoots(changes: RequestChanges | undefined): string[] {
  return [...new Set(countedChanges(changes)?.files.map(fileRoot) ?? [])]
}
