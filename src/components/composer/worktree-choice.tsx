import { useEffect, useState } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, FolderGit2Icon, FolderIcon, GitBranchIcon, LoaderCircleIcon } from "lucide-react"
import { WORKTREE_BRANCH_PREFIX, worktreeSlug } from "../../../electron/contracts/thread-worktrees.ts"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { homeRelative } from "@/lib/skill-matrix"
import { acpStore, useAcp } from "@/state/acp"
import { titleFromPrompt } from "@/state/acp-start"
import { followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { projectDraftKey, useDrafts } from "@/state/drafts"
import { setPref, usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { moveReadiness, moveToWorktree } from "@/state/thread-place"
import { useOnScreen } from "@/state/thread-sessions"
import { threadsStore, useThreads } from "@/state/threads"
import { useWorktrees, wantSpareWorktrees, worktreeAt } from "@/state/worktrees"

const CHOICES = [
  { value: "local", label: "Local", detail: "Works in the project folder, beside anything else running there", Icon: FolderIcon },
  {
    value: "worktree",
    label: "Worktree",
    detail: "Its own checkout and branch, so Threads don't touch each other's files. Your .env files and installed packages come along",
    Icon: GitBranchIcon,
  },
] as const

const choice = "pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover data-[state=checked]:bg-fill-selected data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
const trigger = "pressable flex h-7 max-w-48 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-60"

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Where the composer's Thread works: a new Thread's choice, or where an
 * open Thread is now, with the switch into a worktree.
 */
export function WorktreeChoice() {
  const here = useOnScreen()
  // A Thread's new tab starts where the Thread works.
  if (here.draft) return null
  return here.thread ? <ThreadPlace cwd={here.cwd} /> : <NewThreadPlace />
}

/**
 * Where an open Thread works, and the switch into a worktree. A Thread has
 * one worktree: switching makes it, or joins the one another of its Sessions
 * already made. There's no switch back; a worktree's work reaches the
 * project folder through Merge into main or a pull request.
 */
function ThreadPlace({ cwd }: { cwd: string | undefined }) {
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
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
  const [open, setOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  if (!folder || !head) return null
  const branch = worktree?.branch
  const label = branch ? branch.replace(WORKTREE_BRANCH_PREFIX, "") : "Local"
  const worktreeDetail = worktree
    ? `On ${branch}, in ${homeRelative(worktree.path)}`
    : ready === "running"
      ? "After this answer finishes"
      : ready === "unanswered"
        ? "After its first answer"
        : ready === "loading"
          ? "Once the conversation has loaded"
          : ready === "unsupported"
            ? "This harness can't go on in another folder yet"
            : changed
              ? `Its own checkout and branch. The conversation and the ${plural(changed, "changed file", "changed files")} come along`
              : "Its own checkout and branch. The conversation comes along"
  const move = () => {
    setOpen(false)
    setMoving(true)
    void moveToWorktree(changed).finally(() => setMoving(false))
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-thread-place={worktree ? "worktree" : "local"}
          disabled={moving}
          aria-label={moving ? "Moving to a worktree" : branch ? `Works in a worktree on ${branch}` : "Works in the project folder"}
          title={branch ? `A worktree on ${branch}` : "Works in the project folder"}
          className={trigger}
        >
          {moving ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin" /> : worktree ? <FolderGit2Icon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
          <span data-collapse="1" className="truncate">
            {moving ? "Moving…" : label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
        <p className="px-2 py-1.5 text-label text-faint">Where this thread works</p>
        <RadioGroup.Root
          aria-label="Where this thread works"
          value={worktree ? "worktree" : "local"}
          onValueChange={(value) => {
            if (value === "worktree") move()
          }}
        >
          <RadioGroup.Item value="local" disabled={Boolean(worktree)} className={choice}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-ui">
                <FolderIcon className="size-3 shrink-0" />
                Local
              </span>
              <span className="text-label text-faint">
                {worktree ? "Its work comes back through Merge into main or a pull request" : "In the project folder, beside anything else running there"}
              </span>
            </span>
            <RadioGroup.Indicator className="mt-0.5">
              <CheckIcon className="size-3.5" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
          <RadioGroup.Item value="worktree" disabled={!worktree && ready !== "ready"} data-thread-place-action="move" className={choice}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-ui">
                <FolderGit2Icon className="size-3 shrink-0" />
                {worktree ? "Worktree" : "Switch to a worktree"}
              </span>
              <span className="text-label text-faint">{worktreeDetail}</span>
            </span>
            <RadioGroup.Indicator className="mt-0.5">
              <CheckIcon className="size-3.5" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
        </RadioGroup.Root>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Where a new Thread starts: the project folder, or a worktree of its own.
 * Shown only in a Git project; the choice is remembered, and is the same
 * setting as Settings > Conversation. In Worktree mode it names the branch
 * the send will make, and keeps checkouts of the project ready so the send
 * doesn't wait for one.
 */
function NewThreadPlace() {
  const inRepository = useSession((state) => Boolean(state.git?.root))
  const cwd = useSession((state) => state.meta?.cwd ?? "")
  const worktree = usePrefs((prefs) => prefs.newThreadsInWorktree)
  const slug = useDrafts((state) => {
    if (!inRepository || !worktree) return ""
    const text = state.drafts.find((draft) => draft.key === projectDraftKey(cwd))?.text.trim()
    return text ? worktreeSlug(titleFromPrompt(text)) : ""
  })
  const taken = useWorktrees((state) => Boolean(slug) && state.worktrees.some((entry) => entry.branch === `${WORKTREE_BRANCH_PREFIX}${slug}`))
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (inRepository && worktree && cwd) wantSpareWorktrees(cwd)
  }, [inRepository, worktree, cwd])
  if (!inRepository) return null
  const chosen = worktree ? CHOICES[1] : CHOICES[0]
  const branch = slug ? `${slug}${taken ? "-2" : ""}` : ""
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-worktree-branch={branch || undefined}
          aria-label={branch ? `Starts in a worktree on ${WORKTREE_BRANCH_PREFIX}${branch}` : `Starts in: ${chosen.label}`}
          title={branch ? `A new worktree on ${WORKTREE_BRANCH_PREFIX}${branch}` : chosen.detail}
          className={trigger}
        >
          <chosen.Icon className="size-3 shrink-0" />
          <span data-collapse="1" className="truncate">
            {branch || chosen.label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
        <p className="px-2 py-1.5 text-label text-faint">Where new threads start</p>
        <RadioGroup.Root
          aria-label="Where new threads start"
          value={chosen.value}
          onValueChange={(value) => {
            setPref("newThreadsInWorktree", value === "worktree")
            setOpen(false)
          }}
        >
          {CHOICES.map(({ value, label, detail, Icon }) => (
            <RadioGroup.Item
              key={value}
              value={value}
              className={choice}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-ui">
                  <Icon className="size-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
                <span className="text-label text-faint">{detail}</span>
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
