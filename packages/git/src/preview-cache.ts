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

/** Least recently used first, across every shelf. */
const order = new Map<string, { shelf: PreviewShelf; key: string }>()
let total = 0
let shelves = 0

/**
 * One repository's previews. Each shelf answers for its own keys, while the
 * bytes they hold count against one budget for the whole process: the oldest
 * preview of any repository goes first.
 */
export class PreviewShelf {
  private readonly id = (shelves += 1)
  private readonly entries = new Map<string, KeptPreview>()
  private held = 0

  get count(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.held
  }

  get(key: string): KeptPreview | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    const slot = this.slot(key)
    order.delete(slot)
    order.set(slot, { shelf: this, key })
    return entry
  }

  keep(key: string, entry: KeptPreview): void {
    if (entry.bytes > ENTRY_BYTES) return
    this.drop(key)
    this.entries.set(key, entry)
    order.set(this.slot(key), { shelf: this, key })
    this.held += entry.bytes
    total += entry.bytes
    for (const { shelf, key: oldest } of order.values()) {
      if (total <= CACHE_BYTES) break
      shelf.drop(oldest)
    }
  }

  drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    order.delete(this.slot(key))
    this.held -= entry.bytes
    total -= entry.bytes
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

/** The bytes every repository's previews hold, for `git:doctor`. */
export function previewCacheBytes(): number {
  return total
}
