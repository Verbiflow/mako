import { getMako } from "@/lib/bridge"
import { harnessOrder, isDefaultOrder } from "../../electron/contracts/harness-defaults"
import { providerStore, useProviders } from "./providers"
import { createHook, createStore, shallowEqual } from "./store"
import { threadsStore, useThreads } from "./thread-store"

/**
 * The order Mako tries harnesses in when it picks one itself: setting a
 * project up, naming Threads, drafting commit messages. The host keeps the
 * person's order, since it names Threads with no window open; until it
 * answers, and until the person reorders, it is Mako's own.
 */
const saved = createStore<{ order: string[] }>({ order: [] })
const useSaved = createHook(saved)
let loading: Promise<void> | null = null

export function loadHarnessOrder(): Promise<void> {
  loading ??= getMako()
    .savedHarnessOrder()
    .then((order) => saved.set({ order }))
    .catch(() => {
      loading = null
    })
  return loading
}

/** These harnesses, by default every one Mako knows, in the person's order. */
export function currentHarnessOrder(known: readonly string[] = knownHarnesses(Object.keys(providerStore.get().profiles), threadsStore.get().descriptors)): string[] {
  return harnessOrder(saved.get().order, known)
}

/** Every registered harness, listed before its catalog arrives. */
function knownHarnesses(profiles: readonly string[], descriptors: readonly { provider: string }[]): string[] {
  return [...new Set([...profiles, ...descriptors.map((entry) => entry.provider)])]
}

/** The order the person saved; empty while it is Mako's own. */
export function useSavedHarnessOrder(): string[] {
  return useSaved((state) => state.order)
}

export function useHarnessOrder(): string[] {
  const profiles = useProviders((state) => Object.keys(state.profiles), shallowEqual)
  const descriptors = useThreads((state) => state.descriptors)
  const order = useSaved((state) => state.order)
  return harnessOrder(order, knownHarnesses(profiles, descriptors))
}

/** Save a new order; Mako's own is saved as none, so later defaults still reach it. */
export async function saveHarnessOrder(order: string[]): Promise<void> {
  const next = isDefaultOrder(order) ? [] : order
  const previous = saved.get().order
  saved.set({ order: next })
  try {
    await getMako().saveHarnessOrder(next)
  } catch (error) {
    saved.set({ order: previous })
    throw error
  }
}

export function subscribeHarnessOrder(listener: () => void): () => void {
  return saved.subscribe(listener)
}
