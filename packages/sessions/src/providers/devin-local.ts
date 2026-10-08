import { z } from "zod"
import { AcpSavedTurns, acpSavedNotification, acpSavedRefusal, SavedAcpUpdateSchema } from "../acp-saved-turns.js"
import { acpAttachments, acpText } from "../acp-tool-details.js"
import { DEVIN_ACP_HOOKS } from "../harnesses/devin.js"
/**
 * Devin IDE journals: the per-session SQLite message store, and the ACP
 * NDJSON the IDE wrote before it. Both keep the ACP updates Devin sent, read
 * as a locator through the hooks the live client runs (`DEVIN_ACP_HOOKS`).
 * Native session identity comes from the editor's message-store index, never
 * the database's random filename. SQLite snapshots are replaceable, not
 * byte-tail journals. Devin.app 3.10 deletes `acp-events` when it starts,
 * without moving those sessions into the SQLite store, so one session never
 * has both and an NDJSON session lives on only in the catalog's archive.
 */

import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite"
import { openNativeStore, openReadOnly } from "../read-only-sqlite.js"
import { placeholders, tableColumns, type RecordDatabase, type SessionRecords } from "../harness-records.js"
import {
  agentTitleFrom,
  titleFrom,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
  type UnreadRecord,
} from "../format.js"
import {
  createJsonlFollower,
  readLines,
  type LineTranslator,
} from "../jsonl.js"
import { SessionUnreadable, type NativeFile, type SessionProvider } from "./types.js"

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

type SqliteStatementResult = ReturnType<StatementSync["get"]>
const StoredMessage = z.object({ position: z.number().int().nonnegative(), kind: z.string(), payload: z.string(), characters: z.number().int().nonnegative() })
const MESSAGE_CHARACTER_LIMIT = 4_000_000
const StoredIndex = z.object({ key: z.string(), value: z.string() })
/** How deep a run's `childMessages` may nest: a subagent's own subagent, and a little room. */
const MAX_NESTED_RUNS = 8

/**
 * The ACP notifications one stored message holds, as Devin 3.10.23 (schema 6)
 * keeps them; schema 1 keeps the first two shapes. User, agent and thought
 * messages keep a list. A tool call keeps the call as it last stood, and a
 * plan its entries. A scripted or workflow run nests the messages it made in
 * `childMessages`, which live draws inline, so they read where the run
 * started. A subagent nests its own session's messages, which live keeps out
 * of its parent's (`DevinAgents`); its `run_subagent` call is the parent's row.
 * `unread` names a kind it can't read, which must not vanish.
 */
interface StoredNotifications {
  notifications: JsonRecord[]
  unread?: string
}

function storedNotifications(kind: string, message: JsonRecord, depth = 0): StoredNotifications {
  const content = message.content
  switch (kind) {
    case "tool_call":
      return { notifications: isJsonRecord(content) ? [{ ...content, sessionUpdate: "tool_call" }] : [] }
    case "plan":
      return { notifications: isJsonRecord(content) ? [{ ...content, sessionUpdate: "plan" }] : [] }
    case "subagent":
      return { notifications: [] }
    case "scripted_run":
    case "workflow_run": {
      const notifications: JsonRecord[] = []
      let unread: string | undefined
      const children = message.childMessages
      for (const child of isJsonArray(children) && depth < MAX_NESTED_RUNS ? children : []) {
        if (!isJsonRecord(child)) continue
        const nested = storedNotifications(readString(child, "kind") ?? "", child, depth + 1)
        notifications.push(...nested.notifications)
        unread ??= nested.unread
      }
      return unread ? { notifications, unread } : { notifications }
    }
    // Timestamps drawn from the notifications beside it; Devin shows nothing for one.
    case "progress_marker":
      return { notifications: [] }
    default:
      return isJsonArray(content) ? { notifications: content.filter(isJsonRecord) } : { notifications: [], unread: kind || "unnamed" }
  }
}


interface StateValueRow {
  value: string
}

let sqliteOpen: ((path: string) => DatabaseSync) | null | undefined

async function openDatabase(path: string): Promise<DatabaseSync | null> {
  if (sqliteOpen === undefined) {
    try {
      await import("node:sqlite")
      sqliteOpen = (file) => openNativeStore(file)
    } catch {
      sqliteOpen = null
    }
  }
  if (!sqliteOpen) return null
  try {
    return sqliteOpen(path)
  } catch {
    return null
  }
}

interface SessionMeta {
  sessionId: string
  title?: string
  cwd?: string
  model?: string
  createdAt?: string
  updatedAt?: string
}

interface EventLogEntry {
  uuid: string
  lastUpdated?: number
}

interface CachedSession {
  sessionId: string
  title?: string
  cwd?: string
  model?: string
  createdAt?: string
}

interface SessionCache {
  sessions: CachedSession[]
}

interface DevinTranslator extends LineTranslator {
  done(): ThreadEntry[]
  readonly title?: string
  /** A record history leaves out: past the read limit, or of a `kind` it can't read, kept as `sample`. */
  unavailable(position: number, kind?: string, sample?: JsonRecord): void
  /** The records it couldn't draw, by kind. */
  unread(): UnreadRecord[] | undefined
}

export class DevinLocalProvider implements SessionProvider {
  harness = "devin" as const
  displayName = "Devin"
  peekVersion = 2

  private userDir: string
  /** uuid (journal basename) → session metadata, refreshed by db mtime. */
  private metaByUuid = new Map<string, SessionMeta>()
  private metaLoadedAtMs = 0

  constructor(
    userDir = join(homedir(), "Library", "Application Support", "Devin", "User")
  ) {
    this.userDir = userDir
  }

  roots(): string[] {
    return [join(this.userDir, "acp-events"), join(this.userDir, "acp-messages")]
  }

  observationPaths(path: string): string[] {
    return path.endsWith(".db") ? [path, `${path}-wal`, `${path}-shm`] : [path]
  }

  watchTarget(path: string): string | null {
    const target = path.replace(/-(?:wal|shm)$/, "")
    return /\.(?:db|ndjson)$/.test(target) ? target : null
  }

  async stat(path: string): Promise<NativeFile | null> {
    const stamps = await Promise.all(this.observationPaths(path).map((file) => stat(file).catch(() => null)))
    if (!stamps[0]?.isFile()) return null
    return {
      path,
      bytes: stamps.reduce((total, stamp) => total + (stamp?.size ?? 0), 0),
      mtimeMs: Math.max(...stamps.map((stamp) => stamp?.mtimeMs ?? 0)),
      revision: stamps.map((stamp) => stamp ? `${stamp.size}:${stamp.mtimeMs}` : "missing").join("/"),
    }
  }

  async discover(): Promise<NativeFile[]> {
    const files: NativeFile[] = []
    for (const root of this.roots()) {
      const names = await readdir(root).catch(() => new Array<string>())
      for (const name of names) {
        if (!/\.(?:db|ndjson)$/.test(name)) continue
        const file = await this.stat(join(root, name))
        if (file) files.push(file)
      }
    }
    return files
  }

  /**
   * The journal (a session's own database, or its NDJSON event log before
   * 3.10) and the two keys Devin.app keeps for it in its state database: the
   * message store entry naming the journal and the session's info.
   */
  async records(path: string): Promise<SessionRecords | null> {
    if (!this.roots().includes(dirname(path)) || !(await stat(path).catch(() => null))?.isFile()) return null
    const databases: RecordDatabase[] = []
    if (path.endsWith(".db")) databases.push({ path, tables: [...tableColumns(path).keys()].map((table) => ({ table })) })
    else if (!path.endsWith(".ndjson")) return null
    const state = join(this.userDir, "globalStorage", "state.vscdb")
    const keys = stateKeysOf(state, journalOf(path))
    if (keys.length) databases.push({ path: state, tables: [{ table: "ItemTable", where: `key IN (${placeholders(keys)})`, params: keys }] })
    return { files: path.endsWith(".ndjson") ? [path] : [], databases }
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const meta = await this.metaFor(journalOf(file.path))
    // The IDE names sessions "acp/devin-cli/<name>"; the CLI's own store
    // says just "<name>". One session, one identity — normalized here so
    // the catalog's dedupe collapses the two views of the same thread.
    const rawId = meta?.sessionId ?? journalOf(file.path)
    const ref: ThreadRef = {
      harness: this.harness,
      nativeId: rawId.split("/").pop() ?? rawId,
      path: file.path,
      cwd: meta?.cwd,
      title: agentTitleFrom(meta?.title),
      model: meta?.model,
      modelProvider: "devin",
      startedAt: meta?.createdAt,
      updatedAt: meta?.updatedAt ?? new Date(file.mtimeMs).toISOString(),
      bytes: file.bytes,
      // Devin.app runs local sessions through Devin's CLI, whose store keeps
      // what the journal lacks: prompts until a reopen, and what a reopen's
      // replay drops.
      clientCopy: true,
    }
    if (!ref.title || !ref.startedAt) {
      // No metadata (or a stale cache): the journal's own first lines carry
      // a title update and the first user words. Bounded read.
      const skim = translator(journalOf(file.path))
      let budget = 64_000
      const consume = (line: string) => {
        budget -= line.length + 1
        skim.push(line)
        return budget > 0
      }
      if (file.path.endsWith(".db")) await this.readMessages(file.path, consume, true)
      else await readLines(file.path, 0, consume)
      const entries = skim.done()
      const first = entries.find((entry) => entry.kind === "user")
      if (!ref.title && skim.title) ref.title = agentTitleFrom(skim.title)
      if (!ref.title) {
        for (const entry of entries) {
          if (entry.kind !== "user") continue
          ref.title = titleFrom(entry.text)
          if (ref.title) break
        }
      }
      if (!ref.startedAt && first?.at) ref.startedAt = first.at
    }
    return ref
  }

  async read(path: string): Promise<Thread | null> {
    const info = await stat(path).catch(() => null)
    if (!info) return null
    const ref = await this.peek({
      path,
      bytes: info.size,
      mtimeMs: info.mtimeMs,
    })
    if (!ref) return null
    const into = translator(journalOf(path))
    const checkpoint = path.endsWith(".db")
      ? await this.readMessages(path, into.push, false, into.unavailable)
      : await readLines(path, 0, into.push)
    const thread: Thread = { ref, checkpoint, entries: into.done() }
    if (!ref.title && into.title) ref.title = agentTitleFrom(into.title)
    const unread = into.unread()
    if (unread) thread.unread = unread
    return thread
  }

  createFollower(path: string, fromByte: number) {
    return path.endsWith(".db") ? null : createJsonlFollower(path, fromByte, () => translator(journalOf(path)))
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    if (path.endsWith(".db")) return { entries: [], nextByte: fromByte }
    const into = translator(journalOf(path))
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }

  private async readMessages(path: string, push: (raw: string) => void | boolean, skim = false, unavailable?: DevinTranslator["unavailable"]): Promise<number> {
    const db = await openDatabase(path)
    if (!db) throw new SessionUnreadable(path)
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value
      if (version !== "1" && version !== "6") throw new Error("Unsupported Devin IDE message-store schema")
      let next = 0
      const rows = db.prepare(`SELECT position, kind, length(payload) AS characters, substr(payload, 1, ${skim ? 64000 : MESSAGE_CHARACTER_LIMIT}) AS payload FROM messages ORDER BY position${skim ? " LIMIT 128" : ""}`)
      for (const candidate of rows.iterate()) {
        const row = StoredMessage.parse(candidate)
        const raw = row.payload
        next = row.position + 1
        if (row.characters > (skim ? 64000 : MESSAGE_CHARACTER_LIMIT)) {
          unavailable?.(row.position)
          continue
        }
        const payload = parseJson(raw)
        if (!isJsonRecord(payload)) continue
        const stored = storedNotifications(row.kind, payload)
        let stopped = false
        for (const notification of stored.notifications) {
          if (push(JSON.stringify({ notification })) === false) { stopped = true; break }
        }
        if (stopped) break
        if (stored.unread) unavailable?.(row.position, stored.unread, payload)
      }
      return next
    } catch (cause) {
      throw new SessionUnreadable(path, { cause })
    } finally { db.close() }
  }

  async recent(path: string, bytes: number): Promise<ThreadEntry[] | null> {
    if (path.endsWith(".db")) return null
    const info = await stat(path).catch(() => null)
    if (!info || info.size <= bytes) return null
    return (await this.tail(path, info.size - bytes)).entries
  }

  /* ---------------------------------------------------------- metadata */

  private async metaFor(uuid: string): Promise<SessionMeta | null> {
    await this.refreshMeta()
    return this.metaByUuid.get(uuid) ?? null
  }

  private async refreshMeta(): Promise<void> {
    const dbPath = join(this.userDir, "globalStorage", "state.vscdb")
    const info = await stat(dbPath).catch(() => null)
    const wal = await stat(`${dbPath}-wal`).catch(() => null)
    const changedAt = Math.max(info?.mtimeMs ?? 0, wal?.mtimeMs ?? 0)
    if (!info || changedAt === this.metaLoadedAtMs) return
    const db = await openDatabase(dbPath)
    if (!db) return
    try {
      const statement = db.prepare("SELECT value FROM ItemTable WHERE key = ?")
      const row = (key: string): StateValueRow | null =>
        parseStateValueRow(statement.get(key))
      const indexRaw = row("windsurf.acp.eventLog.index")?.value
      const metaRaw = row("windsurf.acp.metadataCache")?.value
      const index = (indexRaw && parseEventLogIndex(indexRaw)) || new Map<string, EventLogEntry>()
      const cache = (metaRaw && parseSessionCache(metaRaw)) || { sessions: [] }
      for (const candidate of db.prepare(`SELECT key, value FROM ItemTable WHERE key LIKE '${MESSAGE_STORE_KEY}%'`).iterate()) {
        const fields = StoredIndex.parse(candidate)
        const entry = parseJson(fields.value)
        if (!isJsonRecord(entry)) continue
        const uuid = readString(entry, "uuid")
        const sessionId = fields.key.slice(MESSAGE_STORE_KEY.length)
        if (uuid) index.set(sessionId, { uuid, lastUpdated: readNumber(entry, "lastUpdated") })
        const current = row(`windsurf.acp.sessioninfo.session.${sessionId}`)?.value
        const record = current && parseJson(current)
        const session = isJsonRecord(record) ? record.info : undefined
        if (!isJsonRecord(session)) { cache.sessions.push({ sessionId }); continue }
        cache.sessions.push({
          sessionId,
          title: readString(session, "title"),
          cwd: readString(session, "cwd"),
          createdAt: parseCreatedAt(session._meta),
          model: parseConfiguredModel(session.configOptions),
        })
      }
      const bySession = new Map<string, SessionMeta>()
      for (const session of cache.sessions) {
        bySession.set(session.sessionId, {
          sessionId: session.sessionId,
          title: session.title,
          cwd: session.cwd,
          model: session.model,
          createdAt: session.createdAt,
        })
      }
      this.metaByUuid.clear()
      for (const [sessionId, entry] of index) {
        const meta = bySession.get(sessionId) ?? { sessionId }
        if (entry.lastUpdated)
          meta.updatedAt = new Date(entry.lastUpdated).toISOString()
        this.metaByUuid.set(entry.uuid, meta)
      }
      this.metaLoadedAtMs = changedAt
    } catch {
      // A malformed cache reads as no metadata; peeks fall back to the journal.
    } finally {
      db.close()
    }
  }
}

/* -------------------------------------------------------------- events */

function journalOf(path: string): string {
  return basename(path).replace(/\.(?:ndjson|db)$/, "")
}

const MESSAGE_STORE_KEY = "windsurf.acp.messageStore.session."

/** The state keys of the session whose message store names journal `uuid`. */
function stateKeysOf(state: string, uuid: string): string[] {
  if (!existsSync(state)) return []
  const { database } = openReadOnly(state, { timeout: 5_000 })
  try {
    for (const candidate of database.prepare(`SELECT key, value FROM ItemTable WHERE key LIKE '${MESSAGE_STORE_KEY}%'`).iterate()) {
      const fields = StoredIndex.parse(candidate)
      const entry = parseJson(fields.value)
      if (!isJsonRecord(entry) || readString(entry, "uuid") !== uuid) continue
      const sessionId = fields.key.slice(MESSAGE_STORE_KEY.length)
      return [fields.key, `windsurf.acp.sessioninfo.session.${sessionId}`]
    }
    return []
  } finally {
    database.close()
  }
}

/** A saved line: `{ notification }`, as the NDJSON journal keeps it and `readMessages` passes a row on. */
const SavedLineSchema = z.object({ notification: SavedAcpUpdateSchema.extend({ content: z.json().optional(), _meta: z.looseObject({}).optional() }) })
const StampSchema = z.looseObject({ "cognition.ai/timestamp": z.string().optional(), "cognition.ai/clientMessageId": z.string().optional() })

/**
 * Devin marks the person's messages itself: each `user_message_chunk` of
 * one message carries its `cognition.ai/clientMessageId`, and a message
 * opens the next turn. `journal` scopes plan cards; Mako runs no desktop
 * session live, so they need not match a live id.
 */
function translator(journal: string): DevinTranslator {
  const turns = new AcpSavedTurns(DEVIN_ACP_HOOKS)
  let title: string | undefined
  /** The open message's client id, which its later chunks repeat. */
  let message: string | undefined

  const push = (raw: string): void => {
    const line = parseJson(raw)
    const notification = SavedLineSchema.safeParse(line).data?.notification
    if (!notification) {
      if (isJsonRecord(line)) turns.sink.unread("saved line", "unreadable", line)
      return
    }
    const stamp = StampSchema.safeParse(notification._meta).data
    const at = stamp?.["cognition.ai/timestamp"]
    if (notification.sessionUpdate !== "user_message_chunk") {
      turns.close()
      const saved = acpSavedNotification({ sessionId: journal, update: notification })
      if (saved) for (const patch of turns.update(saved, at)) title = patch.title ?? title
      else {
        const reason = acpSavedRefusal(notification.sessionUpdate)
        if (reason) turns.sink.unread(`session/update/${notification.sessionUpdate}`, reason, line)
      }
      return
    }
    const text = acpText(notification.content)
    const attachments = acpAttachments(notification.content)
    const id = stamp?.["cognition.ai/clientMessageId"]
    const run = turns.prompt
    if (run && id !== undefined && id === message) {
      run.text += text
      run.attachments.push(...attachments)
      return
    }
    if (!text && !attachments.length) return
    turns.commit()
    message = id
    turns.prompted({ at, text, attachments })
  }

  return {
    push,
    unavailable: (position, kind, sample) => {
      turns.close()
      if (kind) turns.sink.unread(`messages/${kind}`, "unknown", sample)
      const detail = kind
        ? `Mako can't read Devin's "${kind}" records yet. The original remains in the IDE store.`
        : "This native record exceeds the history read limit. The original remains in the IDE store."
      turns.queue({ kind: "event", label: "Message unavailable", detail, source: { harness: "devin", record: `${journal}:messages/${position}` } }, undefined)
    },
    snapshot: () => turns.snapshot(),
    done: () => turns.done(),
    unread: () => turns.sink.unreadRecords,
    get title() {
      return title
    },
    get needsReset() {
      return turns.needsReset
    },
    get unchanged() {
      return turns.unchanged
    },
  }
}

function parseStateValueRow(row: SqliteStatementResult): StateValueRow | null {
  if (!row) return null
  const value = row["value"]
  return isStringValue(value) ? { value } : null
}

function parseEventLogIndex(raw: string): Map<string, EventLogEntry> | null {
  const root = parseJson(raw)
  if (!isJsonRecord(root)) return null
  const index = new Map<string, EventLogEntry>()
  for (const [sessionId, value] of Object.entries(root)) {
    if (!isJsonRecord(value)) continue
    const uuid = readString(value, "uuid")
    if (!uuid) continue
    const lastUpdated = readNumber(value, "lastUpdated")
    index.set(sessionId, { uuid, lastUpdated })
  }
  return index
}

function parseSessionCache(raw: string): SessionCache | null {
  const root = parseJson(raw)
  if (!isJsonRecord(root)) return null
  const value = root["sessions"]
  if (value === undefined) return { sessions: [] }
  if (!isJsonArray(value)) return null
  const sessions: CachedSession[] = []
  for (const candidate of value) {
    if (!isJsonRecord(candidate)) continue
    const sessionId = readString(candidate, "sessionId")
    if (!sessionId) continue
    sessions.push({
      sessionId,
      title: readString(candidate, "title"),
      cwd: readString(candidate, "cwd"),
      model: parseConfiguredModel(candidate["configOptions"]),
      createdAt: parseCreatedAt(candidate["_meta"]),
    })
  }
  return { sessions }
}

function parseConfiguredModel(
  value: JsonValue | undefined
): string | undefined {
  if (!isJsonArray(value)) return undefined
  for (const option of value) {
    if (!isJsonRecord(option) || readString(option, "id") !== "model") continue
    return readString(option, "currentValue")
  }
  return undefined
}

function parseCreatedAt(value: JsonValue | undefined): string | undefined {
  return isJsonRecord(value)
    ? readString(value, "cognition.ai/createdAt")
    : undefined
}

function parseJson(raw: string): JsonValue | undefined {
  try {
    const value: JsonValue = JSON.parse(raw)
    return value
  } catch {
    return undefined
  }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isJsonArray(value: JsonValue | undefined): value is JsonValue[] {
  return Array.isArray(value)
}

function isStringValue(
  value: JsonValue | SQLOutputValue | undefined
): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return isStringValue(value) ? value : undefined
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return isNumberValue(value) ? value : undefined
}
