import type { CSSProperties } from "react"
import { filePreviewFormat } from "@mako/host/contracts/file-preview"

export interface PreviewAsset { id: string; name: string; mimeType?: string; path?: string }

/** Tiles a grid draws; past them the last tile reads "+N" and the rest wait in the gallery. */
export const MEDIA_GRID_TILES = 6

/** A picture or a video, by its type or else its name. */
export function visualAsset(asset: PreviewAsset): boolean {
  const format = filePreviewFormat(asset.path ?? asset.name, asset.mimeType)
  return format === "image" || format === "video"
}

/** Columns for a grid of `count`: two for two or four, so no row holds a lone orphan it could share; three otherwise. */
export function mediaGridColumns(count: number): 1 | 2 | 3 {
  const shown = Math.min(count, MEDIA_GRID_TILES)
  return shown <= 1 ? 1 : shown === 2 || shown === 4 ? 2 : 3
}

/** The widest and tallest a picture or video draws inline, in rem: about a third of a reading column's height. */
const INLINE_MAX_REM = 30

/**
 * The box a picture or video draws in, before a byte of it loads: its own
 * aspect from the size its header states, no wider than the column, 30rem
 * or its own pixels, and no taller than 30rem. Without a size yet, a
 * screenshot's usual shape holds the place.
 */
export function mediaBox(width?: number, height?: number): CSSProperties {
  if (!width || !height) return { width: `min(100%, ${INLINE_MAX_REM}rem)`, aspectRatio: "16 / 10" }
  const ratio = width / height
  return {
    width: `min(100%, ${INLINE_MAX_REM}rem, ${(INLINE_MAX_REM * ratio).toFixed(3)}rem, ${width}px)`,
    aspectRatio: `${width} / ${height}`,
  }
}

