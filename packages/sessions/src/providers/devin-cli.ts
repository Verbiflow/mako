import { z } from "zod"
import type { WriterEvidenceLookups } from "../record-evidence.js"
import type { WriterEvidence } from "../record-writers.js"
import {
  devinReferences,
  devinPromptImages,
  devinMcpCall,
} from "./devin-presentation.js"
import { attachmentFromUrl, type AttachmentContent } from "../content.js"
import { acpToolFields, AcpToolUpdateSchema, mergeAcpTool, type AcpToolFields } from "../acp-tool-details.js"
import { AcpSavedTurns, acpSavedNotification, acpSavedRefusal } from "../acp-saved-turns.js"
import { DEVIN_ACP_HOOKS, DEVIN_TOOL_READING, DevinCallMetrics, devinCompactionRecord, devinStoredTokens, DevinTodoWrite, devinAnswersShown, devinQuietExitShown } from "../harnesses/devin.js"
import { tokenSum } from "../harnesses/tokens.js"
import { devinCliDirectory } from "./devin-location.js"
/**
 * devin-cli's own sessions — the ones Zed's agent panel (or any ACP host)
 * drives.
 *
 * The Devin IDE journals ACP traffic itself; the *CLI* keeps its own store:
 * one SQLite database at `~/.local/share/devin/cli/sessions.db` with a
 * `sessions` table (id, working_directory, model, title, activity) and a
 * `message_nodes` forest whose rows are JSON chat messages. A Devin thread
 * run through Zed exists only here — no per-session file anywhere.
 *
 * One database, many sessions, so discovery synthesizes one NativeFile per
 * session (`…/sessions.db#<id>`), sized by its highest message row and
 * dated by its last activity — the catalog's cheap change detection works
 * unchanged. The provider marks itself `rescanRoot`: a write to the db (or
 * its WAL) re-runs discovery instead of stat-ing a path that does not
 * exist as a file.
 */

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { removeSessionRows } from "../sqlite-removal.js"
import type { NativeStores } from "../read-only-sqlite.js"
import { ownedRows, type RecordRoot, type SessionRecords } from "../harness-records.js"
import type { ChildTranscript } from "../children.js"
import { DevinChildLinks, devinChildPath } from "./devin-cli-children.js"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { agentTitleFrom, titleFrom, type Thread, type UnreadRecord, type ThreadRef, type TurnUsage } from "../format.js"
import type { Entry, RecordRef } from "../entries.js"
import { joined } from "../entries.js"
import { subagentTurn } from "../provider-turn.js"
import { compactionEvent } from "../events.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./types.js"
import { devinFork } from "./devin-fork.js"

type SqliteFields = Record<string, SQLOutputValue>
type StoredTimestamp = number | undefined
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

type TextSource = JsonValue | SQLOutputValue | undefined

interface JsonObject {
  [key: string]: JsonValue
}

type ChatContent = JsonValue

interface ToolFunction {
  name?: string
  arguments?: JsonValue
}

interface ToolCall {
  id?: string
  name?: string
  arguments?: JsonValue
  function?: ToolFunction
}

interface ChatMessage {
  role?: string
  content?: ChatContent
  images?: JsonValue
  thinking?: ChatContent
  tool_calls?: ToolCall[]
  tool_call_id?: string
  usage?: TurnUsage
  /** Devin's per-message annotations, `metadata.extensions`. */
  extensions?: JsonObject
  /** When Devin made the message, `metadata.created_at`; it writes a steered one after the step it waited for. */
  writtenAt?: string
}

interface DiscoveryRow {
  id: string
  activity: StoredTimestamp
  top: number
  title: string | null
  cwd: string | null
}

interface SessionRow {
  workingDirectory?: string
  model?: string
  title?: string
  createdAt: StoredTimestamp
  lastActivityAt: StoredTimestamp
}

interface MessageRow {
  rowId: number
  chatMessage?: string
  createdAt: StoredTimestamp
  usage?: TurnUsage
  /** On a compaction's summary, the node the history it summarizes ends at. */
  summarizedFrom?: number
}

interface MessageTranslator {
  push(row: MessageRow): void
  /** A subagent's model call, spent in the turn running, or in the next when none runs. */
  spend(usage: TurnUsage): void
  snapshot(): Entry[]
  /** The rows it couldn't draw, by kind. */
  unread(): UnreadRecord[] | undefined
}

function openDatabase(stores: NativeStores, path: string): DatabaseSync | null {
  try {
    return stores.open(path)
  } catch {
    return null
  }
}

/** Epoch seconds or millis — the store has carried both readings. */
function isoOf(value: StoredTimestamp): string | undefined {
  if (value === undefined || value <= 0) return undefined
  return new Date(value > 1e12 ? value : value * 1000).toISOString()
}

export class DevinCliProvider implements SessionProvider {
  /** Its records state no version: what its harness leaves beside them says (`record-evidence.ts`). */
  writerEvidence(path: string, reader: WriterEvidenceLookups): Promise<WriterEvidence | null> {
    return reader.devinCli(path)
  }

  harness = "devin" as const
  displayName = "Devin"
  /** How a session is written again as its own fork (`devin-fork.ts`). */
  readonly fork = devinFork
  /** Refresh cached titles after native image/control/attachment labels are projected. */
  peekVersion = 1
  /** One store, many sessions: a db write means re-discover, not re-stat. */
  rescanRoot = (): boolean => true
  rescanDebounceMs = 500
  private readonly childLinks = new DevinChildLinks()

  private dir: string
  private db: DatabaseSync | null = null
  private dbIdentity: string | null = null

  /**
   * `env` is the environment Devin runs with. The process's own is read only
   * for the default home: a provider built on another home is an isolated
   * world (a fixture, a mirror).
   */
  private readonly stores: NativeStores

  constructor(stores: NativeStores, home?: string, env = home === undefined ? process.env : {}) {
    this.stores = stores
    this.dir = devinCliDirectory(env, home ?? homedir())
  }

  roots(): string[] {
    return [this.dir]
  }

  observationPaths(): string[] {
    const database = this.dbPath()
    return [database, `${database}-wal`]
  }

  /** Only the locks folder: logs and plugin state beside it change without a session moving. */
  watchRoots(): string[] {
    return [this.lockPath()]
  }

  pollFiles(): string[] {
    return this.observationPaths()
  }

  /**
   * Sessions live in the database and their locks; the logs, plugin state
   * and summaries beside them change without a session moving.
   */
  watchTarget(path: string): string | null {
    return path.startsWith(this.dbPath()) ||
      path.startsWith(`${this.lockPath()}${sep}`)
      ? path
      : null
  }

  private dbPath(): string {
    return join(this.dir, "sessions.db")
  }

  private async connection(): Promise<DatabaseSync | null> {
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return null
    const identity = `${info.dev}:${info.ino}:${this.stores.version(this.dbPath())}`
    if (this.db && this.dbIdentity === identity) return this.db
    this.db?.close()
    this.db = openDatabase(this.stores, this.dbPath())
    this.dbIdentity = this.db ? identity : null
    return this.db
  }

  private resetConnection(): void {
    this.db?.close()
    this.db = null
    this.dbIdentity = null
  }

  private lockPath(): string {
    return join(this.dir, "session_locks")
  }

  async discover(): Promise<NativeFile[]> {
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return []
    const db = await this.connection()
    if (!db) return []
    try {
      const stored = db
        .prepare(
          `SELECT s.id AS id, s.last_activity_at AS activity,
                  COALESCE(s.main_chain_id, -1) AS top,
                  s.title AS title, s.working_directory AS cwd
           FROM sessions s WHERE s.hidden = 0`
        )
        .all()
      const rows = stored
        .map(parseDiscoveryRow)
        .filter((row): row is DiscoveryRow => row !== null)
      const locked = await lockedSessionIds(
        this.lockPath(),
        rows.map((row) => row.id)
      )
      return rows.map((row) => this.fileOf(row, info.mtimeMs, info.size, locked.has(row.id)))
    } catch {
      this.resetConnection()
      return []
    }
  }

  /**
   * One session's stamp, as `discover` lists it: a view of the session is
   * kept as long as the catalog sees no change in it. Null for a child
   * agent's path, which is decoded for each ask.
   */
  async stat(path: string): Promise<NativeFile | null> {
    const id = idOf(path)
    if (!id || devinChildPath(path)) return null
    const info = await stat(this.dbPath()).catch(() => null)
    const db = info && (await this.connection())
    if (!info || !db) return null
    try {
      const stored = db
        .prepare(
          `SELECT s.id AS id, s.last_activity_at AS activity,
                  COALESCE(s.main_chain_id, -1) AS top,
                  s.title AS title, s.working_directory AS cwd
           FROM sessions s WHERE s.id = ? AND s.hidden = 0`
        )
        .get(id)
      const row = stored && parseDiscoveryRow(stored)
      if (!row) return null
      const locked = await lockedSessionIds(this.lockPath(), [row.id])
      return this.fileOf(row, info.mtimeMs, info.size, locked.has(row.id))
    } catch {
      this.resetConnection()
      return null
    }
  }

  /** Every node of the session's forest, which a read may walk: `octet_length` reads each row's size from its header, not its text. */
  async recordBytes(path: string): Promise<number | null> {
    const id = idOf(path)
    const db = id && !devinChildPath(path) ? await this.connection() : null
    if (!id || !db) return null
    try {
      const bytes = db.prepare("SELECT COALESCE(SUM(octet_length(chat_message)), 0) AS bytes FROM message_nodes WHERE session_id = ?").get(id)?.bytes
      return isSqliteNumber(bytes) ? bytes : null
    } catch {
      return null
    }
  }

  private fileOf(row: DiscoveryRow, dbMtimeMs: number, dbBytes: number, locked: boolean): NativeFile {
    const at = isoOf(row.activity)
    // Synthetic sessions share one database; this fractional revision lets
    // lock-only changes invalidate one cached ref without moving its cursor.
    return {
      path: `${this.dbPath()}#${row.id}`,
      bytes: row.top,
      mtimeMs: (at ? Date.parse(at) : dbMtimeMs) + (locked ? 0.5 : 0),
      // Devin renames a session without touching last_activity_at.
      revision: JSON.stringify([row.title, row.cwd]),
      locked,
      storeBytes: dbBytes,
    }
  }

  /** Remove a session and every row that names it; the read connection is reset so it cannot serve the ghost. */
  /** The session's row, its rows in every table keyed by `session_id`, and the migration history the CLI checks on open. */
  /**
   * What each of a session's subagents spent, call by call. Devin reports a
   * subagent's model calls on its parent's wire as they're made, so live they
   * count in the parent's turn; its subagent's chain is where the store keeps
   * them (3000.11.205), and its own history counts them there too.
   */
  private subagentSpend(db: DatabaseSync, id: string, path: string): ChildSpend[] {
    const spend: ChildSpend[] = []
    for (const child of this.childLinks.children(db, id, path)) {
      if (!child.path) continue
      for (const row of mainChainRows(db, id, this.childLinks.leaf(db, id, child.nativeId))) {
        const message = row.chatMessage ? parseChatMessage(row.chatMessage) : null
        const usage = message?.role === "assistant" ? message.usage ?? row.usage : undefined
        if (usage) spend.push({ createdAt: row.createdAt ?? 0, usage })
      }
    }
    return spend.sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Its subagents: chains in the session's own forest, named by its `run_subagent` calls. */
  async children(path: string): Promise<ChildTranscript[] | null> {
    const id = idOf(path)
    if (!id || devinChildPath(path)) return null
    const db = await this.connection()
    if (!db) return null
    try {
      if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) return null
      return this.childLinks.children(db, id, path)
    } catch {
      this.resetConnection()
      return null
    }
  }

  /** `devin-cli`: Devin CLI's data folder, where its `sessions.db` is. */
  recordRoots(): RecordRoot[] {
    return [{ name: "devin-cli", path: this.dir }]
  }

  async records(path: string): Promise<SessionRecords | null> {
    const id = idOf(path)
    if (!id || path.slice(0, path.lastIndexOf("#")) !== this.dbPath()) return null
    const database = ownedRows(this.dbPath(), [id], { owner: "session_id", keyed: { sessions: "id" }, shared: ["refinery_schema_history"] })
    // Its subagents are chains in its own rows: the paths they're read at come with them.
    const children = ((await this.children(path).catch(() => null)) ?? []).flatMap((child) => (child.path ? [child.path] : []))
    // Devin's rows state no CLI version (only its schema's, in `refinery_schema_history`): what wrote them is the CLI installed as a write lands.
    return database && { roots: this.recordRoots(), files: [], databases: [database], writer: { installed: true }, children }
  }

  async remove(path: string): Promise<boolean> {
    const id = idOf(path)
    if (!id || path.slice(0, path.lastIndexOf("#")) !== this.dbPath())
      return false
    this.resetConnection()
    return removeSessionRows(this.stores, this.dbPath(), id, ["sessions"])
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const id = idOf(file.path)
    if (!id) return null
    const db = await this.connection()
    if (!db) return null
    try {
      const stored = db
        .prepare(
          "SELECT working_directory, model, title, created_at, last_activity_at FROM sessions WHERE id = ?"
        )
        .get(id)
      if (!stored) return null
      const row = parseSessionRow(stored)
      let title = agentTitleFrom(row.title)
      if (!title) {
        for (const stored of mainChainRows(db, id, mainChainId(db, id))) {
          const message = stored.chatMessage ? parseChatMessage(stored.chatMessage) : null
          if (message?.role !== "user") continue
          title = titleFrom(devinPromptImages(contentText(message.content)).text)
          if (title) break
        }
      }
      return {
        harness: this.harness,
        nativeId: id,
        path: file.path,
        cwd: row.workingDirectory,
        title,
        model: row.model,
        settings: { model: row.model },
        modelProvider: "devin",
        startedAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.lastActivityAt),
        bytes: file.bytes,
        locked: file.locked,
      }
    } catch {
      this.resetConnection()
      return null
    }
  }

  async read(path: string): Promise<Thread | null> {
    const id = idOf(path)
    if (!id) return null
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return null
    const locked = (await lockedSessionIds(this.lockPath(), [id])).has(id)
    const child = devinChildPath(path)
    const ref = await this.peek({
      path,
      bytes: 0,
      mtimeMs: info.mtimeMs,
      locked,
    })
    if (!ref) return null
    const db = await this.connection()
    if (!db) return null
    try {
      const cursor = child ? this.childLinks.leaf(db, id, child.agentId) : mainChainId(db, id)
      if (child) {
        // A subagent's chain, read as its session's main chain is.
        if (cursor < 0) return null
        Object.assign(ref, { nativeId: child.agentId, title: undefined, childOf: { nativeId: id, path: child.parentPath } })
      }
      ref.bytes = cursor
      const { entries, unread } = translatedMainChain(db, id, cursor, child ? [] : this.subagentSpend(db, id, path))
      const thread: Thread = { ref, entries }
      if (unread) thread.unread = unread
      return thread
    } catch {
      this.resetConnection()
      return null
    }
  }

  createFollower(path: string, fromByte: number): SessionFollower {
    const id = idOf(path)
    let cursor = fromByte
    let previous: string[] | null = null

    return {
      get offset() {
        return cursor
      },
      next: async (wholeLimit?: number): Promise<SessionUpdate> => {
        if (!id) return unchangedUpdate(cursor)
        const db = await this.connection()
        if (!db) return unchangedUpdate(cursor)
        try {
          const child = devinChildPath(path)
          const nextCursor = child ? this.childLinks.leaf(db, id, child.agentId) : mainChainId(db, id)
          if (nextCursor === cursor) return unchangedUpdate(cursor)
          if (wholeLimit !== undefined && ((await this.recordBytes(path)) ?? 0) >= wholeLimit) return { entries: [], nextByte: cursor, replace: false, reload: true }
          const spend = child ? [] : this.subagentSpend(db, id, path)
          if (previous === null) {
            previous = translatedMainChain(db, id, cursor, spend).entries.map(entryDigest)
          }
          const current = translatedMainChain(db, id, nextCursor, spend).entries
          const signatures = current.map(entryDigest)
          let shared = 0
          while (
            shared < previous.length &&
            previous[shared] === signatures[shared]
          ) {
            shared += 1
          }
          const appended = shared === previous.length
          const entries = appended
            ? current.slice(previous.length)
            : current.slice(shared)
          previous = signatures
          cursor = nextCursor
          const update: SessionUpdate = {
            entries: structuredClone(entries),
            nextByte: cursor,
            replace: !appended,
          }
          if (!appended) update.replaceFrom = shared
          return update
        } catch {
          this.resetConnection()
          return unchangedUpdate(cursor)
        }
      },
    }
  }

  close(): void {
    this.resetConnection()
  }
}

function mainChainId(db: DatabaseSync, sessionId: string): number {
  const stored = db
    .prepare(
      "SELECT COALESCE(main_chain_id, -1) AS main_chain_id FROM sessions WHERE id = ?"
    )
    .get(sessionId)
  return stored && isSqliteNumber(stored.main_chain_id)
    ? stored.main_chain_id
    : -1
}

/**
 * The main chain, each compaction's earlier history read before it: Devin
 * 3000.10.23 starts a new chain after compacting, whose summary row's
 * `summarized_from` names the node the earlier chain ends at.
 */
function mainChainRows(
  db: DatabaseSync,
  sessionId: string,
  leafId: number,
  read = new Set<number>()
): MessageRow[] {
  if (leafId < 0 || read.has(leafId)) return []
  read.add(leafId)
  const rows = chainRows(db, sessionId, leafId)
  const from = rows.find((row) => row.summarizedFrom !== undefined)?.summarizedFrom
  return from === undefined ? rows : [...mainChainRows(db, sessionId, from, read), ...rows]
}

function chainRows(
  db: DatabaseSync,
  sessionId: string,
  leafId: number
): MessageRow[] {
  const metadata = db
    .prepare("PRAGMA table_info(message_nodes)")
    .all()
    .some((row) => row.name === "metadata")
    ? "metadata"
    : "NULL"
  const stored = db
    .prepare(
      `WITH RECURSIVE chain(
         row_id, node_id, parent_node_id, chat_message, metadata, created_at, depth
       ) AS (
         SELECT row_id, node_id, parent_node_id, chat_message, ${metadata}, created_at, 0
         FROM message_nodes
         WHERE session_id = ? AND node_id = ?
         UNION ALL
         SELECT m.row_id, m.node_id, m.parent_node_id, m.chat_message,
                ${metadata === "metadata" ? "m.metadata" : "NULL"},
                m.created_at, chain.depth + 1
         FROM message_nodes m
         JOIN chain ON m.node_id = chain.parent_node_id
         WHERE m.session_id = ?
       )
       SELECT row_id, chat_message, metadata, created_at
       FROM chain
       ORDER BY depth DESC`
    )
    .all(sessionId, leafId, sessionId)
  return stored.map(parseMessageRow)
}

/** A session's main chain, drawn, with the records the translator couldn't draw. */
interface TranslatedChain {
  entries: Entry[]
  unread: UnreadRecord[] | undefined
}

/** A subagent's model call: when it was made and what it spent. */
interface ChildSpend {
  createdAt: number
  usage: TurnUsage
}

/**
 * A session's main chain, drawn, with each of its subagents' calls spent in
 * the turn running when it was made. One a background subagent made while
 * the session was idle counts in the turn that follows (the one its report
 * opens), as Grok's own ledger counts a subagent that wakes its parent
 * (`GrokWokenSpend`), or with none after it, in the last.
 */
function translatedMainChain(db: DatabaseSync, sessionId: string, leafId: number, spend: readonly ChildSpend[] = []): TranslatedChain {
  const cwd = sqliteText(db.prepare("SELECT working_directory AS cwd FROM sessions WHERE id = ?").get(sessionId)?.cwd)
  const into = translator(sessionId, storedAcpCalls(db, sessionId), cwd)
  let next = 0
  for (const row of mainChainRows(db, sessionId, leafId)) {
    for (; next < spend.length && spend[next]!.createdAt < (row.createdAt ?? 0); next++) into.spend(spend[next]!.usage)
    into.push(row)
  }
  for (; next < spend.length; next++) into.spend(spend[next]!.usage)
  return { entries: into.snapshot(), unread: into.unread() }
}

/** A call as `tool_call_state` kept it: the `tool_call` Devin sent and its final `tool_call_update`. */
interface StoredAcpCall {
  call?: JsonObject
  update?: JsonObject
}

function storedJson(value: SQLOutputValue | undefined): JsonObject | undefined {
  const text = sqliteText(value)
  if (!text) return undefined
  try {
    const parsed: JsonValue = JSON.parse(text)
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function storedFields(value: JsonObject | undefined): AcpToolFields {
  const parsed = AcpToolUpdateSchema.safeParse(value)
  return parsed.success ? acpToolFields(parsed.data, DEVIN_TOOL_READING) : {}
}

/**
 * The input Devin sent its client. Its stored call can drop arguments the
 * model gave (an edit's strings, which its diff holds); when every field it
 * kept matches the model's, the model's arguments are what it sent.
 */
function sentInput(kept: JsonValue | undefined, model: JsonValue | undefined): JsonValue | undefined {
  const given = isTextValue(model) ? jsonObject(model) ?? model : model
  if (kept === undefined || given === undefined) return kept ?? given
  if (!isJsonObject(kept) || !isJsonObject(given)) return kept
  const abridged = Object.entries(kept).every(([key, value]) => key in given && JSON.stringify(given[key]) === JSON.stringify(value))
  return abridged ? given : kept
}

function jsonObject(text: string): Record<string, JsonValue> | undefined {
  try {
    const parsed: JsonValue = JSON.parse(text)
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Each call's ACP updates as Devin kept them. Older stores have no such table. */
function storedAcpCalls(
  db: DatabaseSync,
  sessionId: string
): Map<string, StoredAcpCall> {
  const calls = new Map<string, StoredAcpCall>()
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_call_state'"
    )
    .get()
  if (!table) return calls
  const rows = db
    .prepare(
      "SELECT tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE session_id = ?"
    )
    .all(sessionId)
  for (const row of rows) {
    const id = sqliteText(row.tool_call_id)
    if (id) calls.set(id, { call: storedJson(row.tool_call_json), update: storedJson(row.tool_call_update_json) })
  }
  return calls
}

function entryDigest(entry: Entry): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("base64url")
}

/** Native lock files accumulate after sessions disappear. Only read locks for
 * the sessions this operation actually returns; recheck their PIDs every time. */
async function lockedSessionIds(
  path: string,
  ids: string[]
): Promise<Set<string>> {
  const locked = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 8) {
    await Promise.all(
      ids.slice(offset, offset + 8).map(async (id) => {
        // Session IDs are database data, never permission to read outside locks.
        if (id.includes("/") || id.includes("\\")) return
        const raw = await readFile(join(path, `${id}.lock`), "utf8").catch(
          () => ""
        )
        const pid = Number(raw.trim())
        if (!Number.isInteger(pid) || pid <= 0) return
        try {
          process.kill(pid, 0)
          locked.add(id)
        } catch {
          /* No live lock owner. */
        }
      })
    )
  }
  return locked
}

/** A read's result as the model saw it, the file between line-number gutters. */
const FILE_VIEW = /^<file-view\b[^>]*\bstart_line="(\d+)"[^>]*\bend_line="(\d+)"[^>]*\btotal_lines="(\d+)"[^>]*>[\s\S]*<\/file-view>\s*$/

const ReadRange = z.object({ offset: z.number().optional(), limit: z.number().optional() }).loose()

/** A subagent's report as the model read it (devin 3000.11.205): this header, then the report. */
const SUBAGENT_REPORT = /^Subagent agent_id=\S+ completed successfully:\n\n/

/**
 * A result Devin showed its client but didn't keep in its stored update
 * (devin 3000.10.23): a read was "N lines", and "N lines (truncated)" when
 * Devin cut it short of both the file's end and the lines asked for (about
 * 30 KB of a file read whole); the file itself stays the model's. A
 * subagent's was its report under `Subagent completed:` (3000.11.205). Any
 * other such result showed no words.
 */
function devinClientResult(name: string, output: string, input: string | undefined): string {
  const report = name === "run_subagent" ? SUBAGENT_REPORT.exec(output) : null
  if (report) return `Subagent completed:\n${output.slice(report[0].length)}`
  const view = FILE_VIEW.exec(output)
  if (!view) return ""
  const [start, end, total] = [Number(view[1]), Number(view[2]), Number(view[3])]
  const asked = ReadRange.safeParse(input === undefined ? undefined : jsonObject(input)).data
  const askedEnd = asked?.limit === undefined ? total : (asked.offset ?? 1) + asked.limit - 1
  return `${end - start + 1} lines${end < Math.min(total, askedEnd) ? " (truncated)" : ""}`
}

/** A question's picks (devin 3000.10.23); the model read them as JSON in the result's text. */
const DEVIN_QUESTION_ANSWERS = "chisel/user_question_answers"
const DevinQuestionAnswers = z.object({
  answers: z.array(z.object({ question_index: z.number().int().nonnegative().nullish(), selected: z.array(z.string()) }).loose()),
}).loose().optional().catch(undefined)
const DevinQuestions = z.object({ questions: z.array(z.object({ header: z.string().nullish() }).loose()) }).loose()

function devinPicks(answers: JsonValue | undefined, input: string | undefined): string | undefined {
  const picked = DevinQuestionAnswers.parse(answers)
  if (!picked) return undefined
  const questions = DevinQuestions.safeParse(input === undefined ? undefined : jsonObject(input)).data?.questions ?? []
  return devinAnswersShown(picked.answers.map((answer, index) => ({ index: answer.question_index ?? index, picks: answer.selected })), questions.map((question) => question.header))
}

const ImageSize = z.object({ width: z.number(), height: z.number() }).loose().optional().catch(undefined)

/**
 * What a read of an image showed Devin's client (devin 3000.10.23): `View
 * image ./swatch.png (32x32)`, the path from the session's folder. The
 * model got the image itself.
 */
function viewedImage(input: string | undefined, images: JsonValue | undefined, cwd: string | undefined): string | undefined {
  const size = ImageSize.parse(Array.isArray(images) ? images[0] : undefined)
  const path = input === undefined ? undefined : jsonObject(input)?.["file_path"]
  if (!size || !isTextValue(path)) return undefined
  const inside = cwd ? relative(cwd, path) : undefined
  const shown = inside && !inside.startsWith("..") && !isAbsolute(inside) ? `./${inside}` : path
  return `View image ${shown} (${size.width}x${size.height})`
}

/** A grep result's header for each file it matched in. */
const GREP_FILE = /^-- \d+ match(?:es)? in (\/.+)$/gm

/**
 * The files a search sent its client as `resource_link` parts, which its
 * stored update dropped (devin 3000.10.23): a find's result lists one path a
 * line, a grep's heads each file's matches with its path.
 */
function devinFoundFiles(name: string, output: string): JsonObject[] {
  const paths =
    name === "find_file_by_name" ? output.split("\n").filter((line) => line.startsWith("/"))
    : name === "grep" ? [...output.matchAll(GREP_FILE)].map((match) => match[1] ?? "")
    : []
  return paths.map((path) => ({ type: "content", content: { type: "resource_link", name: basename(path), uri: `file://${path}` } }))
}

function textPart(text: string): JsonObject {
  return { type: "content", content: { type: "text", text } }
}

/** The system message Devin appends to a turn the user stopped. */
const DEVIN_STOP_NOTICE = "[Response interrupted by user]"
/**
 * Annotations on a saved message (devin 3000.10.23): the system message that
 * replaces compacted history carries `devin-rs/summary`, and a tool result
 * that failed carries `chisel/tool_failure` with its reason.
 */
const DEVIN_SUMMARY = "devin-rs/summary"
const DEVIN_TOOL_FAILURE = "chisel/tool_failure"
/** Why a tool failed; a call the person stopped failed `Canceled`. */
const DevinToolFailure = z.object({ reason: z.string() }).loose()
/**
 * A command's output and exit (devin 3000.10.23). A command that exited
 * non-zero isn't a `chisel/tool_failure`, though it failed: `cat` of a
 * missing file is kept `success: true` with exit code 1.
 */
const DEVIN_TERMINAL_OUTPUT = "chisel/terminal_output"
const DevinTerminalOutput = z.object({ text: z.string().nullish(), exit: z.object({ exit_code: z.number().nullish() }).loose().nullish() }).loose().optional().catch(undefined)

/** A command that printed nothing, whose exit code the store keeps without the line Devin's client was shown. */
function devinQuietExit(terminal: JsonValue | undefined): string | undefined {
  const output = DevinTerminalOutput.parse(terminal)
  const code = output?.exit?.exit_code
  return code != null && !output?.text ? devinQuietExitShown(code) : undefined
}

/** The summary a compaction message holds, after the preamble that names where the full history went. */
function compactionSummary(text: string): string {
  const at = text.indexOf("\nSummary:\n")
  return at === -1 ? text : text.slice(at + "\nSummary:\n".length)
}

/** A todo list's call, which Devin sends its client as a plan instead. */

type SentUpdate = JsonObject & { sessionUpdate: string }

/** A call the model made: its name and the input Devin sent with it. */
interface MadeCall {
  name: string
  input: JsonValue | undefined
}

/**
 * The main chain as the wire Devin sent its client, read through the decoder
 * the live client runs (`AcpSavedTurns` with `DEVIN_ACP_HOOKS`): thinking and
 * words as message chunks with the references Devin rendered, each call as
 * the `tool_call` and final `tool_call_update` it kept, and a todo list as
 * the plan it sent instead of the call. What a kept update dropped that the
 * client was shown comes back from the chat's tool result. The reader adds
 * what the store marks its own way: prompts and steering, stops, compactions,
 * subagent completions and what each call spent.
 */
function translator(
  sessionId: string,
  acp: ReadonlyMap<string, StoredAcpCall>,
  cwd: string | undefined
): MessageTranslator {
  const turns = new AcpSavedTurns(DEVIN_ACP_HOOKS)
  const send = (update: SentUpdate, at: string | undefined): void => {
    const notification = acpSavedNotification({ sessionId, update })
    if (notification) {
      turns.update(notification, at)
      return
    }
    const reason = acpSavedRefusal(update.sessionUpdate)
    if (reason) turns.unread(`session/update/${update.sessionUpdate}`, reason, update)
  }
  const calls = new Map<string, MadeCall>()
  /** What the open turn's model calls spent. */
  let spent: TurnUsage | undefined
  /** What subagents spent while no turn ran, which the next turn counts. */
  let idle: TurnUsage | undefined
  const commit = (): void => {
    turns.commit(spent)
    spent = idle
    idle = undefined
  }
  /** A turn ends with an assistant message that calls no tool, or a stop. */
  let running = false
  /** The prompt that opened the running turn, which a steered message names. */
  let opener: string | undefined
  /** When the message before this one was made. */
  let previous = Number.NaN
  /** A message row's record, with the call Devin kept for `id` when it kept one. */
  const withCall = (record: RecordRef, id: string): RecordRef | undefined =>
    acp.has(id) ? joined(record, { rows: [{ table: "tool_call_state", key: { session_id: sessionId, tool_call_id: id } }] }) : record
  const subagentCalls = new Map<string, string>()
  /** Each background subagent's title, and when its call said it started. */
  const subagentTitles = new Map<string, { title: string; at?: string }>()

  return {
    push(row) {
      const record: RecordRef = { rows: [{ table: "message_nodes", key: { row_id: row.rowId } }] }
      turns.sink.reading(record)
      if (!row.chatMessage) return
      const message = parseChatMessage(row.chatMessage)
      if (!message) {
        turns.unread("message_nodes row", "unreadable", row.chatMessage)
        return
      }
      const at = isoOf(row.createdAt)
      const source = { harness: "devin" as const, record: String(row.rowId) }
      const written = Date.parse(message.writtenAt ?? "")
      const before = previous
      if (Number.isFinite(written)) previous = written
      if (message.role === "system") {
        const text = contentText(message.content)
        if (text.trim() === DEVIN_STOP_NOTICE) {
          running = false
          turns.close()
          turns.queue({ kind: "event", source, label: "Interrupted" }, at)
          commit()
          return
        }
        if (message.extensions?.[DEVIN_SUMMARY] !== undefined) {
          turns.close()
          const record = devinCompactionRecord(text)
          turns.queue({
            kind: "event",
            source: record ? { harness: "devin", record } : source,
            ...compactionEvent({ summary: compactionSummary(text) }),
          }, at)
          return
        }
        const completion = parseSubagentCompletion(text)
        if (!completion) return
        const state = completion.status === "completed" ? "completed" : "failed"
        // Devin runs a turn on a completion that arrives while it is idle,
        // and the subagent's report is what the turn opens on, as it is live.
        if (!running) {
          commit()
          const started = subagentTitles.get(completion.id)
          const from = Date.parse(started?.at ?? "")
          const to = Date.parse(at ?? "")
          const { reason, cause, body } = subagentTurn({
            description: started?.title,
            id: completion.id,
            state,
            durationMs: Number.isFinite(from) && to >= from ? to - from : undefined,
            result: completion.output,
          })
          turns.sink.push({ kind: "event", id: source.record, at, label: reason, ...cause && { cause }, ...body && { body }, opensTurn: true })
          running = true
          turns.close()
          return
        }
        turns.close()
        turns.queue({
          kind: "tool",
          id: `subagent:${row.rowId}`,
          title: "subagent",
          name: "subagent",
          status: state,
          input: JSON.stringify({ agent_id: completion.id, status: completion.status }),
          output: completion.output,
        }, at)
        return
      }
      if (message.role === "user") {
        const prompt = devinPromptImages(contentText(message.content))
        const text = prompt.text
        const images = storedImages(message.images)
        const byPath = new Map(images.flatMap(image => image.path ? [[image.path, image.attachment] as const] : []))
        const referenced = new Set(prompt.attachments.flatMap(item => item.source.kind === "file" ? [item.source.path] : []))
        const attachments = [
          ...devinAttachments(message.content),
          ...prompt.attachments.map(item => item.source.kind === "file" ? byPath.get(item.source.path) ?? item : item),
          ...images.filter(image => !image.path || !referenced.has(image.path)).map(image => image.attachment),
        ]
        // Devin holds a message steered into a running turn until the step
        // it arrived during ends, so it was made before the row it follows.
        const steers = running && written < before ? opener : undefined
        if (!steers) {
          commit()
          opener = String(row.rowId)
        }
        running = true
        if (text.trim() || attachments.length)
          turns.prompted({ at, id: String(row.rowId), ...steers && { steeringFor: steers }, text, attachments })
        return
      }
      if (message.role === "assistant") {
        turns.close()
        for (const attachment of devinAttachments(message.content)) turns.queue({ kind: "attachment", attachment }, at)
        const thinking = contentText(message.thinking)
        if (thinking.trim()) send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: devinReferences(thinking) } }, at)
        running = (message.tool_calls?.length ?? 0) > 0
        // The model's words come before the calls they introduce.
        const text = contentText(message.content)
        if (text.trim()) send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: devinReferences(text) } }, at)
        for (const [index, call] of (message.tool_calls ?? []).entries()) {
          const name = call.name ?? call.function?.name ?? "tool"
          const rawInput = call.arguments ?? call.function?.arguments
          if (name === "todo_write") {
            const todos = DevinTodoWrite.safeParse(isTextValue(rawInput) ? jsonObject(rawInput) : rawInput).data?.todos ?? []
            send({ sessionUpdate: "plan", entries: todos.map(({ content, status }) => ({ content, status })) }, at)
            continue
          }
          const id = call.id ?? `${row.rowId}:${index}`
          const title = name === "run_subagent" ? subagentTitle(rawInput) : undefined
          if (title) subagentCalls.set(id, title)
          const start = toolStart(id, name, rawInput, acp.get(id)?.call)
          calls.set(id, { name, input: start.rawInput })
          turns.sink.reading(withCall(record, id))
          send(start, at)
          turns.sink.reading(record)
        }
        const usage = message.usage ?? row.usage
        if (usage) spent = addUsage(spent, usage)
        return
      }
      if (message.role === "tool") {
        running = true
        const id = message.tool_call_id
        const call = id === undefined ? undefined : calls.get(id)
        if (id === undefined || !call) return
        turns.close()
        const output = contentText(message.content)
        const title = subagentCalls.get(id)
        const agent = title ? /^Background subagent started with agent_id=([^\s.]+)/.exec(output)?.[1] : undefined
        if (title && agent) subagentTitles.set(agent, { title, at })
        turns.sink.reading(withCall(record, id))
        send(toolEnd(id, call, acp.get(id), message, output, cwd), at)
        const attachments = devinAttachments(message.content)
        if (attachments.length) turns.queue({ kind: "tool-update", id, attachments }, at)
        return
      }
      turns.unread(`message ${message.role ?? "(no role)"}`, "unknown", JSON.parse(row.chatMessage))
    },
    spend(usage) {
      if (running) spent = addUsage(spent, usage)
      else idle = addUsage(idle, usage)
    },
    snapshot() {
      if (idle) spent = addUsage(spent, idle)
      idle = undefined
      commit()
      return turns.done()
    },
    unread: () => turns.sink.unreadRecords,
  }
}

/**
 * The `tool_call` Devin sent: the one it kept, with the model's arguments
 * where it abridged them, or for a store older than `tool_call_state` one
 * made from the model's call.
 */
function toolStart(id: string, name: string, rawInput: JsonValue | undefined, kept: JsonObject | undefined): SentUpdate {
  if (kept) {
    const input = sentInput(kept.rawInput, rawInput)
    return { ...kept, sessionUpdate: "tool_call", toolCallId: id, ...input !== undefined && { rawInput: input } }
  }
  const mcp = name === "mcp_call_tool" ? devinMcpCall(toolInputText(rawInput)) : undefined
  const input = mcp ? jsonObject(mcp.input) : sentInput(undefined, rawInput)
  const tool = mcp?.name ?? name
  return { sessionUpdate: "tool_call", toolCallId: id, title: tool, ...input !== undefined && { rawInput: input }, _meta: { "cognition.ai/inferenceToolName": tool } }
}

/**
 * The `tool_call_update` that ended a call: the one Devin kept, with what it
 * dropped back from the chat's result. A failed result ends the call
 * failed, a stopped one canceled, and a command's exit code goes where ACP's
 * terminal extension carries it. A store older than `tool_call_state` shows
 * the model's own result.
 */
function toolEnd(id: string, call: MadeCall, stored: StoredAcpCall | undefined, message: ChatMessage, output: string, cwd: string | undefined): SentUpdate {
  const kept = stored?.update
  const failure = message.extensions?.[DEVIN_TOOL_FAILURE]
  const exitCode = DevinTerminalOutput.parse(message.extensions?.[DEVIN_TERMINAL_OUTPUT])?.exit?.exit_code
  const meta: JsonObject = {}
  if (isJsonObject(kept?._meta)) Object.assign(meta, kept._meta)
  if (failure !== undefined && DevinToolFailure.safeParse(failure).data?.reason === "Canceled") meta["cognition.ai/canceled"] = true
  if (exitCode != null && meta["terminal_exit"] === undefined) meta["terminal_exit"] = { exit_code: exitCode }
  const status = failure === undefined ? jsonText(kept?.status) ?? "completed" : "failed"
  const update: SentUpdate = { ...kept, sessionUpdate: "tool_call_update", toolCallId: id, status, _meta: meta }
  if (!stored) {
    if (output) update.content = [textPart(output)]
    return update
  }
  const content = Array.isArray(kept?.content) ? [...kept.content] : []
  const shown = mergeAcpTool(storedFields(stored.call), storedFields(kept))
  if (shown.output === undefined) {
    const input = call.input === undefined || isTextValue(call.input) ? call.input : JSON.stringify(call.input)
    const said = (call.name === "read" ? viewedImage(input, message.images, cwd) : undefined) ??
      devinPicks(message.extensions?.[DEVIN_QUESTION_ANSWERS], input) ??
      (call.name === "exec" ? devinQuietExit(message.extensions?.[DEVIN_TERMINAL_OUTPUT]) : undefined) ??
      devinClientResult(call.name, output, input)
    if (said) content.push(textPart(said))
  }
  if (!shown.attachments) content.push(...devinFoundFiles(call.name, output))
  if (content.length) update.content = content
  return update
}

function addUsage(total: TurnUsage | undefined, more: TurnUsage): TurnUsage {
  if (!total) return { ...more }
  return {
    input: (total.input ?? 0) + (more.input ?? 0),
    output: (total.output ?? 0) + (more.output ?? 0),
    cacheRead: (total.cacheRead ?? 0) + (more.cacheRead ?? 0),
    cacheWrite: (total.cacheWrite ?? 0) + (more.cacheWrite ?? 0),
  }
}

function parseSubagentCompletion(text: string): {
  id: string
  status: string
  output: string
} | null {
  const match =
    /^<subagent_completion_notification>\s*\n\[Background subagent with agent_id=([^\s\]]+) ([^\]]+)\]\s*\n([\s\S]*?)\s*<\/subagent_completion_notification>\s*$/.exec(
      text
    )
  if (!match) return null
  return {
    id: match[1]!,
    status: match[2]!,
    output: match[3]?.trim() ?? "",
  }
}

function unchangedUpdate(nextByte: number): SessionUpdate {
  return { entries: [], nextByte, replace: false }
}

function parseDiscoveryRow(fields: SqliteFields): DiscoveryRow | null {
  if (!isTextValue(fields.id) || !fields.id) return null
  return {
    id: fields.id,
    activity: sqliteNumber(fields.activity),
    top: isSqliteNumber(fields.top) ? fields.top : 0,
    title: isTextValue(fields.title) ? fields.title : null,
    cwd: isTextValue(fields.cwd) ? fields.cwd : null,
  }
}

function parseSessionRow(fields: SqliteFields): SessionRow {
  return {
    workingDirectory: sqliteText(fields.working_directory),
    model: sqliteText(fields.model) || undefined,
    title: sqliteText(fields.title),
    createdAt: sqliteNumber(fields.created_at),
    lastActivityAt: sqliteNumber(fields.last_activity_at),
  }
}

function parseMessageRow(fields: SqliteFields): MessageRow {
  const metadata = parseMetadata(sqliteText(fields.metadata))
  return {
    rowId: isSqliteNumber(fields.row_id) ? fields.row_id : 0,
    chatMessage: sqliteText(fields.chat_message),
    createdAt: sqliteNumber(fields.created_at),
    usage: usageFromMetadata(metadata),
    summarizedFrom: SummarizedFromSchema.parse(metadata)?.summarized_from,
  }
}

/*
 * Read from every row and every call's end, though few carry them: each
 * reads as `undefined` where absent rather than failing a `safeParse`, which
 * builds an `Error` each time.
 */
const SummarizedFromSchema = z.object({ summarized_from: z.number() }).optional().catch(undefined)
const StoredCallMetrics = DevinCallMetrics.optional().catch(undefined)

function usageFromMetadata(
  metadata: JsonValue | undefined
): TurnUsage | undefined {
  const metrics = isJsonObject(metadata) ? StoredCallMetrics.parse(metadata.metrics) : undefined
  if (!metrics) return undefined
  const tokens = devinStoredTokens(metrics)
  const { input, output, cacheRead, cacheWrite } = tokens
  return tokenSum(tokens) > 0 ? { input, output, cacheRead, cacheWrite } : undefined
}

function parseMetadata(text: string | undefined): JsonValue | undefined {
  if (!text) return undefined
  try {
    const metadata: JsonValue = JSON.parse(text)
    return metadata
  } catch {
    return undefined
  }
}

function parseChatMessage(text: string): ChatMessage | null {
  try {
    const parsed: JsonValue = JSON.parse(text)
    if (!isJsonObject(parsed)) return null
    return {
      role: jsonText(parsed.role),
      content: parsed.content,
      images: parsed.images,
      thinking: parsed.thinking,
      tool_calls: parseToolCalls(parsed.tool_calls),
      tool_call_id: jsonText(parsed.tool_call_id),
      usage: usageFromMetadata(parsed.metadata),
      extensions:
        isJsonObject(parsed.metadata) &&
        isJsonObject(parsed.metadata.extensions)
          ? parsed.metadata.extensions
          : undefined,
      writtenAt: isJsonObject(parsed.metadata) ? jsonText(parsed.metadata.created_at) : undefined,
    }
  } catch {
    return null
  }
}

function parseToolCalls(value: JsonValue | undefined): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: ToolCall[] = []
  for (const item of value) {
    if (!isJsonObject(item)) continue
    calls.push({
      id: jsonText(item.id),
      name: jsonText(item.name),
      arguments: item.arguments,
      function: parseToolFunction(item.function),
    })
  }
  return calls
}

function parseToolFunction(
  value: JsonValue | undefined
): ToolFunction | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    name: jsonText(value.name),
    arguments: value.arguments,
  }
}

function sqliteText(value: SQLOutputValue | undefined): string | undefined {
  return isTextValue(value) ? value : undefined
}

function jsonText(value: JsonValue | undefined): string | undefined {
  return isTextValue(value) ? value : undefined
}

function sqliteNumber(value: SQLOutputValue | undefined): StoredTimestamp {
  return isSqliteNumber(value) ? value : undefined
}

function isTextValue(value: TextSource): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isSqliteNumber(value: SQLOutputValue | undefined): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(Number(value))
  )
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value)
  )
}

function subagentTitle(input: JsonValue | undefined): string | undefined {
  if (isJsonObject(input)) return jsonText(input.title)
  if (!isTextValue(input)) return undefined
  try {
    const parsed: JsonValue = JSON.parse(input)
    return isJsonObject(parsed) ? jsonText(parsed.title) : undefined
  } catch {
    return undefined
  }
}

function toolInputText(input: JsonValue | undefined): string | undefined {
  if (input === undefined) return undefined
  return isTextValue(input) ? input : JSON.stringify(input)
}

/** The session a path names; a subagent's path (`devinChildPath`) names its session's. */
function idOf(path: string): string | null {
  const at = path.lastIndexOf("#")
  return at === -1 ? null : path.slice(at + 1).split("/")[0] || null
}

function contentText(content: ChatContent | undefined): string {
  if (isTextValue(content)) return content
  if (isJsonObject(content)) {
    if (isTextValue(content.text)) return content.text
    if (isTextValue(content.thinking)) return content.thinking
    if (content.content !== undefined) return contentText(content.content)
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isTextValue(part)) return part
        return isJsonObject(part) && isTextValue(part.text) ? part.text : ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

function devinAttachments(
  content: ChatContent | undefined
): AttachmentContent[] {
  if (!Array.isArray(content)) return []
  const attachments: AttachmentContent[] = []
  for (const part of content) {
    if (!isJsonObject(part)) continue
    const type = jsonText(part.type)
    if (type !== "image_url" && type !== "input_audio" && type !== "file")
      continue
    const image = isJsonObject(part.image_url) ? part.image_url : undefined
    const audio = isJsonObject(part.input_audio) ? part.input_audio : undefined
    const url =
      jsonText(image?.url) ?? jsonText(part.image_url) ?? jsonText(part.url)
    const mimeType =
      type === "image_url"
        ? "image/png"
        : type === "input_audio"
          ? `audio/${jsonText(audio?.format) ?? "wav"}`
          : "application/octet-stream"
    const data = jsonText(audio?.data)
    attachments.push(
      url
        ? attachmentFromUrl(type, mimeType, url)
        : {
            type: "attachment",
            name: jsonText(part.filename) ?? type,
            mimeType,
            source: data
              ? { kind: "inline", data }
              : {
                  kind: "unavailable",
                  reason: "The provider did not retain attachment bytes",
                },
          }
    )
  }
  return attachments
}

const StoredImage = z.object({
  source_path: z.string().refine(isAbsolute).optional(),
  mime_type: z.string().regex(/^image\/[\w.+-]+$/),
  base64_data: z.string().optional(),
})
interface NativeStoredImage {
  path?: string
  attachment: AttachmentContent
}

/** Devin stores image bytes outside chat content; use them even after the staged file disappears. */
function storedImages(value: JsonValue | undefined): NativeStoredImage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const parsed = StoredImage.safeParse(item)
    if (!parsed.success) return []
    const image = parsed.data
    let source: AttachmentContent["source"]
    if (image.base64_data)
      source = image.base64_data.length > 28 * 1024 * 1024
        ? { kind: "unavailable", reason: "The native image exceeds the inline preview limit; original bytes remain in the Devin store" }
        : { kind: "inline", data: image.base64_data }
    else if (image.source_path) source = { kind: "file", path: image.source_path }
    else return []
    const attachment: AttachmentContent = {
      type: "attachment",
      name: image.source_path ? basename(image.source_path) : "Image",
      mimeType: image.mime_type,
      source,
    }
    return [{ path: image.source_path, attachment }]
  })
}
