import { GitBranchIcon, GitMergeIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "lucide-react"
import type { ThreadWorktree, WorktreeSummary } from "../../../electron/contracts/thread-worktrees.ts"
import { worktreeMark, worktreeMarkLabel } from "@/lib/worktree-marks"

/** A rail row's worktree mark, at the width of the folder mark it replaced: the branch's state in one glyph and a count. */
export function WorktreeMark({ worktree, summary }: { worktree: ThreadWorktree; summary: WorktreeSummary | undefined }) {
  const mark = worktreeMark(summary)
  const Icon = mark.kind === "pull"
    ? mark.draft ? GitPullRequestDraftIcon : GitPullRequestIcon
    : mark.kind === "landed" ? GitMergeIcon : GitBranchIcon
  return (
    <span
      data-thread-worktree={worktree.branch}
      data-worktree-mark={mark.kind}
      role="img"
      aria-label={worktreeMarkLabel(mark, worktree, summary?.into ?? null)}
      className="flex shrink-0 items-center gap-0.5 text-faint/80"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {mark.kind === "ahead" ? <span className="tabular text-label leading-none">{mark.ahead}</span> : null}
    </span>
  )
}
