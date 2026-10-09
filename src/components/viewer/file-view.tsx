import { DiagnosticPreview } from "./diagnostic-preview"
import {
  diagnosticFormat,
  officeFormat,
} from "../../../electron/contracts/file-preview"
import { OfficePreview } from "./office-preview"
import { PdfPreview } from "./pdf-preview"
import { resolveMarkdownMedia } from "@/lib/markdown-media"
import { ArtifactPreview } from "./artifact-preview"
import { useEffect, useRef } from "react"
import { File, Virtualizer } from "@pierre/diffs/react"
import { DIFF_THEME } from "@/lib/diff-theme"
import { FileIcon } from "lucide-react"
import { formatBytes } from "@/lib/format"
import { Prose } from "@/components/transcript/markdown"
import { TabularPreview } from "@/components/viewer/tabular-preview"
import type { FileContents } from "@/lib/types"
import { viewerFileUrl, type ViewerRenderMode } from "@/state/viewer"

/**
 * A file, rendered according to its current contents and selected mode.
 *
 * Text and code use Pierre's file renderer, Markdown can switch between that
 * source view and prose, and binary files stop at a renderer hook because the
 * current bridge intentionally exposes metadata rather than media bytes.
 *
 * The header is disabled because the pane already carries the path and the
 * actions; two stacked filename bars make the workspace feel assembled rather
 * than designed.
 */
export function FileView({
  file,
  line,
  mode,
}: {
  file: FileContents
  line?: number
  mode: ViewerRenderMode
}) {
  const host = useRef<HTMLDivElement>(null)

  /**
   * Land on the line you came for.
   *
   * The renderer stamps each row with `data-line`, but it fills the DOM after
   * its own layout pass, so the row is not there on the effect's first tick.
   * A short poll is cheap, ends the moment it finds the row, and gives up
   * rather than spinning if the file is shorter than the line asked for.
   */
  useEffect(() => {
    if (!line) return
    let frames = 0
    let raf = 0
    const look = () => {
      const row = host.current?.querySelector<HTMLElement>(
        mode === "source"
          ? `[data-line="${line}"]`
          : `[data-source-line="${line}"]`
      )
      if (row) {
        row.scrollIntoView({ block: "center" })
        return
      }
      if (frames++ > 90) return
      raf = requestAnimationFrame(look)
    }
    raf = requestAnimationFrame(look)
    return () => cancelAnimationFrame(raf)
  }, [file, line, mode])

  const diagnostic = file.diagnostic ?? diagnosticFormat(file.path)
  if (mode === "preview" && diagnostic && file.previewUrl)
    return (
      <DiagnosticPreview
        key={file.previewUrl}
        url={viewerFileUrl(file.previewUrl)}
        format={diagnostic}
      />
    )
  const office = officeFormat(file.path, file.mimeType)
  if (mode === "preview" && office && file.previewUrl)
    return (
      <OfficePreview
        url={viewerFileUrl(file.previewUrl)}
        name={file.path.split("/").at(-1) ?? file.path}
        format={office}
      />
    )

  if (file.binary) return <MediaPreview file={file} />

  if (mode === "preview" && file.artifactPreview)
    return file.artifactPreview.kind === "html" ? (
      <ArtifactPreview
        html={file.artifactPreview.html}
        name={file.path.split("/").at(-1) ?? "Artifact"}
        kind={file.artifactPreview.name}
      />
    ) : (
      <p className="p-5 text-ui text-muted-foreground">
        {file.artifactPreview.reason}
      </p>
    )

  if (mode === "preview" && isMarkdownPath(file.path)) {
    return (
      <div ref={host}>
        <Prose
          text={resolveMarkdownMedia(file.contents, file.path)}
          className="mx-auto max-w-4xl p-5 sm:p-7"
          urlTransform={workspaceUrlTransform}
        />
      </div>
    )
  }

  if (mode === "preview" && isTabularPath(file.path)) {
    return <TabularPreview contents={file.contents} path={file.path} />
  }

  return (
    <div ref={host}>
      <Virtualizer className="min-h-full">
        <File
          file={{ name: file.path, contents: file.contents }}
          selectedLines={line ? { start: line, end: line } : null}
          options={{
            theme: DIFF_THEME,
            disableFileHeader: true,
          }}
        />
      </Virtualizer>
    </div>
  )
}

function isMarkdownPath(path: string) {
  return /\.(?:md|markdown|mdx)$/i.test(path)
}

function isTabularPath(path: string) {
  return /\.(?:csv|tsv)$/i.test(path)
}

function workspaceUrlTransform(url: string): string {
  if (url.startsWith("mako-file:")) return viewerFileUrl(url)
  if (/^(?:https?:|mailto:|#)/i.test(url)) return url
  return /^[a-z]+:/i.test(url) ? "" : url
}

function MediaPreview({ file }: { file: FileContents }) {
  if (file.previewUrl && file.media === "image") {
    return (
      <div className="flex min-h-full items-center justify-center overflow-auto bg-shell/40 p-5">
        <img
          src={viewerFileUrl(file.previewUrl)}
          alt={file.path}
          draggable={false}
          className="max-h-full max-w-full rounded-md object-contain shadow-[var(--elevation-card)]"
        />
      </div>
    )
  }
  if (file.previewUrl && file.media === "pdf") {
    return <PdfPreview url={viewerFileUrl(file.previewUrl)} name={file.path} />
  }
  if (file.previewUrl && file.media === "audio") {
    return (
      <div className="flex min-h-56 items-center justify-center p-6">
        <audio
          controls
          src={viewerFileUrl(file.previewUrl)}
          className="w-full max-w-xl"
        />
      </div>
    )
  }
  if (file.previewUrl && file.media === "video") {
    return (
      <div className="flex min-h-full items-center justify-center bg-shell/40 p-4">
        <video
          controls
          src={viewerFileUrl(file.previewUrl)}
          className="max-h-full max-w-full rounded-md"
        />
      </div>
    )
  }
  if (file.thumbnailUrl && file.media === "spreadsheet") {
    return (
      <div className="flex min-h-full items-start justify-center overflow-auto bg-shell/40 p-5">
        <img
          src={file.thumbnailUrl}
          alt={`Preview of ${file.path}`}
          draggable={false}
          className="max-w-full rounded-md object-contain shadow-[var(--elevation-card)]"
        />
      </div>
    )
  }
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-2 p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-lg bg-raised text-faint ring-1 ring-hairline ring-inset">
        <FileIcon className="size-4" />
      </span>
      <p className="text-ui font-medium text-muted-foreground">
        {file.media === "spreadsheet"
          ? "Open this workbook in your editor"
          : "Binary preview unavailable"}
      </p>
      <p className="max-w-sm text-label leading-relaxed text-faint">
        {formatBytes(file.size)} on disk. Mako previews CSV and TSV tables here;
        packaged workbooks stay in the editor that understands their formulas
        and formatting.
      </p>
    </div>
  )
}
