import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The keys and values a LevelDB folder holds, read in place without its
 * lock: Chromium keeps a renderer's localStorage this way (`Local
 * Storage/leveldb`), Mako's desktop clients and every Chromium-family
 * browser alike, and Mako's drafts and outbox are there, naming the files
 * they carry.
 *
 * Reading while the owner runs is safe in this format: a table (`*.ldb`,
 * `*.sst`) is never changed once written, and a write-ahead log (`*.log`)
 * only grows, a record torn at its end being read as far as it goes. What
 * moves is the set of files: a compaction writes new tables and deletes old
 * ones. So a folder is read file by file, then listed again, and read again
 * if a file it read is gone or one it didn't is new (`levelDbFolder`);
 * whatever was live at either listing is read whole.
 *
 * Nothing is parsed past what a search needs: a log's records are its write
 * batches, their fragments across 32 KiB blocks joined; a table's blocks are
 * found from its index and uncompressed (Snappy, or stored), keys rebuilt
 * from their shared prefixes. A record that isn't a batch is returned whole
 * with no key, so a search still reads it. Anything this reader can't follow
 * (a table with another compression, a footer that isn't LevelDB's) throws:
 * a caller that must not miss a name treats the folder as unreadable rather
 * than as naming nothing.
 */

const LOG_BLOCK = 32 * 1024
const LOG_HEADER = 7
const FOOTER = 48
/** `kTableMagicNumber`, little-endian in the last 8 bytes of a table. */
const TABLE_MAGIC = 0xdb4775248b80fb57n
const STORED = 0
const SNAPPY = 1
/** An internal key ends with 8 bytes of sequence number and type. */
const KEY_TRAILER = 8
/** Times a folder is read again because a compaction moved its files mid-read. */
const READS = 4

export interface LevelDbEntry {
  /** The user key; null for a log record that wasn't a write batch. */
  key: Buffer | null
  value: Buffer
}

/** The files of the folder at `folder` that hold keys and values: its logs and tables. */
export async function levelDbFiles(folder: string): Promise<string[]> {
  const names = await readdir(folder)
  return names.filter((name) => /\.(log|ldb|sst)$/.test(name)).sort().map((name) => join(folder, name))
}

/** The entries one file holds, read whole. */
export async function levelDbEntries(path: string): Promise<LevelDbEntry[]> {
  const bytes = await readFile(path)
  return path.endsWith(".log") ? logEntries(bytes) : tableEntries(bytes)
}

/**
 * Every file of a folder, each handed to `read` (which may answer from what
 * it read before), until a listing after the reads matches the one before
 * them. A folder whose files keep moving throws after `READS` tries.
 */
export async function levelDbFolder(folder: string, read: (path: string) => Promise<void>): Promise<string[]> {
  for (let attempt = 0; attempt < READS; attempt += 1) {
    const before = await levelDbFiles(folder)
    let moved = false
    for (const path of before) {
      try {
        await read(path)
      } catch (error) {
        // Compacted away between the listing and the read: its entries are in a file the next listing names.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        moved = true
      }
    }
    const after = await levelDbFiles(folder)
    if (!moved && after.length === before.length && after.every((path, index) => path === before[index])) return after
  }
  throw new Error("The LevelDB folder's files kept moving while it was read")
}

/** A log's write batches, as their puts' keys and values. */
export function logEntries(bytes: Buffer): LevelDbEntry[] {
  const entries: LevelDbEntry[] = []
  for (const record of logRecords(bytes)) {
    const batch = batchEntries(record)
    if (batch) entries.push(...batch)
    else entries.push({ key: null, value: record })
  }
  return entries
}

/**
 * A log's records. A record torn by a crash or still being written (a
 * header past the end, a length past its block) ends the readable part as
 * LevelDB's own reader does; its bytes are still returned as one record, so
 * a search reads them.
 */
export function logRecords(bytes: Buffer): Buffer[] {
  const records: Buffer[] = []
  let pending: Buffer[] = []
  let at = 0
  while (at < bytes.length) {
    const left = LOG_BLOCK - (at % LOG_BLOCK)
    if (left < LOG_HEADER) {
      at += left
      continue
    }
    if (at + LOG_HEADER > bytes.length) break
    const length = bytes.readUInt16LE(at + 4)
    const type = bytes[at + 6]!
    const start = at + LOG_HEADER
    if (type === 0 && length === 0) {
      // Preallocated zeros: the rest of the block is empty.
      at += left
      continue
    }
    if (length > left - LOG_HEADER || start + length > bytes.length || type < 1 || type > 4) {
      records.push(Buffer.concat([...pending, bytes.subarray(at)]))
      return records
    }
    const fragment = bytes.subarray(start, start + length)
    if (type === 1) records.push(fragment)
    else if (type === 2) pending = [fragment]
    else {
      pending.push(fragment)
      if (type === 4) {
        records.push(Buffer.concat(pending))
        pending = []
      }
    }
    at = start + length
  }
  if (pending.length) records.push(Buffer.concat(pending))
  return records
}

/** A write batch's puts (sequence, count, then each put's key and value); null when the record isn't one. */
function batchEntries(record: Buffer): LevelDbEntry[] | null {
  if (record.length < 12) return null
  const count = record.readUInt32LE(8)
  const cursor = { at: 12 }
  const entries: LevelDbEntry[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      const type = record[cursor.at++]
      const key = slice(record, cursor, readVarint(record, cursor))
      if (type === 1) entries.push({ key, value: slice(record, cursor, readVarint(record, cursor)) })
      else if (type !== 0) return null
    }
  } catch {
    return null
  }
  return entries
}

function slice(bytes: Buffer, cursor: { at: number }, length: number): Buffer {
  if (cursor.at + length > bytes.length) throw new Error("A LevelDB entry past its end")
  const part = bytes.subarray(cursor.at, cursor.at + length)
  cursor.at += length
  return part
}

/** A table's entries, block by block through its index, each block uncompressed. */
export function tableEntries(bytes: Buffer): LevelDbEntry[] {
  if (bytes.length < FOOTER) throw new Error("A LevelDB table shorter than its footer")
  const footer = bytes.subarray(bytes.length - FOOTER)
  if (footer.readBigUInt64LE(FOOTER - 8) !== TABLE_MAGIC) throw new Error("Not a LevelDB table: its magic number differs")
  const cursor = { at: 0 }
  readVarint(footer, cursor)
  readVarint(footer, cursor)
  const index = block(bytes, readVarint(footer, cursor), readVarint(footer, cursor))
  return blockEntries(index).flatMap(({ value: handle }) => {
    const at = { at: 0 }
    return blockEntries(block(bytes, readVarint(handle, at), readVarint(handle, at))).map(({ key, value }) => ({
      key: key.length >= KEY_TRAILER ? key.subarray(0, key.length - KEY_TRAILER) : key,
      value,
    }))
  })
}

/** The block at `offset`, its trailer's compression undone. */
function block(bytes: Buffer, offset: number, size: number): Buffer {
  if (offset + size + 5 > bytes.length) throw new Error("A LevelDB block past the table's end")
  const contents = bytes.subarray(offset, offset + size)
  const type = bytes[offset + size]
  if (type === STORED) return contents
  if (type === SNAPPY) return snappyDecompress(contents)
  throw new Error(`A LevelDB block compressed with type ${type}, which this reader doesn't know`)
}

/** Every entry in a block, its key rebuilt from the prefix it shares with the one before. */
function blockEntries(contents: Buffer): { key: Buffer; value: Buffer }[] {
  if (contents.length < 4) throw new Error("A LevelDB block too short for its restarts")
  const restarts = contents.readUInt32LE(contents.length - 4)
  const end = contents.length - 4 - restarts * 4
  if (end < 0) throw new Error("A LevelDB block with more restarts than bytes")
  const entries: { key: Buffer; value: Buffer }[] = []
  const cursor = { at: 0 }
  let previous = Buffer.alloc(0)
  while (cursor.at < end) {
    const shared = readVarint(contents, cursor)
    const unshared = readVarint(contents, cursor)
    const length = readVarint(contents, cursor)
    if (shared > previous.length || cursor.at + unshared + length > end) throw new Error("A LevelDB block entry past its end")
    const key = Buffer.concat([previous.subarray(0, shared), contents.subarray(cursor.at, cursor.at + unshared)])
    cursor.at += unshared
    entries.push({ key, value: contents.subarray(cursor.at, cursor.at + length) })
    cursor.at += length
    previous = key
  }
  return entries
}

function readVarint(bytes: Buffer, cursor: { at: number }): number {
  let value = 0
  let factor = 1
  for (let read = 0; read < 10; read += 1) {
    if (cursor.at >= bytes.length) throw new Error("A LevelDB varint past its end")
    const byte = bytes[cursor.at++]!
    value += (byte & 0x7f) * factor
    if (!(byte & 0x80)) return value
    factor *= 128
  }
  throw new Error("A LevelDB varint longer than ten bytes")
}

/** Snappy's raw format (no framing), as LevelDB stores a compressed block and Firefox a compressed value. */
export function snappyDecompress(input: Buffer): Buffer {
  const cursor = { at: 0 }
  const length = readVarint(input, cursor)
  const output = Buffer.alloc(length)
  let out = 0
  let at = cursor.at
  while (at < input.length) {
    const tag = input[at++]!
    const kind = tag & 3
    if (kind === 0) {
      let size = tag >>> 2
      if (size >= 60) {
        const bytes = size - 59
        if (at + bytes > input.length) throw new Error("A Snappy literal's length past its end")
        size = input.readUIntLE(at, bytes)
        at += bytes
      }
      size += 1
      if (at + size > input.length || out + size > length) throw new Error("A Snappy literal past its end")
      input.copy(output, out, at, at + size)
      at += size
      out += size
      continue
    }
    let size: number
    let offset: number
    if (kind === 1) {
      size = ((tag >>> 2) & 7) + 4
      offset = ((tag >>> 5) << 8) | input[at++]!
    } else if (kind === 2) {
      size = (tag >>> 2) + 1
      offset = input.readUInt16LE(at)
      at += 2
    } else {
      size = (tag >>> 2) + 1
      offset = input.readUInt32LE(at)
      at += 4
    }
    if (offset === 0 || offset > out || out + size > length) throw new Error("A Snappy copy outside what it has written")
    // Copies may overlap what they write, so byte by byte.
    for (let index = 0; index < size; index += 1) output[out + index] = output[out - offset + index]!
    out += size
  }
  if (out !== length) throw new Error("A Snappy block shorter than its stated length")
  return output
}
