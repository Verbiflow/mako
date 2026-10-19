import { createHash } from "node:crypto"
import { z } from "zod"
import type { ForkIds, ForkRow, RecordRow, RecordValue } from "./harness-records.js"

/**
 * What every harness's fork rule (`RecordFork`) is made of: ids derived the
 * same way in every restore of the same arriving version to the same
 * destination, so a second restore finds the fork it wrote rather than
 * writing another, and the byte-level rewrites a fork's files need.
 */

export function forkIds(seed: Buffer, from: string, to: string): ForkIds {
  return { from, to, derive: (name) => createHash("sha256").update(seed).update("\0").update(name).digest() }
}

/** A UUID of `version` 4 from `bytes`; of version 7 keeping the 48-bit time of `timeOf` (a v7 id), so the fork sorts beside the session it came from. */
export function uuidFrom(bytes: Buffer, version: 4 | 7, timeOf?: string): string {
  const raw = Buffer.from(bytes.subarray(0, 16))
  const time = timeOf?.replaceAll("-", "").slice(0, 12)
  if (version === 7 && time && /^[0-9a-f]{12}$/i.test(time)) Buffer.from(time, "hex").copy(raw, 0)
  raw[6] = (raw[6]! & 0x0f) | (version << 4)
  raw[8] = (raw[8]! & 0x3f) | 0x80
  const hex = raw.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** `length` base-62 characters from `bytes`. */
export function base62(bytes: Buffer, length: number): string {
  let out = ""
  for (let index = 0; index < length; index++) out += BASE62[bytes[index % bytes.length]! % 62]
  return out
}

/** `bytes` with every JSON string that is exactly `from` made `to`; `bytes` itself when there's none, as there usually isn't. */
export function replaceQuoted(bytes: Buffer, from: string, to: string): Buffer {
  const needle = Buffer.from(JSON.stringify(from))
  let at = bytes.indexOf(needle)
  if (at === -1) return bytes
  const replacement = Buffer.from(JSON.stringify(to))
  const parts: Buffer[] = []
  let start = 0
  while (at !== -1) {
    parts.push(bytes.subarray(start, at), replacement)
    start = at + needle.length
    at = bytes.indexOf(needle, start)
  }
  parts.push(bytes.subarray(start))
  return Buffer.concat(parts)
}

/** Bytes per write when a fork's lines are streamed out. */
const FLUSH_BYTES = 1 << 20

/**
 * A file's bytes with each line, without its newline, given to `line`. A
 * line `line` hands back unchanged costs no copy: runs of them leave as the
 * slices of the chunks they came in. The last line needn't end in one.
 */
export async function* forkLines(source: AsyncIterable<Buffer> | Iterable<Buffer>, line: (bytes: Buffer, index: number) => Buffer): AsyncGenerator<Buffer> {
  let pending: Buffer[] = []
  let size = 0
  let index = 0
  let rest: Buffer = Buffer.alloc(0)
  const out: Buffer[] = []
  let outSize = 0
  const emit = (bytes: Buffer) => {
    out.push(bytes)
    outSize += bytes.length
  }
  const flush = () => {
    const joined = out.length === 1 ? out[0]! : Buffer.concat(out, outSize)
    out.length = 0
    outSize = 0
    return joined
  }
  for await (const chunk of source) {
    let start = 0
    let newline = chunk.indexOf(0x0a)
    if (newline !== -1 && (rest.length || pending.length)) {
      pending.push(chunk.subarray(0, newline))
      size += newline
      const whole = Buffer.concat([rest, ...pending], rest.length + size)
      emit(line(whole, index++))
      emit(NEWLINE)
      pending = []
      size = 0
      rest = Buffer.alloc(0)
      start = newline + 1
      newline = chunk.indexOf(0x0a, start)
    }
    // Unchanged lines are kept as one slice of the chunk until a changed one ends it.
    let run = start
    while (newline !== -1) {
      const bytes = chunk.subarray(start, newline)
      const mapped = line(bytes, index++)
      if (mapped !== bytes) {
        if (start > run) emit(chunk.subarray(run, start))
        emit(mapped)
        emit(NEWLINE)
        run = newline + 1
      }
      start = newline + 1
      newline = chunk.indexOf(0x0a, start)
    }
    if (start > run) emit(chunk.subarray(run, start))
    if (start < chunk.length) {
      if (!rest.length && !pending.length) rest = chunk.subarray(start)
      else {
        pending.push(chunk.subarray(start))
        size += chunk.length - start
      }
    }
    if (outSize >= FLUSH_BYTES) yield flush()
  }
  if (rest.length || pending.length) emit(line(Buffer.concat([rest, ...pending], rest.length + size), index))
  if (outSize) yield flush()
}

const NEWLINE = Buffer.from("\n")

/**
 * The common rule for a table whose rows a session owns by one column: a
 * row whose `owner` is the session's moves to the fork's id, with each of
 * `renamed`'s columns given the id the fork holds it under (a message's own
 * id, which the session's copy keeps); any other row is shared.
 */
export function ownedBy(owner: string, ids: ForkIds, renamed: Readonly<Record<string, (value: RecordValue, row: RecordRow) => RecordValue>> = {}): ForkRow {
  return (row) => {
    if (row[owner] !== ids.from) return "shared"
    const forked: RecordRow = { ...row, [owner]: ids.to }
    for (const [column, rename] of Object.entries(renamed)) if (column in row) forked[column] = rename(row[column] ?? null, row)
    return forked
  }
}

/** `path`'s root and the path below it, as the store names paths (`claude:projects/…`). */
export function rootAndBelow(path: string) {
  const colon = path.indexOf(":")
  return { root: path.slice(0, colon), below: path.slice(colon + 1) }
}

const Text = z.string()

/** A column's value when it's text; null for any other kind. */
export function textOf(value: RecordValue | undefined): string | null {
  const text = Text.safeParse(value)
  return text.success ? text.data : null
}

/** `value` passed through `rename` when it's text; any other value as it is. */
export function mapText(value: RecordValue, rename: (text: string) => string): RecordValue {
  const text = textOf(value)
  return text === null ? value : rename(text)
}
