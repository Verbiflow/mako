import type { Virtualizer } from "@tanstack/react-virtual"

type Rows = Virtualizer<HTMLDivElement, Element>
type Key = Rows["itemSizeCache"] extends Map<infer Key, number> ? Key : never

/** Off by this much is the two readings' rounding, not a row out of place. */
const ROUNDING = 1
/** Each row says so at most this often: a row with no observer is corrected on every token. */
const SAID_EVERY_MS = 10_000

/** The windowed column as it stands: what `check` reads each time. */
export interface MountedRows {
  rows: Rows
  list: Element | null
  keyOf(index: number): Key
  /** The parts of its turn so far, which say what changed since the row was last right. */
  partsOf(index: number): number
  streaming(index: number): boolean
  following: boolean
}

/** What a correction found, as its log line says it. */
interface Finding {
  what: "height" | "place"
  row: number
  stale: number
  real: number
  heard: false
  /** Whether the virtualizer still had this element for the row. */
  registered: boolean
  turns: number
  scrolling: boolean
  following: boolean
  streaming: boolean
  visibility: DocumentVisibilityState
  /** The turn's parts when the row was last right, and now. */
  parts: [number | undefined, number]
  rightMsAgo: number | undefined
}

interface Correction {
  element: Element
  key: Key
  fields: Finding
}

export interface RowChecker {
  /** The virtualizer's resize observer reported this row. */
  heard(element: Element): void
  /** Corrects what's stale; true when a correction waits to learn whether the observer heard that row. */
  check(mounted: MountedRows): boolean
}

/**
 * The transcript's last word on a windowed row's size and place. The virtualizer's resize observer keeps them, and it
 * only hears a size change, so a row the virtualizer misplaces without changing size stays misplaced: a long Apex was
 * seen with each report drawn over the answer above it and the crew card over the last line. Whatever does that, nobody
 * reads it: each mounted row is held against what the virtualizer has for it, before the frame paints. A correction
 * also runs with a working observer, a step ahead of it; only one that observer never reported is logged, with what
 * was found, so the next time names its cause (the window's warnings reach the host's log, `renderer-health`).
 */
export function rowChecker(): RowChecker {
  let heard = new WeakSet<Element>()
  let waiting: Correction[] = []
  let right = new Map<Key, { parts: number; at: number }>()
  const said = new Map<Key, number>()
  const tell = ({ key, fields }: Correction, now: number) => {
    if (now - (said.get(key) ?? -Infinity) < SAID_EVERY_MS) return
    said.set(key, now)
    if (said.size > 64) said.delete(said.keys().next().value!)
    console.warn(`Transcript row corrected ${JSON.stringify(fields)}`)
  }
  return {
    heard: (element) => void heard.add(element),
    check({ rows, list, keyOf, partsOf, streaming, following }) {
      const now = performance.now()
      for (const correction of waiting) {
        if (!heard.has(correction.element)) tell(correction, now)
      }
      waiting = []
      heard = new WeakSet()
      // A pane out of view has no sizes to go by.
      if (!list?.clientWidth) return false
      const mounted = new Map<number, Element>()
      const still = new Map<Key, { parts: number; at: number }>()
      const found = (index: number, key: Key, what: Finding["what"], stale: number, real: number, registered: boolean): Finding => ({
        what, row: index, stale, real, heard: false, registered, turns: rows.options.count, scrolling: rows.isScrolling,
        following, streaming: streaming(index), visibility: document.visibilityState,
        parts: [right.get(key)?.parts, partsOf(index)],
        rightMsAgo: right.has(key) ? Math.round(now - right.get(key)!.at) : undefined,
      })
      for (const element of list.children) {
        const index = Number(element.getAttribute("data-index"))
        if (!Number.isInteger(index) || index >= rows.options.count) continue
        mounted.set(index, element)
        const key = keyOf(index)
        const real = Math.round(element.getBoundingClientRect().height)
        const stale = rows.itemSizeCache.get(key) ?? rows.options.estimateSize(index)
        const registered = rows.elementsCache.get(key) === element
        // The virtualizer places only the rows it has, and a row it lost is observed again here.
        if (!registered) rows.measureElement(element)
        if (real === 0 || Math.abs(real - stale) <= ROUNDING) {
          still.set(key, { parts: partsOf(index), at: now })
          continue
        }
        waiting.push({ element, key, fields: found(index, key, "height", stale, real, registered) })
        rows.resizeItem(index, real)
        const before = right.get(key)
        if (before) still.set(key, before)
      }
      const top = list.getBoundingClientRect().top
      for (const item of rows.getVirtualItems()) {
        const element = mounted.get(item.index)
        if (!(element instanceof HTMLElement)) continue
        const placed = element.getBoundingClientRect().top - top
        const wanted = item.start - rows.options.scrollMargin
        if (Math.abs(placed - wanted) <= ROUNDING) continue
        element.style.transform = `translate3d(0, ${wanted}px, 0)`
        const key = keyOf(item.index)
        tell({ element, key, fields: found(item.index, key, "place", Math.round(placed), wanted, rows.elementsCache.get(key) === element) }, now)
      }
      right = still
      return waiting.length > 0
    },
  }
}
