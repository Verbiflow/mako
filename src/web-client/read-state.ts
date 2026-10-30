import { useEffect } from "react"
import { z } from "zod"
import { createHook, createStore } from "@/state/store"

/**
 * What this browser has read of each Thread: the activity it had when it was last on screen here, and the ones the
 * person marked unread. A Thread whose run finished since then lists as "Done" until it's opened. Kept on this device
 * only: the account keeps no read state, so another device has its own.
 */
export interface ReadState {
  /** By Thread ID: its activity (ms since the epoch) when it was last on screen, or first listed here. */
  seen: Readonly<Record<string, number>>
  /** Threads marked unread by hand: listed as such until opened. */
  unread: Readonly<Record<string, true>>
}

const ReadStateSchema = z.object({ seen: z.record(z.string(), z.number()), unread: z.record(z.string(), z.literal(true)) })
/** Past this many, the Threads seen longest ago are forgotten (and read as seen when next listed). */
const KEPT = 500

export const readStore = createStore<ReadState>({ seen: {}, unread: {} })
export const useReadState = createHook(readStore)

let storageKey: string | undefined

/** Reads what this browser kept for `accountId`: called once as the client starts, before the list paints. */
export function loadReadState(accountId: string): void {
  storageKey = `mako:web:read:${accountId}`
  try {
    const text = localStorage.getItem(storageKey)
    const kept = text ? ReadStateSchema.safeParse(JSON.parse(text)).data : undefined
    if (kept) readStore.set(kept)
  } catch {
    // Nothing kept: every Thread reads as seen as it's first listed.
  }
}

function keep(next: ReadState): void {
  readStore.set(next)
  if (!storageKey) return
  const seen = Object.entries(next.seen)
  const trimmed = seen.length > KEPT ? { ...next, seen: Object.fromEntries(seen.toSorted((left, right) => right[1] - left[1]).slice(0, KEPT)) } : next
  try {
    localStorage.setItem(storageKey, JSON.stringify(trimmed))
  } catch {
    // Storage full: read state lasts this visit.
  }
}

/** Threads listed here for the first time read as seen as they stand: only what happens from now on is news. */
export function noteListed(threads: ReadonlyArray<{ id: string; activityAt: number }>): void {
  const { seen, unread } = readStore.get()
  const fresh = threads.filter((thread) => seen[thread.id] === undefined)
  if (fresh.length) keep({ seen: { ...seen, ...Object.fromEntries(fresh.map((thread) => [thread.id, thread.activityAt])) }, unread })
}

/** The Thread is on screen with this activity: read up to it, and no longer marked unread. */
export function markSeen(thread: string, activityAt: number): void {
  const { seen, unread } = readStore.get()
  if ((seen[thread] ?? -1) >= activityAt && !unread[thread]) return
  const stillUnread = Object.fromEntries(Object.entries(unread).filter(([each]) => each !== thread))
  keep({ seen: { ...seen, [thread]: Math.max(seen[thread] ?? 0, activityAt) }, unread: stillUnread })
}

/** Marked unread by hand: listed as unread until it's next opened. */
export function markUnread(thread: string): void {
  const { seen, unread } = readStore.get()
  keep({ seen, unread: { ...unread, [thread]: true } })
}

/** Whether the Thread has news since it was last on screen here: a finished run, or the person's own mark. */
export function isUnread(state: ReadState, thread: { id: string; activityAt: number }): boolean {
  if (state.unread[thread.id]) return true
  const seen = state.seen[thread.id]
  return seen !== undefined && thread.activityAt > seen
}

/** While a Thread is on screen and the page in view, it's read: what it does meanwhile never lists as news. */
export function useSeenWhileOpen(thread: { id: string; activityAt: number } | undefined): void {
  const id = thread?.id
  const activityAt = thread?.activityAt
  useEffect(() => {
    if (id === undefined || activityAt === undefined) return
    const seen = () => {
      if (document.visibilityState === "visible") markSeen(id, activityAt)
    }
    seen()
    document.addEventListener("visibilitychange", seen)
    return () => document.removeEventListener("visibilitychange", seen)
  }, [id, activityAt])
}
