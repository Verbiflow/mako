import { useEffect, useRef, useState, type ReactNode } from "react"
import { ImageOffIcon, RotateCwIcon } from "lucide-react"
import { readTranscriptMedia } from "@/state/transcript-media"
import { viewer } from "@/state/viewer"
import { useTranscriptSource } from "./source-context"
import type { AttachmentContent } from "@mako/sessions"
import { previewableMediaUrl } from "@/lib/transcript-media"
import { Skeleton } from "@/components/ui/skeleton"
import { InlineFilePreview } from "./file-preview"

type Preview =
  | { kind: "ready"; url: string; mimeType: string }
  | { kind: "error"; message: string }
  | { kind: "loading" }

/**
 * Preview URLs are capabilities signed by the host process that issued them,
 * so a host restart or a dropped proxy request fails a load that a fresh read
 * would satisfy. One automatic re-read covers that before the fallback shows.
 */
const AUTOMATIC_RETRIES = 1

export function MediaPreview({
  attachment,
}: {
  attachment: AttachmentContent
}) {
  const { threadPath, liveId } = useTranscriptSource()
  const container = useRef<HTMLSpanElement>(null)
  const source = attachment.source
  const path = source.kind === "file" ? source.path : undefined
  const direct =
    source.kind === "inline"
      ? `data:${attachment.mimeType};base64,${source.data}`
      : source.kind === "url"
        ? source.url
        : undefined
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([path, threadPath, liveId, attempt])
  const [resolved, setResolved] = useState<{ key: string; preview: Preview }>()
  const [failedUrl, setFailedUrl] = useState<string>()
  useEffect(() => {
    const element = container.current
    if (!path || !element) return
    let canceled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void readTranscriptMedia({ path, threadPath, liveId }).then(
          (media) => {
            if (!canceled)
              setResolved({ key, preview: { kind: "ready", ...media } })
          },
          (error) => {
            if (!canceled)
              setResolved({
                key,
                preview: {
                  kind: "error",
                  message:
                    error instanceof Error
                      ? readableError(error.message)
                      : "The file could not be read",
                },
              })
          }
        )
      },
      { rootMargin: "240px" }
    )
    observer.observe(element)
    return () => {
      canceled = true
      observer.disconnect()
    }
  }, [path, threadPath, liveId, key])
  const preview: Preview = direct
    ? previewableMediaUrl(direct)
      ? { kind: "ready", url: direct, mimeType: attachment.mimeType }
      : { kind: "error", message: "This link type can't be previewed" }
    : resolved?.key === key
      ? resolved.preview
      : { kind: "loading" }
  const retry = path
    ? () => {
        setFailedUrl(undefined)
        setAttempt((count) => count + 1)
      }
    : undefined
  const open = path
    ? () => void viewer.open(path, undefined, threadPath, liveId)
    : undefined
  return (
    <span ref={container} className="transcript-media">
      {preview.kind === "loading" ? (
        <MediaPlaceholder name={attachment.name} />
      ) : preview.kind === "error" ? (
        <MediaUnavailable
          name={attachment.name}
          reason={preview.message}
          onRetry={retry}
          onOpen={open}
        />
      ) : failedUrl === preview.url ? (
        <MediaUnavailable
          name={attachment.name}
          reason="The preview didn't load"
          onRetry={retry}
          onOpen={open}
        />
      ) : (
        <MediaContent
          key={attempt}
          name={attachment.name}
          url={preview.url}
          mimeType={preview.mimeType}
          onError={() => {
            if (path && attempt < AUTOMATIC_RETRIES) setAttempt(attempt + 1)
            else setFailedUrl(preview.url)
          }}
        />
      )}
    </span>
  )
}

/** Host errors arrive wrapped in Electron's invoke prefix; the reason is the tail. */
function readableError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
}

function MediaPlaceholder({ name }: { name: string }) {
  return (
    <span className="inline-flex h-8 items-center gap-2 text-ui text-faint">
      <Skeleton className="size-3.5 rounded-[3px]" />
      {name}
    </span>
  )
}

export function MediaUnavailable({
  name,
  reason,
  onRetry,
  onOpen,
}: {
  name: string
  reason: ReactNode
  onRetry?: () => void
  onOpen?: () => void
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-2 rounded-lg py-1.5 pr-1.5 pl-2.5 text-ui [box-shadow:inset_0_0_0_0.5px_var(--hairline)]"
      data-media-unavailable
    >
      <ImageOffIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 truncate text-muted-foreground">{name}</span>
      <span className="min-w-0 truncate text-label text-faint">{reason}</span>
      {onRetry ? (
        <button
          type="button"
          className="pressable grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
          aria-label={`Retry preview of ${name}`}
          title="Retry"
          onClick={onRetry}
        >
          <RotateCwIcon className="size-3.5" />
        </button>
      ) : null}
      {onOpen ? (
        <button
          type="button"
          className="pressable shrink-0 rounded-md px-2 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
          onClick={onOpen}
        >
          Open
        </button>
      ) : null}
    </span>
  )
}

export function MediaContent({
  name,
  url,
  mimeType,
  onError,
}: {
  name: string
  url: string
  mimeType: string
  onError: () => void
}) {
  return <InlineFilePreview path={name} name={name} mimeType={mimeType} initiallyOpen sizeKnown={false} onPreviewError={onError} resolvedFile={{
    path: name, contents: "", previewUrl: url, mimeType,
    binary: true, truncated: false, size: 0,
  }} />
}
