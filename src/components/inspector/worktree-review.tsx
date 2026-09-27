import { useState } from "react"
import { GitBranchIcon, GitMergeIcon, Maximize2Icon } from "lucide-react"
import { Action } from "@/components/ui/kit"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSession } from "@/state/session"
import { viewer } from "@/state/viewer"
import { mergeWorktree, readWorktreeReviewDiffs, useWorktreeReview, useWorktrees, worktreeAt } from "@/state/worktrees"

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/**
 * A worktree Thread's whole branch, above its working tree: what it has done
 * since it branched from the project's branch, committed or not, a review of
 * all of it, and merging it back when that's safe. Opening a pull request
 * stays in the card under the commit box.
 */
export function WorktreeReview() {
  const status = useSession((state) => state.git)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, status?.cwd)?.worktree)
  const { review, reread } = useWorktreeReview(worktree?.path, status)
  const [merging, setMerging] = useState(false)
  if (!worktree || !review || (review.commits === 0 && review.files.length === 0)) return null

  const since = review.into ?? "its start"
  const counted = review.files.filter((file) => file.insertions !== null)
  const insertions = counted.reduce((sum, file) => sum + (file.insertions ?? 0), 0)
  const deletions = counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const openReview = () => {
    void viewer.openDiff(`${worktree.branch} since ${since}`, async () => {
      const { diffs, truncated } = await readWorktreeReviewDiffs(worktree.path)
      return { diffs, note: truncated ? `${plural(truncated, "more file")} changed since ${since}; open them from the Changes list.` : undefined }
    })
  }
  const merge = async () => {
    setMerging(true)
    await mergeWorktree(worktree)
    setMerging(false)
    reread()
  }
  const mergeButton = (
    <Action tone="outline" size="xs" disabled={merging || !review.merge.ok} onClick={() => void merge()}>
      <GitMergeIcon />
      {merging ? "Merging…" : `Merge into ${review.into ?? "main"}`}
    </Action>
  )

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
      <div className="mt-1 flex items-center gap-1">
        <Action size="xs" disabled={!review.files.length} onClick={openReview}>
          <Maximize2Icon />
          Review all
        </Action>
        {/* The guard reads the main checkout too, which this worktree's watch doesn't hear: read it again as the pointer or focus arrives. */}
        <span className="ml-auto" onPointerEnter={reread} onFocus={reread}>
          {review.merge.ok ? mergeButton : (
            <Tooltip>
              <TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md">{mergeButton}</span></TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64">{review.merge.reason}</TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>
    </section>
  )
}
