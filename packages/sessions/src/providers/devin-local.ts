import { acpToolDetails } from "../acp-tool-details.js"
import { acpAttachments } from "../acp-attachments.js"
import { ProposedPlans, type AttachmentContent, type ToolDetail } from "../content.js"
import { DevinPlanCallSchema, DevinPlanTracker } from "./devin-plans.js"
/**
 * Devin, running locally.
 *
 * Devin's desktop app is a VS Code lineage editor driving `devin-cli` over
 * ACP, and it journals every session as append-only NDJSON — one file per
 * session under `~/Library/Application Support/Devin/User/acp-events/`,
 * each line an ACP `session/update` notification with a timestamp in
 * `_meta`. Titles, working directories, and the model in force live in the
 * editor's global `state.vscdb` (`windsurf.acp.metadataCache`, with
 * `windsurf.acp.eventLog.index` mapping session ids to journal uuids).
 *
 * Append-only NDJSON lets these sessions tail incrementally: a Devin turn
 * streams into the catalog live, byte offset by byte offset.
 *
 * SQLite comes from `node:sqlite`, loaded lazily like the Cursor provider
 * does; a runtime without it (or a machine without Devin) contributes
 * nothing rather than failing.
 */

import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite"
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
import type { NativeFile, SessionProvider } from "./types.js"

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

type SqliteStatementResult = ReturnType<StatementSync["get"]>

interface StateValueRow {
  value: string
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
}

export class DevinLocalProvider implements SessionProvider {
  harness = "devin" as const
  displayName = "Devin"

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
    return [join(this.userDir, "acp-events")]
  }

  async discover(): Promise<NativeFile[]> {
    const root = this.roots()[0]!
    const names = await readdir(root).catch(() => new Array<string>())
    const files: NativeFile[] = []
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue
      const path = join(root, name)
      const info = await stat(path).catch(() => null)
      if (info?.isFile())
        files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
    }
    return files
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const meta = await this.metaFor(basename(file.path, ".ndjson"))
    // The IDE names sessions "acp/devin-cli/<name>"; the CLI's own store
    // says just "<name>". One session, one identity — normalized here so
    // the catalog's dedupe collapses the two views of the same thread.
    const rawId = meta?.sessionId ?? basename(file.path, ".ndjson")
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
      await readLines(file.path, 0, (line) => {
        budget -= line.length + 1
        skim.push(line)
        return budget > 0
      })
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
    const checkpoint = await readLines(path, 0, into.push)
    const entries = into.done()
    if (!ref.title && into.title) ref.title = agentTitleFrom(into.title)
    return { ref, checkpoint, entries }
  }

  createFollower(path: string, fromByte: number) {
    return createJsonlFollower(path, fromByte, () => translator(journalOf(path)))
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = translator(journalOf(path))
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }

  /* ---------------------------------------------------------- metadata */

  private async metaFor(uuid: string): Promise<SessionMeta | null> {
    await this.refreshMeta()
    return this.metaByUuid.get(uuid) ?? null
  }

  private async refreshMeta(): Promise<void> {
    const dbPath = join(this.userDir, "globalStorage", "state.vscdb")
    const info = await stat(dbPath).catch(() => null)
    if (!info || info.mtimeMs === this.metaLoadedAtMs) return
    const db = await openDatabase(dbPath)
    if (!db) return
    try {
      const statement = db.prepare("SELECT value FROM ItemTable WHERE key = ?")
      const row = (key: string): StateValueRow | null =>
        parseStateValueRow(statement.get(key))
      const indexRaw = row("windsurf.acp.eventLog.index")?.value
      const metaRaw = row("windsurf.acp.metadataCache")?.value
      if (!indexRaw || !metaRaw) return
      const index = parseEventLogIndex(indexRaw)
      const cache = parseSessionCache(metaRaw)
      if (!index || !cache) return
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
      this.metaLoadedAtMs = info.mtimeMs
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
  return basename(path, ".ndjson")
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
