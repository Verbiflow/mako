import { useEffect, useState, type ReactNode } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, ChevronRightIcon, FolderIcon, GitBranchIcon, GitPullRequestIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import { WORKTREE_BRANCH_PREFIX, worktreeSlug, type WorktreeStartPoint } from "../../../electron/contracts/thread-worktrees.ts"
import { Keys } from "@/components/ui/kit"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatChord } from "@/extend/commands"
import { homeRelative } from "@/lib/skill-matrix"
import { cn } from "@/lib/utils"
import { acpStore, useAcp } from "@/state/acp"
import { titleFromPrompt } from "@/state/acp-start"
import { checkoutLabel, followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { projectDraftKey, useDrafts } from "@/state/drafts"
import { setPref, usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { moveReadiness, moveToWorktree } from "@/state/thread-workspace"
import { useOnScreen } from "@/state/thread-sessions"
import { threadsStore, useThreads } from "@/state/threads"
import { chooseWorktreeStart, useWorktrees, useWorktreeStart, useWorktreeStartChoices, wantSpareWorktrees, worktreeAt, type WorktreeStartChoice } from "@/state/worktrees"
import { BranchSearch } from "./branch-search"

/**
 * Where a Thread makes its changes: the project folder itself, or its own
 * branch in a worktree. This is not where it runs; that is the Local/Cloud
 * choice, and a cloud Thread always has its own branch.
 */
type Workspace = "project-folder" | "own-branch"

const OPTIONS = [
  { value: "project-folder", label: "Project folder", Icon: FolderIcon },
  { value: "own-branch", label: "Own branch", Icon: GitBranchIcon },
] as const

const optionClass = "pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover data-[state=checked]:bg-fill-selected data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
const triggerClass = "pressable flex h-7 max-w-48 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-60"
const OWN_BRANCH_COMMAND = "workspace.own-branch"
const OWN_BRANCH = "A worktree with its own checkout and branch, so your folder and other threads aren't touched. Your .env files and installed packages come along"

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function branchLabel(branch: string): string {
  return branch.startsWith(WORKTREE_BRANCH_PREFIX) ? branch.slice(WORKTREE_BRANCH_PREFIX.length) : branch
}

interface Choice {
  detail: string
  disabled?: boolean
}

function WorkspaceMenu({
  heading,
  value,
  choices,
  trigger,
  footer,
  panel,
  open: controlled,
  onOpenChange,
  onEscape,
  onChoose,
}: {
  heading: string
  value: Workspace
  choices: Record<Workspace, Choice>
  trigger: ReactNode
  footer?: ReactNode
  /** Shown in place of the choice while set: a step inside the menu, which Escape leaves first. */
  panel?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onEscape?: () => void
  onChoose: (value: Workspace) => void
}) {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const setOpen = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 p-1"
        onEscapeKeyDown={(event) => {
          if (!panel) return
          event.preventDefault()
          onEscape?.()
        }}
      >
        {panel ?? (
          <WorkspaceChoices
            heading={heading}
            value={value}
            choices={choices}
            footer={footer}
            onChoose={(next) => {
              setOpen(false)
              onChoose(next)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function WorkspaceChoices({ heading, value, choices, footer, onChoose }: {
  heading: string
  value: Workspace
  choices: Record<Workspace, Choice>
  footer?: ReactNode
  onChoose: (value: Workspace) => void
}) {
  return (
    <div className="animate-in fade-in-0 duration-150 ease-[var(--ease-out)]">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <p className="text-label text-faint">{heading}</p>
        <ShortcutKeys />
      </div>
      <RadioGroup.Root
        aria-label={heading}
        value={value}
        onValueChange={(next) => {
          const chosen = OPTIONS.find((option) => option.value === next)?.value
          if (chosen && chosen !== value) onChoose(chosen)
        }}
      >
        {OPTIONS.map(({ value: option, label, Icon }) => (
          <RadioGroup.Item key={option} value={option} disabled={choices[option].disabled} data-workspace-option={option} className={optionClass}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-ui">
                <Icon className="size-3 shrink-0" />
                {label}
              </span>
              <span className="text-label text-faint">{choices[option].detail}</span>
            </span>
            <RadioGroup.Indicator className="mt-0.5">
              <CheckIcon className="size-3.5" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {footer}
    </div>
  )
}

/** Why the branch starts where it does, in a line each; nothing when the folder's branch and its upstream agree. */
function startNotes(point: WorktreeStartPoint): { text: string; caution?: boolean }[] {
  const { standing, branch, upstream } = point
  const notes: { text: string; caution?: boolean }[] = []
  if (standing.kind === "behind") notes.push({ text: `${plural(standing.behind, "commit", "commits")} newer than your ${branch}` })
  if (standing.kind === "ahead" || standing.kind === "diverged")
    notes.push({ text: `With your ${plural(standing.ahead, "unpushed commit", "unpushed commits")}` })
  if (standing.kind === "diverged")
    notes.push({ text: `${upstream} also has ${plural(standing.behind, "commit", "commits")} your ${branch} doesn't`, caution: true })
  if (standing.kind === "detached") notes.push({ text: "The project folder's commit; it's on no branch" })
  if (point.fetched?.failed) notes.push({ text: point.fetched.failed })
  return notes
}

/**
 * Where the next Thread's branch starts, under the choice that makes one:
 * the start point and why, or what the person chose instead. Opens the
 * search for another branch or a pull request.
 */
function StartPoint({ point, choice, onSearch, onReset }: {
  point: WorktreeStartPoint | null | undefined
  choice: WorktreeStartChoice | undefined
  onSearch: () => void
  onReset: () => void
}) {
  const start = choice?.start
  const verb = start && start.kind !== "from" ? "Works on" : "Starts from"
  const PlaceIcon = start?.kind === "pull" ? GitPullRequestIcon : GitBranchIcon
  const place = choice ? (start?.kind === "pull" ? `${choice.label} ${choice.title ?? ""}` : choice.label) : point?.from
  const notes = start?.kind === "branch"
    ? [{ text: "Its commits go on that branch, which stays when the worktree goes" }]
    : start?.kind === "pull"
      ? [{ text: start.cross ? `Fetched from its fork as pr-${start.number}` : `On its branch, ${start.branch}` }]
      : !choice && point ? startNotes(point) : []
  if (!place) return null
  return (
    <div data-start-point={start?.kind ?? point?.standing.kind} className="mt-1 flex items-start border-t border-hairline pt-1">
      <button type="button" onClick={onSearch} aria-label={`${verb} ${place}. Choose another branch or a pull request`} className="pressable group flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-ui">
            <span className="shrink-0 text-faint">{verb}</span>
            <span title={!choice && point ? point.commit.slice(0, 12) : undefined} className="flex min-w-0 items-center gap-1 text-foreground">
              <PlaceIcon className="size-3 shrink-0 text-faint" />
              {start?.kind === "pull" && choice?.title ? (
                <span className="truncate">
                  <span className="tabular text-faint">{choice.label}</span> {choice.title}
                </span>
              ) : (
                <span className="truncate">{place}</span>
              )}
            </span>
          </span>
          {notes.map((note) => (
            <span key={note.text} className={cn("text-label", note.caution ? "text-caution" : "text-faint")}>
              {note.text}
            </span>
          ))}
        </span>
        <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-faint transition-transform duration-150 ease-[var(--ease-out)] group-hover:translate-x-0.5" />
      </button>
      {choice && (
        <button type="button" onClick={onReset} aria-label="Start from the newest instead" title="Start from the newest instead" className="pressable mt-1 ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground">
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  )
}

/** The shortcut that switches the next Thread, or opens this menu on an open one, as bound now. */
function ShortcutKeys() {
  const chord = usePrefs((prefs) => prefs.keybindings[OWN_BRANCH_COMMAND] ?? "mod+shift+b")
  return chord ? <Keys keys={formatChord(chord)} /> : null
}

/**
 * The composer's workspace choice: for a new Thread, where it will make
 * changes; for an open one, where it makes them now, with the move onto its
 * own branch.
 */
export function WorkspaceChoice() {
  const here = useOnScreen()
  // A Thread's new tab works where the Thread works.
  if (here.draft) return null
  return here.thread ? <ThreadWorkspace thread={here.thread} cwd={here.cwd} /> : <NewThreadWorkspace />
}

/**
 * An open Thread in a Git project. A Thread has one worktree: moving makes
 * it, or joins the one another of its Sessions already made. There's no move
 * back; a branch's work reaches the project folder through Merge into main
 * or a pull request.
 */
function ThreadWorkspace({ thread, cwd }: { thread: string; cwd: string | undefined }) {
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
  const threadBranch = useWorktrees((state) => state.worktrees.find((entry) => entry.thread === thread)?.branch)
  const folder = worktree?.path ?? cwd
  useEffect(() => {
    if (folder) followCheckouts([folder])
  }, [folder])
  const head = useCheckoutHead(folder)
  // A worktree made outside Mako (the agent's own, a harness's worktree mode) is its own branch too.
  const outside = worktree ? undefined : head?.linked
  const outsideBranch = outside && head ? checkoutLabel(head) : undefined
  const changed = useSession((state) => (cwd && state.git?.cwd === cwd ? state.git.files.length : 0))
  // Either store can change the answer; each hook wakes the control, and the render reads both.
  useAcp((acp) => moveReadiness(acp, threadsStore.get()))
  useThreads((threads) => moveReadiness(acpStore.get(), threads))
  const ready = moveReadiness(acpStore.get(), threadsStore.get())
  const [moving, setMoving] = useState(false)
  if (!folder || !head) return null
  const moveDetail =
    ready === "running"
      ? "After this answer finishes"
      : ready === "unanswered"
        ? "After its first answer"
        : ready === "loading"
          ? "Once the conversation has loaded"
          : ready === "unsupported"
            ? "This agent can't go on in another folder yet"
            : threadBranch
              ? `Joins this thread's branch, ${threadBranch}. Nothing in the project folder moves`
              : changed
                ? `Moves it to a worktree on a new branch. The conversation and the ${plural(changed, "changed file", "changed files")} come along`
                : "Moves it to a worktree on a new branch. The conversation comes along"
  const branch = worktree?.branch ?? outsideBranch
  const choices: Record<Workspace, Choice> = worktree
    ? {
        "project-folder": { detail: "Its work comes back through Merge into main or a pull request", disabled: true },
        "own-branch": { detail: `${worktree.branch}, in ${homeRelative(worktree.path)}` },
      }
    : outside
      ? {
          "project-folder": { detail: `Its work comes back to ${homeRelative(outside.repoRoot)} through a merge or a pull request`, disabled: true },
          "own-branch": { detail: `${outsideBranch}, in ${homeRelative(outside.path)}, a worktree made outside Mako` },
        }
      : {
          "project-folder": { detail: `Edits ${homeRelative(folder)} directly, beside you and anything else running there` },
          "own-branch": { detail: moveDetail, disabled: ready !== "ready" },
        }
  const label = moving ? "Moving…" : branch ? branchLabel(branch) : "Project folder"
  return (
    <WorkspaceMenu
      heading="Where this thread makes changes"
      value={branch ? "own-branch" : "project-folder"}
      choices={choices}
      onChoose={(value) => {
        if (value !== "own-branch") return
        setMoving(true)
        void moveToWorktree(changed).finally(() => setMoving(false))
      }}
      trigger={
        <button
          type="button"
          data-workspace={branch ? "own-branch" : "project-folder"}
          data-workspace-scope="thread"
          data-worktree-origin={outside ? "outside" : undefined}
          disabled={moving}
          aria-label={moving ? "Moving to its own branch" : branch ? `Makes changes on its own branch, ${branch}${outside ? ", in a worktree made outside Mako" : ""}` : "Makes changes in the project folder"}
          title={branch ?? "Makes changes in the project folder"}
          className={triggerClass}
        >
          {moving ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin" /> : branch ? <GitBranchIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
          <span data-collapse="1" className="truncate">
            {label}
          </span>
        </button>
      }
    />
  )
}

/**
 * A new Thread in a Git project. The choice is remembered, and is the same
 * setting as Settings › Worktrees. On its own branch it names the branch
 * the send will make, and keeps worktrees of the project ready so the send
 * doesn't wait for one.
 */
function NewThreadWorkspace() {
  const inRepository = useSession((state) => Boolean(state.git?.root))
  const cwd = useSession((state) => state.meta?.cwd ?? "")
  const ownBranch = usePrefs((prefs) => prefs.newThreadsInWorktree)
  const slug = useDrafts((state) => {
    if (!inRepository || !ownBranch) return ""
    const text = state.drafts.find((draft) => draft.key === projectDraftKey(cwd))?.text.trim()
    return text ? worktreeSlug(titleFromPrompt(text)) : ""
  })
  const taken = useWorktrees((state) => Boolean(slug) && state.worktrees.some((entry) => entry.branch === `${WORKTREE_BRANCH_PREFIX}${slug}`))
  useEffect(() => {
    if (inRepository && ownBranch && cwd) wantSpareWorktrees(cwd)
  }, [inRepository, ownBranch, cwd])
  // Opening the menu and starting to write each read it again, so the send finds the upstream fetched.
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const start = useWorktreeStart(cwd, inRepository && ownBranch, `${opened}:${slug ? 1 : 0}`)
  const choice = useWorktreeStartChoices((choices) => (ownBranch ? choices.byFolder[cwd] : undefined))
  if (!inRepository) return null
  const value: Workspace = ownBranch ? "own-branch" : "project-folder"
  const existing = choice && choice.start.kind !== "from" ? choice : undefined
  const branch = existing ? existing.label : slug ? `${WORKTREE_BRANCH_PREFIX}${slug}${taken ? "-2" : ""}` : ""
  const label = existing ? existing.label : slug ? `${slug}${taken ? "-2" : ""}` : ownBranch ? "Own branch" : "Project folder"
  const from = choice?.start.kind === "from" ? `, from ${choice.label}` : ""
  const describe = existing?.start.kind === "pull"
    ? `Works on pull request ${existing.label}${existing.title ? `, ${existing.title}` : ""}`
    : existing ? `Works on ${existing.label}, a branch that exists` : branch ? `Starts on its own branch, ${branch}${from}` : ownBranch ? `Starts on its own branch${from}` : "Starts in the project folder"
  return (
    <WorkspaceMenu
      heading="Where new threads make changes"
      value={value}
      choices={{
        "project-folder": { detail: `Edits ${homeRelative(cwd)} directly, beside you and anything else running there` },
        "own-branch": { detail: OWN_BRANCH },
      }}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setOpened((count) => count + 1)
        else setSearching(false)
      }}
      onChoose={(next) => setPref("newThreadsInWorktree", next === "own-branch")}
      footer={ownBranch ? (
        <StartPoint point={start} choice={choice} onSearch={() => setSearching(true)} onReset={() => chooseWorktreeStart(cwd, null)} />
      ) : undefined}
      panel={searching ? (
        <BranchSearch
          cwd={cwd}
          onBack={() => setSearching(false)}
          onChoose={(chosen) => {
            chooseWorktreeStart(cwd, chosen)
            setOpen(false)
            setSearching(false)
          }}
        />
      ) : undefined}
      onEscape={() => setSearching(false)}
      trigger={
        <button
          type="button"
          data-workspace={value}
          data-workspace-scope="new"
          data-worktree-branch={branch || undefined}
          data-worktree-start={choice?.start.kind}
          aria-label={describe}
          title={ownBranch ? describe : "Makes changes in the project folder"}
          className={triggerClass}
        >
          {!ownBranch ? <FolderIcon className="size-3 shrink-0" /> : existing?.start.kind === "pull" ? <GitPullRequestIcon className="size-3 shrink-0" /> : <GitBranchIcon className="size-3 shrink-0" />}
          <span data-collapse="1" className="truncate">
            {label}
          </span>
        </button>
      }
    />
  )
}
