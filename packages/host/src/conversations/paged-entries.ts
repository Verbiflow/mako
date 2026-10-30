import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { Entry } from "@mako/sessions/entries"
import type { Measured } from "../contracts/residency.js"

/**
 * A conversation's entries whose content the host reads back from its
 * journal instead of holding.
 *
 * The journal keeps every one of Mako's live blocks as a row (`blocks`) and,
 * while the conversation is open, every entry of its history as one
 * (`base_entries`, kept or written ahead). A finished turn's entry is paged:
 * the host's arrays hold a copy of it whose short fields (its type, id,
 * request, status, a call's name, a stream's place) stay, and whose long
 * ones (text, a call's input and output) are read back from its row when
 * something reads them. A paged entry is an entry: JSON, spreads, deep
 * equality and every reader see the same fields with the same values, so
 * nothing that reads the history needs to know. What memory holds of a
 * conversation of 150MB is then its last turns and about a hundred bytes an
 * entry.
 *
 * A row a paged entry reads is never written over under it: before the
 * journal writes or drops a row, the entry paged from it takes its content
 * back (`detach`). Once the journal closes, its paged entries still read
 * through a read-only connection until the last is collected; only then are
 * the rows written ahead dropped and the file compacted.
 */

/** The journal table a paged entry is read back from: Mako's live blocks, or the history's entries. */
export type PagedTable = "blocks" | "base"

/** Where a pager reads rows: the journal's own connection while it is open. */
export interface PagedRows {
  /** Row `row` of `table` as the entry it holds now, as JSON; undefined when there is none. */
  read(table: PagedTable, row: number): string | undefined
  close?(): void
}

/** A field at most this long, as JSON, stays on a paged entry: kinds, ids, statuses, names, a stream's or a record's place. */
export const INLINE_CHARS = 160
/** Fields that stay whatever they hold: a paged entry is checked against its row by them. */
const ALWAYS_INLINE = new Set(["type", "id"])
/** Rows a pager keeps parsed, by characters: an entry's fields read one after another, or a page read twice, parse once. */
const READ_CACHE_CHARS = 2 * 1024 * 1024
/** About what a paged entry's object and its slots weigh, beside the fields it keeps. */
const PAGED_OVERHEAD = 96

interface Source {
  readonly pager: EntryPager
  readonly table: PagedTable
  readonly row: number
  readonly weight: number
}

/** Where each paged entry is read back from; an entry not in it holds its own content. */
const sources = new WeakMap<Measured, Source>()
/**
 * A row as written from an entry, every field kept as it is: it is read back
 * for the fields of the entry paged from it, whatever they are, and checked
 * to be that entry by its type and id.
 */
const RowEntrySchema = z.looseObject({ type: z.string(), id: z.string().optional() })
type RowEntry = z.infer<typeof RowEntrySchema>
/** The paged entry each warm one became, for whoever still holds the warm one: a view of an earlier revision. */
const pagedFrom = new WeakMap<Entry, Entry>()
/** Entries looked at and kept as they are, nothing of them long enough to page: a sweep passes them by. */
const short = new WeakSet<Entry>()

function sourceOf(value: Measured): Source | undefined {
  return sources.get(value)
}

/** Whether `entry`'s content is read back from its journal. */
export function isPaged(entry: Entry): boolean {
  return sources.has(entry)
}

/** What a paged entry keeps in memory; undefined for anything else (`ContentWeights`). */
export function pagedWeight(value: Measured): number | undefined {
  return sourceOf(value)?.weight
}

/** The paged entry `entry` became, while it is still paged; undefined when it never was. */
export function pagedOf(entry: Entry): Entry | undefined {
  const paged = pagedFrom.get(entry)
  return paged && isPaged(paged) ? paged : undefined
}

/**
 * Whether paged entry `paged` says what `entry` says, reading its row: the
 * row's text when `entry` serialises to it, as one read again by the same
 * decoder does, else field by field.
 */
export function pagedEqual(paged: Entry, entry: Entry): boolean {
  const source = sourceOf(paged)
  if (!source) return isDeepStrictEqual(paged, entry)
  const text = source.pager.text(source)
  if (text === JSON.stringify(entry)) return true
  return isDeepStrictEqual(paged, entry)
}

/** How long `readBack` reads before it lets other work run. */
const READ_BACK_SLICE_MS = 8

/**
 * `entries` with each paged one read back into an entry of its own, a slice
 * at a time: for a pass that reads them all at once (a merge), which would
 * otherwise read each back inside its one stretch of the loop. The copies
 * live as long as the caller holds them.
 */
export async function readBack(entries: readonly Entry[]): Promise<readonly Entry[]> {
  let read: Entry[] | undefined
  let until = performance.now() + READ_BACK_SLICE_MS
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (isPaged(entry)) (read ??= [...entries])[index] = { ...entry }
    if (performance.now() >= until) {
      await new Promise((resolve) => setImmediate(resolve))
      until = performance.now() + READ_BACK_SLICE_MS
    }
  }
  return read ?? entries
}

/** One journal's paged entries: makes them, reads them back, and gives each its content again before its row changes. */
export class EntryPager {
  private readonly rows = { blocks: new Map<number, WeakRef<Entry>>(), base: new Map<number, WeakRef<Entry>>() }
  /** One getter a field name, shared by every entry this pager pages. */
  private readonly accessors = new Map<string, PropertyDescriptor>()
  private readonly cache = new Map<Entry, { value: RowEntry; chars: number }>()
  private cachedChars = 0
  private readonly collected: FinalizationRegistry<{ table: PagedTable; row: number }>
  private live = 0
  private rowsSource: PagedRows
  /** Resolves `freed` once the journal closed and none of its paged entries is left. */
  private released?: () => void

  constructor(rows: PagedRows) {
    this.rowsSource = rows
    this.collected = new FinalizationRegistry(({ table, row }) => {
      this.live--
      if (this.rows[table].get(row)?.deref() === undefined) this.rows[table].delete(row)
      if (this.live <= 0) this.free()
    })
  }

  /**
   * `entry`, which row `row` of `table` holds now, as a paged entry; `entry`
   * itself when it is paged already or keeps nothing long. The caller puts
   * it where `entry` was.
   */
  page(entry: Entry, table: PagedTable, row: number, inlineChars = INLINE_CHARS): Entry {
    if (isPaged(entry) || (inlineChars === INLINE_CHARS && short.has(entry))) return entry
    // Paged before, where another array still held it warm: the same paged entry, so every array holds one object.
    const known = pagedOf(entry)
    const knownSource = known && sourceOf(known)
    if (known && knownSource?.pager === this && knownSource.table === table && knownSource.row === row) return known
    const paged = {}
    let weight = PAGED_OVERHEAD
    let long = false
    for (const [key, value] of Object.entries(entry)) {
      const size = value === undefined ? 0 : JSON.stringify(value).length
      if (ALWAYS_INLINE.has(key) || size <= inlineChars) {
        Object.defineProperty(paged, key, { value, writable: true, enumerable: true, configurable: true })
        weight += 16 + size * 2
      } else {
        Object.defineProperty(paged, key, this.accessor(key))
        weight += 16
        long = true
      }
    }
    if (!long) {
      if (inlineChars === INLINE_CHARS) short.add(entry)
      return entry
    }
    // SAFETY: `paged` has every field `entry` has, each reading the value the row holds for it.
    const made = paged as Entry
    sources.set(made, { pager: this, table, row, weight })
    this.rows[table].set(row, new WeakRef(made))
    this.collected.register(made, { table, row }, made)
    this.live++
    pagedFrom.set(entry, made)
    return made
  }

  /**
   * Row `row` of `table` is about to be written over or dropped: the entry
   * paged from it takes its content back first, unless it is `keeps`, which
   * the write gives the row again.
   */
  detach(table: PagedTable, row: number, keeps?: Entry): void {
    const paged = this.rows[table].get(row)?.deref()
    if (!paged || paged === keeps) return
    this.rows[table].delete(row)
    this.materialize(paged)
  }

  /** Every row of `table` from `from` on is about to be dropped. */
  detachFrom(table: PagedTable, from: number): void {
    const rows = this.rows[table]
    for (const row of Array.from(rows.keys())) if (row >= from) this.detach(table, row)
  }

  /** How many entries this pager made are still paged and not yet collected. */
  pagedCount(): number {
    return this.live
  }

  /**
   * The journal closed: its paged entries read through `rows` from now on.
   * Resolves once none is left, which needs this pager kept reachable
   * meanwhile (`LiveRecords` holds the journal): an unreachable registry
   * hears of nothing collected.
   */
  release(rows: PagedRows): Promise<void> {
    this.rowsSource = rows
    const freed = new Promise<void>((resolve) => { this.released = resolve })
    if (this.live <= 0) this.free()
    return freed
  }

  /** The closed journal's paged entries are all gone. */
  private free(): void {
    const released = this.released
    if (!released) return
    this.released = undefined
    this.cache.clear()
    this.cachedChars = 0
    this.rowsSource.close?.()
    released()
  }

  /** The row `source` names, as JSON. */
  text(source: Source): string {
    const text = this.rowsSource.read(source.table, source.row)
    if (text === undefined) throw new Error(`Mako's journal no longer has row ${source.row} of ${source.table} to read back`)
    return text
  }

  private accessor(key: string): PropertyDescriptor {
    let descriptor = this.accessors.get(key)
    if (!descriptor) {
      const read = (paged: Entry) => this.content(paged)[key]
      descriptor = {
        get(this: Entry) {
          return read(this)
        },
        // A write gives the entry its own value for the field, as on any other entry.
        set(value) {
          Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true })
        },
        enumerable: true,
        configurable: true,
      }
      this.accessors.set(key, descriptor)
    }
    return descriptor
  }

  private content(paged: Entry): RowEntry {
    const hit = this.cache.get(paged)
    if (hit) {
      this.cache.delete(paged)
      this.cache.set(paged, hit)
      return hit.value
    }
    const source = sourceOf(paged)
    if (!source) throw new Error("This entry is not paged")
    const text = this.text(source)
    const parsed = RowEntrySchema.parse(JSON.parse(text))
    if (parsed.type !== paged.type || parsed.id !== ("id" in paged ? paged.id : undefined))
      throw new Error(`Mako's journal row ${source.row} of ${source.table} holds another entry than the one paged from it`)
    this.cache.set(paged, { value: parsed, chars: text.length })
    this.cachedChars += text.length
    for (const [key, cached] of this.cache) {
      if (this.cachedChars <= READ_CACHE_CHARS || key === paged) break
      this.cache.delete(key)
      this.cachedChars -= cached.chars
    }
    return parsed
  }

  /** Gives a paged entry its content back as its own fields: it is an entry like any other from then on. */
  private materialize(paged: Entry): void {
    const content = this.content(paged)
    const cached = this.cache.get(paged)
    if (cached) {
      this.cache.delete(paged)
      this.cachedChars -= cached.chars
    }
    for (const key of Object.keys(paged)) {
      if (Object.getOwnPropertyDescriptor(paged, key)?.get)
        Object.defineProperty(paged, key, { value: content[key], writable: true, enumerable: true, configurable: true })
    }
    sources.delete(paged)
    if (this.collected.unregister(paged) && --this.live <= 0) this.free()
  }
}
