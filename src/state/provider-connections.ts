import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { providers } from "@/state/providers"
import type { ProviderConnection, ProviderConnectionAction } from "@/lib/types"

/**
 * Provider transports with their own sign-in — Cursor's SDK first. One
 * store because the Settings row and the composer's notice both read it,
 * and because the host pushes a `provider-connections` event when a sign-in
 * lands or a key is rejected so every window agrees without asking again.
 *
 * Failures of an action stay in the store, keyed by provider, so the row
 * that asked shows them inline next to the field the user typed into; a
 * toast would leave the field and the reason in different places.
 */
interface ProviderConnectionsState {
  connections: ProviderConnection[]
  /** Provider whose action is in flight, and which one. */
  busy?: { provider: string; action: ProviderConnectionAction["kind"] }
  /** Last failed action per provider, cleared by the next attempt. */
  failures: Record<string, { action: ProviderConnectionAction["kind"]; message: string }>
  loadedAt?: number
}

const STALE_MS = 60_000

export const providerConnectionsStore = createStore<ProviderConnectionsState>({
  connections: [],
  failures: {},
})
export const useProviderConnections = createHook(providerConnectionsStore)

export function connectionFor(
  state: ProviderConnectionsState,
  provider: string | null | undefined
): ProviderConnection | undefined {
  return provider ? state.connections.find((entry) => entry.provider === provider) : undefined
}

export const providerConnections = {
  load(force = false) {
    if (!hasBridge()) return
    const { loadedAt } = providerConnectionsStore.get()
    if (!force && loadedAt && Date.now() - loadedAt < STALE_MS) return
    providerConnectionsStore.set({ loadedAt: Date.now() })
    void getMako()
      .providerConnections(force)
      .then((connections) => providerConnectionsStore.set({ connections }))
      .catch(() => providerConnectionsStore.set({ loadedAt: undefined }))
  },

  dismissFailure(provider: string) {
    providerConnectionsStore.set((state) => {
      if (!(provider in state.failures)) return state
      const failures = { ...state.failures }
      delete failures[provider]
      return { failures }
    })
  },

  /** Resolves to true when the action landed; the failure is in the store otherwise. */
  async act(provider: string, action: ProviderConnectionAction): Promise<boolean> {
    if (providerConnectionsStore.get().busy) return false
    providerConnectionsStore.set((state) => {
      const failures = { ...state.failures }
      delete failures[provider]
      return { busy: { provider, action: action.kind }, failures }
    })
    try {
      const connection = await getMako().providerConnectionAction(provider, action)
      providerConnectionsStore.set((state) => ({
        connections: state.connections.some((entry) => entry.provider === provider)
          ? state.connections.map((entry) => (entry.provider === provider ? connection : entry))
          : [...state.connections, connection],
        loadedAt: Date.now(),
      }))
      // The models on offer follow the account; the host re-runs discovery
      // on its side and this drops the stale catalogue here.
      if (action.kind !== "refresh") await providers.refreshAccount(provider)
      return true
    } catch (error) {
      providerConnectionsStore.set((state) => ({
        failures: {
          ...state.failures,
          [provider]: {
            action: action.kind,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      }))
      return false
    } finally {
      providerConnectionsStore.set({ busy: undefined })
    }
  },
}
