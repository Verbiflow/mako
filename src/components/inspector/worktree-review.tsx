import { useState } from "react"
import { ArrowDownIcon, CheckIcon, GitBranchIcon, Maximize2Icon } from "lucide-react"
import { Explained } from "@/components/inspector/git-action-control"
import { Action } from "@/components/ui/kit"
import { harnessLabels } from "@/lib/harness-label"
import { landState, readLandWith } from "@/lib/worktree-landing"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { gitConflictAttachment } from "@/state/git-conflicts"
import { stageGitAction } from "@/state/git-actions"
import { useBranchPull } from "@/state/github"
import { usePrefs } from "@/state/prefs"
import { actions, useSession } from "@/state/session"
import { viewer } from "@/state/viewer"
import { readWorktreeReviewDiffs, updateFromMain, useLeavingWorktrees, useWorktreeReview, useWorktrees, useWorktreeSummaries, worktreeAt } from "@/state/worktrees"

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/**
 * A worktree Thread's whole branch, above its working tree: what it has done
 * since it branched from the project's branch, committed or not, a review of
 * all of it, and bringing in what main has since. Landing it, by merging or
 * through a pull request, is the Git control's, beside Fetch above the commit box.
 */
export function WorktreeReview() {
  const status = useSession((state) => state.git)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, status?.cwd)?.worktree)
  const { review, reread } = useWorktreeReview(worktree?.path, status)
  const summary = useWorktreeSummaries((state) => (worktree ? state.byPath[worktree.path] : undefined))
  const branchPull = useBranchPull()
  const last = usePrefs((prefs) => readLandWith(worktree ? prefs.landWith[worktree.repoRoot] : undefined))
  const [updating, setUpdating] = useState(false)
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const harness = useAcp((state) => activeLiveAcp(state)?.session.harness)
  const leaving = useLeavingWorktrees((state) => Boolean(worktree && state.byPath[worktree.path]))
  if (!worktree || !review || leaving) return null

  const pull = branchPull?.pull && branchPull.pull.head === worktree.branch && branchPull.pull.state === "open" ? branchPull.pull : null
  const changed = status?.files.some((file) => file.status !== "untracked") ?? false
  const land = landState({
    commits: review.commits,
    changed,
    operation: Boolean(status?.operation),
    landed: summary?.landing.kind === "merged",
    pullOpen: Boolean(pull),
    last,
  })
  const behind = review.behind?.commits ?? 0
  if (review.commits === 0 && review.files.length === 0 && behind === 0 && land.kind !== "landed" && land.kind !== "pull") return null

  const since = review.into ?? "its start"
  const into = review.into ?? "main"

  const counted = review.files.filter((file) => file.insertions !== null)
  const insertions = counted.reduce((sum, file) => sum + (file.insertions ?? 0), 0)
  const deletions = counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const conflicts = status?.files.filter((file) => file.status === "conflicted") ?? []
  const merge = status?.operation === "merge"
  const agent = (harness && harnessLabels()[harness]) || "the agent"
  const from = review.behind?.from ?? into
  const openReview = () => {
    void viewer.openDiff(`${worktree.branch} since ${since}`, async () => {
      const { diffs, truncated } = await readWorktreeReviewDiffs(worktree.path)
      return { diffs, note: truncated ? `${plural(truncated, "more file")} changed since ${since}; open them from the Changes list.` : undefined }
    })
  }
  const update = async () => {
    setUpdating(true)
    setAsked(false)
    const result = await updateFromMain(worktree)
    setUpdating(false)
    setUpdatedFrom(result?.kind === "conflicts" ? result.from : null)
    await actions.refreshGit()
    reread()
  }
  const askAgent = () => {
    const file = gitConflictAttachment()
    stageGitAction({ kind: "resolve", branch: worktree.branch, from: updatedFrom ?? from, files: conflicts.map((entry) => entry.path) }, file ? [file] : [])
    setAsked(true)
  }

  const updateReason = changed ? "Commit or stash your changes first." : null
  const landedNote = land.kind === "landed"
    ? summary?.pull?.state === "merged" ? `#${summary.pull.number} merged; its work is in ${into}` : `Its work is in ${into}`
    : null

  return (
    <section aria-label={`Since ${since}`} className="shrink-0 border-b border-hairline px-2.5 py-1.5 text-label">
      <div className="flex h-5 items-center gap-1.5">
        <GitBranchIcon className="size-3.5 shrink-0 text-faint" />
        <span className="shrink-0 font-medium text-muted-foreground">Since {since}</span>
        <span className="min-w-0 flex-1 truncate tabular text-faint">
          {[review.commits ? plural(review.commits, "commit") : "", review.files.length ? plural(review.files.length, "file") : ""].filter(Boolean).join(" · ")}
        </span>
        {counted.length ? <>
          <span className="tabular text-added">+{insertions}</span>
          <span className="tabular text-removed">−{deletions}</span>
        </> : null}
      </div>
      {landedNote && review.files.length ? (
        <p className="mt-0.5 flex items-center gap-1 pl-5 text-faint">
          <CheckIcon className="size-3 shrink-0 text-added" />
          {landedNote}
        </p>
      ) : null}
      {behind > 0 && !merge ? (
        <p className="mt-0.5 flex items-center gap-1 pl-5 tabular text-faint">
          {from} has {plural(behind, "commit")} this branch doesn't
        </p>
      ) : null}
      {merge && conflicts.length ? (
        <div role="status" className="animate-in fade-in-0 mt-1.5 flex items-center gap-2 rounded-md bg-fill-hover px-2 py-1.5 duration-200 ease-[var(--ease-out)]">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {conflicts.length === 1 ? "1 file conflicts" : `${conflicts.length} files conflict`} with {updatedFrom ?? from}
          </span>
          <Action size="xs" tone={asked ? "ghost" : "outline"} disabled={asked} onClick={askAgent}>
            <span key={String(asked)} className="changing-label">{asked ? "Added to your message" : `Ask ${agent} to resolve it`}</span>
          </Action>
        </div>
      ) : null}
      {review.files.length || (behind > 0 && !merge) ? <div className="mt-1 flex items-center gap-1">
        {review.files.length ? (
          <Action size="xs" onClick={openReview}>
            <Maximize2Icon />
            Review all
          </Action>
        ) : landedNote ? (
          <span className="flex min-w-0 items-center gap-1 pl-5 text-faint animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">
            <CheckIcon className="size-3 shrink-0 text-added" />
            <span className="truncate">{landedNote}</span>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {behind > 0 && !merge ? (
            <Explained reason={updateReason}>
              <Action tone="outline" size="xs" disabled={updating || changed} onClick={() => void update()} aria-label={`Update from ${from}: merge its ${plural(behind, "commit")} into ${worktree.branch}`}>
                <ArrowDownIcon />
                {updating ? "Updating…" : "Update"}
                {updating ? null : <span className="tabular text-faint">{behind}</span>}
              </Action>
            </Explained>
          ) : null}
        </span>
      </div> : null}
    </section>
  )
}
