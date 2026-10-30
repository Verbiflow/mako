import type { CSSProperties, ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * A Thread's harnesses, one mark per Session, the first Session's first: each mark whole, side by side a hairline apart
 * (`.mark-stack`), so every mark reads as itself at any size and two of the same harness read as two. No disc behind
 * them. The rail and the phone's list draw the same stack, at their own size.
 */
export function MarkStack({ size, className, children }: { size?: number; className?: string; children: ReactNode }) {
  return (
    // SAFETY: a custom property is a style React passes through as it's named; CSSProperties lists only the standard ones.
    <span aria-hidden className={cn("mark-stack", className)} style={size ? ({ "--mark": `${size}px` } as CSSProperties) : undefined}>
      {children}
    </span>
  )
}

/** One mark of a stack, drawn at the stack's size. `arrived`: joined while seen. */
export function StackedMark({ arrived, children }: { arrived?: boolean; children: ReactNode }) {
  return (
    <span data-new={arrived || undefined} className="thread-glyph flex">
      {children}
    </span>
  )
}
