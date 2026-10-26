import { DiagnosticPreview } from "./diagnostic-preview"
import {
  diagnosticFormat,
  filePreviewFormat,
  officeFormat,
} from "@mako/host/contracts/file-preview"
import { OfficePreview } from "./office-preview"
import { PdfPreview } from "./pdf-preview"
import { resolveMarkdownMedia } from "@/lib/markdown-media"
import { ArtifactPreview } from "./artifact-preview"
import { HtmlFrame } from "./html-frame"
import { MediaVideo } from "./media-video"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react"
import type { SelectedLineRange } from "@pierre/diffs"
import { File, Virtualizer } from "@pierre/diffs/react"
import { LineCommentField } from "@/components/inspector/line-comment"
import { commentInput, commentLabel, fileCommentDetail, lineOfNode, workspacePath } from "@/lib/line-comments"
import { addContext } from "@/state/composer-context"
import { store } from "@/state/session"
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
  commentPath,
}: {
  file: FileContents
  line?: number
  mode: ViewerRenderMode
  /** The file's path when its lines can go into the message as a comment. */
  commentPath?: string
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

  if (mode === "preview" && file.previewUrl && filePreviewFormat(file.path, file.mimeType) === "html")
    return <HtmlFrame key={file.previewUrl} url={viewerFileUrl(file.previewUrl)} name={file.path.split("/").at(-1) ?? file.path} expanded />

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

  return commentPath ? (
    <CommentableSource host={host} file={file} line={line} path={commentPath} />
  ) : (
    <div ref={host}>
      <Virtualizer className="min-h-full">
        <File
          file={{ name: file.path, contents: file.contents }}
          selectedLines={line ? { start: line, end: line } : null}
          options={SOURCE_OPTIONS}
        />
      </Virtualizer>
    </div>
  )
}

const SOURCE_OPTIONS = { theme: DIFF_THEME, disableFileHeader: true }

/**
 * Lines picked in a file, and how they were picked: in the gutter (a
 * press on a line number, shift-press or a drag to extend), or as text
 * selected across the code. `null` is a pick let go; no pick at all leaves
 * the line the file was opened at highlighted.
 */
type Picked = { owner: string; range: SelectedLineRange | null; by: "gutter" | "text" }

/**
 * Source with its lines pickable for the message. The renderer draws the
 * pick with the selection tint and owns the gutter gestures; a text
 * selection inside the code picks the lines it touches. The field floats
 * under the last picked line, at the code's left edge, and scrolls with it.
 */
function CommentableSource({ host, file, line, path }: {
  host: RefObject<HTMLDivElement | null>
  file: FileContents
  line?: number
  path: string
}) {
  const owner = `${path}\n${line ?? ""}`
  const [state, setPicked] = useState<Picked>()
  const picked = state?.owner === owner ? state : undefined
  const selectedLines = useMemo(
    () => (picked ? picked.range : line ? { start: line, end: line } : null),
    [line, picked]
  )
  const ownerRef = useRef(owner)
  useEffect(() => {
    ownerRef.current = owner
  }, [owner])

  // Fires when a gutter press ends, never for a range set from here.
  const onLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    setPicked({ owner: ownerRef.current, range, by: "gutter" })
  }, [])
  const options = useMemo(() => ({ ...SOURCE_OPTIONS, enableLineSelection: true, onLineSelectionEnd }), [onLineSelectionEnd])

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-line-comment-float]")) return
    const range = selectedText(host.current)
    if (range) setPicked({ owner, range, by: "text" })
    else if (picked?.by === "text") setPicked({ owner, range: null, by: "text" })
  }

  const range = picked?.range ?? null
  const close = () => setPicked({ owner, range: null, by: picked?.by ?? "gutter" })
  const detail = range ? fileCommentDetail({ path: workspacePath(path, store.get().meta?.cwd), contents: file.contents, range }) : null

  return (
    <div ref={host} className="relative" onPointerUp={onPointerUp}>
      <Virtualizer className="min-h-full">
        <File
          file={{ name: file.path, contents: file.contents }}
          selectedLines={selectedLines}
          options={options}
        />
      </Virtualizer>
      {range && detail ? (
        <FloatingComment
          host={host}
          endLine={detail.endLine}
          label={commentLabel(detail)}
          focus={picked?.by === "gutter"}
          onClose={close}
          onAdd={(comment) => {
            const next = fileCommentDetail({ path: detail.path, contents: file.contents, range, comment })
            if (next) addContext(commentInput(next))
            close()
          }}
        />
      ) : null}
    </div>
  )
}

/** The rendered file's shadow root inside `host`. */
function codeRoot(host: HTMLElement | null): ShadowRoot | null {
  return host?.querySelector("diffs-container")?.shadowRoot ?? null
}

/**
 * The lines a text selection inside the code touches. A selection that
 * ends at the very start of a line (a drag to the next line's edge, a
 * triple click) does not take that line.
 */
function selectedText(host: HTMLElement | null): SelectedLineRange | null {
  const root = codeRoot(host)
  const selection = document.getSelection()
  // Seen from the document a selection inside a shadow root reads as
  // collapsed; only its composed range says what it covers.
  if (!root || !selection || !("getComposedRanges" in selection)) return null
  const [range] = selection.getComposedRanges({ shadowRoots: [root] })
  if (!range || range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = lineOfNode(range.startContainer)
  let end = lineOfNode(range.endContainer)
  if (start === null || end === null) return null
  if (range.endOffset === 0 && end > start) end -= 1
  return { start, end }
}

/** The field for picked lines, floating under the last of them. */
function FloatingComment({ host, endLine, label, focus, onAdd, onClose }: {
  host: RefObject<HTMLDivElement | null>
  endLine: number
  label: string
  focus: boolean
  onAdd: (comment: string) => void
  onClose: () => void
}) {
  const [place, setPlace] = useState<{ top: number; left: number }>()
  useLayoutEffect(() => {
    const node = host.current
    if (!node) return
    const measure = () => {
      const row = codeRoot(node)?.querySelector(`[data-line="${endLine}"]`)
      if (!row) return
      const outer = node.getBoundingClientRect()
      const box = row.getBoundingClientRect()
      setPlace({ top: box.bottom - outer.top + 4, left: Math.max(8, box.left - outer.left) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [endLine, host])
  if (!place) return null
  return (
    <div
      role="group"
      data-line-comment-float
      aria-label={`Comment on ${label}`}
      style={{ top: place.top, left: place.left }}
      className="overlay-panel animate-enter absolute z-10 w-[min(32rem,calc(100%-1rem))] p-1.5"
    >
      <LineCommentField label={label} focus={focus} onAdd={onAdd} onClose={onClose} />
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
        <MediaVideo
          key={file.previewUrl}
          url={viewerFileUrl(file.previewUrl)}
          poster={file.posterUrl && viewerFileUrl(file.posterUrl)}
          name={file.path}
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
