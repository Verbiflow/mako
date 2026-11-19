import type { StorageBudgetSettings, StorageReport } from "@mako/host/contracts/storage"
import { getMako, hasBridge } from "@/lib/bridge"

const NOTHING: StorageReport = {
  at: null, disk: null, lowBytes: 0, parts: [], collections: [], measuring: false, collecting: false,
  plan: null, planning: false, reclaiming: false, reclaims: [], budget: { autoFree: true },
}

/** What Mako keeps, measured again when `measure` is set. */
export async function readStorage(measure: boolean): Promise<StorageReport> {
  if (!hasBridge()) return NOTHING
  return getMako().storage(measure)
}

/** What every collector can free now, then measured again. */
export async function freeStorage(): Promise<StorageReport> {
  if (!hasBridge()) return NOTHING
  return getMako().freeStorage()
}

/** Starts a preview of what each store could give back; the report says `planning` until it's in. */
export async function planStorage(): Promise<StorageReport> {
  if (!hasBridge()) return NOTHING
  return getMako().planStorage()
}

/** Removes the previewed folders chosen, within what the person agreed to; the report says `reclaiming` meanwhile. */
export async function reclaimStorage(consent: "now" | "approve", ids: string[]): Promise<StorageReport> {
  if (!hasBridge()) return NOTHING
  return getMako().reclaimStorage(consent, ids)
}

export async function setStorageBudget(settings: StorageBudgetSettings): Promise<StorageReport> {
  if (!hasBridge()) return NOTHING
  return getMako().setStorageBudget(settings)
}
