import { useEffect, useMemo } from "react"
import type { ThreadGroup } from "../../electron/contracts/thread-groups.ts"
import type { PromptAttachment, ThreadRef } from "@/lib/types"
import { harnessLabel } from "@/lib/harness-label"
import { getMako } from "@/lib/bridge"
import { foldRowSession, type FoldRow } from "@/lib/thread-fold"
import { acp, acpStore, activeAcp, useAcp, type AcpState } from "@/state/acp"
import { sameAcpPresence, selectAcpPresence, type AcpPresence } from "@/state/acp-presence"
import { descriptorFor } from "@/state/descriptors"
import { prefsStore } from "@/state/prefs"
import { shallowEqual } from "@/state/store"
import { tabsStore } from "@/state/tabs"
import { toast } from "sonner"
import {
  discardSessionDraft,
  draftHasContent,
  leaveSessionDraft,
  openSessionDraft,
  putSessionDraft,
  rowThread,
  threadGroupsStore,
  useThreadGroups,
  type SessionDraft,
} from "@/state/thread-groups"
import { archivedLive, archivedThread, threadArchiveStore, useThreadArchives } from "@/state/thread-lifecycle"
import type { ThreadsState } from "@/state/thread-state"
import { threadStatus } from "@/state/thread-status"
import { threadsStore } from "@/state/thread-store"
import { threads, useThreads } from "@/state/threads"
import { threadTitle } from "@/state/thread-titles"
import { followCheckouts } from "@/state/checkout-heads"
import { useWorktrees, workingFolder, worktreesStore, type WorktreePlaces } from "@/state/worktrees"

interface LiveSlot {
  key: string
  starting: boolean
  cwd: string
  title?: string
  threadPath?: string
  threadId?: string
  sessionId?: string
}

interface ViewSlot {
  ref: ThreadRef
  viewingPath?: string
}

function liveSlot(state: AcpState): LiveSlot | null {
  const live = activeAcp(state)
  return live
    ? { key: live.key, starting: live.kind === "starting", cwd: live.cwd, title: live.title, threadPath: live.threadPath, threadId: live.threadId, sessionId: live.sessionId }
    : null
}

function viewSlot(state: ThreadsState): ViewSlot | null {
  const ref = state.opening?.ref ?? state.viewing?.ref
  return ref ? { ref, viewingPath: state.viewing?.ref.path } : null
}

/** What the conversation area shows, as a Thread and one of its Sessions. */
export interface OnScreen {
  thread?: string
  session?: string
  draft?: SessionDraft
  cwd?: string
  title?: string
}

/** The same choice `ConversationSurface` makes between the viewer and a live panel. */
function onScreen(view: ViewSlot | null, live: LiveSlot | null, draft: SessionDraft | null, threadOf: Readonly<Record<string, string>>, liveMovedTo: string | undefined, places: WorktreePlaces): OnScreen {
  const viewerShown = view && (!live || view.viewingPath !== live.threadPath || (live.starting && view.viewingPath !== undefined))
  if (viewerShown) {
    const { ref } = view
    const thread = rowThread(ref, threadOf)
    return { thread, session: ref.sessionId, cwd: workingFolder(places, ref), title: prefsStore.get().titleOverrides[ref.path] ?? threadTitle(thread) ?? ref.title }
  }
  if (live) {
    const thread = rowThread(live, threadOf)
    const title = (live.threadPath ? prefsStore.get().titleOverrides[live.threadPath] : undefined) ?? threadTitle(thread) ?? live.title
    const cwd = liveMovedTo ? workingFolder(places, { cwd: live.cwd, currentCwd: liveMovedTo }) : live.cwd
    return { thread, session: live.sessionId, cwd, title }
  }
  if (draft) return { thread: draft.thread, draft, cwd: draft.cwd, title: draft.title }
  return {}
}

/** The folder the harness last recorded for the live conversation, when it isn't where it started. */
function movedTo(state: ThreadsState, live: LiveSlot | null): string | undefined {
  return live?.threadPath ? state.threads.find((ref) => ref.path === live.threadPath)?.currentCwd : undefined
}

export function currentOnScreen(): OnScreen {
  const groups = threadGroupsStore.get()
  const live = liveSlot(acpStore.get())
  return onScreen(viewSlot(threadsStore.get()), live, openSessionDraft(groups), groups.threadOf, movedTo(threadsStore.get(), live), worktreesStore.get())
}

export function useOnScreen(): OnScreen {
  const view = useThreads(viewSlot, shallowEqual)
  const live = useAcp(liveSlot, shallowEqual)
  const liveMovedTo = useThreads((state) => movedTo(state, live))
  const draft = useThreadGroups(openSessionDraft)
  const threadOf = useThreadGroups((state) => state.threadOf)
  const places = useWorktrees((state) => state)
  // Whether the folder a harness moved to is a worktree is read from its checkout.
  const moved = liveMovedTo ?? view?.ref.currentCwd
  useEffect(() => {
    if (moved) followCheckouts([moved])
  }, [moved])
  return onScreen(view, live, draft, threadOf, liveMovedTo, places)
}

/** One tab of a Thread's strip: a Session, or the Thread's new tab. */
export type SessionTab =
  | { kind: "session"; id: string; ref?: ThreadRef; presence?: AcpPresence }
  | { kind: "draft"; id: string; draft: SessionDraft }

/**
 * A Thread's tabs in the Thread's order, the new tab last. A Session with
 * neither a catalog row nor a live conversation has nothing to show and is
 * left out; an empty one is reused by the next new tab. So is an archived
 * one, unless it is the Session on screen. A row that names this Thread
 * before the group's event arrives is shown after the rest.
 */
export function threadSessionTabs(input: {
  thread: string
  group?: ThreadGroup
  refs: readonly ThreadRef[]
  presences: readonly AcpPresence[]
  draft?: SessionDraft
  threadOf?: Readonly<Record<string, string>>
  archived?: ReadonlySet<string>
  shown?: string
}): SessionTab[] {
  const { thread, group, draft, threadOf = {}, archived, shown } = input
  const grouped = new Set<string>(group?.sessions.map((session) => session.id))
  const belongs = (row: { threadId?: string; sessionId?: string }) =>
    (row.sessionId !== undefined && grouped.has(row.sessionId)) || rowThread(row, threadOf) === thread
  const refs = new Map<string, ThreadRef>()
  const presences = new Map<string, AcpPresence>()
  const order = [...grouped]
  for (const ref of input.refs) {
    if (!ref.sessionId || refs.has(ref.sessionId) || !belongs(ref)) continue
    if (archived && ref.sessionId !== shown && archivedThread(ref, archived)) continue
    refs.set(ref.sessionId, ref)
    if (!grouped.has(ref.sessionId)) order.push(ref.sessionId)
  }
  for (const presence of input.presences) {
    if (!presence.sessionId || presences.has(presence.sessionId) || !belongs(presence)) continue
    if (archived && presence.sessionId !== shown && archivedLive(presence, archived)) continue
    presences.set(presence.sessionId, presence)
    if (!grouped.has(presence.sessionId) && !refs.has(presence.sessionId)) order.push(presence.sessionId)
  }
  const tabs = order.flatMap((id): SessionTab[] => {
    const ref = refs.get(id)
    const presence = presences.get(id)
    return ref || presence ? [{ kind: "session", id, ref, presence }] : []
  })
  // Once its Session is starting, the new tab is that Session's tab.
  if (draft && !(draft.session && tabs.some((tab) => tab.id === draft.session)))
    tabs.push({ kind: "draft", id: draft.id, draft })
  return tabs
}

/** The Thread on screen as tabs: its Sessions in order, then its new tab. */
export function useThreadTabs(here: OnScreen): SessionTab[] {
  const { thread, session: shown } = here
  const group = useThreadGroups((state) => (thread ? state.groups[thread] : undefined))
  const draft = useThreadGroups((state) => (thread ? state.drafts[thread] : undefined))
  const threadOf = useThreadGroups((state) => state.threadOf)
  const archived = useThreadArchives((state) => state.keys)
  const refs = useThreads((state) => state.threads)
  const presences = useAcp(selectAcpPresence, sameAcpPresence)
  return useMemo(
    () => (thread ? threadSessionTabs({ thread, group, refs, presences, draft, threadOf, archived, shown }) : []),
    [thread, group, refs, presences, draft, threadOf, archived, shown]
  )
}

export function currentThreadTabs(thread: string): SessionTab[] {
  const groups = threadGroupsStore.get()
  return threadSessionTabs({
    thread,
    group: groups.groups[thread],
    refs: threadsStore.get().threads,
    presences: selectAcpPresence(acpStore.get()),
    draft: groups.drafts[thread],
    threadOf: groups.threadOf,
    archived: threadArchiveStore.get().keys,
    shown: currentOnScreen().session,
  })
}

/** The tab on screen: the new tab by its draft, any other by its Session. */
export function onScreenTab(here: OnScreen): string | undefined {
  return here.draft ? here.draft.id : here.session
}

export function sessionTabTitle(tab: SessionTab, overrides: Readonly<Record<string, string>>): string {
  if (tab.kind === "draft") return "New session"
  const path = tab.ref?.path ?? tab.presence?.threadPath
  const harness = tab.presence?.harness ?? tab.ref?.harness
  return (path ? overrides[path] : undefined) ?? tab.presence?.title ?? tab.ref?.title ?? (harness ? harnessLabel(harness) : "Untitled session")
}

function showDraft(draft: SessionDraft): void {
  const harness = draft.harness ?? threadsStore.get().composerHarness
  acp.deactivate()
  threads.closeViewer()
  // Closing the viewer puts back the agent chosen before it opened; the new
  // tab keeps its own pick, else the agent of the Session you were on.
  threadsStore.set({ composerHarness: harness })
  putSessionDraft(draft, true)
  window.dispatchEvent(new CustomEvent("mako:focus-composer"))
}

export function openSessionTab(tab: SessionTab): void {
  const here = currentOnScreen()
  if (tab.id === onScreenTab(here)) return
  if (tab.kind === "draft") {
    showDraft(tab.draft)
    return
  }
  const { ref, presence } = tab
  const owns = presence && ref && (presence.threadPath === ref.path || presence.nativePaths?.includes(ref.path))
  if (ref && (!presence || owns)) void threads.view(ref)
  else if (presence) acp.activate(presence.key)
}

/**
 * Open the Thread's new tab: the one it already has, else a fresh one that
 * reuses an empty Session left by a start that failed. Nothing is created
 * until the first message is sent.
 */
export function newSessionInThread(): boolean {
  const here = currentOnScreen()
  if (!here.thread) return false
  if (here.draft) {
    window.dispatchEvent(new CustomEvent("mako:focus-composer"))
    return true
  }
  const { drafts, groups } = threadGroupsStore.get()
  const empty = groups[here.thread]?.sessions.find((session) => !session.started)
  showDraft(drafts[here.thread] ?? {
    id: crypto.randomUUID(),
    thread: here.thread,
    cwd: here.cwd ?? "",
    title: here.title ?? "this Thread",
    session: empty?.id,
  })
  return true
}

/**
 * Close the new tab on screen and go back to the Session last shown in its
 * Thread. Unsent text stays under the Thread, so the next new tab has it.
 */
export function closeSessionDraft(): boolean {
  const { draft } = currentOnScreen()
  if (!draft) return false
  const kept = draftHasContent(draft)
  discardSessionDraft(draft.thread)
  const tabs = currentThreadTabs(draft.thread)
  const last = threadGroupsStore.get().lastViewed[draft.thread]
  const back = tabs.find((tab) => tab.id === last) ?? tabs.at(-1)
  if (back) openSessionTab(back)
  if (kept) toast("Draft put away. A new tab in this Thread brings it back.")
  return true
}

/** Close a Thread's new tab from its ×, on screen or not. */
export function closeDraftTab(draft: SessionDraft): void {
  if (currentOnScreen().draft?.id === draft.id) {
    closeSessionDraft()
    return
  }
  const kept = draftHasContent(draft)
  discardSessionDraft(draft.thread)
  if (kept) toast("Draft put away. A new tab in this Thread brings it back.")
}

/** Step through the Thread's tabs; false when the Thread on screen has one. */
export function stepThreadSession(delta: 1 | -1): boolean {
  const here = currentOnScreen()
  if (!here.thread) return false
  const tabs = currentThreadTabs(here.thread)
  if (tabs.length < 2) return false
  const index = tabs.findIndex((tab) => tab.id === onScreenTab(here))
  const next = tabs[(index + delta + tabs.length) % tabs.length]
  if (next) openSessionTab(next)
  return true
}

export function threadHasTabs(): boolean {
  const { thread } = currentOnScreen()
  return thread !== undefined && currentThreadTabs(thread).length > 1
}

/** A folded rail row: the Session you last had open, else the first with news, else the lead. */
export function openFoldedThread(thread: string, members: readonly FoldRow[]): void {
  const last = threadGroupsStore.get().lastViewed[thread]
  const state = threadsStore.get()
  const target =
    members.find((row) => foldRowSession(row) === last) ??
    members.find((row) => {
      if (row.kind === "live") return row.presence.status === "failed" || row.presence.status === "needs-permission"
      const status = threadStatus(row.ref, state)
      return status.kind === "needs-permission" || status.kind === "failed" || (status.kind === "review" && status.unread)
    }) ??
    members[0]
  if (!target) return
  if (target.kind === "native") void threads.view(target.ref)
  else acp.activate(target.presence.key)
}

/**
 * Send the new tab's first message. The Session is created under the tab's
 * ID, so a retry after an unknown outcome finds the same Session. A start
 * that fails brings the tab back with the message restored.
 */
export async function startInThread(draft: SessionDraft, harness: string, prompt: string, attachments: PromptAttachment[]): Promise<boolean> {
  if (descriptorFor(threadsStore.get(), harness)?.live !== true)
    throw new Error(`${harnessLabel(harness)} can't start a session inside a Thread. Pick another agent; your message is kept.`)
  const session = draft.session ?? (await getMako().threadCreateSession(draft.id, draft.thread)).session
  const placed = { ...draft, session, harness }
  putSessionDraft(placed, false)
  const started = await acp.startFresh(harness, draft.cwd, prompt, attachments, prompt, undefined, { thread: draft.thread, session })
  if (started) discardSessionDraft(draft.thread)
  else if (!activeAcp(acpStore.get()) && !viewSlot(threadsStore.get())) showDraft(placed)
  else putSessionDraft(placed, false)
  return started
}

/**
 * Keep the Thread bookkeeping in step with the screen: remember the Session
 * last shown in each Thread, and put the new tab away once anything else
 * takes its place, including a switch between attached sessions.
 */
export function watchThreadSessions(): () => void {
  let attached = tabsStore.get().activeId
  const sync = () => {
    const view = viewSlot(threadsStore.get())
    const live = liveSlot(acpStore.get())
    const switched = tabsStore.get().activeId !== attached
    attached = tabsStore.get().activeId
    if (threadGroupsStore.get().open !== null && (view || live || switched)) leaveSessionDraft()
    const { groups, lastViewed, threadOf } = threadGroupsStore.get()
    const here = onScreen(view, live, null, threadOf, undefined, worktreesStore.get())
    if (here.thread && here.session && groups[here.thread] && lastViewed[here.thread] !== here.session)
      threadGroupsStore.set({ lastViewed: { ...lastViewed, [here.thread]: here.session } })
  }
  const stops = [threadsStore.subscribe(sync), acpStore.subscribe(sync), threadGroupsStore.subscribe(sync), tabsStore.subscribe(sync)]
  sync()
  return () => stops.forEach((stop) => stop())
}
