import { MARK } from "@/lib/git-marks"
import { cn } from "@/lib/utils"
import type { GitFileStatus } from "@/lib/types"

export function StatusLetter({ status, className }: { status: GitFileStatus; className?: string }) {
  const mark = MARK[status]
  return <span title={mark.title} className={cn("shrink-0 font-mono text-label leading-none font-semibold", mark.tone, className)}>{mark.glyph}</span>
}

/** Lines added and removed; nothing when neither is known. */
export function LineCounts({ insertions, deletions, className }: { insertions: number | null | undefined; deletions: number | null | undefined; className?: string }) {
  if (!insertions && !deletions) return null
  return (
    <span className={cn("tabular flex shrink-0 gap-1.5 text-label", className)}>
      {insertions ? <span className="text-added/80">+{insertions.toLocaleString()}</span> : null}
      {deletions ? <span className="text-removed/80">−{deletions.toLocaleString()}</span> : null}
    </span>
  )
}
