import type { HandOffCandidate, HandOffResult, HandOffSettings } from "@mako/host/contracts/cloud-threads"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Handing this Mac's working agents to the cloud, as the window sees it. The host does the handoff (`CloudHandOffs`)
 * and owns its truth: each Thread's move reports its steps as it would for a single move, by conversation
 * (`cloudMovesStore`), so this keeps only what the quit sheet and Settings read: which Threads at work could go, the
 * handoff the quit sheet started and how each Thread came out of it, and the person's choice for sleep.
 */
interface HandOffState {
  /** The Threads at work here, read when the quit sheet opens; null before. */
  candidates: HandOffCandidate[] | null
  /** The quit sheet's handoff: running until `results`. */
  running: { id: string; results?: HandOffResult[] } | null
  settings: HandOffSettings | null
}

export const handOffStore = createStore<HandOffState>({ candidates: null, running: null, settings: null })
export const useHandOff = createHook(handOffStore)

/** The quit sheet's handoff while it runs, which a second ask joins. */
let pending: Promise<HandOffResult[]> | undefined

export const handOff = {
  async loadCandidates(): Promise<HandOffCandidate[]> {
    if (!hasBridge()) return []
    const candidates = await getMako().handOffCandidates().catch(() => [])
    handOffStore.set({ candidates })
    return candidates
  },
  /**
   * Hands every Thread at work to the cloud, all at once, and answers how each went. One handoff at a time: asked
   * again while one runs, it waits for that one.
   */
  all(): Promise<HandOffResult[]> {
    if (pending) return pending
    const id = crypto.randomUUID()
    handOffStore.set({ running: { id } })
    pending = getMako().handOff(id, "quit").then((results) => {
      handOffStore.set({ running: { id, results } })
      return results
    }).finally(() => {
      pending = undefined
    })
    return pending
  },
  reset(): void {
    handOffStore.set({ running: null, candidates: null })
  },
  async loadSettings(): Promise<void> {
    if (!hasBridge()) return
    const settings = await getMako().handOffSettings().catch(() => null)
    handOffStore.set({ settings })
  },
  async setOnSleep(onSleep: boolean): Promise<void> {
    const before = handOffStore.get().settings
    if (before) handOffStore.set({ settings: { ...before, onSleep } })
    try {
      handOffStore.set({ settings: await getMako().setHandOffOnSleep(onSleep) })
    } catch {
      handOffStore.set({ settings: before })
    }
  },
  /** The host's word on the person's choice, from any window. */
  settled(settings: HandOffSettings): void {
    handOffStore.set({ settings })
  },
}
