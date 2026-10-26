import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { XIcon } from "lucide-react"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import type { FileContents } from "@/lib/types"
import { cn } from "@/lib/utils"
import { AssetPreviewContext, type AssetView } from "./asset-preview-context"
import { ExpandedFilePreview } from "./expanded-file-preview"
import { OwnMediaGallery } from "./media-gallery"
import { MediaTileContext, type MediaTile } from "./media-tile-context"
import { MEDIA_GRID_TILES, mediaGridColumns, visualAsset, type PreviewAsset } from "./media-tile-layout"

export type { PreviewAsset }

const TILE: MediaTile = { kind: "tile" }
const HIDDEN: MediaTile = { kind: "hidden" }

/**
 * Groups only related assets at their place in the conversation. Pictures
 * and videos alone form a thumbnail grid whose tiles open the gallery;
 * anything mixed is a row of chips, the selected one drawn below. Closed
 * chips and tiles past the grid do no file reads.
 */
export function AssetPreviewCollection<T extends PreviewAsset>({ items, render, className, onRemove }: {
  items: readonly T[]
  render(item: T): ReactNode
  className?: string
  onRemove?(id: string): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [enlarged, setEnlarged] = useState(false)
  const [ready, setReady] = useState<{ id: string; file: FileContents | undefined; mode: AssetView; error?: string }>()
  const index = items.findIndex(item => item.id === selected)
  const asset = items[index]
  const id = asset?.id
  const resolved = useCallback((file: FileContents | undefined, mode: AssetView, error?: string) => {
    if (id) setReady(previous => previous?.id === id && previous.file === file && previous.mode === mode && previous.error === error ? previous : { id, file, mode, error })
  }, [id])
  const owner = useMemo(() => ({ enlarged, setEnlarged, resolved }), [enlarged, resolved])
  const current = ready?.id === id ? ready : undefined
  const select = (at: number) => { if (items[at]) setSelected(items[at].id) }
  const focusSelected = () => host.current?.querySelector<HTMLButtonElement>('[data-asset-selected="true"]') ?? null
  if (!items.length) return null
  if (items.length > 1 && items.every(visualAsset)) return <MediaGrid items={items} render={render} className={className} />
  return <div ref={host} data-asset-collection className={`not-prose my-3 min-w-0 text-ui ${className ?? ""}`}>
    <div className="flex flex-wrap gap-2" aria-label="Attachments">
      {items.map(item => <div key={item.id} className="group relative min-w-0 max-w-full">
        <button type="button" aria-label={`Show ${item.name}`} aria-pressed={id === item.id} data-copy-file={item.path} data-asset-selected={id === item.id} onClick={() => setSelected(id === item.id ? null : item.id)} className={`asset-surface pressable flex h-11 max-w-full items-center gap-2.5 border px-3 text-left ${id === item.id ? "border-border bg-fill-selected text-foreground" : "border-hairline bg-surface text-muted-foreground hover:bg-fill-hover hover:text-foreground"}`}>
          <FileTypeIcon path={item.name} mimeType={item.mimeType} className="size-4 shrink-0" />
          <span className="max-w-52 truncate text-label font-medium">{item.name}</span>
        </button>
        {onRemove ? <button type="button" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)} className="asset-surface pressable absolute -right-1 -top-1 grid size-5 place-items-center border border-hairline bg-popover text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"><XIcon className="size-3" /></button> : null}
      </div>)}
    </div>
    {asset ? <AssetPreviewContext value={owner}><div key={asset.id} className="mt-2 [&>[data-inline-file-preview]]:my-0 [&>[data-inline-document]]:my-0">{render(asset)}</div></AssetPreviewContext> : null}
    <ExpandedFilePreview file={current?.file} error={current?.error} identity={id} name={asset?.name ?? "Attachment"} mode={current?.mode} open={enlarged && !!asset} onOpenChange={setEnlarged} focusTarget={focusSelected} navigation={asset ? { index, count: items.length, previous: () => select(index - 1), next: () => select(index + 1) } : undefined} />
  </div>
}

/** Pictures and videos as tiles; the item's own renderer draws each as a tile through `MediaTileContext`. */
function MediaGrid<T extends PreviewAsset>({ items, render, className }: { items: readonly T[]; render(item: T): ReactNode; className?: string }) {
  const shown = items.slice(0, MEDIA_GRID_TILES)
  const more = items.length - shown.length
  const columns = mediaGridColumns(items.length)
  return <OwnMediaGallery>
    <div data-asset-collection data-media-grid={columns} className={cn("not-prose my-3 grid gap-1.5", columns === 2 ? "max-w-[min(100%,30rem)] grid-cols-2" : "max-w-[min(100%,36rem)] grid-cols-3", className)}>
      {shown.map((item, at) => <MediaTileContext key={item.id} value={more && at === shown.length - 1 ? { kind: "tile", more } : TILE}>{render(item)}</MediaTileContext>)}
    </div>
    {more ? <div hidden>
      {items.slice(shown.length).map(item => <MediaTileContext key={item.id} value={HIDDEN}>{render(item)}</MediaTileContext>)}
    </div> : null}
  </OwnMediaGallery>
}
