import { FileIcon, FilmIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  formatBytes,
  useAttachmentPreview,
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
  if (items.length === 0) return null
  return (
    <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pt-4 pb-1" aria-label="Attachments">
      {items.map((item) =>
        /^(image|video|audio)\//.test(item.mimeType) ? (
          <Thumbnail key={item.id} item={item} onRemove={onRemove} />
        ) : (
          <FileTile key={item.id} item={item} onRemove={onRemove} />
        )
      )}
    </div>
  )
}

const tile =
  "pressable flex h-14 shrink-0 overflow-hidden rounded-lg bg-raised ring-1 ring-hairline ring-inset transition-[box-shadow] duration-150 hover:ring-border focus-visible:outline focus-visible:outline-ring"

function RemoveButton({ label, onRemove }: { label: string; onRemove(): void }) {
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

/** A text or other file: its name, how much there is, and, for text, a look inside. */
function FileTile({ item, onRemove }: { item: Attachment; onRemove(id: string): void }) {
  const label = item.contextLabel ?? item.name
  const lines = item.text === undefined ? undefined : item.text.replace(/\n$/, "").split("\n").length
  const detail =
    item.error ??
    (item.pending
      ? "Adding…"
      : [lines === undefined ? undefined : `${lines} ${lines === 1 ? "line" : "lines"}`, formatBytes(item.size)]
          .filter(Boolean)
          .join(" · "))
  const body = (
    <>
      <span className="truncate text-ui font-medium text-foreground">{label}</span>
      <span className={cn("truncate text-label", item.error ? "text-negative" : "text-faint")}>{detail}</span>
    </>
  )
  const face = cn(tile, "w-48 flex-col justify-center gap-0.5 px-3 text-left", item.error && "ring-negative/40")
  return (
    <div title={label === item.name ? item.name : `${label} · ${item.name}`} className={cn("group relative shrink-0", item.pending && "opacity-60")}>
      {item.text ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={`Show ${label}`} className={face}>
              {body}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-[min(40rem,calc(100vw-2rem))] overflow-hidden p-0">
            <div className="flex min-w-0 items-center gap-3 border-b border-hairline px-3 py-2 text-label">
              <span className="truncate font-medium text-foreground">{label}</span>
              <span className="ml-auto shrink-0 text-faint">{detail}</span>
            </div>
            <pre
              // Logs and pasted output matter at their end, so the view opens there.
              ref={(node) => {
                if (node) node.scrollTop = node.scrollHeight
              }}
              className="max-h-[50vh] overflow-y-auto px-3 py-2.5 font-mono text-label leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]"
            >
              {item.text}
            </pre>
          </PopoverContent>
        </Popover>
      ) : (
        <div className={face}>{body}</div>
      )}
      <RemoveButton label={label} onRemove={() => onRemove(item.id)} />
    </div>
  )
}

function Thumbnail({
  item,
  onRemove,
}: {
  item: Attachment
  onRemove(id: string): void
}) {
  const loaded = useAttachmentPreview(item)
  const preview = loaded?.kind === "ready" ? loaded.url : undefined
  const video = item.mimeType.startsWith("video/")
  const audio = item.mimeType.startsWith("audio/")
  const detail = item.error ?? (loaded?.kind === "unavailable" ? "Preview unavailable. Remove and reattach the file if it has moved." : item.pending ? "Adding…" : formatBytes(item.size))
  return (
    <div title={`${item.name} · ${detail}`} className={cn("group relative shrink-0", item.pending && "opacity-60")}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Preview ${item.name}`}
            className={cn(tile, "w-22 flex-col items-center justify-center gap-1 bg-background", item.error && "ring-negative/40")}
          >
            {preview && item.kind === "image" ? (
              <img src={preview} alt={item.name} className="attachment-preview size-full object-cover" decoding="async" />
            ) : preview && video ? (
              <video src={preview} muted playsInline preload="metadata" className="attachment-preview size-full object-cover" />
            ) : (
              <>
                {video ? <FilmIcon className="size-4 text-muted-foreground" /> : <FileIcon className="size-4 text-muted-foreground" />}
                <span className="max-w-full truncate px-2 text-label text-muted-foreground">{item.name}</span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-[min(36rem,calc(100vw-2rem))] overflow-hidden p-0">
          {preview && video ? (
            <video src={preview} controls playsInline preload="metadata" aria-label={item.name} className="max-h-[60vh] w-full bg-background" />
          ) : preview && audio ? (
            <audio src={preview} controls preload="none" aria-label={item.name} className="w-full" />
          ) : preview && item.kind === "image" ? (
            <img src={preview} alt={item.name} className="max-h-[60vh] w-full bg-background object-contain" decoding="async" />
          ) : null}
          <div className="flex min-w-0 items-center gap-3 border-t border-hairline px-3 py-2 text-label text-muted-foreground">
            <span className="truncate">{item.name}</span>
            <span className="ml-auto shrink-0">{detail}</span>
          </div>
        </PopoverContent>
      </Popover>
      <RemoveButton label={item.name} onRemove={() => onRemove(item.id)} />
    </div>
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
