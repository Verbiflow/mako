import { attachmentFromUrl, proposedPlanBlock, type AttachmentContent } from "../content.js"
import { stat } from "node:fs/promises"
import { OPENCODE_IMPORTED_MODEL } from "../emit.js"
import { removeSessionRows } from "../sqlite-removal.js"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { openCodeDatabasePaths } from "./opencode-location.js"
import { isOpenCodeInstruction, openCodeNoticeLabel } from "./opencode-notice.js"
import { openCodePlan } from "./opencode-plan.js"
import { compactionEvent, compactionFailedEvent, event, turnFailedEvent, type TranscriptEvent } from "../events.js"
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
  /** `time_archived`, which each archive sets anew. */
  archivedAt?: number
  revision: number
}

interface StoredRow {
  id: string
  type?: string
  timeCreated?: number
  /** When the row last changed: a compaction row settles here. */
  timeUpdated?: number
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

  private readonly databases: string[]
  private snapshots = new Map<string, Snapshot>()

  constructor(home?: string, env = home === undefined ? process.env : {}) {
    this.databases = openCodeDatabasePaths(env, home ?? homedir())
  }

  roots(): string[] {
    return [...new Set(this.databases.map(path => dirname(path)))]
  }

  /** The data folder also holds logs, snapshots and tool output a running agent writes continuously. */
  watchRoots(): string[] {
    return []
  }

  pollFiles(): string[] {
    return this.databasePaths().flatMap((database) => [database, `${database}-wal`])
  }

  observationPaths(path: string): string[] {
    const target = parseSessionPath(path, this.databasePaths())
    return target ? [target.database, `${target.database}-wal`] : []
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
                revision: rowState(row),
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
                "session_v2",
                hasTable(database, "session")
              ).map((row) => ({
                path: sessionPath(path, row.id, true),
                bytes: row.revision,
                mtimeMs: row.updatedAt ?? info.mtimeMs,
                revision: rowState(row),
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
      const parent = forkParent(database, kind, row, target.v2 ? "session_v2" : "session")
      if (parent) ref.parentNativeId = parent
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
    return this.databases
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
  sessionTable = "session",
  legacySessions = false
): SessionRow[] {
  const rows = database
    .prepare(sessionQuery(kind, false, sessionTable, legacySessions))
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

/**
 * A store OpenCode migrated from v1 keeps its `session` table beside
 * `session_v2`, and a session in both is listed once, from `session`. A
 * store OpenCode 2 created has no `session` table at all.
 */
function sessionQuery(
  kind: StoreKind,
  one: boolean,
  sessionTable = "session",
  legacySessions = false
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
    : sessionTable === "session_v2" && legacySessions
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
    archivedAt: sqliteNumber(fields.time_archived),
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
  }
  // Archived in OpenCode, not lost: the row is intact and resumes as it is.
  if (row.archived) ref.nativeArchived = true
  if (row.archived && row.archivedAt !== undefined) ref.nativeArchiveStamp = String(Math.floor(row.archivedAt))
  if (model?.effort) ref.settings = { model: modelId, options: { effort: model.effort } }
  return ref
}

const FORK_TITLE = /^(.+) \(fork #(\d+)\)$/

/**
 * OpenCode records no parent for a fork. It names the copy after its source
 * ("X" forks to "X (fork #1)", "X (fork #1)" to "X (fork #2)") and copies
 * its history, so the source is the earlier session in the same folder with
 * that title and the same first prompt.
 */
function forkParent(
  database: DatabaseSync,
  kind: StoreKind,
  row: SessionRow,
  table: "session" | "session_v2"
): string | undefined {
  const match = row.title?.match(FORK_TITLE)
  const base = match?.[1]
  const count = Number(match?.[2])
  if (!base || !count || !row.directory) return undefined
  const title = count > 1 ? `${base} (fork #${count - 1})` : base
  const prompt = firstUserTitle(database, kind, row.id)
  if (prompt === undefined) return undefined
  try {
    const candidates = database
      .prepare(
        `SELECT id FROM ${table} WHERE title = ? AND directory = ? AND id != ? AND time_created <= ?
         ORDER BY time_created DESC LIMIT 8`
      )
      .all(title, row.directory, row.id, row.startedAt ?? Number.MAX_SAFE_INTEGER)
    for (const candidate of candidates) {
      const id = sqliteText(candidate.id)
      if (id && firstUserTitle(database, kind, id) === prompt) return id
    }
  } catch {
    return undefined
  }
  return undefined
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
      `SELECT id, type, time_created, time_updated, data FROM (
         SELECT id, type, seq, time_created, time_updated, data FROM session_message
         WHERE session_id = ? ORDER BY seq DESC, id DESC LIMIT ?
       ) ORDER BY seq, id`
    )
    .all(sessionId, MAX_MESSAGES)
  const sink = new EntrySink()
  const execution: Execution = { running: false }
  for (const fields of stored) {
    const row = parseStoredRow(fields)
    if (row) pushCurrent(sink, row, execution)
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

interface Execution {
  /**
   * The session's execution had not ended at this row. A step that ended in
   * tool calls continues it; any other end settles it. A synthetic notice
   * delivered while it runs is read in that execution.
   */
  running: boolean
  /** Context tokens of the latest step: what a compaction starts from, as live reads it. */
  context?: number
}

/**
 * `system` rows (instructions and date updates OpenCode tells the model) and
 * `skill` rows are protocol, not conversation, and are left out.
 */
function pushCurrent(sink: EntrySink, row: StoredRow, execution: Execution): void {
  const type = row.type ?? jsonText(row.data.type)
  const at = isoOf(timeCreated(row.data) ?? row.timeCreated)
  if (type === "user") execution.running = true
  if (type === "assistant") {
    const finish = jsonText(row.data.finish)
    // A retried step continues its execution; OpenCode resumes it with a synthetic "continue".
    execution.running = finish === undefined || finish === "tool-calls" || jsonObject(row.data.retry) !== undefined
  }
  if (type === "synthetic") {
    const notice = {
      text: jsonText(row.data.text),
      description: jsonText(row.data.description),
      source: jsonText(jsonObject(row.data.metadata)?.source),
      state: jsonText(jsonObject(row.data.metadata)?.state),
    }
    if (isOpenCodeInstruction(notice)) return
    if (!execution.running)
      sink.push({ kind: "event", id: row.id, source: { harness: "opencode", record: row.id }, at, label: openCodeNoticeLabel(notice), opensTurn: true })
    execution.running = true
    return
  }
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
    const blocks = withPlanCard(row.id, row.data, assistantContent(row.data.content))
    const usage = usageFrom(row.data)
    const model = modelFromData(row.data)
    if (blocks.length > 0 || usage)
      pushAssistant(sink, at, model?.id, usage, blocks)
    execution.context = contextTokens(row.data) ?? execution.context
    // A step that failed and was retried did not fail the turn.
    const retry = retryEvent(jsonObject(row.data.retry))
    if (retry) pushEvent(sink, at, retry, row.id)
    if (isInterrupted(row.data))
      pushEvent(sink, at, { label: "Interrupted" }, row.id)
    else if (!retry) {
      const failure = failedTurn(jsonObject(row.data.error))
      if (failure) pushEvent(sink, at, failure, row.id)
    }
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
    const status = jsonText(row.data.status)
    if (status === "failed")
      pushEvent(sink, at, compactionFailedEvent(errorText(row.data.error) || undefined), row.id)
    // A running compaction has not happened yet; the row settles when it ends.
    else if (status !== "running")
      pushEvent(sink, at, compactionEvent({
        trigger: compactionTrigger(jsonText(row.data.reason)),
        tokensBefore: execution.context,
        summary: jsonText(row.data.summary),
        durationMs: elapsed(timeCreated(row.data) ?? row.timeCreated, row.timeUpdated),
      }), row.id)
    return
  }
  if (type === "model-switched") {
    const model = jsonObject(row.data.model)
    const id = model ? jsonText(model.id) : undefined
    const provider = model ? jsonText(model.providerID) : undefined
    sink.push({
      kind: "event",
      at,
      id: row.id,
      source: { harness: "opencode", record: row.id },
      label: "Model changed",
      detail: modelLabel(id, provider),
    })
    return
  }
  if (type === "agent-switched") {
    const agent = jsonText(row.data.agent)
    pushEvent(sink, at, { label: "Agent changed", detail: agent }, row.id)
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
    pushEvent(sink, at, compactionEvent({ trigger: jsonBoolean(compaction.data.auto) === true ? "automatic" : "manual" }), compaction.id)
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
  const retries: { marker: TranscriptEvent; record: string }[] = []
  let usage = usageFrom(message.data)
  for (const part of parts) {
    const type = jsonText(part.data.type)
    if (type === "retry") {
      const retry = retryEvent(part.data)
      if (retry) retries.push({ marker: retry, record: part.id })
      continue
    }
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
    pushAssistant(sink, at, model?.id, usage, withPlanCard(message.id, message.data, blocks))
  for (const retry of retries) pushEvent(sink, at, retry.marker, retry.record)
  if (isInterrupted(message.data))
    pushEvent(sink, at, { label: "Interrupted" }, message.id)
  else {
    const failure = failedTurn(jsonObject(message.data.error))
    if (failure) pushEvent(sink, at, failure, message.id)
  }
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

/** A Plan step's reply shows as its plan card, as it does live. */
function withPlanCard(messageId: string, data: JsonObject, blocks: EntryBlock[]): EntryBlock[] {
  const texts = blocks.flatMap((block) => block.type === "text" ? [block.text] : [])
  const plan = openCodePlan(messageId, jsonText(data.agent), jsonText(data.finish), texts)
  const card = plan && proposedPlanBlock(plan.id, plan.text)
  return card ? [...blocks.filter((block) => block.type !== "text"), card] : blocks
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
    if (kind === "current" && isAborted(state.error)) block.canceled = true
    else block.error = true
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
  if (provider === OPENCODE_IMPORTED_MODEL.providerID && id === OPENCODE_IMPORTED_MODEL.id) return null
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

function pushEvent(sink: EntrySink, at: string | undefined, marker: TranscriptEvent, record: string): void {
  sink.push({ kind: "event", id: record, at, ...marker, source: { harness: "opencode", record } })
}

function compactionTrigger(reason: string | undefined): "automatic" | "manual" | undefined {
  return reason === "auto" ? "automatic" : reason === "manual" ? "manual" : undefined
}

/** Context tokens of one step, as the live session reads them. */
function contextTokens(data: JsonObject): number | undefined {
  const tokens = jsonObject(data.tokens)
  if (!tokens) return undefined
  const cache = jsonObject(tokens.cache)
  const counts = [tokens.input, tokens.output, tokens.reasoning, cache?.read, cache?.write].map(jsonNumber)
  const total = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
  return total > 0 ? total : undefined
}

/** A v2 step's `retry` or a v1 `retry` part: the attempt OpenCode scheduled after an error. */
function retryEvent(retry: JsonObject | undefined): TranscriptEvent | undefined {
  if (!retry) return undefined
  const attempt = jsonNumber(retry.attempt)
  const message = errorText(retry.error)
  if (attempt === undefined && !message) return undefined
  const line = oneLine(message)
  const detail = [attempt === undefined ? undefined : `attempt ${attempt}`, line].filter(Boolean).join(" · ")
  return { ...event("Retried", detail, line === message.trim() ? undefined : message), tone: "warning" }
}

/** An error that ended the turn; a stopped turn reads as interrupted instead. */
function failedTurn(error: JsonObject | undefined): TranscriptEvent | undefined {
  if (!error) return undefined
  const kind = jsonText(error.type) ?? jsonText(error.name)
  const message = errorText(error)
  if (!kind && !message) return undefined
  return turnFailedEvent(kind ? failureClass(kind) : oneLine(message), message)
}

/** OpenCode 2 error types and OpenCode 1 error names, in plain words. */
const FAILURE_CLASSES = new Map([
  ["provider.invalid-output", "Invalid model response"],
  ["provider.invalid-request", "Request rejected"],
  ["provider.rate-limit", "Rate limited"],
  ["provider.quota", "Quota exceeded"],
  ["provider.auth", "Authentication failed"],
  ["provider.content-filter", "Blocked by content filter"],
  ["provider.transport", "Connection failed"],
  ["provider.connect", "Connection failed"],
  ["provider.no-route", "Model unavailable"],
  ["provider.unsupported-operation", "Not supported by the provider"],
  ["provider.internal", "Provider error"],
  ["provider.error", "Provider error"],
  ["provider.unknown", "Provider error"],
  ["ProviderAuthError", "Authentication failed"],
  ["APIError", "Provider error"],
  ["MessageOutputLengthError", "Output too long"],
  ["ContextOverflowError", "Context too long"],
  ["StructuredOutputError", "Invalid structured output"],
  ["UnknownError", "Unknown error"],
])

function failureClass(kind: string): string {
  const known = FAILURE_CLASSES.get(kind)
  if (known) return known
  const words = kind.replace(/Error$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim().toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Error"
}

/** The first line of a message, short enough to sit beside a label. */
function oneLine(text: string, max = 160): string {
  const line = text.trim().split("\n", 1)[0]!.trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
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

/** OpenCode 2 records a call the user stopped as an `aborted` error. */
function isAborted(value: JsonValue | undefined): boolean {
  return isJsonObject(value) && jsonText(value.type) === "aborted"
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
    timeUpdated: sqliteNumber(fields.time_updated),
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

function elapsed(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined || from <= 0 || to <= from) return undefined
  return (to - from) * (to > 1e12 ? 1 : 1000)
}

function timeCreated(data: JsonObject): number | undefined {
  const time = jsonObject(data.time)
  return time ? (jsonNumber(time.created) ?? jsonNumber(time.start)) : undefined
}

/** Archiving or renaming may leave the row's times alone; the stamp still has to move. */
function rowState(row: SessionRow): string {
  return JSON.stringify([row.archived ? (row.archivedAt ?? "archived") : "open", row.title ?? null, row.directory ?? null])
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
