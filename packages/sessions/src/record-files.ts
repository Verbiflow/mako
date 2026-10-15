/**
 * A record's bytes, in whichever encoding its harness keeps them.
 *
 * A harness writes a session's record plain, and may later compress it in
 * place (Codex rewrites a rollout untouched for a week as `.jsonl.zst` and
 * restores it when the thread resumes). The file's name says its encoding.
 * Every offset and size here counts the record's plain bytes, so an offset
 * a follower, a page or a lineage span holds means the same line before and
 * after the harness compresses or restores the file.
 *
 * A plain file is read by position. A zstd file can't be: its frame has no
 * seek table, so a read from an offset decodes from the start and drops what
 * comes before. Its size comes from the frame header, which Codex always
 * writes, so listing and stat never decode.
 */

import { createReadStream, statSync, type Stats } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { createZstdDecompress } from "node:zlib"
import { recordEncoding, type RecordEncoding } from "./record-encoding.js"

export { encodedRecordPath, oneFilePerRecord, plainRecordPath, recordEncoding, type RecordEncoding } from "./record-encoding.js"

const CHUNK = 512 * 1024
/** The longest zstd frame header: magic, descriptor, window, dictionary id, content size. */
const FRAME_HEADER_BYTES = 18
const ZSTD_MAGIC = 0xfd2fb528

/** A stat of a record's file, with its size in plain bytes. */
export interface RecordStat {
  /** Plain bytes: the length every offset into the record counts against. */
  bytes: number
  mtimeMs: number
  /** The file's own identity, which a rewrite in place keeps and a replacement doesn't. */
  identity: string
  encoding: RecordEncoding
}

const MAX_REMEMBERED_SIZES = 8192

function fileIdentity(info: Stats): string {
  return `${info.dev}:${info.ino}`
}

/**
 * Compressed files' plain sizes, by the file each was read from, for a
 * scanner that stats the same files on every listing: a frame header read
 * costs about 40 µs, a stat about 1. Compressed files are written once, so a
 * size holds while the file's identity, size and mtime do.
 */
export class PlainSizes {
  private readonly known = new Map<string, { identity: string; size: number; mtimeMs: number; bytes: number }>()

  get(path: string, info: Stats): number | undefined {
    const known = this.known.get(path)
    return known && known.identity === fileIdentity(info) && known.size === info.size && known.mtimeMs === info.mtimeMs
      ? known.bytes
      : undefined
  }

  set(path: string, info: Stats, bytes: number): void {
    if (this.known.size >= MAX_REMEMBERED_SIZES) this.known.clear()
    this.known.set(path, { identity: fileIdentity(info), size: info.size, mtimeMs: info.mtimeMs, bytes })
  }
}

/** The record's stat, or null when it isn't a file. Reads a compressed file's frame header, unless `sizes` has it. */
export async function statRecord(path: string, info?: Stats, sizes?: PlainSizes): Promise<RecordStat | null> {
  const found = info ?? statSync(path, { throwIfNoEntry: false })
  if (!found?.isFile()) return null
  const encoding = recordEncoding(path)
  const identity = fileIdentity(found)
  if (encoding === "plain") return { bytes: found.size, mtimeMs: found.mtimeMs, identity, encoding }
  let bytes = sizes?.get(path, found)
  if (bytes === undefined) {
    bytes = await plainSize(path)
    sizes?.set(path, found, bytes)
  }
  return { bytes, mtimeMs: found.mtimeMs, identity, encoding }
}

/**
 * A zstd file's plain size: its frame's declared content size, else what
 * decoding it all yields. Codex compresses a rollout as one frame and
 * declares its size; a later frame after it would only extend the record,
 * which a read to the end still delivers.
 */
async function plainSize(path: string): Promise<number> {
  const handle = await open(path, "r")
  try {
    const header = Buffer.alloc(FRAME_HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, FRAME_HEADER_BYTES, 0)
    const declared = bytesRead >= 6 ? frameContentSize(header.subarray(0, bytesRead)) : undefined
    if (declared !== undefined) return declared
  } finally {
    await handle.close()
  }
  let size = 0
  for await (const chunk of decodedChunks(path)) size += chunk.length
  return size
}

/** The content size a zstd frame header declares; undefined when it declares none. */
function frameContentSize(header: Buffer): number | undefined {
  if (header.readUInt32LE(0) !== ZSTD_MAGIC) return undefined
  const descriptor = header[4]!
  const sizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!
  const sizeBytes = sizeFlag === 0 ? singleSegment : [1, 2, 4, 8][sizeFlag]!
  if (!sizeBytes) return undefined
  const at = 5 + (singleSegment ? 0 : 1) + dictionaryBytes
  if (header.length < at + sizeBytes) return undefined
  if (sizeBytes === 1) return header[at]!
  if (sizeBytes === 2) return header.readUInt16LE(at) + 256
  if (sizeBytes === 4) return header.readUInt32LE(at)
  return Number(header.readBigUInt64LE(at))
}

function decodedChunks(path: string): AsyncIterable<Buffer> {
  return createReadStream(path, { highWaterMark: CHUNK }).pipe(createZstdDecompress({ chunkSize: CHUNK }))
}

/** A run of a record's plain bytes and the offset of its first. */
export interface RecordChunk {
  bytes: Buffer
  at: number
}

/**
 * A record's plain bytes from `from` up to `until`, in chunks. A plain file
 * is read by position through the open `handle` its caller stat'ed, so a
 * replacement mid-read can't mix two files; a compressed one is decoded from
 * its start. Stopping the iteration stops the decoding.
 */
export async function* recordChunks(
  path: string,
  from: number,
  until: number,
  handle?: FileHandle
): AsyncGenerator<RecordChunk> {
  if (from >= until) return
  if (recordEncoding(path) === "plain") {
    const own = handle ?? (await open(path, "r"))
    try {
      let cursor = from
      while (cursor < until) {
        const length = Math.min(CHUNK, until - cursor)
        const bytes = Buffer.allocUnsafe(length)
        const { bytesRead } = await own.read(bytes, 0, length, cursor)
        if (bytesRead === 0) return
        yield { bytes: bytesRead === length ? bytes : bytes.subarray(0, bytesRead), at: cursor }
        cursor += bytesRead
      }
    } finally {
      if (!handle) await own.close()
    }
    return
  }
  let at = 0
  for await (const decoded of decodedChunks(path)) {
    const end = at + decoded.length
    if (end > from) {
      const start = Math.max(0, from - at)
      const stop = Math.min(decoded.length, until - at)
      yield { bytes: decoded.subarray(start, stop), at: at + start }
    }
    at = end
    if (at >= until) return
  }
}
