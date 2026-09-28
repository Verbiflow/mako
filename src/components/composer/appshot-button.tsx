import { useState } from "react"
import {
  CameraIcon,
  LoaderCircleIcon,
  MonitorIcon,
  SearchIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { ComposerControlSlotProps } from "@/extend/slots"
import type { AppshotWindow } from "@/lib/types"
import { appshots } from "@/state/appshots"

type Windows =
  | { kind: "loading" }
  | { kind: "ready"; windows: AppshotWindow[] }
  | { kind: "error"; message: string }

export function AppshotButton({
  attachFiles,
  disabled,
  dismiss,
}: ComposerControlSlotProps) {
  const [open, setOpen] = useState(false)
  const [windows, setWindows] = useState<Windows>({ kind: "loading" })
  const [query, setQuery] = useState("")
  const [capturing, setCapturing] = useState<string | null>(null)
  const show = async (next: boolean) => {
    setOpen(next)
    if (!next) return
    setQuery("")
    setWindows({ kind: "loading" })
    try {
      setWindows({ kind: "ready", windows: await appshots.windows() })
    } catch (error) {
      setWindows({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Windows could not be listed.",
      })
    }
  }
  const capture = async (window: AppshotWindow) => {
    setOpen(false)
    setCapturing(window.app)
    dismiss?.()
    try {
      // Let the chooser leave the captured window before taking its image.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      await attachFiles(await appshots.capture({ pid: window.pid, windowId: window.windowId }))
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The appshot could not be captured."
      )
    } finally {
      setCapturing(null)
    }
  }
  const matches =
    windows.kind === "ready"
      ? windows.windows.filter((window) =>
          `${window.app} ${window.title}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
        )
      : []
  return (
    <Popover open={open} onOpenChange={(next) => void show(next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Attach a screenshot"
          className="pressable flex min-h-9 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-ui text-foreground hover:bg-fill-hover focus-visible:bg-fill-hover disabled:opacity-40"
          disabled={disabled || capturing !== null}
        >
          {capturing ? (
            <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
          ) : (
            <CameraIcon className="size-4 text-muted-foreground" />
          )}
          {capturing ? `Capturing ${capturing}` : "Attach a screenshot"}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        aria-label="Attach appshot"
        className="w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border border-border p-0"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-faint" />
          <input
            aria-label="Find a window"
            placeholder="Find a window…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint"
          />
          <span className="shrink-0 text-label text-faint">Appshot</span>
        </div>
        <div className="max-h-96 overflow-y-auto overscroll-contain p-2">
          {windows.kind === "loading" && (
            <p
              role="status"
              className="flex h-36 items-center justify-center gap-2 text-ui text-muted-foreground"
            >
              <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
              Finding windows…
            </p>
          )}
          {windows.kind === "error" && (
            <p role="alert" className="p-3 text-ui text-muted-foreground">
              {windows.message}
            </p>
          )}
          {windows.kind === "ready" && matches.length === 0 && (
            <p className="p-5 text-center text-ui text-muted-foreground">
              {query ? "No matching windows" : "No visible windows to capture"}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1">
            {matches.map((window) => (
              <button
                key={`${window.pid}:${window.windowId}`}
                type="button"
                onClick={() => void capture(window)}
                className="pressable group min-w-0 rounded-lg p-1.5 text-left outline-none hover:bg-fill-hover focus-visible:bg-fill-selected"
                aria-label={`Capture ${window.app}: ${window.title || "Window"}`}
              >
                <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md border border-hairline bg-background">
                  {window.thumbnail ? (
                    <img
                      src={`data:${window.thumbnail.mimeType};base64,${window.thumbnail.data}`}
                      alt=""
                      decoding="async"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <MonitorIcon className="size-6 text-faint" />
                  )}
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-1.5">
                  {window.icon ? (
                    <img
                      src={`data:${window.icon.mimeType};base64,${window.icon.data}`}
                      alt=""
                      className="size-4 shrink-0"
                    />
                  ) : (
                    <MonitorIcon className="size-3.5 shrink-0 text-faint" />
                  )}
                  <span className="truncate text-ui font-medium">
                    {window.app}
                  </span>
                </div>
                <p
                  className="mt-0.5 truncate text-label text-muted-foreground"
                  title={window.title}
                >
                  {window.title || "Window"}
                </p>
              </button>
            ))}
          </div>
        </div>
        <p className="border-t border-hairline px-3 py-2 text-label text-faint">
          Adds the window image and readable text to your draft
        </p>
      </PopoverContent>
    </Popover>
  )
}
