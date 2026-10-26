import { MARK } from "@/lib/git-marks"
import { anyUnsure, UNSURE_MEANING, unsureWords, type Unsure } from "@/lib/turn-changes"
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

/** "2 lines not sure whose": what of a turn the journal can't put on anyone, counted apart wherever its changes are counted. */
export function UnsureCount({ unsure, className }: { unsure: Unsure; className?: string }) {
  if (!anyUnsure(unsure)) return null
  return (
    <span data-unsure-lines={unsure.lines} data-unsure-files={unsure.files || undefined} title={UNSURE_MEANING} className={cn("cursor-default text-faint", className)}>
      {unsureWords(unsure)}
    </span>
  )
}
