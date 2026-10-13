import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { FileDiffIcon, GitBranchIcon, GitCommitHorizontalIcon, ScanSearchIcon, XIcon } from "lucide-react"
import type { ReviewTarget } from "@mako/host/contracts/live-reviews"
import type { GitCommitEntry } from "@mako/host/contracts/git-workspace-search"
import { IconAction, Keys } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { git } from "@/state/git"
import { closeReviewPicker, reviewer, startReview, useReviewPicker } from "@/state/reviews"
import { useSession } from "@/state/session"
import { useThreads } from "@/state/threads"
import { useWorktrees, useWorktreeSummaries, worktreeAt } from "@/state/worktrees"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"

const COMMIT_LIMIT = 6

interface Choice {
  id: string
  target?: ReviewTarget
  title: string
  detail?: string
  /** Why it can't be reviewed now. */
  blocked?: string
  commit?: GitCommitEntry
  icon: typeof FileDiffIcon
}

/** What to review, chosen above the composer: the uncommitted changes, the branch, or one commit. */
export function ReviewPicker({ cwd }: { cwd?: string }) {
  const open = useReviewPicker((state) => state.open)
  const root = useSession((state) => state.git?.root)
  if (!open) return null
  return <ReviewChoices key={root ?? "none"} cwd={cwd} />
}

function ReviewChoices({ cwd }: { cwd?: string }) {
  const harness = useThreads((state) => state.composerHarness)
  const running = useAcp((state) => activeLiveAcp(state)?.session.status === "running")
  const status = useSession((state) => state.git)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, status?.root)?.worktree)
  const into = useWorktreeSummaries((state) => (worktree ? state.byPath[worktree.path]?.into : undefined))
  const [defaultBranch, setDefaultBranch] = useState<string | null>()
  const [commits, setCommits] = useState<GitCommitEntry[]>()
  const [starting, setStarting] = useState<string>()
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!status?.root) return
    let current = true
    void git.defaultBranch().then((branch) => current && setDefaultBranch(branch), () => current && setDefaultBranch(null))
    void git.log(COMMIT_LIMIT).then((entries) => current && setCommits(entries), () => current && setCommits([]))
    return () => {
      current = false
    }
  }, [status?.root, status?.head])

  useEffect(() => {
    list.current?.focus()
  }, [])

  const choices = useMemo<Choice[]>(() => {
    if (!status?.root) return []
    const changed = status.files.length
    const base = into ?? defaultBranch
    const branch: Choice = {
      id: "branch",
      title: base ? `Changes against ${base}` : "Changes on this branch",
      icon: GitBranchIcon,
      ...(defaultBranch === undefined && !into
        ? { blocked: "Finding the branch this one started from…" }
        : !base
          ? { blocked: "Git couldn't tell which branch this one started from." }
          : status.branch === base
            ? { blocked: `This is ${base} itself. Review the uncommitted changes or a commit instead.` }
            : { target: { kind: "branch", base }, detail: `Everything since this branch left ${base}, committed or not` }),
    }
    return [
      {
        id: "changes",
        title: "Uncommitted changes",
        icon: FileDiffIcon,
        ...(changed
          ? { target: { kind: "changes" }, detail: `${changed} ${changed === 1 ? "file" : "files"}, staged or not` }
          : { blocked: "Nothing is uncommitted." }),
      },
      branch,
      ...(commits ?? []).map((commit): Choice => ({
        id: commit.hash,
        title: commit.subject,
        commit,
        icon: GitCommitHorizontalIcon,
        target: { kind: "commit", sha: commit.hash, title: commit.subject },
      })),
    ]
  }, [commits, defaultBranch, into, status])

  const usable = choices.filter((choice) => choice.target)
  const [activeId, setActiveId] = useState<string>()
  const active = usable.find((choice) => choice.id === activeId) ?? usable[0]

  async function pick(choice: Choice) {
    if (!choice.target || starting) return
    setStarting(choice.id)
    if (await startReview(choice.target, cwd)) closeReviewPicker()
    else setStarting(undefined)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      closeReviewPicker()
      return
    }
    const at = active ? usable.indexOf(active) : -1
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: usable.length - 1 }[event.key]
    if (move !== undefined) {
      event.preventDefault()
      const next = usable[(move + usable.length) % usable.length]
      if (next) setActiveId(next.id)
      return
    }
    if (event.key === "Enter" && active) {
      event.preventDefault()
      void pick(active)
    }
  }

  const changesAndBranch = choices.slice(0, 2)
  const commitChoices = choices.slice(2)

  return (
    <section aria-label="Code review" data-review-picker className="review-picker animate-enter shrink-0 border-b border-hairline">
      <header className="flex h-8 items-center gap-2 px-3 text-label">
        <ScanSearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="shrink-0 font-medium text-muted-foreground">Code review</span>
        <span className="min-w-0 truncate text-faint">{reviewer(harness)}, without editing anything</span>
        <IconAction label="Close code review" keys={["Esc"]} size="xs" className="ml-auto" onClick={closeReviewPicker}>
          <XIcon />
        </IconAction>
      </header>

      {status?.root ? (
        <div
          ref={list}
          id={listId}
          role="listbox"
          tabIndex={0}
          aria-label="What to review"
          aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
          aria-busy={Boolean(starting) || undefined}
          onKeyDown={onKeyDown}
          className="review-choices max-h-[min(34dvh,20rem)] overflow-y-auto overscroll-contain pb-1 outline-none"
        >
          {changesAndBranch.map((choice) => (
            <Option key={choice.id} id={`${listId}-${choice.id}`} choice={choice} active={choice === active} starting={starting === choice.id} onHover={setActiveId} onPick={pick} />
          ))}
          <div role="presentation" className="flex h-7 items-end px-3 pb-1 text-label text-faint">
            Recent commits
          </div>
          {commits === undefined ? (
            <div role="presentation" className="flex h-8 items-center px-3">
              <Shimmer text="Reading the log…" className="text-label" />
            </div>
          ) : commitChoices.length ? (
            commitChoices.map((choice) => (
              <Option key={choice.id} id={`${listId}-${choice.id}`} choice={choice} active={choice === active} starting={starting === choice.id} onHover={setActiveId} onPick={pick} />
            ))
          ) : (
            <p role="presentation" className="flex h-8 items-center px-3 text-label text-faint">No commits yet.</p>
          )}
        </div>
      ) : (
        <p className="px-3 pb-2.5 text-ui text-muted-foreground">This folder isn't a Git repository, so there are no changes to review.</p>
      )}

      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-hairline px-3 py-1.5 text-label text-faint">
        <Keys keys={["↑", "↓"]} /> to choose, <Keys keys={["↵"]} /> to review, <Keys keys={["Esc"]} /> to close.
        {running ? <span className="ml-auto">It starts once the current turn ends.</span> : null}
      </p>
    </section>
  )
}

function Option({ id, choice, active, starting, onHover, onPick }: {
  id: string
  choice: Choice
  active: boolean
  starting: boolean
  onHover: (id: string) => void
  onPick: (choice: Choice) => void
}) {
  const Icon = choice.icon
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={!choice.target || undefined}
      data-review-choice={choice.id}
      data-active={active || undefined}
      onPointerMove={() => choice.target && !active && onHover(choice.id)}
      onClick={() => onPick(choice)}
      className={cn("review-choice flex h-8 items-center gap-2.5 px-3 text-ui", choice.target ? "cursor-default" : "text-faint")}
    >
      <Icon className={cn("size-3.5 shrink-0", active ? "text-foreground" : "text-faint")} aria-hidden />
      {choice.commit ? <span className="shrink-0 font-mono text-label text-faint">{choice.commit.shortHash}</span> : null}
      <span className={cn("min-w-0 shrink truncate", choice.target ? "text-foreground" : "text-faint")}>{choice.title}</span>
      <span className="min-w-0 flex-1 truncate text-label text-faint">{choice.blocked ?? choice.detail}</span>
      {starting ? (
        <Shimmer text="Starting…" className="shrink-0 text-label" />
      ) : choice.commit ? (
        <span className="shrink-0 text-label text-faint tabular-nums">{formatRelative(choice.commit.date)}</span>
      ) : null}
      {active && !starting ? <span className="shrink-0"><Keys keys={["↵"]} /></span> : null}
    </div>
  )
}
