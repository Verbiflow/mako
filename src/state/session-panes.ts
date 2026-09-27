import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { z } from "zod"
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
import { AGENT_TAB_ID, viewer, viewerStore, type PaneSession, type PaneSide, type ViewerState } from "@/state/viewer"

/**
 * Two chats side by side. Each pane shows one Session; the focused one is
 * the window's active conversation and has the composer, the other keeps
 * streaming from its own binding. A split is a view: the Thread's tabs and
 * membership don't change.
 */

function same(left: PaneSession | undefined, right: PaneSession | undefined): boolean {
  return left?.thread === right?.thread && left?.tab === right?.tab
}

/** The Session the window shows now: the focused pane's. */
export function onScreenSession(): PaneSession | undefined {
  const here = currentOnScreen()
  const tab = onScreenTab(here)
  return here.thread && tab ? { thread: here.thread, tab } : undefined
}

export function tabFor(session: PaneSession): SessionTab | undefined {
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

/**
 * Open a Session tab in a pane on `side` of the workbench, or in the pane
 * already there. `shown` is what the focused pane showed before the press
 * that started this: a sidebar row opens its Thread on press, and the drag
 * that follows puts that Thread beside what was there, not over it.
 */
export function openInPane(tab: SessionTab, thread: string, side: PaneSide, shown?: PaneSession): boolean {
  const state = viewerStore.get()
  const session = { thread, tab: tab.id }
  const focusedShows = shown ?? onScreenSession()
  if (state.panes.length === 1) {
    const [only] = state.panes
    if (!same(focusedShows, session)) {
      const added = viewer.openAgentPane(side, session)
      if (!added) return false
      // A dragged sidebar row is already the active conversation; focus follows it.
      apply({ [only.id]: focusedShows, [added]: session }, shown ? added : only.id)
      return true
    }
    // The tab on screen moves to the new pane; this one shows its neighbour.
    const tabs = currentThreadTabs(thread)
    const at = tabs.findIndex((candidate) => candidate.id === tab.id)
    const neighbour = tabs[at + 1] ?? tabs[at - 1]
    if (!neighbour) {
      toast("This thread has one session", { description: "Drag another thread here from the sidebar to see both." })
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
  const otherShows = other.id === state.focusedPaneId ? focusedShows : other.session
  const targetShows = target.id === state.focusedPaneId ? focusedShows : target.session
  apply({ [target.id]: session, [other.id]: same(otherShows, session) ? targetShows : otherShows }, target.id)
  return true
}

/** Split the chat: the Session on screen moves to a new pane on the right. */
export function splitOnScreenSession(): boolean {
  const here = onScreenSession()
  const tab = here && tabFor(here)
  return Boolean(here && tab && openInPane(tab, here.thread, viewerStore.get().split === "down" ? "down" : "right"))
}

/** The chat panes, in order; empty while the chat has only one. */
export function chatPanes(): string[] {
  const { panes } = viewerStore.get()
  const chats = panes.filter((pane) => pane.tabIds.includes(AGENT_TAB_ID)).map((pane) => pane.id)
  return chats.length > 1 ? chats : []
}

/** When a press on a chat pane's resting composer asked for the caret; the composer that mounts next takes it. */
let composerFocusAsked = 0
const COMPOSER_FOCUS_FRESH_MS = 1_000

/** Focus a chat pane and put the caret in the composer that mounts there. */
export function engageWorkbenchPane(paneId: string): void {
  composerFocusAsked = performance.now()
  focusWorkbenchPane(paneId)
}

/** Whether a newly mounted composer should take the caret; true once per press. */
export function takeComposerFocus(): boolean {
  const asked = composerFocusAsked
  composerFocusAsked = 0
  return asked > 0 && performance.now() - asked < COMPOSER_FOCUS_FRESH_MS
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
  const stopLayout = keepPaneLayout()
  return () => {
    for (const stop of stops) stop()
    stopLayout()
  }
}

/**
 * The chat survives a reload of its window: what each pane shows is kept per
 * window (`sessionStorage`) and put back once its Session is known. A live
 * conversation comes back on its own (`live-recovery.ts`); this brings back
 * a Thread you were reading, and the pane beside it.
 */
const LAYOUT_KEY = "mako:chat-panes"
const PaneSessionSchema = z.object({ thread: z.string(), tab: z.string() })
const SavedLayoutSchema = z.object({
  focused: PaneSessionSchema.optional(),
  resting: z.object({ split: z.enum(["right", "down"]), first: z.boolean(), session: PaneSessionSchema }).optional(),
})
type SavedLayout = z.infer<typeof SavedLayoutSchema>

function layoutOf(state: ViewerState): SavedLayout {
  const chats = state.panes.filter((pane) => pane.tabIds.includes(AGENT_TAB_ID))
  const resting = state.panes.length === 2 && chats.length === 2 ? chats.find((pane) => pane.id !== state.focusedPaneId) : undefined
  return {
    focused: acpStore.get().activeKey ? undefined : onScreenSession(),
    resting: resting?.session && { split: state.split, first: state.panes[0]?.id === resting.id, session: resting.session },
  }
}

function savedLayout(): SavedLayout {
  try {
    const parsed = SavedLayoutSchema.safeParse(JSON.parse(globalThis.sessionStorage?.getItem(LAYOUT_KEY) ?? "null"))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/** Whether `session` can be shown yet; false once it is known to be gone. */
function arrived(session: PaneSession): boolean | "gone" {
  if (tabFor(session)) return true
  return threadsStore.get().loaded && threadGroupsStore.get().groups[session.thread] ? "gone" : false
}

function keepPaneLayout(): () => void {
  let { focused, resting } = savedLayout()
  let written = focused || resting ? JSON.stringify({ focused, resting }) : ""
  const restore = () => {
    // Anything you open first wins over what the window showed before.
    if (focused && (onScreenSession() || acpStore.get().activeKey || threadsStore.get().opening)) focused = undefined
    if (resting && viewerStore.get().panes.length > 1) resting = undefined
    if (focused) {
      const state = arrived(focused)
      const tab = state === true ? tabFor(focused) : undefined
      if (state === "gone") focused = undefined
      if (tab) {
        focused = undefined
        openSessionTab(tab)
      }
    }
    if (resting) {
      const state = arrived(resting.session)
      if (state === "gone") resting = undefined
      if (state !== true || !resting) return
      const { session, split, first } = resting
      resting = undefined
      if (same(onScreenSession(), session)) return
      const [only] = viewerStore.get().panes
      const added = viewer.openAgentPane(split === "right" ? (first ? "left" : "right") : first ? "up" : "down", session)
      if (added && only) apply({ [only.id]: undefined, [added]: session }, only.id)
    }
  }
  // Recomputed only when what's on screen or the panes change, never per token.
  let seen = ""
  let seenViewer: ViewerState | undefined
  const save = () => {
    if (focused || resting) return
    const threads = threadsStore.get()
    const signature = `${threads.opening?.ref.path ?? threads.viewing?.ref.path ?? ""}\n${acpStore.get().activeKey ?? ""}\n${threadGroupsStore.get().open ?? ""}`
    const state = viewerStore.get()
    if (signature === seen && state === seenViewer) return
    seen = signature
    seenViewer = state
    const layout = layoutOf(state)
    const next = layout.focused || layout.resting ? JSON.stringify(layout) : ""
    if (next === written) return
    written = next
    if (next) globalThis.sessionStorage?.setItem(LAYOUT_KEY, next)
    else globalThis.sessionStorage?.removeItem(LAYOUT_KEY)
  }
  const update = () => {
    restore()
    save()
  }
  const stops = [viewerStore, threadsStore, threadGroupsStore, acpStore].map((store) => store.subscribe(update))
  restore()
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
  const bound = Boolean(session)
  // The tab's kind, not the tab: its presence changes as the agent works, and
  // a new scope object re-renders the whole transcript under it.
  const tabKind = tab?.kind
  return useMemo((): ConversationScope | null => {
    if (!bound) return null
    if (!tabKind) return { kind: "missing" }
    if (tabKind === "draft") return { kind: "draft", title: draftTitle }
    if (liveKey) return { kind: "live", key: liveKey }
    if (ref) return { kind: "history", ref, thread }
    return { kind: "missing" }
  }, [bound, tabKind, draftTitle, liveKey, ref, thread])
}
