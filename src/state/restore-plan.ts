import type { RestorePlan } from "@mako/host/contracts/restore-plan"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * The host's restore plan for each session the window shows that its
 * harness deleted and Mako keeps the records of: restore and resume
 * natively, or wait for the update the restore gate asks for. The host
 * decides (`mako:thread-restore-plan`); the window only shows it, and asks
 * again when a runtime reading changes, so an Update turns the offer back
 * into a native resume without a reload.
 */
interface RestorePlans {
  plans: Readonly<Record<string, RestorePlan>>
}

const store = createStore<RestorePlans>({ plans: {} })
export const useRestorePlans = createHook(store)

/** The newest request for each path; one answered after a newer request for the same path is dropped. */
const asked = new Map<string, number>()

export async function loadRestorePlan(path: string): Promise<void> {
  if (!hasBridge()) return
  const turn = (asked.get(path) ?? 0) + 1
  asked.set(path, turn)
  const plan = await getMako().restorePlan(path).catch((): RestorePlan => ({ kind: "none" }))
  if (asked.get(path) !== turn) return
  store.set((state) => ({ plans: { ...state.plans, [path]: plan } }))
}
