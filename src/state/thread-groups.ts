import { z } from "zod"
import type { ThreadGroup, ThreadGroupChange } from "../../electron/contracts/thread-groups.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { readAttachmentDrafts, readDraftStorage, writeDraftStorage } from "@/lib/draft-persistence"
import { draftsStore } from "@/state/drafts"
import { createHook, createStore } from "@/state/store"

/**
 * A Thread's new tab: a Session it will get when the tab's first message is
 * sent. A Thread has at most one, and it stays while it holds unsent text.
 */
export interface SessionDraft {
  /** The operation ID that creates the tab's Session. */
  id: string
  thread: string
  cwd: string
  /** The Thread's title when the tab opened, for the empty tab's receipt. */
  title: string
  /** The Session created for the tab, once a send has asked for it. */
  session?: string
  /** The agent picked in the tab, when one was. */
  harness?: string
  /** Where its text is kept, when it came from a Thread that joined this one. */
  key?: string
}

const SessionDraftSchema = z.object({
  id: z.string().uuid(),
  thread: z.string().uuid(),
  cwd: z.string(),
  title: z.string(),
  session: z.string().uuid().optional(),
  harness: z.string().optional(),
  key: z.string().optional(),
})

export interface ThreadGroupsState {
  /** Threads with two or more Sessions, by Thread ID. */
  groups: Readonly<Record<string, ThreadGroup>>
  /** The Thread of every Session in `groups`. */
  threadOf: Readonly<Record<string, string>>
  /** The Session you last had on screen in each Thread. */
  lastViewed: Readonly<Record<string, string>>
  /** Each Thread's new tab, by Thread ID. */
  drafts: Readonly<Record<string, SessionDraft>>
  /** The Thread whose new tab is on screen. */
  open: string | null
}

/** Where the composer keeps a Thread's new-tab text; one per Thread, so it outlives the tab. */
export function sessionDraftKey(draft: SessionDraft | null | undefined): string | undefined {
  return draft ? (draft.key ?? `thread-session:${draft.thread}`) : undefined
}

export function draftHasContent(draft: SessionDraft): boolean {
  const key = draft.key ?? `thread-session:${draft.thread}`
  const saved = draftsStore.get().drafts.find((entry) => entry.key === key)
  return Boolean(saved?.text.trim() || saved?.plans?.length || readAttachmentDrafts()[key]?.length)
}

const STORAGE_KEY = "mako.thread-session-drafts.v1"

function restoredDrafts(): Record<string, SessionDraft> {
  const raw = readDraftStorage(STORAGE_KEY)
  if (!raw) return {}
  try {
    const drafts = z.array(SessionDraftSchema).parse(JSON.parse(raw))
    return Object.fromEntries(drafts.filter(draftHasContent).map((draft) => [draft.thread, draft]))
  } catch {
    return {}
  }
}

export const threadGroupsStore = createStore<ThreadGroupsState>({ groups: {}, threadOf: {}, lastViewed: {}, drafts: restoredDrafts(), open: null })
export const useThreadGroups = createHook(threadGroupsStore)

let savedDrafts = threadGroupsStore.get().drafts
threadGroupsStore.subscribe(() => {
  const { drafts } = threadGroupsStore.get()
  if (drafts === savedDrafts) return
  savedDrafts = drafts
  writeDraftStorage(STORAGE_KEY, JSON.stringify(Object.values(drafts)))
})

export function openSessionDraft(state: ThreadGroupsState): SessionDraft | null {
  return state.open === null ? null : (state.drafts[state.open] ?? null)
}

export function putSessionDraft(draft: SessionDraft, open: boolean): void {
  threadGroupsStore.set((state) => {
    const patch: Partial<ThreadGroupsState> = { drafts: { ...state.drafts, [draft.thread]: draft } }
    if (open) patch.open = draft.thread
    return patch
  })
}

/** Drop a Thread's new tab. Its text stays under the Thread's key for the next one. */
export function discardSessionDraft(thread: string): void {
  threadGroupsStore.set((state) => {
    if (!state.drafts[thread]) return {}
    const drafts = { ...state.drafts }
    delete drafts[thread]
    return { drafts, open: state.open === thread ? null : state.open }
  })
}

/** Something else took the screen: an empty new tab goes, one with text stays. */
export function leaveSessionDraft(): void {
  const draft = openSessionDraft(threadGroupsStore.get())
  if (!draft) return
  if (draftHasContent(draft)) threadGroupsStore.set({ open: null })
  else discardSessionDraft(draft.thread)
}

/** The agent picked while a new tab is on screen belongs to that tab. */
export function rememberDraftHarness(harness: string): void {
  const draft = openSessionDraft(threadGroupsStore.get())
  if (draft && draft.harness !== harness) putSessionDraft({ ...draft, harness }, false)
}

function indexSessions(groups: Readonly<Record<string, ThreadGroup>>) {
  return Object.fromEntries(Object.values(groups).flatMap((group) => group.sessions.map((session) => [session.id, group.id])))
}

/** A row's Thread: the group this window heard of, else the one stamped when it was listed. */
export function rowThread(row: { threadId?: string; sessionId?: string }, threadOf: Readonly<Record<string, string>>): string | undefined {
  return (row.sessionId === undefined ? undefined : threadOf[row.sessionId]) ?? row.threadId
}

function withChange(groups: Readonly<Record<string, ThreadGroup>>, change: ThreadGroupChange) {
  const next = { ...groups }
  delete next[change.thread]
  if (change.group) next[change.group.id] = change.group
  return next
}

// Changes that arrive while a full read is in flight win over it: the read
// may have been answered before they happened.
const loads = new Set<ThreadGroupChange[]>()

export function applyThreadGroupChange(change: ThreadGroupChange): void {
  for (const arrived of loads) arrived.push(change)
  threadGroupsStore.set((state) => {
    const groups = withChange(state.groups, change)
    return { groups, threadOf: indexSessions(groups) }
  })
}

export async function loadThreadGroups(): Promise<void> {
  if (!hasBridge()) return
  const arrived: ThreadGroupChange[] = []
  loads.add(arrived)
  try {
    const list = await getMako().threadGroups()
    let groups: Record<string, ThreadGroup> = Object.fromEntries(list.map((group) => [group.id, group]))
    for (const change of arrived) groups = withChange(groups, change)
    threadGroupsStore.set({ groups, threadOf: indexSessions(groups) })
  } finally {
    loads.delete(arrived)
  }
}
