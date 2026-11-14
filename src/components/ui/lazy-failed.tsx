import { CloudOffIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A piece read as code of its own (a preview, a viewer) whose code couldn't arrive: one line saying so where it would
 * draw, with Reload, which reads it afresh even where the browser keeps a dynamic import it failed once. Drawn by a
 * `LazyBoundary` in place of the window's error screen.
 */
export function LazyFailed({ what, className }: { what: string; className?: string }) {
  return (
    <div role="alert" data-lazy-failed="" className={cn("flex items-center gap-2 p-4 text-ui text-faint", className)}>
      <CloudOffIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{what} couldn't load.</span>
      <button type="button" className="pressable h-7 shrink-0 border border-hairline px-2.5 text-ui text-foreground" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  )
}
