import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import type { ThreadRef } from "@/lib/types"
import { acpStore, useAcp } from "@/state/acp"
import type { ConversationScope } from "@/state/conversation-scope"
import { hydrateLive } from "@/state/live-recovery"
import { threadGroupsStore } from "@/state/thread-groups"
import {
  currentOnScreen,
  currentThreadTabs,
  onScreenTab,
  openSessionTab,
  useThreadTabs,
  type SessionTab,
} from "@/state/thread-sessions"
import type { ViewedThread } from "@/state/thread-state"
import { threadsStore } from "@/state/thread-store"
import { readThreadForPane, rememberedThread } from "@/state/thread-viewing"
import { AGENT_TAB_ID, viewer, viewerStore, type PaneSession, type PaneSide } from "@/state/viewer"

/**
 * Two chats side by side. Each pane shows one Session; the focused one is
 * the window's active conversation and has the composer, the other keeps
 * streaming from its own binding. A split is a view: the Thread's tabs and
 * membership don't change.
 */

function same(left: PaneSession | undefined, right: PaneSession | undefined): boolean {
  return left?.thread === right?.thread && left?.tab === right?.tab
}

function onScreenSession(): PaneSession | undefined {
  const here = currentOnScreen()
  const tab = onScreenTab(here)
  return here.thread && tab ? { thread: here.thread, tab } : undefined
}

function tabFor(session: PaneSession): SessionTab | undefined {
  return currentThreadTabs(session.thread).find((tab) => tab.id === session.tab)
}

/**
 * Give each pane its Session and focus one. The focused pane's Session
 * becomes the active conversation; until it has, that pane keeps showing it
 * from its binding, so nothing flashes in between.
 */
function apply(sessions: Record<string, PaneSession | undefined>, focus: string): void {
  const target = sessions[focus]
  const from = onScreenSession()
  const settled = !target || same(from, target)
  const tab = target && !settled ? tabFor(target) : undefined
  pendingFrom = tab ? from : undefined
  viewer.bindPanes({ ...sessions, [focus]: tab ? target : undefined }, focus)
  if (tab) openSessionTab(tab)
}

/** What was on screen when the focused pane's binding was set, while it waits to become active. */
let pendingFrom: PaneSession | undefined

/** Open a tab in its pane. With one pane this is opening the tab. */
export function openTabInPane(paneId: string, thread: string | undefined, tab: SessionTab): void {
  const state = viewerStore.get()
  if (state.panes.length === 1 || !thread) {
    viewer.activate(paneId, AGENT_TAB_ID)
    openSessionTab(tab)
    return
  }
  apply({ [paneId]: { thread, tab: tab.id } }, paneId)
}

/** Open a Session tab in a pane on `side` of the workbench, or in the pane already there. */
export function openInPane(tab: SessionTab, thread: string, side: PaneSide): boolean {
  const state = viewerStore.get()
  const session = { thread, tab: tab.id }
  if (state.panes.length === 1) {
    const [only] = state.panes
    const here = onScreenSession()
    if (!same(here, session)) {
      const added = viewer.openAgentPane(side, session)
      if (!added) return false
      apply({ [only.id]: here, [added]: session }, only.id)
      return true
    }
    // The tab on screen moves to the new pane; this one shows its neighbour.
    const tabs = currentThreadTabs(thread)
    const at = tabs.findIndex((candidate) => candidate.id === tab.id)
    const neighbour = tabs[at + 1] ?? tabs[at - 1]
    if (!neighbour) {
      toast("This thread has one session", { description: "Open another thread, then drag this tab beside it." })
      return false
    }
    const added = viewer.openAgentPane(side, session)
    if (!added) return false
    apply({ [only.id]: { thread, tab: neighbour.id }, [added]: session }, added)
    return true
  }
  const [first, second] = state.panes
  const target = side === "left" || side === "up" ? first : second
  const other = target === first ? second : first
  const otherShows = other.id === state.focusedPaneId ? onScreenSession() : other.session
  const targetShows = target.id === state.focusedPaneId ? onScreenSession() : target.session
  apply({ [target.id]: session, [other.id]: same(otherShows, session) ? targetShows : otherShows }, target.id)
  return true
}

/** Focus a pane. Pressing in a chat without focus makes its Session the active conversation. */
export function focusWorkbenchPane(paneId: string): void {
  const state = viewerStore.get()
  if (state.focusedPaneId === paneId) return
  const pane = state.panes.find((candidate) => candidate.id === paneId)
  if (!pane) return
  if (!pane.session || pane.activeId !== AGENT_TAB_ID) {
    viewer.focusPane(paneId)
    return
  }
  const focused = state.panes.find((candidate) => candidate.id === state.focusedPaneId)
  const leaving = focused && !focused.session && focused.tabIds.includes(AGENT_TAB_ID) ? { [focused.id]: onScreenSession() } : {}
  apply({ ...leaving, [paneId]: pane.session }, paneId)
}

/** Close a pane; the one left shows what it showed and takes focus. */
export function closeWorkbenchPane(paneId: string): void {
  const state = viewerStore.get()
  const remaining = state.panes.find((candidate) => candidate.id !== paneId)
  viewer.closePane(paneId)
  if (remaining?.session) apply({ [remaining.id]: remaining.session }, remaining.id)
}

/**
 * Drop a pane's binding once the active conversation is the Session it
 * named, and drop a binding whose Session is gone, so the focused pane
 * follows the rail again.
 */
export function watchSessionPanes(): () => void {
  const settle = () => {
    const state = viewerStore.get()
    const focused = state.panes.find((pane) => pane.id === state.focusedPaneId)
    if (!focused?.session) return
    const now = onScreenSession()
    // Arrived, gone, or you went somewhere else meanwhile (a rail click).
    if (same(now, focused.session) || !tabFor(focused.session) || (now && !same(now, pendingFrom))) {
      pendingFrom = undefined
      viewer.bindPanes({ [focused.id]: undefined }, focused.id)
    }
  }
  const stops = [viewerStore, threadsStore, acpStore, threadGroupsStore].map((store) => store.subscribe(settle))
  return () => {
    for (const stop of stops) stop()
  }
}

/** A transcript for a pane without focus: the last read now, a fresh one when its record changes. */
function usePaneThread(ref: ThreadRef | undefined): ViewedThread | null {
  const path = ref?.path
  const version = ref ? `${ref.path}\n${ref.revision ?? ""}\n${ref.bytes ?? ""}\n${ref.updatedAt}` : ""
  const [read, setRead] = useState<ViewedThread | null>(null)
  useEffect(() => {
    if (!path) return
    let current = true
    readThreadForPane(path)
      .then((thread) => {
        if (current && thread) setRead(thread)
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [path, version])
  if (!path) return null
  return read?.ref.path === path ? read : (rememberedThread(path) ?? null)
}

/** What a pane's chat reads: null for the active conversation, else its bound Session. */
export function usePaneScope(session: PaneSession | undefined): ConversationScope | null {
  const tabs = useThreadTabs(session ? { thread: session.thread, session: session.tab } : {})
  const tab = session ? tabs.find((candidate) => candidate.id === session.tab) : undefined
  const liveKey = tab?.kind === "session" ? tab.presence?.key : undefined
  const projected = useAcp((state) => (liveKey ? Boolean(state.conversations[liveKey]?.projection) : false))
  const ref = tab?.kind === "session" && !liveKey ? tab.ref : undefined
  const thread = usePaneThread(ref)
  useEffect(() => {
    if (liveKey && !projected) void hydrateLive(liveKey, true)
  }, [liveKey, projected])
  const draftTitle = tab?.kind === "draft" ? tab.draft.title : undefined
  return useMemo((): ConversationScope | null => {
    if (!session) return null
    if (!tab) return { kind: "missing" }
    if (tab.kind === "draft") return { kind: "draft", title: draftTitle }
    if (liveKey) return { kind: "live", key: liveKey }
    if (ref) return { kind: "history", ref, thread }
    return { kind: "missing" }
  }, [session, tab, draftTitle, liveKey, ref, thread])
}
