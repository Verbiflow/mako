import type { GitFile } from "@/lib/types"

/** What one finished turn changed, from the checkpoints either side of it. */
export interface TurnChangeSummary {
  files: number
  /** Lines added across the files that report a count; null when none does (all binary, say). */
  insertions: number | null
  deletions: number | null
}

/** The files a turn changed, summed; a file without a count (a binary) adds to the files and nothing else. */
export function turnChangeSummary(files: readonly Pick<GitFile, "insertions" | "deletions">[]): TurnChangeSummary {
  let insertions: number | null = null
  let deletions: number | null = null
  for (const file of files) {
    if (file.insertions !== null) insertions = (insertions ?? 0) + file.insertions
    if (file.deletions !== null) deletions = (deletions ?? 0) + file.deletions
  }
  return { files: files.length, insertions, deletions }
}

/** The line's words: "Changed a file", "Changed 4 files". */
export function turnChangeWords(files: number): string {
  return files === 1 ? "Changed a file" : `Changed ${files.toLocaleString()} files`
}
