import { useState, type ReactNode } from "react"
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, GitMergeIcon, GitPullRequestDraftIcon, GitPullRequestIcon, MessageSquareTextIcon, RefreshCwIcon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Action, IconAction } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { gitNextStep, type GitStep } from "@/lib/git-next-step"
import { harnessLabels } from "@/lib/harness-label"
import { pullMergeReason, pullSetupReason, summarizeChecks } from "@/lib/pull-requests"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { PullRequest } from "@/lib/types"
import { readLandWith, type LandWith } from "@/lib/worktree-landing"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { desktop } from "@/state/desktop"
import { git } from "@/state/git"
import { stageGitAction } from "@/state/git-actions"
import { useGitPush } from "@/state/git-push"
import { github, pullComposer, useBranchPull } from "@/state/github"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { mergeWorktree, refreshWorktreeSummaries, removeWorktree, useWorktreeReview, useWorktrees, useWorktreeSummaries, worktreeAt } from "@/state/worktrees"

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

const MERGE_STRATEGIES = [["squash", "Squash and merge"], ["merge", "Create a merge commit"], ["rebase", "Rebase and merge"]] as const

/** A button, with why it can't be pressed in its tooltip when it can't. */
export function Explained({ reason, children }: { reason: string | null | undefined; children: ReactNode }) {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md">{children}</span></TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">{reason}</TooltipContent>
    </Tooltip>
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
    : checks.failed ? `${plural(checks.failed, "check")} failing`
    : checks.running ? `${plural(checks.running, "check")} running`
    : "Checks pass"
  const review = pull.reviewDecision === "approved" ? "Approved"
    : pull.reviewDecision === "changes" ? "Changes requested"
    : pull.reviewDecision === "required" ? "Review needed"
    : null
  return [pull.title, [pull.draft ? "Draft" : null, ran, review, pull.mergeable === "conflicting" ? "Conflicts" : null].filter(Boolean).join(" · ")].filter(Boolean)
}

/**
 * The Changes panel's one Git control, beside Fetch: the next step for this
 * branch and, behind its chevron, the others that make sense now. Push, Open
 * pull request, Merge into main and the pull request's own actions used to be
 * separate buttons in three places; `gitNextStep` picks one primary from the
 * same facts each of them read.
 */
export function GitActionControl({ cwd, branch }: { cwd: string; branch: string }) {
  const status = useSession((state) => state.git)
  const state = useGitPush(cwd, branch)
  const branchPull = useBranchPull()
  const worktree = useWorktrees((current) => worktreeAt(current.worktrees, status?.cwd)?.worktree)
  const { review, reread } = useWorktreeReview(worktree?.path, status)
  const landed = useWorktreeSummaries((current) => (worktree ? current.byPath[worktree.path]?.landing.kind === "merged" : false))
  const last = usePrefs((prefs) => readLandWith(worktree ? prefs.landWith[worktree.repoRoot] : undefined))
  const harness = useAcp((current) => activeLiveAcp(current)?.session.harness)
  const [merging, setMerging] = useState(false)
  if (!status) return null

  const pending = state.kind === "pushing" || state.kind === "syncing"
  const pull = branchPull?.pull && branchPull.pull.head === branch && branchPull.pull.state === "open" ? branchPull.pull : null
  const failing = pull?.checks.filter((check) => check.state === "failed").map((check) => check.name) ?? []
  const conflicts = status.files.some((file) => file.status === "conflicted")
  const { primary, more } = gitNextStep({
    ahead: status.ahead,
    behind: status.behind,
    published: Boolean(status.upstream),
    changed: status.files.some((file) => file.status !== "untracked"),
    operation: status.operation ?? null,
    conflicts,
    keepEdits: state.kind === "failed" && state.reason === "dirty",
    pushing: state.kind === "pushing" || state.kind === "pushed",
    onDefault: !worktree && branchPull?.status.defaultBranch === branch,
    pullBlocked: branchPull ? pullSetupReason(branchPull.status) : undefined,
    pull: pull ? { number: pull.number, mergeBlocked: pullMergeReason(pull) ?? null, failing } : null,
    worktree: worktree ? {
      into: review?.into ?? "main",
      commits: review?.commits ?? 0,
      landed,
      mergeBlocked: merging ? "Merging…" : review && !review.merge.ok ? review.merge.reason : null,
      last,
    } : null,
  })

  const agent = (harness && harnessLabels()[harness]) || "the agent"
  const remember = (way: LandWith) => {
    if (worktree) setPref("landWith", { ...prefsStore.get().landWith, [worktree.repoRoot]: way })
  }
  const land = async () => {
    if (!worktree || !review) return
    const merged = await mergeWorktree(worktree, review, () => setMerging(true))
    setMerging(false)
    if (merged) {
      remember("merge")
      void refreshWorktreeSummaries().catch(() => {})
    }
    reread()
  }
  const mergePull = async (strategy: (typeof MERGE_STRATEGIES)[number][0]) => {
    try {
      const next = await github.merge(strategy)
      toast.success(next?.state === "merged" ? `Merged #${next.number}` : "Pull request merged")
      if (worktree) void refreshWorktreeSummaries().catch(() => {})
    } catch (error) {
      toast.error("Pull request was not merged", { duration: ACTION_TOAST_MS, description: error instanceof Error ? error.message : String(error) })
    }
  }
  const run = (step: GitStep) => {
    switch (step.kind) {
      case "continue":
        return void git.remote("continue")
      case "abort":
        return void git.remote("abort")
      case "pull":
        return void git.remote(step.way)
      case "push":
        return void git.push()
      case "open-pull":
        return pullComposer.open(status.root ?? cwd)
      case "land":
        return void land()
      case "view-pull":
        return pull ? void desktop.openUrl(pull.url) : undefined
      case "fix-checks":
        return stageGitAction({ kind: "fix-checks", number: step.number, failing: step.failing })
      case "remove-worktree":
        return worktree ? void removeWorktree(worktree) : undefined
      case "merge-pull":
        return undefined
    }
  }

  const style = "h-6 gap-1 px-1.5 text-label font-normal tabular disabled:opacity-50 [&_svg]:size-3"
  const button = (step: GitStep): ReactNode => {
    const segment = more.length ? "rounded-r-none" : ""
    switch (step.kind) {
      case "continue":
        return <Explained reason={step.blocked}>
          <Action size="xs" tone="quiet" className={`${style} ${segment}`} disabled={pending || Boolean(step.blocked)} onClick={() => run(step)}>{state.kind === "syncing" ? "Working…" : `Continue ${step.operation}`}</Action>
        </Explained>
      case "pull": {
        const label = step.way === "merge_autostash" ? `Pull ${step.commits} incoming commits with stash` : step.way === "merge" ? `Pull and merge ${step.commits} incoming commits` : `Pull ${step.commits} incoming commits`
        const title = step.way === "merge_autostash" ? "Temporarily stash your edits, pull, then restore them. Restoring may cause conflicts; staged edits return unstaged." : step.way === "merge" ? "Merge incoming commits into this branch, preserving both histories" : "Pull incoming commits"
        return <Action size="xs" tone="quiet" className={`${style} ${segment}`} disabled={pending || Boolean(step.blocked)} aria-label={label} title={step.blocked ?? title} onClick={() => run(step)}>
          <ArrowDownIcon />{state.kind === "syncing" ? "Pulling…" : step.way === "merge_autostash" ? `Pull with stash ${step.commits}` : step.way === "merge" ? `Pull & merge ${step.commits}` : `Pull ${step.commits}`}
        </Action>
      }
      case "push":
        return <Action size="xs" tone="quiet" className={`${style} ${segment}`} data-push-state={state.kind} aria-label={`Push to ${branch}`} aria-busy={state.kind === "pushing"} disabled={pending || state.kind === "pushed" || conflicts} title={step.publish ? `Publish ${branch} to origin` : `Push ${plural(step.commits, "commit")} to ${status.upstream}`} onClick={() => run(step)}>
          {state.kind === "pushed" ? <CheckIcon /> : <ArrowUpIcon />}
          <span role="status" className="git-action-label" key={state.kind}>{state.kind === "pushing" ? `Pushing ${step.commits}…` : state.kind === "pushed" ? "Pushed" : step.publish ? "Publish branch" : `Push ${step.commits}`}</span>
        </Action>
      case "open-pull":
        return <Explained reason={step.blocked}>
          <Action size="xs" tone="quiet" className={`${style} ${segment}`} disabled={Boolean(step.blocked)} onClick={() => run(step)}><GitPullRequestIcon />Open pull request</Action>
        </Explained>
      case "land":
        return <Explained reason={merging ? null : step.blocked}>
          <Action size="xs" tone="quiet" className={`${style} ${segment}`} disabled={Boolean(step.blocked)} onClick={() => run(step)}><GitMergeIcon />{merging ? "Merging…" : `Merge into ${step.into}`}</Action>
        </Explained>
      case "view-pull": {
        if (!pull) return null
        const PullIcon = pull.draft ? GitPullRequestDraftIcon : GitPullRequestIcon
        return <Tooltip>
          <TooltipTrigger asChild>
            <Action size="xs" tone="quiet" className={`${style} ${segment}`} aria-label={`View pull request #${pull.number} on GitHub`} onClick={() => run(step)}>
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
      case "remove-worktree":
        return <Action size="xs" tone="quiet" className={`${style} ${segment}`} onClick={() => run(step)}><Trash2Icon />Remove worktree</Action>
      case "abort":
      case "fix-checks":
      case "merge-pull":
        return null
    }
  }

  const item = (step: GitStep): ReactNode => {
    const icon = "size-3.5 text-faint"
    const reasoned = (label: ReactNode, reason: string | null) => <span className="min-w-0 flex-1">{label}{reason ? <span className="block text-label text-faint">{reason}</span> : null}</span>
    switch (step.kind) {
      case "abort":
        return <MenuItem key="abort" disabled={pending} onSelect={() => run(step)}><Undo2Icon className={icon} />Abort {step.operation}</MenuItem>
      case "push":
        return <MenuItem key="push" disabled={pending || conflicts} onSelect={() => run(step)}><ArrowUpIcon className={icon} />{step.publish ? `Publish ${branch}` : `Push ${plural(step.commits, "commit")}`}</MenuItem>
      case "open-pull":
        return <MenuItem key="open-pull" disabled={Boolean(step.blocked)} onSelect={() => run(step)}><GitPullRequestIcon className={icon} />{reasoned("Open a pull request", step.blocked)}</MenuItem>
      case "land":
        return <MenuItem key="land" disabled={Boolean(step.blocked)} onSelect={() => run(step)}><GitMergeIcon className={icon} />{reasoned(`Merge into ${step.into} here`, step.blocked)}</MenuItem>
      case "view-pull":
        return <MenuItem key="view-pull" onSelect={() => run(step)}><GitPullRequestIcon className={icon} />View #{step.number} on GitHub</MenuItem>
      case "merge-pull":
        return step.blocked
          ? <MenuItem key="merge-pull" disabled><GitMergeIcon className={icon} />{reasoned(`Merge #${step.number} on GitHub`, step.blocked)}</MenuItem>
          : <span key="merge-pull" className="contents">
            <MenuLabel>Merge #{step.number} on GitHub</MenuLabel>
            {MERGE_STRATEGIES.map(([strategy, label]) => <MenuItem key={strategy} onSelect={() => void mergePull(strategy)}><GitMergeIcon className={icon} />{label}</MenuItem>)}
          </span>
      case "fix-checks":
        return <span key="fix-checks" className="contents">
          <MenuItem onSelect={() => run(step)}>
            <MessageSquareTextIcon className={icon} />
            <span className="min-w-0 flex-1">
              Ask {agent} to fix the checks
              <span className="block truncate text-label text-faint">{step.failing.length === 1 ? `${step.failing[0]} is failing` : `${step.failing.length} are failing`}</span>
            </span>
          </MenuItem>
          <MenuItem onSelect={() => void github.rerun()}><RefreshCwIcon className={icon} />Re-run failed checks</MenuItem>
        </span>
      case "continue":
      case "pull":
      case "remove-worktree":
        return null
    }
  }

  return (
    // The worktree merge check reads the main checkout too, which this worktree's watch doesn't hear: read it again as the pointer or focus arrives.
    <span data-push-control className="flex shrink-0 items-center gap-1" onPointerEnter={worktree ? reread : undefined} onFocus={worktree ? reread : undefined}>
      <IconAction size="xs" label="Fetch remote changes" disabled={pending} onClick={() => void git.remote("fetch")}>
        <RefreshCwIcon className={state.kind === "syncing" && state.action === "fetch" ? "animate-spin motion-reduce:animate-none" : ""} />
      </IconAction>
      {primary ? (
        <span data-git-next={primary.kind} className="inline-flex items-stretch rounded-md ring-1 ring-hairline">
          {button(primary)}
          {more.length ? <>
            <span aria-hidden className="my-1 w-px bg-hairline" />
            <Menu modal={false}>
              <MenuTrigger asChild>
                <Action size="xs" tone="quiet" aria-label="More Git actions" className="h-6 rounded-l-none px-1 [&_svg]:size-3">
                  <ChevronDownIcon />
                </Action>
              </MenuTrigger>
              <MenuContent align="end" side="top" className="min-w-56">
                {more.map((step, index) => <span key={step.kind} className="contents">
                  {index > 0 && step.kind === "land" && more[index - 1]?.kind !== "open-pull" ? <MenuSeparator /> : null}
                  {item(step)}
                </span>)}
              </MenuContent>
            </Menu>
          </> : null}
        </span>
      ) : null}
    </span>
  )
}
