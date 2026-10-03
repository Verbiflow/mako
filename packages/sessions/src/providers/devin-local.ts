import { z } from "zod"
import { acpToolDetails } from "../acp-tool-details.js"
import { acpAttachments } from "../acp-attachments.js"
import { ProposedPlans, type AttachmentContent, type ToolDetail } from "../content.js"
import { DevinPlanCallSchema, DevinPlanTracker } from "./devin-plans.js"
/** Devin IDE journals: legacy ACP NDJSON and the current per-session SQLite
 * message store. Both reuse the ACP translator; native session identity comes
 * from the editor's message-store index, never the database's random filename.
 * SQLite snapshots are replaceable, not byte-tail journals. */

import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite"
import { openNativeStore } from "../read-only-sqlite.js"
import {
  agentTitleFrom,
  clip,
  EntrySink,
  titleFrom,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import {
  createJsonlFollower,
  readLines,
  snapshotSink,
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

interface AcpMetadata {
  timestamp?: string
  clientMessageId?: string
  inferenceToolName?: string
}

interface AcpEventBase {
  details?: ToolDetail[]
  attachments?: AttachmentContent[]
  at?: string
}

interface AcpUserMessage extends AcpEventBase {
  sessionUpdate: "user_message_chunk"
  text: string
  clientMessageId?: string
}

interface AcpAgentMessage extends AcpEventBase {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk"
  text: string
}

interface AcpToolCall extends AcpEventBase {
  sessionUpdate: "tool_call"
  name: string
  input?: string
  toolCallId?: string
  notification: JsonRecord
}

interface AcpToolCallUpdate extends AcpEventBase {
  sessionUpdate: "tool_call_update"
  output: string
  status?: string
  toolCallId?: string
  notification: JsonRecord
}

interface AcpPlanEntry {
  content?: string
  status?: string
}

interface AcpPlan extends AcpEventBase {
  sessionUpdate: "plan"
  entries: AcpPlanEntry[]
}

interface AcpCost {
  amount: number
  currency?: string
}

interface AcpUsage extends AcpEventBase {
  sessionUpdate: "usage_update"
  used?: number
  size?: number
  cost?: AcpCost
}

interface AcpSessionInfo extends AcpEventBase {
  sessionUpdate: "session_info_update"
  title?: string
}

interface AcpCurrentMode extends AcpEventBase {
  sessionUpdate: "current_mode_update"
}

type AcpEvent =
  | AcpUserMessage
  | AcpAgentMessage
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpPlan
  | AcpUsage
  | AcpSessionInfo
  | AcpCurrentMode

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type ToolBlock = Extract<AssistantEntry["blocks"][number], { type: "tool" }>

interface TranslatorState {
  title?: string
}

interface DevinTranslator extends LineTranslator {
  done(): ThreadEntry[]
  readonly title?: string
  unavailable(position: number): void
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
    const entries = into.done()
    if (!ref.title && into.title) ref.title = agentTitleFrom(into.title)
    return { ref, checkpoint, entries }
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

  private async readMessages(path: string, push: (raw: string) => void | boolean, skim = false, unavailable?: (position: number) => void): Promise<number> {
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
        const content = payload.content
        if (row.kind === "tool_call" && isJsonRecord(content)) {
          if (push(JSON.stringify({ notification: { ...content, sessionUpdate: "tool_call" } })) === false) break
          if (push(JSON.stringify({ notification: { ...content, sessionUpdate: "tool_call_update" } })) === false) break
        } else if (isJsonArray(content)) {
          let stopped = false
          for (const notification of content) {
            if (push(JSON.stringify({ notification })) === false) { stopped = true; break }
          }
          if (stopped) break
        }
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
      for (const candidate of db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'windsurf.acp.messageStore.session.%'").iterate()) {
        const fields = StoredIndex.parse(candidate)
        const entry = parseJson(fields.value)
        if (!isJsonRecord(entry)) continue
        const uuid = readString(entry, "uuid")
        const sessionId = fields.key.slice("windsurf.acp.messageStore.session.".length)
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

/**
 * ACP notifications → canonical entries. Chunk streams coalesce: a run of
 * `agent_message_chunk`s is one text block, a thought run one thinking
 * block, and tool calls pick up their updates by id. User chunks group by
 * the client message id so a multi-chunk prompt stays one entry.
 */
function journalOf(path: string): string {
  return basename(path).replace(/\.(?:ndjson|db)$/, "")
}

/** `journal` scopes plan cards; Mako runs no desktop session live, so they need not match a live id. */
function translator(journal: string): DevinTranslator {
  const sink = new EntrySink()
  const state: TranslatorState = {}
  const plans = new DevinPlanTracker()
  const cards = new ProposedPlans()
  let assistant: AssistantEntry | null = null
  let userId: string | null = null
  const toolsById = new Map<string, ToolBlock>()
  let started = false
  let needsReset = false

  const flushAssistant = (preserveTools = false) => {
    if (assistant) sink.push(assistant)
    assistant = null
    if (!preserveTools) toolsById.clear()
  }

  const ensureAssistant = (at?: string): AssistantEntry => {
    if (!assistant) assistant = { kind: "assistant", at, blocks: [] }
    return assistant
  }

  const appendText = (kind: "text" | "thinking", text: string, at?: string) => {
    const entry = ensureAssistant(at)
    const last = entry.blocks.at(-1)
    if (last && last.type === kind) {
      last.text += text
    } else {
      entry.blocks.push({ type: kind, text })
    }
  }

  const propose = (notification: JsonRecord, at?: string) => {
    const plan = plans.observe(DevinPlanCallSchema.safeParse(notification).data, journal)
    const block = plan && cards.propose(plan.id, plan.text)
    if (block) ensureAssistant(at).blocks.push(block)
  }

  const push = (raw: string): void => {
    const event = parseAcpEvent(raw)
    if (!event) return

    switch (event.sessionUpdate) {
      case "user_message_chunk": {
        if (!event.text && !event.attachments?.length) return
        const lastEntry = sink.entries.at(-1)
        if (
          event.clientMessageId &&
          event.clientMessageId === userId &&
          lastEntry?.kind === "user"
        ) {
          lastEntry.text += event.text
          if (event.attachments?.length)
            lastEntry.attachments = [
              ...(lastEntry.attachments ?? []),
              ...event.attachments,
            ]
          return
        }
        flushAssistant()
        userId = event.clientMessageId ?? null
        started = true
        const user: ThreadEntry = {
          kind: "user",
          at: event.at,
          text: event.text,
        }
        if (event.attachments?.length) user.attachments = event.attachments
        sink.push(user)
        return
      }
      case "agent_message_chunk":
        if (!started) needsReset = true
        started = true
        appendText("text", event.text, event.at)
        if (event.attachments?.length)
          ensureAssistant(event.at).blocks.push(...event.attachments)
        return
      case "agent_thought_chunk":
        if (!started) needsReset = true
        started = true
        appendText("thinking", event.text, event.at)
        return
      case "tool_call": {
        if (!started) needsReset = true
        started = true
        const entry = ensureAssistant(event.at)
        const block = createToolBlock(event.name, event.input)
        block.id = event.toolCallId
        if (event.details?.length) block.details = event.details
        if (event.attachments?.length) block.attachments = event.attachments
        entry.blocks.push(block)
        if (event.toolCallId) toolsById.set(event.toolCallId, block)
        propose(event.notification, event.at)
        return
      }
      case "tool_call_update": {
        const block = event.toolCallId
          ? toolsById.get(event.toolCallId)
          : undefined
        if (block) {
          if (event.details?.length) block.details = event.details
          if (event.attachments?.length) block.attachments = event.attachments
          if (event.output)
            block.output = clip(`${block.output ?? ""}${event.output}`)
          if (event.status === "failed") block.error = true
          if (/cancel/i.test(event.status ?? "")) block.canceled = true
        } else if (event.toolCallId) {
          needsReset = true
        }
        propose(event.notification, event.at)
        return
      }
      case "plan":
        flushAssistant()
        sink.push({
          kind: "assistant",
          at: event.at,
          blocks: [
            {
              type: "tool",
              name: "Plan",
              output: "",
              details: [
                {
                  type: "plan",
                  entries: event.entries.flatMap((entry) =>
                    entry.content
                      ? [
                          {
                            content: entry.content,
                            status: entry.status ?? "pending",
                          },
                        ]
                      : []
                  ),
                },
              ],
            },
          ],
        })
        return
      case "usage_update":
        flushAssistant(true)
        sink.push({
          kind: "event",
          at: event.at,
          label: "Context usage",
          detail: [
            event.used !== undefined ? `${event.used} used` : "",
            event.size !== undefined ? `${event.size} available` : "",
            event.cost
              ? `${event.cost.amount}${event.cost.currency ? ` ${event.cost.currency}` : ""} spent`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        })
        return
      case "session_info_update":
        state.title = agentTitleFrom(event.title) ?? state.title
        return
      case "current_mode_update":
        flushAssistant()
        return
    }
  }

  return {
    push,
    unavailable: (position) => {
      flushAssistant()
      sink.push({ kind: "event", label: "Message unavailable", detail: "This native record exceeds the history read limit. The original remains in the IDE store.", source: { harness: "devin", record: `${journal}:messages/${position}` } })
    },
    snapshot: () => {
      const entries = snapshotSink(sink)
      return assistant ? [...entries, assistant] : entries
    },
    done: () => {
      flushAssistant()
      return snapshotSink(sink)
    },
    commitBatch: () => flushAssistant(true),
    get title() {
      return state.title
    },
    get needsReset() {
      return needsReset
    },
  }
}

function createToolBlock(name: string, input?: string): ToolBlock {
  return { type: "tool", name, input }
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

function parseAcpEvent(raw: string): AcpEvent | null {
  const root = parseJson(raw)
  if (!isJsonRecord(root)) return null
  const notification = root["notification"]
  if (!isJsonRecord(notification)) return null
  const sessionUpdate = readString(notification, "sessionUpdate")
  if (!sessionUpdate) return null
  const metadata = parseAcpMetadata(notification["_meta"])
  const at = metadata.timestamp

  switch (sessionUpdate) {
    case "user_message_chunk":
      return {
        sessionUpdate,
        at,
        text: parseAcpContent(notification["content"]),
        attachments: acpAttachments(notification["content"]),
        details: acpToolDetails(notification["content"]),
        clientMessageId: metadata.clientMessageId,
      }
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return {
        sessionUpdate,
        at,
        text: parseAcpContent(notification["content"]),
        attachments: acpAttachments(notification["content"]),
        details: acpToolDetails(notification["content"]),
      }
    case "tool_call":
      return {
        sessionUpdate,
        at,
        name:
          metadata.inferenceToolName ??
          readString(notification, "title") ??
          "tool",
        input: formatJson(notification["rawInput"]),
        attachments: acpAttachments(notification["content"]),
        details: acpToolDetails(notification["content"]),
        toolCallId: readString(notification, "toolCallId"),
        notification,
      }
    case "tool_call_update":
      return {
        sessionUpdate,
        at,
        output: parseAcpContent(notification["content"]),
        status: readString(notification, "status"),
        attachments: acpAttachments(notification["content"]),
        details: acpToolDetails(notification["content"]),
        toolCallId: readString(notification, "toolCallId"),
        notification,
      }
    case "plan":
      return {
        sessionUpdate,
        at,
        entries: parsePlanEntries(notification["entries"]),
      }
    case "usage_update":
      return {
        sessionUpdate,
        at,
        used: readNumber(notification, "used"),
        size: readNumber(notification, "size"),
        cost: parseAcpCost(notification["cost"]),
      }
    case "session_info_update":
      return { sessionUpdate, at, title: readString(notification, "title") }
    case "current_mode_update":
      return { sessionUpdate, at }
    default:
      return null
  }
}

function parseAcpMetadata(value: JsonValue | undefined): AcpMetadata {
  if (!isJsonRecord(value)) return {}
  return {
    timestamp: readString(value, "cognition.ai/timestamp"),
    clientMessageId: readString(value, "cognition.ai/clientMessageId"),
    inferenceToolName: readString(value, "cognition.ai/inferenceToolName"),
  }
}

function parsePlanEntries(value: JsonValue | undefined): AcpPlanEntry[] {
  if (!isJsonArray(value)) return []
  const entries: AcpPlanEntry[] = []
  for (const candidate of value) {
    if (!isJsonRecord(candidate)) continue
    const content = readString(candidate, "content")
    const status = readString(candidate, "status")
    if (content || status) entries.push({ content, status })
  }
  return entries
}

function parseAcpCost(value: JsonValue | undefined): AcpCost | undefined {
  if (!isJsonRecord(value)) return undefined
  const amount = readNumber(value, "amount")
  if (amount === undefined) return undefined
  return { amount, currency: readString(value, "currency") }
}

function parseAcpContent(value: JsonValue | undefined): string {
  if (isStringValue(value)) return value
  if (isJsonArray(value))
    return value.map(parseAcpContent).filter(Boolean).join("\n")
  if (!isJsonRecord(value)) return ""
  const text = readString(value, "text")
  if (text) return text
  const content = parseAcpContent(value["content"])
  return content || parseAcpContent(value["resource"])
}

function formatJson(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isStringValue(value)) return value
  return JSON.stringify(value)
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
