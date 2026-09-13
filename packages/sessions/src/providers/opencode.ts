import { attachmentFromUrl, type AttachmentContent } from "../content.js"
import { stat } from "node:fs/promises"
import { removeSessionRows } from "../sqlite-removal.js"
import { homedir } from "node:os"
import { join } from "node:path"
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

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]
type SqliteFields = Record<string, SQLOutputValue>
type StoreKind = "current" | "legacy"
type ToolBlock = Extract<EntryBlock, { type: "tool" }>

interface JsonObject {
  [key: string]: JsonValue | undefined
}

interface StoredModel {
  id?: string
  provider?: string
  effort?: string
}

interface SessionRow {
  id: string
  directory?: string
  projectWorktree?: string
  projectName?: string
  title?: string
  model?: JsonObject
  startedAt?: number
  updatedAt?: number
  archived: boolean
  revision: number
}

interface StoredRow {
  id: string
  type?: string
  timeCreated?: number
  data: JsonObject
}

interface Snapshot {
  revision: number
  entries: ThreadEntry[]
  values: string[]
}

const MAX_SESSIONS = 20_000
const MAX_MESSAGES = 12_000
const MAX_PARTS = 48_000

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

export class OpenCodeProvider implements SessionProvider {
  harness = "opencode" as const
  displayName = "OpenCode"
  /** One database, many sessions: a write means re-discover, not re-stat. */
  rescanRoot = (): boolean => true
  rescanDebounceMs = 250

  private root: string
  private snapshots = new Map<string, Snapshot>()

  constructor(home = homedir()) {
    this.root = join(home, ".local", "share", "opencode")
  }

  roots(): string[] {
    return [this.root]
  }

  /**
   * The root also holds logs, shell transcripts, snapshots and tool output
   * that a running agent writes continuously; only the databases hold
   * sessions.
   */
  watchTarget(path: string): string | null {
    return this.databasePaths().some((database) => path.startsWith(database))
      ? path
      : null
  }

  async discover(): Promise<NativeFile[]> {
    const stores = await Promise.all(
      this.databasePaths().map(async (path) => {
        const info = await stat(path).catch(() => null)
        if (!info?.isFile()) return []
        const database = await openDatabase(path)
        if (!database) return []
        try {
          const files: NativeFile[] = []
          const kind = storeKind(database, path)
          if (kind) {
            files.push(
              ...sessionRows(database, kind, MAX_SESSIONS).map((row) => ({
                path: sessionPath(path, row.id),
                bytes: row.revision,
                mtimeMs: row.updatedAt ?? info.mtimeMs,
              }))
            )
          }
          if (
            hasTable(database, "session_v2") &&
            hasTable(database, "session_message")
          ) {
            files.push(
              ...sessionRows(
                database,
                "current",
                MAX_SESSIONS,
                "session_v2"
              ).map((row) => ({
                path: sessionPath(path, row.id, true),
                bytes: row.revision,
                mtimeMs: row.updatedAt ?? info.mtimeMs,
              }))
            )
          }
          return files
        } catch {
          return []
        } finally {
          database.close()
        }
      })
    )
    return stores.flat()
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const target = parseSessionPath(file.path, this.databasePaths())
    if (!target) return null
    const database = await openDatabase(target.database)
    if (!database) return null
    try {
      const kind = target.v2 ? "current" : storeKind(database, target.database)
      if (!kind) return null
      const row = sessionRow(
        database,
        kind,
        target.id,
        target.v2 ? "session_v2" : "session"
      )
      if (!row) return null
      const model = modelFromSession(row) ?? latestModel(database, kind, row.id)
      const ref = refFrom(row, file.path, file.bytes, model)
      ref.title ??= firstUserTitle(database, kind, row.id)
      return ref
    } catch {
      return null
    } finally {
      database.close()
    }
  }

  async read(path: string): Promise<Thread | null> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return null
    const database = await openDatabase(target.database)
    if (!database) return null
    try {
      const kind = target.v2 ? "current" : storeKind(database, target.database)
      if (!kind) return null
      database.exec("BEGIN")
      const row = sessionRow(
        database,
        kind,
        target.id,
        target.v2 ? "session_v2" : "session"
      )
      if (!row) {
        database.exec("COMMIT")
        return null
      }
      const entries =
        kind === "current"
          ? currentEntries(database, row.id)
          : legacyEntries(database, row.id)
      const model =
        modelFromSession(row) ??
        latestModel(database, kind, row.id) ??
        modelFromEntries(entries)
      const ref = refFrom(row, path, row.revision, model)
      ref.title ??= firstUserTitle(database, kind, row.id)
      database.exec("COMMIT")
      this.snapshots.set(path, {
        revision: row.revision,
        entries: structuredClone(entries),
        values: entries.map((entry) => JSON.stringify(entry)),
      })
      return { ref, entries }
    } catch {
      try {
        database.exec("ROLLBACK")
      } catch {}
      return null
    } finally {
      database.close()
    }
  }

  createFollower(path: string, fromByte: number): SessionFollower {
    const held = this.snapshots.get(path)
    let cursor = fromByte
    let previous =
      held?.revision === fromByte
        ? [...held.values]
        : fromByte === 0
          ? []
          : null

    return {
      get offset() {
        return cursor
      },
      next: async (): Promise<SessionUpdate> => {
        const revision = await this.revision(path)
        if (revision === null || revision === cursor)
          return unchangedUpdate(cursor)
        const thread = await this.read(path)
        const snapshot = this.snapshots.get(path)
        if (!thread || !snapshot) return unchangedUpdate(cursor)
        const current = snapshot.values
        if (previous === null) {
          previous = [...current]
          cursor = snapshot.revision
          return {
            entries: structuredClone(thread.entries),
            nextByte: cursor,
            replace: true,
            replaceFrom: 0,
            reset: true,
          }
        }
        let shared = 0
        while (
          shared < previous.length &&
          shared < current.length &&
          previous[shared] === current[shared]
        ) {
          shared += 1
        }
        const appended = shared === previous.length
        const entries = appended
          ? thread.entries.slice(previous.length)
          : thread.entries.slice(shared)
        previous = [...current]
        cursor = snapshot.revision
        const update: SessionUpdate = {
          entries: structuredClone(entries),
          nextByte: cursor,
          replace: !appended,
        }
        if (!appended) {
          update.replaceFrom = shared
          update.reset = true
        }
        return update
      },
    }
  }

  private databasePaths(): string[] {
    return [join(this.root, "opencode.db"), join(this.root, "opencode-next.db")]
  }

  /** Remove a session and its messages, parts, and child sessions from the store it lives in. */
  async remove(path: string): Promise<boolean> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return false
    return removeSessionRows(target.database, target.id, ["session", "session_v2"])
  }

  private async revision(path: string): Promise<number | null> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return null
    const database = await openDatabase(target.database)
    if (!database) return null
    try {
      const kind = target.v2 ? "current" : storeKind(database, target.database)
      return kind
        ? (sessionRow(
            database,
            kind,
            target.id,
            target.v2 ? "session_v2" : "session"
          )?.revision ?? null)
        : null
    } catch {
      return null
    } finally {
      database.close()
    }
  }
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  )
}

function storeKind(database: DatabaseSync, path: string): StoreKind | null {
  const names = new Set(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part', 'session_message')"
      )
      .all()
      .map((row) => sqliteText(row.name))
      .filter((name): name is string => name !== undefined)
  )
  if (!names.has("session")) return null
  const legacy = names.has("message") && names.has("part")
  if (!path.endsWith("opencode-next.db") && legacy) return "legacy"
  if (names.has("session_message")) return "current"
  return legacy ? "legacy" : null
}

function sessionRows(
  database: DatabaseSync,
  kind: StoreKind,
  limit: number,
  sessionTable = "session"
): SessionRow[] {
  const rows = database
    .prepare(sessionQuery(kind, false, sessionTable))
    .all(limit)
  return rows
    .map(parseSessionRow)
    .filter((row): row is SessionRow => row !== null)
}

function sessionRow(
  database: DatabaseSync,
  kind: StoreKind,
  id: string,
  sessionTable = "session"
): SessionRow | null {
  const stored = database
    .prepare(sessionQuery(kind, true, sessionTable))
    .get(id)
  return stored ? parseSessionRow(stored) : null
}

function sessionQuery(
  kind: StoreKind,
  one: boolean,
  sessionTable = "session"
): string {
  const source = kind === "current" ? "session_message" : "message"
  const partRevision =
    kind === "legacy"
      ? ", COALESCE((SELECT MAX(p2.time_updated) FROM part p2 WHERE p2.session_id = s.id), 0)"
      : ""
  const partCount =
    kind === "legacy"
      ? " + (SELECT COUNT(*) FROM part p3 WHERE p3.session_id = s.id)"
      : ""
  const model = kind === "current" ? ", s.model AS model" : ""
  const where = one
    ? "s.id = ?"
    : sessionTable === "session_v2"
      ? "s.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM session legacy WHERE legacy.id = s.id)"
      : "s.parent_id IS NULL"
  const suffix = one
    ? "LIMIT 1"
    : "ORDER BY s.time_updated DESC, s.id DESC LIMIT ?"
  return `SELECT s.id AS id, s.directory AS directory, s.title AS title,
                 s.time_created AS time_created, s.time_updated AS time_updated,
                 s.time_archived AS time_archived, p.worktree AS project_worktree,
                 p.name AS project_name${model},
                 MAX(s.time_updated,
                     COALESCE((SELECT MAX(m.time_updated) FROM ${source} m WHERE m.session_id = s.id), 0)
                     ${partRevision}) AS revision_time,
                 ((SELECT COUNT(*) FROM ${source} m2 WHERE m2.session_id = s.id)${partCount}) AS revision_count
          FROM ${sessionTable} s LEFT JOIN project p ON p.id = s.project_id
          WHERE ${where} ${suffix}`
}

function parseSessionRow(fields: SqliteFields): SessionRow | null {
  const id = sqliteText(fields.id)
  if (!id) return null
  const updatedAt = sqliteNumber(fields.time_updated)
  const revisionTime = sqliteNumber(fields.revision_time) ?? updatedAt ?? 0
  return {
    id,
    directory: sqliteText(fields.directory),
    projectWorktree: sqliteText(fields.project_worktree),
    projectName: sqliteText(fields.project_name),
    title: sqliteText(fields.title),
    model: parseObject(sqliteText(fields.model)),
    startedAt: sqliteNumber(fields.time_created),
    updatedAt,
    archived:
      fields.time_archived !== null && fields.time_archived !== undefined,
    revision: revisionOf(
      revisionTime,
      sqliteNumber(fields.revision_count) ?? 0
    ),
  }
}

function refFrom(
  row: SessionRow,
  path: string,
  revision: number,
  model: StoredModel | null
): ThreadRef {
  const title = titleFrom(row.title) ?? titleFrom(row.projectName)
  const modelId =
    model?.id && model.provider && !model.id.includes("/")
      ? `${model.provider}/${model.id}`
      : model?.id
  const ref: ThreadRef = {
    harness: "opencode",
    nativeId: row.id,
    path,
    cwd: row.directory ?? row.projectWorktree,
    title,
    model: modelId,
    settings: { model: modelId },
    modelProvider: model?.provider,
    startedAt: isoOf(row.startedAt),
    updatedAt: isoOf(row.updatedAt),
    bytes: revision,
    archived: row.archived,
  }
  if (model?.effort) ref.settings = { model: modelId, options: { effort: model.effort } }
  return ref
}

function firstUserTitle(
  database: DatabaseSync,
  kind: StoreKind,
  sessionId: string
): string | undefined {
  try {
    const rows =
      kind === "current"
        ? database
            .prepare(
              "SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq, id LIMIT 20"
            )
            .all(sessionId)
        : database
            .prepare(
              `SELECT p.data FROM message m JOIN part p ON p.message_id = m.id
               WHERE m.session_id = ?
                 AND json_extract(m.data, '$.role') = 'user'
                 AND json_extract(p.data, '$.type') = 'text'
                 AND COALESCE(json_extract(p.data, '$.synthetic'), 0) != 1
                 AND COALESCE(json_extract(p.data, '$.ignored'), 0) != 1
               ORDER BY m.time_created, m.id, p.id LIMIT 20`
            )
            .all(sessionId)
    for (const row of rows) {
      const data = parseObject(sqliteText(row.data))
      const title = titleFrom(data ? jsonText(data.text) : undefined)
      if (title) return title
    }
  } catch {
    return undefined
  }
  return undefined
}

function latestModel(
  database: DatabaseSync,
  kind: StoreKind,
  sessionId: string
): StoredModel | null {
  const table = kind === "current" ? "session_message" : "message"
  const rows = database
    .prepare(
      `SELECT data FROM ${table} WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 20`
    )
    .all(sessionId)
  for (const row of rows) {
    const data = parseObject(sqliteText(row.data))
    if (!data) continue
    const model = modelFromData(data)
    if (model?.id || model?.provider) return model
  }
  return null
}

function currentEntries(
  database: DatabaseSync,
  sessionId: string
): ThreadEntry[] {
  const stored = database
    .prepare(
      `SELECT id, type, time_created, data FROM (
         SELECT id, type, seq, time_created, data FROM session_message
         WHERE session_id = ? ORDER BY seq DESC, id DESC LIMIT ?
       ) ORDER BY seq, id`
    )
    .all(sessionId, MAX_MESSAGES)
  const sink = new EntrySink()
  for (const fields of stored) {
    const row = parseStoredRow(fields)
    if (row) pushCurrent(sink, row)
  }
  return sink.done()
}

function legacyEntries(
  database: DatabaseSync,
  sessionId: string
): ThreadEntry[] {
  const messages = database
    .prepare(
      `SELECT id, time_created, data FROM (
         SELECT id, time_created, data FROM message
         WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?
       ) ORDER BY time_created, id`
    )
    .all(sessionId, MAX_MESSAGES)
    .map(parseStoredRow)
    .filter((row): row is StoredRow => row !== null)
  if (messages.length === 0) return []
  const parts = database
    .prepare(
      `SELECT id, message_id, time_created, data FROM (
         SELECT p.id, p.message_id, p.time_created, p.data
         FROM part p JOIN (
           SELECT id FROM message WHERE session_id = ?
           ORDER BY time_created DESC, id DESC LIMIT ?
         ) selected ON selected.id = p.message_id
         ORDER BY p.id DESC LIMIT ?
       ) ORDER BY id`
    )
    .all(sessionId, MAX_MESSAGES, MAX_PARTS)
  const byMessage = new Map<string, StoredRow[]>()
  for (const fields of parts) {
    const row = parseStoredRow(fields)
    const messageId = sqliteText(fields.message_id)
    if (!row || !messageId) continue
    const held = byMessage.get(messageId)
    if (held) held.push(row)
    else byMessage.set(messageId, [row])
  }
  const sink = new EntrySink()
  for (const message of messages)
    pushLegacy(sink, message, byMessage.get(message.id) ?? [])
  return sink.done()
}

function pushCurrent(sink: EntrySink, row: StoredRow): void {
  const type = row.type ?? jsonText(row.data.type)
  const at = isoOf(timeCreated(row.data) ?? row.timeCreated)
  if (type === "user") {
    const text = jsonText(row.data.text)
    const attachments = fileParts([
      ...(Array.isArray(row.data.content) ? row.data.content : []),
      ...(Array.isArray(row.data.parts) ? row.data.parts : []),
      ...(Array.isArray(row.data.files) ? row.data.files : []),
    ])
    if (text?.trim() || attachments.length)
      sink.push({ kind: "user", id: row.id, at, text: text ?? "", attachments })
    return
  }
  if (type === "assistant") {
    const blocks = assistantContent(row.data.content)
    const usage = usageFrom(row.data)
    const model = modelFromData(row.data)
    if (blocks.length > 0 || usage)
      pushAssistant(sink, at, model?.id, usage, blocks)
    if (isInterrupted(row.data))
      sink.push({ kind: "event", at, label: "Interrupted" })
    return
  }
  if (type === "shell") {
    const command = jsonText(row.data.command)
    const output = jsonText(row.data.output)
    sink.push({
      kind: "assistant",
      at,
      blocks: [
        {
          type: "tool",
          name: "shell",
          input: clip(command),
          output: clip(normalizeToolOutput(output)),
        },
      ],
    })
    return
  }
  if (type === "compaction") {
    pushCompaction(sink, at, jsonText(row.data.reason) === "auto")
    return
  }
  if (type === "model-switched") {
    const model = jsonObject(row.data.model)
    const id = model ? jsonText(model.id) : undefined
    const provider = model ? jsonText(model.providerID) : undefined
    sink.push({
      kind: "event",
      at,
      label: "Model changed",
      detail: modelLabel(id, provider),
    })
    return
  }
  if (type === "agent-switched") {
    const agent = jsonText(row.data.agent)
    sink.push({ kind: "event", at, label: "Agent changed", detail: agent })
  }
}

function pushLegacy(
  sink: EntrySink,
  message: StoredRow,
  parts: StoredRow[]
): void {
  const role = jsonText(message.data.role)
  const at = isoOf(timeCreated(message.data) ?? message.timeCreated)
  const compaction = parts.find(
    (part) => jsonText(part.data.type) === "compaction"
  )
  if (compaction) {
    pushCompaction(sink, at, jsonBoolean(compaction.data.auto) === true)
    return
  }
  if (role === "user") {
    const text = parts
      .filter(
        (part) =>
          jsonText(part.data.type) === "text" &&
          jsonBoolean(part.data.synthetic) !== true &&
          jsonBoolean(part.data.ignored) !== true
      )
      .map((part) => jsonText(part.data.text) ?? "")
      .filter((value) => value.trim().length > 0)
      .join("\n")
    const attachments = fileParts(parts.map((part) => part.data))
    if (text || attachments.length)
      sink.push({ kind: "user", id: message.id, at, text, attachments })
    return
  }
  if (role !== "assistant") return
  const blocks: EntryBlock[] = []
  let usage = usageFrom(message.data)
  for (const part of parts) {
    const type = jsonText(part.data.type)
    if (type === "file") {
      blocks.push(...fileParts([part.data]))
      continue
    }
    if (type === "reasoning") {
      const text = jsonText(part.data.text)
      if (text) blocks.push({ type: "thinking", text })
      continue
    }
    if (type === "text") {
      const text = jsonText(part.data.text)
      if (
        text &&
        jsonBoolean(part.data.synthetic) !== true &&
        jsonBoolean(part.data.ignored) !== true
      )
        blocks.push({ type: "text", text })
      continue
    }
    if (type === "tool") {
      blocks.push(toolBlock(part.data, "legacy"))
      continue
    }
    if (type === "step-finish") usage = usageFrom(part.data) ?? usage
  }
  const model = modelFromData(message.data)
  if (blocks.length > 0 || usage)
    pushAssistant(sink, at, model?.id, usage, blocks)
  if (isInterrupted(message.data))
    sink.push({ kind: "event", at, label: "Interrupted" })
}

function pushAssistant(
  sink: EntrySink,
  at: string | undefined,
  model: string | undefined,
  usage: TurnUsage | undefined,
  blocks: EntryBlock[]
): void {
  const entry: Extract<ThreadEntry, { kind: "assistant" }> = {
    kind: "assistant",
    blocks,
  }
  if (at !== undefined) entry.at = at
  if (model !== undefined) entry.model = model
  if (usage !== undefined) entry.usage = usage
  sink.push(entry)
}

function assistantContent(value: JsonValue | undefined): EntryBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: EntryBlock[] = []
  for (const part of value) {
    if (!isJsonObject(part)) continue
    const type = jsonText(part.type)
    if (type === "text") {
      const text = jsonText(part.text)
      if (text) blocks.push({ type: "text", text })
      continue
    }
    if (type === "reasoning") {
      const text = jsonText(part.text)
      if (text) blocks.push({ type: "thinking", text })
      continue
    }
    if (type === "file") blocks.push(...fileParts([part]))
    if (type === "tool") blocks.push(toolBlock(part, "current"))
  }
  return blocks
}

function toolBlock(data: JsonObject, kind: StoreKind): ToolBlock {
  const state = jsonObject(data.state)
  const status = state ? jsonText(state.status) : undefined
  const name = jsonText(data.tool) ?? jsonText(data.name) ?? "tool"
  const input = state?.input
  const block: ToolBlock = {
    type: "tool",
    name,
    input: clip(formatJson(input)),
  }
  const id = jsonText(data.callID) ?? jsonText(data.id)
  if (id) block.id = id
  if (!state) return block
  const attachments = fileParts(state.attachments ?? state.content)
  if (attachments.length) block.attachments = attachments
  if (status === "completed") {
    const output =
      kind === "legacy"
        ? jsonText(state.output)
        : contentText(state.content) || formatJson(state.result)
    block.output = clip(normalizeToolOutput(output))
    return block
  }
  if (status === "error") {
    const error =
      kind === "legacy"
        ? jsonText(state.error)
        : contentText(state.content) || errorText(state.error)
    block.output = clip(normalizeToolOutput(error))
    block.error = true
  }
  if (/cancel/i.test(status ?? "")) block.canceled = true
  return block
}

function usageFrom(data: JsonObject): TurnUsage | undefined {
  const tokens = jsonObject(data.tokens)
  const cache = tokens ? jsonObject(tokens.cache) : undefined
  const values = {
    input: tokens ? jsonNumber(tokens.input) : undefined,
    output: tokens ? jsonNumber(tokens.output) : undefined,
    cacheRead: cache ? jsonNumber(cache.read) : undefined,
    cacheWrite: cache ? jsonNumber(cache.write) : undefined,
    costUsd: jsonNumber(data.cost),
  }
  const usage = Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, number] => entry[1] !== undefined
    )
  ) satisfies TurnUsage
  return Object.keys(usage).length > 0 ? usage : undefined
}

function modelFromSession(
  row: SessionRow
): StoredModel | null {
  if (!row.model) return null
  return {
    id: jsonText(row.model.id) ?? jsonText(row.model.modelID),
    provider: jsonText(row.model.providerID),
    effort: jsonText(row.model.variant),
  }
}

function modelFromData(
  data: JsonObject
): StoredModel | null {
  const model = jsonObject(data.model)
  const id =
    jsonText(data.modelID) ??
    (model ? (jsonText(model.id) ?? jsonText(model.modelID)) : undefined)
  const provider =
    jsonText(data.providerID) ??
    (model ? jsonText(model.providerID) : undefined)
  const effort = jsonText(data.variant) ?? (model ? jsonText(model.variant) : undefined)
  return id || provider ? { id, provider, effort } : null
}

function modelFromEntries(
  entries: ThreadEntry[]
): StoredModel | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind === "assistant" && entry.model) return { id: entry.model }
  }
  return null
}

function pushCompaction(
  sink: EntrySink,
  at: string | undefined,
  automatic: boolean
): void {
  sink.push({
    kind: "event",
    at,
    label: "Context compacted",
    detail: automatic ? "Automatic" : "Manual",
  })
}

function isInterrupted(data: JsonObject): boolean {
  const finish = jsonText(data.finish)?.toLowerCase()
  if (
    finish &&
    ["abort", "aborted", "cancelled", "interrupted"].includes(finish)
  )
    return true
  const error = jsonObject(data.error)
  if (!error) return false
  const name = (
    jsonText(error.name) ??
    jsonText(error.type) ??
    ""
  ).toLowerCase()
  const message = errorText(error).toLowerCase()
  return (
    name.includes("abort") ||
    name.includes("interrupt") ||
    message.includes("interrupt")
  )
}

function errorText(value: JsonValue | undefined): string {
  if (isStringValue(value)) return value
  if (!isJsonObject(value)) return ""
  const direct = jsonText(value.message)
  if (direct) return direct
  const data = jsonObject(value.data)
  return data ? (jsonText(data.message) ?? "") : ""
}

function contentText(value: JsonValue | undefined): string {
  if (isStringValue(value)) return value
  if (Array.isArray(value))
    return value.map(contentText).filter(Boolean).join("\n")
  if (!isJsonObject(value)) return ""
  const text = jsonText(value.text)
  if (text) return text
  if (
    isStringValue(value.value) ||
    isNumberValue(value.value) ||
    isBooleanValue(value.value)
  )
    return String(value.value)
  return value.content !== undefined ? contentText(value.content) : ""
}

function parseStoredRow(fields: SqliteFields): StoredRow | null {
  const id = sqliteText(fields.id)
  const data = parseObject(sqliteText(fields.data))
  if (!id || !data) return null
  return {
    id,
    type: sqliteText(fields.type),
    timeCreated: sqliteNumber(fields.time_created),
    data,
  }
}

function parseObject(raw: string | undefined): JsonObject | undefined {
  if (!raw) return undefined
  try {
    const parsed: JsonValue = JSON.parse(raw)
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function timeCreated(data: JsonObject): number | undefined {
  const time = jsonObject(data.time)
  return time ? (jsonNumber(time.created) ?? jsonNumber(time.start)) : undefined
}

function revisionOf(timestamp: number, count: number): number {
  const safeTimestamp = Math.max(0, Math.floor(timestamp))
  const safeCount = Math.max(0, Math.floor(count)) % 1000
  return safeTimestamp * 1000 + safeCount
}

function isoOf(value: number | undefined): string | undefined {
  if (value === undefined || value <= 0) return undefined
  return new Date(value > 1e12 ? value : value * 1000).toISOString()
}

function sessionPath(database: string, id: string, v2 = false): string {
  return `${database}#${v2 ? "v2:" : ""}${encodeURIComponent(id)}`
}

function parseSessionPath(
  path: string,
  databases: string[]
): { database: string; id: string; v2: boolean } | null {
  const at = path.lastIndexOf("#")
  if (at === -1) return null
  const database = path.slice(0, at)
  if (!databases.includes(database)) return null
  try {
    const fragment = path.slice(at + 1)
    const v2 = fragment.startsWith("v2:")
    const id = decodeURIComponent(v2 ? fragment.slice(3) : fragment)
    return id ? { database, id, v2 } : null
  } catch {
    return null
  }
}

function modelLabel(
  id: string | undefined,
  provider: string | undefined
): string | undefined {
  if (id && provider) return `${provider}/${id}`
  return id ?? provider
}

function formatJson(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  return isStringValue(value) ? value : JSON.stringify(value)
}

function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function jsonText(value: JsonValue | undefined): string | undefined {
  return isStringValue(value) ? value : undefined
}

function jsonNumber(value: JsonValue | undefined): number | undefined {
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

function jsonBoolean(value: JsonValue | undefined): boolean | undefined {
  return isBooleanValue(value) ? value : undefined
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isStringValue(
  value: JsonValue | SQLOutputValue | undefined
): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(
  value: JsonValue | SQLOutputValue | undefined
): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBooleanValue(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

function sqliteText(value: SQLOutputValue | undefined): string | undefined {
  return isStringValue(value) ? value : undefined
}

function sqliteNumber(value: SQLOutputValue | undefined): number | undefined {
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

function unchangedUpdate(nextByte: number): SessionUpdate {
  return { entries: [], nextByte, replace: false }
}

function fileParts(value: JsonValue | undefined): AttachmentContent[] {
  if (!Array.isArray(value)) return []
  const attachments: AttachmentContent[] = []
  for (const part of value) {
    if (!isJsonObject(part)) continue
    const type = jsonText(part.type)
    const url = jsonText(part.url) ?? jsonText(part.uri)
    if (type !== "file" && (type !== undefined || !url)) continue
    const name = jsonText(part.filename) ?? "Attachment"
    const mime =
      jsonText(part.mime) ??
      jsonText(part.mediaType) ??
      "application/octet-stream"
    attachments.push(
      url
        ? attachmentFromUrl(name, mime, url)
        : {
            type: "attachment",
            name,
            mimeType: mime,
            source: {
              kind: "unavailable",
              reason: "The provider did not retain a readable file URL",
            },
          }
    )
  }
  return attachments
}
