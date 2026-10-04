import { useState, type ReactNode } from "react"
import { ArrowDownIcon, CheckIcon, ChevronDownIcon, ExternalLinkIcon, GitBranchIcon, GitMergeIcon, GitPullRequestDraftIcon, GitPullRequestIcon, Maximize2Icon, RefreshCwIcon, SparklesIcon, Trash2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { ComposePull } from "@/components/inspector/pull-request"
import { Action } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { harnessLabels } from "@/lib/harness-label"
import { pullMergeReason, pullSetupReason, summarizeChecks } from "@/lib/pull-requests"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { PullRequest } from "@/lib/types"
import { landState, readLandWith, type LandWith } from "@/lib/worktree-landing"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { desktop } from "@/state/desktop"
import { gitConflictAttachment } from "@/state/git-conflicts"
import { github, useBranchPull } from "@/state/github"
import { setPref, prefsStore, usePrefs } from "@/state/prefs"
import { actions, useSession } from "@/state/session"
import { viewer } from "@/state/viewer"
import { mergeWorktree, readWorktreeReviewDiffs, refreshWorktreeSummaries, removeWorktree, updateFromMain, useWorktreeReview, useWorktrees, useWorktreeSummaries, worktreeAt } from "@/state/worktrees"

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** A button, with why it can't be pressed in its tooltip when it can't. */
function Explained({ reason, children }: { reason: string | null | undefined; children: ReactNode }) {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md">{children}</span></TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">{reason}</TooltipContent>
    </Tooltip>
  )
}

/** The landing action and, behind its chevron, the other ways to land: one control, so the choice reads as one decision. */
function SplitAction({ main, menu, label }: { main: ReactNode; menu: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-stretch rounded-md border border-border">
      {main}
      <span aria-hidden className="my-1 w-px bg-border" />
      <Menu modal={false}>
        <MenuTrigger asChild>
          <Action size="xs" tone="quiet" aria-label={label} className="rounded-l-none px-1 [&_svg]:size-3">
            <ChevronDownIcon />
          </Action>
        </MenuTrigger>
        <MenuContent align="end" side="bottom" className="min-w-56">{menu}</MenuContent>
      </Menu>
    </span>
  )
}

function ChecksGlyph({ pull }: { pull: PullRequest }) {
  const checks = summarizeChecks(pull.checks)
  if (!checks.total) return null
  if (checks.failed) return <XIcon className="text-removed" />
  if (checks.running) return <span className="size-1.5 animate-live rounded-full bg-caution" />
  return <CheckIcon className="text-added" />
}

function pullTip(pull: PullRequest): string[] {
  const checks = summarizeChecks(pull.checks)
  const ran = !checks.total ? null
    : checks.failed ? `${checks.failed} ${checks.failed === 1 ? "check" : "checks"} failing`
    : checks.running ? `${checks.running} ${checks.running === 1 ? "check" : "checks"} running`
    : "Checks pass"
  const review = pull.reviewDecision === "approved" ? "Approved"
    : pull.reviewDecision === "changes" ? "Changes requested"
    : pull.reviewDecision === "required" ? "Review needed"
    : null
  return [pull.title, [pull.draft ? "Draft" : null, ran, review, pull.mergeable === "conflicting" ? "Conflicts" : null].filter(Boolean).join(" · ")].filter(Boolean)
}

/**
 * A worktree Thread's whole branch, above its working tree: what it has done
 * since it branched from the project's branch, committed or not, a review of
 * all of it, bringing in what main has since, and the one place to land it.
 * The landing action follows the branch: merge it or open a pull request
 * (whichever this project used last), view the pull request once it's open,
 * and remove the worktree once its work is in.
 */
export function WorktreeReview() {
  const status = useSession((state) => state.git)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, status?.cwd)?.worktree)
  const { review, reread } = useWorktreeReview(worktree?.path, status)
  const summary = useWorktreeSummaries((state) => (worktree ? state.byPath[worktree.path] : undefined))
  const branchPull = useBranchPull()
  const last = usePrefs((prefs) => readLandWith(worktree ? prefs.landWith[worktree.repoRoot] : undefined))
  const [merging, setMerging] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const [composing, setComposing] = useState(false)
  const harness = useAcp((state) => activeLiveAcp(state)?.session.harness)
  if (!worktree || !review) return null

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
  const remember = (way: LandWith) => setPref("landWith", { ...prefsStore.get().landWith, [worktree.repoRoot]: way })

  if (composing) {
    return (
      <section aria-label={`Open a pull request for ${worktree.branch}`} className="shrink-0 border-b border-hairline animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">
        <ComposePull
          className="border-t-0"
          base={branchPull?.status.defaultBranch ?? review.into ?? undefined}
          branch={worktree.branch}
          onOpened={() => {
            remember("pull")
            void refreshWorktreeSummaries().catch(() => {})
          }}
          onDone={() => setComposing(false)}
        />
      </section>
    )
  }

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
  const mergeIn = async () => {
    const merged = await mergeWorktree(worktree, review, () => setMerging(true))
    setMerging(false)
    if (merged) {
      remember("merge")
      void refreshWorktreeSummaries().catch(() => {})
    }
    reread()
  }
  const mergePull = async (strategy: "merge" | "squash" | "rebase") => {
    try {
      const next = await github.merge(strategy)
      toast.success(next?.state === "merged" ? `Merged #${next.number}` : "Pull request merged")
      void refreshWorktreeSummaries().catch(() => {})
    } catch (error) {
      toast.error("Pull request was not merged", { duration: ACTION_TOAST_MS, description: error instanceof Error ? error.message : String(error) })
    }
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

  const updateReason = changed ? "Commit or stash your changes first." : null
  const pullReason = !branchPull ? "Checking GitHub…"
    : pullSetupReason(branchPull.status)
      ?? ((status?.behind ?? 0) > 0 ? `This branch is ${plural(status?.behind ?? 0, "commit")} behind ${status?.upstream ?? "its upstream"}. Pull them first.` : null)
  const mergeReason = review.merge.ok ? null : review.merge.reason
  const segment = "rounded-r-none border-0"

  const mergeAction = (
    <Explained reason={mergeReason}>
      <Action tone="quiet" size="xs" className={segment} disabled={merging || Boolean(mergeReason)} onClick={() => void mergeIn()}>
        <GitMergeIcon />
        {merging ? "Merging…" : `Merge into ${into}`}
      </Action>
    </Explained>
  )
  const pullAction = (
    <Explained reason={pullReason}>
      <Action tone="quiet" size="xs" className={segment} disabled={Boolean(pullReason)} onClick={() => setComposing(true)}>
        <GitPullRequestIcon />
        Open pull request
      </Action>
    </Explained>
  )
  const mergeItem = (
    <MenuItem disabled={merging || Boolean(mergeReason)} onSelect={() => void mergeIn()}>
      <GitMergeIcon className="size-3.5 text-faint" />
      <span className="min-w-0 flex-1">
        Merge into {into} here
        {mergeReason ? <span className="block text-label text-faint">{mergeReason}</span> : null}
      </span>
    </MenuItem>
  )
  const pullItem = (
    <MenuItem disabled={Boolean(pullReason)} onSelect={() => setComposing(true)}>
      <GitPullRequestIcon className="size-3.5 text-faint" />
      <span className="min-w-0 flex-1">
        Open a pull request
        {pullReason ? <span className="block text-label text-faint">{pullReason}</span> : null}
      </span>
    </MenuItem>
  )

  let landing: ReactNode = null
  if (land.kind === "commits") {
    landing = (
      <SplitAction
        label={`Other ways to land ${worktree.branch}`}
        main={land.main === "pull" ? pullAction : mergeAction}
        menu={land.main === "pull" ? mergeItem : pullItem}
      />
    )
  } else if (land.kind === "pull" && pull) {
    const PullIcon = pull.draft ? GitPullRequestDraftIcon : GitPullRequestIcon
    const pullMergeBlocked = pullMergeReason(pull)
    const failing = summarizeChecks(pull.checks).failed > 0
    landing = (
      <SplitAction
        label={`More for #${pull.number}`}
        main={
          <Tooltip>
            <TooltipTrigger asChild>
              <Action tone="quiet" size="xs" className={segment} onClick={() => void desktop.openUrl(pull.url)} aria-label={`View pull request #${pull.number} on GitHub`}>
                <PullIcon className={pull.draft ? "text-faint" : "text-added"} />
                <span>View <span className="tabular">#{pull.number}</span></span>
                <ChecksGlyph pull={pull} />
              </Action>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex max-w-72 flex-col gap-0.5">
              {pullTip(pull).map((line) => <span key={line}>{line}</span>)}
            </TooltipContent>
          </Tooltip>
        }
        menu={<>
          {pullMergeBlocked ? (
            <MenuItem disabled>
              <GitMergeIcon className="size-3.5 text-faint" />
              <span className="min-w-0 flex-1">
                Merge #{pull.number} on GitHub
                <span className="block text-label text-faint">{pullMergeBlocked}</span>
              </span>
            </MenuItem>
          ) : <>
            <MenuLabel>Merge #{pull.number} on GitHub</MenuLabel>
            {([["squash", "Squash and merge"], ["merge", "Create a merge commit"], ["rebase", "Rebase and merge"]] as const).map(([strategy, label]) => (
              <MenuItem key={strategy} onSelect={() => void mergePull(strategy)}>
                <GitMergeIcon className="size-3.5 text-faint" />
                {label}
              </MenuItem>
            ))}
          </>}
          {failing ? (
            <MenuItem onSelect={() => void github.rerun()}>
              <RefreshCwIcon className="size-3.5 text-faint" />
              Re-run failed checks
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => void desktop.openUrl(pull.url)}>
            <ExternalLinkIcon className="size-3.5 text-faint" />
            Open on GitHub
          </MenuItem>
          <MenuSeparator />
          {mergeItem}
        </>}
      />
    )
  } else if (land.kind === "landed") {
    landing = (
      <Action tone="outline" size="xs" onClick={() => void removeWorktree(worktree)}>
        <Trash2Icon />
        Remove worktree
      </Action>
    )
  }

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
            <SparklesIcon />
            <span key={String(asked)} className="changing-label">{asked ? "Added to your message" : `Ask ${agent} to resolve it`}</span>
          </Action>
        </div>
      ) : null}
      {review.files.length || landing || (behind > 0 && !merge) ? <div className="mt-1 flex items-center gap-1">
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
        {/* The guard reads the main checkout too, which this worktree's watch doesn't hear: read it again as the pointer or focus arrives. */}
        <span className="ml-auto flex items-center gap-1" onPointerEnter={reread} onFocus={reread}>
          {behind > 0 && !merge ? (
            <Explained reason={updateReason}>
              <Action tone="outline" size="xs" disabled={updating || changed} onClick={() => void update()} aria-label={`Update from ${from}: merge its ${plural(behind, "commit")} into ${worktree.branch}`}>
                <ArrowDownIcon />
                {updating ? "Updating…" : "Update"}
                {updating ? null : <span className="tabular text-faint">{behind}</span>}
              </Action>
            </Explained>
          ) : null}
          {landing}
        </span>
      </div> : null}
    </section>
  )
}
