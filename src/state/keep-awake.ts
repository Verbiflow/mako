import type { KeepAwakeSettings, KeepAwakeState } from "@mako/host/contracts/keep-awake"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Keeping this Mac awake while its agents work, as the window sees it. The host holds the power assertion
 * (`KeepAwake`) and owns its truth; this keeps the person's choice and what's held, for Settings and the titlebar.
 * Null until read.
 */
export const keepAwakeStore = createStore<{ state: KeepAwakeState | null }>({ state: null })
export const useKeepAwake = createHook(keepAwakeStore)

export const keepAwake = {
  async load(): Promise<void> {
    if (!hasBridge()) return
    const state = await getMako().keepAwake().catch(() => null)
    keepAwakeStore.set({ state })
  },
  async set(change: Partial<KeepAwakeSettings>): Promise<void> {
    const before = keepAwakeStore.get().state
    if (!before) return
    keepAwakeStore.set({ state: { ...before, settings: { ...before.settings, ...change } } })
    try {
      keepAwakeStore.set({ state: await getMako().setKeepAwake(change) })
    } catch {
      keepAwakeStore.set({ state: before })
    }
  },
  /** The host's word, from any window: the choice, or what's held, changed. */
  settled(state: KeepAwakeState): void {
    keepAwakeStore.set({ state })
  },
}
