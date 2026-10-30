import { createHook, createStore } from "@/state/store"

/**
 * The open conversation while it's read again: opened from what this page kept of it, or after a return or a
 * reconnect. Its screen says "Syncing…" meanwhile, over the transcript it already shows, never a skeleton.
 */
export const syncingStore = createStore<{ conversation: string | undefined }>({ conversation: undefined })
export const useSyncing = createHook(syncingStore)
