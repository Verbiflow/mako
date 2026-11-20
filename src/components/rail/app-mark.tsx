import { memo } from "react"
import { HourglassIcon, PlayIcon, TriangleAlertIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { appMarkOf, useThreadApp } from "@/state/thread-app"
import { appMarkLabel } from "@/lib/rail-marks"
import { cn } from "@/lib/utils"

/**
 * A checkout's app on the sidebar, with the strip's own icons: nothing while
 * it's stopped. A leaf with its own selector, so an app changing repaints one
 * icon, never the list. Its tip names the state.
 */
export const AppMarkIcon = memo(function AppMarkIcon({ checkout }: { checkout: string }) {
  const state = useThreadApp((store) => appMarkOf(store, checkout)?.state)
  const port = useThreadApp((store) => appMarkOf(store, checkout)?.port)
  if (!state) return null
  const icon = "size-3 shrink-0"
  const text = appMarkLabel(state, port)
  return (
    <span role="img" aria-label={text} data-tip={text} data-app-mark={state} className="flex shrink-0 items-center">
      {state === "running" ? <PlayIcon aria-hidden className={cn(icon, "fill-current text-positive")} strokeWidth={2.5} />
        : state === "starting" ? <Spinner aria-hidden className={cn(icon, "text-faint")} strokeWidth={2.5} />
        : state === "waiting" ? <HourglassIcon aria-hidden className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />
        : <TriangleAlertIcon aria-hidden className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />}
    </span>
  )
})
