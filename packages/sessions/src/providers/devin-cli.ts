import { devinReferences, devinPromptImages, devinMcpCall } from "./devin-presentation.js"
import { todoDetails } from "../tool-plan.js"
import { attachmentFromUrl, type AttachmentContent } from "../content.js"
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
import { homedir } from "node:os"
import { join, sep } from "node:path"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import {
  clip,
  EntrySink,
  titleFrom,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
  type TurnUsage,
} from "../format.js"
import { normalizeToolOutput } from "../tool-output.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./types.js"

type SqliteFields = Record<string, SQLOutputValue>
type StoredTimestamp = number | undefined
type ToolBlock = Extract<EntryBlock, { type: "tool" }>
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
  thinking?: ChatContent
  tool_calls?: ToolCall[]
  tool_call_id?: string
  usage?: TurnUsage
}

interface DiscoveryRow {
  id: string
  activity: StoredTimestamp
  top: number
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
}

interface MessageTranslator {
  push(row: MessageRow): void
  snapshot(): ThreadEntry[]
}

let sqliteOpen: ((path: string) => DatabaseSync) | null | undefined

async function openDatabase(path: string): Promise<DatabaseSync | null> {
  if (sqliteOpen === undefined) {
    try {
      const sqlite = await import("node:sqlite")
      sqliteOpen = (file) => new sqlite.DatabaseSync(file, { readOnly: true })
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

/** Epoch seconds or millis — the store has carried both readings. */
function isoOf(value: StoredTimestamp): string | undefined {
  if (value === undefined || value <= 0) return undefined
  return new Date(value > 1e12 ? value : value * 1000).toISOString()
}

export class DevinCliProvider implements SessionProvider {
  harness = "devin" as const
  displayName = "Devin"
  /** One store, many sessions: a db write means re-discover, not re-stat. */
  rescanRoot = (): boolean => true
  rescanDebounceMs = 500

  private dir: string
  private db: DatabaseSync | null = null
  private dbIdentity: string | null = null

  constructor(home = homedir()) {
    this.dir = join(home, ".local", "share", "devin", "cli")
  }

  roots(): string[] {
    return [this.dir]
  }

  observationPaths(): string[] {
    const database = this.dbPath()
    return [database, `${database}-wal`]
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
    const identity = `${info.dev}:${info.ino}`
    if (this.db && this.dbIdentity === identity) return this.db
    this.db?.close()
    this.db = await openDatabase(this.dbPath())
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
                  COALESCE(s.main_chain_id, 0) AS top
           FROM sessions s WHERE s.hidden = 0`
        )
        .all()
      const rows = stored.map(parseDiscoveryRow).filter((row): row is DiscoveryRow => row !== null)
      const locked = await lockedSessionIds(this.lockPath(), rows.map(row => row.id))
      const files: NativeFile[] = []
      for (const row of rows) {
        const at = isoOf(row.activity)
        const isLocked = locked.has(row.id)
        // Synthetic sessions share one database; this fractional revision lets
        // lock-only changes invalidate one cached ref without moving its cursor.
        files.push({
          path: `${this.dbPath()}#${row.id}`,
          bytes: row.top,
          mtimeMs: (at ? Date.parse(at) : info.mtimeMs) + (isLocked ? 0.5 : 0),
          locked: isLocked,
        })
      }
      return files
    } catch {
      this.resetConnection()
      return []
    }
  }

  /** Remove a session and every row that names it; the read connection is reset so it cannot serve the ghost. */
  async remove(path: string): Promise<boolean> {
    const id = idOf(path)
    if (!id || path.slice(0, path.lastIndexOf("#")) !== this.dbPath()) return false
    this.resetConnection()
    return removeSessionRows(this.dbPath(), id, ["sessions"])
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
      let title = titleFrom(row.title)
      if (!title) {
        for (const entry of translatedMainChain(db, id, mainChainId(db, id))) {
          if (entry.kind !== "user") continue
          title = titleFrom(entry.text)
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
      const cursor = mainChainId(db, id)
      const into = translator()
      for (const row of mainChainRows(db, id, cursor)) into.push(row)
      ref.bytes = cursor
      return { ref, entries: into.snapshot() }
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
      next: async (): Promise<SessionUpdate> => {
        if (!id) return unchangedUpdate(cursor)
        const db = await this.connection()
        if (!db) return unchangedUpdate(cursor)
        try {
          if (previous === null) {
            previous = translatedMainChain(db, id, cursor).map(entryDigest)
          }
          const nextCursor = mainChainId(db, id)
          if (nextCursor === cursor) return unchangedUpdate(cursor)
          const current = translatedMainChain(db, id, nextCursor)
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
      "SELECT COALESCE(main_chain_id, 0) AS main_chain_id FROM sessions WHERE id = ?"
    )
    .get(sessionId)
  return stored && isSqliteNumber(stored.main_chain_id)
    ? stored.main_chain_id
    : 0
}

function mainChainRows(
  db: DatabaseSync,
  sessionId: string,
  leafId: number
): MessageRow[] {
  if (leafId <= 0) return []
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

function translatedMainChain(
  db: DatabaseSync,
  sessionId: string,
  leafId: number
): ThreadEntry[] {
  const into = translator()
  for (const row of mainChainRows(db, sessionId, leafId)) into.push(row)
  return into.snapshot()
}

function entryDigest(entry: ThreadEntry): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("base64url")
}

/** Native lock files accumulate after sessions disappear. Only read locks for
 * the sessions this operation actually returns; recheck their PIDs every time. */
async function lockedSessionIds(path: string, ids: string[]): Promise<Set<string>> {
  const locked = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 8) {
    await Promise.all(ids.slice(offset, offset + 8).map(async id => {
      // Session IDs are database data, never permission to read outside locks.
      if (id.includes("/") || id.includes("\\")) return
      const raw = await readFile(join(path, `${id}.lock`), "utf8").catch(() => "")
      const pid = Number(raw.trim())
      if (!Number.isInteger(pid) || pid <= 0) return
      try { process.kill(pid, 0); locked.add(id) } catch { /* No live lock owner. */ }
    }))
  }
  return locked
}

function translator(): MessageTranslator {
  const sink = new EntrySink()
  const tools = new Map<string, ToolBlock>()

  return {
    push(row) {
      if (!row.chatMessage) return
      const message = parseChatMessage(row.chatMessage)
      if (!message) return
      const at = isoOf(row.createdAt)
      if (message.role === "system") {
        const completion = parseSubagentCompletion(contentText(message.content))
        if (!completion) return
        sink.push({
          kind: "assistant",
          at,
          blocks: [
            {
              type: "tool",
              name: "subagent",
              input: JSON.stringify({
                agent_id: completion.id,
                status: completion.status,
              }),
              output: clip(completion.output),
              error: completion.status !== "completed",
            },
          ],
        })
        return
      }
      if (message.role === "user") {
        const prompt = devinPromptImages(contentText(message.content))
        const text = prompt.text
        const attachments = [...devinAttachments(message.content), ...prompt.attachments]
        if (text.trim() || attachments.length)
          sink.push({
            kind: "user",
            id: String(row.rowId),
            at,
            text,
            attachments,
          })
        return
      }
      if (message.role === "assistant") {
        const blocks: EntryBlock[] = [...devinAttachments(message.content)]
        const thinking = contentText(message.thinking)
        if (thinking.trim()) blocks.push({ type: "thinking", text: devinReferences(thinking) })
        for (const call of message.tool_calls ?? []) {
          const name = call.name ?? call.function?.name ?? "tool"
          const rawInput = call.arguments ?? call.function?.arguments
          const block: ToolBlock = {
            type: "tool",
            id: call.id,
            name,
            input: toolInputText(rawInput),
          }
          if (name === "todo_write") block.details = todoDetails(block.input)
          const mcp = name === "mcp_call_tool" ? devinMcpCall(block.input) : undefined
          if (mcp) { block.name = mcp.name; block.input = mcp.input }
          blocks.push(block)
          if (call.id) tools.set(call.id, block)
        }
        const text = contentText(message.content)
        if (text.trim()) blocks.push({ type: "text", text: devinReferences(text) })
        const usage = message.usage ?? row.usage
        if (blocks.length > 0 || usage) {
          const entry: Extract<ThreadEntry, { kind: "assistant" }> = {
            kind: "assistant",
            at,
            blocks,
          }
          if (usage) entry.usage = usage
          sink.push(entry)
        }
        return
      }
      if (message.role === "tool") {
        const block = message.tool_call_id
          ? tools.get(message.tool_call_id)
          : undefined
        if (!block) return
        const output = contentText(message.content)
        block.output = clip(normalizeToolOutput(output))
        const attachments = devinAttachments(message.content)
        if (attachments.length) block.attachments = attachments
      }
    },
    snapshot() {
      return sink.snapshot()
    },
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
  return {
    rowId: isSqliteNumber(fields.row_id) ? fields.row_id : 0,
    chatMessage: sqliteText(fields.chat_message),
    createdAt: sqliteNumber(fields.created_at),
    usage: parseUsage(sqliteText(fields.metadata)),
  }
}

function usageFromMetadata(
  metadata: JsonValue | undefined
): TurnUsage | undefined {
  if (!isJsonObject(metadata) || !isJsonObject(metadata.metrics))
    return undefined
  const values = {
    input: jsonNumber(metadata.metrics.input_tokens),
    output: jsonNumber(metadata.metrics.output_tokens),
    cacheRead: jsonNumber(metadata.metrics.cache_read_tokens),
    cacheWrite: jsonNumber(metadata.metrics.cache_creation_tokens),
  }
  const usage = Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, number] => entry[1] !== undefined
    )
  ) satisfies TurnUsage
  return Object.keys(usage).length > 0 ? usage : undefined
}

function parseUsage(text: string | undefined): TurnUsage | undefined {
  if (!text) return undefined
  try {
    const metadata: JsonValue = JSON.parse(text)
    return usageFromMetadata(metadata)
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
      thinking: parsed.thinking,
      tool_calls: parseToolCalls(parsed.tool_calls),
      tool_call_id: jsonText(parsed.tool_call_id),
      usage: usageFromMetadata(parsed.metadata),
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

function jsonNumber(value: JsonValue | undefined): number | undefined {
  return Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(Number(value))
    ? Number(value)
    : undefined
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

function toolInputText(input: JsonValue | undefined): string | undefined {
  if (input === undefined) return undefined
  return clip(isTextValue(input) ? input : JSON.stringify(input))
}

function idOf(path: string): string | null {
  const at = path.lastIndexOf("#")
  return at === -1 ? null : path.slice(at + 1) || null
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
