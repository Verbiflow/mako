import { useCallback } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"

/**
 * The ref a virtualized row measures itself with, inside React's commit without a render forced there.
 *
 * A row's ref runs as React attaches it, in its commit. A row measured at other than its estimate moves the scroll to
 * keep what's read in place (at the list's end, or above the view), and react-virtual then renders at once with
 * `flushSync`. Inside a commit React refuses that ("flushSync was called from inside a lifecycle method") and renders
 * after the commit anyway: crew-card-ui said so in 5 runs of 8 under load (2026-11-16), from the crew card's rows.
 *
 * Here a change the measurement makes is held until it ends, then said as an ordinary one (`sync: false`). An update
 * made in the commit is one React renders before the frame is painted, which is what the flush was for, and
 * react-virtual still decides whether to render at all (`directDomUpdates`). A change from a scroll or a resize,
 * outside React, is said as it comes and still renders at once. Measuring later instead (a microtask) let a
 * windowed transcript's crossing move under its reader (`test:follow-ui`).
 */
export function useRowRef<TScroll extends Element | Window, TItem extends Element>(virtualizer: Virtualizer<TScroll, TItem>): (node: TItem | null) => void {
  return useCallback((node: TItem | null) => measureHeld(virtualizer, node), [virtualizer])
}

/** Measures a row with what the measurement changes held until it ends, then said once as an ordinary change. */
function measureHeld<TScroll extends Element | Window, TItem extends Element>(virtualizer: Virtualizer<TScroll, TItem>, node: TItem | null): void {
  if (!node) return virtualizer.measureElement(node)
  // The virtualizer says it changed through its options' `onChange`, which react-virtual's own is.
  const options = virtualizer.options
  const onChange = options.onChange
  let changed = false
  options.onChange = () => {
    changed = true
  }
  try {
    virtualizer.measureElement(node)
  } finally {
    options.onChange = onChange
  }
  if (changed) onChange?.(virtualizer, false)
}
