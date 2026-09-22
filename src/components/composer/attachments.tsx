import { PaperclipIcon, FileIcon, FilmIcon, XIcon } from "lucide-react"
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
 * Images stay visible while the draft is written. The inline chip keeps the
 * textarea's glyph-for-glyph overlay honest, so it can only show text; the
 * thumbnail row above it is where the screenshot is actually seen.
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
      {items.map((item) => (
        item.contextLabel ? <div key={item.id} title={item.error ?? (item.pending ? "Preparing context…" : item.name)} className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-raised pl-2 text-label", item.pending && "opacity-60", item.error && "text-negative")}>
          <PaperclipIcon className="size-3 text-muted-foreground" />
          <span className="max-w-64 truncate">{item.contextLabel}</span>
          <button type="button" aria-label={`Remove ${item.name}`} className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring" onMouseDown={event => event.preventDefault()} onClick={() => onRemove(item.id)}><XIcon className="size-3" /></button>
        </div> : <Thumbnail key={item.id} item={item} onRemove={onRemove} />
      ))}
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
            className={cn("pressable relative flex h-20 w-28 flex-col items-center justify-center gap-1 overflow-hidden rounded border border-border bg-background focus-visible:outline focus-visible:outline-ring", item.error && "border-negative/40")}
          >
            {preview && item.kind === "image" ? (
              <img src={preview} alt={item.name} className="attachment-preview size-full object-cover" decoding="async" />
            ) : preview && video ? (
              <video src={preview} muted playsInline preload="metadata" className="attachment-preview size-full object-cover" />
            ) : (
              <>
                {video ? <FilmIcon className="size-5 text-muted-foreground" /> : <FileIcon className="size-5 text-muted-foreground" />}
                <span className="max-w-full truncate px-2 text-label text-muted-foreground">{item.name}</span>
                {loaded?.kind === "unavailable" ? <span className="text-label text-muted-foreground">Preview unavailable</span> : null}
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
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onRemove(item.id)}
        className="pressable absolute top-1 right-1 flex size-5 items-center justify-center rounded-sm border border-border bg-popover text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

export function InlineAttachment({
  item,
  reference,
}: {
  item: Attachment
  reference: string
}) {
  return (
    <span
      data-attachment-reference
      aria-hidden
      className={cn(
        "rounded-sm bg-fill-selected [box-decoration-break:clone] text-foreground ring-1 ring-border ring-inset",
        item.pending && "opacity-60",
        item.error && "text-negative"
      )}
    >
      {reference}
    </span>
  )
}
