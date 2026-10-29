import { getHeapStatistics } from "node:v8"

/**
 * The shares of the heap limit at which the host says it's under pressure:
 * once past the first, again past the second. Chosen so the first line lands
 * while the host still has the room to write it: a host that ran out of heap
 * 90 seconds after each start left an out-of-memory report with no
 * JavaScript stack and nothing naming who filled it.
 */
export const HEAP_PRESSURE = [0.6, 0.8] as const
/** How far below a line the heap must ease before that line is said again. */
const HYSTERESIS = 0.1

export type HeapLevel = 0 | 1 | 2

export interface HeapReading {
  /** Bytes in use on the JavaScript heap. */
  used: number
  /** The most V8 will grow the heap to before it dies. */
  limit: number
  /** The process's resident set, when read. */
  rss?: number
}

export type HeapChange = "rising" | "easing"

/** The pressure level a reading is at. */
export function heapLevel(reading: HeapReading): HeapLevel {
  const share = heapShare(reading)
  return share >= HEAP_PRESSURE[1] ? 2 : share >= HEAP_PRESSURE[0] ? 1 : 0
}

export function heapShare(reading: HeapReading): number {
  return reading.limit > 0 ? reading.used / reading.limit : 0
}

/** This process's heap, as V8 reports it. */
export function readHeap(): HeapReading {
  const stats = getHeapStatistics()
  return { used: stats.used_heap_size, limit: stats.heap_size_limit, rss: process.memoryUsage.rss() }
}

/**
 * Watches the heap on the host's tick and says once, each way, when it
 * crosses a pressure line: rising, so whoever answers can write what memory
 * holds while the process can still say it; easing, so the line has an end.
 * A line is said again only after the heap has eased a tenth of the limit
 * below it, so a heap hovering at a line isn't said every tick.
 */
export class HeapWatch {
  readonly #read: () => HeapReading
  readonly #crossed: (change: HeapChange, level: HeapLevel, reading: HeapReading) => void
  #level: HeapLevel = 0

  constructor(read: () => HeapReading, crossed: (change: HeapChange, level: HeapLevel, reading: HeapReading) => void) {
    this.#read = read
    this.#crossed = crossed
  }

  /** The level the heap stands at after this tick. */
  level(): HeapLevel {
    return this.#level
  }

  tick(): HeapLevel {
    const reading = this.#read()
    const level = heapLevel(reading)
    if (level > this.#level) {
      this.#level = level
      this.#crossed("rising", level, reading)
    } else if (level < this.#level) {
      const share = heapShare(reading)
      // Eased below the line it crossed, with room to spare.
      const line = HEAP_PRESSURE[this.#level - 1] ?? HEAP_PRESSURE[0]
      if (share < line - HYSTERESIS) {
        this.#level = level
        this.#crossed("easing", level, reading)
      }
    }
    return this.#level
  }
}
