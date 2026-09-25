import { NativeControlPreview } from "./native-control-preview"
import { ControlPreviewImage } from "./control-preview-image"
import { useEffect } from "react"
import { MonitorIcon, GlobeIcon } from "lucide-react"
import { Blank } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { useControlPreview, watchControlPreview } from "@/state/control-preview"

export function ControlPreviewPanel() {
  const conversationId = useAcp(
    (state) => activeLiveAcp(state)?.session.id ?? null
  )
  const preview = useControlPreview((state) =>
    conversationId ? state.previews[conversationId] : null
  )
  const error = useControlPreview((state) =>
    conversationId ? state.errors[conversationId] : null
  )
  useEffect(
    () => (conversationId ? watchControlPreview(conversationId) : undefined),
    [conversationId]
  )
  const activity = preview?.activity
  const frame = preview?.frame
  const browser = activity?.kind === "browser"

  if (!frame && !activity)
    return (
      <section className="flex h-full flex-col" aria-label="Control preview">
        <Blank
          icon={<MonitorIcon />}
          title={
            conversationId ? "Nothing observed yet" : "No live conversation"
          }
          body={
            conversationId
              ? "When this task drives a browser tab or an app window, its latest view appears here."
              : "Open a live conversation to watch the browser and apps it controls."
          }
        />
        {error ? (
          <p
            role="status"
            className="shrink-0 px-4 pb-4 text-center text-label text-faint"
          >
            {error}
          </p>
        ) : null}
      </section>
    )

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label="Control preview"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-label">
        {browser ? (
          <GlobeIcon className="size-3.5 shrink-0 text-faint" />
        ) : (
          <MonitorIcon className="size-3.5 shrink-0 text-faint" />
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {browser ? "This task’s browser tab" : "This task’s app window"}
        </span>
        {activity ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5",
              activity.status === "error" ? "text-negative" : "text-faint"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                activity.status === "running"
                  ? "animate-pulse bg-positive"
                  : activity.status === "error"
                    ? "bg-negative"
                    : "bg-faint"
              )}
            />
            {activity.status === "running"
              ? "Working"
              : activity.status === "error"
                ? "Action failed"
                : "Last observed"}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {preview?.window && conversationId ? (
          <NativeControlPreview
            key={`${conversationId}:${preview.window.pid}:${preview.window.windowId}`}
            id={conversationId}
            poster={frame?.image}
            className="block h-auto w-full rounded-lg object-contain"
          />
        ) : frame ? (
          <figure className="m-0 overflow-hidden rounded-lg bg-background [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
            <ControlPreviewImage
              key={`${conversationId}:${activity?.kind}:${activity?.target}`}
              className="block h-auto w-full object-contain"
              frame={frame}
              label={`${browser ? "Browser tab" : "Application window"} observed by this task`}
            />
          </figure>
        ) : null}
        <div className="mt-2.5 flex items-baseline gap-2 px-0.5 text-label">
          <span className="min-w-0 flex-1 truncate text-muted-foreground first-letter:uppercase">
            {activity
              ? activity.operation.replaceAll("_", " ")
              : "Waiting for the next observation"}
          </span>
          {frame ? (
            <span className="tabular shrink-0 text-faint">
              {new Date(frame.capturedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          ) : null}
        </div>
        {error ? (
          <p role="status" className="mt-2 px-0.5 text-label text-faint">
            {error}
          </p>
        ) : null}
        <p className="mt-4 px-0.5 text-label leading-relaxed text-faint">
          Browser previews stay live while this panel is open. App windows
          stream during activity when capture is available; otherwise the latest
          screenshot remains visible.
        </p>
      </div>
    </section>
  )
}
