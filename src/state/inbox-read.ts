import { createHook, createStore } from "@/state/store"

/**
 * What the person read today: each Thread whose unread answer or failure stood down (opened, or settled from the
 * Inbox with `e`), when. The Inbox folds them under "Read today", and `u` there puts one back. Kept for the window's
 * life only; a read from before today falls away by itself.
 */
export interface ReadEntry {
  path: string
  kind: "review" | "failed"
  /** When its answer or failure came. */
  at: number
  detail?: string
  readAt: number
}

/** How many reads are kept: the newest. */
const KEPT = 60

export const inboxReadStore = createStore<{ entries: readonly ReadEntry[] }>({ entries: [] })
export const useInboxRead = createHook(inboxReadStore)

export function noteRead(entry: Omit<ReadEntry, "readAt">, readAt = Date.now()): void {
  inboxReadStore.set((state) => ({ entries: [{ ...entry, readAt }, ...state.entries.filter((each) => each.path !== entry.path)].slice(0, KEPT) }))
}

export function forgetRead(path: string): void {
  inboxReadStore.set((state) => ({ entries: state.entries.filter((each) => each.path !== path) }))
}

function startOfDay(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** Today's reads, newest first. */
export function readToday(entries: readonly ReadEntry[], now = Date.now()): ReadEntry[] {
  const since = startOfDay(now)
  return entries.filter((entry) => entry.readAt >= since)
}
