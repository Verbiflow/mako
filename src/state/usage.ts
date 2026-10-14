import type { ChangeUsage } from "@mako/host/contracts/thread-changes"
import { getMako, hasBridge } from "@/lib/bridge"
import type { UsageSummary } from "@/lib/types"

export function loadUsage(): Promise<UsageSummary | null> {
  return hasBridge() ? getMako().usage() : Promise.resolve(null)
}

/** What agents changed on this machine over the journal's window; null before the journal opens. */
export function loadChangeUsage(): Promise<ChangeUsage | null> {
  return hasBridge() ? getMako().changeUsage() : Promise.resolve(null)
}
