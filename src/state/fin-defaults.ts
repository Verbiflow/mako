import type { SessionSettings } from "@mako/sessions/settings"
import type { FinChoicesReading, FinPolicy, RoleRules } from "@mako/host/contracts/fin-tuning"
import { getMako } from "@/lib/bridge"
import { createHook, createStore } from "./store"

/**
 * Settings › Fins as the host keeps it (`mako:fin-defaults`): the person's
 * model for each harness's Fins, the model they last used on each, and how
 * many Fins run at once. The
 * host decides what a Fin runs on from it; a window only shows and changes it.
 */
const store = createStore<{ reading: FinChoicesReading | undefined; failed: boolean }>({ reading: undefined, failed: false })
export const useFinDefaults = createHook(store)
export const finDefaultsStore = store

export function loadFinDefaults(): Promise<void> {
  return getMako()
    .finDefaults()
    .then((reading) => store.set({ reading, failed: false }))
    .catch(() => store.set({ failed: true }))
}

/** Fins on `harness` run on `settings`, or with null, on what the person uses there. Shown at once, put back if the host refuses. */
export async function chooseFinDefault(harness: string, settings: SessionSettings | null): Promise<void> {
  const before = store.get().reading
  if (before) {
    const chosen = { ...before.chosen }
    if (settings) chosen[harness] = settings
    else delete chosen[harness]
    store.set({ reading: { ...before, chosen } })
  }
  try {
    store.set({ reading: await getMako().chooseFinDefault(harness, settings) })
  } catch (error) {
    store.set({ reading: before })
    throw error
  }
}

/** Whether a Fin whose account runs out goes on to the next one: shown at once, put back if the host refuses. */
export async function chooseMoveOnLimit(on: boolean): Promise<void> {
  const before = store.get().reading
  if (before) store.set({ reading: { ...before, moveOnLimit: on } })
  try {
    store.set({ reading: await getMako().chooseFinMoveOnLimit(on) })
  } catch (error) {
    store.set({ reading: before })
    throw error
  }
}

/** The person's standing rules for one role, saved alone: shown at once, put back if the host refuses them. */
export async function saveRoleRules(role: RoleRules, text: string): Promise<void> {
  const before = store.get().reading
  if (before) store.set({ reading: { ...before, policy: { ...before.policy, [role]: text || undefined } } })
  try {
    store.set({ reading: await getMako().saveRoleRules(role, text) })
  } catch (error) {
    store.set({ reading: before })
    throw error
  }
}

/** The person's rules, saved whole: shown at once, put back if the host refuses them. */
export async function saveFinPolicy(policy: FinPolicy): Promise<void> {
  const before = store.get().reading
  if (before) store.set({ reading: { ...before, policy } })
  try {
    store.set({ reading: await getMako().saveFinPolicy(policy) })
  } catch (error) {
    store.set({ reading: before })
    throw error
  }
}

/** This Mac's own number of Fins at once, or with null its capacity (Auto): shown at once, put back if the host refuses it. */
export async function setFinLimit(limit: number | null): Promise<void> {
  const before = store.get().reading
  if (before) {
    const next = { ...before }
    if (limit === null) delete next.limit
    else next.limit = limit
    store.set({ reading: next })
  }
  try {
    store.set({ reading: await getMako().setFinLimit(limit) })
  } catch (error) {
    store.set({ reading: before })
    throw error
  }
}

/** The person's Fins at once across every place: shown at once, put back if the host refuses it. */
export async function setFinCeiling(ceiling: number): Promise<void> {
  const before = store.get().reading
  if (before) store.set({ reading: { ...before, ceiling } })
  try {
    store.set({ reading: await getMako().setFinCeiling(ceiling) })
  } catch (error) {
    store.set({ reading: before })
    throw error
  }
}
