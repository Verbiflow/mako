import type { CSSProperties } from "react"

/**
 * The brand's steel blue (`--sea`) on a square mark: the one accent a pane carries. Builds before the token is in
 * the stylesheet read the same steel blue.
 */
const SEA = "var(--sea, oklch(0.62 0.085 246))"
export const SEA_MARK: CSSProperties = { color: SEA, backgroundColor: `color-mix(in oklab, ${SEA} 14%, transparent)` }
