import { createHash } from "node:crypto"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import type { CursorSdkModelSelection } from "./cursor-sdk-models.js"

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
  /** Runs the user stopped after they wrote to the conversation, oldest first. */
  cancelled: CursorSdkCancelledRun[]
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
}

/** A run the user stopped, oldest first. */
export type CursorSdkCancelledRun =
  | {
      recorded: true
      runId: string
      /** Blob id of the root the run last checkpointed: the conversation as it stopped. */
      rootId: string
      cancelledAt?: string
    }
  | {
      /**
       * Stopped before its first checkpoint: the conversation never took its
       * prompt or output. The prompt record and the run's event log still
       * hold them.
       */
      recorded: false
      runId: string
      /** The conversation the run started from; absent for an agent's first run. */
      startRootId?: string
      startedAt?: string
      cancelledAt?: string
    }

/** What a run streamed, in order: text and thinking deltas joined, each tool call at its latest state. */
export type CursorSdkStreamPart =
  | { type: "text" | "thinking"; text: string }
  | { type: "tool"; callId: string; name: string; status?: string; args?: CursorSdkJson; result?: CursorSdkJson }

export type CursorSdkJson = string | number | boolean | null | CursorSdkJson[] | { [key: string]: CursorSdkJson | undefined }

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
    return new module.DatabaseSync(path, { readOnly: true })
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
    const parsed: { [CURSOR_SDK_IMPORT_METADATA_KEY]?: { path?: string; identity?: string; agentId?: string } } =
      JSON.parse(raw)
    const record = parsed[CURSOR_SDK_IMPORT_METADATA_KEY]
    if (!record) return undefined
    const path = text(record.path)
    const identity = text(record.identity)
    const agentId = text(record.agentId)
    return path && identity && agentId ? { path, identity, agentId } : undefined
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

/** An index without run checkpoints records no stops, not an unreadable agent. */
function cancelledRuns(database: DatabaseSync, agentId: string): CursorSdkCancelledRun[] {
  let rows: ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>
  try {
    rows = database
      .prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'CANCELLED' ORDER BY turn_number")
      .all(agentId)
  } catch {
    return []
  }
  const cancelled: CursorSdkCancelledRun[] = []
  for (const row of rows) {
    if (!("latest_checkpoint_ref_json" in row)) return []
    const runId = text(row["run_id"])
    if (!runId) continue
    const rootId = checkpointBlobId(text(row["latest_checkpoint_ref_json"]))
    const startRootId = checkpointBlobId(text(row["start_checkpoint_ref_json"]))
    const cancelledAt = text(row["cancelled_at"])
    if (rootId && rootId !== startRootId) {
      cancelled.push({ recorded: true, runId, rootId, ...(cancelledAt ? { cancelledAt } : {}) })
      continue
    }
    const startedAt = text(row["started_at"])
    cancelled.push({
      recorded: false,
      runId,
      ...(startRootId ? { startRootId } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(cancelledAt ? { cancelledAt } : {}),
    })
  }
  return cancelled
}

type JsonRecord = { [key: string]: CursorSdkJson | undefined }

function isRecord(value: CursorSdkJson | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * The run's own event log: what the SDK streamed while it ran. An index
 * without `run_events` records none.
 */
export function readCursorSdkRunStream(indexPath: string, runId: string): CursorSdkStreamPart[] {
  const database = openReadOnly(indexPath)
  if (!database) return []
  const parts: CursorSdkStreamPart[] = []
  const tools = new Map<string, Extract<CursorSdkStreamPart, { type: "tool" }>>()
  const append = (type: "text" | "thinking", delta: string) => {
    const last = parts.at(-1)
    if (last?.type === type) last.text += delta
    else parts.push({ type, text: delta })
  }
  try {
    const rows = database
      .prepare("SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId)
    for (const row of rows) {
      let payload: CursorSdkJson
      try {
        payload = JSON.parse(text(row["payload_json"]) ?? "")
      } catch {
        continue
      }
      const message = isRecord(payload) ? payload["message"] : undefined
      if (!isRecord(message)) continue
      switch (message["type"]) {
        case "thinking": {
          const delta = str(message["text"])
          if (delta) append("thinking", delta)
          break
        }
        case "assistant": {
          const content = isRecord(message["message"]) ? message["message"]["content"] : undefined
          if (!Array.isArray(content)) break
          for (const part of content) {
            const delta = isRecord(part) && part["type"] === "text" ? str(part["text"]) : undefined
            if (delta) append("text", delta)
          }
          break
        }
        case "tool_call": {
          const callId = str(message["call_id"])
          const name = str(message["name"])
          if (!callId || !name) break
          const status = str(message["status"])
          const known = tools.get(callId)
          const tool = known ?? { type: "tool" as const, callId, name }
          if (status) tool.status = status
          if (message["args"] !== undefined) tool.args = message["args"]
          if (message["result"] !== undefined) tool.result = message["result"]
          if (!known) {
            tools.set(callId, tool)
            parts.push(tool)
          }
          break
        }
      }
    }
    return parts
  } catch {
    return []
  } finally {
    database.close()
  }
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
    const cancelled = cancelledRuns(database, agentId)
    const record: CursorSdkAgentRecord = {
      agentId,
      cwd: text(agent["workspace_ref"]) ?? "",
      status: statusOf(text(agent["status"])),
      turns: count(run?.["turns"]),
      running: runStatus !== undefined && !TERMINAL.has(runStatus),
      cancelled,
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
