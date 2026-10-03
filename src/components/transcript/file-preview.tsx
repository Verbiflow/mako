import { lazy, Suspense, useEffect, useRef, useState, useContext } from "react"
import { ChevronDownIcon, ExpandIcon, RotateCwIcon } from "lucide-react"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { ExpandedFilePreview } from "@/components/viewer/expanded-file-preview"
import { readTranscriptFile } from "@/state/transcript-media"
import { viewer } from "@/state/viewer"
import { formatBytes } from "@/lib/attachments"
import { filePreviewFormat } from "../../../electron/contracts/file-preview"
import type { FileContents } from "@/lib/types"
import { AssetPreviewContext, useAssetPreview } from "@/components/viewer/asset-preview-context"
import { useTranscriptSource } from "./source-context"

const RichFilePreview = lazy(
  () => import("@/components/viewer/rich-file-preview")
)

/** File ownership is resolved through the conversation, never guessed by MIME. */
export function InlineFilePreview({
  path,
  name,
  mimeType,
  initiallyOpen = false,
  resolvedFile,
  sizeKnown = true,
  onPreviewError,
}: {
  path: string
  name: string
  mimeType?: string
  initiallyOpen?: boolean
  resolvedFile?: FileContents
  sizeKnown?: boolean
  onPreviewError?: () => void
}) {
  const context = useTranscriptSource()
  const galleryOpen = useContext(AssetPreviewContext)?.enlarged
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
    // Gallery navigation must load even if the selected inline owner is offscreen.
    if (galleryOpen) {
      read()
      return () => { current = false }
    }
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
  }, [path, context.liveId, context.threadPath, key, resolvedFile, galleryOpen, loaded?.key])
  const result = loaded?.key === key ? loaded : undefined
  const file = resolvedFile ?? result?.file
  const collection = useAssetPreview(file, mode, result?.error)
  const enlarged = collection?.enlarged ?? localEnlarged
  const format =
    file?.media ?? filePreviewFormat(path, file?.mimeType ?? mimeType)
  const automatic =
    format === "image" || format === "video" || format === "audio"
  const expanded = !!collection || open || (automatic && mode !== "source")
  const showSource = file && !file.binary
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
