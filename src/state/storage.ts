import type { StorageReport } from "@mako/host/contracts/storage"
import { getMako, hasBridge } from "@/lib/bridge"

const NOTHING: StorageReport = { at: null, disk: null, lowBytes: 0, parts: [], collections: [], measuring: false, collecting: false }

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
