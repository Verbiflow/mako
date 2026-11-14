import type { ContentRef } from "@mako/protocol"
import type { StatRow } from "./journal-store.js"

/** Columns a row keeps as numbers, and as nanoseconds. */
const NUMBERS = 4
const NANOS = 3

/**
 * A root's stat cache, a path's last stat and content, packed in columns rather than an object a row. On the person's
 * Mac on 2026-11-12 the tracker held 1,016,086 rows for 154 roots: as objects, each with three bigints, about 277
 * bytes a row and 262 MB of the host's heap; packed, about 93. It reads and changes as the `Map` it replaces did,
 * `get` making the row it returns, so a caller holding one keeps it unchanged whatever the cache does after.
 */
export class StatCache implements ReadonlyMap<string, StatRow> {
  private readonly slots = new Map<string, number>()
  private numbers = new Float64Array(0)
  private nanos = new BigInt64Array(0)
  private refs: (ContentRef | null)[] = []
  private readonly free: number[] = []

  constructor(rows?: Iterable<readonly [string, StatRow]>) {
    if (rows) for (const [path, row] of rows) this.set(path, row)
  }

  get size(): number {
    return this.slots.size
  }

  has(path: string): boolean {
    return this.slots.has(path)
  }

  get(path: string): StatRow | undefined {
    const slot = this.slots.get(path)
    return slot === undefined ? undefined : this.row(slot)
  }

  set(path: string, row: StatRow): this {
    let slot = this.slots.get(path)
    if (slot === undefined) {
      slot = this.free.pop() ?? this.grow()
      this.slots.set(path, slot)
    }
    const numbers = slot * NUMBERS
    this.numbers[numbers] = row.dev
    this.numbers[numbers + 1] = row.ino
    this.numbers[numbers + 2] = row.size
    this.numbers[numbers + 3] = row.mode
    const nanos = slot * NANOS
    this.nanos[nanos] = row.mtimeNs
    this.nanos[nanos + 1] = row.ctimeNs
    this.nanos[nanos + 2] = row.checkedNs
    this.refs[slot] = row.ref
    return this
  }

  delete(path: string): boolean {
    const slot = this.slots.get(path)
    if (slot === undefined) return false
    this.slots.delete(path)
    this.refs[slot] = null
    this.free.push(slot)
    return true
  }

  keys(): MapIterator<string> {
    return this.slots.keys()
  }

  *values(): MapIterator<StatRow> {
    for (const slot of this.slots.values()) yield this.row(slot)
  }

  *entries(): MapIterator<[string, StatRow]> {
    for (const [path, slot] of this.slots) yield [path, this.row(slot)]
  }

  [Symbol.iterator](): MapIterator<[string, StatRow]> {
    return this.entries()
  }

  forEach(each: (row: StatRow, path: string, cache: ReadonlyMap<string, StatRow>) => void): void {
    for (const [path, slot] of this.slots) each(this.row(slot), path, this)
  }

  private row(slot: number): StatRow {
    const numbers = slot * NUMBERS
    const nanos = slot * NANOS
    return {
      dev: this.numbers[numbers]!, ino: this.numbers[numbers + 1]!, size: this.numbers[numbers + 2]!, mode: this.numbers[numbers + 3]!,
      mtimeNs: this.nanos[nanos]!, ctimeNs: this.nanos[nanos + 1]!, ref: this.refs[slot] ?? null, checkedNs: this.nanos[nanos + 2]!,
    }
  }

  /** One more slot, the columns doubled when full. */
  private grow(): number {
    const slot = this.refs.length
    const capacity = this.numbers.length / NUMBERS
    if (slot >= capacity) {
      const next = Math.max(64, capacity * 2)
      const numbers = new Float64Array(next * NUMBERS)
      numbers.set(this.numbers)
      this.numbers = numbers
      const nanos = new BigInt64Array(next * NANOS)
      nanos.set(this.nanos)
      this.nanos = nanos
    }
    this.refs.push(null)
    return slot
  }
}
