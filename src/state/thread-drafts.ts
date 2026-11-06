import { z } from "zod"
import { carryDrafts, type ThreadOrigin } from "@mako/host/contracts/thread-splits"
import { getMako, hasBridge } from "@/lib/bridge"
import { readAttachmentDrafts, readDraftStorage, writeDraftStorage } from "@/lib/draft-persistence"
import { draftsStore } from "@/state/drafts"
import { createHook, createStore } from "@/state/store"

/**
 * A new Thread beside another, in its place, before its first send: nothing is made until then. A place has at most
 * one, and it stays while it holds unsent text.
 */
export interface SessionDraft {
  /** The operation ID that creates the new Thread. */
  id: string
  /** The Thread it opened from, whose place it works in. */
  thread: string
  cwd: string
  /** That Thread's title when it opened, for the empty tab's receipt. */
  title: string
  /** The Session a send made for it, once one has asked. */
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

export interface ThreadDraftsState {
  /** Each place's new Thread, by the Thread it opened from. */
  drafts: Readonly<Record<string, SessionDraft>>
  /** The Thread whose new Thread is on screen. */
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

export const threadDraftsStore = createStore<ThreadDraftsState>({ drafts: restoredDrafts(), open: null })
export const useThreadDrafts = createHook(threadDraftsStore)

let savedDrafts = threadDraftsStore.get().drafts
threadDraftsStore.subscribe(() => {
  const { drafts } = threadDraftsStore.get()
  if (drafts === savedDrafts) return
  savedDrafts = drafts
  writeDraftStorage(STORAGE_KEY, JSON.stringify(Object.values(drafts)))
})

export function openSessionDraft(state: ThreadDraftsState): SessionDraft | null {
  return state.open === null ? null : (state.drafts[state.open] ?? null)
}

export function putSessionDraft(draft: SessionDraft, open: boolean): void {
  threadDraftsStore.set((state) => {
    const patch: Partial<ThreadDraftsState> = { drafts: { ...state.drafts, [draft.thread]: draft } }
    if (open) patch.open = draft.thread
    return patch
  })
}

/** Drop a Thread's new tab. Its text stays under the Thread's key for the next one. */
export function discardSessionDraft(thread: string): void {
  threadDraftsStore.set((state) => {
    if (!state.drafts[thread]) return {}
    const drafts = { ...state.drafts }
    delete drafts[thread]
    return { drafts, open: state.open === thread ? null : state.open }
  })
}

/** Something else took the screen: an empty new tab goes, one with text stays. */
export function leaveSessionDraft(): void {
  const draft = openSessionDraft(threadDraftsStore.get())
  if (!draft) return
  if (draftHasContent(draft)) threadDraftsStore.set({ open: null })
  else discardSessionDraft(draft.thread)
}

/** The agent picked while a new tab is on screen belongs to that tab. */
export function rememberDraftHarness(harness: string): void {
  const draft = openSessionDraft(threadDraftsStore.get())
  if (draft && draft.harness !== harness) putSessionDraft({ ...draft, harness }, false)
}

/** When a row's Session started, as a conversation (`createdAt`) or a catalog row (`startedAt`) says: a Thread's Sessions go oldest first. */
export function rowStarted(row: { createdAt?: number; startedAt?: string }): number {
  const started = row.createdAt ?? (row.startedAt === undefined ? Number.NaN : Date.parse(row.startedAt))
  return Number.isFinite(started) ? started : Number.MAX_SAFE_INTEGER
}

/** What the host split: a draft that had named a Session goes with it. */
export async function loadThreadSplits(): Promise<void> {
  if (!hasBridge()) return
  const splits = await getMako().threadSplits()
  threadDraftsStore.set((state) => ({ drafts: Object.fromEntries(carryDrafts(Object.values(state.drafts), splits).map((draft) => [draft.thread, draft])) }))
}

/** Where a Thread came from, for its crumb; a window with no host of its own can't say. */
export async function readThreadOrigin(thread: string): Promise<ThreadOrigin | null> {
  return hasBridge() ? getMako().threadOrigin(thread) : null
}
