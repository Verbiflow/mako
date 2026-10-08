/** The timeline publishes what it actually painted. Cache/focus/host events
 * cannot move this state or invent a reading position. One lease per mounted
 * timeline means two panes reading the same conversation protect both places. */
export interface TranscriptReading {
  visible: readonly string[]
  nearby: readonly string[]
  anchor?: { turn: string; offset: number; block?: { index: number; text: string; offset: number } }
  following: boolean
  moving: boolean
  interacting: boolean
  /** Earliest coordinates needed to reacquire this pane after whole-view eviction. */
  window?: { blocks: number; base: number }
}

interface Reader {
  source: string
  reading?: TranscriptReading
}
interface Visit { turn: string; at: number }
type Bookmark = Pick<TranscriptReading, "anchor" | "following" | "window">
const RECENT_MS = 60_000
const MAX_VISITS = 32

export class TranscriptReaders {
  private readonly readers = new Map<symbol, Reader>()
  private readonly visits = new Map<string, Visit[]>()
  private readonly operations = new Map<symbol, { source: string; turn: string }>()
  private readonly listeners = new Set<() => void>()
  private readonly bookmarks = new Map<string | symbol, Map<string, Bookmark>>()

  private readonly now: () => number
  constructor(now: () => number = Date.now) { this.now = now }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bookmark(source: string, pane: string | symbol): Bookmark | undefined { return this.bookmarks.get(pane)?.get(source) }

  rememberedWindow(source: string): TranscriptReading["window"] {
    let from: TranscriptReading["window"]
    for (const panes of this.bookmarks.values()) {
      const reading = panes.get(source)
      if (reading?.following || !reading?.window) continue
      from = from ? { blocks: Math.min(from.blocks, reading.window.blocks), base: Math.min(from.base, reading.window.base) } : reading.window
    }
    return from
  }

  attach(source: string, pane: string | symbol = Symbol(source)) {
    const owner = Symbol(source)
    const reader: Reader = { source }
    this.readers.set(owner, reader)
    this.changed()
    return {
      report: (reading: TranscriptReading) => {
        // A late observer/frame from a retired timeline has no authority.
        if (this.readers.get(owner) !== reader) return
        const old = reader.reading
        reader.reading = reading
        if (reading.visible.length && !reading.moving) {
          const bookmarks = this.bookmarks.get(pane) ?? new Map<string, Bookmark>()
          bookmarks.delete(source)
          // A saved place needs no viewport/interaction snapshot or body.
          bookmarks.set(source, { anchor: reading.anchor, following: reading.following, window: reading.window })
          if (bookmarks.size > 256) bookmarks.delete(bookmarks.keys().next().value!)
          this.bookmarks.set(pane, bookmarks)
          if (this.bookmarks.size > 32) this.bookmarks.delete(this.bookmarks.keys().next().value!)
        }
        if (!reading.moving && reading.visible.length &&
            (!old || old.moving || !sameIds(old.visible, reading.visible))) {
          const recent = this.visits.get(source) ?? []
          const arrived = new Set(reading.visible)
          this.visits.delete(source)
          this.visits.set(source, [...reading.visible.map(turn => ({ turn, at: this.now() })),
            ...recent.filter(visit => !arrived.has(visit.turn))].slice(0, MAX_VISITS))
          // Bookkeeping carries identifiers only, never transcript bodies.
          if (this.visits.size > 128) this.visits.delete(this.visits.keys().next().value!)
        }
        if (!old || JSON.stringify(old) !== JSON.stringify(reading)) this.changed()
      },
      release: () => {
        if (!this.readers.delete(owner)) return
        this.changed()
      },
    }
  }

  forgetPane(pane: string | symbol): void { this.bookmarks.delete(pane) }

  /** Copy/detail/navigation reads outlive pointer focus. They explicitly hold
   * their input until the operation settles, independently of pane lifetime. */
  protect(source: string, turn: string): () => void {
    const owner = Symbol(turn)
    this.operations.set(owner, { source, turn })
    this.changed()
    return () => { if (this.operations.delete(owner)) this.changed() }
  }

  /** Undefined means no trustworthy viewport report yet: retain everything.
   * A moving/interactive pane postpones structural cleanup altogether. */
  protected(source: string): Set<string> | undefined {
    const result = new Set<string>()
    for (const operation of this.operations.values())
      if (operation.source === source && operation.turn === "*") return undefined
    for (const reader of this.readers.values()) {
      if (reader.source !== source) continue
      const reading = reader.reading
      if (!reading || reading.moving || reading.interacting || !reading.visible.length) return undefined
      for (const id of [...reading.visible, ...reading.nearby]) result.add(id)
      if (reading.anchor) result.add(reading.anchor.turn)
    }
    for (const operation of this.operations.values())
      if (operation.source === source) result.add(operation.turn)
    return result
  }

  sources(): Set<string> { return new Set([...this.readers.values()].map(reader => reader.source)) }

  heldSources(): Set<string> {
    return new Set([...this.sources(), ...[...this.operations.values()].map(operation => operation.source)])
  }

  usedAt(source: string, turn: string): number {
    return this.visits.get(source)?.find(visit => visit.turn === turn)?.at ?? 0
  }

  warm(source: string, turn: string): boolean {
    const at = this.usedAt(source, turn)
    return at > 0 && this.now() - at < RECENT_MS
  }

  private changed() { for (const listener of this.listeners) listener() }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export const transcriptReaders = new TranscriptReaders()
export const liveReadingSource = (id: string): string => `live:${id}`
export const nativeReadingSource = (path: string): string => `native:${path}`
