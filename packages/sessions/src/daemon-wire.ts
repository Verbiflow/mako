import { StringDecoder } from "node:string_decoder"
import {
  EntryBlockSchema,
  ThreadEntrySchema,
  ThreadRefSchema,
} from "./thread-schema.js"
import type {
  EntryBlock,
  Thread,
  ThreadEntry,
  ThreadPage,
  ThreadRef,
} from "./format.js"

/**
 * Splits a socket's chunks into NDJSON lines, scanning each chunk once.
 *
 * The first version appended every chunk to one string and searched and
 * measured the whole string again: a 7 MB thread arriving in 64 KB pieces
 * was rescanned a hundred times over, and a frame the loopback socket
 * carries in ten milliseconds took 2.7 s to assemble. Pieces are kept apart
 * until a newline arrives and joined once; the pending byte count is a
 * running total, so the frame limit costs nothing per chunk.
 */
export class LineAssembler {
  private readonly parts: string[] = []
  private readonly decoder = new StringDecoder("utf8")
  /** Bytes of the line still being assembled. */
  pendingBytes = 0

  constructor(private readonly limit: number) {}

  /** Complete lines in this chunk, or `null` once the pending line exceeds the limit. */
  push(chunk: Buffer): string[] | null {
    let text = this.decoder.write(chunk)
    let at = text.indexOf("\n")
    if (at === -1) {
      this.pendingBytes += chunk.length
      if (this.pendingBytes > this.limit) return null
      this.parts.push(text)
      return []
    }
    const lines: string[] = []
    while (at !== -1) {
      const head = text.slice(0, at)
      this.pendingBytes += Buffer.byteLength(head)
      if (this.pendingBytes > this.limit) return null
      if (this.parts.length) {
        this.parts.push(head)
        lines.push(this.parts.join(""))
        this.parts.length = 0
      } else lines.push(head)
      this.pendingBytes = 0
      text = text.slice(at + 1)
      at = text.indexOf("\n")
    }
    if (text) {
      this.pendingBytes = Buffer.byteLength(text)
      if (this.pendingBytes > this.limit) return null
      this.parts.push(text)
    }
    return lines
  }
}

export interface DaemonStats {
  pid: number
  startedAt: number
  sessions: number
  version: number
  /** The entry script this daemon runs; a client from another build retires it. */
  script?: string
  /** Reader code, native roots, archive and runtime identity. */
  catalogIdentity?: string
  /** The Node runtime executing that script. */
  runtime?: string
  rss?: number
  heapUsed?: number
  eventLoopP99Ms?: number
  clients?: number
  fullScans?: number
  watchers?: number
  observations?: number
  cpuUserMicros?: number
  cpuSystemMicros?: number
}

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

export interface JsonRecord {
  [key: string]: JsonValue | undefined
}

export type DaemonRequestFrame =
  | { id: number; op: "ping" }
  | { id: number; op: "list"; cwd?: string; harness?: string }
  | { id: number; op: "open"; path: string }
  | {
      id: number
      op: "page"
      path: string
      before?: number
      limit?: number
      toolOutput?: number
      maxChars?: number
      preview?: boolean
    }
  | { id: number; op: "block"; path: string; entry: number; block: number }
  | { id: number; op: "follow"; path: string; fromByte: number }
  | { id: number; op: "unfollow"; path?: string }
  | { id: number; op: "retire" }

export type DaemonResponseFrame =
  | {
      id: number
      ok: true
      result:
        | DaemonStats
        | ThreadRef[]
        | Thread
        | ThreadPage
        | EntryBlock
        | null
    }
  | { id: number; ok: false; error: string }

export type DaemonEvent =
  | { event: "added" | "updated"; ref: ThreadRef }
  | { event: "removed"; path: string }
  | {
      event: "entries"
      path: string
      entries: ThreadEntry[]
      replace: boolean
      replaceFrom?: number
    }

type DaemonServerFrame = DaemonResponseFrame | DaemonEvent

interface PendingBase {
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PingPending extends PendingBase {
  kind: "ping"
  resolve: (stats: DaemonStats) => void
}

interface ListPending extends PendingBase {
  kind: "list"
  resolve: (refs: ThreadRef[]) => void
}

interface OpenPending extends PendingBase {
  kind: "open"
  resolve: (thread: Thread | null) => void
}

interface PagePending extends PendingBase {
  kind: "page"
  resolve: (page: ThreadPage | null) => void
}

interface BlockPending extends PendingBase {
  kind: "block"
  resolve: (block: EntryBlock | null) => void
}

interface AckPending extends PendingBase {
  kind: "ack"
  resolve: () => void
}

export type PendingRequest =
  | PingPending
  | ListPending
  | OpenPending
  | PagePending
  | BlockPending
  | AckPending

export type ParsedDaemonResponse =
  | { kind: "ping"; pending: PingPending; result: DaemonStats }
  | { kind: "list"; pending: ListPending; result: ThreadRef[] }
  | { kind: "open"; pending: OpenPending; result: Thread | null }
  | { kind: "page"; pending: PagePending; result: ThreadPage | null }
  | { kind: "block"; pending: BlockPending; result: EntryBlock | null }
  | { kind: "ack"; pending: AckPending }
  | { kind: "error"; pending: PendingRequest; error: Error }

export function serializeDaemonFrame(
  frame: DaemonRequestFrame | DaemonServerFrame
): string {
  return `${JSON.stringify(frame)}\n`
}

export function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    const value: JsonValue = JSON.parse(raw)
    return isJsonRecord(value) ? value : null
  } catch {
    return null
  }
}

export function readDaemonFrameId(record: JsonRecord): number | undefined {
  return readNumber(record, "id")
}

export function parseDaemonRequest(raw: string): DaemonRequestFrame | null {
  const record = parseJsonRecord(raw)
  if (!record) return null
  const id = readNumber(record, "id")
  const op = readString(record, "op")
  if (id === undefined || !Number.isInteger(id) || id < 0 || !op) return null
  switch (op) {
    case "ping":
      return { id, op }
    case "list":
      return {
        id,
        op,
        cwd: readString(record, "cwd"),
        harness: readString(record, "harness"),
      }
    case "open": {
      const path = readString(record, "path")
      return path ? { id, op, path } : null
    }
    case "page": {
      const path = readString(record, "path")
      const before = readNumber(record, "before")
      const limit = readNumber(record, "limit")
      const toolOutput = readNumber(record, "toolOutput")
      const maxChars = readNumber(record, "maxChars")
      const preview = readBoolean(record, "preview")
      return path ? { id, op, path, before, limit, toolOutput, maxChars, preview } : null
    }
    case "block": {
      const path = readString(record, "path")
      const entry = readNumber(record, "entry")
      const block = readNumber(record, "block")
      return path &&
        entry !== undefined &&
        Number.isInteger(entry) &&
        entry >= 0 &&
        block !== undefined &&
        Number.isInteger(block) &&
        block >= 0
        ? { id, op, path, entry, block }
        : null
    }
    case "follow": {
      const path = readString(record, "path")
      const fromByte = readNumber(record, "fromByte")
      return path && fromByte !== undefined && fromByte >= 0
        ? { id, op, path, fromByte }
        : null
    }
    case "unfollow":
      return { id, op, path: readString(record, "path") }
    case "retire":
      return { id, op }
    default:
      return null
  }
}

export function parseDaemonResponse(
  record: JsonRecord,
  pending: PendingRequest
): ParsedDaemonResponse | null {
  const ok = readBoolean(record, "ok")
  if (ok === false) {
    return {
      kind: "error",
      pending,
      error: new Error(readString(record, "error") ?? "daemon error"),
    }
  }
  if (ok !== true) return null
  switch (pending.kind) {
    case "ping": {
      const result = parseDaemonStats(record.result)
      return result ? { kind: "ping", pending, result } : null
    }
    case "list": {
      const result = parseArray(record.result, parseThreadRef)
      return result ? { kind: "list", pending, result } : null
    }
    case "open": {
      if (record.result === null) return { kind: "open", pending, result: null }
      const result = parseThread(record.result)
      return result ? { kind: "open", pending, result } : null
    }
    case "page": {
      if (record.result === null) return { kind: "page", pending, result: null }
      const result = parseThreadPage(record.result)
      return result ? { kind: "page", pending, result } : null
    }
    case "block": {
      if (record.result === null)
        return { kind: "block", pending, result: null }
      const result = EntryBlockSchema.safeParse(record.result)
      return result.success
        ? { kind: "block", pending, result: result.data }
        : null
    }
    case "ack":
      return record.result === null ? { kind: "ack", pending } : null
  }
}

export function parseDaemonEvent(record: JsonRecord): DaemonEvent | null {
  const event = readString(record, "event")
  switch (event) {
    case "added":
    case "updated": {
      const ref = parseThreadRef(record.ref)
      return ref ? { event, ref } : null
    }
    case "removed": {
      const path = readString(record, "path")
      return path ? { event, path } : null
    }
    case "entries": {
      const path = readString(record, "path")
      const entries = parseArray(record.entries, parseThreadEntry)
      const replace = readBoolean(record, "replace")
      if (!path || !entries || replace === undefined) return null
      const frame: DaemonEvent = { event, path, entries, replace }
      const replaceFrom = readNumber(record, "replaceFrom")
      if (replaceFrom !== undefined) frame.replaceFrom = replaceFrom
      return frame
    }
    default:
      return null
  }
}

function parseDaemonStats(value: JsonValue | undefined): DaemonStats | null {
  if (!isJsonRecord(value)) return null
  const pid = readNumber(value, "pid")
  const startedAt = readNumber(value, "startedAt")
  const sessions = readNumber(value, "sessions")
  const version = readNumber(value, "version")
  if (
    pid === undefined ||
    startedAt === undefined ||
    sessions === undefined ||
    version === undefined
  )
    return null
  const result: DaemonStats = { pid, startedAt, sessions, version }
  const script = readString(value, "script")
  const runtime = readString(value, "runtime")
  if (script !== undefined) result.script = script
  const catalogIdentity = readString(value, "catalogIdentity")
  if (catalogIdentity !== undefined) result.catalogIdentity = catalogIdentity
  if (runtime !== undefined) result.runtime = runtime
  const rss = readNumber(value, "rss")
  const heapUsed = readNumber(value, "heapUsed")
  const eventLoopP99Ms = readNumber(value, "eventLoopP99Ms")
  if (rss !== undefined) result.rss = rss
  if (heapUsed !== undefined) result.heapUsed = heapUsed
  if (eventLoopP99Ms !== undefined) result.eventLoopP99Ms = eventLoopP99Ms
  for (const key of ["clients", "fullScans", "watchers", "observations", "cpuUserMicros", "cpuSystemMicros"] as const) {
    const metric = readNumber(value, key)
    if (metric !== undefined && metric >= 0) result[key] = metric
  }
  return result
}

function parseThread(value: JsonValue | undefined): Thread | null {
  if (!isJsonRecord(value)) return null
  const ref = parseThreadRef(value.ref)
  const entries = parseArray(value.entries, parseThreadEntry)
  if (!ref || !entries) return null
  const result: Thread = { ref, entries }
  const checkpoint = readNumber(value, "checkpoint")
  if (checkpoint !== undefined) result.checkpoint = checkpoint
  return result
}

function parseThreadPage(value: JsonValue | undefined): ThreadPage | null {
  if (!isJsonRecord(value)) return null
  const ref = parseThreadRef(value.ref)
  const entries = parseArray(value.entries, parseThreadEntry)
  const start = readNumber(value, "start")
  const total = readNumber(value, "total")
  const hasEarlier = readBoolean(value, "hasEarlier")
  if (
    !ref ||
    !entries ||
    start === undefined ||
    total === undefined ||
    hasEarlier === undefined
  )
    return null
  const result: ThreadPage = { ref, entries, start, total, hasEarlier }
  const checkpoint = readNumber(value, "checkpoint")
  if (checkpoint !== undefined) result.checkpoint = checkpoint
  const translator = readString(value, "translator")
  if (translator !== undefined) result.translator = translator
  if (readBoolean(value, "preview")) result.preview = true
  return result
}

/**
 * Every field of a ref crosses the wire. A hand-written reader here once
 * listed the fields it knew and silently dropped `settings`, `identity` and
 * `liveResume`: a catalog served from the worker showed "Reasoning not
 * reported" for every Codex thread and collapsed Cursor's forked stores.
 */
function parseThreadRef(value: JsonValue | undefined): ThreadRef | null {
  const parsed = ThreadRefSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseThreadEntry(value: JsonValue): ThreadEntry | null {
  const parsed = ThreadEntrySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseArray<T>(
  value: JsonValue | undefined,
  parse: (item: JsonValue) => T | null
): T[] | null {
  if (!Array.isArray(value)) return null
  const parsed: T[] = []
  for (const item of value) {
    const result = parse(item)
    if (result === null) return null
    parsed.push(result)
  }
  return parsed
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isStringValue(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBooleanValue(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return isStringValue(value) ? value : undefined
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

function readBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key]
  return isBooleanValue(value) ? value : undefined
}
