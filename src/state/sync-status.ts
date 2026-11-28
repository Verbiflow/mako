import type { SyncStatus } from "@mako/host/contracts/sync-status"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"
import { deskRefetch, DESK_SCOPE } from "@/state/desk-refetch"

interface SyncStatusState {
  status?: SyncStatus
  readAt?: number
}
export const syncStatusStore = createStore<SyncStatusState>({})
export const useSyncStatus = createHook(syncStatusStore)
const readers = new Map<number, number>()

/** The rail and Settings share one read; supported hosts push invalidations, older ones retain visible polling. */
export const syncStatus = {
  /** Reads a Session this Mac couldn't read into its records again, then the status: whether it was read. */
  async readAgain(harness: string, nativeId: string): Promise<boolean> {
    const read = await getMako().syncReadAgain(harness, nativeId)
    syncStatusStore.set({ status: await getMako().syncStatus(), readAt: Date.now() })
    return read
  },
  watch(everyMs = 2_000): () => void {
    if (!hasBridge()) return () => {}
    const owner = deskRefetch()
    readers.set(everyMs, (readers.get(everyMs) ?? 0) + 1)
    const lease = owner.reads.watch("host:sync-status", {
      scope: DESK_SCOPE, domain: "sync", fields: ["status"],
      every: () => owner.supports("sync") ? undefined : Math.min(...readers.keys()),
      read: async (current) => {
        const status = await getMako().syncStatus()
        if (current()) syncStatusStore.set({ status, readAt: Date.now() })
      },
    })
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      const left = (readers.get(everyMs) ?? 1) - 1
      if (left) readers.set(everyMs, left)
      else readers.delete(everyMs)
      lease.release()
      owner.reads.reschedule(DESK_SCOPE)
    }
  },
}
