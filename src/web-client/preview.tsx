import { useEffect, useRef, useState } from "react"
import { ExternalLinkIcon, GlobeIcon, PlayIcon, RotateCwIcon } from "lucide-react"
import type { AppActionOutcome, ThreadAppView } from "@mako/host/contracts/thread-app"
import { Spinner } from "@/components/ui/spinner"
import { useWebClient, type WebClient } from "./client"
import { Sheet } from "./sheet"
import { ownerCall, previewAddress, type Owner } from "./start"

type Stage =
  | { kind: "asking" }
  | { kind: "none"; reason: string }
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "open"; url: string; port: number }
  | { kind: "failed"; reason: string }

/** The app's view as a phone says it: running at a port, stopped, or not set up, in a sentence. */
function stageOf(view: ThreadAppView): Stage {
  if (view.kind === "none") return { kind: "none", reason: "This project's app isn't set up yet. Set it up from a Mac, and it opens here after." }
  if (view.kind === "invalid") return { kind: "none", reason: view.message }
  if (view.kind === "setting-up") return { kind: "none", reason: "Its app is being set up. It opens here once it runs." }
  // A cloud machine asleep: running the app wakes it.
  if (view.kind === "asleep") return { kind: "stopped" }
  if (view.address && (view.phase === "running" || view.phase === "starting")) return { kind: "open", url: "", port: view.address.port }
  if (view.phase === "stopped" || view.phase === "crashed") return { kind: "stopped" }
  return { kind: "starting" }
}

/** Where the app stands, asked of its owner: running (and its address), stopped, or not set up, in a sentence. */
async function appStage(client: WebClient, owner: Owner, folder: string | undefined): Promise<Stage> {
  if (!folder) return { kind: "none", reason: "This Session has no folder to run an app in." }
  try {
    const next = stageOf(await ownerCall<ThreadAppView>(client.gateway, client.deviceId, owner, "mako:thread-app", [folder]))
    return next.kind === "open" ? { ...next, url: await previewAddress(client.gateway, owner, next.port) } : next
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The app in a sheet that fills the screen: the page itself, under a slim bar with its address, reload and Open in
 * browser. Drag the bar down to close it. A stopped app can be started from here; one not set up says so.
 */
export function PreviewSheet({ open, onDismiss, owner, folder, title }: { open: boolean; onDismiss: () => void; owner: Owner; folder: string | undefined; title: string }) {
  const client = useWebClient()
  const [stage, setStage] = useState<Stage>({ kind: "asking" })
  const [asked, setAsked] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  // Asked of the owner each time it opens, or is asked again (reload, after Run): set only once the owner answers.
  useEffect(() => {
    if (!open) return
    let live = true
    void appStage(client, owner, folder).then((next) => live && setStage(next))
    return () => {
      live = false
    }
  }, [open, asked, client, owner, folder])
  const again = () => setAsked((count) => count + 1)
  const dismiss = () => {
    setStage({ kind: "asking" })
    onDismiss()
  }
  const run = async () => {
    if (!folder) return
    setStage({ kind: "starting" })
    try {
      await ownerCall<AppActionOutcome>(client.gateway, client.deviceId, owner, "mako:thread-app-start", [folder])
      again()
    } catch (error) {
      setStage({ kind: "failed", reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <Sheet open={open} onDismiss={dismiss} label={`${title}: its app`} className="web-preview-sheet">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <GlobeIcon aria-hidden className="ml-2 size-4 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">{stage.kind === "open" ? `${title} · port ${stage.port}` : title}</span>
        {stage.kind === "open" ? (
          <>
            <button type="button" aria-label="Reload" className="web-icon-button size-10" onClick={again}>
              <RotateCwIcon className="size-4" />
            </button>
            <a aria-label="Open in browser" className="web-icon-button size-10" href={stage.url} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon className="size-4" />
            </a>
          </>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-t-xl bg-surface ring-1 ring-hairline">
        {stage.kind === "open" ? (
          <iframe ref={frame} key={stage.url} src={stage.url} title={`${title}: its app`} className="size-full border-0 bg-white" allow="clipboard-write; fullscreen" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
            {stage.kind === "asking" || stage.kind === "starting" ? (
              <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
                <Spinner className="size-4" />
                {stage.kind === "asking" ? "Finding its app…" : "Starting its app…"}
              </p>
            ) : stage.kind === "stopped" ? (
              <>
                <p className="text-ui text-muted-foreground">Its app isn't running.</p>
                <button type="button" className="web-button" onClick={() => void run()}>
                  <PlayIcon className="size-4 fill-current" strokeWidth={0} />
                  Run app
                </button>
              </>
            ) : (
              <p className="max-w-[320px] text-ui text-muted-foreground">{stage.reason}</p>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}
