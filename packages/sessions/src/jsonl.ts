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

import { constants } from "node:buffer"
import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import type { Entry, NativeRecordSample, UnreadRecord } from "./format.js"
import type { RecordRef } from "./entries.js"
import type { TurnPoint, TurnState } from "./entry-sink.js"
import type { SessionFollower, SessionUpdate } from "./providers/types.js"
import { oneFilePerRecord, plainRecordPath, recordChunks, recordEncoding, recordFile, statRecord, type RecordChunk } from "./record-files.js"

/** The longest line that decodes to one string: none is longer than its bytes. */
const MAX_LINE_BYTES = constants.MAX_STRING_LENGTH
/** What a line longer than a string can be passes on: its head. */
const CUT_LINE_HEAD = 64 * 1024
/** The bytes before a read's last newline that its seal hashes. */
const SEAL_BYTES = 4096

/**
 * Where a line sits: its plain bytes, newline included, and its file when
 * it is an earlier one of the record's lineage (`RecordSpan`), as
 * `recordFile` names it.
 */
export interface LinePlace {
  from: number
  to: number
  file?: string
  /** The line is longer than a string can be, and what was passed is only its head. */
  cut?: true
}

/**
 * What a decoder keeps of a line it couldn't parse, for its unread entry:
 * the text, or a cut line's head and size. Nothing for a blank line.
 */
export function unparsedLine(raw: string, place: LinePlace | undefined): NativeRecordSample | undefined {
  if (place?.cut) return { head: raw, bytes: place.to - place.from }
  return raw.trim() ? raw : undefined
}

/** A line's place as the record `EntrySink.reading` names. */
export function lineRecord(place: LinePlace | undefined): RecordRef | undefined {
  if (!place) return undefined
  const record: RecordRef = { ranges: [[place.from, place.to]] }
  if (place.file) record.file = place.file
  return record
}

/** A line callback: `place` says where the line is. Returning `false` stops the read. */
export type OnLine = (line: string, place: LinePlace) => void | boolean

export interface LineTranslator {
  push(raw: string, place?: LinePlace): void
  snapshot(): Entry[]
  /** A line reached back before where this translator began: only a read from the record's start can place it. */
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
  /** The bytes just before `nextByte`, hashed, where the record is plain bytes and a line ended. */
  seal?: RecordSeal
}

/**
 * A record as one read left it: the file (`dev:ino`), and a hash of the
 * bytes before the last newline read. A record that still has them only
 * grew past them; one rewritten in place or replaced doesn't.
 */
export interface RecordSeal {
  identity: string
  from: number
  to: number
  sha256: string
}

/** Where a decode of a record can start again (`TurnPoint`), as of the record its seal names. */
export interface ResumePoint extends TurnPoint {
  seal: RecordSeal
}

/** A translator a read runs to the end: its entries, what it couldn't read, and where a later read can start again. */
export interface RecordTranslator extends LineTranslator {
  done(): Entry[]
  unread(): UnreadRecord[] | undefined
  readonly resume?: TurnPoint
}

/** One read of a record's lines through a translator. */
export interface RecordDecode {
  checkpoint: number
  entries: Entry[]
  unread?: UnreadRecord[]
  resume?: ResumePoint
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
  /** The head of a line too long to be a string, passed on when the line ends. */
  private cutHead: Buffer | undefined
  /** The last bytes seen, and the last before a newline consumed, with where those begin. */
  private recent: Buffer = Buffer.alloc(0)
  private sealed: { from: number; bytes: Buffer } | undefined
  private awaitingPrior: boolean
  private readonly onLine: OnLine
  private readonly strict: boolean
  private readonly file: string | undefined

  constructor(from: number, onLine: OnLine, strict: boolean, file?: string) {
    this.consumed = from
    this.reached = from
    this.awaitingPrior = from > 0
    this.onLine = onLine
    this.strict = strict
    this.file = file
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
            this.cut(segment)
          } else {
            this.carry.push(Buffer.from(segment))
            this.carryBytes += segment.length
          }
        }
        break
      }
      const nextByte = at + lineBreak + 1
      const segment = bytes.subarray(start, lineBreak)
      start = lineBreak + 1
      if (this.skipping && !this.cutHead) {
        this.skipping = false
        this.consumed = nextByte
        continue
      }
      if (!this.cutHead && this.carryBytes + segment.length > MAX_LINE_BYTES) {
        if (this.strict) throw new Error("Native evidence record exceeds the read limit")
        this.cut(segment)
      }
      const head = this.cutHead
      const line = head
        ? head.toString("utf8")
        : this.carryBytes === 0
          ? segment.toString("utf8")
          : Buffer.concat([...this.carry, segment], this.carryBytes + segment.length).toString("utf8")
      this.carry = []
      this.carryBytes = 0
      this.skipping = false
      this.cutHead = undefined
      const place: LinePlace = { from: this.consumed, to: nextByte }
      if (this.file) place.file = this.file
      if (head) place.cut = true
      this.consumed = nextByte
      if (this.onLine(line, place) === false) {
        this.keep(bytes, at, lineBreak + 1)
        return false
      }
    }
    this.keep(bytes, at, bytes.lastIndexOf(0x0a) + 1)
    this.reached = at + bytes.length
    return true
  }

  /** The bytes before the last newline consumed, at most `SEAL_BYTES` of them, from where this read began. */
  seal(): { from: number; bytes: Buffer } | undefined {
    return this.sealed && this.sealed.from + this.sealed.bytes.length === this.consumed ? this.sealed : undefined
  }

  /** Notes `bytes`, at `at`, for `seal`: `through` of them end at a newline. */
  private keep(bytes: Buffer, at: number, through: number): void {
    if (through > 0) {
      const own = bytes.subarray(Math.max(0, through - SEAL_BYTES), through)
      const lead = this.recent.subarray(Math.max(0, this.recent.length - (SEAL_BYTES - own.length)))
      const sealed = Buffer.concat([lead, own])
      this.sealed = { from: at + through - sealed.length, bytes: sealed }
    }
    this.recent = bytes.length >= SEAL_BYTES ? Buffer.from(bytes.subarray(bytes.length - SEAL_BYTES)) : Buffer.concat([this.recent, bytes]).subarray(-SEAL_BYTES)
  }

  /** Keeps the head of the line being read and skips the rest of it. */
  private cut(segment: Buffer): void {
    const held = Buffer.concat([...this.carry, segment.subarray(0, CUT_LINE_HEAD)])
    this.cutHead = Buffer.from(held.subarray(0, CUT_LINE_HEAD))
    this.carry = []
    this.carryBytes = 0
    this.skipping = true
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
  onLine: OnLine,
  evidence?: { identity: string; strict: true }
): Promise<LineRead> {
  return scanLines(path, fromByte, undefined, onLine, evidence ? { evidence } : {})
}

interface ScanOptions {
  evidence?: { identity: string; strict: true }
  /** The lines' file as their records name it, where it isn't the session's own (`recordFile`). */
  file?: string
  /** False where a file shrunk below `fromByte` is read no further: the read says `reset` and holds nothing. */
  restart?: boolean
  /** The file the read continues: one that replaced it since is read no further, and the read gives its identity. */
  identity?: string
}

/** The plain bytes a read of the whole lineage scans. */
async function lineageBytes(spans: readonly RecordSpan[]): Promise<number> {
  let total = 0
  for (const span of spans) {
    const bytes = (await statRecord(span.path))?.bytes ?? 0
    total += span.until === undefined ? bytes : Math.min(bytes, span.until)
  }
  return total
}

/** `readLineBatch` up to `until`. */
async function scanLines(
  path: string,
  fromByte: number,
  until: number | undefined,
  onLine: OnLine,
  { evidence, file, restart = true, identity: continues }: ScanOptions = {}
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
    if ((reset && !restart) || (continues !== undefined && continues !== identity)) return { nextByte: fromByte, reset, size, identity }
    const from = reset ? 0 : fromByte
    // A plain file ends where its stat said; a compressed one where its frames do.
    const end = plain ? Math.min(size, until ?? size) : (until ?? Number.MAX_SAFE_INTEGER)
    const lines = new LineSplitter(from, onLine, evidence?.strict === true, file)
    for await (const chunk of recordChunks(path, Math.max(0, from - 1), end, handle))
      if (!lines.feed(chunk)) break
    const read: LineRead = { nextByte: lines.consumed, reset, size: Math.max(size, lines.reached), identity }
    const sealed = plain ? lines.seal() : undefined
    if (sealed) read.seal = { identity, from: sealed.from, to: sealed.from + sealed.bytes.length, sha256: createHash("sha256").update(sealed.bytes).digest("hex") }
    return read
  } finally {
    await handle?.close()
  }
}

export async function readLines(
  path: string,
  fromByte: number,
  onLine: OnLine
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
 * A record's lines across its lineage, oldest stretch first. The result is
 * the read of the last span, the record's own file, whose offset a follower
 * continues from.
 */
export async function readLineage(spans: readonly RecordSpan[], onLine: OnLine, until?: number): Promise<LineRead> {
  const own = spans[spans.length - 1]
  if (!own) throw new Error("A lineage ends with the record's own file")
  for (const span of spans.slice(0, -1)) {
    const bytes = (await statRecord(span.path))?.bytes ?? 0
    const length = span.until === undefined ? bytes : Math.min(bytes, span.until)
    await scanLines(span.path, 0, length, onLine, { file: recordFile(own.path, span.path) })
  }
  return scanLines(own.path, 0, until, onLine)
}

/** `UnreadRecord`s of a record read in two parts, as one read of it counts them. */
export function mergeUnread(before: readonly UnreadRecord[] | undefined, after: readonly UnreadRecord[] | undefined): UnreadRecord[] | undefined {
  if (!before?.length) return after?.length ? [...after] : undefined
  if (!after?.length) return [...before]
  const merged = new Map(before.map((record) => [`${record.reason}\0${record.kind}`, { ...record }]))
  for (const record of after) {
    const key = `${record.reason}\0${record.kind}`
    const known = merged.get(key)
    if (known) known.count += record.count
    else merged.set(key, { ...record })
  }
  return [...merged.values()]
}

/** Whether `path` is still the record `seal` names, with the same bytes up to its end. */
export async function sealHolds(path: string, seal: RecordSeal): Promise<boolean> {
  if (recordEncoding(path) !== "plain") return false
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return false
  try {
    const info = await handle.stat()
    if (`${info.dev}:${info.ino}` !== seal.identity || info.size < seal.to) return false
    const bytes = Buffer.alloc(seal.to - seal.from)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, seal.from)
    return bytesRead === bytes.length && createHash("sha256").update(bytes).digest("hex") === seal.sha256
  } finally {
    await handle.close()
  }
}

/** What `into` made of `read`, continuing `from` when it began there. */
function decodeOf(read: LineRead, entries: Entry[], into: RecordTranslator, from: ResumePoint | undefined): RecordDecode {
  const decode: RecordDecode = { checkpoint: read.nextByte, entries }
  const unread = mergeUnread(from?.unread, into.unread())
  if (unread) decode.unread = unread
  const turn = into.resume
  const point: TurnPoint | undefined = turn
    ? { byte: turn.byte, entry: (from?.entry ?? 0) + turn.entry, ...turn.state !== undefined && { state: turn.state } }
    : from && { byte: from.byte, entry: from.entry, ...from.state !== undefined && { state: from.state } }
  if (point && read.seal) {
    const counted = turn ? mergeUnread(from?.unread, turn.unread) : from?.unread
    decode.resume = { ...point, ...counted && { unread: counted }, seal: read.seal }
  }
  return decode
}

/** A record read whole across its lineage through `into`. */
export async function decodeRecord(spans: readonly RecordSpan[], into: RecordTranslator, until?: number): Promise<RecordDecode> {
  const read = await readLineage(spans, (line, place) => into.push(line, place), until)
  return decodeOf(read, into.done(), into, undefined)
}

/**
 * A decode of `path` continued from `from` through `into`, a translator
 * begun after the entry before `from.entry`: the entries from there on. Null
 * when `path` isn't the record `from` was of, or a line since reaches back
 * before it.
 */
export async function decodeFrom(path: string, from: ResumePoint, into: RecordTranslator, until?: number): Promise<RecordDecode | null> {
  if (!(await sealHolds(path, from.seal))) return null
  const read = await scanLines(path, from.byte, until, (line, place) => into.push(line, place), { restart: false })
  if (read.reset || read.identity !== from.seal.identity) return null
  const entries = into.done()
  return into.needsReset ? null : decodeOf(read, entries, into, from)
}

/**
 * Where a follower takes over from a decode it was shown: the decode's
 * resume point, the id of the entry before it, and the entries the decode
 * held from there on. Its updates then count from `point.entry`.
 */
export interface FollowStart {
  point: ResumePoint
  after: string | undefined
  entries: readonly Entry[]
}

/**
 * Follow a record from `fromByte`, or from `start` where the follow takes
 * over from a decode: its first update is then what changed since that
 * decode, counted from `start.point.entry`. A reset re-reads the record
 * whole, across its lineage when it continues another record, so what it
 * shows is what the first read showed; past `next`'s `wholeLimit` it
 * reloads instead.
 */
export function createJsonlFollower(
  path: string,
  fromByte: number,
  createTranslator: (after?: string, state?: TurnState) => LineTranslator,
  lineage: () => Promise<readonly RecordSpan[]> = async () => [{ path }],
  start?: FollowStart
): SessionFollower {
  let parser = start ? createTranslator(start.after, start.point.state) : createTranslator()
  let cursor = start ? start.point.byte : fromByte
  let identity: string | null = null
  let synchronized = false
  /** The seal `start` was taken under, checked by the first read. */
  let unsealed = start?.point.seal
  try {
    const info = statSync(path)
    identity = `${info.dev}:${info.ino}`
  } catch {
    identity = null
  }
  const serializeEntries = (entries: readonly Entry[]): string[] =>
    entries.map((entry) => JSON.stringify(entry))
  let previousValues: string[] = []
  /** `start.entries` until the first update compares against them: a view holds an entry as JSON does, its keys perhaps in another order, so they compare by value as JSON. */
  let seeded = start?.entries

  const remember = (entries: Entry[]) => {
    previousValues = serializeEntries(entries)
  }
  const cloneEntries = (entries: Entry[]): Entry[] =>
    structuredClone(entries)

  return {
    get offset() {
      return cursor
    },
    async next(wholeLimit?: number): Promise<SessionUpdate> {
      const moved = unsealed !== undefined && (unsealed.identity !== identity || !(await sealHolds(path, unsealed)))
      unsealed = undefined
      let read = moved ? null : await scanLines(path, cursor, undefined, parser.push, identity === null ? { restart: false } : { restart: false, identity })
      if (!read || read.reset || (identity !== null && read.identity !== identity) || (!synchronized && parser.needsReset)) {
        const spans = await lineage()
        if (wholeLimit !== undefined && (await lineageBytes(spans)) >= wholeLimit) return { entries: [], nextByte: cursor, replace: false, reload: true }
        parser = createTranslator()
        read = await readLineage(spans, parser.push)
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
      if (seeded) {
        const before = seeded
        seeded = undefined
        let replaceFrom = 0
        while (replaceFrom < Math.min(before.length, current.length) && isDeepStrictEqual(before[replaceFrom], JSON.parse(JSON.stringify(current[replaceFrom])))) replaceFrom += 1
        remember(current)
        const appended = replaceFrom === before.length
        return appended
          ? { entries: cloneEntries(current.slice(replaceFrom)), nextByte: cursor, replace: false }
          : { entries: cloneEntries(current.slice(replaceFrom)), nextByte: cursor, replace: true, replaceFrom }
      }
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
