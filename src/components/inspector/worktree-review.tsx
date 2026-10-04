import { useState } from "react"
import { ArrowDownIcon, GitBranchIcon, GitMergeIcon, Maximize2Icon, SparklesIcon } from "lucide-react"
import { Action } from "@/components/ui/kit"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { harnessLabels } from "@/lib/harness-label"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { gitConflictAttachment } from "@/state/git-conflicts"
import { actions, useSession } from "@/state/session"
import { viewer } from "@/state/viewer"
import { mergeWorktree, readWorktreeReviewDiffs, updateFromMain, useWorktreeReview, useWorktrees, worktreeAt } from "@/state/worktrees"

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** A button, with why it can't be pressed in its tooltip when it can't. */
function Explained({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md">{children}</span></TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">{reason}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A worktree Thread's whole branch, above its working tree: what it has done
 * since it branched from the project's branch, committed or not, a review of
 * all of it, bringing in what main has since, and merging it back when that's
 * safe. Opening a pull request stays in the card under the commit box.
 */
export function WorktreeReview() {
  const status = useSession((state) => state.git)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, status?.cwd)?.worktree)
  const { review, reread } = useWorktreeReview(worktree?.path, status)
  const [merging, setMerging] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const harness = useAcp((state) => activeLiveAcp(state)?.session.harness)
  const behind = review?.behind?.commits ?? 0
  if (!worktree || !review || (review.commits === 0 && review.files.length === 0 && behind === 0)) return null

  const since = review.into ?? "its start"
  const counted = review.files.filter((file) => file.insertions !== null)
  const insertions = counted.reduce((sum, file) => sum + (file.insertions ?? 0), 0)
  const deletions = counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const conflicts = status?.files.filter((file) => file.status === "conflicted") ?? []
  const merge = status?.operation === "merge"
  const agent = (harness && harnessLabels()[harness]) || "the agent"
  const from = review.behind?.from ?? review.into ?? "main"
  const openReview = () => {
    void viewer.openDiff(`${worktree.branch} since ${since}`, async () => {
      const { diffs, truncated } = await readWorktreeReviewDiffs(worktree.path)
      return { diffs, note: truncated ? `${plural(truncated, "more file")} changed since ${since}; open them from the Changes list.` : undefined }
    })
  }
  const mergeIn = async () => {
    await mergeWorktree(worktree, review, () => setMerging(true))
    setMerging(false)
    reread()
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
    const names = conflicts.map((entry) => entry.path)
    const listed = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${plural(names.length - 3, "more file")}` : names.join(", ")
    window.dispatchEvent(new CustomEvent("mako:attach", {
      detail: {
        files: file ? [file] : [],
        text: (references: string) =>
          `Merging ${updatedFrom ?? from} into ${worktree.branch} stopped on conflicts in ${listed}.${references ? ` ${references} has what Git reported.` : ""} Resolve each one keeping what both sides meant, stage the files, and finish with \`git merge --continue\`.`,
      },
    }))
    setAsked(true)
  }
  const dirty = status?.files.some((file) => file.status !== "untracked") ?? false
  const updateReason = dirty ? "Commit or stash your changes first." : null
  const updateButton = (
    <Action tone="outline" size="xs" disabled={updating || dirty} onClick={() => void update()} aria-label={`Update from ${from}: merge its ${plural(behind, "commit")} into ${worktree.branch}`}>
      <ArrowDownIcon />
      {updating ? "Updating…" : "Update"}
      {updating ? null : <span className="tabular text-faint">{behind}</span>}
    </Action>
  )
  const mergeButton = (
    <Action tone="outline" size="xs" disabled={merging || !review.merge.ok} onClick={() => void mergeIn()}>
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
            <SparklesIcon />
            <span key={String(asked)} className="changing-label">{asked ? "Added to your message" : `Ask ${agent} to resolve it`}</span>
          </Action>
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-1">
        <Action size="xs" disabled={!review.files.length} onClick={openReview}>
          <Maximize2Icon />
          Review all
        </Action>
        {/* The guard reads the main checkout too, which this worktree's watch doesn't hear: read it again as the pointer or focus arrives. */}
        <span className="ml-auto flex items-center gap-1" onPointerEnter={reread} onFocus={reread}>
          {behind > 0 && !merge ? <Explained reason={updateReason}>{updateButton}</Explained> : null}
          <Explained reason={review.merge.ok ? null : review.merge.reason}>{mergeButton}</Explained>
        </span>
      </div>
    </section>
  )
}
