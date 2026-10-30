import type { SyncStatus } from "@mako/host/contracts/sync-status"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * How this Mac's Sessions stand in the account, as the host last read them from the stores it pushes from. Read while
 * Settings shows it, every two seconds: the host reads the catalog every five, so this never lags it by more.
 */
interface SyncStatusState {
  status?: SyncStatus
  /** When it was read, which what's said of its age is measured against. */
  readAt?: number
}

export const syncStatusStore = createStore<SyncStatusState>({})
export const useSyncStatus = createHook(syncStatusStore)

const READ_EVERY_MS = 2_000

async function read(): Promise<void> {
  if (!hasBridge()) return
  try {
    syncStatusStore.set({ status: await getMako().syncStatus(), readAt: Date.now() })
  } catch {
    // The section keeps what it last read; the next read says again.
  }
}

export const syncStatus = {
  /** Reads it now and while the caller shows it, every `everyMs`; the returned function stops. */
  watch(everyMs = READ_EVERY_MS): () => void {
    void read()
    const timer = setInterval(() => void read(), everyMs)
    return () => clearInterval(timer)
  },
}
