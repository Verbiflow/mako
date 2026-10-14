import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs"
import type { GitDiff } from "@/lib/types"

/**
 * A diff read from both files, as the diff engine parses it for display,
 * so picked lines can be read from the same rows the person saw. Patches,
 * binaries and empty diffs have none.
 */
export function fileDiffOf(diff: GitDiff): FileDiffMetadata | null {
  if (diff.binary || diff.preview || (!diff.oldFile && !diff.newFile)) return null
  return parseDiffFromFile(diff.oldFile, diff.newFile)
}
