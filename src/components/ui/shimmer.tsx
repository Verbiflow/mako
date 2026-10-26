import { observeVisibleAnimation } from "@/lib/visible-animation"
import { cn } from "@/lib/utils"

/**
 * Loading text with a crest of light running through it. One gradient
 * clipped to the words sweeps across them, so a label of any length is one
 * element and one paint, and it rests while it is off screen.
 */
export function Shimmer({ text, className }: { text: string; className?: string }) {
  return (
    <span ref={observeVisibleAnimation} className={cn("shimmer-text", className)}>
      {text}
    </span>
  )
}
