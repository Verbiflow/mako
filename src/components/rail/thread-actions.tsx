import { useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { ArchiveIcon, ArchiveRestoreIcon, ClipboardCopyIcon, ClipboardListIcon, CopyIcon, FolderOpenIcon, MoreHorizontalIcon, PencilLineIcon, PinIcon, PinOffIcon, SquareIcon, Trash2Icon } from "lucide-react"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { desktop } from "@/state/desktop"
import { threadLifecycle, type ThreadControls, type ThreadTarget } from "@/state/thread-lifecycle"
import { offerWorktreeRemoval, removeWorktree, useWorktrees, worktreeAt } from "@/state/worktrees"
import { discardSessionDraft, useThreadGroups } from "@/state/thread-groups"
import { wholeThreadTargets } from "@/state/session-archive"

export interface ThreadMenuProps {
  target: ThreadTarget
  title: string
  archived: boolean
  running: boolean
  controlled: boolean
  path?: string
  thread?: string
  cwd?: string
  /** Every Session a folded row stands for; archive puts them all away. */
  archiveTargets?: ThreadTarget[]
  pinned?: boolean
  onPin?: () => void
  onRename?: () => void
}

async function stopRun(target: ThreadTarget, known: ThreadControls | null): Promise<void> {
  try {
    const latest = known ?? await threadLifecycle.controls(target)
    if (latest.stop) await threadLifecycle.stop(latest.stop)
    else toast(latest.external ? "This run is controlled by another app" : "There is no running task to stop")
  } catch (error) {
    toast.error("The run could not be stopped", { description: error instanceof Error ? error.message : "Controls are unavailable" })
  }
}

/**
 * What a row's menu knows only while it's open: the run's controls, read
 * when it opens, and a rename waiting for the menu to hand focus back.
 */
function useThreadMenu(props: ThreadMenuProps) {
  const [controls, setControls] = useState<ThreadControls | null>(null)
  const [error, setError] = useState<string | null>(null)
  const renaming = useRef(false)
  return {
    controls,
    error,
    onOpenChange: (open: boolean) => {
      if (!open) { setControls(null); return }
      setError(null)
      void threadLifecycle.controls(props.target).then(setControls).catch((failure) => setError(failure instanceof Error ? failure.message : "Controls are unavailable"))
    },
    rename: () => { renaming.current = true },
    // A rename's field takes focus once the menu has closed, not before, or the menu's own focus return would blur it.
    onCloseAutoFocus: (event: Event) => {
      if (!renaming.current) return
      renaming.current = false
      event.preventDefault()
      props.onRename?.()
    },
  }
}

function ThreadMenuItems({ props, menu }: { props: ThreadMenuProps; menu: ReturnType<typeof useThreadMenu> }) {
  const { target, archived, running, path, thread, cwd, archiveTargets, pinned, onPin, onRename } = props
  const { controls, error } = menu
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
  // An archived row of a Thread whose other Sessions are still out is one Session of it.
  const oneOfMany = useThreadGroups((state) => !archiveTargets && thread !== undefined && state.groups[thread] !== undefined)
  const archive = async () => {
    const restoringOne = archived && oneOfMany
    const targets = restoringOne ? [target] : (thread && wholeThreadTargets(thread)) || archiveTargets || [target]
    // Putting the whole Thread away, with nothing running in it, is when its worktree stops being needed.
    const leftBehind = !archived && !running ? worktree : undefined
    const changed = await threadLifecycle.archive(targets, !archived, !restoringOne && !leftBehind)
    if (changed && restoringOne) toast("Session restored")
    if (changed && leftBehind) offerWorktreeRemoval(leftBehind)
    if (changed && !archived && thread) discardSessionDraft(thread)
  }
  return (
    <>
      {onPin ? (
        <MenuItem onSelect={onPin}>
          {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}{pinned ? "Unpin" : "Pin"}
        </MenuItem>
      ) : null}
      {onRename ? (
        <MenuItem data-thread-action="rename" onSelect={menu.rename}>
          <PencilLineIcon className="size-3.5" />Rename
        </MenuItem>
      ) : null}
      {path ? <>
        <MenuSeparator />
        <MenuItem onSelect={() => { void threadLifecycle.copyTranscript(path, "concise") }}><ClipboardListIcon className="size-3.5" />Copy concise transcript</MenuItem>
        <MenuItem onSelect={() => { void threadLifecycle.copyTranscript(path, "full") }}><ClipboardCopyIcon className="size-3.5" />Copy full transcript</MenuItem>
      </> : null}
      {worktree ? <>
        <MenuSeparator />
        <MenuLabel>Worktree on {worktree.branch}</MenuLabel>
        <MenuItem onSelect={() => { void navigator.clipboard.writeText(worktree.path).then(() => toast("Worktree path copied")) }}><CopyIcon className="size-3.5" />Copy its path</MenuItem>
        <MenuItem onSelect={() => { void desktop.revealPath(worktree.path) }}><FolderOpenIcon className="size-3.5" />Show the folder</MenuItem>
        <MenuItem data-thread-action="remove-worktree" onSelect={() => { void removeWorktree(worktree) }}><Trash2Icon className="size-3.5" />Remove worktree, keep branch</MenuItem>
      </> : null}
      <MenuSeparator />
      {running ? (
        <MenuItem disabled={!controls?.stop} onSelect={() => { void stopRun(target, controls) }}>
          <SquareIcon className="size-3" />{controls?.external ? "Controlled by another app" : "Stop run and pause queue"}
        </MenuItem>
      ) : null}
      <MenuItem data-thread-action="archive" onSelect={() => { void archive() }}>
        {archived ? <ArchiveRestoreIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}
        {archived ? (oneOfMany ? "Restore session" : "Restore thread") : running ? "Archive when finished" : "Archive thread"}
      </MenuItem>
      {error ? <p role="alert" className="max-w-64 px-2 py-1 text-label text-negative">{error}</p> : null}
    </>
  )
}

/** A row's trailing controls: Stop while it runs, and the `…` menu. */
export function ThreadActions(props: ThreadMenuProps) {
  const { target, title, running, controlled } = props
  const menu = useThreadMenu(props)
  const [busy, setBusy] = useState(false)
  const stop = async () => {
    if (busy) return
    setBusy(true)
    await stopRun(target, menu.controls)
    setBusy(false)
  }
  return (
    <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {running && controlled ? <button type="button" aria-label={`Stop ${title}`} title="Stop this run and pause its queue" disabled={busy} onClick={() => { void stop() }} className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"><SquareIcon className="size-2.5 fill-current" strokeWidth={0} /></button> : null}
      <Menu modal={false} onOpenChange={menu.onOpenChange}>
        <MenuTrigger asChild><button type="button" aria-label={`Actions for ${title}`} className="pressable flex size-6 shrink-0 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"><MoreHorizontalIcon className="size-3.5" /></button></MenuTrigger>
        <MenuContent align="end" sideOffset={4} className="min-w-52" onCloseAutoFocus={menu.onCloseAutoFocus}>
          <ThreadMenuItems props={props} menu={menu} />
        </MenuContent>
      </Menu>
    </span>
  )
}

/** Right-click on a row opens the same menu as its `…`, at the pointer. */
export function ThreadContextMenu({ children, ...props }: ThreadMenuProps & { children: ReactNode }) {
  const menu = useThreadMenu(props)
  return (
    <ContextMenu modal={false} onOpenChange={menu.onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <ThreadMenuItems props={props} menu={menu} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
