import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ChevronRightIcon, ExternalLinkIcon, GlobeIcon, PlayIcon, RotateCwIcon, XIcon } from "lucide-react"
import type { AppActionOutcome } from "@mako/host/contracts/thread-app"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useWebClient } from "./client"
import { appKey, closePreview, PreviewRefused, readApp, serverAddress, useApps, usePreviewAsk, withPath, type PreviewServer, type ServerState, type ThreadApp } from "./previews"
import { Sheet } from "./sheet"
import { ownerCall, type Owner } from "./start"

/** The sizes a page is shown at, as the device it's for would show it; scaled down to fit where the sheet is narrower. */
const VIEWPORTS = [
  { id: "phone", label: "Phone", width: 390 },
  { id: "tablet", label: "Tablet", width: 820 },
  { id: "desktop", label: "Desktop", width: 1280 },
] as const
type Viewport = (typeof VIEWPORTS)[number]["id"]

const STATE_WORDS = { ready: "Ready", starting: "Starting…", stopped: "Stopped" } satisfies Record<ServerState, string>

/** One of a Thread's servers as a card: its address, its name and how it stands, opening its preview. */
export function ServerCard({ server, onOpen, refused, compact = false }: { server: PreviewServer; onOpen: () => void; refused?: string; compact?: boolean }) {
  return (
    <button type="button" onClick={onOpen} data-preview-server={server.port} data-state={server.state} className={cn("web-server pressable", compact && "web-server-compact")}>
      <span className="web-server-mark" aria-hidden>
        {server.state === "starting" ? <Spinner className="size-3.5" /> : <GlobeIcon className="size-4" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-ui font-medium text-foreground">localhost:{server.port}</span>
        <span className={cn("truncate text-label", refused ? "text-caution" : "text-faint")}>
          {server.name} · {refused ?? STATE_WORDS[server.state]}
        </span>
      </span>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-faint" />
    </button>
  )
}

/** What the sheet shows, as one thing at a time. */
type Stage =
  | { kind: "asking" }
  | { kind: "choose"; servers: PreviewServer[] }
  | { kind: "starting"; server: PreviewServer }
  | { kind: "stopped" }
  | { kind: "open"; server: PreviewServer | undefined; port: number; url: string }
  | { kind: "said"; words: string; tooMany?: boolean }

/** Which stage an app's servers and the ask make: a chosen server, the only one, or a choice of several. */
function stageOf(app: ThreadApp | undefined, port: number | undefined, owner: Owner): Exclude<Stage, { kind: "open" }> | { kind: "address"; server: PreviewServer | undefined; port: number } {
  if (!app) return { kind: "asking" }
  const chosen = port === undefined ? undefined : app.servers.find((server) => server.port === port)
  if (port !== undefined && !chosen) {
    // A cloud machine serves any port of its own; a Mac only its app's, the ones its recipe runs.
    if (owner.kind === "cloud") return { kind: "address", server: undefined, port }
    return { kind: "said", words: `Nothing of this Thread's app listens on port ${port}. A phone opens the ports its app runs on; a server started by hand opens on the Mac.` }
  }
  const server = chosen ?? (app.servers.length === 1 ? app.servers[0] : undefined)
  if (!server) {
    if (app.servers.length > 1) return { kind: "choose", servers: app.servers }
    if (app.runnable) return { kind: "stopped" }
    return { kind: "said", words: app.reason ?? "Its app isn't running." }
  }
  if (server.state === "starting") return { kind: "starting", server }
  if (server.state === "stopped") return app.runnable ? { kind: "stopped" } : { kind: "said", words: `${server.name} stopped.` }
  return { kind: "address", server, port: server.port }
}

/**
 * A Thread's app, full screen: the page itself under a slim bar with its address, Phone / Tablet / Desktop, Reload and
 * Open in browser, and Close; drag the bar down to close it. Opened from the capsule, a card or a link in the
 * transcript (`askPreview`); several servers open on a choice of them. The page runs on an origin of its own and stays
 * loaded while the sheet shows; hidden (the page put away), it's let go and loaded again on the way back.
 */
export function PreviewSheet({ conversation, owner, folder, title }: { conversation: string; owner: Owner; folder: string | undefined; title: string }) {
  const client = useWebClient()
  const ask = usePreviewAsk((state) => (state.conversation === conversation ? state.ask : undefined))
  const open = ask !== undefined
  const key = folder ? appKey(owner, folder) : undefined
  const app = useApps((state) => (key ? state.apps.get(key) : undefined))
  const [picked, setPicked] = useState<number | undefined>(undefined)
  const [opened, setOpened] = useState<{ port: number; url: string } | undefined>(undefined)
  const [refusal, setRefusal] = useState<{ words: string; tooMany: boolean } | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [reloads, setReloads] = useState(0)
  const [viewport, setViewport] = useState<Viewport>("phone")
  const visible = usePageVisible()
  // Each ask starts afresh: the server or link it names, read of the app at once.
  const [askedAt, setAskedAt] = useState<number | undefined>(undefined)
  if (ask && ask.at !== askedAt) {
    setAskedAt(ask.at)
    setPicked(ask.port)
    setOpened(undefined)
    setRefusal(undefined)
  }
  useEffect(() => {
    if (open && folder) void readApp(client, owner, folder)
    // Asked again with each ask; the Thread's own follow keeps it current while the sheet shows.
  }, [open, askedAt, client, owner, folder])
  const port = picked ?? ask?.port
  const next = folder ? stageOf(app, port, owner) : ({ kind: "said", words: "This Session has no folder to run an app in." } as const)
  const want = next.kind === "address" ? next.port : undefined
  useEffect(() => {
    if (!open || want === undefined || opened?.port === want) return
    let live = true
    serverAddress(client, owner, want).then(
      (url) => live && setOpened({ port: want, url: withPath(url, ask?.port === want ? (ask.path ?? "") : "") }),
      (error) => live && setRefusal({ words: error instanceof Error ? error.message : String(error), tooMany: error instanceof PreviewRefused && error.tooMany })
    )
    return () => {
      live = false
    }
  }, [open, want, opened?.port, client, owner, ask])
  const stage: Stage = refusal
    ? { kind: "said", words: refusal.words, tooMany: refusal.tooMany }
    : next.kind === "address"
      ? opened?.port === next.port
        ? { kind: "open", server: next.server, port: next.port, url: opened.url }
        : { kind: "asking" }
      : running
        ? { kind: "asking" }
        : next
  const run = async () => {
    if (!folder) return
    setRunning(true)
    try {
      await ownerCall<AppActionOutcome>(client.gateway, client.deviceId, owner, "mako:thread-app-start", [folder])
      await readApp(client, owner, folder)
    } catch (error) {
      setRefusal({ words: error instanceof Error ? error.message : String(error), tooMany: false })
    } finally {
      setRunning(false)
    }
  }
  const dismiss = () => {
    closePreview()
    setPicked(undefined)
  }
  const address = stage.kind === "open" ? `localhost:${stage.port}` : title
  return (
    <Sheet open={open} onDismiss={dismiss} label={`${title}: its app`} className="web-preview">
      <div className="web-preview-bar">
        <GlobeIcon aria-hidden className="ml-1 size-4 shrink-0 text-faint" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium">{address}</span>
          {stage.kind === "open" && stage.server ? <span className="truncate text-label text-faint">{stage.server.name} · {title}</span> : null}
        </span>
        {stage.kind === "open" ? (
          <>
            <button type="button" aria-label="Reload" className="web-icon-button size-10" onClick={() => setReloads((count) => count + 1)}>
              <RotateCwIcon className="size-4" />
            </button>
            <a aria-label="Open in browser" className="web-icon-button size-10" href={stage.url} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon className="size-4" />
            </a>
          </>
        ) : null}
        <button type="button" aria-label="Close" className="web-icon-button size-10" onClick={dismiss}>
          <XIcon className="size-4" />
        </button>
      </div>
      {stage.kind === "open" ? (
        <div role="radiogroup" aria-label="Show it as" className="web-viewports">
          {VIEWPORTS.map((each) => (
            <button key={each.id} type="button" role="radio" aria-checked={viewport === each.id} onClick={() => setViewport(each.id)} className={cn("web-viewport pressable", viewport === each.id && "web-viewport-on")}>
              {each.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="web-preview-page">
        {stage.kind === "open" ? (
          visible ? (
            <Framed key={`${stage.url}:${reloads}`} url={stage.url} title={`${title}: its app`} width={VIEWPORTS.find((each) => each.id === viewport)!.width} />
          ) : (
            <p className="web-preview-said">Paused while Mako is in the background.</p>
          )
        ) : stage.kind === "choose" ? (
          <div className="flex flex-col gap-2 p-3">
            <p className="px-1 pb-1 text-label text-muted-foreground">Its app runs {stage.servers.length} servers. Open one:</p>
            {stage.servers.map((server) => (
              <ServerCard key={server.port} server={server} onOpen={() => setPicked(server.port)} />
            ))}
          </div>
        ) : stage.kind === "asking" || stage.kind === "starting" ? (
          <p role="status" className="web-preview-said">
            <Spinner className="size-4" />
            {stage.kind === "starting" ? `Starting ${stage.server.name} on port ${stage.server.port}…` : running ? "Starting its app…" : "Finding its app…"}
          </p>
        ) : stage.kind === "stopped" ? (
          <div className="web-preview-said flex-col">
            <p>Its app isn't running.</p>
            <button type="button" className="web-button" onClick={() => void run()}>
              <PlayIcon className="size-4 fill-current" strokeWidth={0} />
              Run app
            </button>
          </div>
        ) : (
          <p className="web-preview-said max-w-[320px]" data-too-many={stage.tooMany || undefined}>
            {stage.words}
          </p>
        )}
      </div>
    </Sheet>
  )
}

/**
 * The page at a device's width: as wide as the sheet when it fits, else laid out at that width and scaled down to fit,
 * so a desktop layout reads whole on a phone. Its own origin keeps its storage and scripts; it never navigates the
 * app's window, nor learns its address.
 */
function Framed({ url, title, width }: { url: string; title: string; width: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<{ width: number; height: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const measure = () => setRoom({ width: node.clientWidth, height: node.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => observer.disconnect()
  }, [])
  const scale = room ? Math.min(1, room.width / width) : 1
  const shown = room ? Math.min(width, room.width / scale) : width
  return (
    <div ref={box} className="relative size-full overflow-hidden">
      {room ? (
        <iframe
          src={url}
          title={title}
          className="absolute top-0 left-1/2 border-0 bg-white"
          style={{ width: shown, height: room.height / scale, transform: `translateX(-50%) scale(${scale})`, transformOrigin: "top center" }}
          allow="clipboard-write; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
          referrerPolicy="no-referrer"
        />
      ) : null}
    </div>
  )
}

/** Whether the page is in front: a preview is let go while it isn't, and loaded again when it's back. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible")
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", changed)
    return () => document.removeEventListener("visibilitychange", changed)
  }, [])
  return visible
}
