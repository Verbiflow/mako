import { attachmentFromUrl, proposedPlanBlock, type AttachmentContent } from "../content.js"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import type { Stats } from "node:fs"
import { OPENCODE_IMPORTED_MODEL } from "../emit.js"
import { OPENCODE_ASSISTANT_CONTENT, OPENCODE_LEGACY_PARTS, OPENCODE_MESSAGES, OpenCodeSavedTokens, openCodeTokens } from "../harnesses/opencode.js"
import { tokenSum } from "../harnesses/tokens.js"
import { removeSessionRows } from "../sqlite-removal.js"
import { openReadOnly, type NativeStores } from "../read-only-sqlite.js"
import { ownedRows, placeholders, type SessionRecords } from "../harness-records.js"
import type { ChildTranscript } from "../children.js"
import { openCodeChildren, openCodeParent } from "./opencode-children.js"
import { READ_BUSY_TIMEOUT_MS } from "./sqlite-busy.js"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { reduceLiveUpdates, type LiveUpdate } from "../live-content.js"
import { liveEntryBlocks } from "../live-entries.js"
import { OpenCodeContent, type OpenCodeToolContent } from "../opencode-content.js"
import { openCodeDatabasePaths } from "./opencode-location.js"
import { isOpenCodeInstruction, openCodeNoticeTurn, openCodeRetried, openCodeTurnFailed } from "./opencode-notice.js"
import { openCodePlan } from "./opencode-plan.js"
import { OpenCodeEditInput, openCodeFailedExit, openCodeFileName, openCodeToolDetails } from "./opencode-tools.js"
import { z } from "zod"
import { compactionEvent, compactionFailedEvent, type TranscriptEvent } from "../events.js"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { titleFrom, type DecodedBlock, type Thread, type DecodedEntry, type ThreadRef, type TurnUsage, type UnreadRecord } from "../format.js"
import { normalizeToolOutput } from "../tool-output.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./types.js"
import { EntrySink } from "../entry-sink.js"
import { isReplyEntry, type Entry, type EntryOf } from "../entries.js"
import { openCodeFork } from "./opencode-fork.js"

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]
type SqliteFields = Record<string, SQLOutputValue>
type StoreKind = "current" | "legacy"
type ToolBlock = Extract<DecodedBlock, { type: "tool" }>

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
  /** An undo OpenCode staged and the next prompt commits. */
  revert?: StagedRevert
}

/**
 * `/undo` stages a revert: from `messageID` on (from its part `partID` on,
 * in a v1 store) the session's messages are undone, shown and sent no more,
 * yet kept until the next prompt deletes them or `/redo` clears the revert.
 */
const StagedRevert = z.object({ messageID: z.string().min(1), partID: z.string().min(1).optional() })
type StagedRevert = z.infer<typeof StagedRevert>

interface StoredRow {
  id: string
  type?: string
  timeCreated?: number
  /** When the row last changed: a compaction row settles here. */
  timeUpdated?: number
  data: JsonObject
}

/** What a follower diffs a session's next read against: each entry's digest, in order. */
interface Snapshot {
  revision: number
  digests: string[]
}

/** Sessions whose last read a new follower can start from; one without starts over at its first change. */
const SNAPSHOTS = 8

function digestOf(entry: Entry): string {
  return createHash("sha1").update(JSON.stringify(entry)).digest("base64")
}

const MAX_SESSIONS = 20_000

function openDatabase(stores: NativeStores, path: string): DatabaseSync | null {
  try {
    return stores.open(path)
  } catch {
    return null
  }
}

export class OpenCodeProvider implements SessionProvider {
  harness = "opencode" as const
  displayName = "OpenCode"
  /** How a session is written again as its own fork (`opencode-fork.ts`). */
  readonly fork = openCodeFork
  /** One database, many sessions: a write means re-discover, not re-stat. */
  rescanRoot = (): boolean => true
  rescanDebounceMs = 250

  private readonly databases: string[]
  private snapshots = new Map<string, Snapshot>()
  private held = new Map<string, { database: DatabaseSync; identity: string }>()

  private readonly stores: NativeStores

  constructor(stores: NativeStores, home?: string, env = home === undefined ? process.env : {}) {
    this.stores = stores
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
        const opened = await this.connection(path)
        if (!opened) return []
        const { database, info } = opened
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
              ...sessionRows(database, "current", MAX_SESSIONS, "session_v2").map((row) => ({
                path: sessionPath(path, row.id, true),
                bytes: row.revision,
                mtimeMs: row.updatedAt ?? info.mtimeMs,
                revision: rowState(row),
              }))
            )
          }
          return files
        } catch {
          this.drop(path)
          return []
        }
      })
    )
    return stores.flat()
  }

  /** One session's stamp, as `discover` lists it: a view of the session is kept as long as the catalog sees no change in it. */
  async stat(path: string): Promise<NativeFile | null> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return null
    const opened = await this.connection(target.database)
    if (!opened) return null
    const { database, info } = opened
    try {
      const kind = target.v2 ? "current" : storeKind(database, target.database)
      const row = kind && sessionRow(database, kind, target.id, target.v2 ? "session_v2" : "session")
      return row ? { path, bytes: row.revision, mtimeMs: row.updatedAt ?? info.mtimeMs, revision: rowState(row), storeBytes: info.size } : null
    } catch {
      this.drop(target.database)
      return null
    }
  }

  /**
   * The connection to the database at `path` that every read here shares:
   * held until the file is replaced or a strict snapshot of it goes stale,
   * and dropped when a read through it fails.
   */
  private async connection(path: string): Promise<{ database: DatabaseSync; info: Stats } | null> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    const identity = `${info.dev}:${info.ino}:${this.stores.version(path)}`
    const held = this.held.get(path)
    if (held?.identity === identity) return { database: held.database, info }
    this.drop(path)
    const database = openDatabase(this.stores, path)
    if (!database) return null
    this.held.set(path, { database, identity })
    return { database, info }
  }

  private drop(path: string): void {
    this.held.get(path)?.database.close()
    this.held.delete(path)
  }

  close(): void {
    for (const { database } of this.held.values()) database.close()
    this.held.clear()
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const target = parseSessionPath(file.path, this.databasePaths())
    if (!target) return null
    const database = (await this.connection(target.database))?.database
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
      this.drop(target.database)
      return null
    }
  }

  async read(path: string): Promise<Thread | null> {
    return (await this.readSnapshot(path))?.thread ?? null
  }

  /** `read`, and what a follower diffs the session's next read against, which is kept for the next follower too. */
  private async readSnapshot(path: string): Promise<{ thread: Thread; snapshot: Snapshot } | null> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return null
    const database = (await this.connection(target.database))?.database
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
      const { entries, unread } =
        kind === "current"
          ? currentEntries(database, row.id, row.directory ?? row.projectWorktree ?? "", row.revert)
          : legacyEntries(database, row.id, row.directory ?? row.projectWorktree ?? "", row.revert)
      const model =
        modelFromSession(row) ??
        latestModel(database, kind, row.id) ??
        modelFromEntries(entries)
      const ref = refFrom(row, path, row.revision, model)
      ref.title ??= firstUserTitle(database, kind, row.id)
      const parent = openCodeParent(database, target.v2 ? "session_v2" : "session", row.id)
      if (parent) ref.childOf = { nativeId: parent, path: sessionPath(target.database, parent, target.v2) }
      database.exec("COMMIT")
      const snapshot: Snapshot = { revision: row.revision, digests: entries.map(digestOf) }
      this.snapshots.delete(path)
      this.snapshots.set(path, snapshot)
      for (const oldest of this.snapshots.keys()) {
        if (this.snapshots.size <= SNAPSHOTS) break
        this.snapshots.delete(oldest)
      }
      const thread: Thread = { ref, entries }
      if (unread) thread.unread = unread
      return { thread, snapshot }
    } catch {
      try {
        database.exec("ROLLBACK")
      } catch {}
      this.drop(target.database)
      return null
    }
  }

  createFollower(path: string, fromByte: number): SessionFollower {
    const held = this.snapshots.get(path)
    let cursor = fromByte
    let previous =
      held?.revision === fromByte
        ? held.digests
        : fromByte === 0
          ? []
          : null

    return {
      get offset() {
        return cursor
      },
      next: async (wholeLimit?: number): Promise<SessionUpdate> => {
        const revision = await this.revision(path)
        if (revision === null || revision === cursor)
          return unchangedUpdate(cursor)
        if (wholeLimit !== undefined && ((await this.recordBytes(path)) ?? 0) >= wholeLimit) return { entries: [], nextByte: cursor, replace: false, reload: true }
        const read = await this.readSnapshot(path)
        if (!read) return unchangedUpdate(cursor)
        const { thread, snapshot } = read
        const current = snapshot.digests
        if (previous === null) {
          previous = current
          cursor = snapshot.revision
          return {
            entries: thread.entries,
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
        previous = current
        cursor = snapshot.revision
        const update: SessionUpdate = {
          entries,
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
  /**
   * The session's rows and its subagents' (the sessions under it by
   * `parent_id`), in every table keyed by `session_id`; the session, project
   * and event log rows; the instruction blobs its instruction state names;
   * and the migration list OpenCode checks before it opens the database.
   */
  async records(path: string): Promise<SessionRecords | null> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return null
    const sessions = target.v2 ? "session_v2" : "session"
    const ids = sessionTree(target.database, sessions, target.id)
    if (!ids.length) return null
    const listed = placeholders(ids)
    const named = (column: string) => `SELECT j.value FROM instruction_state s, json_each(s.${column}) j WHERE s.session_id IN (${listed}) AND json_valid(s.${column})`
    const database = ownedRows(target.database, ids, {
      owner: "session_id",
      keyed: { [sessions]: "id" },
      shared: ["migration", "__drizzle_migrations"],
      extra: [
        { table: "project", where: `id IN (SELECT project_id FROM ${sessions} WHERE id IN (${listed}))`, params: ids },
        { table: "event", where: `aggregate_id IN (${listed})`, params: ids },
        { table: "event_sequence", where: `aggregate_id IN (${listed})`, params: ids },
        {
          table: "instruction_blob",
          where: `hash IN (${named("initial_values")} UNION ${named("current_values")} UNION SELECT value FROM instruction_entry WHERE session_id IN (${listed}))`,
          params: [...ids, ...ids, ...ids],
          immutable: true,
        },
      ],
    })
    return database && { roots: [{ name: "opencode", path: dirname(target.database) }], files: [], databases: [database] }
  }

  /** Its subagents: the sessions under it by `parent_id`, and the calls that started them. */
  async children(path: string): Promise<ChildTranscript[] | null> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return null
    return openCodeChildren(this.stores, target.database, target.id, target.v2, (id) => sessionPath(target.database, id, target.v2))
  }

  async remove(path: string): Promise<boolean> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return false
    return removeSessionRows(this.stores, target.database, target.id, ["session", "session_v2"])
  }

  /** The session's message and part rows: `octet_length` reads each row's size from its header, not its text. */
  async recordBytes(path: string): Promise<number | null> {
    const target = parseSessionPath(path, this.databasePaths())
    const database = target && (await this.connection(target.database))?.database
    if (!target || !database) return null
    try {
      const kind = target.v2 ? "current" : storeKind(database, target.database)
      if (!kind) return null
      const sum = (table: string) => sqliteNumber(database.prepare(`SELECT COALESCE(SUM(octet_length(data)), 0) AS bytes FROM ${table} WHERE session_id = ?`).get(target.id)?.bytes)
      const counted = kind === "current" ? [sum("session_message")] : [sum("message"), sum("part")]
      let total = 0
      for (const bytes of counted) {
        if (bytes === undefined) return null
        total += bytes
      }
      return total
    } catch {
      return null
    }
  }

  private async revision(path: string): Promise<number | null> {
    const target = parseSessionPath(path, this.databasePaths())
    if (!target) return null
    const database = (await this.connection(target.database))?.database
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
      this.drop(target.database)
      return null
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

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column))
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
  sessionTable: "session" | "session_v2" = "session"
): SessionRow[] {
  const other = sessionTable === "session" ? "session_v2" : "session"
  const rows = database
    .prepare(sessionQuery(kind, false, sessionTable, hasColumn(database, sessionTable, "revert"), hasTable(database, other) ? other : undefined))
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
    .prepare(sessionQuery(kind, true, sessionTable, hasColumn(database, sessionTable, "revert")))
    .get(id)
  return stored ? parseSessionRow(stored) : null
}

/**
 * A store OpenCode migrated from v1 keeps its `session` table beside
 * `session_v2`, and a session in both is listed once, from the generation
 * written last: OpenCode 2 reads and writes only `session_v2`, so a migrated
 * session resumed there is newer in it, and one it never touched again is
 * whole in `session`. A store OpenCode 2 created has no `session` table at
 * all. `shadow` is the other generation's table, when the store has both.
 * `staged` says the table has a `revert` column, which stores from before
 * `/undo` lack.
 */
function sessionQuery(
  kind: StoreKind,
  one: boolean,
  sessionTable: string,
  staged: boolean,
  shadow?: "session" | "session_v2"
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
  // Equal times keep the v1 copy, which a migration wrote whole.
  const newer = shadow === "session" ? ">=" : ">"
  const where = one
    ? "s.id = ?"
    : shadow
      ? `s.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM ${shadow} other WHERE other.id = s.id AND other.time_updated ${newer} s.time_updated)`
      : "s.parent_id IS NULL"
  const suffix = one
    ? "LIMIT 1"
    : "ORDER BY s.time_updated DESC, s.id DESC LIMIT ?"
  return `SELECT s.id AS id, s.directory AS directory, s.title AS title,
                 s.time_created AS time_created, s.time_updated AS time_updated,
                 s.time_archived AS time_archived, ${staged ? "s.revert" : "NULL"} AS revert, p.worktree AS project_worktree,
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
    revert: StagedRevert.safeParse(parseObject(sqliteText(fields.revert))).data,
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
 * A fork copies its source's history. OpenCode 2 records the source in
 * `fork_session_id`; v1 recorded none, naming the copy after its source
 * ("X" forks to "X (fork #1)", "X (fork #1)" to "X (fork #2)"), so there the
 * source is the earlier session in the same folder with that title and the
 * same first prompt.
 */
function forkParent(
  database: DatabaseSync,
  kind: StoreKind,
  row: SessionRow,
  table: "session" | "session_v2"
): string | undefined {
  if (table === "session_v2" && hasColumn(database, "session_v2", "fork_session_id")) {
    const recorded = sqliteText(database.prepare("SELECT fork_session_id AS fork FROM session_v2 WHERE id = ?").get(row.id)?.fork)
    if (recorded) return recorded
  }
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

/** A thread's entries, and the records it couldn't draw. */
interface ReadEntries {
  entries: Entry[]
  unread: UnreadRecord[] | undefined
}

/** The marker after a session's last shown entry for the messages a staged undo holds back. */
function undoneEvent(messages: number): DecodedEntry {
  return {
    kind: "event",
    label: "Undone",
    detail: `OpenCode holds ${messages === 1 ? "1 undone message" : `${messages} undone messages`} until the next prompt; /redo brings ${messages === 1 ? "it" : "them"} back`,
  }
}

function currentEntries(
  database: DatabaseSync,
  sessionId: string,
  cwd: string,
  revert: StagedRevert | undefined
): ReadEntries {
  // OpenCode deletes from the revert's message on when it commits the undo.
  const boundary = revert
    ? sqliteNumber(database.prepare("SELECT seq FROM session_message WHERE session_id = ? AND id = ?").get(sessionId, revert.messageID)?.seq)
    : undefined
  const until = boundary ?? Number.MAX_SAFE_INTEGER
  const stored = database
    .prepare(
      `SELECT id, type, time_created, time_updated, data FROM session_message
       WHERE session_id = ? AND seq < ? ORDER BY seq, id`
    )
    .iterate(sessionId, until)
  const sink = new EntrySink()
  const execution: Execution = { running: false }
  for (const fields of stored) {
    const row = parseStoredRow(fields)
    if (!row) continue
    sink.reading({ rows: [{ table: "session_message", key: { id: row.id } }] })
    pushCurrent(sink, row, execution, sessionId, cwd)
  }
  sink.reading(undefined)
  if (boundary !== undefined) {
    const undone = sqliteNumber(database.prepare("SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND seq >= ? AND type IN ('user', 'assistant')").get(sessionId, boundary)?.count) ?? 0
    if (undone) sink.push(undoneEvent(undone))
  }
  return { entries: sink.done(), unread: sink.unreadRecords }
}

function legacyEntries(
  database: DatabaseSync,
  sessionId: string,
  cwd: string,
  revert: StagedRevert | undefined
): ReadEntries {
  // A v1 undo holds back its message from `partID` on, else whole, and every later message; ids ascend.
  const all = database
    .prepare(
      `SELECT id, time_created, data FROM message
       WHERE session_id = ? ORDER BY time_created, id`
    )
    .all(sessionId)
    .map(parseStoredRow)
    .filter((row): row is StoredRow => row !== null)
  const messages = revert
    ? all.filter((message) => message.id < revert.messageID || (message.id === revert.messageID && revert.partID !== undefined))
    : all
  const undone = all.length - messages.length + (revert?.partID !== undefined && messages.some((message) => message.id === revert.messageID) ? 1 : 0)
  if (messages.length === 0) {
    const sink = new EntrySink()
    if (undone) sink.push(undoneEvent(undone))
    return { entries: sink.done(), unread: undefined }
  }
  const parts = database
    .prepare(
      `SELECT p.id, p.message_id, p.time_created, p.data
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE m.session_id = ? ORDER BY p.id`
    )
    .iterate(sessionId)
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
  const cut = revert?.partID
  for (const message of messages) {
    const parts = byMessage.get(message.id) ?? []
    sink.reading({ rows: [{ table: "message", key: { id: message.id } }] })
    pushLegacy(sink, message, cut !== undefined && message.id === revert?.messageID ? parts.filter((part) => part.id < cut) : parts, cwd)
  }
  sink.reading(undefined)
  if (undone) sink.push(undoneEvent(undone))
  return { entries: sink.done(), unread: sink.unreadRecords }
}

interface Execution {
  /**
   * The session's execution had not ended at this row. A step that ended in
   * tool calls continues it; any other end settles it. A synthetic notice
   * delivered while it runs is read in that execution.
   */
  running: boolean
  /** The prompt the running execution answers; OpenCode saves a prompt steered into it as a plain one. */
  prompt?: string
  /** Context tokens of the latest step: what a compaction starts from, as live reads it. */
  context?: number
}

/**
 * `system` rows (instructions and date updates OpenCode tells the model) and
 * `skill` rows are protocol, not conversation, and are left out.
 */
function pushCurrent(sink: EntrySink, row: StoredRow, execution: Execution, sessionId: string, cwd: string): void {
  const type = row.type ?? jsonText(row.data.type)
  const at = isoOf(timeCreated(row.data) ?? row.timeCreated)
  const steers = type === "user" && execution.running ? execution.prompt : undefined
  if (type === "user") execution.running = true
  if (type === "assistant") {
    const finish = jsonText(row.data.finish)
    // A retried step continues its execution; OpenCode resumes it with a synthetic "continue".
    execution.running = finish === undefined || finish === "tool-calls" || jsonObject(row.data.retry) !== undefined
    if (!execution.running) execution.prompt = undefined
  }
  // However its last step ended, interrupted included, the turn is over.
  if (type === "idle") {
    execution.running = false
    execution.prompt = undefined
  }
  if (type === "synthetic") {
    const metadata = jsonObject(row.data.metadata)
    const notice = {
      text: jsonText(row.data.text),
      description: jsonText(row.data.description),
      source: jsonText(metadata?.source),
      state: jsonText(metadata?.state),
      exit: jsonNumber(metadata?.exit),
      signal: jsonText(metadata?.signal),
    }
    if (isOpenCodeInstruction(notice)) return
    if (!execution.running) {
      const { reason, cause, body } = openCodeNoticeTurn(notice)
      sink.push({ kind: "event", id: row.id, source: { harness: "opencode", record: row.id }, at, label: reason, ...cause && { cause }, ...body && { body }, opensTurn: true })
    }
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
    if (!text?.trim() && !attachments.length) return
    if (!steers) execution.prompt = row.id
    sink.push({ kind: "user", id: row.id, at, ...steers && { steeringFor: steers }, text: text ?? "", attachments })
    return
  }
  if (type === "assistant") {
    const { blocks, unread } = storedReply(sink, sessionId, row.id, row.data, cwd)
    const usage = usageFrom(row.data)
    const model = modelFromData(row.data)
    const pushed = blocks.length > 0 || !!usage
    if (pushed) pushAssistant(sink, at, model?.id, usage, blocks)
    placeUnread(sink, unread, pushed)
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
          input: command,
          output: normalizeToolOutput(output),
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
  if (type === undefined) sink.unread("session_message (no type)", "unreadable", row.data)
  else if (!Object.hasOwn(OPENCODE_MESSAGES, type)) sink.unread(`session_message ${type}`, "unknown", row.data)
}

function pushLegacy(
  sink: EntrySink,
  message: StoredRow,
  parts: StoredRow[],
  cwd: string
): void {
  const role = jsonText(message.data.role)
  const at = isoOf(timeCreated(message.data) ?? message.timeCreated)
  const unknown = new Map<StoredRow, EntryOf<"unread">>()
  for (const part of parts) {
    const type = jsonText(part.data.type)
    if (type !== undefined && Object.hasOwn(OPENCODE_LEGACY_PARTS, type)) continue
    const entry = sink.unreadEntry(`part ${type ?? "(no type)"}`, type === undefined ? "unreadable" : "unknown", part.data)
    entry.record = { rows: [{ table: "part", key: { id: part.id } }] }
    unknown.set(part, entry)
  }
  const compaction = parts.find(
    (part) => jsonText(part.data.type) === "compaction"
  )
  if (compaction) {
    pushEvent(sink, at, compactionEvent({ trigger: jsonBoolean(compaction.data.auto) === true ? "automatic" : "manual" }), compaction.id)
    for (const entry of unknown.values()) sink.place(entry)
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
    for (const entry of unknown.values()) sink.place(entry)
    return
  }
  if (role !== "assistant") {
    for (const entry of unknown.values()) sink.place(entry)
    sink.unread(`message ${role ?? "(no role)"}`, role === undefined ? "unreadable" : "unknown", message.data)
    return
  }
  const blocks: DecodedBlock[] = []
  const unread: PlacedUnread[] = []
  const retries: { marker: TranscriptEvent; record: string }[] = []
  let usage = usageFrom(message.data)
  for (const part of parts) {
    const type = jsonText(part.data.type)
    const entry = unknown.get(part)
    if (entry) unread.push({ entry, after: blocks.length })
    const from = (block: DecodedBlock): DecodedBlock => {
      sink.recorded(block, { rows: [{ table: "part", key: { id: part.id } }] })
      return block
    }
    if (type === "retry") {
      const retry = retryEvent(part.data)
      if (retry) retries.push({ marker: retry, record: part.id })
      continue
    }
    if (type === "file") {
      blocks.push(...fileParts([part.data]).map(from))
      continue
    }
    if (type === "reasoning") {
      const text = jsonText(part.data.text)
      if (text) blocks.push(from({ type: "thinking", id: part.id, text }))
      continue
    }
    if (type === "text") {
      const text = jsonText(part.data.text)
      if (
        text &&
        jsonBoolean(part.data.synthetic) !== true &&
        jsonBoolean(part.data.ignored) !== true
      )
        blocks.push(from({ type: "text", id: part.id, text }))
      continue
    }
    if (type === "tool") {
      blocks.push(from(legacyTool(part.data, cwd)))
      continue
    }
    if (type === "step-finish") usage = usageFrom(part.data) ?? usage
  }
  const model = modelFromData(message.data)
  const pushed = blocks.length > 0 || !!usage
  if (pushed) pushAssistant(sink, at, model?.id, usage, withPlanCard(message.id, message.data, blocks))
  placeUnread(sink, unread, pushed)
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
  blocks: DecodedBlock[]
): void {
  const entry: Extract<DecodedEntry, { kind: "assistant" }> = {
    kind: "assistant",
    blocks,
  }
  if (at !== undefined) entry.at = at
  if (model !== undefined) entry.model = model
  if (usage !== undefined) entry.usage = usage
  sink.push(entry)
}

/** An unread part of a reply, and how many of the reply's blocks came before it. */
interface PlacedUnread {
  entry: EntryOf<"unread">
  after: number
}

/** A current assistant message's blocks, and the parts of it history couldn't draw. */
interface StoredReply {
  blocks: DecodedBlock[]
  unread: PlacedUnread[]
}

/** Puts a reply's unread parts among its blocks, or after what came before when the reply drew nothing. */
function placeUnread(sink: EntrySink, unread: readonly PlacedUnread[], pushed: boolean): void {
  const message = sink.entries.length - 1
  for (const { entry, after } of unread) {
    if (pushed) sink.place(entry, message, after)
    else sink.place(entry)
  }
}

/** A Plan step's reply shows as its plan card, as it does live. */
function withPlanCard(messageId: string, data: JsonObject, blocks: DecodedBlock[]): DecodedBlock[] {
  const texts = blocks.flatMap((block) => block.type === "text" ? [block.text] : [])
  const plan = openCodePlan(messageId, jsonText(data.agent), jsonText(data.finish), texts)
  const card = plan && proposedPlanBlock(plan.id, plan.text)
  return card ? [...blocks.filter((block) => block.type !== "text"), card] : blocks
}

const StoredToolContent = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("file"), name: z.string().optional(), mime: z.string(), uri: z.string() }),
])
const StoredTool = z.object({
  type: z.literal("tool"),
  id: z.string(),
  name: z.string(),
  state: z.object({
    status: z.string(),
    input: z.json().optional(),
    content: z.array(z.json()).optional(),
    metadata: z.json().optional(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  }).optional(),
})
const StoredPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  StoredTool,
])

/**
 * A current assistant message as the live projection draws it: each part it
 * keeps goes in as the event that streamed it (`OpenCodeContent`). A tool
 * keeps the call id it is saved under.
 */
function storedReply(sink: EntrySink, sessionId: string, messageId: string, data: JsonObject, cwd: string): StoredReply {
  const projection = new OpenCodeContent(sessionId, cwd)
  const updates: LiveUpdate[] = []
  const unread: PlacedUnread[] = []
  projection.stepStarted(sessionId, messageId, jsonText(data.agent) ?? "")
  const parts = Array.isArray(data.content) ? data.content : []
  parts.forEach((part, ordinal) => {
    const read = StoredPart.safeParse(part).data
    if (read?.type === "text") {
      updates.push(...projection.text(sessionId, messageId, ordinal, read.text))
      projection.textEnded(sessionId, messageId, ordinal, read.text)
      return
    }
    if (read?.type === "reasoning") return void updates.push(...projection.reasoning(sessionId, messageId, ordinal, read.text))
    if (!read) {
      const attachments = fileParts([part])
      for (const attachment of attachments) updates.push({ kind: "attachment", attachment })
      if (attachments.length) return
      const type = jsonText(jsonObject(part)?.type)
      const entry = type === undefined || OPENCODE_ASSISTANT_CONTENT.has(type)
        ? sink.unreadEntry(`assistant ${type ?? "part"}`, "unreadable", part)
        : sink.unreadEntry(`assistant ${type}`, "unknown", part)
      unread.push({ entry, after: liveEntryBlocks(reduceLiveUpdates([], updates)).length })
      return
    }
    const tool = read
    updates.push(...projection.toolStarted(sessionId, tool.id, tool.name))
    const state = tool.state
    if (!state || state.status === "pending") return
    updates.push(...projection.toolCalled(sessionId, tool.id, state.input ?? {}))
    const content = state.content?.flatMap((item): OpenCodeToolContent[] => {
      const read = StoredToolContent.safeParse(item).data
      return read ? [read] : []
    })
    if (state.status === "completed") updates.push(...projection.toolEnded(sessionId, tool.id, { content, metadata: state.metadata }))
    else if (state.status === "error") updates.push(...projection.toolEnded(sessionId, tool.id, { content, error: state.error ?? { type: "error", message: "" } }))
  })
  updates.push(...projection.stepEnded(sessionId, messageId, jsonText(data.finish)))
  const session = `${sessionId}:`
  const blocks = liveEntryBlocks(reduceLiveUpdates([], updates)).map((block) =>
    block.type === "tool" && block.id?.startsWith(session) ? { ...block, id: block.id.slice(session.length) } : block)
  return { blocks, unread }
}

/** A legacy (OpenCode 1.x) `part` row's tool. */
function legacyTool(data: JsonObject, cwd: string): ToolBlock {
  const state = jsonObject(data.state)
  const status = state ? jsonText(state.status) : undefined
  const name = jsonText(data.tool) ?? jsonText(data.name) ?? "tool"
  const input = state?.input
  const block: ToolBlock = {
    type: "tool",
    name,
    input: formatJson(input),
  }
  const details = openCodeToolDetails(name, OpenCodeEditInput.safeParse(input).data, cwd)
  if (details) block.details = details
  const id = jsonText(data.callID) ?? jsonText(data.id)
  if (id) block.id = id
  if (!state) return block
  const attachments = fileParts(state.attachments ?? state.content)
  if (attachments.length) block.attachments = attachments
  if (status === "completed") {
    block.output = normalizeToolOutput(jsonText(state.output))
    if (openCodeFailedExit(state.metadata)) block.error = true
    return block
  }
  if (status === "error") {
    block.output = normalizeToolOutput(jsonText(state.error))
    block.error = true
  }
  if (/cancel/i.test(status ?? "")) block.canceled = true
  return block
}

function usageFrom(data: JsonObject): TurnUsage | undefined {
  const tokens = OpenCodeSavedTokens.parse(data.tokens)
  const cost = jsonNumber(data.cost)
  if (!tokens && cost === undefined) return undefined
  const usage: TurnUsage = {}
  if (tokens) {
    const counted = openCodeTokens(tokens)
    usage.input = counted.input
    usage.output = counted.output
    usage.cacheRead = counted.cacheRead
    usage.cacheWrite = counted.cacheWrite
  }
  if (cost !== undefined) usage.costUsd = cost
  return usage
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
  entries: readonly Entry[]
): StoredModel | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (isReplyEntry(entry) && entry.model) return { id: entry.model }
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
  const tokens = OpenCodeSavedTokens.parse(data.tokens)
  const total = tokens ? tokenSum(openCodeTokens(tokens)) : 0
  return total > 0 ? total : undefined
}

/** A v2 step's `retry` or a v1 `retry` part: the attempt OpenCode scheduled after an error. */
function retryEvent(retry: JsonObject | undefined): TranscriptEvent | undefined {
  return retry ? openCodeRetried(jsonNumber(retry.attempt), errorText(retry.error)) : undefined
}

/** An error that ended the turn; a stopped turn reads as interrupted instead. */
function failedTurn(error: JsonObject | undefined): TranscriptEvent | undefined {
  if (!error) return undefined
  const kind = jsonText(error.type) ?? jsonText(error.name)
  const message = errorText(error)
  if (!kind && !message) return undefined
  return openCodeTurnFailed(kind, message)
}


/** The first line of a message, short enough to sit beside a label. */
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

/** The session and every session under it by `parent_id`, or none when it isn't in `table`. */
function sessionTree(database: string, table: "session" | "session_v2", id: string): string[] {
  const { database: db } = openReadOnly(database, { timeout: READ_BUSY_TIMEOUT_MS })
  try {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return []
    const children = db.prepare(`SELECT id FROM ${table} WHERE parent_id = ?`)
    const ids = [id]
    for (let at = 0; at < ids.length; at++)
      for (const row of children.all(ids[at]!)) {
        const child = String(row["id"])
        if (!ids.includes(child)) ids.push(child)
      }
    return ids
  } finally {
    db.close()
  }
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
    const mime =
      jsonText(part.mime) ??
      jsonText(part.mediaType) ??
      "application/octet-stream"
    // OpenCode 2.x keeps a prompt's file on its message: the bytes, and the URI they came from unless inline.
    const source = jsonObject(part.source)
    const data = jsonText(part.data)
    const url = jsonText(part.url) ?? jsonText(part.uri)
      ?? (jsonText(source?.type) === "uri" ? jsonText(source?.uri) : undefined)
      ?? (data ? `data:${mime};base64,${data}` : undefined)
    if (type !== "file" && (type !== undefined || !url)) continue
    const name = openCodeFileName(jsonText(part.filename) ?? jsonText(part.name))
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
