import type { KeepAwakeHold, KeepAwakeSettings, KeepAwakeState } from "@mako/host/contracts/keep-awake"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Keeping this Mac awake while its agents work, as the window sees it. The host holds the power assertion
 * (`KeepAwake`) and owns its truth; this keeps the person's choice and what's held, for Settings and the titlebar.
 * Null until read.
 */
export const keepAwakeStore = createStore<{ state: KeepAwakeState | null }>({ state: null })
export const useKeepAwake = createHook(keepAwakeStore)

export function agentsWorking(agents: number): string {
  return `${agents} ${agents === 1 ? "agent" : "agents"} working`
}

/**
 * What's wrong when agents work on a Mac that may sleep, in the same words in the titlebar and in the setting it opens;
 * undefined when nothing is. The setting's switch says the person's choice; this says what's happening.
 */
export function keepAwakeWarning(hold: KeepAwakeHold | undefined): string | undefined {
  if (hold?.kind === "low-battery") return `Battery at ${hold.percent}%, below ${hold.floor}%: this Mac may sleep with ${agentsWorking(hold.agents)}.`
  if (hold?.kind === "failed") return `Mako couldn't keep this Mac awake, so it may sleep with ${agentsWorking(hold.agents)}. Mako tries again within a minute.`
  return undefined
}

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
