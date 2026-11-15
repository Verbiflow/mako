import type { ThreadRunState } from "@/lib/types"
import { createHook, createStore } from "@/state/store"

/**
 * What a native Thread's latest reply runs without (`ThreadRunState.dropped`: a model or effort its harness's command
 * line can't carry), by the Thread's path: said on that reply, until a reply that carries everything starts.
 */
export const runDroppedStore = createStore<{ runs: Readonly<Record<string, { harness: string; dropped: readonly string[] }>> }>({ runs: {} })
export const useRunDropped = createHook(runDroppedStore)

export function noteRunDropped(run: ThreadRunState): void {
  if (run.status !== "running") return
  const runs = { ...runDroppedStore.get().runs }
  if (run.dropped?.length) runs[run.path] = { harness: run.harness, dropped: run.dropped }
  else delete runs[run.path]
  runDroppedStore.set({ runs })
}
