import { formatBytes } from "@/lib/format"
import type { GitDiff } from "@/lib/types"

/** A binary file's sizes, "12 KB → 14 KB", or the one side that exists; null when nothing was read. */
export function binarySizes(diff: Pick<GitDiff, "before" | "after">): string | null {
  const { before, after } = diff
  if (before && after) return before.bytes === after.bytes ? formatBytes(after.bytes) : `${formatBytes(before.bytes)} → ${formatBytes(after.bytes)}`
  if (after) return `Added · ${formatBytes(after.bytes)}`
  if (before) return `Deleted · ${formatBytes(before.bytes)}`
  return null
}
