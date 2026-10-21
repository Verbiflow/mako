import { createHash } from "node:crypto"
import { mkdirSync, readdirSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib"

/**
 * Bytes cut where their content says, so the same run of bytes is the same
 * chunk wherever it appears: in two versions of a record, in a compaction
 * snapshot that repeats a session's history, or in two sessions. A gear hash
 * cuts once its low 14 bits are zero (16 KiB on average), never under 4 KiB
 * and always by 64 KiB.
 */
const MIN_CHUNK = 4 * 1024
const MAX_CHUNK = 64 * 1024
const CUT_MASK = (1 << 14) - 1
/** Each step shifts the 32-bit hash a bit left, so it holds only the last 32 bytes: the bytes of a chunk before those can't move a cut. */
const UNHASHED = MIN_CHUNK - 32

/** Signed, so the rolling hash stays a 32-bit integer: `>>> 0` made it a double past 2^31, and the hash ran at a seventh of this speed. */
const GEAR = (() => {
  const table = new Int32Array(256)
  let state = 0x9e3779b9
  for (let index = 0; index < 256; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    table[index] = state >>> 0
  }
  return table
})()

/**
 * Cuts a stream of bytes into chunks; `push` as bytes arrive, `end` for the
 * last. A chunk that lies within one push is a view of its bytes, not a copy:
 * each pushed buffer must stay unchanged while its chunks are in use.
 */
export class Chunker {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private hash = 0

  push(bytes: Uint8Array): Buffer[] {
    const out: Buffer[] = []
    const piece = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let start = 0
    let hash = this.hash
    let length = this.pendingBytes
    let index = 0
    const size = piece.length
    while (index < size) {
      if (length < UNHASHED) {
        const skipped = Math.min(UNHASHED - length, size - index)
        index += skipped
        length += skipped
        continue
      }
      // The 32 bytes before MIN_CHUNK only warm the hash; no cut falls there.
      if (length < MIN_CHUNK) {
        const warm = Math.min(MIN_CHUNK - length, size - index)
        for (let at = index; at < index + warm; at++) hash = ((hash << 1) + GEAR[piece[at]!]!) | 0
        index += warm
        length += warm
        if (length < MIN_CHUNK) break
      }
      const end = Math.min(size, index + MAX_CHUNK - length)
      let at = index
      let found = false
      while (at < end) {
        hash = ((hash << 1) + GEAR[piece[at++]!]!) | 0
        if ((hash & CUT_MASK) === 0) {
          found = true
          break
        }
      }
      length += at - index
      index = at
      if (found || length >= MAX_CHUNK) {
        const tail = piece.subarray(start, index)
        out.push(this.pending.length ? Buffer.concat([...this.pending, tail]) : tail)
        this.pending = []
        start = index
        hash = 0
        length = 0
      }
    }
    if (start < piece.length) this.pending.push(Buffer.from(piece.subarray(start)))
    this.pendingBytes = length
    this.hash = hash
    return out
  }

  end(): Buffer[] {
    const rest = this.pending.length ? [Buffer.concat(this.pending)] : []
    this.pending = []
    this.pendingBytes = 0
    this.hash = 0
    return rest
  }
}

export const HASH_BYTES = 32

export function chunkHash(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest()
}

/** Where a chunk's stored bytes are. */
export interface ChunkPlace {
  pack: number
  offset: number
  /** Bytes in the pack, after the entry header. */
  stored: number
  /** Bytes once decoded. */
  size: number
  codec: ChunkCodec
}

export type ChunkCodec = 0 | 1

/** A chunk as a store keeps it: its codec, its size once decoded, and its stored bytes. */
export interface StoredChunk {
  codec: ChunkCodec
  size: number
  body: Buffer
}

/**
 * Whether `stored` is the chunk `hash` names, decoded and hashed: what crosses between stores is never taken on its
 * sender's word. Throws naming the hash when it isn't.
 */
export function checkStoredChunk(hash: Buffer, stored: StoredChunk): void {
  if (stored.codec !== 0 && stored.codec !== 1) throw new Error(`The chunk ${hash.toString("hex")} came in an unknown codec`)
  const bytes = stored.codec === 1 ? decoded(stored.body) : stored.body
  if (bytes === null || bytes.length !== stored.size || !chunkHash(bytes).equals(hash))
    throw new Error(`The chunk ${hash.toString("hex")} that came isn't the chunk its hash names`)
}
/** A body that doesn't decode is as wrong as one whose bytes don't match. */
function decoded(body: Buffer): Buffer | null {
  try {
    return zstdDecompressSync(body)
  } catch {
    return null
  }
}
const RAW: ChunkCodec = 0
const ZSTD: ChunkCodec = 1

/**
 * Each entry in a pack starts with a header naming its chunk, so the index
 * can be rebuilt from the packs alone: magic, hash, codec, size, stored size.
 */
const ENTRY_MAGIC = 0x314b434d // "MCK1"
/** An entry a repack scrubbed (`record-repack.ts`): its hash and bytes are zeros, its stored length kept so a scan steps over it. */
const DEAD_MAGIC = 0x44414544 // "DEAD"
export const ENTRY_HEADER_BYTES = 4 + HASH_BYTES + 1 + 4 + 4
/** A pack stops taking chunks past this, so no file grows without bound. */
export const PACK_LIMIT = 1024 * 1024 * 1024
const PACK_NAME = /^(\d{8})\.pack$/
/**
 * Entries are copied into a buffer of this size and written a buffer at a
 * time: one write per chunk was a round trip to the thread pool for each of
 * a large store's half million chunks. Copied, because zstd's output is a
 * view of a 64 KiB allocation, which a list of waiting entries would keep.
 */
const FLUSH_BYTES = 8 * 1024 * 1024

export const packName = (pack: number) => `${String(pack).padStart(8, "0")}.pack`

/** What a scrubbed entry becomes in place: a dead header naming nothing, then zeros. */
export function deadEntry(stored: number): Buffer {
  const entry = Buffer.alloc(ENTRY_HEADER_BYTES + stored)
  entry.writeUInt32LE(DEAD_MAGIC, 0)
  entry.writeUInt32LE(stored, 9 + HASH_BYTES)
  return entry
}

/** A chunk's entry in a pack: its header (naming the chunk, so the index can be rebuilt from the packs alone), then its stored bytes. */
export function packEntry(hash: Buffer, codec: ChunkCodec, size: number, body: Buffer): Buffer[] {
  const header = Buffer.alloc(ENTRY_HEADER_BYTES)
  header.writeUInt32LE(ENTRY_MAGIC, 0)
  hash.copy(header, 4)
  header.writeUInt8(codec, 4 + HASH_BYTES)
  header.writeUInt32LE(size, 5 + HASH_BYTES)
  header.writeUInt32LE(body.length, 9 + HASH_BYTES)
  return [header, body]
}

/**
 * Append-only pack files under one folder. Writes go to the newest pack; a
 * crash leaves at most unindexed bytes at a pack's end, which nothing reads.
 * Entries wait in memory until `FLUSH_BYTES` of them or `sync`, which runs
 * before the index naming them commits, so nothing is written outside the
 * index's write lock; entries still waiting when a transaction rolls back
 * are dropped.
 */
export class Packs {
  /** `size` counts the entries waiting in `staged`; `written` is where they go. */
  private writing: { pack: number; handle: FileHandle; size: number; written: number } | null = null
  private staged: Buffer | null = null
  /** Each pack's reading handle, as the promise of its open: two reads of one pack at once share one open. */
  private readers = new Map<number, Promise<FileHandle>>()

  constructor(readonly folder: string) {
    mkdirSync(folder, { recursive: true })
  }

  /** Stores `bytes`, compressed when that saves, and says where. */
  async write(hash: Buffer, bytes: Buffer): Promise<ChunkPlace> {
    const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } })
    const codec = compressed.length < bytes.length * 0.95 ? ZSTD : RAW
    return this.writeBody(hash, codec, bytes.length, codec === ZSTD ? compressed : bytes)
  }

  /**
   * Stores a chunk as another store stored it (`readStored`), once `chunkOf` checked it is the chunk its hash names:
   * a chunk that crosses between stores is compressed once, where it was first written.
   */
  async writeStored(hash: Buffer, stored: StoredChunk): Promise<ChunkPlace> {
    return this.writeBody(hash, stored.codec, stored.size, stored.body)
  }

  /** A chunk's bytes as stored, compressed or not, for another store's `writeStored`. */
  async readStored(place: ChunkPlace): Promise<StoredChunk> {
    const body = Buffer.allocUnsafe(place.stored)
    const { writing, staged } = this
    if (writing?.pack === place.pack && staged && place.offset >= writing.written)
      staged.copy(body, 0, place.offset - writing.written, place.offset - writing.written + place.stored)
    else {
      const handle = await this.reader(place.pack)
      let read = 0
      while (read < body.length) {
        const { bytesRead } = await handle.read(body, read, body.length - read, place.offset + read)
        if (bytesRead === 0) throw new Error(`${packName(place.pack)} ends before the chunk at ${place.offset}`)
        read += bytesRead
      }
    }
    return { codec: place.codec, size: place.size, body }
  }

  private async writeBody(hash: Buffer, codec: ChunkCodec, size: number, body: Buffer): Promise<ChunkPlace> {
    const entry = ENTRY_HEADER_BYTES + body.length
    const target = await this.target(entry)
    if (target.size - target.written + entry > FLUSH_BYTES) await this.flush()
    const staged = (this.staged ??= Buffer.allocUnsafe(FLUSH_BYTES))
    const at = target.size - target.written
    staged.writeUInt32LE(ENTRY_MAGIC, at)
    hash.copy(staged, at + 4)
    staged.writeUInt8(codec, at + 4 + HASH_BYTES)
    staged.writeUInt32LE(size, at + 5 + HASH_BYTES)
    staged.writeUInt32LE(body.length, at + 9 + HASH_BYTES)
    body.copy(staged, at + ENTRY_HEADER_BYTES)
    const offset = target.size + ENTRY_HEADER_BYTES
    target.size += entry
    return { pack: target.pack, offset, stored: body.length, size, codec }
  }

  async read(place: ChunkPlace): Promise<Buffer> {
    const body = Buffer.allocUnsafe(place.stored)
    const { writing, staged } = this
    if (writing?.pack === place.pack && staged && place.offset >= writing.written) {
      // Still waiting to be written, by the transaction reading it.
      staged.copy(body, 0, place.offset - writing.written, place.offset - writing.written + place.stored)
      return this.decoded(place, body)
    }
    const handle = await this.reader(place.pack)
    let read = 0
    while (read < body.length) {
      const { bytesRead } = await handle.read(body, read, body.length - read, place.offset + read)
      if (bytesRead === 0) throw new Error(`${packName(place.pack)} ends before the chunk at ${place.offset}`)
      read += bytesRead
    }
    return this.decoded(place, body)
  }

  private decoded(place: ChunkPlace, body: Buffer): Buffer {
    const bytes = place.codec === ZSTD ? zstdDecompressSync(body) : body
    if (bytes.length !== place.size) throw new Error(`The chunk at ${packName(place.pack)}:${place.offset} decodes to ${bytes.length} bytes, not ${place.size}`)
    return bytes
  }

  /**
   * Called holding the index's write lock: another process may have appended
   * since, or a repack (`record-repack.ts`) placed a newer pack. Writes only
   * ever go to the newest pack, so a pack below it changes only by a repack.
   */
  async begin(): Promise<void> {
    if (!this.writing) return
    const newest = this.packs().at(-1)
    if (newest !== undefined && newest > this.writing.pack) {
      await this.writing.handle.close()
      this.writing = null
      return
    }
    // Entries still waiting belong to a transaction that rolled back: no index names them.
    this.writing.size = this.writing.written = (await this.writing.handle.stat()).size
  }

  /** The packs in the folder, oldest first. */
  numbers(): number[] {
    return this.packs()
  }

  /** Lets go of a pack a repack removed; its number is never used again, since the newest pack is never removed. */
  async drop(pack: number): Promise<void> {
    const handle = this.readers.get(pack)
    this.readers.delete(pack)
    await (await handle?.catch(() => null))?.close()
  }

  /** Makes what's written durable before the index that names it commits. */
  async sync(): Promise<void> {
    await this.flush()
    await this.writing?.handle.sync()
  }

  /** Entries still waiting were never synced, so no committed index names them. */
  async close(): Promise<void> {
    await this.writing?.handle.close()
    this.writing = null
    for (const handle of this.readers.values()) await (await handle.catch(() => null))?.close()
    this.readers.clear()
  }

  /** Every entry of every pack, for rebuilding the index or checking the packs. */
  async *entries(): AsyncGenerator<{ hash: Buffer; place: ChunkPlace }> {
    for (const pack of this.packs()) {
      const handle = await open(join(this.folder, packName(pack)), "r")
      try {
        const { size } = await handle.stat()
        let at = 0
        const header = Buffer.alloc(ENTRY_HEADER_BYTES)
        while (at + ENTRY_HEADER_BYTES <= size) {
          await handle.read(header, 0, ENTRY_HEADER_BYTES, at)
          const magic = header.readUInt32LE(0)
          const stored = header.readUInt32LE(9 + HASH_BYTES)
          if (magic === DEAD_MAGIC && at + ENTRY_HEADER_BYTES + stored <= size) {
            at += ENTRY_HEADER_BYTES + stored
            continue
          }
          if (magic !== ENTRY_MAGIC) break
          const codec = header.readUInt8(4 + HASH_BYTES)
          if (at + ENTRY_HEADER_BYTES + stored > size || (codec !== 0 && codec !== 1)) break
          yield {
            hash: Buffer.from(header.subarray(4, 4 + HASH_BYTES)),
            place: { pack, offset: at + ENTRY_HEADER_BYTES, stored, size: header.readUInt32LE(5 + HASH_BYTES), codec },
          }
          at += ENTRY_HEADER_BYTES + stored
        }
      } finally {
        await handle.close()
      }
    }
  }

  private packs(): number[] {
    return readdirSync(this.folder).flatMap((name) => {
      const match = PACK_NAME.exec(name)
      return match ? [Number(match[1])] : []
    }).sort((left, right) => left - right)
  }

  /** Writes the waiting entries where they were placed. */
  private async flush(): Promise<void> {
    const target = this.writing
    if (!target || !this.staged || target.size === target.written) return
    const bytes = target.size - target.written
    const { bytesWritten } = await target.handle.write(this.staged, 0, bytes, target.written)
    if (bytesWritten !== bytes) throw new Error(`${packName(target.pack)} took ${bytesWritten} of ${bytes} bytes`)
    target.written += bytes
  }

  private async target(bytes: number): Promise<{ pack: number; handle: FileHandle; size: number; written: number }> {
    if (this.writing && this.writing.size + bytes <= PACK_LIMIT) return this.writing
    let pack = this.writing ? this.writing.pack + 1 : (this.packs().at(-1) ?? 0)
    if (this.writing) {
      await this.flush()
      await this.writing.handle.close()
    }
    for (;;) {
      const handle = await open(join(this.folder, packName(pack)), "a+")
      const { size } = await handle.stat()
      if (size === 0 || size + bytes <= PACK_LIMIT) return (this.writing = { pack, handle, size, written: size })
      await handle.close()
      pack += 1
    }
  }

  private async reader(pack: number): Promise<FileHandle> {
    if (this.writing?.pack === pack) return this.writing.handle
    let handle = this.readers.get(pack)
    if (!handle) {
      handle = open(join(this.folder, packName(pack)), "r")
      this.readers.set(pack, handle)
      // A pack that can't be opened isn't cached: the next read tries again.
      handle.catch(() => {
        if (this.readers.get(pack) === handle) this.readers.delete(pack)
      })
    }
    return handle
  }
}
