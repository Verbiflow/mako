import type { ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * The one line everything between two messages folds behind: a chevron where every row of work keeps its glyph, the
 * line's words, then quieter what the work was. Quiet at rest; `strong` while something behind it ended badly and
 * hasn't been read, `caution` when the turn was cut. One row of fixed height, so opening it moves nothing above it.
 */
export function FoldLine({ title, detail, open, strong, caution, onToggle, children, ...data }: {
  title: string
  detail?: string
  open: boolean
  strong?: boolean
  caution?: boolean
  onToggle: () => void
  /** What stands right after the words, before what the work was: how the calls behind it ended. */
  children?: ReactNode
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "pressable group/fold -mx-1.5 flex h-7 max-w-full items-center gap-2 self-start px-1.5 text-ui transition-colors duration-100 hover:bg-fill-hover",
        caution ? "text-caution" : strong ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
      )}
      {...data}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-faint transition-[transform,color] duration-200 ease-[var(--ease-out)] group-hover/fold:text-muted-foreground",
          open && "rotate-90"
        )}
      />
      <span data-fold-title className={cn("truncate", detail ? "max-w-[70%] shrink-0" : "min-w-0")}>{title}</span>
      {children}
      {detail ? <span className="min-w-0 truncate font-normal text-faint">{detail}</span> : null}
    </button>
  )
}
