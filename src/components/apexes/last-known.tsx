import { stoodFor } from "@mako/host/contracts/children"
import { useTickingText } from "@/components/ui/second-clock"
import { cn } from "@/lib/utils"

/** That what's shown is the last its device said, and how long that device has been off. It goes once it's back. */
export function LastKnownLine({ device, since, className }: { device: string; since: string; className?: string }) {
  const at = Date.parse(since)
  const when = useTickingText(Number.isFinite(at), (now) => (Number.isFinite(at) ? stoodFor(now - at) : ""))
  return (
    <span data-apex-last-known={since} className={cn("pt-1 text-label text-faint", className)}>
      Last known · {device} off{when ? ` for ${when}` : ""}
    </span>
  )
}
