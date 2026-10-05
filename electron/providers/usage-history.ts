import type { UsageScan } from "../usage-scan.js"
import type { ProviderCapability } from "./registry.js"

/**
 * Reads what a harness's own store says its sessions spent. A harness whose
 * store keeps no token counts declares none; the usage table then shows
 * what Mako measured while running it.
 */
export interface ProviderUsageHistory extends ProviderCapability {
  /** Records the last `DAYS` of calls; `truncated` when a bound left some unread. */
  scan(scan: UsageScan): Promise<{ truncated: boolean }>
}
