import { cn } from "@/lib/utils"

/**
 * A tab of the terminal dock: a square cell, full height, with a hairline on
 * its right. A shown tab takes the terminal's own page colour and covers the
 * strip's bottom hairline, so it opens straight into the output below it.
 * Every pane of a visible split is shown; only the focused one is `active`.
 */
export function dockTab(shown: boolean, active = shown): string {
  return cn(
    "group relative flex h-full shrink-0 items-center gap-1 border-r border-hairline px-3 text-ui transition-[background-color,color] duration-150 ease-(--ease-out)",
    shown ? "bg-terminal" : "hover:bg-fill-hover",
    active ? "text-foreground" : shown ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/80 hover:text-foreground"
  )
}

/** A square icon cell at the end of the dock's strip, the same height as the tabs. */
export const dockTool =
  "pressable flex h-full w-9 shrink-0 items-center justify-center text-muted-foreground transition-[background-color,color] duration-150 hover:bg-fill-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-fill-selected data-[state=open]:text-foreground [&_svg]:size-4"

/** A text button inside one of the dock's bars: nearly square, no icon. */
export function dockButton(tone: "primary" | "plain"): string {
  return cn(
    "pressable inline-flex h-7 shrink-0 items-center rounded-xs px-3 text-ui font-medium whitespace-nowrap transition-[background-color,color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-40",
    tone === "primary"
      ? "bg-foreground text-terminal hover:bg-foreground/88"
      : "text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover"
  )
}
