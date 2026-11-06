import { useEffect, useMemo, useState } from "react"
import type { OpenedBy, SessionFacts, SessionState } from "@mako/host/contracts/session-choice"
import { laterPrompt } from "@mako/host/contracts/worked-at"
import type { PromptAttachment, ThreadRef } from "@/lib/types"
import { harnessLabel } from "@/lib/harness-label"
import { getMako } from "@/lib/bridge"
import { acp, acpStore, activeAcp, useAcp, type AcpState, type StartFirst } from "@/state/acp"
import { sameAcpPresence, selectAcpPresence, type AcpPresence } from "@/state/acp-presence"
import { descriptorFor } from "@/state/descriptors"
import { prefsStore } from "@/state/prefs"
import { shallowEqual } from "@/state/store"
import { tabsStore } from "@/state/tabs"
import { toast } from "sonner"
import { closeEntries, draftBecameThread, entryKey, openTabsStore, showInTabs, useOpenEntries, type OpenEntry } from "@/state/open-tabs"
import {
  discardSessionDraft,
  draftHasContent,
  leaveSessionDraft,
  openSessionDraft,
  putSessionDraft,
  rowStarted,
  threadDraftsStore,
  useThreadDrafts,
  type SessionDraft,
} from "@/state/thread-drafts"
import { archivedLive, archivedThread, threadArchiveStore, useThreadArchives } from "@/state/thread-lifecycle"
import type { ThreadsState } from "@/state/thread-state"
import { threadsStore } from "@/state/thread-store"
import { threads, useThreads } from "@/state/threads"
import { threadTitle } from "@/state/thread-titles"
import { followCheckouts } from "@/state/checkout-heads"
import { useWorktrees, workingFolder, worktreesStore, type WorktreePlaces } from "@/state/worktrees"
import { openConversation, windowRoutesStore } from "@/state/window-routes"

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

/** What the conversation area shows, as a Thread and its conversation. */
export interface OnScreen {
  thread?: string
  session?: string
  draft?: SessionDraft
  cwd?: string
  title?: string
}

/** The same choice `ConversationSurface` makes between the viewer and a live panel. */
function onScreen(view: ViewSlot | null, live: LiveSlot | null, draft: SessionDraft | null, liveMovedTo: string | undefined, places: WorktreePlaces): OnScreen {
  const viewerShown = view && (!live || view.viewingPath !== live.threadPath || (live.starting && view.viewingPath !== undefined))
  if (viewerShown) {
    const { ref } = view
    const thread = ref.threadId
    return { thread, session: ref.sessionId, cwd: workingFolder(places, ref), title: prefsStore.get().titleOverrides[ref.path] ?? threadTitle(thread) ?? ref.title }
  }
  if (live) {
    const thread = live.threadId
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
  const live = liveSlot(acpStore.get())
  return onScreen(viewSlot(threadsStore.get()), live, openSessionDraft(threadDraftsStore.get()), movedTo(threadsStore.get(), live), worktreesStore.get())
}

export function useOnScreen(): OnScreen {
  const view = useThreads(viewSlot, shallowEqual)
  const live = useAcp(liveSlot, shallowEqual)
  const liveMovedTo = useThreads((state) => movedTo(state, live))
  const draft = useThreadDrafts(openSessionDraft)
  const places = useWorktrees((state) => state)
  // Whether the folder a harness moved to is a worktree is read from its checkout.
  const moved = liveMovedTo ?? view?.ref.currentCwd
  useEffect(() => {
    if (moved) followCheckouts([moved])
  }, [moved])
  return onScreen(view, live, draft, liveMovedTo, places)
}

/** One tab of the strip: a Thread by its conversation, or a new Thread. */
export type SessionTab =
  | { kind: "session"; id: string; ref?: ThreadRef; presence?: AcpPresence }
  | { kind: "draft"; id: string; draft: SessionDraft }

/**
 * A Thread's conversations, oldest first, then the new Thread beside it. After the split that is one, except a Thread
 * that runs elsewhere, left whole until cloud Threads split. One with neither a catalog row nor a live conversation has
 * nothing to show and is left out; so is an archived one, unless it is the one on screen.
 */
export function threadSessionTabs(input: {
  thread: string
  refs: readonly ThreadRef[]
  presences: readonly AcpPresence[]
  draft?: SessionDraft
  archived?: ReadonlySet<string>
  shown?: string
}): SessionTab[] {
  const { thread, draft, archived, shown } = input
  const refs = new Map<string, ThreadRef>()
  const presences = new Map<string, AcpPresence>()
  const started = new Map<string, number>()
  for (const ref of input.refs) {
    if (!ref.sessionId || refs.has(ref.sessionId) || ref.threadId !== thread) continue
    if (archived && ref.sessionId !== shown && archivedThread(ref, archived)) continue
    refs.set(ref.sessionId, ref)
    started.set(ref.sessionId, rowStarted(ref))
  }
  for (const presence of input.presences) {
    if (!presence.sessionId || presences.has(presence.sessionId) || presence.threadId !== thread) continue
    if (archived && presence.sessionId !== shown && archivedLive(presence, archived)) continue
    presences.set(presence.sessionId, presence)
    if (!refs.has(presence.sessionId)) started.set(presence.sessionId, rowStarted(presence))
  }
  const tabs = [...started].sort((left, right) => left[1] - right[1]).map(([id]): SessionTab => ({ kind: "session", id, ref: refs.get(id), presence: presences.get(id) }))
  if (draft) tabs.push({ kind: "draft", id: draft.id, draft })
  return tabs
}

/** A Thread's own tabs, for a pane that shows one conversation and whatever asks after a Thread's conversations. */
export function useThreadTabs(here: OnScreen): SessionTab[] {
  const { thread, session: shown } = here
  const draft = useThreadDrafts((state) => (thread ? state.drafts[thread] : undefined))
  const archived = useThreadArchives((state) => state.keys)
  const refs = useThreads((state) => state.threads)
  const presences = useAcp(selectAcpPresence, sameAcpPresence)
  return useMemo(
    () => (thread ? threadSessionTabs({ thread, refs, presences, draft, archived, shown }) : []),
    [thread, refs, presences, draft, archived, shown]
  )
}

export function currentThreadTabs(thread: string): SessionTab[] {
  return threadSessionTabs({
    thread,
    refs: threadsStore.get().threads,
    presences: selectAcpPresence(acpStore.get()),
    draft: threadDraftsStore.get().drafts[thread],
    archived: threadArchiveStore.get().keys,
    shown: currentOnScreen().session,
  })
}

/** The strip's entries drawn: a Thread's entry by the conversation it names, or its first; one not listed yet waits. */
export function openTabsOf(input: {
  entries: readonly OpenEntry[]
  refs: readonly ThreadRef[]
  presences: readonly AcpPresence[]
  drafts: Readonly<Record<string, SessionDraft>>
  archived?: ReadonlySet<string>
  shown?: string
}): SessionTab[] {
  const { entries, drafts, archived, shown } = input
  const open = new Set(entries.flatMap((entry) => (entry.kind === "thread" ? [entry.thread] : [])))
  const refs = input.refs.filter((ref) => ref.threadId !== undefined && open.has(ref.threadId))
  const presences = input.presences.filter((presence) => presence.threadId !== undefined && open.has(presence.threadId))
  return entries.flatMap((entry): SessionTab[] => {
    if (entry.kind === "draft") {
      const draft = drafts[entry.place]
      return draft ? [{ kind: "draft", id: draft.id, draft }] : []
    }
    const tabs = threadSessionTabs({ thread: entry.thread, refs, presences, archived, shown })
    const tab = tabs.find((candidate) => candidate.id === entry.session) ?? tabs[0]
    return tab ? [tab] : []
  })
}

/** What this window has open, as the strip draws it. */
export function useOpenTabs(here: OnScreen): SessionTab[] {
  const entries = useOpenEntries((state) => state.entries)
  const drafts = useThreadDrafts((state) => state.drafts)
  const archived = useThreadArchives((state) => state.keys)
  const refs = useThreads((state) => state.threads)
  const presences = useAcp(selectAcpPresence, sameAcpPresence)
  const shown = here.session
  return useMemo(() => openTabsOf({ entries, refs, presences, drafts, archived, shown }), [entries, refs, presences, drafts, archived, shown])
}

export function currentOpenTabs(): SessionTab[] {
  return openTabsOf({
    entries: openTabsStore.get().entries,
    refs: threadsStore.get().threads,
    presences: selectAcpPresence(acpStore.get()),
    drafts: threadDraftsStore.get().drafts,
    archived: threadArchiveStore.get().keys,
    shown: currentOnScreen().session,
  })
}

/** The Thread a tab names; a new Thread's is the one it opened from. */
export function tabThread(tab: SessionTab): string | undefined {
  return tab.kind === "draft" ? tab.draft.thread : (tab.ref?.threadId ?? tab.presence?.threadId)
}

/** The tab on screen: a new Thread by its draft, any other by its conversation. */
export function onScreenTab(here: OnScreen): string | undefined {
  return here.draft ? here.draft.id : here.session
}

/** A tab's title: its Thread's name, the rail row's, then what its agent called it. */
export function sessionTabTitle(tab: SessionTab): string {
  if (tab.kind === "draft") return "New thread"
  const thread = tabThread(tab)
  const path = tab.ref?.path ?? tab.presence?.threadPath
  const harness = tab.presence?.harness ?? tab.ref?.harness
  return (path ? prefsStore.get().titleOverrides[path] : undefined) ?? (thread ? threadTitle(thread) : undefined) ?? tab.presence?.title ?? tab.ref?.title ?? (harness ? harnessLabel(harness) : "Untitled thread")
}

const PRESENCE_STATE = {
  starting: "working",
  running: "working",
  background: "working",
  "needs-permission": "waiting",
  failed: "failed",
  ready: "idle",
} satisfies Record<AcpPresence["status"], SessionState>

/**
 * What the shared rule (`session-choice.ts`) reads of a tab, for a Thread left whole. When the person last worked in it
 * is their last message (`promptedAt`, kept on a conversation the host closed too), else its harness's own last write.
 */
export function sessionTabFacts(tab: Extract<SessionTab, { kind: "session" }>, promptedAt: number | undefined): SessionFacts {
  const { ref, presence } = tab
  const harness = presence?.harness ?? ref?.harness ?? ""
  const facts: SessionFacts = {
    id: tab.id,
    harness,
    state: presence ? PRESENCE_STATE[presence.status] : "idle",
    createdAt: presence?.createdAt ?? rowStarted(ref ?? {}),
  }
  const title = presence?.title ?? ref?.title
  if (title) facts.title = title
  // The host lists a message a beat after this window's conversation took it.
  const prompted = laterPrompt(presence?.promptedAt, promptedAt)
  if (prompted !== undefined) facts.promptedAt = prompted
  else if (!presence && ref?.updatedAt) facts.harnessWroteAt = Date.parse(ref.updatedAt)
  if (presence?.quietSince !== undefined) facts.quiet = true
  const forkOf = presence?.forkOf
  if (forkOf) {
    facts.fork = true
    facts.forkOf = forkOf
  }
  return facts
}

/** When the person last sent a Session a message, from any conversation of it this window holds, closed ones too. */
export function sessionPromptedAt(state: AcpState, session: string): number | undefined {
  let latest: number | undefined
  for (const conversation of Object.values(state.conversations))
    if (conversation.sessionId === session && conversation.kind !== "starting" && conversation.promptedAt !== undefined)
      latest = Math.max(latest ?? 0, conversation.promptedAt)
  return latest
}

/** The time, read again each minute: a Session's age moves on while it shows. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
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

/**
 * The Session this window put on screen by itself, with nothing of the person's to go on (an address naming none),
 * until they pick one. Only a send to it may ask first (`staleTarget`): one the person picked is where they mean their
 * words to go.
 */
let openedByScreen: string | undefined

/** How the Session on screen got there (`OpenedBy`). */
export function openedBy(session: string): OpenedBy {
  return session === openedByScreen ? "screen" : "person"
}

/** This window opened `session` by itself; undefined, the person picked what's on screen. */
export function noteOpenedByScreen(session: string | undefined): void {
  openedByScreen = session
}

export function openSessionTab(tab: SessionTab): void {
  openedByScreen = undefined
  const here = currentOnScreen()
  if (tab.id === onScreenTab(here)) return
  if (tab.kind === "draft") {
    showDraft(tab.draft)
    return
  }
  const { ref, presence } = tab
  const owns = presence && ref && (presence.threadPath === ref.path || presence.nativePaths?.includes(ref.path))
  if (ref && (!presence || owns)) void threads.view(ref)
  else if (presence) openConversation(presence)
}

/**
 * Start a new Thread beside the one on screen: same folder, same branch. One already waiting there comes back. Nothing
 * is created until the first message is sent.
 */
export function newThreadHere(): boolean {
  const { routes } = windowRoutesStore.get()
  if (routes) return routes.newSession()
  const here = currentOnScreen()
  if (!here.thread) return false
  if (here.draft) {
    window.dispatchEvent(new CustomEvent("mako:focus-composer"))
    return true
  }
  showDraft(threadDraftsStore.get().drafts[here.thread] ?? {
    id: crypto.randomUUID(),
    thread: here.thread,
    cwd: here.cwd ?? "",
    title: here.title ?? "this Thread",
  })
  return true
}

/** Close a new Thread: its text stays for the next one here. */
function putDraftAway(draft: SessionDraft): void {
  const kept = draftHasContent(draft)
  discardSessionDraft(draft.thread)
  if (kept) toast("Draft put away. A new tab here brings it back.")
}

/** Close the new Thread on screen and go back to the one it opened from. */
export function closeSessionDraft(): boolean {
  const { draft } = currentOnScreen()
  if (!draft) return false
  putDraftAway(draft)
  const back = currentThreadTabs(draft.thread).at(-1)
  if (back) openSessionTab(back)
  return true
}

/** Close a new Thread from its ×, on screen or not. */
export function closeDraftTab(draft: SessionDraft): void {
  if (currentOnScreen().draft?.id === draft.id) closeSessionDraft()
  else putDraftAway(draft)
}

/**
 * Close a Thread's tab: the Thread stays in the rail, and keeps running. The tab beside it takes the screen; with none,
 * the window goes back to its start.
 */
export function closeThreadTab(tab: Extract<SessionTab, { kind: "session" }>): void {
  const thread = tabThread(tab)
  if (!thread) return
  if (tab.id === onScreenTab(currentOnScreen())) {
    const tabs = currentOpenTabs()
    const at = tabs.findIndex((candidate) => candidate.id === tab.id)
    const neighbour = tabs[at + 1] ?? tabs[at - 1]
    if (neighbour) openSessionTab(neighbour)
    else leaveOnScreen()
  }
  closeEntries(new Set([thread]))
}

/** Nothing on screen: the window's start. */
function leaveOnScreen(): void {
  const { routes } = windowRoutesStore.get()
  if (routes) {
    routes.closeThread()
    return
  }
  acp.deactivate()
  threads.closeViewer()
}

/** Close the tab on screen; false when it isn't a Thread's. */
export function closeOnScreenTab(): boolean {
  const here = currentOnScreen()
  const tab = currentOpenTabs().find((candidate) => candidate.id === here.session)
  if (tab?.kind !== "session") return false
  closeThreadTab(tab)
  return true
}

/** Step through what's open; false with one tab or none. */
export function stepOpenTab(delta: 1 | -1): boolean {
  const tabs = currentOpenTabs()
  if (tabs.length < 2) return false
  const index = tabs.findIndex((tab) => tab.id === onScreenTab(currentOnScreen()))
  const next = tabs[(index + delta + tabs.length) % tabs.length]
  if (next) openSessionTab(next)
  return true
}

export function hasOpenTabs(): boolean {
  return currentOpenTabs().length > 1
}

/**
 * Send a new Thread's first message, or set its goal or start its review in place of one. It's made under the draft's
 * ID, so a retry after an unknown outcome finds the same Thread, and opens in the same tab. A start that fails brings
 * the draft back with the message restored.
 */
export async function startInThread(
  draft: SessionDraft,
  harness: string,
  first: { prompt: string; attachments: PromptAttachment[] } | StartFirst
): Promise<boolean> {
  if (descriptorFor(threadsStore.get(), harness)?.live !== true)
    throw new Error(`${harnessLabel(harness)} can't start a new Thread here. Pick another agent; your message is kept.`)
  const placement = await getMako().threadCreateSession(draft.id, draft.thread)
  const placed = { ...draft, session: placement.session, harness }
  putSessionDraft(placed, false)
  draftBecameThread(draft.thread, placement)
  const started = "prompt" in first
    ? await acp.startFresh(harness, draft.cwd, first.prompt, first.attachments, first.prompt, undefined, placement)
    : await acp.startWith(harness, draft.cwd, first, placement)
  if (started) discardSessionDraft(draft.thread)
  else if (!activeAcp(acpStore.get()) && !viewSlot(threadsStore.get())) showDraft(placed)
  else putSessionDraft(placed, false)
  return started
}

/**
 * Keep the strip in step with the screen: what's shown has a tab, an archived Thread's tab goes, a new Thread goes once
 * it's empty and anything else takes its place, including a switch between attached sessions.
 */
export function watchThreadSessions(): () => void {
  let attached = tabsStore.get().activeId
  let archivedSeen = threadArchiveStore.get().keys
  const sync = () => {
    const view = viewSlot(threadsStore.get())
    const live = liveSlot(acpStore.get())
    const switched = tabsStore.get().activeId !== attached
    attached = tabsStore.get().activeId
    if (threadDraftsStore.get().open !== null && (view || live || switched)) leaveSessionDraft()
    const { drafts } = threadDraftsStore.get()
    showInTabs(onScreen(view, live, openSessionDraft(threadDraftsStore.get()), undefined, worktreesStore.get()))
    const { keys } = threadArchiveStore.get()
    const drawn = keys === archivedSeen ? undefined : new Set(currentOpenTabs().map((tab) => tabThread(tab)))
    archivedSeen = keys
    const gone = openTabsStore.get().entries.flatMap((entry) =>
      (entry.kind === "draft" ? !drafts[entry.place] : drawn !== undefined && !drawn.has(entry.thread) && threadsStore.get().threads.some((ref) => ref.threadId === entry.thread)) ? [entryKey(entry)] : [])
    if (gone.length) closeEntries(new Set(gone))
  }
  const stops = [threadsStore.subscribe(sync), acpStore.subscribe(sync), threadDraftsStore.subscribe(sync), tabsStore.subscribe(sync), threadArchiveStore.subscribe(sync)]
  sync()
  return () => stops.forEach((stop) => stop())
}
