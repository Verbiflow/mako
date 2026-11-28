import type { BoardIssue, BoardPull } from "@mako/host/contracts/project-pulls"
import { desktop } from "@/state/desktop"

/** Enter on a row: the pull request or issue on GitHub. */
export function openBoardRow(row: BoardPull | BoardIssue): void {
  void desktop.openUrl(row.url)
}
