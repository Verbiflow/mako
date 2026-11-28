import { rowCode, type BoardIssue, type BoardPull, type BoardPullDetail } from "@mako/host/contracts/project-pulls"
import type { GitDiff } from "@mako/host/contracts/git-workspace-search"
import { readBoardPull } from "@/state/project-board"
import { desktop } from "@/state/desktop"
import { viewer } from "@/state/viewer"

/**
 * Enter on a row. A pull request opens as a tab of its own, the diff tab every change opens in: its files as GitHub's
 * patches, with its state, checks and reviews in the tab's note. An issue opens on GitHub, where it's answered.
 */
export function openBoardRow(row: BoardPull | BoardIssue, multi: ReadonlySet<string> = new Set()): void {
  if (!("head" in row)) {
    void desktop.openUrl(row.url)
    return
  }
  // Named by its code alone: a tab's name reads as a path, and titles hold slashes.
  void viewer.openDiff(rowCode(row, multi), async () => {
    const detail = await readBoardPull({ repository: row.repository, number: row.number })
    return { diffs: pullDiffs(detail, row.url), note: pullTabNote(row, detail), base: row.base }
  })
}

/** GitHub's patches as the diff tab draws them; a file GitHub gives no patch for (binary, too large) says so. */
export function pullDiffs(detail: BoardPullDetail, url: string): GitDiff[] {
  return detail.files.map((file) => file.patch !== undefined
    ? { path: file.path, binary: false, oldFile: null, newFile: null, preview: { kind: "patch", contents: patchOf(file.path, file.status, file.patch), limited: false, url: `${url}/files` } }
    : { path: file.path, binary: false, oldFile: null, newFile: null, preview: { kind: "unavailable", reason: "GitHub doesn't show this file's changes" } })
}

/** A unified diff of one file from GitHub's hunks, with the headers a patch reader expects. */
function patchOf(path: string, status: string, hunks: string): string {
  const before = status === "added" ? "/dev/null" : `a/${path}`
  const after = status === "removed" ? "/dev/null" : `b/${path}`
  return `diff --git a/${path} b/${path}\n--- ${before}\n+++ ${after}\n${hunks}\n`
}

/** The tab's one line about the pull request: its state, branch, checks and reviews. */
export function pullTabNote(row: BoardPull, detail: BoardPullDetail): string {
  const failed = detail.checks.filter((check) => check.state === "failed").length
  const running = detail.checks.filter((check) => check.state === "running").length
  const counted = detail.checks.filter((check) => check.state !== "skipped").length
  const checks = !counted ? undefined : failed ? `${failed} of ${counted} checks failing` : running ? `${running} of ${counted} checks running` : `all ${counted} checks passed`
  const approved = detail.reviews.filter((review) => review.state === "approved").map((review) => review.login)
  const changes = detail.reviews.filter((review) => review.state === "changes").map((review) => review.login)
  return [
    `${row.title} (${row.repository}#${row.number})`,
    row.state === "open" ? (row.draft ? "draft" : "open") : row.state,
    `${row.head} → ${row.base}`,
    checks,
    changes.length ? `changes requested by ${changes.join(", ")}` : approved.length ? `approved by ${approved.join(", ")}` : undefined,
    `+${detail.additions} −${detail.deletions} in ${detail.changedFiles} ${detail.changedFiles === 1 ? "file" : "files"}${detail.moreFiles ? " (first 100 shown)" : ""}`,
  ].filter(Boolean).join(" · ")
}
