import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { selectAcpPresence } from "@/state/acp-presence"
import { acpStore } from "@/state/acp-state"
import { threadGroupsStore } from "@/state/thread-groups"
import { nativeThreadTarget, threadLifecycle, type ThreadTarget } from "@/state/thread-lifecycle"
import { currentOnScreen, currentThreadTabs, openSessionTab, type SessionTab } from "@/state/thread-sessions"
import { threadsStore } from "@/state/threads"

/**
 * What archiving a Thread with several Sessions acts on: every Session with
 * a row in the catalog or a live conversation, found in the whole list, not
 * the rows a filter or search left showing.
 */
export function wholeThreadTargets(thread: string): ThreadTarget[] | undefined {
  const group = threadGroupsStore.get().groups[thread]
  if (!group) return undefined
  const refs = threadsStore.get().threads
  const live = selectAcpPresence(acpStore.get())
  const targets = new Map<string, ThreadTarget>()
  for (const member of group.sessions) {
    const ref = refs.find((entry) => entry.sessionId === member.id)
    const presence = ref ? undefined : live.find((entry) => entry.sessionId === member.id)
    const target: ThreadTarget | undefined = ref ? nativeThreadTarget(ref) : presence && { kind: "live", id: presence.key }
    if (target) targets.set(JSON.stringify(target), target)
  }
  return targets.size ? [...targets.values()] : undefined
}

/**
 * The last Session archive in this window, still undoable after its toast
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

/**
 * Archive one Session of a Thread from its tab. Its run keeps going. The
 * Thread's other tabs stay, and the one on screen hands over to its
 * neighbour first.
 */
export async function archiveSessionTab(tab: Extract<SessionTab, { kind: "session" }>, thread: string): Promise<boolean> {
  const target = tabTarget(tab)
  if (!target) return false
  const here = currentOnScreen()
  if (here.session === tab.id) {
    const sessions = currentThreadTabs(thread).filter((candidate) => candidate.kind === "session")
    const at = sessions.findIndex((candidate) => candidate.id === tab.id)
    const neighbour = sessions[at + 1] ?? sessions[at - 1]
    if (neighbour) openSessionTab(neighbour)
  }
  if (!(await threadLifecycle.archive([target], true, false))) return false
  const running = tab.presence?.status === "running" || tab.presence?.status === "starting"
  offerUndo("Session archived", async () => { await threadLifecycle.archive([target], false, false) }, running ? "Its run keeps going." : undefined)
  return true
}
