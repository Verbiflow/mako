import { LoaderCircleIcon, PlayIcon, SquareArrowOutUpRightIcon } from "lucide-react"
import { StatusDot, type AppView } from "@/components/inspector/app-panel"
import { cn } from "@/lib/utils"

const part = "pressable flex h-6 shrink-0 items-center gap-1.5 px-2 text-label whitespace-nowrap transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"

/**
 * This Thread's app in its strip. Quiet, and absent until there's something
 * to say: a project with no recipe shows nothing here; its App tab explains.
 */
export function AppStatus({ view, onPanel, onOpen, onStart, open }: {
  view: AppView
  onPanel: () => void
  onOpen: () => void
  onStart: () => void
  /** The App tab is showing. */
  open?: boolean
}) {
  const frame = cn("flex h-6 shrink-0 items-center overflow-hidden rounded-md", open && "bg-fill-hover")
  const port = view.processes.find((process) => process.port !== undefined)?.port
  switch (view.state) {
    case "none":
      return null
    case "setting-up":
      return (
        <div className={frame}>
          <button type="button" className={cn(part, "text-faint")} onClick={onPanel}>
            <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" />Setting up app
          </button>
        </div>
      )
    case "stopped":
      return (
        <div className={frame}>
          <button type="button" aria-label="Start this Thread's app" className={cn(part, "text-faint")} onClick={onStart}>
            <PlayIcon className="size-3 fill-current" />Run app
          </button>
        </div>
      )
    case "preparing":
    case "starting":
      return (
        <div className={frame}>
          <button type="button" className={cn(part, "text-muted-foreground")} onClick={onPanel}>
            <StatusDot state="starting" className="size-1.5" />{view.state === "preparing" ? "Installing" : "Starting"}
          </button>
        </div>
      )
    case "running":
      return (
        <div className={cn(frame, "ring-1 ring-hairline ring-inset")}>
          <button type="button" aria-label={`This Thread's app is running${port ? ` on port ${port}` : ""}; show it`} className={cn(part, "pr-1.5 text-muted-foreground")} onClick={onPanel}>
            <StatusDot state="running" className="size-1.5" />App{port ? <span className="text-faint tabular-nums">:{port}</span> : null}
          </button>
          <span className="h-3.5 w-px bg-hairline" />
          <button type="button" aria-label="Open the app" title="Open the app" className={cn(part, "px-1.5 text-faint")} onClick={onOpen}>
            <SquareArrowOutUpRightIcon className="size-3" />
          </button>
        </div>
      )
    case "crashed":
      return (
        <div className={frame}>
          <button type="button" className={cn(part, "text-negative hover:text-negative")} onClick={onPanel}>
            <StatusDot state="crashed" className="size-1.5" />App crashed
          </button>
        </div>
      )
    case "waiting":
      return (
        <div className={frame}>
          <button type="button" className={cn(part, "text-caution hover:text-caution")} onClick={onPanel}>
            <StatusDot state="waiting" className="size-1.5" />Waiting for memory
          </button>
        </div>
      )
  }
}
