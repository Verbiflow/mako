import { CircleAlertIcon, ClockIcon, TriangleAlertIcon } from "lucide-react"
import type { RequestRecovery } from "@/state/request-recovery"

/**
 * The mark a failed message wears wherever it's said, the row and the line
 * above the composer alike: a clock for a limit that resets at a known time,
 * a warning for a wait or an unconfirmed outcome, an alert for a fault.
 */
export function recoveryGlyph(recovery: Pick<RequestRecovery, "description" | "tone">) {
  if (recovery.description) return { icon: ClockIcon, className: "text-caution" }
  return recovery.tone === "danger" ? { icon: CircleAlertIcon, className: "text-negative" } : { icon: TriangleAlertIcon, className: "text-caution" }
}
