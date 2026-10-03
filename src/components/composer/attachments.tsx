import { FilePreviewTile } from "./diagnostic-tile"
import {
  diagnosticFormat,
  filePreviewFormat,
  officeFormat,
} from "../../../electron/contracts/file-preview"
import { InlineFilePreview } from "@/components/transcript/file-preview"
import { ExpandedFilePreview } from "@/components/viewer/expanded-file-preview"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { resolveMarkdownMedia } from "@/lib/markdown-media"
import { Prose } from "@/components/transcript/markdown"
import { ArtifactPreview } from "@/components/viewer/artifact-preview"
import { ExpandIcon, XIcon } from "lucide-react"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { useCompactRow } from "@/components/composer/use-compact-row"
import { fileDir, fileName } from "@/lib/format"
import {
  readGitConflictContext,
  type GitConflictSnapshot,
} from "@/lib/git-conflict-context"
import {
  formatBytes,
  useAttachmentPreview,
  useAttachmentText,
  type Attachment,
} from "@/lib/attachments"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * What the draft carries, as tiles of one height above it. The inline
 * reference keeps the textarea's glyph-for-glyph overlay honest, so it can
 * only show text; the tile is where a screenshot is seen and where a text
 * file says what it is and opens to what it holds.
 */
export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: Attachment[]
  onRemove(id: string): void
}) {
  return items.length === 0 ? null : <Strip items={items} onRemove={onRemove} />
}

/**
 * The row scrolls without a scrollbar; the edge still hiding a tile fades.
 * The composer renders on every keystroke, so the row and its tiles are
 * memoised: a tile renders again only when its own attachment changes, which
 * needs `onRemove` to keep its identity.
 */
const Strip = memo(function Strip({
  items,
  onRemove,
}: {
  items: Attachment[]
  onRemove(id: string): void
}) {
  const strip = useRef<HTMLDivElement>(null)
  useCompactRow(strip, 0)
  return (
    <div
      ref={strip}
      className="attachment-strip flex shrink-0 [scrollbar-width:none] gap-2 overflow-x-auto px-4 pt-4 pb-1"
      aria-label="Attachments"
    >
      {items.map((item) =>
        diagnosticFormat(item.name) ||
        officeFormat(item.name, item.mimeType) ? (
          <FilePreviewTile key={item.id} item={item} onRemove={onRemove} />
        ) : /^(image|video|audio)\//.test(item.mimeType) ||
          item.mimeType === "application/pdf" ? (
          <Thumbnail key={item.id} item={item} onRemove={onRemove} />
        ) : (
          <FileTile key={item.id} item={item} onRemove={onRemove} />
        )
      )}
    </div>
  )
})

const tile =
  "pressable flex h-14 shrink-0 overflow-hidden rounded-lg bg-raised ring-1 ring-hairline ring-inset transition-[box-shadow] duration-150 hover:ring-border focus-visible:outline focus-visible:outline-ring"

function RemoveButton({
  label,
  onRemove,
}: {
  label: string
  onRemove(): void
}) {
  return (
    <button
      type="button"
      aria-label={`Remove ${label}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRemove}
      className="pressable absolute -top-1.5 -right-1.5 flex size-5 scale-90 items-center justify-center rounded-full bg-popover text-muted-foreground opacity-0 shadow-[var(--elevation-floating)] transition-[opacity,scale,color] duration-150 group-hover:scale-100 group-hover:opacity-100 hover:text-foreground focus-visible:scale-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-ring"
    >
      <XIcon className="size-3" />
    </button>
  )
}

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`

/** A line a person scanning output would read as the failure. */
const FAILURE_LINE = /\b(error|failed|fatal|exception|panic)\b|✗|✘/i

/** Longer than a miniature can show at half size; a minified line stays cheap to lay out. */
const GLANCE_CHARS = 80

interface Glance {
  lines: number
  head: string[]
  /** The last lines with something on them, for terminal output. */
  tail: string[]
}

/**
 * What a tile shows of a text, found by scanning for line breaks rather than
 * splitting: a text can be 200 KB, and only its ends and its line count are
 * drawn.
 */
function glance(text: string): Glance {
  let lines = 1
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    lines++
  if (text.endsWith("\n")) lines--
  const head: string[] = []
  for (let start = 0; head.length < 6;) {
    const end = text.indexOf("\n", start)
    head.push(
      text.slice(
        start,
        end === -1 ? start + GLANCE_CHARS : Math.min(end, start + GLANCE_CHARS)
      )
    )
    if (end === -1) break
    start = end + 1
  }
  const tail: string[] = []
  for (
    let end = text.length, scanned = 0;
    end > 0 && tail.length < 5 && scanned < 200;
    scanned++
  ) {
    const at = text.lastIndexOf("\n", end - 1)
    const line = text.slice(at + 1, Math.min(end, at + 1 + GLANCE_CHARS))
    if (line.trim()) tail.unshift(line)
    end = at
  }
  return { lines, head, tail }
}

/** Logs and pasted output matter at their end, so the view opens there. Module-level so it runs once per opening, not on every render. */
function openAtEnd(node: HTMLPreElement | null) {
  if (node) node.scrollTop = node.scrollHeight
}

/**
 * The tile's left square, drawn from what the file is: terminal output as the
 * foot of a terminal, a conflict snapshot as conflict markers, other text as
 * the top of a page, anything else as its extension. It is a thumbnail: laid
 * out at the type scale and shrunk by half, so the lines are texture and the
 * popover is where the file is read.
 */
function Face({ item, text }: { item: Attachment; text: Glance | undefined }) {
  const surface =
    item.origin === "terminal" ? "bg-[var(--terminal-face)]" : "bg-background"
  return (
    <span
      aria-hidden
      className={cn(
        "relative h-full w-18 shrink-0 overflow-hidden border-r border-hairline",
        surface
      )}
    >
      {text === undefined && item.origin !== "terminal" ? (
        <span className="absolute inset-0 flex items-center justify-center text-label font-medium text-faint">
          <FileTypeIcon path={item.name} mimeType={item.mimeType} className="size-6" />
        </span>
      ) : (
        <span className="absolute top-0 left-0 flex h-[200%] w-[200%] origin-top-left scale-50 flex-col p-3 font-mono text-label leading-[17px]">
          <Miniature origin={item.origin} text={text} />
        </span>
      )}
    </span>
  )
}

function Miniature({
  origin,
  text,
}: {
  origin: Attachment["origin"]
  text: Glance | undefined
}) {
  const line = "overflow-hidden whitespace-pre"
  if (origin === "terminal") {
    const lines = text?.tail.length ? text.tail : ["$"]
    return (
      <span className="mt-auto flex flex-col">
        {lines.map((text, index) => (
          <span
            key={index}
            className={cn(
              line,
              FAILURE_LINE.test(text)
                ? "text-[var(--terminal-face-alert)]"
                : "text-[var(--terminal-face-ink)]"
            )}
          >
            {text}
          </span>
        ))}
      </span>
    )
  }
  if (origin === "git-conflicts") {
    const band = "h-1.5 shrink-0 rounded-[2px]"
    const ours = "bg-[color-mix(in_oklab,var(--added)_60%,transparent)]"
    const theirs =
      "bg-[color-mix(in_oklab,var(--terminal-blue)_60%,transparent)]"
    return (
      <span className="my-auto flex flex-col gap-[3px] leading-[14px] text-faint">
        <span>{"<<<<<<<"}</span>
        <span className={cn(band, ours, "w-20")} />
        <span className={cn(band, ours, "w-14")} />
        <span>{"======="}</span>
        <span className={cn(band, theirs, "w-16")} />
        <span className={cn(band, theirs, "w-22")} />
        <span>{">>>>>>>"}</span>
      </span>
    )
  }
  return (
    <>
      {(text?.head ?? []).map((text, index) => (
        <span key={index} className={cn(line, "text-faint")}>
          {text || " "}
        </span>
      ))}
    </>
  )
}

/** A text or other file: what it is at a glance, its name and size, and, for text, a look inside. */
const FileTile = memo(function FileTile({
  item,
  onRemove,
}: {
  item: Attachment
  onRemove(id: string): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const label = item.contextLabel ?? item.name
  const source = useAttachmentText(item)
  const [view, setView] = useState<"preview" | "source">("preview")
  const [open, setOpen] = useState(false)
  const [enlarged, setEnlarged] = useState(false)
  const markdown = filePreviewFormat(item.name, item.mimeType) === "markdown"
  const html = filePreviewFormat(item.name, item.mimeType) === "html"
  const text = useMemo(
    () => (source === undefined ? undefined : glance(source)),
    [source]
  )
  const conflict = useMemo(
    () =>
      item.origin === "git-conflicts" && source
        ? readGitConflictContext(source)
        : null,
    [item.origin, source]
  )
  const lines = text?.lines
  const detail =
    item.error ??
    (item.pending
      ? "Adding…"
      : conflict
        ? conflict.blocker
          ? "Incoming changes blocked"
          : [plural(conflict.conflictedPaths.length, "file"), conflict.branch]
              .filter(Boolean)
              .join(" · ")
        : [
            lines === undefined ? undefined : plural(lines, "line"),
            formatBytes(item.size),
          ]
            .filter(Boolean)
            .join(" · "))
  const body = (
    <>
      <Face item={item} text={text} />
      <span className="flex min-w-0 flex-col justify-center gap-0.5 px-3">
        <span className="truncate text-ui font-medium text-foreground">
          {label}
        </span>
        <span
          className={cn(
            "truncate text-label",
            item.error ? "text-negative" : "text-faint"
          )}
        >
          {detail}
        </span>
      </span>
    </>
  )
  const face = cn(tile, "w-60 text-left", item.error && "ring-negative/40")
  return (
    <div
      ref={host}
      title={label === item.name ? item.name : `${label} · ${item.name}`}
      className={cn("group relative shrink-0", item.pending && "opacity-60")}
    >
      {source !== undefined ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label={`Show ${label}`} className={face}>
              {body}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="w-[min(40rem,calc(100vw-2rem))] overflow-hidden p-0"
          >
            <div className="flex min-w-0 items-center gap-3 border-b border-hairline px-3 py-2 text-label">
              <span className="truncate font-medium text-foreground">
                {label}
              </span>
              {markdown || html ? (
                <div
                  className="ml-auto flex shrink-0 gap-1"
                  aria-label="Document view"
                >
                  {(["preview", "source"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={view === mode}
                      onClick={() => setView(mode)}
                      className={cn(
                        "pressable rounded px-2 py-1",
                        view === mode
                          ? "bg-fill-selected text-foreground"
                          : "text-muted-foreground hover:bg-fill-hover"
                      )}
                    >
                      {mode === "preview" ? "Preview" : "Source"}
                    </button>
                  ))}
                </div>
              ) : null}
              <span className="ml-auto shrink-0 text-faint">{detail}</span>
              <button type="button" aria-label={`Expand ${label}`} onClick={() => setEnlarged(true)} className="pressable rounded p-1 text-muted-foreground hover:bg-fill-hover"><ExpandIcon className="size-4" /></button>
            </div>
            {open && !enlarged ? conflict ? (
              <ConflictList snapshot={conflict} />
            ) : view === "preview" && markdown ? (
              <div className="max-h-[50vh] overflow-y-auto p-4">
                <Prose
                  text={
                    item.stagedPath
                      ? resolveMarkdownMedia(source, item.stagedPath)
                      : source
                  }
                />
              </div>
            ) : view === "preview" && html ? (
              <div className="max-h-[50vh] overflow-y-auto">
                <ArtifactPreview html={source} name={item.name} />
              </div>
            ) : (
              <pre
                ref={openAtEnd}
                className={cn(
                  "max-h-[50vh] overflow-y-auto px-3 py-2.5 font-mono text-label leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap",
                  item.origin === "terminal"
                    ? "bg-terminal text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {source}
              </pre>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : (
        <div className={face}>{body}</div>
      )}
      {source !== undefined ? <ExpandedFilePreview name={label} file={{ path: item.stagedPath ?? item.name, contents: source, mimeType: item.mimeType, size: item.size ?? new TextEncoder().encode(source).length, binary: false, truncated: false }} mode={view} open={enlarged} onOpenChange={setEnlarged} focusTarget={() => host.current?.querySelector<HTMLButtonElement>('button[data-slot="popover-trigger"]') ?? null} /> : null}
      <RemoveButton label={item.name} onRemove={() => onRemove(item.id)} />
    </div>
  )
})

/** A conflict snapshot as the files it names, not the JSON the agent reads. */
function ConflictList({ snapshot }: { snapshot: GitConflictSnapshot }) {
  return (
    <div className="max-h-[50vh] overflow-y-auto py-1.5 text-ui">
      {snapshot.blocker ? (
        <p className="px-3 py-1 text-muted-foreground">
          {snapshot.blocker.message}
        </p>
      ) : null}
      {snapshot.conflictedPaths.map((path) => (
        <div key={path} className="flex min-w-0 items-baseline gap-2 px-3 py-1">
          <span className="shrink-0 text-foreground">{fileName(path)}</span>
          <span className="truncate text-label text-faint">
            {fileDir(path)}
          </span>
        </div>
      ))}
      <p className="border-t border-hairline px-3 pt-2 pb-1 text-label text-faint first-letter:uppercase">
        {[
          snapshot.operation ? `${snapshot.operation} in progress` : undefined,
          snapshot.branch ? `on ${snapshot.branch}` : undefined,
          "as it was when attached",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  )
}

const Thumbnail = memo(function Thumbnail({
  item,
  onRemove,
}: {
  item: Attachment
  onRemove(id: string): void
}) {
  const loaded = useAttachmentPreview(item)
  const preview = loaded?.kind === "ready" ? loaded.url : undefined
  const [failedPreview, setFailedPreview] = useState<string>()
  const unavailable = loaded?.kind === "unavailable" || Boolean(preview && failedPreview === preview)
  const image = item.mimeType.startsWith("image/")
  const video = item.mimeType.startsWith("video/")
  const [open, setOpen] = useState(false)
  const detail =
    item.error ??
    (loaded?.kind === "unavailable"
      ? "Preview unavailable. Remove and reattach the file if it has moved."
      : item.pending
        ? "Adding…"
        : formatBytes(item.size))
  return (
    <div
      title={`${item.name} · ${detail}`}
      className={cn("group relative shrink-0", item.pending && "opacity-60")}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Preview ${item.name}`}
            className={cn(
              tile,
              unavailable ? "w-52 items-center gap-3 px-3 text-left" : "w-22 flex-col items-center justify-center gap-1 bg-background",
              item.error && "ring-negative/40"
            )}
          >
            {unavailable ? (
              <>
                <FileTypeIcon path={item.name} mimeType={item.mimeType} className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-label text-foreground">{item.name}</span>
                  <span className="block text-label text-faint">{formatBytes(item.size) || "File"}</span>
                </span>
              </>
            ) : preview && image ? (
              <ImageThumb url={preview} alt={item.name} onUnavailable={() => setFailedPreview(preview)} />
            ) : preview && video ? (
              <video
                src={preview}
                muted
                playsInline
                preload="metadata"
                onError={() => setFailedPreview(preview)}
                className="attachment-preview size-full object-cover"
              />
            ) : (
              <>
                <FileTypeIcon path={item.name} mimeType={item.mimeType} className="size-4 text-muted-foreground" />
                <span className="max-w-full truncate px-2 text-label text-muted-foreground">
                  {item.name}
                </span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(36rem,calc(100vw-2rem))] overflow-hidden p-0 [&>[data-inline-file-preview]]:my-0 [&>[data-inline-file-preview]]:border-0"
        >
          {open ? item.stagedPath ? (
            <InlineFilePreview path={item.stagedPath} name={item.name} mimeType={item.mimeType} initiallyOpen />
          ) : preview ? (
            <InlineFilePreview path={item.name} name={item.name} mimeType={item.mimeType} initiallyOpen sizeKnown={item.size !== undefined} resolvedFile={{ path: item.name, previewUrl: preview, contents: "", binary: true, truncated: false, size: item.size ?? 0, mimeType: item.mimeType }} />
          ) : (
            <p className="px-4 py-6 text-ui text-muted-foreground">
              {loaded?.kind === "unavailable"
                ? "This file could not be previewed. Reattach it to try again."
                : "Loading preview…"}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
      <RemoveButton label={item.name} onRemove={() => onRemove(item.id)} />
    </div>
  )
})

/** The tile's box in CSS pixels; the thumbnail is decoded to cover it and no larger. */
const THUMB = { width: 88, height: 56 }

/**
 * A picture at the size of its tile. An `<img>` of the original keeps the
 * whole picture decoded for as long as the tile shows, about 59 MB for a 5K
 * screenshot, to paint 88 by 56 pixels. Here the picture is decoded once at
 * tile size and the full one is dropped; the popover decodes the original only
 * while it is open. The bitmap is shown, never read back, so a preview served
 * from another origin (`mako-file:`) draws as well as a pasted one.
 */
function ImageThumb({ url, alt, onUnavailable }: { url: string; alt: string; onUnavailable(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<{
    url: string
    kind: "ready" | "failed"
  } | null>(null)
  useEffect(() => {
    let live = true
    const image = new Image()
    const release = () => {
      image.onload = image.onerror = null
      image.src = ""
    }
    image.onload = () => {
      const scale =
        Math.min(
          1,
          Math.max(
            THUMB.width / image.naturalWidth,
            THUMB.height / image.naturalHeight
          )
        ) * devicePixelRatio
      void createImageBitmap(image, {
        resizeWidth: Math.max(1, Math.round(image.naturalWidth * scale)),
        resizeHeight: Math.max(1, Math.round(image.naturalHeight * scale)),
        resizeQuality: "medium",
      }).then(
        (bitmap) => {
          release()
          const node = canvas.current
          if (!live || !node) return bitmap.close()
          node.width = bitmap.width
          node.height = bitmap.height
          node.getContext("bitmaprenderer")?.transferFromImageBitmap(bitmap)
          setState({ url, kind: "ready" })
        },
        () => {
          release()
          if (live) setState({ url, kind: "failed" })
        }
      )
    }
    image.onerror = () => live && setState({ url, kind: "failed" })
    image.src = url
    return () => {
      live = false
      release()
    }
  }, [url])
  const shown = state?.url === url ? state.kind : undefined
  useEffect(() => {
    if (shown === "failed") onUnavailable()
  }, [shown, onUnavailable])
  if (shown === "failed")
    return (
      <span className="px-2 text-center text-label leading-tight text-muted-foreground">
        Preview unavailable
      </span>
    )
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={alt}
      data-ready={shown === "ready" || undefined}
      className="size-full object-cover opacity-0 transition-opacity duration-150 data-ready:opacity-100"
    />
  )
}

/** An attachment's place in the draft: `[web output]` with the brackets gone into the fill's air. */
export function InlineAttachment({
  item,
  reference,
}: {
  item: Attachment
  reference: string
}) {
  const bracketed = reference.startsWith("[") && reference.endsWith("]")
  return (
    <span
      data-attachment-reference
      data-pending={item.pending || undefined}
      data-error={item.error ? "" : undefined}
      aria-hidden
      className="ref-token"
    >
      {bracketed ? (
        <>
          <span className="ref-bracket">[</span>
          {reference.slice(1, -1)}
          <span className="ref-bracket">]</span>
        </>
      ) : (
        reference
      )}
    </span>
  )
}
