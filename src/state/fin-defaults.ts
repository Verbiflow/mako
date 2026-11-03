import type { SessionSettings } from "@mako/sessions/settings"
import type { FinChoicesReading } from "@mako/host/contracts/fin-tuning"
import { getMako } from "@/lib/bridge"
import { createHook, createStore } from "./store"

/**
 * Settings › Fins as the host keeps it (`mako:fin-defaults`): the person's
 * model for each harness's Fins, and the model they last used on each. The
 * host decides what a Fin runs on from it; a window only shows and changes it.
 */
const store = createStore<{ reading: FinChoicesReading | undefined; failed: boolean }>({ reading: undefined, failed: false })
export const useFinDefaults = createHook(store)

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
