import { NativeControlPreview } from "./native-control-preview"
import { ControlPreviewImage } from "./control-preview-image"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { GlobeIcon, Minimize2Icon, MonitorIcon, XIcon } from "lucide-react"
import {
  controlPreviewStore,
  useControlPreview,
  watchControlPreview,
  zoomControlPreview,
} from "@/state/control-preview"
import {
  controlPreviewRateDescription,
  type ControlPreviewRate,
} from "@/lib/control-preview-painter"
import { cn } from "@/lib/utils"

/** The containing timeline owns its position; this never creates a system window or portal. */
export function ControlPreviewOverlay({
  conversationId,
}: {
  conversationId?: string
}) {
  return conversationId ? (
    <TaskPreview key={conversationId} id={conversationId} />
  ) : null
}

function TaskPreview({ id }: { id: string }) {
  const activity = useControlPreview((state) => state.activities[id])
  const zoomed = useControlPreview((state) => state.zoomed === id)
  const [collapsed, setCollapsed] = useState(false)
  const boundary = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const node = boundary.current
    if (!node) return
    let intersecting = false
    const update = () => setVisible(intersecting && !document.hidden)
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false
      update()
    })
    observer.observe(node)
    document.addEventListener("visibilitychange", update)
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", update)
    }
  }, [])
  useEffect(
    () => () => {
      if (controlPreviewStore.get().zoomed === id) zoomControlPreview(null)
    },
    [id]
  )
  useEffect(() => {
    if (!zoomed) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      zoomControlPreview(null)
    }
    document.addEventListener("keydown", escape, true)
    return () => document.removeEventListener("keydown", escape, true)
  }, [zoomed])
  return (
    <div
      ref={boundary}
      data-control-preview-task={id}
      data-zoomed={zoomed || undefined}
      className={cn(
        "absolute z-20",
        zoomed
          ? "inset-0 z-30 flex items-center justify-center p-6 [container-type:size]"
          : "pointer-events-none top-4 right-4 min-h-px w-72 max-w-[calc(100%_-_2rem)]"
      )}
    >
      {zoomed && (
        <div
          aria-hidden
          className="control-preview-scrim absolute inset-0 bg-shell/40 backdrop-blur-[2px]"
          onPointerDown={() => zoomControlPreview(null)}
        />
      )}
      {collapsed && !zoomed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="glass-panel pressable pointer-events-auto ml-auto flex h-7 items-center gap-1.5 rounded-full px-2.5 text-label text-muted-foreground"
        >
          <MonitorIcon className="size-3" />
          Show preview
        </button>
      ) : (
        (visible || zoomed) &&
        activity && (
          <PreviewCard
            id={id}
            zoomed={zoomed}
            onClose={() => setCollapsed(true)}
          />
        )
      )}
    </div>
  )
}

/** Stopping the run is the composer's job; this card only shows what the agent sees. */
function PreviewCard({
  id,
  zoomed,
  onClose,
}: {
  id: string
  zoomed: boolean
  onClose: () => void
}) {
  const preview = useControlPreview((state) => state.previews[id])
  useEffect(() => watchControlPreview(id), [id])
  const error = useControlPreview((state) => state.errors[id])
  const [rate, setRate] = useState<ControlPreviewRate | null>(null)
  const card = useRef<HTMLElement>(null)
  const shrink = useRef<HTMLButtonElement>(null)
  const from = useRef<DOMRect | undefined>(undefined)
  const zoom = (next: boolean) => {
    from.current = card.current?.getBoundingClientRect()
    zoomControlPreview(next ? id : null)
  }
  useLayoutEffect(() => {
    const node = card.current
    const first = from.current
    from.current = undefined
    if (zoomed) shrink.current?.focus({ preventScroll: true })
    if (!node || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (!first) {
      if (zoomed)
        node.animate([{ opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1 }], {
          duration: 180,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        })
      return
    }
    // Zoom from the rectangle the card had, so it reads as the same glass growing.
    const last = node.getBoundingClientRect()
    if (!last.width || !last.height) return
    node.animate(
      [
        {
          transformOrigin: "0 0",
          transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`,
        },
        { transformOrigin: "0 0", transform: "none" },
      ],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    )
  }, [zoomed])
  const frame = preview?.frame
  const activity = preview?.activity
  const nativeWindow = preview?.window
  if (!frame && !nativeWindow && !error) return null
  const surface = activity?.kind === "browser" ? "Browser" : "Computer"
  const working = activity?.status === "running"
  const label = activity
    ? `${surface} · ${activity.operation.replaceAll("_", " ")}${working ? " · working" : ""}`
    : surface
  const media = zoomed
    ? "block h-auto max-h-[100cqh] w-full object-contain"
    : "block max-h-64 w-full object-contain"
  return (
    <section
      ref={card}
      aria-label="Live control preview"
      className={cn(
        "control-preview-card glass-panel pointer-events-auto relative overflow-hidden text-popover-foreground",
        zoomed ? "w-full max-w-5xl rounded-2xl" : "rounded-xl"
      )}
    >
      {/* The image sets its own height; no letterbox band around it. */}
      <div className="group relative flex min-h-16 items-center justify-center overflow-hidden">
        {nativeWindow ? (
          <NativeControlPreview
            key={`${id}:${nativeWindow.pid}:${nativeWindow.windowId}`}
            id={id}
            poster={frame ?? undefined}
            className={media}
          />
        ) : (
          frame && (
            <ControlPreviewImage
              key={`${id}:${activity?.kind}:${activity?.target}`}
              frame={frame}
              label="Live view of the tab this task is using"
              className={media}
              onRate={setRate}
            />
          )
        )}
        {zoomed ? null : (
          <button
            type="button"
            aria-label="Enlarge preview"
            title="Enlarge"
            onClick={() => zoom(true)}
            className="absolute inset-0 cursor-zoom-in focus-visible:outline-none"
          />
        )}
        {/* Just the picture and small glass marks over it. The kind of
            surface (browser or computer) is a glyph, the working state is
            the ember dot beside it, and the operation's name is the mark's
            tooltip and accessible name. A caption band that spelled out
            "Computer · get desktop state" under every frame was a status bar
            stuck to a thumbnail. */}
        <div
          role="status"
          aria-label={label}
          title={label}
          className={cn(
            "glass-control pointer-events-none absolute top-2 left-2 flex h-6 items-center gap-1.5 rounded-full px-2 text-muted-foreground",
            zoomed && "pointer-events-auto"
          )}
        >
          {activity?.kind === "browser" ? (
            <GlobeIcon className="size-3.5 shrink-0" />
          ) : (
            <MonitorIcon className="size-3.5 shrink-0" />
          )}
          {working && (
            <span className="size-1.5 shrink-0 rounded-full bg-ember" />
          )}
          {zoomed && activity && (
            <span className="text-label first-letter:uppercase">
              {activity.operation.replaceAll("_", " ")}
            </span>
          )}
        </div>
        {zoomed ? (
          <button
            ref={shrink}
            type="button"
            aria-label="Shrink preview"
            title="Shrink (Esc)"
            onClick={() => zoom(false)}
            className="glass-control pressable absolute top-2 right-2 flex size-7 items-center justify-center rounded-full text-muted-foreground"
          >
            <Minimize2Icon className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Hide preview"
            onClick={onClose}
            className="glass-control pressable absolute top-2 right-2 flex size-6 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
        {rate && !error && (
          <span
            data-control-preview-rate
            title={controlPreviewRateDescription(rate)}
            className="glass-control tabular pointer-events-none absolute bottom-2 left-2 flex h-6 items-center rounded-full px-2 text-label text-muted-foreground"
          >
            {rate.shown} of {rate.full} fps
          </span>
        )}
        {error && (
          <p
            role="status"
            className="glass-control pointer-events-none absolute inset-x-2 bottom-2 truncate rounded-md px-2 py-1 text-label text-muted-foreground"
            title={error}
          >
            {error}
          </p>
        )}
      </div>
      {working && (
        <span aria-hidden className="control-preview-rim">
          <span />
        </span>
      )}
    </section>
  )
}
