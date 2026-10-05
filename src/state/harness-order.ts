import { getMako } from "@/lib/bridge"
import { harnessOrder, isDefaultOrder } from "../../electron/contracts/harness-defaults"
import { providerStore, useProviders } from "./providers"
import { createHook, createStore, shallowEqual } from "./store"
import { threadsStore, useThreads } from "./thread-store"

/**
 * The order Mako tries harnesses in when it picks one itself: setting a
 * project up, drafting commit messages. The host keeps the person's order,
 * so every window reads the same one; until it answers, and until the
 * person reorders, it is Mako's own.
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
export function currentHarnessOrder(known?: readonly string[]): string[] {
  const descriptors = threadsStore.get().descriptors
  return harnessOrder(saved.get().order, known ? inMakoOrder(known, descriptors) : knownHarnesses(Object.keys(providerStore.get().profiles), descriptors))
}

/** `known` in the order the host describes harnesses in; any it doesn't describe follow. */
function inMakoOrder(known: readonly string[], descriptors: readonly { provider: string }[]): string[] {
  const described = descriptors.map((entry) => entry.provider)
  return [...described.filter((harness) => known.includes(harness)), ...known.filter((harness) => !described.includes(harness))]
}

/** Every registered harness in Mako's order, the host's descriptor order, listed before its catalog arrives. */
function knownHarnesses(profiles: readonly string[], descriptors: readonly { provider: string }[]): string[] {
  return [...new Set([...descriptors.map((entry) => entry.provider), ...profiles])]
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
  const known = knownHarnesses(Object.keys(providerStore.get().profiles), threadsStore.get().descriptors)
  const next = isDefaultOrder(order, known) ? [] : order
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
