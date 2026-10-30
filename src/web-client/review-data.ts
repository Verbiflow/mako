import type { TurnFileHunks } from "@mako/host/contracts/turn-review"
import { getMako } from "@/lib/bridge"
import { hunksFromParsed } from "./review-model"

/*
 * A turn's diffs, read as fast as a phone can show them. Each file's
 * stretches come from its owner in one bounded read (`mako:live-turn-hunks`),
 * at most four at once, the files nearest the screen first. A turn's record
 * never changes once it has settled, so what was read is kept by the record
 * it was read for: in memory for this page, and on this device (IndexedDB)
 * for the next time, within a budget, the least recently opened let go
 * first. A Changes screen opened again paints from what's kept at once and
 * reads only what it doesn't have; nothing is read again for a later turn.
 */

/** What one file's read is kept by: its turn, its path, and the record it was read for. */
export interface HunksKey {
  conversation: string
  requestId: string
  path: string
  /** The record's journal position and state: a recount reads again, a settled record never. */
  through: number
  settled: boolean
}

const keyOf = (key: HunksKey) => `${key.conversation}\0${key.requestId}\0${key.path}\0${key.through}`

/** Reads in flight at once: a gateway call each, so the link isn't one long queue. */
const AT_ONCE = 4
/** Kept in memory for this page, most recently used last. */
const MEMORY = { files: 400, chars: 12 * 1024 * 1024 }
/** Kept on this device across visits. */
const STORED = { chars: 24 * 1024 * 1024, name: "mako-review", version: 1, store: "hunks" }

type Stored = { key: string; value: TurnFileHunks; chars: number; at: number }

function sizeOf(value: TurnFileHunks): number {
  if (value.kind !== "text") return 64
  return value.hunks.reduce((total, hunk) => total + hunk.kinds.length + hunk.lines.reduce((sum, line) => sum + line.length + 4, 0), 128)
}

/** IndexedDB, opened once; a browser that refuses it (a private window) just keeps nothing past the page. */
class DeviceCache {
  #db: Promise<IDBDatabase | null> | undefined
  #sizes: Promise<Map<string, { chars: number; at: number }>> | undefined

  #open(): Promise<IDBDatabase | null> {
    this.#db ??= new Promise((resolve) => {
      if (!("indexedDB" in globalThis)) return resolve(null)
      const request = indexedDB.open(STORED.name, STORED.version)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORED.store)) request.result.createObjectStore(STORED.store, { keyPath: "key" })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    })
    return this.#db
  }

  async #index(): Promise<Map<string, { chars: number; at: number }>> {
    this.#sizes ??= this.#open().then(
      (db) =>
        new Promise((resolve) => {
          const sizes = new Map<string, { chars: number; at: number }>()
          if (!db) return resolve(sizes)
          const cursor = db.transaction(STORED.store, "readonly").objectStore(STORED.store).openCursor()
          cursor.onsuccess = () => {
            const at = cursor.result
            if (!at) return resolve(sizes)
            // SAFETY: this store is written only by `put`, which writes a `Stored`.
            const stored = at.value as Stored
            sizes.set(stored.key, { chars: stored.chars, at: stored.at })
            at.continue()
          }
          cursor.onerror = () => resolve(sizes)
        })
    )
    return this.#sizes
  }

  async get(key: string): Promise<TurnFileHunks | undefined> {
    const db = await this.#open()
    if (!db) return undefined
    return new Promise((resolve) => {
      const read = db.transaction(STORED.store, "readonly").objectStore(STORED.store).get(key)
      // SAFETY: this store is written only by `put`, which writes a `Stored`; a missing key reads undefined.
      read.onsuccess = () => resolve((read.result as Stored | undefined)?.value)
      read.onerror = () => resolve(undefined)
    })
  }

  async put(key: string, value: TurnFileHunks): Promise<void> {
    const db = await this.#open()
    if (!db) return
    const sizes = await this.#index()
    const chars = sizeOf(value)
    const at = Date.now()
    sizes.set(key, { chars, at })
    let total = 0
    for (const size of sizes.values()) total += size.chars
    const gone: string[] = []
    if (total > STORED.chars)
      for (const [old, size] of [...sizes].sort((left, right) => left[1].at - right[1].at)) {
        if (total <= STORED.chars * 0.8 || old === key) break
        total -= size.chars
        gone.push(old)
        sizes.delete(old)
      }
    const write = db.transaction(STORED.store, "readwrite")
    const store = write.objectStore(STORED.store)
    store.put({ key, value, chars, at } satisfies Stored)
    for (const old of gone) store.delete(old)
  }
}

/** The page's reader: one per page, shared by every Changes screen. */
class HunksReader {
  readonly #memory = new Map<string, TurnFileHunks>()
  #memoryChars = 0
  readonly #device = new DeviceCache()
  readonly #reading = new Map<string, Promise<TurnFileHunks>>()
  readonly #queue: { key: HunksKey; run: () => void; priority: number }[] = []
  #running = 0
  /** Owners that answered "no such call": asked the older way from then on. */
  readonly #older = new Set<string>()

  /** What this page already holds, at once; undefined when it must be read. */
  held(key: HunksKey): TurnFileHunks | undefined {
    const found = this.#memory.get(keyOf(key))
    if (found) {
      this.#memory.delete(keyOf(key))
      this.#memory.set(keyOf(key), found)
    }
    return found
  }

  /** What this device kept from an earlier visit, then nothing read; only a settled record's. */
  async kept(key: HunksKey): Promise<TurnFileHunks | undefined> {
    if (!key.settled) return undefined
    const found = await this.#device.get(keyOf(key))
    if (found) this.#remember(keyOf(key), found)
    return found
  }

  /**
   * The file's stretches: held, kept, or read from its owner. `priority` orders the queue: lower first, so the files
   * on screen go before the ones read ahead.
   */
  read(key: HunksKey, priority = 0): Promise<TurnFileHunks> {
    const id = keyOf(key)
    const held = this.held(key)
    if (held) return Promise.resolve(held)
    const reading = this.#reading.get(id)
    if (reading) {
      const queued = this.#queue.find((each) => keyOf(each.key) === id)
      if (queued) queued.priority = Math.min(queued.priority, priority)
      return reading
    }
    const read = (async () => {
      const kept = await this.kept(key)
      if (kept) return kept
      await this.#turn(key, priority)
      try {
        const value = await this.#fetch(key)
        this.#remember(id, value)
        if (key.settled) void this.#device.put(id, value)
        return value
      } finally {
        this.#running--
        this.#next()
      }
    })()
    this.#reading.set(id, read)
    void read.finally(() => this.#reading.delete(id)).catch(() => undefined)
    return read
  }

  /** Waits for a free slot, the nearer files first. */
  #turn(key: HunksKey, priority: number): Promise<void> {
    if (this.#running < AT_ONCE) {
      this.#running++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.#queue.push({ key, priority, run: resolve })
    })
  }

  #next(): void {
    if (this.#running >= AT_ONCE || !this.#queue.length) return
    this.#queue.sort((left, right) => left.priority - right.priority)
    const next = this.#queue.shift()!
    this.#running++
    next.run()
  }

  async #fetch(key: HunksKey): Promise<TurnFileHunks> {
    const mako = getMako()
    if (!this.#older.has(key.conversation)) {
      try {
        return await mako.liveTurnHunks(key.conversation, key.requestId, key.path)
      } catch (error) {
        if (!(error instanceof Error && /no such call|live-turn-hunks/iu.test(error.message))) throw error
        this.#older.add(key.conversation)
      }
    }
    // A host from before the bounded read: both versions whole, and the writers apart, made into the same stretches.
    const [diff, writers, { fileDiffOf }] = await Promise.all([
      mako.liveTurnDiff(key.conversation, key.requestId, key.path),
      mako.liveTurnWriters(key.conversation, key.requestId, key.path).catch(() => null),
      import("@/lib/git-file-diff"),
    ])
    if (diff.binary) return { kind: "binary", path: key.path, before: diff.before?.bytes ?? null, after: diff.after?.bytes ?? null }
    if (diff.preview?.kind === "unavailable") return { kind: "unavailable", path: key.path, reason: diff.preview.reason }
    if (diff.preview?.kind === "patch") {
      const { getSingularPatch } = await import("@pierre/diffs")
      return { ...hunksFromParsed(key.path, getSingularPatch(diff.preview.contents), writers?.runs, writers?.body ?? "checkpoints"), limited: diff.preview.limited }
    }
    return hunksFromParsed(key.path, fileDiffOf(diff), writers?.runs, writers?.body ?? "journal")
  }

  #remember(key: string, value: TurnFileHunks): void {
    if (this.#memory.has(key)) return
    this.#memory.set(key, value)
    this.#memoryChars += sizeOf(value)
    for (const [old, kept] of this.#memory) {
      if (this.#memory.size <= MEMORY.files && this.#memoryChars <= MEMORY.chars) break
      this.#memory.delete(old)
      this.#memoryChars -= sizeOf(kept)
    }
  }
}

/** The page's one reader. */
export const hunksReader = new HunksReader()
