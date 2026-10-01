import { memo } from "react"
import { HourglassIcon, LoaderCircleIcon, PlayIcon, TriangleAlertIcon } from "lucide-react"
import { appMarkOf, useThreadApp, type AppMark } from "@/state/thread-app"
import { cn } from "@/lib/utils"

function label(state: AppMark["state"], port: number | undefined): string {
  if (state === "running") return port === undefined ? "App running" : `App running on port ${port}`
  if (state === "starting") return "App starting"
  if (state === "waiting") return "App waiting for memory; it starts by itself once there's room"
  return "App crashed; its Thread has the log"
}

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
  const text = label(state, port)
  return (
    <span role="img" aria-label={text} data-tip={text} data-app-mark={state} className="flex shrink-0 items-center">
      {state === "running" ? <PlayIcon aria-hidden className={cn(icon, "fill-current text-positive")} strokeWidth={2.5} />
        : state === "starting" ? <LoaderCircleIcon aria-hidden className={cn(icon, "animate-spin text-faint")} strokeWidth={2.5} />
        : state === "waiting" ? <HourglassIcon aria-hidden className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />
        : <TriangleAlertIcon aria-hidden className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />}
    </span>
  )
})
