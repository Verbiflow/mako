import type { ThreadPurpose } from "../../electron/contracts/thread-purposes.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

export interface ThreadPurposesState {
  /** What Mako started each Thread for, by Thread ID; most Threads have none. */
  byThread: Readonly<Record<string, ThreadPurpose>>
}

export const threadPurposesStore = createStore<ThreadPurposesState>({ byThread: {} })
export const useThreadPurposes = createHook(threadPurposesStore)

/** Each list is the whole set, so a load answered after a newer event is dropped. */
let arrived = 0

export function applyThreadPurposes(purposes: readonly ThreadPurpose[]): void {
  arrived += 1
  threadPurposesStore.set({ byThread: Object.fromEntries(purposes.map((purpose) => [purpose.thread, purpose])) })
}

export async function loadThreadPurposes(): Promise<void> {
  if (!hasBridge()) return
  const before = arrived
  const purposes = await getMako().threadPurposes()
  if (arrived === before) applyThreadPurposes(purposes)
}
