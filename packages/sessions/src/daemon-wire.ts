import { ReceivedRecordsSchema, ReceivingSessionSchema, RecordsLinkSchema, SentRecordsSchema, StagedRecordsSchema, type ReceivedRecords, type ReceivingSession, type RecordsLink, type SentRecords, type StagedRecords } from "./record-sync.js"
import { CopyScopeSchema, type CopyScope } from "./reading-copies.js"
import { StringDecoder } from "node:string_decoder"
import { z } from "zod"
import {
  ThreadRefSchema,
  UnreadRecordSchema,
} from "./thread-schema.js"
import { EntrySchema, type Entry } from "./entries.js"
import { EntryOriginalSchema, type EntryOriginal } from "./record-original.js"
import type {
  Thread,
  ThreadPage,
  ThreadRef,
  UnreadRecord,
} from "./format.js"
import { ChildTranscriptsSchema, type ChildTranscripts } from "./children.js"
import { KeptRestoreSchema, type KeptRestore } from "./kept-restore.js"
import { InstalledReadingSchema, type InstalledReading } from "./record-writers.js"

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
      stale?: boolean
      asOf?: number
    }
  | { id: number; op: "entry"; path: string; entry: string }
  | { id: number; op: "original"; path: string; entry: string }
  | { id: number; op: "children"; path: string }
  | { id: number; op: "hold"; path: string }
  /** `installed`: the version of the harness here, which the restore gate compares with the records' writers (`restoreGate`). */
  | { id: number; op: "restore"; path: string; installed?: string | InstalledReading | null }
  /** `reloads`: the client takes a `reload` event, where a follow would otherwise read a large session whole in the daemon. */
  | { id: number; op: "follow"; path: string; fromByte: number; reloads?: true }
  | { id: number; op: "unfollow"; path?: string }
  | { id: number; op: "retire" }
  /** Where the store's records are kept in step (`SessionCatalog.syncRecords`); null stops. */
  | { id: number; op: "records"; link: RecordsLink | null }
  /** Where this device's reading copies go (`SessionCatalog.syncCopies`); null stops them. */
  | { id: number; op: "copies"; link: RecordsLink | null }
  /** Which Sessions it keeps copies of, most wanted first (`SessionCatalog.scopeCopies`). */
  | { id: number; op: "copy-scope"; scope: CopyScope }
  /** Sends sessions' records to a remote store now (`SessionCatalog.sendRecords`). */
  | { id: number; op: "send-records"; link: RecordsLink; paths: string[] }
  /** Takes sessions' records from a remote store into their harnesses' stores here (`SessionCatalog.receiveRecords`). */
  | { id: number; op: "receive-records"; link: RecordsLink; sessions: ReceivingSession[]; installed: Record<string, InstalledReading | null> }
  /** Pulls sessions' records from a remote store into this one ahead of a move (`SessionCatalog.stageRecords`). */
  | { id: number; op: "stage-records"; link: RecordsLink; sessions: ReceivingSession[] }

export type DaemonResponseFrame =
  | {
      id: number
      ok: true
      result:
        | DaemonStats
        | ThreadRef[]
        | Thread
        | ThreadPage
        | Entry
        | EntryOriginal
        | ChildTranscripts
        | KeptRestore
        | SentRecords[]
        | ReceivedRecords[]
        | StagedRecords[]
        | boolean
        | null
    }
  | { id: number; ok: false; error: string }

export type DaemonEvent =
  | { event: "added" | "updated"; ref: ThreadRef }
  | { event: "removed"; path: string }
  | {
      event: "entries"
      path: string
      entries: Entry[]
      replace: boolean
      replaceFrom?: number
    }
  /** A follow that asked for `reloads` ended: page the session again and follow it from there. */
  | { event: "reload"; path: string }

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

interface EntryPending extends PendingBase {
  kind: "entry"
  resolve: (entry: Entry | null) => void
}

interface OriginalPending extends PendingBase {
  kind: "original"
  resolve: (original: EntryOriginal | null) => void
}

interface ChildrenPending extends PendingBase {
  kind: "children"
  resolve: (children: ChildTranscripts | null) => void
}

interface HoldPending extends PendingBase {
  kind: "hold"
  resolve: (held: boolean) => void
}

interface RestorePending extends PendingBase {
  kind: "restore"
  resolve: (restored: KeptRestore) => void
}

interface SendRecordsPending extends PendingBase {
  kind: "send-records"
  resolve: (sent: SentRecords[]) => void
}

interface ReceiveRecordsPending extends PendingBase {
  kind: "receive-records"
  resolve: (received: ReceivedRecords[]) => void
}

interface StageRecordsPending extends PendingBase {
  kind: "stage-records"
  resolve: (staged: StagedRecords[]) => void
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
  | EntryPending
  | OriginalPending
  | ChildrenPending
  | HoldPending
  | RestorePending
  | SendRecordsPending
  | ReceiveRecordsPending
  | StageRecordsPending
  | AckPending

export type ParsedDaemonResponse =
  | { kind: "ping"; pending: PingPending; result: DaemonStats }
  | { kind: "list"; pending: ListPending; result: ThreadRef[] }
  | { kind: "open"; pending: OpenPending; result: Thread | null }
  | { kind: "page"; pending: PagePending; result: ThreadPage | null }
  | { kind: "entry"; pending: EntryPending; result: Entry | null }
  | { kind: "original"; pending: OriginalPending; result: EntryOriginal | null }
  | { kind: "children"; pending: ChildrenPending; result: ChildTranscripts | null }
  | { kind: "hold"; pending: HoldPending; result: boolean }
  | { kind: "restore"; pending: RestorePending; result: KeptRestore }
  | { kind: "send-records"; pending: SendRecordsPending; result: SentRecords[] }
  | { kind: "receive-records"; pending: ReceiveRecordsPending; result: ReceivedRecords[] }
  | { kind: "stage-records"; pending: StageRecordsPending; result: StagedRecords[] }
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
      const stale = readBoolean(record, "stale")
      return path ? { id, op, path, before, limit, toolOutput, maxChars, preview, stale } : null
    }
    case "entry":
    case "original": {
      const path = readString(record, "path")
      const entry = readString(record, "entry")
      return path && entry ? { id, op, path, entry } : null
    }
    case "children":
    case "hold": {
      const path = readString(record, "path")
      return path ? { id, op, path } : null
    }
    case "restore": {
      const path = readString(record, "path")
      if (!path) return null
      const reading = InstalledReadingSchema.safeParse(record.installed)
      const installed = record.installed === null ? null : reading.success ? reading.data : readString(record, "installed")
      return installed === undefined ? { id, op, path } : { id, op, path, installed }
    }
    case "follow": {
      const path = readString(record, "path")
      const fromByte = readNumber(record, "fromByte")
      if (!path || fromByte === undefined || fromByte < 0) return null
      return readBoolean(record, "reloads") === true ? { id, op, path, fromByte, reloads: true } : { id, op, path, fromByte }
    }
    case "unfollow":
      return { id, op, path: readString(record, "path") }
    case "retire":
      return { id, op }
    case "records": {
      if (record.link === null) return { id, op, link: null }
      const link = RecordsLinkSchema.safeParse(record.link)
      return link.success ? { id, op, link: link.data } : null
    }
    case "copies": {
      if (record.link === null) return { id, op, link: null }
      const link = RecordsLinkSchema.safeParse(record.link)
      return link.success ? { id, op, link: link.data } : null
    }
    case "copy-scope": {
      const scope = CopyScopeSchema.safeParse(record.scope)
      return scope.success ? { id, op, scope: scope.data } : null
    }
    case "send-records": {
      const parsed = z.object({ link: RecordsLinkSchema, paths: z.array(z.string().min(1)) }).safeParse(record)
      return parsed.success ? { id, op, ...parsed.data } : null
    }
    case "receive-records": {
      const parsed = z.object({
        link: RecordsLinkSchema,
        sessions: z.array(ReceivingSessionSchema),
        installed: z.record(z.string(), InstalledReadingSchema.nullable()),
      }).safeParse(record)
      return parsed.success ? { id, op, ...parsed.data } : null
    }
    case "stage-records": {
      const parsed = z.object({ link: RecordsLinkSchema, sessions: z.array(ReceivingSessionSchema) }).safeParse(record)
      return parsed.success ? { id, op, ...parsed.data } : null
    }
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
    case "entry": {
      if (record.result === null) return { kind: "entry", pending, result: null }
      const result = EntrySchema.safeParse(record.result)
      return result.success ? { kind: "entry", pending, result: result.data } : null
    }
    case "original": {
      if (record.result === null) return { kind: "original", pending, result: null }
      const result = EntryOriginalSchema.safeParse(record.result)
      return result.success ? { kind: "original", pending, result: result.data } : null
    }
    case "children": {
      if (record.result === null) return { kind: "children", pending, result: null }
      const result = ChildTranscriptsSchema.safeParse(record.result)
      return result.success ? { kind: "children", pending, result: result.data } : null
    }
    case "hold": {
      const result = readBoolean(record, "result")
      return result === undefined ? null : { kind: "hold", pending, result }
    }
    case "restore": {
      const result = KeptRestoreSchema.safeParse(record.result)
      return result.success ? { kind: "restore", pending, result: result.data } : null
    }
    case "send-records": {
      const result = z.array(SentRecordsSchema).safeParse(record.result)
      return result.success ? { kind: "send-records", pending, result: result.data } : null
    }
    case "receive-records": {
      const result = z.array(ReceivedRecordsSchema).safeParse(record.result)
      return result.success ? { kind: "receive-records", pending, result: result.data } : null
    }
    case "stage-records": {
      const result = z.array(StagedRecordsSchema).safeParse(record.result)
      return result.success ? { kind: "stage-records", pending, result: result.data } : null
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
    case "removed":
    case "reload": {
      const path = readString(record, "path")
      return path ? { event, path } : null
    }
    case "entries": {
      const path = readString(record, "path")
      const entries = parseArray(record.entries, parseEntry)
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
  const entries = parseArray(value.entries, parseEntry)
  if (!ref || !entries) return null
  const result: Thread = { ref, entries }
  const checkpoint = readNumber(value, "checkpoint")
  if (checkpoint !== undefined) result.checkpoint = checkpoint
  const unread = parseUnread(value.unread)
  if (unread) result.unread = unread
  return result
}

function parseUnread(value: JsonValue | undefined): UnreadRecord[] | undefined {
  const parsed = z.array(UnreadRecordSchema).safeParse(value)
  return parsed.success && parsed.data.length ? parsed.data : undefined
}

function parseThreadPage(value: JsonValue | undefined): ThreadPage | null {
  if (!isJsonRecord(value)) return null
  const ref = parseThreadRef(value.ref)
  const entries = parseArray(value.entries, parseEntry)
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
  const unread = parseUnread(value.unread)
  if (unread) result.unread = unread
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

function parseEntry(value: JsonValue): Entry | null {
  const parsed = EntrySchema.safeParse(value)
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
