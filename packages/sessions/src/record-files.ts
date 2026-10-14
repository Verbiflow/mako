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

export type RecordEncoding = "plain" | "zstd"

/** The suffix each encoding adds to the plain file's name. */
const SUFFIXES = { plain: "", zstd: ".zst" } as const satisfies Record<RecordEncoding, string>

const CHUNK = 512 * 1024
/** The longest zstd frame header: magic, descriptor, window, dictionary id, content size. */
const FRAME_HEADER_BYTES = 18
const ZSTD_MAGIC = 0xfd2fb528

export function recordEncoding(path: string): RecordEncoding {
  return path.endsWith(SUFFIXES.zstd) ? "zstd" : "plain"
}

/** The record's plain file name, whatever its encoding. */
export function plainRecordPath(path: string): string {
  const suffix = SUFFIXES[recordEncoding(path)]
  return suffix ? path.slice(0, -suffix.length) : path
}

/** The record's file in `encoding`. */
export function encodedRecordPath(path: string, encoding: RecordEncoding): string {
  return plainRecordPath(path) + SUFFIXES[encoding]
}

/**
 * Of files found together, each record's once: a plain file hides its
 * compressed sibling, as the harness reads it. Compression writes the
 * compressed file before deleting the plain one, and a restore the reverse,
 * so both exist only for that moment and hold the same bytes.
 */
export function oneFilePerRecord(paths: readonly string[]): string[] {
  const plain = new Set(paths.filter((path) => recordEncoding(path) === "plain"))
  return paths.filter((path) => recordEncoding(path) === "plain" || !plain.has(plainRecordPath(path)))
}

/** A stat of a record's file, with its size in plain bytes. */
export interface RecordStat {
  /** Plain bytes: the length every offset into the record counts against. */
  bytes: number
  mtimeMs: number
  /** The file's own identity, which a rewrite in place keeps and a replacement doesn't. */
  identity: string
  encoding: RecordEncoding
}

/** A compressed file's plain size, by the file it was read from. Compressed files are written once. */
const plainSizes = new Map<string, { identity: string; size: number; mtimeMs: number; bytes: number }>()
const MAX_REMEMBERED_SIZES = 8192

function fileIdentity(info: Stats): string {
  return `${info.dev}:${info.ino}`
}

/** The record's stat, or null when it isn't a file. Reads a compressed file's frame header, once. */
export async function statRecord(path: string, info?: Stats): Promise<RecordStat | null> {
  const found = info ?? statSync(path, { throwIfNoEntry: false })
  if (!found?.isFile()) return null
  const encoding = recordEncoding(path)
  const identity = fileIdentity(found)
  if (encoding === "plain") return { bytes: found.size, mtimeMs: found.mtimeMs, identity, encoding }
  const known = plainSizes.get(path)
  if (known && known.identity === identity && known.size === found.size && known.mtimeMs === found.mtimeMs)
    return { bytes: known.bytes, mtimeMs: found.mtimeMs, identity, encoding }
  const bytes = await plainSize(path)
  if (plainSizes.size >= MAX_REMEMBERED_SIZES) plainSizes.clear()
  plainSizes.set(path, { identity, size: found.size, mtimeMs: found.mtimeMs, bytes })
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
