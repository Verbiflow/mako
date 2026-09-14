import { useCallback, useEffect, useMemo, useState } from "react"
import { Action, IconAction } from "@/components/ui/kit"
import { SearchSelect } from "@/components/ui/search-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { desktop } from "@/state/desktop"
import { git } from "@/state/git"
import { github, useGitHub } from "@/state/github"
import { currentCommitModel } from "@/state/commit-model"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import type { CheckSummary, GitHubStatus, PullRequest as Pull } from "@/lib/types"
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

const PULL_REQUEST_PROMPT = `Write a pull request title and body from this diff.

The first line is a concise imperative title with no prefix and no period. Then a blank line, then:

## Summary
- Two or three bullets explaining what changed and why

## Test plan
- A short checklist of concrete verification steps

Be specific. Do not invent tests or behavior not shown by the diff.`

/**
 * The pull request for this branch.
 *
 * Under the commit box rather than in a tab of its own, because it is the end
 * of one continuous motion — stage, commit, push, open — and splitting the last
 * step into separate chrome would make it read as a different activity than it
 * is. It appears only when there is something to say: a PR that exists, or a
 * branch with commits that could become one.
 */
export function PullRequestCard() {
  const status = useGitHub((state) => state.status)
  const pull = useGitHub((state) => state.pull)
  const loading = useGitHub((state) => state.loading)
  const cached = useGitHub((state) => state.branch)
  const cachedRoot = useGitHub((state) => state.root)
  const statusRoot = useGitHub((state) => state.statusRoot)

  const branch = useSession((state) => state.git?.branch)
  const ahead = useSession((state) => state.git?.ahead ?? 0)
  const upstream = useSession((state) => state.git?.upstream)
  const behind = useSession((state) => state.git?.behind ?? 0)
  const root = useSession((state) => state.git?.root)
  const [composing, setComposing] = useState(false)
  useEffect(() => {
    if (!root) return
    if (
      cachedRoot !== root ||
      statusRoot !== root ||
      cached !== branch
    )
      void github.refresh(root, branch)
  }, [branch, cached, cachedRoot, root, statusRoot])

  if (!root || cachedRoot !== root || statusRoot !== root || cached !== branch || !status)
    return null

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

  if (composing) {
    return <ComposePull base={status.defaultBranch} branch={branch} onDone={() => setComposing(false)} />
  }

  if (pull) return <PullSummary pull={pull} loading={loading} />
  if (onDefault || !hasWork) return null
  if (behind > 0) {
    return <BehindBranch behind={behind} upstream={upstream} />
  }

  const commits = unpublished && ahead === 0 ? "unpushed" : `${ahead} ${ahead === 1 ? "commit" : "commits"}`

  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <button
        type="button"
        onClick={() => setComposing(true)}
        className={cn(
          "pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
        )}
      >
        <GitPullRequestIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Open a pull request for {branch}</span>
        <span className="tabular shrink-0 text-label text-faint">{commits}</span>
      </button>
    </div>
  )
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
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
      <div className="flex items-start gap-2 rounded-md bg-surface px-2 py-2 ring-1 ring-hairline">
        <GitPullRequestIcon className="mt-0.5 size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1">
          <span className="block text-ui text-foreground/90">{title}</span>
          <span className="mt-0.5 block text-label leading-relaxed text-faint">{detail}</span>
        </span>
        {status.installed && !status.authenticated ? (
          <Action tone="ghost" size="xs" onClick={copyLogin}>Copy login command</Action>
        ) : null}
      </div>
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
 * Drafting the pull request.
 *
 * Nothing is published until the button is pressed, and the button says
 * exactly what it does. The agent can draft the title and body from the diff —
 * the same model, the same idea as the commit draft — but what it writes is a
 * starting point in an editable field, not a thing that happens to you.
 */
function ComposePull({
  base,
  branch,
  onDone,
}: {
  base?: string
  branch?: string
  onDone: () => void
}) {
  const cwd = useSession((state) => state.git?.cwd ?? state.meta?.cwd ?? "")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [branches, setBranches] = useState<string[]>(base ? [base] : [])
  const [selectedBase, setSelectedBase] = useState(base)

  useEffect(() => {
    void github
      .listBranches()
      .then((next) => {
        const ordered = base
          ? [base, ...next.filter((branchName) => branchName !== base)]
          : next
        setBranches(ordered)
        setSelectedBase((current) => current ?? ordered[0])
      })
      .catch(() => {})
  }, [base])

  const compose = useCallback(async function composePull() {
    if (drafting) return
    setDrafting(true)
    try {
      // The utility model reads the same bounded diff as the commit drafter,
      // but uses a PR-specific structure with a summary and test plan.
      const { model } = await currentCommitModel()
      const result = await git.generateMessage({
        requestId: crypto.randomUUID(),
        cwd,
        prompt: PULL_REQUEST_PROMPT,
        model,
      })
      const [first, ...rest] = result.message.split("\n")
      setTitle((current) => current || (first ?? "").trim())
      setBody((current) => current || rest.join("\n").trim())
    } catch (error) {
      toast.error("Pull request draft was not generated", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void composePull() },
      })
    } finally {
      setDrafting(false)
    }
  }, [drafting, cwd])

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
  }, [body, busy, draft, onDone, selectedBase, title])

  return (
    <div className="shrink-0 border-t border-hairline px-2.5 py-2">
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
          onChange={setSelectedBase}
        />
        <IconAction label="Draft it from the diff" size="xs" onClick={() => void compose()}>
          <SparklesIcon className={drafting ? "animate-spin" : undefined} />
        </IconAction>
        <IconAction label="Cancel" size="xs" onClick={onDone}>
          <XIcon />
        </IconAction>
      </div>

      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        className="mb-1 h-8 w-full rounded-md bg-raised px-2 text-ui placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What changed, and why"
        rows={4}
        className="w-full resize-none rounded-md bg-raised px-2 py-1.5 text-ui leading-relaxed placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
      />

      <div className="mt-1.5 flex items-center gap-2">
        <Action tone="solid" disabled={!title.trim() || busy} onClick={() => void create()}>
          {busy ? "Opening…" : draft ? "Open as draft" : "Create pull request"}
        </Action>
        <button
          type="button"
          onClick={() => setDraft(!draft)}
          className={cn(
            "pressable rounded px-1.5 py-1 text-label transition-colors duration-100",
            draft ? "bg-fill-selected text-foreground" : "text-faint hover:text-foreground"
          )}
        >
          Draft
        </button>
        <span className="ml-auto text-label text-faint">pushes the branch first</span>
      </div>
    </div>
  )
}

/** An open pull request, in one line plus whatever CI has to say. */
function PullSummary({ pull, loading }: { pull: Pull; loading: boolean }) {
  const root = useGitHub((state) => state.root)
  const checks = useMemo(() => summarize(pull.checks), [pull.checks])
  const [merging, setMerging] = useState(false)
  const mergeBlocked =
    pull.state !== "open" ||
    pull.mergeable === "conflicting" ||
    checks.failed > 0 ||
    checks.running > 0 ||
    pull.reviewDecision === "changes"
  const mergeReason =
    pull.state !== "open"
      ? `This pull request is already ${pull.state}`
      : pull.mergeable === "conflicting"
        ? "Resolve merge conflicts first"
        : checks.failed > 0
          ? "Fix failing checks first"
          : checks.running > 0
            ? "Wait for checks to finish"
            : pull.reviewDecision === "changes"
              ? "Address requested changes first"
              : undefined

  const merge = useCallback(async function mergePullRequest(
    strategy: "merge" | "squash" | "rebase"
  ) {
    if (merging) return
    setMerging(true)
    try {
      const next = await github.merge(strategy)
      toast.success(next?.state === "merged" ? `Merged #${next.number}` : "Pull request merged")
    } catch (error) {
      toast.error("Pull request was not merged", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: {
          label: "Retry",
          onClick: () => void mergePullRequest(strategy),
        },
      })
    } finally {
      setMerging(false)
    }
  }, [merging])

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
          onClick={() => root && void github.refresh(root, pull.head)}
          data-on={loading || undefined}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
        </IconAction>
        <MergeMenu
          disabled={mergeBlocked}
          reason={mergeReason}
          merging={merging}
          onMerge={(strategy) => void merge(strategy)}
        />
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

        {checks.failed > 0 ? (
          <button
            type="button"
            onClick={() => void github.rerun()}
            className="pressable ml-auto rounded px-1 text-faint hover:text-foreground"
          >
            Re-run failed
          </button>
        ) : null}
      </div>
    </div>
  )
}

function MergeMenu({
  disabled,
  reason,
  merging,
  onMerge,
}: {
  disabled: boolean
  reason?: string
  merging: boolean
  onMerge: (strategy: "merge" | "squash" | "rebase") => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || merging}
          title={reason ?? "Merge pull request"}
          className="pressable flex h-6 items-center gap-0.5 rounded px-1.5 text-label text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
        >
          <GitMergeIcon className="size-3" />
          {merging ? "Merging…" : "Merge"}
          <ChevronDownIcon className="size-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-48 p-1">
        <p className="px-2 py-1 text-label text-faint">Merge strategy</p>
        {([
          ["squash", "Squash and merge"],
          ["merge", "Create merge commit"],
          ["rebase", "Rebase and merge"],
        ] as const).map(([strategy, label]) => (
          <button
            key={strategy}
            type="button"
            onClick={() => onMerge(strategy)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-foreground/90 hover:bg-fill-hover"
          >
            <GitMergeIcon className="size-3.5 text-faint" />
            {label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function summarize(checks: CheckSummary[]) {
  let passed = 0
  let failed = 0
  let running = 0
  for (const check of checks) {
    if (check.state === "passed") passed += 1
    else if (check.state === "failed") failed += 1
    else if (check.state === "running") running += 1
  }
  return { total: checks.length, passed, failed, running }
}
