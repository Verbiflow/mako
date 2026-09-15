import { prefsStore } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import type { ThreadsState } from "@/state/thread-state"

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  opening: null,

  descriptors: [],
  run: null,
  working: {},
  attention: {},
  observed: {},
  externalActivity: {},
  converting: null,
  composerHarness: prefsStore.get().composerHarness ?? "claude",
  nativeRequests: [],
})

export const useThreads = createHook(threadsStore)
