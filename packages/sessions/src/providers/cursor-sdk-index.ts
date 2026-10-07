import { createHash } from "node:crypto"
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite"
import { z } from "zod"
import { CursorSdkMessageSchema, type CursorSdkModelSelection, type CursorSdkRunEvent } from "../cursor-sdk-content.js"
import { cursorToolResults, parseBlobDataRow, parseRoot, type CursorToolResult } from "./cursor-records.js"
import { cursorSdkIndexPath, cursorSdkStorePath } from "./cursor-sdk-paths.js"
import { READ_BUSY_TIMEOUT_MS } from "./sqlite-busy.js"
import { openNativeStore, refuseNativeWrite } from "../read-only-sqlite.js"

/**
 * The Cursor SDK keeps two things per state root: one `store.db` of blobs
 * per agent, and one `index.db` naming every agent, its workspace, its runs
 * and — unlike an ACP store, whose `meta` row carries `latestRootBlobId` —
 * the blob id of the agent's latest checkpoint. Reading an SDK conversation
 * therefore starts here: the index says which root to fold, which model the
 * last turn ran under, and whether a run is in flight.
 *
 * Reads are synchronous because `watchTarget` is, and `node:sqlite` is loaded
 * through `process.getBuiltinModule` so a runtime without it degrades to
 * "no index" instead of failing to import the provider.
 */

export interface CursorSdkAgentRecord {
  agentId: string
  /** The workspace the agent was created in. */
  cwd: string
  status: "IDLE" | "RUNNING" | "ARCHIVED" | "UNKNOWN"
  name?: string
  /** Blob id of the latest checkpoint root in the agent's `store.db`. */
  rootId?: string
  createdAt?: string
  updatedAt?: string
  /** Model and parameters of the newest run, the SDK's own selection shape. */
  model?: CursorSdkModelSelection
  turns: number
  /** Whether the newest run is still non-terminal. */
  running: boolean
  /** Every run, oldest first. */
  runs: CursorSdkRun[]
  /**
   * Set when Mako created this agent from a `cursor-agent` store (an
   * `acp-sessions` or `chats` session) so the conversation could go on
   * through the SDK. `identity` is the catalog identity of that legacy row,
   * so the two collapse onto one thread.
   */
  imported?: CursorSdkImport
}

export interface CursorSdkImport {
  /** The legacy `store.db` the agent's blobs were copied from. */
  path: string
  /** The legacy row's catalog identity (`<agent id>` or `chats:<agent id>`). */
  identity: string
  /** The agent id the legacy store's own meta row names. */
  agentId: string
  /** Native checkpoint of the copied snapshot; absent on older imports. */
  revision?: string
}

/**
 * How a run ended short of finishing: the user stopped it, a later send
 * expired it after the process running it died (`force_send`), or it failed
 * with the SDK's error message.
 */
export type CursorSdkRunEnd =
  | { kind: "cancelled" }
  | { kind: "expired" }
  | { kind: "failed"; error?: string }

/** One send to an agent, as the index records it. */
export interface CursorSdkRun {
  runId: string
  /** How it ended short of finishing; absent for a run that finished or is still going. */
  end?: CursorSdkRunEnd
  running: boolean
  /** The conversation the run started from; absent for an agent's first run. */
  startRootId?: string
  /**
   * The conversation as the run last checkpointed it, when that moved past
   * `startRootId`. A run stopped before its first checkpoint has none: the
   * conversation never took its prompt or output, and the prompt record and
   * the run's event log still hold them.
   */
  rootId?: string
  model?: string
  startedAt?: string
  /** When it finished, was stopped or failed; an expired run's expiry is when the next send found it, so it has none. */
  endedAt?: string
  /** `run_events` holds its messages (`readCursorSdkRunEvents`). */
  evented: boolean
}

/** The key under which the import record sits in the agent's `metadata_json`. */
export const CURSOR_SDK_IMPORT_METADATA_KEY = "makoImport"

type SqliteModule = typeof import("node:sqlite")

let sqlite: SqliteModule | null | undefined

function sqliteModule(): SqliteModule | null {
  if (sqlite === undefined) {
    try {
      const loaded = process.getBuiltinModule("node:sqlite")
      sqlite = loaded ?? null
    } catch {
      sqlite = null
    }
  }
  return sqlite
}

function openReadOnly(path: string): DatabaseSync | null {
  const module = sqliteModule()
  if (!module) return null
  try {
    return openNativeStore(path, { timeout: READ_BUSY_TIMEOUT_MS })
  } catch {
    return null
  }
}

function text(value: SQLOutputValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : undefined
}

function count(value: SQLOutputValue | undefined): number {
  return Object.prototype.toString.call(value) === "[object Number]"
    ? Number(value)
    : 0
}

const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"])

function statusOf(value: string | undefined): CursorSdkAgentRecord["status"] {
  return value === "IDLE" || value === "RUNNING" || value === "ARCHIVED"
    ? value
    : "UNKNOWN"
}

function checkpointBlobId(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const parsed: { blobId?: string } = JSON.parse(raw)
    return text(parsed.blobId)
  } catch {
    return undefined
  }
}

function importRecord(raw: string | undefined): CursorSdkImport | undefined {
  if (!raw) return undefined
  try {
    const parsed: { [CURSOR_SDK_IMPORT_METADATA_KEY]?: { path?: string; identity?: string; agentId?: string; revision?: string } } =
      JSON.parse(raw)
    const record = parsed[CURSOR_SDK_IMPORT_METADATA_KEY]
    if (!record) return undefined
    const path = text(record.path)
    const identity = text(record.identity)
    const agentId = text(record.agentId)
    if (!path || !identity || !agentId) return undefined
    const imported: CursorSdkImport = { path, identity, agentId }
    const revision = text(record.revision)
    if (revision) imported.revision = revision
    return imported
  } catch {
    return undefined
  }
}

/** The `agent-<sha256(id)>` directory name the SDK gives an agent. */
export function cursorSdkDirectoryName(agentId: string): string {
  return `agent-${createHash("sha256").update(agentId).digest("hex")}`
}

/**
 * The agent an `agents/agent-<hash>/` directory belongs to. The hash is
 * one-way, so the index's ids are hashed until one matches; an imported
 * store's own meta row names the legacy agent, not necessarily this one,
 * which is why the directory rather than the store answers.
 */
export function cursorSdkAgentIdForDirectory(indexPath: string, directoryName: string): string | null {
  const database = openReadOnly(indexPath)
  if (!database) return null
  try {
    const rows = database.prepare("SELECT agent_id FROM agents").all()
    for (const row of rows) {
      const candidate = text(row["agent_id"])
      if (candidate && cursorSdkDirectoryName(candidate) === directoryName) return candidate
    }
    return null
  } catch {
    return null
  } finally {
    database.close()
  }
}

function modelParams(raw: string | undefined): CursorSdkModelSelection["params"] {
  if (!raw) return undefined
  try {
    const parsed: { id?: string; value?: string }[] = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    const params: { id: string; value: string }[] = []
    for (const entry of parsed) {
      const id = text(entry.id)
      const value = entry.value
      if (id && value !== undefined && value !== null)
        params.push({ id, value: String(value) })
    }
    return params.length > 0 ? params : undefined
  } catch {
    return undefined
  }
}

/** An index without run checkpoints records no runs to place, not an unreadable agent. */
function agentRuns(database: DatabaseSync, agentId: string): CursorSdkRun[] {
  const evented = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_events'").get() !== undefined
  let rows: ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>
  try {
    rows = database
      .prepare(`SELECT *, ${evented ? "EXISTS (SELECT 1 FROM run_events WHERE run_events.run_id = runs.run_id)" : "0"} AS evented FROM runs WHERE agent_id = ? ORDER BY turn_number`)
      .all(agentId)
  } catch {
    return []
  }
  const runs: CursorSdkRun[] = []
  for (const row of rows) {
    if (!("latest_checkpoint_ref_json" in row)) return []
    const runId = text(row["run_id"])
    if (!runId) continue
    const status = text(row["status"])
    const run: CursorSdkRun = { runId, running: status === undefined || !TERMINAL.has(status), evented: row["evented"] === 1 }
    const end = runEnd(status, text(row["error_code"]))
    if (end) run.end = end
    const startRootId = checkpointBlobId(text(row["start_checkpoint_ref_json"]))
    if (startRootId) run.startRootId = startRootId
    const rootId = checkpointBlobId(text(row["latest_checkpoint_ref_json"]))
    if (rootId && rootId !== startRootId) run.rootId = rootId
    const model = text(row["model"])
    if (model) run.model = model
    const startedAt = text(row["started_at"])
    if (startedAt) run.startedAt = startedAt
    const endedAt = end?.kind === "cancelled" ? text(row["cancelled_at"]) : end?.kind === "expired" ? undefined : text(row["finished_at"])
    if (endedAt) run.endedAt = endedAt
    runs.push(run)
  }
  return runs
}

function runEnd(status: string | undefined, error: string | undefined): CursorSdkRunEnd | undefined {
  if (status === "CANCELLED") return { kind: "cancelled" }
  if (status === "EXPIRED") return { kind: "expired" }
  if (status === "ERROR") return error ? { kind: "failed", error } : { kind: "failed" }
  return undefined
}

const RunEventSchema = z.object({ type: z.literal("sdk_message"), message: CursorSdkMessageSchema })
const RunEventRow = z.tuple([z.string().nullable(), z.string().nullable()])

/**
 * Every message a run streamed, as the SDK keeps it in `run_events`: the
 * live child's messages, deltas aside. A message this SDK version's
 * vocabulary doesn't describe is skipped, as the live decoder skips it.
 */
export function readCursorSdkRunEvents(indexPath: string, runId: string): CursorSdkRunEvent[] {
  const database = openReadOnly(indexPath)
  if (!database) return []
  const events: CursorSdkRunEvent[] = []
  try {
    const statement = database.prepare("SELECT payload_json, created_at FROM run_events WHERE run_id = ? AND event_type = 'run_stream_event' ORDER BY seq")
    // A long agent keeps hundreds of thousands of these: rows as arrays skip an object each.
    statement.setReturnArrays(true)
    for (const row of statement.iterate(runId)) {
      const columns = RunEventRow.safeParse(row)
      if (!columns.success) continue
      const [raw, created] = columns.data
      let payload: unknown
      try {
        payload = JSON.parse(raw ?? "")
      } catch {
        continue
      }
      const event = RunEventSchema.safeParse(payload)
      if (!event.success) continue
      events.push(created ? { message: event.data.message, at: created } : { message: event.data.message })
    }
    return events
  } catch {
    return []
  } finally {
    database.close()
  }
}

/** How far a call's result has been looked for: through `length` messages of checkpoint `ref`, whose last is `last`. */
interface Looked {
  ref: string
  length: number
  last: string | undefined
}

/**
 * The results a running run's checkpoints keep for calls its stream never
 * ended (`CursorSdkProjection.settle`). Cursor saves a checkpoint after each
 * step (verified with SDK 1.0.31: a read of a missing file had its
 * "Error: File not found" in the run's third of seven), so a result is there
 * long before the run ends.
 *
 * Only the run's messages are searched, past the checkpoint it started from.
 * A call is looked for again only once the run's latest checkpoint has moved,
 * and only in the messages added since, so checking at every step costs one
 * row read until Cursor saves a new step. Empty when the run wrote no
 * checkpoint or the stores can't be read.
 */
export class CursorSdkRunCheckpoints {
  private readonly stateRoot: string
  private readonly agentId: string
  private readonly runId: string
  private readonly looked = new Map<string, Looked>()
  private startLength: number | undefined

  constructor(stateRoot: string, agentId: string, runId: string) {
    this.stateRoot = stateRoot
    this.agentId = agentId
    this.runId = runId
  }

  results(callIds: ReadonlySet<string>): Map<string, CursorToolResult> {
    if (!callIds.size) return new Map()
    const refs = this.refs()
    if (!refs?.latest || refs.latest === refs.start) return new Map()
    const latest = refs.latest
    const wanted = new Set([...callIds].filter((id) => this.looked.get(id)?.ref !== latest))
    if (!wanted.size) return new Map()
    const store = openReadOnly(cursorSdkStorePath(this.stateRoot, this.agentId))
    if (!store) return new Map()
    try {
      const blobs = store.prepare("SELECT data FROM blobs WHERE id = ?")
      const hashes = rootHashes(blobs, latest)
      if (!hashes) return new Map()
      this.startLength ??= refs.start ? rootHashes(blobs, refs.start)?.length ?? 0 : 0
      const first = this.startLength <= hashes.length ? this.startLength : 0
      let from = hashes.length
      for (const id of wanted) from = Math.min(from, this.resumeAt(id, hashes, first))
      const results = cursorToolResults(blobs, hashes, from, hashes.length, wanted)
      for (const id of wanted) {
        if (results.has(id)) this.looked.delete(id)
        else this.looked.set(id, { ref: latest, length: hashes.length, last: hashes.at(-1) })
      }
      return results
    } catch {
      return new Map()
    } finally {
      store.close()
    }
  }

  /** Where to go on looking for `id`: past what was searched, unless a compaction rewrote the conversation since. */
  private resumeAt(id: string, hashes: readonly string[], first: number): number {
    const looked = this.looked.get(id)
    if (!looked || looked.length > hashes.length || looked.length <= first) return first
    return hashes[looked.length - 1] === looked.last ? looked.length : first
  }

  private refs(): { start: string | undefined; latest: string | undefined } | undefined {
    const index = openReadOnly(cursorSdkIndexPath(this.stateRoot))
    if (!index) return undefined
    try {
      const row = index.prepare("SELECT start_checkpoint_ref_json AS start, latest_checkpoint_ref_json AS latest FROM runs WHERE run_id = ?").get(this.runId)
      return { start: checkpointBlobId(text(row?.["start"])), latest: checkpointBlobId(text(row?.["latest"])) }
    } catch {
      return undefined
    } finally {
      index.close()
    }
  }
}

function rootHashes(blobs: StatementSync, rootId: string): string[] | undefined {
  const row = parseBlobDataRow(blobs.get(rootId))
  return row ? parseRoot(row.data).hashes : undefined
}

/** One agent's index row plus its newest run, or null when the index has none. */
export function readCursorSdkAgent(
  indexPath: string,
  agentId: string
): CursorSdkAgentRecord | null {
  const database = openReadOnly(indexPath)
  if (!database) return null
  try {
    const agent = database
      .prepare(
        "SELECT workspace_ref, status, latest_checkpoint_ref_json, name, metadata_json, created_at, updated_at FROM agents WHERE agent_id = ?"
      )
      .get(agentId)
    if (!agent) return null
    const run = database
      .prepare(
        "SELECT status, model, model_params_json, (SELECT COUNT(*) FROM runs WHERE agent_id = ?) AS turns FROM runs WHERE agent_id = ? ORDER BY turn_number DESC LIMIT 1"
      )
      .get(agentId, agentId)
    const modelId = text(run?.["model"])
    const runStatus = text(run?.["status"])
    const record: CursorSdkAgentRecord = {
      agentId,
      cwd: text(agent["workspace_ref"]) ?? "",
      status: statusOf(text(agent["status"])),
      turns: count(run?.["turns"]),
      running: runStatus !== undefined && !TERMINAL.has(runStatus),
      runs: agentRuns(database, agentId),
    }
    const name = text(agent["name"])
    if (name) record.name = name
    const rootId = checkpointBlobId(text(agent["latest_checkpoint_ref_json"]))
    if (rootId) record.rootId = rootId
    const createdAt = text(agent["created_at"])
    if (createdAt) record.createdAt = createdAt
    const updatedAt = text(agent["updated_at"])
    if (updatedAt) record.updatedAt = updatedAt
    const imported = importRecord(text(agent["metadata_json"]))
    if (imported) record.imported = imported
    if (modelId) {
      record.model = { id: modelId }
      const params = modelParams(text(run?.["model_params_json"]))
      if (params) record.model.params = params
    }
    return record
  } catch {
    return null
  } finally {
    database.close()
  }
}

/** What the index says about one agent, reduced to a comparable stamp. */
export interface CursorSdkAgentStamp {
  revision: string
  /** The newest `updated_at` of the agent's row and its runs, 0 when unknown. */
  updatedMs: number
}

/**
 * Every agent's index facts, keyed by its `agent-<hash>` directory. The SDK
 * streams each running agent's events into this one file, so the file's own
 * stat moves every few seconds for all agents at once; an agent's row and
 * its runs move only when that agent does.
 */
export function readCursorSdkAgentStamps(indexPath: string): Map<string, CursorSdkAgentStamp> | null {
  const database = openReadOnly(indexPath)
  if (!database) return null
  try {
    const runs = new Map<string, { count: number; updatedAt?: string }>()
    try {
      for (const row of database
        .prepare("SELECT agent_id, COUNT(*) AS runs, MAX(updated_at) AS updated_at FROM runs GROUP BY agent_id")
        .all()) {
        const agentId = text(row["agent_id"])
        if (agentId) runs.set(agentId, { count: count(row["runs"]), updatedAt: text(row["updated_at"]) })
      }
    } catch {
      // An index without runs stamps agents by their own rows.
    }
    const stamps = new Map<string, CursorSdkAgentStamp>()
    for (const row of database.prepare("SELECT * FROM agents").all()) {
      const agentId = text(row["agent_id"])
      if (!agentId) continue
      const run = runs.get(agentId)
      const facts = Object.keys(row).sort().map((key) => [key, row[key]])
      const revision = createHash("sha256")
        .update(JSON.stringify([facts, run?.count ?? 0, run?.updatedAt ?? null]))
        .digest("hex")
        .slice(0, 16)
      const updatedMs = Math.max(
        0,
        ...[text(row["updated_at"]), run?.updatedAt]
          .map((value) => (value ? Date.parse(value) : NaN))
          .filter((value) => Number.isFinite(value))
      )
      stamps.set(cursorSdkDirectoryName(agentId), { revision, updatedMs })
    }
    return stamps
  } catch {
    return null
  } finally {
    database.close()
  }
}

/**
 * The agent whose index row moved most recently. A write to `index.db` is
 * the SDK recording a checkpoint or a run transition for exactly one agent,
 * and this is the cheapest honest guess at which one.
 */
export function newestCursorSdkAgentId(indexPath: string): string | null {
  const database = openReadOnly(indexPath)
  if (!database) return null
  try {
    const row = database
      .prepare("SELECT agent_id FROM agents ORDER BY updated_at DESC LIMIT 1")
      .get()
    return text(row?.["agent_id"]) ?? null
  } catch {
    return null
  } finally {
    database.close()
  }
}

/**
 * Forget an agent in the index: its row, its runs and their events. The
 * agent's directory is named by the SHA-256 of its id, so a store that can no
 * longer be read is matched by hashing every id the index knows. Returns the
 * id removed, or null when the index has no such agent.
 */
export interface CursorSdkAgentMatch {
  /** The id the store's meta row names, when the store could be read. */
  agentId?: string
  /** The `agent-<sha256(agentId)>` directory the store lives in. */
  directoryName: string
}

export function removeCursorSdkAgent(indexPath: string, match: CursorSdkAgentMatch): string | null {
  const module = sqliteModule()
  if (!module) return null
  refuseNativeWrite("Cursor's agent index")
  let database: DatabaseSync
  try {
    database = new module.DatabaseSync(indexPath)
  } catch {
    return null
  }
  try {
    // The directory is the truth: an imported store's meta row names the
    // legacy agent, and the SDK row may sit under another id.
    let agentId: string | undefined
    const rows = database.prepare("SELECT agent_id FROM agents").all()
    for (const row of rows) {
      const candidate = text(row["agent_id"])
      if (candidate && cursorSdkDirectoryName(candidate) === match.directoryName) {
        agentId = candidate
        break
      }
    }
    agentId ??= match.agentId
    if (!agentId) return null
    database.exec("BEGIN")
    try {
      database.prepare("DELETE FROM run_events WHERE run_id IN (SELECT run_id FROM runs WHERE agent_id = ?)").run(agentId)
      database.prepare("DELETE FROM runs WHERE agent_id = ?").run(agentId)
      const removed = database.prepare("DELETE FROM agents WHERE agent_id = ?").run(agentId)
      database.exec("COMMIT")
      return removed.changes > 0 ? agentId : null
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  } catch {
    return null
  } finally {
    database.close()
  }
}
