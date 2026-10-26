import { lazy, Suspense, useEffect, useMemo, useRef, useState, useContext } from "react"
import { ChevronDownIcon, ExpandIcon, RotateCwIcon } from "lucide-react"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { ExpandedFilePreview } from "@/components/viewer/expanded-file-preview"
import { readTranscriptFile } from "@/state/transcript-media"
import { viewer } from "@/state/viewer"
import { formatBytes } from "@/lib/attachments"
import { filePreviewFormat } from "@mako/host/contracts/file-preview"
import type { FileContents } from "@/lib/types"
import { AssetPreviewContext, useAssetPreview } from "@/components/viewer/asset-preview-context"
import { useGalleryItem } from "@/components/viewer/media-gallery-store"
import { MediaTileContext } from "@/components/viewer/media-tile-context"
import type { FileReadPurpose } from "@mako/host/contracts/git-workspace-search"
import { useTranscriptSource } from "./source-context"
import { InlineMedia } from "./inline-media"

const RichFilePreview = lazy(
  () => import("@/components/viewer/rich-file-preview")
)

/**
 * File ownership is resolved through the conversation, never guessed by MIME.
 * A picture or video draws as itself (`InlineMedia`), in a grid as a tile,
 * and opens in the enclosing gallery; anything else is a card that expands.
 * `purpose: "preview"`: the transcript shows it unasked, so a file outside
 * the Thread's folders that isn't media, a page or a PDF stays a link.
 */
export function InlineFilePreview({
  path,
  name,
  mimeType,
  initiallyOpen = false,
  resolvedFile,
  sizeKnown = true,
  onPreviewError,
  purpose,
}: {
  path: string
  name: string
  mimeType?: string
  initiallyOpen?: boolean
  resolvedFile?: FileContents
  sizeKnown?: boolean
  onPreviewError?: () => void
  purpose?: FileReadPurpose
}) {
  const context = useTranscriptSource()
  const tile = useContext(MediaTileContext)
  const [requested, setRequested] = useState(false)
  const [mediaFailed, setMediaFailed] = useState<{ attempt: number; final: boolean }>()
  const galleryOpen = useContext(AssetPreviewContext)?.enlarged || requested
  const host = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [inlineHeight, setInlineHeight] = useState(0)
  const [open, setOpen] = useState(initiallyOpen)
  const [mode, setMode] = useState<"preview" | "source">("preview")
  const [attempt, setAttempt] = useState(0)
  const [localEnlarged, setEnlarged] = useState(false)
  const changeEnlarged = (value: boolean) => {
    if (value) setInlineHeight(body.current?.getBoundingClientRect().height ?? 0)
    if (collection) collection.setEnlarged(value)
    else setEnlarged(value)
  }
  const key = JSON.stringify([
    path,
    context.liveId,
    context.threadPath,
    attempt,
  ])
  const [loaded, setLoaded] = useState<{
    key: string
    file?: FileContents
    error?: string
  }>()
  useEffect(() => {
    const element = host.current
    if (!element || resolvedFile || loaded?.key === key) return
    let current = true
    const read = () => {
        void readTranscriptFile({
          path,
          liveId: context.liveId,
          threadPath: context.threadPath,
          purpose,
        }).then(
          (file) => {
            if (current) setLoaded({ key, file })
          },
          (error) => {
            if (current)
              setLoaded({
                key,
                error:
                  error instanceof Error
                    ? error.message.replace(
                        /^Error invoking remote method '[^']+': (?:Error: )?/,
                        ""
                      )
                    : "This file could not be read",
              })
          }
        )
    }
    // Gallery navigation must load even if the selected inline owner is offscreen; a hidden grid item reads only then.
    if (galleryOpen) {
      read()
      return () => { current = false }
    }
    if (tile?.kind === "hidden") return
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      read()
    }, { rootMargin: "240px" })
    observer.observe(element)
    return () => {
      current = false
      observer.disconnect()
    }
  }, [path, context.liveId, context.threadPath, key, resolvedFile, galleryOpen, loaded?.key, purpose, tile?.kind])
  const result = loaded?.key === key ? loaded : undefined
  const file = resolvedFile ?? result?.file
  const collection = useAssetPreview(file, mode, result?.error)
  const enlarged = collection?.enlarged ?? localEnlarged
  const format =
    file?.media ?? filePreviewFormat(path, file?.mimeType ?? mimeType)
  // A page shown by URL draws inline like a picture; one only in memory still waits to be opened.
  const automatic =
    format === "image" || format === "video" || format === "audio" || (format === "html" && !!file?.previewUrl)
  const expanded = !!collection || open || (automatic && mode !== "source")
  const showSource = file && !file.binary
  const visual = (format === "image" || format === "video") && mode === "preview" && !file?.withheld
  const openPath = resolvedFile ? undefined : path
  const failure = result?.error ?? (mediaFailed?.final ? "The preview didn't load" : undefined)
  const galleryItem = useMemo(() => visual && !collection ? {
    name,
    path: openPath,
    file,
    error: failure,
    element: () => host.current,
    request: () => setRequested(true),
  } : null, [visual, collection, name, openPath, file, failure])
  const openInGallery = useGalleryItem(galleryItem)
  if (visual)
    return (
      <>
        <InlineMedia
          hostRef={host}
          path={path}
          name={name}
          format={format}
          file={file}
          error={failure}
          tile={tile}
          openPath={openPath}
          onOpen={collection ? () => changeEnlarged(true) : openInGallery ?? (() => changeEnlarged(true))}
          onRetry={() => { setMediaFailed(undefined); setAttempt(attempt + 1) }}
          onMediaError={() => {
            // A signed URL that expired or a file rewritten since: read it once more for a fresh one before giving up.
            if (resolvedFile) { onPreviewError?.(); return }
            if (mediaFailed?.attempt === attempt) setMediaFailed({ attempt, final: true })
            else { setMediaFailed({ attempt: attempt + 1, final: false }); setAttempt(attempt + 1) }
          }}
        />
        {file && !collection && !openInGallery ? <ExpandedFilePreview file={file} name={name} mode={mode} open={enlarged} onOpenChange={changeEnlarged} focusTarget={() => host.current?.querySelector<HTMLButtonElement>("button") ?? null} /> : null}
      </>
    )
  if (file?.withheld)
    return (
      <div ref={host} data-inline-file-preview={path} className="not-prose my-2 flex min-w-0 items-center gap-2 text-ui">
        <FileTypeIcon path={name} mimeType={file.mimeType} className="size-4 shrink-0 text-muted-foreground" />
        <button type="button" className="pressable min-w-0 truncate font-medium underline decoration-hairline underline-offset-3 hover:decoration-current" onClick={() => void viewer.open(path, undefined, context.threadPath, context.liveId)}>{name}</button>
        <span className="min-w-0 truncate text-label text-faint">{file.withheld}</span>
      </div>
    )
  return (
    <div
      ref={host}
      data-inline-file-preview={path}
      className="not-prose my-3 overflow-hidden asset-surface border border-hairline bg-surface text-ui"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <FileTypeIcon path={name} mimeType={file?.mimeType ?? mimeType} className="size-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          className="pressable flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={`Preview ${name}`}
          aria-expanded={expanded}
          onClick={() => {
            if (automatic) setMode(expanded ? "source" : "preview")
            else setOpen(!open)
          }}
        >
          <span className="truncate font-medium">{name}</span>
          <ChevronDownIcon
            aria-hidden
            className={`size-3.5 shrink-0 text-faint transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {file ? (
          <button type="button" aria-label={`Expand ${name}`} title="Expand preview" onClick={() => changeEnlarged(true)} className="pressable rounded p-1 text-muted-foreground hover:bg-fill-hover hover:text-foreground">
            <ExpandIcon className="size-3.5" />
          </button>
        ) : null}
        {file && sizeKnown ? (
          <span className="text-label text-faint tabular-nums">
            {formatBytes(file.size)}
          </span>
        ) : null}
        <button
          type="button"
          className="pressable rounded p-1 text-faint hover:bg-fill-hover"
          aria-label={`Refresh ${name}`}
          onClick={() => setAttempt(attempt + 1)}
        >
          <RotateCwIcon className="size-3.5" />
        </button>
        {resolvedFile?.previewUrl ? (
          <a className="pressable rounded px-2 py-1 text-label text-muted-foreground hover:bg-fill-hover" href={resolvedFile.previewUrl} target="_blank" rel="noreferrer">Open original</a>
        ) : (
          <button type="button" className="pressable rounded px-2 py-1 text-label text-muted-foreground hover:bg-fill-hover" onClick={() => void viewer.open(path, undefined, context.threadPath, context.liveId)}>Open</button>
        )}
      </div>
      {result?.error ? (
        <div className="flex items-center gap-2 border-t border-hairline px-3 py-2 text-label text-faint">
          <span className="min-w-0 flex-1">{result.error}</span>
          <button
            className="pressable rounded p-1"
            aria-label={`Retry ${name}`}
            onClick={() => setAttempt(attempt + 1)}
          >
            <RotateCwIcon className="size-3.5" />
          </button>
        </div>
      ) : expanded && !enlarged ? (
        <div ref={body} className="border-t border-hairline">
          {showSource ? (
            <div className="flex gap-1 border-b border-hairline px-3 py-1.5 text-label">
              {(["preview", "source"] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={`pressable rounded px-2 py-1 ${mode === value ? "bg-fill-selected text-foreground" : "text-faint hover:bg-fill-hover"}`}
                >
                  {value === "preview" ? "Preview" : "Source"}
                </button>
              ))}
            </div>
          ) : null}
          <Suspense
            fallback={
              <p className="min-h-64 p-4 text-faint">Loading preview…</p>
            }
          >
            {file ? (
              <RichFilePreview key={key} file={file} mode={mode} name={name} onExpand={() => changeEnlarged(true)} onPreviewError={onPreviewError} />
            ) : (
              <p role="status" className="min-h-64 p-4 text-faint">
                Reading file…
              </p>
            )}
          </Suspense>
        </div>
      ) : enlarged && expanded ? <div aria-hidden style={{ height: inlineHeight }} /> : null}
      {file && !collection ? <ExpandedFilePreview file={file} name={name} mode={mode} open={enlarged} onOpenChange={changeEnlarged} focusTarget={() => host.current?.querySelector<HTMLButtonElement>('button[title="Expand preview"]') ?? null} /> : null}
    </div>
  )
}
