import { useEffect, useRef, useState } from "react"
import { GlobeIcon, MonitorIcon, XIcon } from "lucide-react"
import {
  controlPreviewStream,
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
  return (
    <section
      aria-label="Live control preview"
      className="glass-panel pointer-events-auto overflow-hidden rounded-xl text-popover-foreground"
    >
      {/* The image sets its own height; no letterbox band around it. */}
      <div className="group relative flex min-h-16 items-center justify-center overflow-hidden">
        {nativeWindow ? (
          <NativePreview
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
            <img
              src={`data:${frame.image.mimeType};base64,${frame.image.data}`}
              alt="Live view of the tab this task is using"
              className="block max-h-64 w-full object-contain"
              decoding="async"
            />
          )
        )}
        <button
          type="button"
          aria-label="Hide preview"
          onClick={onClose}
          className="glass-control pressable absolute top-2 right-2 flex size-6 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
        <div className="glass-caption absolute inset-x-0 bottom-0 flex h-10 items-end gap-2 px-2.5 pb-2 text-label">
          {activity?.kind === "browser" ? (
            <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate leading-none text-foreground">
            {activity?.kind === "browser" ? "Browser" : "Computer"}
            {activity ? ` · ${activity.operation.replaceAll("_", " ")}` : ""}
          </span>
          {activity?.status === "running" && (
            <span
              className="mb-px size-1.5 shrink-0 rounded-full bg-ember"
              aria-label="Working"
            />
          )}
        </div>
      </div>
      {error && (
        <p
          role="status"
          className="px-2.5 py-2 text-label text-muted-foreground"
        >
          {error}
        </p>
      )}
    </section>
  )
}

function NativePreview({ id, poster }: { id: string; poster?: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let closed = false
    let stream: MediaStream | null = null
    void controlPreviewStream(id)
      .then(async (value) => {
        if (closed) {
          value?.getTracks().forEach((track) => track.stop())
          return
        }
        stream = value
        const element = video.current
        if (!stream || !element) {
          setFailed(true)
          return
        }
        element.srcObject = stream
        await element.play()
      })
      .catch(() => {
        stream?.getTracks().forEach((track) => track.stop())
        if (!closed) setFailed(true)
      })
    return () => {
      closed = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [id])
  if (failed)
    return poster ? (
      <img
        src={poster}
        alt="Latest view of this task's application window"
        className="block max-h-64 w-full object-contain"
        decoding="async"
      />
    ) : (
      <span role="status" className="py-6 text-label text-muted-foreground">
        Waiting for a screenshot
      </span>
    )
  return (
    <video
      ref={video}
      muted
      autoPlay
      playsInline
      poster={poster}
      aria-label="Live application window"
      className="block max-h-64 w-full object-contain"
    />
  )
}
