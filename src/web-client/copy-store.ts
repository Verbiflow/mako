import { CopyManifestSchema, MemoryCopyStore, type CopyManifest, type CopyStore } from "@mako/sessions/copy-reader"
import { z } from "zod"

/** Where this browser keeps the copies it read (`CopyStore`): a few Sessions' chunks, for opening them again offline. */
const STORED = { name: "mako-copies", version: 1, manifests: "manifests", chunks: "chunks" } as const

const KeptManifestSchema = z.object({ key: z.string(), manifest: CopyManifestSchema })

/**
 * The copies this browser read, kept in IndexedDB by content: each Session's manifest by its key, each chunk's plain
 * bytes by its hash, so one chunk two versions share is kept once. Opened once; a browser that refuses it (a private
 * window) keeps them in memory for the page instead. The reader bounds what's kept (`COPIES_KEPT`, `KEPT_BYTES`).
 */
export class IndexedCopyStore implements CopyStore {
  readonly #memory = new MemoryCopyStore()
  #db: Promise<IDBDatabase | null> | undefined

  #open(): Promise<IDBDatabase | null> {
    this.#db ??= new Promise((resolve) => {
      if (!("indexedDB" in globalThis)) return resolve(null)
      const request = indexedDB.open(STORED.name, STORED.version)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORED.manifests)) db.createObjectStore(STORED.manifests, { keyPath: "key" })
        if (!db.objectStoreNames.contains(STORED.chunks)) db.createObjectStore(STORED.chunks)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    })
    return this.#db
  }

  async manifest(key: string): Promise<CopyManifest | undefined> {
    const db = await this.#open()
    if (!db) return this.#memory.manifest(key)
    const kept = KeptManifestSchema.safeParse(await asked(db.transaction(STORED.manifests).objectStore(STORED.manifests).get(key)))
    return kept.success ? kept.data.manifest : undefined
  }

  async keepManifest(key: string, manifest: CopyManifest): Promise<void> {
    const db = await this.#open()
    if (!db) return this.#memory.keepManifest(key, manifest)
    const write = db.transaction(STORED.manifests, "readwrite")
    write.objectStore(STORED.manifests).put({ key, manifest })
    await done(write)
  }

  async manifests(): Promise<Array<[string, CopyManifest]>> {
    const db = await this.#open()
    if (!db) return this.#memory.manifests()
    const all = z.array(z.unknown()).parse(await asked(db.transaction(STORED.manifests).objectStore(STORED.manifests).getAll()))
    return all.flatMap((each): Array<[string, CopyManifest]> => {
      const kept = KeptManifestSchema.safeParse(each)
      return kept.success ? [[kept.data.key, kept.data.manifest]] : []
    })
  }

  async chunks(hashes: readonly string[]): Promise<Map<string, Uint8Array>> {
    const db = await this.#open()
    if (!db) return this.#memory.chunks(hashes)
    const store = db.transaction(STORED.chunks).objectStore(STORED.chunks)
    const found = new Map<string, Uint8Array>()
    await Promise.all(
      [...new Set(hashes)].map(async (hash) => {
        const bytes = await asked(store.get(hash))
        if (bytes instanceof Uint8Array) found.set(hash, bytes)
        else if (bytes instanceof ArrayBuffer) found.set(hash, new Uint8Array(bytes))
      })
    )
    return found
  }

  async keepChunks(chunks: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const db = await this.#open()
    if (!db) return this.#memory.keepChunks(chunks)
    const write = db.transaction(STORED.chunks, "readwrite")
    const store = write.objectStore(STORED.chunks)
    for (const [hash, bytes] of chunks) store.put(bytes, hash)
    await done(write)
  }

  async forget(keys: readonly string[], chunks: readonly string[]): Promise<void> {
    const db = await this.#open()
    if (!db) return this.#memory.forget(keys, chunks)
    const write = db.transaction([STORED.manifests, STORED.chunks], "readwrite")
    for (const key of keys) write.objectStore(STORED.manifests).delete(key)
    for (const hash of chunks) write.objectStore(STORED.chunks).delete(hash)
    await done(write)
  }
}

function asked<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB refused a read"))
  })
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB refused a write"))
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB dropped a write"))
  })
}
