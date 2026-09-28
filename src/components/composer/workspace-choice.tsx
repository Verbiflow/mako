import { useEffect, useState, type ReactNode } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, FolderIcon, GitBranchIcon, LoaderCircleIcon } from "lucide-react"
import { WORKTREE_BRANCH_PREFIX, worktreeSlug } from "../../../electron/contracts/thread-worktrees.ts"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { homeRelative } from "@/lib/skill-matrix"
import { acpStore, useAcp } from "@/state/acp"
import { titleFromPrompt } from "@/state/acp-start"
import { followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { projectDraftKey, useDrafts } from "@/state/drafts"
import { setPref, usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { moveReadiness, moveToWorktree } from "@/state/thread-workspace"
import { useOnScreen } from "@/state/thread-sessions"
import { threadsStore, useThreads } from "@/state/threads"
import { useWorktrees, wantSpareWorktrees, worktreeAt } from "@/state/worktrees"

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
  onChoose,
}: {
  heading: string
  value: Workspace
  choices: Record<Workspace, Choice>
  trigger: ReactNode
  onChoose: (value: Workspace) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
        <p className="px-2 py-1.5 text-label text-faint">{heading}</p>
        <RadioGroup.Root
          aria-label={heading}
          value={value}
          onValueChange={(next) => {
            setOpen(false)
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
      </PopoverContent>
    </Popover>
  )
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
  const choices: Record<Workspace, Choice> = worktree
    ? {
        "project-folder": { detail: "Its work comes back through Merge into main or a pull request", disabled: true },
        "own-branch": { detail: `${worktree.branch}, in ${homeRelative(worktree.path)}` },
      }
    : {
        "project-folder": { detail: `Edits ${homeRelative(folder)} directly, beside you and anything else running there` },
        "own-branch": { detail: moveDetail, disabled: ready !== "ready" },
      }
  const label = moving ? "Moving…" : worktree ? branchLabel(worktree.branch) : "Project folder"
  return (
    <WorkspaceMenu
      heading="Where this thread makes changes"
      value={worktree ? "own-branch" : "project-folder"}
      choices={choices}
      onChoose={(value) => {
        if (value !== "own-branch") return
        setMoving(true)
        void moveToWorktree(changed).finally(() => setMoving(false))
      }}
      trigger={
        <button
          type="button"
          data-workspace={worktree ? "own-branch" : "project-folder"}
          disabled={moving}
          aria-label={moving ? "Moving to its own branch" : worktree ? `Makes changes on its own branch, ${worktree.branch}` : "Makes changes in the project folder"}
          title={worktree ? worktree.branch : "Makes changes in the project folder"}
          className={triggerClass}
        >
          {moving ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin" /> : worktree ? <GitBranchIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
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
 * setting as Settings > Conversation. On its own branch it names the branch
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
  if (!inRepository) return null
  const branch = slug ? `${slug}${taken ? "-2" : ""}` : ""
  const value: Workspace = ownBranch ? "own-branch" : "project-folder"
  return (
    <WorkspaceMenu
      heading="Where new threads make changes"
      value={value}
      choices={{
        "project-folder": { detail: `Edits ${homeRelative(cwd)} directly, beside you and anything else running there` },
        "own-branch": { detail: OWN_BRANCH },
      }}
      onChoose={(next) => setPref("newThreadsInWorktree", next === "own-branch")}
      trigger={
        <button
          type="button"
          data-workspace={value}
          data-worktree-branch={branch || undefined}
          aria-label={branch ? `Starts on its own branch, ${WORKTREE_BRANCH_PREFIX}${branch}` : ownBranch ? "Starts on its own branch" : "Starts in the project folder"}
          title={branch ? `A new worktree on ${WORKTREE_BRANCH_PREFIX}${branch}` : ownBranch ? OWN_BRANCH : "Makes changes in the project folder"}
          className={triggerClass}
        >
          {ownBranch ? <GitBranchIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
          <span data-collapse="1" className="truncate">
            {branch || (ownBranch ? "Own branch" : "Project folder")}
          </span>
        </button>
      }
    />
  )
}
