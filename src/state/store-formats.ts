import type { StoreFormats, StoreStandingRow } from "@mako/host/contracts/store-formats"
import type { ContinuationPlan } from "@mako/host/contracts/thread-continuation"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

export interface StoreFormatsState {
  /** Each shared store's format for this build, from the host; empty until the first answer. */
  stores: readonly StoreStandingRow[]
}

export const storeFormatsStore = createStore<StoreFormatsState>({ stores: [] })
export const useStoreFormats = createHook(storeFormatsStore)

/** The host's answer, at boot and whenever a newer Mako changes a store under it (`store-formats`). */
export function applyStoreFormats(formats: StoreFormats): void {
  storeFormatsStore.set({ stores: formats.stores })
}

export async function loadStoreFormats(): Promise<void> {
  if (!hasBridge()) return
  applyStoreFormats(await getMako().storeFormats())
}

/**
 * The host's continuation plan for each catalogued session the composer
 * shows while a newer Mako changed the session ledger: the plan decides
 * (`resumeLedger`, from the same rule the send asks), the window only says
 * it before a reply. Asked again whenever the stores' formats change, so an
 * update clears it without a reload.
 */
interface LedgerPlans {
  plans: Readonly<Record<string, ContinuationPlan>>
}

const ledgerPlans = createStore<LedgerPlans>({ plans: {} })
export const useLedgerPlans = createHook(ledgerPlans)

export async function loadLedgerPlan(path: string): Promise<void> {
  if (!hasBridge()) return
  const plan = await getMako().continuationPlan(path).catch((): ContinuationPlan => ({ transport: "unavailable", reason: "" }))
  ledgerPlans.set((state) => ({ plans: { ...state.plans, [path]: plan } }))
}
