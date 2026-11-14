import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { LazyFailed } from "./lazy-failed"
import { usePatience } from "./use-patience"

/**
 * A preview's Suspense fallback with a patience: its own loading look (a skeleton, "Loading document…") while its code
 * is on its way; past `CODE_PATIENCE_MS` the same look with "Still loading …" and Reload, the download still under way,
 * not failed; offline, the failure line. A preview that arrives draws in its place, as ever.
 */
export function PatientFallback({ what, children, className }: { what: string; children: ReactNode; className?: string }) {
  const late = usePatience()
  if (late === "offline") return <LazyFailed what={what.charAt(0).toUpperCase() + what.slice(1)} />
  if (late === "waiting") return children
  return (
    <div data-lazy-slow="" className={cn("flex min-w-0 flex-col", className)}>
      {children}
      <p aria-live="polite" className="flex items-center gap-2 px-4 py-2 text-ui text-faint">
        <span>Still loading {what}…</span>
        <button type="button" className="pressable h-7 shrink-0 border border-hairline px-2.5 text-ui text-foreground" onClick={() => location.reload()}>
          Reload
        </button>
      </p>
    </div>
  )
}
