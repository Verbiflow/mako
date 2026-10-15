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

const GEAR = (() => {
  const table = new Uint32Array(256)
  let state = 0x9e3779b9
  for (let index = 0; index < 256; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    table[index] = state >>> 0
  }
  return table
})()

/** Cuts a stream of bytes into chunks; `push` as bytes arrive, `end` for the last. */
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
    while (index < piece.length) {
      if (length < UNHASHED) {
        const skipped = Math.min(UNHASHED - length, piece.length - index)
        index += skipped
        length += skipped
        continue
      }
      hash = ((hash << 1) + GEAR[piece[index]!]!) >>> 0
      index += 1
      length += 1
      if ((length >= MIN_CHUNK && (hash & CUT_MASK) === 0) || length >= MAX_CHUNK) {
        const tail = piece.subarray(start, index)
        out.push(this.pending.length ? Buffer.concat([...this.pending, tail]) : Buffer.from(tail))
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
const RAW: ChunkCodec = 0
const ZSTD: ChunkCodec = 1

/**
 * Each entry in a pack starts with a header naming its chunk, so the index
 * can be rebuilt from the packs alone: magic, hash, codec, size, stored size.
 */
const ENTRY_MAGIC = 0x314b434d // "MCK1"
export const ENTRY_HEADER_BYTES = 4 + HASH_BYTES + 1 + 4 + 4
/** A pack stops taking chunks past this, so no file grows without bound. */
const PACK_LIMIT = 1024 * 1024 * 1024
const PACK_NAME = /^(\d{8})\.pack$/

const packName = (pack: number) => `${String(pack).padStart(8, "0")}.pack`

/**
 * Append-only pack files under one folder. Writes go to the newest pack; a
 * crash leaves at most unindexed bytes at a pack's end, which nothing reads.
 */
export class Packs {
  private writing: { pack: number; handle: FileHandle; size: number } | null = null
  private readers = new Map<number, FileHandle>()

  constructor(readonly folder: string) {
    mkdirSync(folder, { recursive: true })
  }

  /** Stores `bytes`, compressed when that saves, and says where. */
  async write(hash: Buffer, bytes: Buffer): Promise<ChunkPlace> {
    const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } })
    const codec = compressed.length < bytes.length * 0.95 ? ZSTD : RAW
    const body = codec === ZSTD ? compressed : bytes
    const target = await this.target(ENTRY_HEADER_BYTES + body.length)
    const header = Buffer.alloc(ENTRY_HEADER_BYTES)
    header.writeUInt32LE(ENTRY_MAGIC, 0)
    hash.copy(header, 4)
    header.writeUInt8(codec, 4 + HASH_BYTES)
    header.writeUInt32LE(bytes.length, 5 + HASH_BYTES)
    header.writeUInt32LE(body.length, 9 + HASH_BYTES)
    const offset = target.size + ENTRY_HEADER_BYTES
    await target.handle.writev([header, body], target.size)
    target.size += ENTRY_HEADER_BYTES + body.length
    return { pack: target.pack, offset, stored: body.length, size: bytes.length, codec }
  }

  async read(place: ChunkPlace): Promise<Buffer> {
    const handle = await this.reader(place.pack)
    const body = Buffer.allocUnsafe(place.stored)
    let read = 0
    while (read < body.length) {
      const { bytesRead } = await handle.read(body, read, body.length - read, place.offset + read)
      if (bytesRead === 0) throw new Error(`${packName(place.pack)} ends before the chunk at ${place.offset}`)
      read += bytesRead
    }
    const bytes = place.codec === ZSTD ? zstdDecompressSync(body) : body
    if (bytes.length !== place.size) throw new Error(`The chunk at ${packName(place.pack)}:${place.offset} decodes to ${bytes.length} bytes, not ${place.size}`)
    return bytes
  }

  /** Called holding the index's write lock: another process may have appended since. */
  async begin(): Promise<void> {
    if (this.writing) this.writing.size = (await this.writing.handle.stat()).size
  }

  /** Makes what's written durable before the index that names it commits. */
  async sync(): Promise<void> {
    await this.writing?.handle.sync()
  }

  async close(): Promise<void> {
    await this.writing?.handle.close()
    this.writing = null
    for (const handle of this.readers.values()) await handle.close()
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
          if (header.readUInt32LE(0) !== ENTRY_MAGIC) break
          const stored = header.readUInt32LE(9 + HASH_BYTES)
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

  private async target(bytes: number): Promise<{ pack: number; handle: FileHandle; size: number }> {
    if (this.writing && this.writing.size + bytes <= PACK_LIMIT) return this.writing
    let pack = this.writing ? this.writing.pack + 1 : (this.packs().at(-1) ?? 0)
    if (this.writing) await this.writing.handle.close()
    for (;;) {
      const handle = await open(join(this.folder, packName(pack)), "a+")
      const { size } = await handle.stat()
      if (size === 0 || size + bytes <= PACK_LIMIT) return (this.writing = { pack, handle, size })
      await handle.close()
      pack += 1
    }
  }

  private async reader(pack: number): Promise<FileHandle> {
    if (this.writing?.pack === pack) return this.writing.handle
    let handle = this.readers.get(pack)
    if (!handle) this.readers.set(pack, handle = await open(join(this.folder, packName(pack)), "r"))
    return handle
  }
}
