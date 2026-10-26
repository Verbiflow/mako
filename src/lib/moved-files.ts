import type { MoveOutcome } from "@mako/host/contracts/workspace-moves"

/** "1 file", "3 files". */
export const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`

/** What stayed, path by path, for a tooltip. */
export function stayedPaths(outcome: MoveOutcome): string[] {
  const listed = (label: string, share: { files: number; paths: string[] }) =>
    share.files ? [`${label}: ${share.paths.join(", ")}${share.files > share.paths.length ? `, and ${share.files - share.paths.length} more` : ""}`] : []
  return [...listed("Might be its", outcome.stayed.uncertain), ...listed("Changed before Mako was watching", outcome.stayed.unattributed)]
}
