/**
 * The stage never splits by percentage. A fraction grows the companion with
 * the monitor, which is exactly backwards: a diff needs a fixed readable
 * width and the conversation deserves everything left over. So the chat
 * reserves its minimum, the companion keeps a fixed width the user can drag,
 * and the clamp mediates when the window cannot afford both.
 */

export const CHAT_MIN = 450
export const CHAT_HEIGHT_MIN = 260
export const COMPANION_MIN_DEFAULT = 340
/** The right rail until it is dragged: the left rail's widest, as they are twins. */
export const COMPANION_DEFAULT = 420
/** The visible divider between tiled workbench panes. */
export const STAGE_GUTTERS = 1

export function clampCompanionWidth(input: {
  width: number
  /** The stage row's measured width; undefined before the first measure. */
  available: number | undefined
  min: number
}): number {
  const { width, available, min } = input
  // Before the ResizeObserver has spoken, trust the stored width — clamping
  // against a guess would snap the pane on the first frame.
  if (available === undefined) return Math.max(width, min)
  const most = available - CHAT_MIN - STAGE_GUTTERS
  return Math.min(Math.max(width, min), Math.max(most, min))
}

/** Whether a beside split physically fits; below this the companion covers. */
export function fitsBeside(available: number | undefined, min: number): boolean {
  if (available === undefined) return true
  return available >= CHAT_MIN + min + STAGE_GUTTERS
}

export function clampDockHeight(input: {
  height: number
  available: number | undefined
  min: number
}): number {
  const { height, available, min } = input
  if (available === undefined) return Math.max(height, min)
  const most = Math.max(
    Math.min(Math.floor(available * 0.7), available - CHAT_HEIGHT_MIN),
    min
  )
  return Math.min(Math.max(height, min), most)
}
