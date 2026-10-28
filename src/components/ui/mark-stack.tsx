import type { CSSProperties, ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * A Thread's harnesses, one mark per Session, the first Session's first: each mark a third over the last, and each cut
 * away where the next overlaps it (`.mark-stack`), so whatever the row is painted with shows in the gap and two of the
 * same harness read as two. No disc behind them. The rail and the phone's list draw the same stack, at their own size.
 */
export function MarkStack({ size, className, children }: { size?: number; className?: string; children: ReactNode }) {
  return (
    // SAFETY: a custom property is a style React passes through as it's named; CSSProperties lists only the standard ones.
    <span aria-hidden className={cn("mark-stack", className)} style={size ? ({ "--mark": `${size}px` } as CSSProperties) : undefined}>
      {children}
    </span>
  )
}

/** One mark of a stack: what `.mark-stack` cuts away where the next one sits over it. `arrived`: joined while seen. */
export function StackedMark({ arrived, children }: { arrived?: boolean; children: ReactNode }) {
  return (
    <span data-new={arrived || undefined} className="thread-glyph flex">
      {children}
    </span>
  )
}
