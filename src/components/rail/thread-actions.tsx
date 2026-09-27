import { useState } from "react"
import { toast } from "sonner"
import { DropdownMenu } from "radix-ui"
import { ArchiveIcon, ArchiveRestoreIcon, ClipboardCopyIcon, ClipboardListIcon, CopyIcon, FolderOpenIcon, ListPlusIcon, MoreHorizontalIcon, SquareIcon, Trash2Icon } from "lucide-react"
import { desktop } from "@/state/desktop"
import { threadLifecycle, type ThreadControls, type ThreadTarget } from "@/state/thread-lifecycle"
import { offerWorktreeRemoval, removeWorktree, useWorktrees, worktreeAt } from "@/state/worktrees"
import { discardSessionDraft, useThreadGroups } from "@/state/thread-groups"
import { openAddToThread, rowSessions } from "@/state/thread-regroup"

export function ThreadActions({ target, title, archived, running, controlled, path, thread, session, cwd, archiveTargets }: {
  target: ThreadTarget
  title: string
  archived: boolean
  running: boolean
  controlled: boolean
  path?: string
  thread?: string
  /** The row's own Session; with `thread`, what "Add to thread…" takes along. */
  session?: string
  cwd?: string
  /** Every Session a folded row stands for; archive puts them all away. */
  archiveTargets?: ThreadTarget[]
}) {
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
  // An archived row of a Thread whose other Sessions are still out is one Session of it.
  const oneOfMany = useThreadGroups((state) => !archiveTargets && thread !== undefined && state.groups[thread] !== undefined)
  const archive = async () => {
    const restoringOne = archived && oneOfMany
    // Putting the whole Thread away, with nothing running in it, is when its worktree stops being needed.
    const leftBehind = !archived && !running && !oneOfMany ? worktree : undefined
    const changed = await threadLifecycle.archive(archiveTargets ?? [target], !archived, !restoringOne && !leftBehind)
    if (changed && restoringOne) toast("Session restored")
    if (changed && leftBehind) offerWorktreeRemoval(leftBehind)
    if (changed && !archived && thread) discardSessionDraft(thread)
  }
  const [busy, setBusy] = useState(false)
  const [controls, setControls] = useState<ThreadControls | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stop = async () => {
    if (busy) return
    setBusy(true)
    try {
      const latest = controls ?? await threadLifecycle.controls(target)
      if (latest.stop) await threadLifecycle.stop(latest.stop)
      else toast(latest.external ? "This run is controlled by another app" : "There is no running task to stop")
    } catch (error) { toast.error("The run could not be stopped", { description: error instanceof Error ? error.message : "Controls are unavailable" }) }
    finally { setBusy(false) }
  }
  return (
    <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {running && controlled ? <button type="button" aria-label={`Stop ${title}`} title="Stop this run and pause its queue" disabled={busy} onClick={() => { void stop() }} className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"><SquareIcon className="size-2.5 fill-current" strokeWidth={0} /></button> : null}
      <DropdownMenu.Root modal={false} onOpenChange={(open) => {
        if (!open) { setControls(null); return }
        setError(null)
        void threadLifecycle.controls(target).then(setControls).catch((error) => setError(error instanceof Error ? error.message : "Controls are unavailable"))
      }}>
        <DropdownMenu.Trigger asChild><button type="button" aria-label={`Actions for ${title}`} className="pressable flex size-6 shrink-0 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"><MoreHorizontalIcon className="size-3.5" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className="overlay-panel z-50 min-w-48 rounded-lg p-1 text-ui">
          <DropdownMenu.Item disabled={busy || !controls?.stop} onSelect={() => { void stop() }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover data-[disabled]:text-faint"><SquareIcon className="size-3" />{controls?.external ? "Controlled by another app" : "Stop run and pause queue"}</DropdownMenu.Item>
          <DropdownMenu.Item data-thread-action="archive" onSelect={() => { void archive() }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover">{archived ? <ArchiveRestoreIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}{archived ? (oneOfMany ? "Restore session" : "Restore thread") : running ? "Archive when finished" : "Archive thread"}</DropdownMenu.Item>
          {thread && !archived ? (
            <DropdownMenu.Item
              data-thread-action="add-to-thread"
              disabled={!rowSessions(thread, session).length}
              onSelect={() => openAddToThread({ sessions: rowSessions(thread, session), from: thread, title, cwd })}
              className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover data-[disabled]:text-faint"
            >
              <ListPlusIcon className="size-3.5" />Add to thread…
            </DropdownMenu.Item>
          ) : null}
          {path ? <>
            <DropdownMenu.Item onSelect={() => { void threadLifecycle.copyTranscript(path, "concise") }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"><ClipboardListIcon className="size-3.5" />Copy concise transcript</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => { void threadLifecycle.copyTranscript(path, "full") }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"><ClipboardCopyIcon className="size-3.5" />Copy full transcript</DropdownMenu.Item>
          </> : null}
          {worktree ? <>
            <DropdownMenu.Separator className="mx-1 my-1 h-px bg-hairline" />
            <DropdownMenu.Label className="truncate px-2 py-1 text-label text-faint">Worktree on {worktree.branch}</DropdownMenu.Label>
            <DropdownMenu.Item onSelect={() => { void navigator.clipboard.writeText(worktree.path).then(() => toast("Worktree path copied")) }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"><CopyIcon className="size-3.5" />Copy its path</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => { void desktop.revealPath(worktree.path) }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"><FolderOpenIcon className="size-3.5" />Show the folder</DropdownMenu.Item>
            <DropdownMenu.Item data-thread-action="remove-worktree" onSelect={() => { void removeWorktree(worktree) }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"><Trash2Icon className="size-3.5" />Remove worktree, keep branch</DropdownMenu.Item>
          </> : null}
          {error ? <p role="alert" className="max-w-64 px-2 py-1 text-label text-negative">{error}</p> : null}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  )
}
