import { useState, type RefObject } from "react"
import { ExpandIcon, ImageOffIcon, PlayIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { MediaActions } from "@/components/viewer/media-actions"
import { MediaVideo } from "@/components/viewer/media-video"
import type { MediaTile } from "@/components/viewer/media-tile-context"
import { mediaBox, naturalSize, type MediaSize } from "@/components/viewer/media-tile-layout"
import { useDevicePixelRatio } from "@/components/viewer/use-device-pixel-ratio"
import type { FileContents } from "@/lib/types"
import { cn } from "@/lib/utils"
import { MediaUnavailable } from "./media-preview"

/**
 * A picture or video drawn as itself: no card, no header, a hairline and a
 * soft corner. Its name shows on hover and its actions sit in the corner;
 * a click opens the lightbox. In a grid it's a tile of its own shape
 * drawing the host's thumbnail or poster; the original loads only in the
 * lightbox. Neither ever draws a picture larger
 * than its own pixels, one to a device pixel: a small one sits at its size
 * in the middle of its tile or box.
 */
export function InlineMedia({ hostRef, path, name, format, file, error, tile, size, onOpen, onRetry, onMediaError, openPath }: {
  hostRef: RefObject<HTMLDivElement | null>
  /** What `data-inline-file-preview` names: the spelling the answer used. */
  path: string
  name: string
  format: "image" | "video"
  file?: FileContents
  error?: string
  tile: MediaTile | null
  /** Its pixels as known before it is read: the box holds its shape from the first frame. */
  size?: MediaSize
  onOpen?(): void
  onRetry(): void
  onMediaError(): void
  /** A path the actions can open, reveal and copy; absent for an inline attachment. */
  openPath?: string
}) {
  const [natural, setNatural] = useState<{ width: number; height: number }>()
  const ratio = useDevicePixelRatio()
  // The picture's own pixels: its header's, as read or as the host kept it, or the drawn one's once it loads.
  const known = file?.width && file.height ? file : size ?? natural
  const pixels = naturalSize(known?.width, known?.height, ratio)
  const url = file?.previewUrl
  if (tile?.kind === "hidden") return <div ref={hostRef} hidden data-inline-file-preview={path} />
  if (tile) {
    const picture = format === "image" ? file?.thumbnailUrl ?? url : file?.posterUrl
    return (
      <div ref={hostRef} data-inline-file-preview={path} data-media-tile className="w-full min-w-0">
        <button
          type="button"
          aria-label={tile.more ? `Open ${name} and ${tile.more} more` : `Open ${name}`}
          onClick={onOpen}
          style={{ aspectRatio: tile.aspect ?? 16 / 10 }}
          className="group/tile pressable relative grid w-full cursor-zoom-in place-items-center overflow-hidden media-surface border border-hairline bg-shell"
        >
          {error ? (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3 text-label text-faint">
              <ImageOffIcon className="size-4" aria-hidden />
              <span className="max-w-full truncate">{name}</span>
            </span>
          ) : picture ? (
            <img
              src={picture}
              alt={name}
              loading="lazy"
              decoding="async"
              onError={onMediaError}
              onLoad={(event) => {
                const image = event.currentTarget
                if (!file?.width && image.naturalWidth) setNatural({ width: image.naturalWidth, height: image.naturalHeight })
              }}
              // Cropped to fill the tile only as far as its pixels reach: past them it stays its size, centred.
              style={pixels && { maxWidth: pixels.width, maxHeight: pixels.height }}
              className="block size-full object-cover"
            />
          ) : format === "image" || !file ? (
            <Skeleton className="block size-full" />
          ) : null}
          {format === "video" && !error ? (
            <span className="absolute inset-0 grid place-items-center">
              <span className="media-play grid size-10 place-items-center rounded-full">
                <PlayIcon className="size-4 translate-x-px fill-current" aria-hidden />
              </span>
            </span>
          ) : null}
          {tile.more ? (
            <span className="media-more absolute inset-0 grid place-items-center text-title font-medium tabular-nums">+{tile.more}</span>
          ) : (
            <span className="media-control pointer-events-none absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded-md px-2 py-0.5 text-left text-label opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100">{name}</span>
          )}
        </button>
      </div>
    )
  }
  if (error)
    return (
      <div ref={hostRef} data-inline-file-preview={path} className="not-prose my-3">
        <MediaUnavailable name={name} reason={error} onRetry={onRetry} />
      </div>
    )
  const box = mediaBox(known?.width, known?.height, ratio)
  return (
    <div ref={hostRef} data-inline-file-preview={path} data-inline-media={format} className="not-prose my-3 w-full">
      <div className="group/media relative max-w-full" style={box}>
        {format === "image" ? (
          <button type="button" aria-label={`Open ${name}`} onClick={onOpen} className="pressable block size-full cursor-zoom-in overflow-hidden media-surface border border-hairline bg-shell/40">
            {url ? (
              <img
                src={url}
                alt={name}
                loading="lazy"
                decoding="async"
                onError={onMediaError}
                onLoad={(event) => {
                  const image = event.currentTarget
                  if (!file?.width && image.naturalWidth) setNatural({ width: image.naturalWidth, height: image.naturalHeight })
                }}
                className="block size-full object-contain"
              />
            ) : (
              <Skeleton className="block size-full" />
            )}
          </button>
        ) : url ? (
          <MediaVideo url={url} poster={file?.posterUrl} name={name} onError={onMediaError} className="block size-full media-surface border border-hairline bg-shell object-contain" />
        ) : (
          <div className="size-full overflow-hidden media-surface border border-hairline bg-shell"><Skeleton className="block size-full rounded-none" /></div>
        )}
        <span className={cn("media-control pointer-events-none absolute left-1.5 max-w-[calc(100%-6rem)] truncate rounded-md px-2 py-1 text-label opacity-0 transition-opacity duration-150 group-hover/media:opacity-100", format === "image" ? "bottom-1.5" : "top-1.5")}>{name}</span>
        {file ? (
          <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/media:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
            {format === "video" && onOpen ? (
              <button type="button" aria-label={`Expand ${name}`} title="Expand" onClick={onOpen} className="media-control pressable grid size-7 place-items-center rounded-md">
                <ExpandIcon className="size-3.5" />
              </button>
            ) : null}
            <MediaActions file={file} name={name} path={openPath} className="media-control" />
          </div>
        ) : null}
      </div>
    </div>
  )
}
