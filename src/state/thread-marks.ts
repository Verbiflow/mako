import { foldsAsDone, marksNothing, type ThreadMarkChange, type ThreadMarkEntry, type WorkStatus } from "@mako/host/contracts/thread-marks"
import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * What the person marked each Thread with, as the host's Thread store keeps it (`contracts/thread-marks.ts`): its
 * workflow status and Mark as unread. A change shows at once and is the host's to keep; every window hears it as
 * `thread-marks`, and the person's other devices with the Sessions the host reports.
 */
export interface ThreadMarksState {
  byThread: Readonly<Record<string, ThreadMarkEntry>>
}

export const threadMarksStore = createStore<ThreadMarksState>({ byThread: {} })
export const useThreadMarks = createHook(threadMarksStore)

/** Changes told while the whole set is loading, applied over it once it arrives. */
let told: ThreadMarkEntry[] | null = null

function merge(byThread: Readonly<Record<string, ThreadMarkEntry>>, entries: readonly ThreadMarkEntry[]): Readonly<Record<string, ThreadMarkEntry>> {
  let next: Record<string, ThreadMarkEntry> | undefined
  for (const entry of entries) {
    const current = byThread[entry.thread]
    if (marksNothing(entry)) {
      if (!current) continue
      next ??= { ...byThread }
      delete next[entry.thread]
      continue
    }
    if (current && current.status === entry.status && current.statusAt === entry.statusAt && current.unreadAt === entry.unreadAt && current.by === entry.by) continue
    next ??= { ...byThread }
    next[entry.thread] = entry
  }
  return next ?? byThread
}

export function applyThreadMarks(entries: readonly ThreadMarkEntry[]): void {
  told?.push(...entries)
  threadMarksStore.set((state) => ({ byThread: merge(state.byThread, entries) }))
}

export async function loadThreadMarks(): Promise<void> {
  if (!hasBridge()) return
  told = []
  try {
    const all = await getMako().threadMarks()
    const late = told
    threadMarksStore.set({ byThread: merge(merge({}, all), late) })
  } finally {
    told = null
  }
}

function changed(entry: ThreadMarkEntry | undefined, thread: string, change: ThreadMarkChange, now: number): ThreadMarkEntry {
  const held = entry ?? { thread, status: null, statusAt: null, by: null, unreadAt: null }
  return {
    ...held,
    ...(change.status !== undefined && { status: change.status, statusAt: change.status === null ? null : now, by: change.status === null ? null : "person" }),
    ...(change.unread !== undefined && { unreadAt: change.unread ? now : null }),
  }
}

/** Marks each of `threads` with `change`: shown at once, put back if the host refuses. */
export async function markThreads(threads: readonly string[], change: ThreadMarkChange): Promise<void> {
  const ids = [...new Set(threads)]
  if (!ids.length) return
  const before = threadMarksStore.get().byThread
  const now = Date.now()
  applyThreadMarks(ids.map((thread) => changed(before[thread], thread, change, now)))
  if (!hasBridge()) return
  const results = await Promise.allSettled(ids.map((thread) => getMako().markThread(crypto.randomUUID(), thread, change)))
  const kept = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  applyThreadMarks(kept)
  const failed = ids.filter((_, index) => results[index]?.status === "rejected")
  if (!failed.length) return
  applyThreadMarks(failed.map((thread) => before[thread] ?? { thread, status: null, statusAt: null, by: null, unreadAt: null }))
  const reason = results.find((result) => result.status === "rejected")
  toast.error(failed.length === 1 ? "The thread kept its mark" : `${failed.length} threads kept their marks`, {
    description: reason?.status === "rejected" && reason.reason instanceof Error ? reason.reason.message : undefined,
  })
}

export function setWorkStatus(thread: string, status: WorkStatus | null): Promise<void> {
  return markThreads([thread], { status })
}

/** Opening a Thread reads it: a Mark as unread on it is dropped. */
export function readThreadMark(thread: string | undefined): void {
  if (thread && threadMarksStore.get().byThread[thread]?.unreadAt != null) void markThreads([thread], { unread: false })
}

export function markedUnread(thread: string | undefined): boolean {
  return thread !== undefined && threadMarksStore.get().byThread[thread]?.unreadAt != null
}

/** Whether a Thread has been Done for three days and folds into its project's "N done" line. */
export function foldedAsDone(entry: ThreadMarkEntry | undefined, now: number): boolean {
  return foldsAsDone(entry, now)
}
