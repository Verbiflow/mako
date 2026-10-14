/**
 * JSONL plumbing shared by every file-backed provider.
 *
 * The catalog's speed rests on three disciplines here: reads are *bounded*
 * (peeks read a head, never the whole file), reads are *incremental* (a
 * growing session re-reads only the appended bytes), and reads are
 * *streamed* (a full translation walks the file in fixed-size chunks —
 * session files reach gigabytes in the wild, and a gigabyte must never
 * become one JavaScript string).
 *
 * A record is read in whichever encoding its file is in (`record-files.ts`),
 * and as its whole lineage where it continues an earlier one (`RecordSpan`).
 */

import { statSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import type { ThreadEntry } from "./format.js"
import type { SessionFollower, SessionUpdate } from "./providers/types.js"
import { oneFilePerRecord, plainRecordPath, recordChunks, recordEncoding, statRecord, type RecordChunk } from "./record-files.js"

const MAX_LINE_BYTES = 16 * 1024 * 1024
const MAX_FOLLOW_RESET_BYTES = 64 * 1024 * 1024

export interface LineTranslator {
  push(raw: string): void
  snapshot(): ThreadEntry[]
  readonly needsReset?: boolean
  /**
   * How many leading entries the last `snapshot` returned exactly as the one
   * before it did. A follower serializes and compares only the rest, so a
   * batch costs what changed rather than the whole conversation. Without it
   * every entry is compared.
   */
  readonly unchanged?: number
}

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

interface LineRead {
  nextByte: number
  reset: boolean
  size: number
  identity: string
}

/** Parse one JSONL line, returning null rather than throwing on torn writes. */
export function parseLine(line: string): JsonRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value: JsonValue = JSON.parse(trimmed)
    return isJsonRecord(value) ? value : null
  } catch {
    return null
  }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

/** The first `bytes` of a record, decoded. */
export async function readHead(path: string, bytes: number): Promise<string> {
  const parts: Buffer[] = []
  let length = 0
  for await (const chunk of recordChunks(path, 0, bytes)) {
    parts.push(chunk.bytes)
    length += chunk.bytes.length
  }
  return Buffer.concat(parts, length).toString("utf8")
}

/**
 * Complete lines out of a record's bytes, chunk by chunk. Splitting is done
 * on the byte, not the decoded string, so a multi-byte character straddling
 * a chunk boundary can never be torn. A read that starts mid-line drops the
 * rest of that line: the chunk before `from` says whether it does.
 */
class LineSplitter {
  /** The offset after the last newline consumed. */
  consumed: number
  /** The offset after the last byte seen. */
  reached: number
  private carry: Buffer[] = []
  private carryBytes = 0
  private skipping = false
  private awaitingPrior: boolean
  private readonly onLine: (line: string) => void | boolean
  private readonly strict: boolean

  constructor(from: number, onLine: (line: string) => void | boolean, strict: boolean) {
    this.consumed = from
    this.reached = from
    this.awaitingPrior = from > 0
    this.onLine = onLine
    this.strict = strict
  }

  /** False once the callback stopped the read. */
  feed(chunk: RecordChunk): boolean {
    let { bytes, at } = chunk
    if (this.awaitingPrior) {
      this.awaitingPrior = false
      this.skipping = bytes[0] !== 0x0a
      bytes = bytes.subarray(1)
      at += 1
    }
    let start = 0
    while (start < bytes.length) {
      const lineBreak = bytes.indexOf(0x0a, start)
      if (lineBreak === -1) {
        if (!this.skipping) {
          const segment = bytes.subarray(start)
          if (this.carryBytes + segment.length > MAX_LINE_BYTES) {
            if (this.strict) throw new Error("Native evidence record exceeds the read limit")
            this.carry = []
            this.carryBytes = 0
            this.skipping = true
          } else {
            this.carry.push(Buffer.from(segment))
            this.carryBytes += segment.length
          }
        }
        break
      }
      const nextByte = at + lineBreak + 1
      if (this.skipping) {
        this.skipping = false
        this.carry = []
        this.carryBytes = 0
        this.consumed = nextByte
        start = lineBreak + 1
        continue
      }
      const segment = bytes.subarray(start, lineBreak)
      if (this.carryBytes + segment.length <= MAX_LINE_BYTES) {
        const line =
          this.carryBytes === 0
            ? segment.toString("utf8")
            : Buffer.concat([...this.carry, segment], this.carryBytes + segment.length).toString("utf8")
        this.carry = []
        this.carryBytes = 0
        this.consumed = nextByte
        if (this.onLine(line) === false) return false
      } else {
        if (this.strict) throw new Error("Native evidence record exceeds the read limit")
        this.carry = []
        this.carryBytes = 0
        this.consumed = nextByte
      }
      start = lineBreak + 1
    }
    this.reached = at + bytes.length
    return true
  }
}

/**
 * Stream complete lines from `fromByte` to the end of the file, in chunks.
 *
 * Returns the offset *after the last newline consumed*, so a line still being
 * written is left for the next call rather than parsed half-formed, and a
 * follow-up costs one positional read of only the new bytes. Splitting is
 * done on the byte, not the decoded string, so a multi-byte character
 * straddling a chunk boundary can never be torn.
 *
 * A callback that returns `false` stops the read — that is how bounded scans
 * (peeks hunting for a title) avoid walking a gigabyte they do not need.
 *
 * If the file shrank below `fromByte` it was rewritten (compaction,
 * truncation); reading restarts from zero so offsets never point into a file
 * that no longer exists in that shape.
 */
export async function readLineBatch(
  path: string,
  fromByte: number,
  onLine: (line: string) => void | boolean,
  evidence?: { identity: string; strict: true }
): Promise<LineRead> {
  return scanLines(path, fromByte, undefined, onLine, evidence)
}

/** `readLineBatch` up to `until`. */
async function scanLines(
  path: string,
  fromByte: number,
  until: number | undefined,
  onLine: (line: string) => void | boolean,
  evidence?: { identity: string; strict: true }
): Promise<LineRead> {
  const plain = recordEncoding(path) === "plain"
  const handle = plain ? await open(path, "r") : undefined
  try {
    const info = handle ? await handle.stat() : await stat(path)
    const identity = `${info.dev}:${info.ino}`
    if (evidence && evidence.identity !== identity)
      throw new Error("Native evidence source changed while opening")
    const size = plain ? info.size : ((await statRecord(path, info))?.bytes ?? 0)
    const reset = size < fromByte
    const from = reset ? 0 : fromByte
    // A plain file ends where its stat said; a compressed one where its frames do.
    const end = plain ? Math.min(size, until ?? size) : (until ?? Number.MAX_SAFE_INTEGER)
    const lines = new LineSplitter(from, onLine, evidence?.strict === true)
    for await (const chunk of recordChunks(path, Math.max(0, from - 1), end, handle))
      if (!lines.feed(chunk)) break
    return { nextByte: lines.consumed, reset, size: Math.max(size, lines.reached), identity }
  } finally {
    await handle?.close()
  }
}

export async function readLines(
  path: string,
  fromByte: number,
  onLine: (line: string) => void | boolean
): Promise<number> {
  return (await readLineBatch(path, fromByte, onLine)).nextByte
}

/**
 * One stretch of a record's history: a file from its start up to `until`, or
 * to its end. A record that continues an earlier one (Codex's
 * `history_base`) reads as its lineage: each earlier record's stretch, oldest
 * first, then its own file whole. A harness that keeps a record whole is a
 * lineage of one.
 */
export interface RecordSpan {
  path: string
  /** The first plain byte past the stretch; at a line's end. */
  until?: number
}

/**
 * A record's lines across its lineage, keeping only the last `keep` plain
 * bytes of the whole when given, read and dropped in order so the earlier
 * stretches cost only their decoding. The result is the read of the last
 * span, the record's own file, whose offset a follower continues from, and
 * how many plain bytes of the whole were left unread before `keep`.
 */
export async function readLineage(
  spans: readonly RecordSpan[],
  keep: number | undefined,
  onLine: (line: string) => void
): Promise<LineRead & { dropped: number }> {
  const own = spans[spans.length - 1]
  if (!own) throw new Error("A lineage ends with the record's own file")
  const lengths = await Promise.all(spans.map(async (span) => {
    const bytes = (await statRecord(span.path))?.bytes ?? 0
    return span.until === undefined ? bytes : Math.min(bytes, span.until)
  }))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const dropped = keep === undefined ? 0 : Math.max(0, total - keep)
  let skip = dropped
  for (let index = 0; index < spans.length - 1; index++) {
    const span = spans[index]!
    const length = lengths[index]!
    if (skip >= length) {
      skip -= length
      continue
    }
    await scanLines(span.path, skip, length, onLine)
    skip = 0
  }
  return { ...(await readLineBatch(own.path, skip, onLine)), dropped }
}

/**
 * Follow a record from `fromByte`. A reset re-reads the record's last bytes
 * across its lineage, when it continues another record, so the earlier
 * history it re-reads is the same the first read showed.
 */
export function createJsonlFollower(
  path: string,
  fromByte: number,
  createTranslator: () => LineTranslator,
  lineage: () => Promise<readonly RecordSpan[]> = async () => [{ path }]
): SessionFollower {
  let parser = createTranslator()
  let cursor = fromByte
  let identity: string | null = null
  let synchronized = false
  try {
    const info = statSync(path)
    identity = `${info.dev}:${info.ino}`
  } catch {
    identity = null
  }
  let previousValues: string[] = []

  const serializeEntries = (entries: ThreadEntry[]): string[] =>
    entries.map((entry) => JSON.stringify(entry))
  const remember = (entries: ThreadEntry[]) => {
    previousValues = serializeEntries(entries)
  }
  const cloneEntries = (entries: ThreadEntry[]): ThreadEntry[] =>
    structuredClone(entries)

  return {
    get offset() {
      return cursor
    },
    async next(): Promise<SessionUpdate> {
      let read = await readLineBatch(path, cursor, parser.push)
      if (read.reset || (identity !== null && read.identity !== identity)) {
        parser = createTranslator()
        read = await readLineage(await lineage(), MAX_FOLLOW_RESET_BYTES, parser.push)
        cursor = read.nextByte
        identity = read.identity
        synchronized = true
        const current = parser.snapshot()
        remember(current)
        return {
          entries: cloneEntries(current),
          nextByte: cursor,
          replace: true,
          replaceFrom: 0,
          reset: true,
        }
      }

      if (!synchronized && parser.needsReset) {
        parser = createTranslator()
        read = await readLineage(await lineage(), MAX_FOLLOW_RESET_BYTES, parser.push)
        cursor = read.nextByte
        identity = read.identity
        synchronized = true
        const current = parser.snapshot()
        remember(current)
        return {
          entries: cloneEntries(current),
          nextByte: cursor,
          replace: true,
          replaceFrom: 0,
          reset: true,
        }
      }

      cursor = Math.max(cursor, read.nextByte)
      identity = read.identity
      const current = parser.snapshot()
      const kept = Math.min(parser.unchanged ?? 0, previousValues.length, current.length)
      const changed = serializeEntries(current.slice(kept))
      const shared = Math.min(previousValues.length, current.length)
      let replaceFrom = kept
      while (replaceFrom < shared && previousValues[replaceFrom] === changed[replaceFrom - kept]) replaceFrom += 1
      const appended = replaceFrom === previousValues.length
      const update: SessionUpdate = {
        entries: cloneEntries(current.slice(replaceFrom)),
        nextByte: cursor,
        replace: !appended,
      }
      if (!appended) update.replaceFrom = replaceFrom
      previousValues.length = kept
      for (const value of changed) previousValues.push(value)
      return update
    },
  }
}

/** Recursively list files under a root, bounded, without following links. */
export async function walkFiles(
  root: string,
  matches: (name: string) => boolean,
  maxDepth = 5
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  const found: string[] = []
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) return visit(path, depth + 1)
        if (entry.isFile() && matches(entry.name)) found.push(path)
      })
    )
  }
  await visit(root, 0)
  return found
}

/**
 * The record files under a root whose plain name `matches`, in any encoding,
 * each record once (`oneFilePerRecord`).
 */
export async function walkRecordFiles(
  root: string,
  matches: (plainName: string) => boolean,
  maxDepth = 5
): Promise<string[]> {
  return oneFilePerRecord(await walkFiles(root, (name) => matches(plainRecordPath(name)), maxDepth))
}
