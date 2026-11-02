import { memo } from "react"
import { rollupLabel, type Rollup } from "@mako/host/contracts/children"
import { ApexMark } from "@/components/ui/apex-mark"
import { useThreadRollup } from "@/state/apex-fins"
import { cn } from "@/lib/utils"

/**
 * An Apex's Fins as two numbers and one bar, never as rows: how many need
 * the person, in caution, then all of them with each group's share drawn
 * under the count.
 */
export function RollupBadge({ counts, size = "rail" }: { counts: Rollup; size?: "rail" | "phone" }) {
  const parts: [number, string][] = [
    [counts.needs, "bg-caution"],
    [counts.working, "bg-muted-foreground"],
    [counts.queued, "bg-faint/50"],
    [counts.failed, "bg-negative/80"],
    [counts.done, "bg-positive/70"],
  ]
  const label = rollupLabel(counts)
  return (
    <span role="img" aria-label={label} title={label} data-rollup={counts.total} className="flex shrink-0 items-center gap-1">
      {counts.needs ? (
        <span className={cn("tabular flex min-w-4 items-center justify-center rounded bg-caution/15 px-1 text-label font-medium text-caution", size === "phone" ? "h-5" : "h-4")}>
          {counts.needs}
        </span>
      ) : null}
      <span className={cn("tabular flex items-center gap-1 rounded bg-fill-selected px-1 text-label text-muted-foreground", size === "phone" ? "h-5" : "h-4")}>
        <ApexMark className="size-3" />
        {counts.total}
        <span aria-hidden className="flex h-[3px] w-3.5 overflow-hidden rounded-full bg-foreground/10">
          {parts.map(([value, tone], index) => (value ? <span key={index} className={tone} style={{ width: `${(value / counts.total) * 100}%` }} /> : null))}
        </span>
      </span>
    </span>
  )
}

/** The badge a Thread's rail row wears while it is an Apex: it repaints only when a count moves. */
export const ThreadRollup = memo(function ThreadRollup({ thread, size }: { thread: string | undefined; size?: "rail" | "phone" }) {
  const counts = useThreadRollup(thread)
  return counts.total ? <RollupBadge counts={counts} size={size} /> : null
})
