import { z } from "zod"

/**
 * What a windowed transcript's rows measured, kept per conversation for the window's life and across a reload, and
 * an estimate for the rows never measured, learned from the ones that were.
 *
 * A virtualizer places every row it hasn't measured at an estimate, and corrects the column as each one is. With one
 * constant for every turn, a long transcript's column was wrong by most of its height when it opened, and scrolling
 * through it was a correction a row. Two things make the corrections fewer and smaller: a row measured before stands
 * at that size again (while it says the same and the window is as wide), and a row never measured is estimated from
 * what it holds, at the pixels a character of prose has been taking in this window.
 */

/** What a row's height comes from, read from its turn: enough to estimate it, and to tell it has changed. */
export interface RowFacts {
  /** Characters of prose: the prompt's and the answer's. */
  chars: number
  /** Line breaks in that prose: a list or a code block is taller than its characters say. */
  lines: number
  /** Tool rows. */
  tools: number
}

/** A row as it measured, with what it held then. */
export interface KeptRow extends RowFacts {
  size: number
}

/** A turn's chrome: its prompt's bubble, the answer's header and actions, the space between them. */
const BASE_PX = 110
/** A tool row (`h-7`). */
const TOOL_PX = 28
/** What a line break adds over its characters: the rest of its line, and a paragraph's gap now and then. */
const LINE_PX = 9
/** Before anything is learned: about 90 characters to a 27 px line of the desk's column. */
export const PRIOR_PX_PER_CHAR = 0.3
/** Prose measured before the ratio is trusted over the prior. */
const LEARNED_FROM_CHARS = 4_000

/**
 * A row's height from what it holds. Never a whole number: the virtualizer doesn't keep a measurement equal to its
 * estimate, and such a row would move with the estimate the next time it was made.
 */
export function estimateRow(facts: RowFacts, pxPerChar: number): number {
  return Math.round(BASE_PX + facts.chars * pxPerChar + facts.lines * LINE_PX + facts.tools * TOOL_PX) + 0.5
}

/** The pixels a character of prose took in `rows`, or `prior` while too little has been measured to say. */
export function learnedPxPerChar(rows: Iterable<KeptRow>, prior = PRIOR_PX_PER_CHAR): number {
  let px = 0
  let chars = 0
  for (const row of rows) {
    if (!row.chars) continue
    px += Math.max(0, row.size - BASE_PX - row.lines * LINE_PX - row.tools * TOOL_PX)
    chars += row.chars
  }
  if (chars < LEARNED_FROM_CHARS) return prior
  return Math.min(2, Math.max(0.05, px / chars))
}

export function sameFacts(left: RowFacts, right: RowFacts): boolean {
  return left.chars === right.chars && left.lines === right.lines && left.tools === right.tools
}

const StoredSchema = z.object({
  version: z.literal(1),
  conversations: z.array(z.object({
    source: z.string(),
    width: z.number(),
    rows: z.array(z.tuple([z.string(), z.number(), z.number(), z.number(), z.number()])),
  })),
})

/** Where the sizes are kept across a reload: the window's `localStorage`, or a test's. */
export interface RowHeightStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface Kept {
  width: number
  rows: Map<string, KeptRow>
}

const STORAGE_KEY = "mako:transcript-row-heights"

export class RowHeights {
  /** By conversation, the least recently kept first. */
  readonly #kept = new Map<string, Kept>()
  readonly #storage: RowHeightStorage | undefined
  readonly #limits: { conversations: number; rows: number; bytes: number }
  #loaded = false

  constructor(storage?: RowHeightStorage, limits = { conversations: 12, rows: 600, bytes: 256_000 }) {
    this.#storage = storage
    this.#limits = limits
  }

  /** The rows `source` measured, when it was `width` wide: at another width every line has flowed again. */
  kept(source: string, width: number): ReadonlyMap<string, KeptRow> | undefined {
    this.#load()
    const held = this.#kept.get(source)
    return held?.width === width ? held.rows : undefined
  }

  /** `source`'s rows as they measure now. Only its newest `rows` are kept, and the conversations kept last. */
  keep(source: string, width: number, rows: ReadonlyMap<string, KeptRow>): void {
    this.#load()
    if (!rows.size) return
    const newest = [...rows].slice(-this.#limits.rows)
    this.#kept.delete(source)
    this.#kept.set(source, { width, rows: new Map(newest) })
    while (this.#kept.size > this.#limits.conversations) this.#kept.delete(this.#kept.keys().next().value!)
  }

  /** The pixels a character of prose takes at `width`, from every conversation kept at it. */
  pxPerChar(width: number): number {
    this.#load()
    const rows: KeptRow[] = []
    for (const held of this.#kept.values()) if (held.width === width) rows.push(...held.rows.values())
    return learnedPxPerChar(rows)
  }

  /** Written where a reload finds it, the oldest conversations left out until it fits. */
  save(): void {
    if (!this.#storage) return
    this.#load()
    const conversations = [...this.#kept].map(([source, held]) => ({
      source,
      width: held.width,
      rows: [...held.rows].map(([key, row]): [string, number, number, number, number] => [key, row.size, row.chars, row.lines, row.tools]),
    }))
    try {
      let text = JSON.stringify({ version: 1, conversations })
      while (text.length > this.#limits.bytes && conversations.length > 1) {
        conversations.shift()
        text = JSON.stringify({ version: 1, conversations })
      }
      if (text.length <= this.#limits.bytes) this.#storage.setItem(STORAGE_KEY, text)
    } catch {
      // Storage full or refused: the sizes are a convenience, measured again when they're missing.
    }
  }

  #load(): void {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const text = this.#storage?.getItem(STORAGE_KEY)
      if (!text) return
      const stored = StoredSchema.safeParse(JSON.parse(text))
      if (!stored.success) return
      for (const { source, width, rows } of stored.data.conversations)
        this.#kept.set(source, { width, rows: new Map(rows.map(([key, size, chars, lines, tools]) => [key, { size, chars, lines, tools }])) })
    } catch {
      // Unreadable: as if nothing had been kept.
    }
  }
}
