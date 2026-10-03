import { useState } from "react"
import { Prose } from "@/components/transcript/markdown"
import { resolveMarkdownMedia } from "@/lib/markdown-media"
import {
  filePreviewFormat,
  officeFormat,
} from "../../../electron/contracts/file-preview"
import { OfficePreview } from "./office-preview"
import type { FileContents } from "@/lib/types"
import { ArtifactPreview } from "./artifact-preview"
import { PdfPreview } from "./pdf-preview"
import { DiagnosticPreview } from "./diagnostic-preview"
import { TabularPreview } from "./tabular-preview"

/** Shared expanded body for composer, reply cards and the file workbench. */
export default function RichFilePreview({
  file,
  mode = "preview",
  name: displayName,
  expanded = false,
  onExpand,
  onPreviewError,
}: {
  file: FileContents
  mode?: "preview" | "source"
  name?: string
  expanded?: boolean
  onExpand?: () => void
  onPreviewError?: () => void
}) {
  const format =
    file.diagnostic ??
    officeFormat(displayName ?? file.path, file.mimeType) ??
    file.media ??
    filePreviewFormat(file.path, file.mimeType)
  const name = displayName ?? file.path.split("/").at(-1) ?? "File"
  const text = file.contents.slice(0, 64_000)
  if (mode === "source" || !format || format === "text")
    return (
      <div>
        <pre className={`${expanded ? "" : "max-h-80"} overflow-auto p-4 font-mono text-label [overflow-wrap:anywhere] whitespace-pre-wrap`}>
          {text ||
            (file.binary
              ? "Binary file. Open the original to inspect its contents."
              : "This file is empty.")}
        </pre>
        {file.truncated || file.contents.length > text.length ? (
          <p className="border-t border-hairline px-4 py-2 text-label text-faint">
            Source excerpt · open the original for the complete file.
          </p>
        ) : null}
      </div>
    )
  if (
    format === "har" ||
    format === "cpu-profile" ||
    format === "heap-profile" ||
    format === "heap-snapshot" ||
    format === "trace"
  )
    return file.previewUrl ? (
      <DiagnosticPreview
        key={file.previewUrl}
        url={file.previewUrl}
        format={format}
        expanded={expanded}
      />
    ) : (
      <p className="p-4 text-ui text-faint">
        Reopen this file to obtain its inspection URL.
      </p>
    )
  if (format === "pdf" && file.previewUrl)
    return (
      <div className={`${expanded ? "" : "max-h-[60vh]"} overflow-auto`}>
        <PdfPreview url={file.previewUrl} name={name} expanded={expanded} />
      </div>
    )
  if (
    (format === "word" || format === "workbook" || format === "presentation") &&
    file.previewUrl
  )
    return <OfficePreview url={file.previewUrl} name={name} format={format} expanded={expanded} />
  if (
    (format === "image" || format === "video" || format === "audio") &&
    file.previewUrl
  )
    return (
      <FileMediaPreview
        key={file.previewUrl}
        format={format}
        url={file.previewUrl}
        name={name}
        expanded={expanded}
        onExpand={onExpand}
        onPreviewError={onPreviewError}
      />
    )
  if (format === "markdown")
    return (
      <div className={`${expanded ? "" : "max-h-80"} overflow-auto p-4`}>
        <Prose text={resolveMarkdownMedia(text, file.path)} />
        {file.truncated || file.contents.length > text.length ? (
          <p className="mt-3 text-label text-faint">
            Document excerpt · open the original for the complete file.
          </p>
        ) : null}
      </div>
    )
  if (format === "html")
    return file.truncated || file.contents.length > 200_000 ? (
      <p className="p-4 text-ui text-faint">
        This document exceeds the inline HTML preview limit. Open the original
        to inspect it.
      </p>
    ) : (
      <div className={`${expanded ? "h-full" : "max-h-96"} overflow-auto`}>
        <ArtifactPreview html={file.contents} name={name} />
      </div>
    )
  if (format === "table")
    return (
      <div className={`${expanded ? "" : "max-h-80"} overflow-auto`}>
        <TabularPreview path={file.path} contents={text} />
        {file.truncated || file.contents.length > text.length ? (
          <p className="p-3 text-label text-faint">
            Table excerpt · open the original for the complete file.
          </p>
        ) : null}
      </div>
    )
  return (
    <p className="p-4 text-ui text-faint">
      Preview unavailable. Open the original file.
    </p>
  )
}

function FileMediaPreview({
  format,
  url,
  name,
  expanded,
  onExpand,
  onPreviewError,
}: {
  format: "image" | "video" | "audio"
  url: string
  name: string
  expanded: boolean
  onExpand?: () => void
  onPreviewError?: () => void
}) {
  const [failed, setFailed] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  if (failed)
    return (
      <p role="status" className="p-4 text-ui text-muted-foreground">
        This {format} could not be previewed. Refresh it or open the original
        file.
      </p>
    )
  if (format === "image")
    return (
      <div className="bg-shell/40">
        {expanded ? <div className="flex items-center gap-1 border-b border-hairline px-4 py-2 text-label">
          {([false, true] as const).map((actual) => <button key={String(actual)} type="button" aria-pressed={actualSize === actual} onClick={() => setActualSize(actual)} className={`pressable rounded-md px-2 py-1 ${actualSize === actual ? "bg-fill-selected text-foreground" : "text-muted-foreground hover:bg-fill-hover"}`}>
            {actual ? "Actual size" : "Fit"}
          </button>)}
        </div> : null}
        <button type="button" aria-label={expanded ? `View ${name} ${actualSize ? "fitted" : "at actual size"}` : `Enlarge ${name}`} onClick={expanded ? () => setActualSize(!actualSize) : onExpand} disabled={!expanded && !onExpand} className={`pressable block w-full overflow-auto ${expanded ? "h-[calc(100dvh-10rem)]" : "cursor-zoom-in"} ${actualSize ? "cursor-zoom-out" : ""}`}>
          <img
          loading="lazy"
          decoding="async"
          src={url}
          alt={name}
          onError={() => { setFailed(true); onPreviewError?.() }}
          className={actualSize ? "asset-surface max-w-none" : `asset-surface mx-auto block w-full object-contain ${expanded ? "h-full" : "max-h-[32rem]"}`}
        />
        </button>
      </div>
    )
  if (format === "video")
    return (
      <video
        controls
        playsInline
        preload="none"
        src={url}
        aria-label={name}
        onError={() => { setFailed(true); onPreviewError?.() }}
        className={`${expanded ? "h-[calc(100dvh-6rem)]" : "max-h-[32rem]"} w-full bg-shell object-contain`}
      />
    )
  return (
    <div className="flex min-h-20 items-center p-4">
      <audio
        controls
        preload="none"
        src={url}
        aria-label={name}
        onError={() => { setFailed(true); onPreviewError?.() }}
        className="w-full"
      />
    </div>
  )
}
