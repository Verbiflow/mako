import { Spinner } from "@/components/ui/spinner"
import { PULL_THRESHOLD } from "./pull"

/** The spinner in the gap a pull opens: still and fading in with the distance, turning once let go to refresh. */
export function PullIndicator({ pulled, refreshing }: { pulled: number; refreshing: boolean }) {
  if (!pulled && !refreshing) return null
  const progress = refreshing ? 1 : Math.min(pulled / PULL_THRESHOLD, 1)
  return (
    <div aria-hidden={!refreshing} role={refreshing ? "status" : undefined} aria-label={refreshing ? "Refreshing" : undefined} className="pointer-events-none absolute inset-x-0 top-0 flex h-12 items-center justify-center" style={{ opacity: progress }}>
      <Spinner turning={refreshing} className="size-5 text-muted-foreground" style={refreshing ? undefined : { transform: `rotate(${progress * 270}deg)` }} />
    </div>
  )
}
