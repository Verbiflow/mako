import type { Preview } from "./preview.js"

/** What every open repository's previews keep together, by the bytes they carry. */
const CACHE_BYTES = 64 * 1024 * 1024
/** One preview may take at most this share, so a huge file can't empty the cache. */
const ENTRY_BYTES = CACHE_BYTES / 8

export interface KeptPreview {
  preview: Preview
  bytes: number
  path: string
  /** Read from the working tree, so a change on disk makes it stale. */
  worktree: boolean
}

/** The bytes the shelves made from one budget hold together; past it, the oldest preview of any shelf goes first. */
export class PreviewBudget {
  /** Least recently used first, by each shelf's slot for the key. */
  readonly #order = new Map<string, { shelf: PreviewShelf; key: string }>()
  #bytes = 0
  #shelves = 0

  get bytes(): number {
    return this.#bytes
  }

  /** A new shelf's number, which prefixes its slots. */
  enroll(): number {
    return (this.#shelves += 1)
  }

  used(slot: string, shelf: PreviewShelf, key: string): void {
    this.#order.delete(slot)
    this.#order.set(slot, { shelf, key })
  }

  added(slot: string, shelf: PreviewShelf, key: string, bytes: number): void {
    this.#order.set(slot, { shelf, key })
    this.#bytes += bytes
    for (const { shelf: holder, key: oldest } of this.#order.values()) {
      if (this.#bytes <= CACHE_BYTES) break
      holder.drop(oldest)
    }
  }

  removed(slot: string, bytes: number): void {
    this.#order.delete(slot)
    this.#bytes -= bytes
  }
}

/** One repository's previews, answering for its own keys while its bytes count against a shared budget. */
export class PreviewShelf {
  private readonly budget: PreviewBudget
  private readonly id: number
  private readonly entries = new Map<string, KeptPreview>()
  private held = 0

  constructor(budget: PreviewBudget) {
    this.budget = budget
    this.id = budget.enroll()
  }

  get count(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.held
  }

  /** What every shelf of this one's budget holds. */
  get allBytes(): number {
    return this.budget.bytes
  }

  get(key: string): KeptPreview | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.budget.used(this.slot(key), this, key)
    return entry
  }

  keep(key: string, entry: KeptPreview): void {
    if (entry.bytes > ENTRY_BYTES) return
    this.drop(key)
    this.entries.set(key, entry)
    this.held += entry.bytes
    this.budget.added(this.slot(key), this, key, entry.bytes)
  }

  drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.held -= entry.bytes
    this.budget.removed(this.slot(key), entry.bytes)
  }

  /** Drops every preview `stale` picks. */
  dropWhere(stale: (entry: KeptPreview) => boolean): void {
    for (const [key, entry] of this.entries) if (stale(entry)) this.drop(key)
  }

  clear(): void {
    for (const key of this.entries.keys()) this.drop(key)
  }

  private slot(key: string): string {
    return `${this.id}\0${key}`
  }
}
