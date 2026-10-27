import type { ChangeUsage } from "@mako/host/contracts/thread-changes"
import { UsageSummarySchema } from "@mako/host/contracts/automations-usage-updates"
import { getMako, hasBridge } from "@/lib/bridge"
import type { UsageSummary } from "@/lib/types"

/** A host from before usage was read by window answers in the old shape; the page says so instead of drawing nothing. */
export class UsageFromOlderHostError extends Error {
  constructor() {
    super("This host reads usage the way an earlier Mako did. Restart Mako to see it by day and by harness.")
    this.name = "UsageFromOlderHostError"
  }
}

export async function loadUsage(): Promise<UsageSummary | null> {
  if (!hasBridge()) return null
  const parsed = UsageSummarySchema.safeParse(await getMako().usage())
  if (!parsed.success) throw new UsageFromOlderHostError()
  return parsed.data
}

/** What agents changed on this machine over the journal's window; null before the journal opens. */
export function loadChangeUsage(): Promise<ChangeUsage | null> {
  return hasBridge() ? getMako().changeUsage() : Promise.resolve(null)
}
