/** A row's key, as the virtualizer keeps its size and element by. */
type Key = number | string | bigint

/** A row as the check reads it: an element of the list, and one it can move when it stands out of place. */
export interface RowElement {
  getAttribute(name: string): string | null
  getBoundingClientRect(): { height: number; top: number }
  style?: { transform: string }
}

/** What the check reads and corrects of the virtualizer, which the window's own satisfies whole. */
interface Rows<Row> {
  options: { count: number; scrollMargin: number; estimateSize(index: number): number }
  isScrolling: boolean
  itemSizeCache: Map<Key, number>
  elementsCache: Map<Key, Row>
  measureElement(node: Row | null): void
  resizeItem(index: number, size: number): void
  getVirtualItems(): readonly { index: number; start: number }[]
}

/** Off by this much is the two readings' rounding, not a row out of place. */
const ROUNDING = 1
/** Each row says so at most this often: a row with no observer is corrected on every token. */
const SAID_EVERY_MS = 10_000

/** The windowed column as it stands: what `check` reads each time. */
export interface MountedRows<Row extends RowElement = Element> {
  rows: Rows<Row>
  list: { clientWidth: number; children: Iterable<Row>; getBoundingClientRect(): { top: number } } | null
  keyOf(index: number): Key
  /** The parts of its turn so far, which say what changed since the row was last right. */
  partsOf(index: number): number
  streaming(index: number): boolean
  /**
   * The browser skips this row's contents (`content-visibility`), so its box is a placeholder and says nothing of its
   * size. Absent, every row is laid out.
   */
  skipped?(element: Row): boolean
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

interface Correction<Row> {
  element: Row
  key: Key
  fields: Finding
}

export interface RowChecker<Row extends RowElement = Element> {
  /** The virtualizer's resize observer reported this row. */
  heard(element: Row): void
  /**
   * Corrects what's stale; true when a correction waits to learn whether the observer heard that row. With `only`,
   * the rows something changed inside: their sizes are held against the virtualizer, and where one was stale, the
   * places of it and of the rows after it, the ones its size moves. Every row is read when none are named.
   */
  check(mounted: MountedRows<Row>, only?: ReadonlySet<Row>): boolean
}

/**
 * The transcript's last word on a windowed row's size and place. The virtualizer's resize observer keeps them, and it
 * only hears a size change, so a row the virtualizer misplaces without changing size stays misplaced: a long Apex was
 * seen with each report drawn over the answer above it and the Shiver card over the last line. Whatever does that, nobody
 * reads it: each mounted row is held against what the virtualizer has for it, before the frame paints. A correction
 * also runs with a working observer, a step ahead of it; only one that observer never reported is logged, with what
 * was found, so the next time names its cause (the window's warnings reach the host's log, `renderer-health`).
 *
 * A row's size is its own content's, so a change inside some rows asks only about those (`only`): a stream changes
 * one row a frame apart, and reading every mounted row's box twice for each frame was the cost of a long answer.
 */
export function rowChecker<Row extends RowElement = Element>(): RowChecker<Row> {
  let heard = new WeakSet<Row>()
  let waiting: Correction<Row>[] = []
  let right = new Map<Key, { parts: number; at: number }>()
  const said = new Map<Key, number>()
  const tell = ({ key, fields }: Correction<Row>, now: number) => {
    if (now - (said.get(key) ?? -Infinity) < SAID_EVERY_MS) return
    said.set(key, now)
    if (said.size > 64) said.delete(said.keys().next().value!)
    console.warn(`Transcript row corrected ${JSON.stringify(fields)}`)
  }
  return {
    heard: (element) => void heard.add(element),
    check({ rows, list, keyOf, partsOf, streaming, skipped, following }, only) {
      const now = performance.now()
      for (const correction of waiting) {
        if (!heard.has(correction.element)) tell(correction, now)
      }
      waiting = []
      heard = new WeakSet()
      // A pane out of view has no sizes to go by.
      if (!list?.clientWidth) return false
      const mounted = new Map<number, Row>()
      // Rows not looked at this time are as right as they were.
      const still = only ? new Map(right) : new Map<Key, { parts: number; at: number }>()
      /** The first row whose size was stale: places are read from it on. */
      let moved = Infinity
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
        if (only && !only.has(element)) continue
        const key = keyOf(index)
        const real = Math.round(element.getBoundingClientRect().height)
        const stale = rows.itemSizeCache.get(key) ?? rows.options.estimateSize(index)
        const registered = rows.elementsCache.get(key) === element
        // The virtualizer places only the rows it has, and a row it lost is observed again here.
        if (!registered) rows.measureElement(element)
        // A skipped row stands at the size the browser last remembered for it, which can be one from before its turn
        // finished: taken for its size, the column closed up under it, and the frame the browser drew it again (it
        // decides which rows it skips after this check, before the paint) painted it over what follows the rows.
        if (skipped?.(element)) {
          const before = right.get(key)
          if (before) still.set(key, before)
          continue
        }
        if (real === 0 || Math.abs(real - stale) <= ROUNDING) {
          still.set(key, { parts: partsOf(index), at: now })
          continue
        }
        waiting.push({ element, key, fields: found(index, key, "height", stale, real, registered) })
        rows.resizeItem(index, real)
        moved = Math.min(moved, index)
        const before = right.get(key)
        if (before) still.set(key, before)
        else still.delete(key)
      }
      if (only && moved === Infinity) {
        right = still
        return false
      }
      const top = list.getBoundingClientRect().top
      for (const item of rows.getVirtualItems()) {
        if (only && item.index < moved) continue
        const element = mounted.get(item.index)
        if (!element?.style) continue
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
