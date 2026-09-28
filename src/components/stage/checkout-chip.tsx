import { useEffect } from "react"
import { toast } from "sonner"
import { DropdownMenu } from "radix-ui"
import { ArrowUpIcon, CopyIcon, DiffIcon, FolderGit2Icon, FolderOpenIcon, GitBranchIcon, SquareArrowOutUpRightIcon, Trash2Icon } from "lucide-react"
import { CheckoutLabel } from "@/components/rail/checkout-label"
import { workspaceName } from "@/lib/format"
import { homeRelative } from "@/lib/skill-matrix"
import { checkoutSentence, followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { desktop } from "@/state/desktop"
import { prefsStore } from "@/state/prefs"
import { useSession } from "@/state/session"
import { removeWorktree, useWorktreeAhead, useWorktrees, worktreeAt } from "@/state/worktrees"

const item = "flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast.error(`The ${what.toLowerCase()} wasn't copied`)
  )
}

/**
 * What the chat on screen has checked out, quiet at the right of its strip.
 * A Thread in its own worktree wears the worktree mark and carries the
 * worktree's controls; any other chat in a checkout shows that checkout's
 * branch. Nothing shows outside a checkout.
 */
export function CheckoutChip({ cwd }: { cwd: string | undefined }) {
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
  const folder = worktree?.path ?? cwd
  useEffect(() => {
    if (folder) followCheckouts([folder])
  }, [folder])
  const head = useCheckoutHead(folder)
  // Counts come from the Git status the Changes watcher keeps, and only when it's this chat's folder's.
  const git = useSession((state) => (cwd && state.git?.cwd === cwd ? state.git : undefined))
  const sinceStart = useWorktreeAhead(worktree?.path, git?.head)
  const changed = git?.files.length
  const ahead = worktree ? sinceStart : git?.upstream ? git.ahead : undefined
  if (!folder || !head) return null
  const where = worktree ? `Worktree of ${workspaceName(worktree.repoRoot)}` : workspaceName(folder)
  const branch = head.kind === "detached" ? undefined : head.name
  const counts = [
    changed ? plural(changed, "changed file", "changed files") : "",
    ahead ? (worktree ? `${plural(ahead, "commit", "commits")} since it started` : `${plural(ahead, "commit", "commits")} to push`) : "",
  ].filter(Boolean).join(" · ")
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-checkout-chip={worktree ? "worktree" : "checkout"}
          aria-label={`${where}, on ${checkoutSentence(head)}${counts ? `, ${counts}` : ""}`}
          className="pressable flex h-6 min-w-0 max-w-[40%] shrink items-center gap-1 rounded-md px-1.5 text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"
        >
          {worktree ? <FolderGit2Icon className="size-3 shrink-0" /> : <GitBranchIcon className="size-3 shrink-0" />}
          <CheckoutLabel head={head} />
          {changed || ahead ? (
            <span data-checkout-counts className="flex shrink-0 items-center gap-1.5 pl-0.5 tabular-nums">
              {changed ? (
                <span className="flex items-center gap-0.5">
                  <DiffIcon className="size-2.5" />
                  {changed}
                </span>
              ) : null}
              {ahead ? (
                <span className="flex items-center gap-0.5">
                  <ArrowUpIcon className="size-2.5" />
                  {ahead}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="overlay-panel z-50 w-72 p-1 text-ui">
          <div className="px-2 pt-1 pb-1.5">
            <p className="truncate text-label text-muted-foreground">{where} · {checkoutSentence(head)}</p>
            {counts ? <p className="truncate text-label text-faint">{counts}</p> : null}
            {/* Right-to-left so a long path gives up its start, not the folder's own name. */}
            <p dir="rtl" className="truncate text-left font-mono text-label text-faint" title={folder}>
              <bdi dir="ltr">{homeRelative(folder)}</bdi>
            </p>
          </div>
          <DropdownMenu.Item className={item} onSelect={() => { void desktop.openInEditor(folder, prefsStore.get().externalEditor) }}>
            <SquareArrowOutUpRightIcon className="size-3.5" />Open in editor
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => { void desktop.revealPath(folder) }}>
            <FolderOpenIcon className="size-3.5" />Show the folder
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => copy(folder, "Path")}>
            <CopyIcon className="size-3.5" />Copy path
          </DropdownMenu.Item>
          {branch ? (
            <DropdownMenu.Item className={item} onSelect={() => copy(branch, "Branch name")}>
              <GitBranchIcon className="size-3.5" />Copy branch name
            </DropdownMenu.Item>
          ) : null}
          {worktree ? (
            <>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-hairline" />
              <DropdownMenu.Item data-checkout-action="remove-worktree" className={item} onSelect={() => { void removeWorktree(worktree) }}>
                <Trash2Icon className="size-3.5" />Remove worktree, keep branch
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
