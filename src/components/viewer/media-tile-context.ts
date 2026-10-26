import { createContext } from "react"

/**
 * How a picture or video inside a grid draws: a `tile` (its thumbnail or
 * poster, cropped to the cell's `aspect`, width over height, past which
 * `more` wait as "+N"), or `hidden`
 * (past the grid's last tile: it only holds its place in the gallery, and
 * reads nothing until the lightbox reaches it). Absent, it draws at its
 * own size.
 */
export type MediaTile = { kind: "tile"; more?: number; aspect?: number } | { kind: "hidden" }

export const MediaTileContext = createContext<MediaTile | null>(null)
