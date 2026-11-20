import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { flushSync } from "react-dom"

/**
 * How much a tab bar's readings say, from the most to the least: their words ("2 need you"), a count ("2"), nothing
 * (the words only in the tab's tooltip and name), and nothing with the tabs drawn tighter. The bar picks the first that
 * fits its real width, so the tabs never scroll and never clip.
 */
export const TAB_FITS = ["words", "count", "bare", "tight"] as const
export type TabFit = (typeof TAB_FITS)[number]

export interface TabBarFit {
  fit: TabFit
  /** A tab's label or reading changed: what each fit needs is measured again. */
  changed: () => void
}

export const TabBarFitContext = createContext<TabBarFit>({ fit: "words", changed: () => undefined })

/** A tab's reading tells its tab the words it stands for, so the tab can carry them in its name and tooltip. */
export const TabWordsContext = createContext<(words: string | undefined) => void>(() => undefined)

export function useTabFit(): TabFit {
  return useContext(TabBarFitContext).fit
}

export function useTabWords(words: string | undefined): void {
  const report = useContext(TabWordsContext)
  useLayoutEffect(() => {
    report(words)
    return () => report(undefined)
  }, [report, words])
}

/**
 * The fit a bar's tabs take: measured with a ResizeObserver on the bar, never from a breakpoint.
 * Each fit's natural width is remembered once drawn, so the bar steps back up only to a fit known (or not yet known) to
 * fit, and a reading's words changing forgets them all.
 */
export function useTabBarFit(bar: RefObject<HTMLElement | null>, row: RefObject<HTMLElement | null>): TabBarFit {
  const [level, setLevel] = useState(0)
  const current = useRef(0)
  const needs = useRef<Array<number | undefined>>([])
  const measure = useCallback(function measure(): void {
    const outer = bar.current
    const inner = row.current
    if (!outer || !inner) return
    const style = getComputedStyle(outer)
    const room = outer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const need = inner.getBoundingClientRect().width
    const at = current.current
    needs.current[at] = need
    let next = at
    if (need > room + 0.5 && at < TAB_FITS.length - 1) next = at + 1
    else if (at > 0) {
      const above = needs.current[at - 1]
      if (above === undefined || above <= room + 0.5) next = at - 1
    }
    if (next === at) return
    current.current = next
    // Drawn now, before the frame paints, and measured again: two fits can be the same width (no readings to drop).
    flushSync(() => setLevel(next))
    measure()
  }, [bar, row])
  useLayoutEffect(() => {
    const outer = bar.current
    const inner = row.current
    if (!outer || !inner) return
    // Only the bar is watched: redrawing the tabs inside an observer that also watches them is a ResizeObserver loop.
    // What changes the tabs' own width is a label or a reading's words (`changed`), or the font arriving.
    const observer = new ResizeObserver(() => measure())
    observer.observe(outer)
    // Out of the layout effect (no flushSync inside one), still before the first paint.
    queueMicrotask(measure)
    let live = true
    void document.fonts?.ready.then(() => {
      if (live) {
        needs.current = []
        measure()
      }
    })
    return () => {
      live = false
      observer.disconnect()
    }
  }, [bar, row, measure])
  const changed = useCallback(() => {
    needs.current = []
    queueMicrotask(measure)
  }, [measure])
  return { fit: TAB_FITS[level] ?? "words", changed }
}
