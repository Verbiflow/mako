import { useEffect, type RefObject } from "react"

export type OverflowEdges = "none" | "start" | "end" | "both"

/** Which edges of a horizontal scroller hide content. */
export function overflowEdges(input: {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}): OverflowEdges {
  const { scrollLeft, scrollWidth, clientWidth } = input
  const hiddenEnd = scrollWidth - clientWidth - scrollLeft > 1
  const hiddenStart = scrollLeft > 1
  if (hiddenStart && hiddenEnd) return "both"
  if (hiddenEnd) return "end"
  if (hiddenStart) return "start"
  return "none"
}

/**
 * The smallest compaction level at which the row fits, or `max` when none
 * does. `fits(0)` is the row with every label showing.
 */
export function compactLevel(fits: (level: number) => boolean, max: number): number {
  for (let level = 0; level < max; level++) if (fits(level)) return level
  return max
}

/**
 * Make a horizontal row of controls give way in a fixed order, then fade the
 * edge that still hides something.
 *
 * The row is stamped `data-compact="1"…"<levels>"`; CSS decides what each
 * level removes (`[data-collapse="n"]` children hide at level n and above).
 * The level is found by measuring: every label is restored, then levels are
 * applied one at a time until `scrollWidth` fits. The passes happen inside
 * one layout, so nothing paints in between, and a resize or scroll writes
 * straight to the DOM so the controls being measured do not re-render.
 *
 * Whatever still overflows scrolls, and `data-overflow` names the hidden
 * edge for the fade.
 */
export function useCompactRow(ref: RefObject<HTMLElement | null>, levels: number): void {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const fits = (level: number) => {
        if (level === 0) element.removeAttribute("data-compact")
        else element.setAttribute("data-compact", String(level))
        return element.scrollWidth - element.clientWidth <= 1
      }
      const level = compactLevel(fits, levels)
      if (level === 0) element.removeAttribute("data-compact")
      else element.setAttribute("data-compact", String(level))
      const edges = overflowEdges(element)
      if (edges === "none") element.removeAttribute("data-overflow")
      else element.setAttribute("data-overflow", edges)
    }
    update()
    const observer = new ResizeObserver(update)
    const observe = () => {
      observer.disconnect()
      observer.observe(element)
      for (const child of element.children) observer.observe(child)
    }
    observe()
    const children = new MutationObserver(() => {
      observe()
      update()
    })
    children.observe(element, { childList: true })
    element.addEventListener("scroll", update, { passive: true })
    return () => {
      observer.disconnect()
      children.disconnect()
      element.removeEventListener("scroll", update)
    }
  }, [ref, levels])
}
