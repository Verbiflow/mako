import { cn } from "@/lib/utils"

/**
 * A tab of the terminal dock: square and full height, because the tab strip
 * is structure. The selected one is marked by the dock's one sliding
 * indicator, never by a fill.
 */
export function dockTab(active: boolean): string {
  return cn(
    "group relative flex h-full shrink-0 items-center gap-1.5 px-2.5 text-ui transition-colors duration-150",
    active ? "text-foreground" : "text-faint hover:text-muted-foreground"
  )
}
