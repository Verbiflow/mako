import type { ReactNode } from "react"
import { observeVisibleAnimation } from "@/lib/visible-animation"
import { cn } from "@/lib/utils"

/**
 * Loading text with a crest of light running through it. One gradient
 * clipped to the words sweeps across them, so a label of any length, in any
 * number of parts, is one element and one paint, and it rests while it is
 * off screen. A part that colours itself keeps its colour only where motion
 * is reduced; elsewhere the sweep paints every part.
 */
export function Shimmer({ text, children, className }: { text?: string; children?: ReactNode; className?: string }) {
  return (
    <span ref={observeVisibleAnimation} className={cn("shimmer-text", className)}>
      {children ?? text}
    </span>
  )
}
