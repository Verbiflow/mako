import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Action, IconAction } from "@/components/ui/kit"
import { harnessLabels, useHarnessIdentity } from "@/lib/harness-label"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { handGitAction, type GitHandoff } from "@/state/git-actions"
import { pullBaseFor } from "../../../electron/contracts/git-actions"
import { SearchSelect } from "@/components/ui/search-select"
import { desktop } from "@/state/desktop"
import { github, pullComposer, pullRequestAttachment, useBranchPull, usePullComposer } from "@/state/github"
import { useSession } from "@/state/session"
import { useOnScreen } from "@/state/thread-sessions"
import { useThreads } from "@/state/threads"
import { prefsStore, setPref } from "@/state/prefs"
import { refreshWorktreeSummaries, useWorktrees, worktreeAt } from "@/state/worktrees"
import { summarizeChecks } from "@/lib/pull-requests"
import { cn } from "@/lib/utils"
import type { GitHubStatus, PullRequest as Pull } from "@/lib/types"
import {
  CheckIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

/**
 * The pull request for this branch.
 *
 * Under the commit box rather than in a tab of its own, because it is the end
 * of one continuous motion — stage, commit, push, open — and splitting the last
 * step into separate chrome would make it read as a different activity than it
 * is. The Git control above opens the form and acts on the pull request; this
 * card is the form, what GitHub says about the open one, and how to set GitHub
 * up where that's missing.
 */
export function PullRequestCard() {
  const branchPull = useBranchPull()
  const ahead = useSession((state) => state.git?.ahead ?? 0)
  const upstream = useSession((state) => state.git?.upstream)
  const behind = useSession((state) => state.git?.behind ?? 0)
  const cwd = useSession((state) => state.git?.cwd)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
  const composing = usePullComposer(branchPull?.root)

  if (!branchPull) return null
  const { status, pull, loading, branch, root } = branchPull

  if (composing) {
    return <ComposePull
      base={status.defaultBranch}
      startedFrom={worktree?.start?.from}
      branch={branch}
      onOpened={worktree ? () => {
        setPref("landWith", { ...prefsStore.get().landWith, [worktree.repoRoot]: "pull" })
        void refreshWorktreeSummaries().catch(() => {})
      } : undefined}
      onDone={pullComposer.close}
    />
  }
  // A Thread's own worktree shows its branch in Since main, above the changes.
  if (worktree) return null

  const onDefault = Boolean(status.defaultBranch && branch === status.defaultBranch)
  const unpublished = Boolean(branch) && !upstream
  const hasWork = onDefault ? ahead > 0 : ahead > 0 || unpublished

  if (!status.installed || !status.authenticated || !status.repo) {
    // The one place a "connect" affordance belongs is exactly where the
    // feature would live — hiding it from the people who have not set it
    // up is how a capability stays undiscovered.
    if (!hasWork) return <ConnectGitHubRow status={status} />
    return <GitHubSetup status={status} />
  }

  if (pull) return <PullSummary pull={pull} loading={loading} root={root} />
  if (!onDefault && hasWork && behind > 0) return <BehindBranch behind={behind} upstream={upstream} />
  return null
}

/**
 * A quiet doorway where the PR flow will live once GitHub is connected.
 * Three different "no"s keep three different sentences — a missing CLI, a
 * missing login, and a repo with no GitHub remote are fixed differently.
 */
function ConnectGitHubRow({ status }: { status: GitHubStatus }) {
  const label = !status.installed
    ? "Install the gh CLI to track pull requests"
    : !status.authenticated
      ? "Sign in to GitHub to track pull requests"
      : "Add a GitHub remote to track pull requests"
  const copy = () => {
    void navigator.clipboard.writeText("gh auth login")
    toast.success("Copied gh auth login")
  }
  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <button
        type="button"
        onClick={status.installed && !status.authenticated ? copy : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-label text-faint",
          status.installed && !status.authenticated &&
            "pressable transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
        )}
      >
        <GitPullRequestIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    </div>
  )
}

function GitHubSetup({ status }: { status: GitHubStatus }) {
  const copyLogin = () => {
    void navigator.clipboard.writeText("gh auth login")
    toast.success("Copied gh auth login")
  }
  const title = !status.installed
    ? "Install the GitHub CLI to open a pull request"
    : !status.authenticated
      ? "Sign in to GitHub before opening a pull request"
      : "Add a GitHub remote before opening a pull request"
  const detail = !status.installed
    ? "Mako uses the gh CLI so it can reuse your existing GitHub account."
    : !status.authenticated
      ? "Run gh auth login once; Mako will use that login without asking again."
      : "Push this repository to GitHub, then refresh the Changes panel."

  return (
    <div className="flex shrink-0 items-start gap-2 border-t border-hairline px-3 py-2.5">
      <GitPullRequestIcon className="mt-px size-3.5 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 text-label leading-snug">
        <span className="block text-muted-foreground">{title}</span>
        <span className="block text-faint">{detail}</span>
      </span>
      {status.installed && !status.authenticated ? (
        <Action tone="ghost" size="xs" className="-my-0.5" onClick={copyLogin}>Copy login command</Action>
      ) : null}
    </div>
  )
}

function BehindBranch({ behind, upstream }: { behind: number; upstream?: string }) {
  const copyUpdate = () => {
    void navigator.clipboard.writeText("git pull --rebase")
    toast.success("Copied git pull --rebase")
  }
  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <div className="flex items-center gap-2 rounded-md bg-caution/10 px-2 py-1.5 ring-1 ring-caution/20">
        <GitPullRequestIcon className="size-3.5 shrink-0 text-caution" />
        <span className="min-w-0 flex-1 text-label leading-relaxed text-muted-foreground">
          This branch is {behind} {behind === 1 ? "commit" : "commits"} behind {upstream ?? "its upstream"}. Update it before opening a pull request; Mako will never force-push it.
        </span>
        <Action tone="ghost" size="xs" onClick={copyUpdate}>Copy update command</Action>
      </div>
    </div>
  )
}

/**
 * Opening the pull request.
 *
 * The Thread's harness writes it by default: it knows why the work was
 * done, reads the branch's commits and the repository's template with its
 * pull request tool, and opens it, pushing the branch first. It does so in
 * the session on screen, or in a new session of the Thread. Writing the
 * title and description yourself is the override, and nothing is published
 * until its button is pressed.
 */
export function ComposePull({
  base,
  startedFrom,
  branch,
  onDone,
  onOpened,
  className,
}: {
  /** The repository's default branch, until the branch list says better. */
  base?: string
  /** Where this worktree's branch started (`origin/main`), which the base follows when the remote has it. */
  startedFrom?: string | null
  branch?: string
  onDone: () => void
  onOpened?: () => void
  className?: string
}) {
  const live = useAcp((state) => activeLiveAcp(state)?.session.harness)
  const composing = useThreads((state) => state.composerHarness)
  const onScreen = useOnScreen()
  useHarnessIdentity()
  const harness = live ?? composing
  const named = harness ? harnessLabels()[harness] : undefined
  const agent = named || "the agent"
  const [writing, setWriting] = useState(false)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [branches, setBranches] = useState<string[]>(base ? [base] : [])
  const [selectedBase, setSelectedBase] = useState(base)
  // A base the person picked stays picked when the list arrives.
  const picked = useRef(false)

  useEffect(() => {
    void github
      .listBranches()
      .then((next) => {
        const preferred = (branch && pullBaseFor(branch, startedFrom, next, base)) ?? base
        const ordered = preferred
          ? [preferred, ...next.filter((branchName) => branchName !== preferred && branchName !== branch)]
          : next.filter((branchName) => branchName !== branch)
        setBranches(ordered)
        if (!picked.current) setSelectedBase(ordered[0])
      })
      .catch(() => {})
  }, [base, branch, startedFrom])

  const hand = (where: GitHandoff) => {
    if (!branch) return
    void handGitAction({ kind: "pr", branch, base: selectedBase, draft }, where)
      .then(onDone)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }

  const create = useCallback(async function createPullRequest() {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const pull = await github.create({
        title: title.trim(),
        body: body.trim(),
        base: selectedBase,
        draft,
      })
      toast.success(pull ? `Opened #${pull.number}` : "Pull request opened")
      onOpened?.()
      onDone()
    } catch (error) {
      toast.error("Pull request was not created", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void createPullRequest() },
      })
    } finally {
      setBusy(false)
    }
  }, [body, busy, draft, onDone, onOpened, selectedBase, title])

  const draftToggle = (
    <button
      type="button"
      aria-pressed={draft}
      onClick={() => setDraft(!draft)}
      className={cn(
        "pressable h-7 px-2 text-label transition-colors duration-100",
        draft ? "bg-fill-selected text-foreground" : "text-faint hover:text-foreground"
      )}
    >
      As draft
    </button>
  )
  // In the Thread's new tab, the session on screen is already a new one.
  const newSession = Boolean(onScreen.thread) && !onScreen.draft

  return (
    <section aria-label="Open a pull request" className={cn("shrink-0 border-t border-hairline px-2.5 py-2", className)}>
      <div className="mb-1.5 flex items-center gap-2">
        <GitPullRequestIcon className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 truncate text-ui text-faint">
          {branch} →
        </span>
        <SearchSelect
          value={selectedBase ?? ""}
          label="Pull request base branch"
          searchPlaceholder="Search branches"
          className="min-w-0 flex-1"
          options={branches.map((branchName) => ({
            value: branchName,
            label: branchName,
          }))}
          onChange={(next) => {
            picked.current = true
            setSelectedBase(next)
          }}
        />
        <IconAction label="Cancel" size="xs" onClick={onDone}>
          <XIcon />
        </IconAction>
      </div>

      {writing ? (
        <>
          <input
            autoFocus
            aria-label="Pull request title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            className="mb-1 h-8 w-full bg-raised px-2 text-ui ring-1 ring-hairline placeholder:text-faint focus:outline-none focus-visible:ring-border"
          />
          <textarea
            aria-label="Pull request description"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="What changed, and why"
            rows={4}
            className="w-full resize-none bg-raised px-2 py-1.5 text-ui leading-relaxed ring-1 ring-hairline placeholder:text-faint focus:outline-none focus-visible:ring-border"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <Action tone="solid" size="sm" disabled={!title.trim() || busy} onClick={() => void create()}>
              {busy ? "Opening…" : draft ? "Open as draft" : "Create pull request"}
            </Action>
            {draftToggle}
            <Action tone="ghost" size="xs" className="ml-auto" disabled={!branch} onClick={() => setWriting(false)}>
              Let {agent} write it
            </Action>
          </div>
        </>
      ) : (
        <>
          <p className="text-label leading-snug text-muted-foreground">
            {named || "The agent"} writes the title and description from the branch's commits and the repository's template, then opens
            it into {selectedBase ?? "the base"}{draft ? " as a draft" : ""}, pushing the branch first.
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <Action tone="solid" size="sm" disabled={!branch} onClick={() => hand("here")}>
              Ask {agent}
            </Action>
            {newSession ? (
              <Action tone="outline" size="sm" disabled={!branch} onClick={() => hand("new")}>
                In a new session
              </Action>
            ) : null}
            {draftToggle}
            <Action tone="ghost" size="xs" className="ml-auto" onClick={() => setWriting(true)}>
              Write it yourself
            </Action>
          </div>
        </>
      )}
    </section>
  )
}

/** The branch's pull request in the composer, as the `@` menu adds it. */
function attachPull() {
  const file = pullRequestAttachment()
  if (!file) return void toast.info("This branch has no pull request on GitHub.")
  window.dispatchEvent(new CustomEvent("mako:attach", { detail: { files: [file], text: (references: string) => references } }))
}

/** An open pull request, in one line plus whatever CI has to say; the Git control above merges it or hands failing checks to the agent. */
function PullSummary({ pull, loading, root }: { pull: Pull; loading: boolean; root: string }) {
  const checks = useMemo(() => summarizeChecks(pull.checks), [pull.checks])

  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <div className="flex items-center gap-2">
        <GitPullRequestIcon
          className={cn(
            "size-3.5 shrink-0",
            pull.state === "merged"
              ? "text-foreground"
              : pull.state === "closed"
                ? "text-removed"
                : pull.draft
                  ? "text-faint"
                  : "text-added"
          )}
        />
        <span className="tabular shrink-0 text-ui text-faint">#{pull.number}</span>
        <button
          type="button"
          onClick={() => void desktop.openUrl(pull.url)}
          title={pull.url}
          className="min-w-0 flex-1 truncate text-left text-ui text-foreground/90 hover:text-foreground"
        >
          {pull.title}
        </button>
        <IconAction
          label="Refresh"
          size="xs"
          onClick={() => void github.refresh(root, pull.head)}
          data-on={loading || undefined}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
        </IconAction>
        <IconAction label="Add to your message" size="xs" onClick={() => attachPull()}>
          <MessageSquarePlusIcon />
        </IconAction>
        <IconAction label="Open on GitHub" size="xs" onClick={() => void desktop.openUrl(pull.url)}>
          <ExternalLinkIcon />
        </IconAction>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[22px] text-label text-faint">
        <span>
          {pull.state === "open" && pull.draft ? "draft" : pull.state} · {pull.base}
        </span>
        <span className="tabular text-added">+{pull.additions}</span>
        <span className="tabular text-removed">−{pull.deletions}</span>

        {checks.total > 0 ? (
          <span
            className={cn(
              "flex items-center gap-1",
              checks.failed > 0 ? "text-removed" : checks.running > 0 ? "text-caution" : "text-added"
            )}
          >
            {checks.failed > 0 ? (
              <XIcon className="size-2.5" />
            ) : checks.running > 0 ? (
              <span className="size-1.5 animate-live rounded-full bg-caution" />
            ) : (
              <CheckIcon className="size-2.5" />
            )}
            {checks.failed > 0
              ? `${checks.failed} failing`
              : checks.running > 0
                ? `${checks.running} running`
                : "checks pass"}
          </span>
        ) : null}

        {pull.reviewDecision === "approved" ? (
          <span className="text-added">approved</span>
        ) : pull.reviewDecision === "changes" ? (
          <span className="text-caution">changes requested</span>
        ) : pull.reviewDecision === "required" ? (
          <span>review needed</span>
        ) : null}

        {pull.mergeable === "conflicting" ? <span className="text-removed">conflicts</span> : null}
      </div>
    </div>
  )
}
