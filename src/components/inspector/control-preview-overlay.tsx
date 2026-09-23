import { NativeControlPreview } from "./native-control-preview"
import { ControlPreviewImage } from "./control-preview-image"
import { useEffect, useRef, useState } from "react"
import { GlobeIcon, MonitorIcon, XIcon } from "lucide-react"
import {
  useControlPreview,
  watchControlPreview,
} from "@/state/control-preview"

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
  return (
    <div
      ref={boundary}
      data-control-preview-task={id}
      className="pointer-events-none absolute top-4 right-4 z-20 min-h-px w-72 max-w-[calc(100%_-_2rem)]"
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="glass-panel pressable pointer-events-auto ml-auto flex h-7 items-center gap-1.5 rounded-full px-2.5 text-label text-muted-foreground"
        >
          <MonitorIcon className="size-3" />
          Show preview
        </button>
      ) : (
        visible &&
        activity && (
          <PreviewCard id={id} onClose={() => setCollapsed(true)} />
        )
      )}
    </div>
  )
}

/** Stopping the run is the composer's job; this card only shows what the agent sees. */
function PreviewCard({ id, onClose }: { id: string; onClose: () => void }) {
  const preview = useControlPreview((state) => state.previews[id])
  useEffect(() => watchControlPreview(id), [id])
  const error = useControlPreview((state) => state.errors[id])
  const frame = preview?.frame
  const activity = preview?.activity
  const nativeWindow = preview?.window
  if (!frame && !nativeWindow) return null
  const surface = activity?.kind === "browser" ? "Browser" : "Computer"
  const label = activity
    ? `${surface} · ${activity.operation.replaceAll("_", " ")}${activity.status === "running" ? " · working" : ""}`
    : surface
  return (
    <section
      aria-label="Live control preview"
      className="glass-panel pointer-events-auto overflow-hidden rounded-xl text-popover-foreground"
    >
      {/* The image sets its own height; no letterbox band around it. */}
      <div className="group relative flex min-h-16 items-center justify-center overflow-hidden">
        {nativeWindow ? (
          <NativeControlPreview
            key={`${id}:${nativeWindow.pid}:${nativeWindow.windowId}`}
            id={id}
            poster={
              frame
                ? `data:${frame.image.mimeType};base64,${frame.image.data}`
                : undefined
            }
          />
        ) : (
          frame && (
            <ControlPreviewImage
              key={`${id}:${activity?.kind}:${activity?.target}`}
              frame={frame}
              label="Live view of the tab this task is using"
              className="block max-h-64 w-full object-contain"
            />
          )
        )}
        {/* Just the picture and two small glass marks over it. The kind of
            surface (browser or computer) is a glyph, the working state is
            the ember dot beside it, and the operation's name is the mark's
            tooltip and accessible name. A caption band that spelled out
            "Computer · get desktop state" under every frame was a status bar
            stuck to a thumbnail. */}
        <div
          role="status"
          aria-label={label}
          title={label}
          className="glass-control absolute top-2 left-2 flex h-6 items-center gap-1.5 rounded-full px-2 text-muted-foreground"
        >
          {activity?.kind === "browser" ? (
            <GlobeIcon className="size-3.5 shrink-0" />
          ) : (
            <MonitorIcon className="size-3.5 shrink-0" />
          )}
          {activity?.status === "running" && (
            <span className="size-1.5 shrink-0 rounded-full bg-ember" />
          )}
        </div>
        <button
          type="button"
          aria-label="Hide preview"
          onClick={onClose}
          className="glass-control pressable absolute top-2 right-2 flex size-6 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
        {error && (
          <p
            role="status"
            className="glass-control absolute inset-x-2 bottom-2 truncate rounded-md px-2 py-1 text-label text-muted-foreground"
            title={error}
          >
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
