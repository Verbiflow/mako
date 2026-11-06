import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { inCloud, nativeThreadTarget, threadLifecycle, type ThreadTarget } from "@/state/thread-lifecycle"
import { closeThreadTab, type SessionTab } from "@/state/thread-sessions"

/**
 * The last archive from a tab in this window, still undoable after its toast
 * is gone: from the command palette, until it's undone or another archive
 * takes its place.
 */
let lastUndo: { label: string; run: () => Promise<void> } | null = null

export function hasThreadUndo(): boolean {
  return lastUndo !== null
}

export function threadUndoLabel(): string | undefined {
  return lastUndo?.label
}

export async function undoLastThreadChange(): Promise<void> {
  const undo = lastUndo
  lastUndo = null
  if (undo) await undo.run()
}

function offerUndo(label: string, run: () => Promise<void>, description?: string): void {
  const entry = { label, run }
  lastUndo = entry
  toast(label, {
    description,
    duration: ACTION_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => {
        if (lastUndo === entry) lastUndo = null
        void run()
      },
    },
  })
}

function tabTarget(tab: Extract<SessionTab, { kind: "session" }>): ThreadTarget | null {
  if (tab.ref) return nativeThreadTarget(tab.ref)
  return tab.presence ? { kind: "live", id: tab.presence.key } : null
}

/** Archive a Thread from its tab. Its run keeps going, and the tab beside it takes the screen. */
export async function archiveSessionTab(tab: Extract<SessionTab, { kind: "session" }>): Promise<boolean> {
  const target = tabTarget(tab)
  if (!target) return false
  // One machine runs a cloud Thread, so it's archived whole, from its row: its cloud machine ends with it.
  if (inCloud(target)) {
    toast("A thread in the cloud is archived from its row", { description: "Archive it from the sidebar: its cloud machine ends, and its history is kept." })
    return false
  }
  closeThreadTab(tab)
  if (!(await threadLifecycle.archive([target], true, false))) return false
  const running = tab.presence?.status === "running" || tab.presence?.status === "starting"
  offerUndo("Thread archived", async () => { await threadLifecycle.archive([target], false, false) }, running ? "Its run keeps going." : undefined)
  return true
}
