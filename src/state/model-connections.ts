import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { errorMessage, type FailureBoundary } from "@mako/host/contracts/error-message"
import type {
  LocalModelServer,
  ModelConnectionCheck,
  ModelConnectionCheckInput,
  ModelConnectionInput,
  ModelConnectionsSnapshot,
  ModelConnectionTest,
} from "@mako/host/contracts/model-connections"

/**
 * Settings › Models › Connections: the gateways, local servers and endpoints
 * the person connected, Ollama's and LM Studio's state on this Mac, and each
 * row's last test. Keys go to the host and never come back.
 */
interface ModelConnectionsState {
  snapshot?: ModelConnectionsSnapshot
  error?: string
  local?: LocalModelServer[]
  /** A row being turned on or off, tested or removed. */
  busy?: string
  /** Each row's last test, or why it failed. */
  tests: Record<string, { result: ModelConnectionTest } | { error: string }>
}

export const modelConnectionsStore = createStore<ModelConnectionsState>({ tests: {} })
export const useModelConnections = createHook(modelConnectionsStore)

/** The host's reason, or `fallback` when it gave none. */
function message(failure: FailureBoundary, fallback: string): string {
  return errorMessage(failure) || fallback
}

export const modelConnections = {
  async load() {
    if (!hasBridge()) return
    try {
      modelConnectionsStore.set({ snapshot: await getMako().modelConnections(), error: undefined })
    } catch (error) {
      modelConnectionsStore.set({ error: message({ error }, "Connections could not be loaded.") })
    }
  },

  async detectLocal() {
    if (!hasBridge()) return
    try {
      modelConnectionsStore.set({ local: await getMako().localModelServers() })
    } catch {
      modelConnectionsStore.set({ local: [] })
    }
  },

  /** What a key or endpoint lists, before anything is saved. Throws with the host's reason. */
  async check(input: ModelConnectionCheckInput): Promise<ModelConnectionCheck> {
    try {
      return await getMako().checkModelConnection(input)
    } catch (error) {
      throw new Error(message({ error }, "Couldn't check access. Try again."), { cause: error })
    }
  },

  async add(input: ModelConnectionInput) {
    try {
      const added = await getMako().addModelConnection(input)
      await modelConnections.load()
      return added
    } catch (error) {
      throw new Error(message({ error }, "The connection wasn't added. Try again."), { cause: error })
    }
  },

  async setEnabled(id: string, enabled: boolean) {
    await modelConnections.run(id, () => getMako().enableModelConnection(id, enabled))
  },

  async remove(id: string) {
    await modelConnections.run(id, () => getMako().removeModelConnection(id))
  },

  async test(id: string) {
    if (modelConnectionsStore.get().busy) return
    modelConnectionsStore.set({ busy: id })
    try {
      const result = await getMako().testModelConnection(id)
      modelConnectionsStore.set((state) => ({ tests: { ...state.tests, [id]: { result } } }))
    } catch (error) {
      modelConnectionsStore.set((state) => ({ tests: { ...state.tests, [id]: { error: message({ error }, "The test didn't finish. Try again.") } } }))
    } finally {
      modelConnectionsStore.set({ busy: undefined })
    }
  },

  dismissTest(id: string) {
    modelConnectionsStore.set((state) => {
      const tests = { ...state.tests }
      delete tests[id]
      return { tests }
    })
  },

  async run(id: string, work: () => Promise<void>) {
    if (modelConnectionsStore.get().busy) return
    modelConnectionsStore.set({ busy: id })
    try {
      await work()
      modelConnections.dismissTest(id)
      await modelConnections.load()
    } catch (error) {
      modelConnectionsStore.set((state) => ({ tests: { ...state.tests, [id]: { error: message({ error }, "That didn't work. Try again.") } } }))
    } finally {
      modelConnectionsStore.set({ busy: undefined })
    }
  },
}
