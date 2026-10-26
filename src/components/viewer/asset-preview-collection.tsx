import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { XIcon } from "lucide-react"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import type { FileContents } from "@/lib/types"
import { cn } from "@/lib/utils"
import { AssetPreviewContext, type AssetView } from "./asset-preview-context"
import { ExpandedFilePreview } from "./expanded-file-preview"
import { OwnMediaGallery } from "./media-gallery"
import { MediaTileContext, type MediaTile } from "./media-tile-context"
import { MEDIA_GRID_TILES, mediaGridColumns, mediaRows, naturalSize, visualAsset, type PreviewAsset } from "./media-tile-layout"
import { useDevicePixelRatio } from "./use-device-pixel-ratio"

export type { PreviewAsset }

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
          <span className="max-w-52 truncate text-label font-medium">{item.caption ?? item.name}</span>
        </button>
        {onRemove ? <button type="button" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)} className="asset-surface pressable absolute -right-1 -top-1 grid size-5 place-items-center border border-hairline bg-popover text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"><XIcon className="size-3" /></button> : null}
      </div>)}
    </div>
    {asset ? <AssetPreviewContext value={owner}><div key={asset.id} className="mt-2 [&>[data-inline-file-preview]]:my-0 [&>[data-inline-document]]:my-0">{render(asset)}</div></AssetPreviewContext> : null}
    <ExpandedFilePreview file={current?.file} error={current?.error} identity={id} name={asset?.name ?? "Attachment"} mode={current?.mode} open={enlarged && !!asset} onOpenChange={setEnlarged} focusTarget={focusSelected} navigation={asset ? { index, count: items.length, previous: () => select(index - 1), next: () => select(index + 1) } : undefined} />
  </div>
}

/**
 * Pictures and videos as tiles, in rows that share a height, each tile its
 * picture's own shape (`mediaRows`); the item's own renderer draws each as
 * a tile through `MediaTileContext`, its caption under it. A tile is never
 * wider than a picture drawn alone or than its own pixels, so a small chart
 * beside a screenshot stays its size instead of floating in an empty tile.
 */
function MediaGrid<T extends PreviewAsset>({ items, render, className }: { items: readonly T[]; render(item: T): ReactNode; className?: string }) {
  const shown = items.slice(0, MEDIA_GRID_TILES)
  const more = items.length - shown.length
  const last = shown.at(-1)
  const ratio = useDevicePixelRatio()
  // No tile wider than a picture drawn alone (30rem), nor than its own pixels.
  const widest = (item: T, aspect: number) => {
    const pixels = naturalSize(item.size?.width, item.size?.height, ratio)
    return pixels ? `min(30rem, ${Math.min(pixels.width, pixels.height * aspect)}px)` : "30rem"
  }
  return <OwnMediaGallery>
    <div data-asset-collection data-media-grid={mediaGridColumns(items.length)} className={cn("not-prose my-3 flex w-full flex-col gap-1.5", className)}>
      {mediaRows(shown).map((row) => <div key={row.tiles[0]!.item.id} className="flex items-start gap-1.5">
        {row.tiles.map(({ item, aspect }) => <figure key={item.id} className="m-0 flex min-w-0 flex-col gap-1.5" style={{ flex: `${aspect} 1 0%`, maxWidth: widest(item, aspect) }}>
          <MediaTileContext value={{ kind: "tile", aspect, ...more && item === last && { more } }}>{render(item)}</MediaTileContext>
          {item.caption ? <figcaption className="line-clamp-2 text-label text-muted-foreground">{item.caption}</figcaption> : null}
        </figure>)}
        {row.filler ? <div aria-hidden style={{ flex: `${row.filler} 1 0%` }} /> : null}
      </div>)}
    </div>
    {more ? <div hidden>
      {items.slice(shown.length).map(item => <MediaTileContext key={item.id} value={HIDDEN}>{render(item)}</MediaTileContext>)}
    </div> : null}
  </OwnMediaGallery>
}
