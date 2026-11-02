import { existsSync, readdirSync, statfsSync, statSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { NativeStores } from "../read-only-sqlite.js"
import { cursorCompactionReadings, type CursorCompactionRun } from "./cursor-compactions.js"
import { parseRootExtent } from "./cursor-records.js"
import { checkpointBlobId, cursorSdkDirectoryName } from "./cursor-sdk-index.js"
import { cursorSdkIndexPath } from "./cursor-sdk-paths.js"

/**
 * The checkpoints the Cursor SDK leaves behind in Mako's agent stores.
 *
 * The SDK saves a checkpoint after every step of a run: a new root blob
 * listing every message hash of the conversation so far, then the agent's
 * `latestCheckpoint` in `index.db` names it. Nothing deletes the root it
 * replaced (the SDK's `deleteBlob` is never called), so a store grows by the
 * whole conversation's hash list at every step: on 2026-11-01 one agent's
 * 59,609 roots took 9.45 GB of its 10.5 GB, 2,271 steps for each of its 26
 * runs.
 *
 * What still reads a root: the agent's latest checkpoint and each run's
 * start and latest (the SDK's resume, a fork, the fold's stops and replays,
 * a journal's history read as it was at a turn's end), the store's own meta
 * (an imported `cursor-agent` store's `latestRootBlobId`), and any blob a
 * kept one names (summary windows, subagent states, turns). The collector
 * marks from those, following every 32-byte field at any depth of a
 * protobuf and every 64-character hex id anywhere in a blob's bytes, so it
 * keeps more than it must rather than less. The fold also places each
 * summary window by a binary search over a run's intermediate roots
 * (`cursor-compactions.ts`), so every root that search settles on is kept
 * too, and the search reads the same after as before. Then it deletes only
 * unmarked blobs shaped as roots. Messages and every other blob stay.
 *
 * An agent is collected only while quiet: not running, no run running, and
 * nothing in its index rows or its store changed for `quietMs`. Deletes go in
 * short transactions (`BATCH_ROWS`), each of which first checks, holding the
 * store's write lock, that the index holds the agent as it was when marked
 * and that the store's newest rowid hasn't moved (the SDK writes `INSERT OR
 * REPLACE`, so even a blob written again moves it); anything moved ends the
 * agent's sweep. A run starts in the index before it writes a blob, so no
 * root a run is about to name goes. A crash between batches has deleted only
 * unmarked roots. A batch holds the store's lock for milliseconds. Then, once
 * what went is at least `VACUUM_MIN_BYTES` and a quarter of the file, a
 * VACUUM gives the space back, if the disk can hold what's kept twice over
 * (VACUUM writes a copy and the WAL another). A VACUUM holds the lock for
 * seconds (10.7 s for 1.9 GB kept), so Mako's patch of the SDK waits a
 * minute on a busy store rather than its 5 s, and the host stops a sweep of
 * an agent it is about to open.
 */

/** What a pass did to one agent's store. */
export interface CursorCheckpointSweep {
  /** The `agents/agent-<sha256>` folder. */
  directory: string
  agentId?: string
  outcome: "collected" | "skipped"
  /** Why an agent was skipped, or why its sweep stopped early. */
  reason?: CursorSweepReason
  blobs: number
  /** Blobs shaped as roots. */
  roots: number
  /** Blobs some kept checkpoint names, roots and messages alike. */
  marked: number
  /** Intermediate roots kept because the fold's compaction search settles on them. */
  placed: number
  deleted: number
  deletedBytes: number
  fileBefore: number
  fileAfter: number
  vacuumed: boolean
  ms: number
  /** The store as the pass left it, for the next pass's `stamps`. */
  stamp?: CursorSweepStamp
}

export type CursorSweepReason =
  | "not in the index"
  | "running"
  | "recent"
  | "unchanged"
  | "moved"
  | "unreadable"
  | "no room to compact"
  | "dry run"

export interface CursorCollectOptions {
  stateRoot: string
  stores: NativeStores
  /** The `agent-<sha256>` folders to sweep; every agent's when absent. */
  directories?: readonly string[]
  now?: number
  /** How long an agent's index rows and store must have been still. */
  quietMs?: number
  /** Count what would go without deleting anything. */
  dryRun?: boolean
  /** What each agent's store was at its last pass (`CursorSweepStamp`): an agent whose store is as it was is skipped. */
  stamps?: ReadonlyMap<string, CursorSweepStamp>
  /** Free bytes on the store's disk; `statfs` unless a test says. */
  freeBytes?: (path: string) => number
  /** What must have gone before a VACUUM; `VACUUM_MIN_BYTES` unless a test says. */
  vacuumMinBytes?: number
  /** Test hook: runs before each batch of deletes takes the store's lock. */
  beforeBatch?: (batch: number) => void
}

/** A store as a pass left it: its size and when it was last written, its WAL included. */
export interface CursorSweepStamp {
  size: number
  mtimeMs: number
}

export const CURSOR_QUIET_MS = 30 * 60_000
const BATCH_ROWS = 256
export const VACUUM_MIN_BYTES = 64 * 1024 * 1024
/** How deep the marking follows nested protobuf messages. */
const MAX_DEPTH = 8
const HEX_ID = /[0-9a-f]{64}/g
const RUNNING = new Set(["RUNNING", "CREATING"])

const AgentRowSchema = z.looseObject({
  agent_id: z.string(),
  status: z.string(),
  updated_at: z.string(),
})
const SqlTextSchema = z.string()
const RunRowSchema = z.looseObject({
  run_id: z.string().nullish(),
  status: z.string(),
  updated_at: z.string(),
  start_checkpoint_ref_json: z.string().nullish(),
  latest_checkpoint_ref_json: z.string().nullish(),
})
const MetaRowSchema = z.object({ value: z.string() })
const RowidSchema = z.object({ rowid: z.number().nullable() })
const IdRowSchema = z.object({ rowid: z.number(), id: z.string() })
const DataRowSchema = z.object({ data: z.instanceof(Uint8Array) })
const SizeRowSchema = z.object({ size: z.number() })
const PragmaSchema = z.record(z.string(), z.number())

/** One agent's rows in the index: what the sweep keeps from, and what must not move while it deletes. */
interface IndexedAgent {
  agentId: string
  status: string
  updatedMs: number
  running: boolean
  /** Every 64-character hex id in the agent's row and its runs' rows: its checkpoints and anything else they name. */
  named: string[]
  /** The runs as the fold reads them (`readCursorSdkAgent`), for its compaction search. */
  runs: CursorCompactionRun[]
  /** The rows as read, compared before each batch. */
  fingerprint: string
}

/** Sweeps every agent store under `stateRoot`, one at a time. */
export function collectCursorCheckpoints(options: CursorCollectOptions): CursorCheckpointSweep[] {
  const agentsFolder = join(options.stateRoot, "agents")
  if (!existsSync(agentsFolder)) return []
  const sweeps: CursorCheckpointSweep[] = []
  const indexed = readIndex(options.stores, options.stateRoot)
  const only = options.directories && new Set(options.directories)
  for (const directory of readdirSync(agentsFolder).filter((name) => name.startsWith("agent-") && (!only || only.has(name))).sort()) {
    const store = join(agentsFolder, directory, "store.db")
    if (!existsSync(store)) continue
    sweeps.push(sweepAgent(options, directory, store, indexed?.get(directory)))
  }
  return sweeps
}

/** The index's agents by the folder the SDK gives each, or null when the index can't be read. */
function readIndex(stores: NativeStores, stateRoot: string): Map<string, IndexedAgent> | null {
  const path = cursorSdkIndexPath(stateRoot)
  if (!existsSync(path)) return null
  let database: DatabaseSync
  try {
    database = stores.open(path, { timeout: 2_000 })
  } catch {
    return null
  }
  try {
    return indexedAgents(database)
  } catch {
    return null
  } finally {
    database.close()
  }
}

function indexedAgents(database: DatabaseSync, only?: string): Map<string, IndexedAgent> {
  const agents = new Map<string, IndexedAgent>()
  const rows = only === undefined
    ? database.prepare("SELECT * FROM agents").all()
    : database.prepare("SELECT * FROM agents WHERE agent_id = ?").all(only)
  const runs = database.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY turn_number")
  for (const raw of rows) {
    const agent = AgentRowSchema.parse(raw)
    const runRows = runs.all(agent.agent_id).map((row) => ({ row, run: RunRowSchema.parse(row) }))
    const named = new Set<string>()
    for (const row of [raw, ...runRows.map((each) => each.row)])
      for (const [column, value] of Object.entries(row)) {
        const text = SqlTextSchema.safeParse(value).data
        if (text === undefined) continue
        hexIdsIn(text, named)
        const blobId = column.endsWith("checkpoint_ref_json") ? checkpointBlobId(text) : undefined
        if (blobId) named.add(blobId)
      }
    const updatedMs = Math.max(Date.parse(agent.updated_at) || 0, ...runRows.map(({ run }) => Date.parse(run.updated_at) || 0))
    agents.set(cursorSdkDirectoryName(agent.agent_id), {
      agentId: agent.agent_id,
      status: agent.status,
      updatedMs,
      running: agent.status === "RUNNING" || runRows.some(({ run }) => RUNNING.has(run.status)),
      named: [...named],
      runs: runRows.flatMap(({ run }) => {
        if (!run.run_id) return []
        const compaction: CursorCompactionRun = { runId: run.run_id }
        const startRootId = checkpointBlobId(run.start_checkpoint_ref_json ?? undefined)
        const rootId = checkpointBlobId(run.latest_checkpoint_ref_json ?? undefined)
        if (startRootId) compaction.startRootId = startRootId
        if (rootId && rootId !== startRootId) compaction.rootId = rootId
        return [compaction]
      }),
      fingerprint: JSON.stringify([raw, ...runRows.map((each) => each.row)]),
    })
  }
  return agents
}

function hexIdsIn(text: string, into: Set<string>): void {
  for (const match of text.matchAll(HEX_ID)) into.add(match[0])
}

function sweepAgent(options: CursorCollectOptions, directory: string, store: string, agent: IndexedAgent | undefined): CursorCheckpointSweep {
  const started = performance.now()
  const fileBefore = storeBytes(store)
  const sweep: CursorCheckpointSweep = {
    directory, outcome: "skipped", blobs: 0, roots: 0, marked: 0, placed: 0, deleted: 0, deletedBytes: 0, fileBefore, fileAfter: fileBefore, vacuumed: false, ms: 0,
  }
  const done = (reason?: CursorSweepReason): CursorCheckpointSweep => {
    if (reason) sweep.reason = reason
    sweep.fileAfter = storeBytes(store)
    // Only a sweep that went through marks the store as done: one skipped or cut short is looked at again.
    if (sweep.outcome === "collected" && !reason) sweep.stamp = stampOf(store)
    sweep.ms = Math.round(performance.now() - started)
    return sweep
  }
  if (!agent) return done("not in the index")
  sweep.agentId = agent.agentId
  if (agent.running) return done("running")
  const now = options.now ?? Date.now()
  const quiet = options.quietMs ?? CURSOR_QUIET_MS
  if (now - agent.updatedMs < quiet || now - lastWrite(store) < quiet) return done("recent")
  const before = options.stamps?.get(directory)
  const current = stampOf(store)
  if (before && before.size === current.size && before.mtimeMs === current.mtimeMs) return done("unchanged")
  let database: DatabaseSync
  try {
    database = options.dryRun ? options.stores.open(store, { timeout: 2_000 }) : options.stores.openForWriting(store)
  } catch {
    return done("unreadable")
  }
  let outcome: CursorSweepReason | undefined
  try {
    database.exec("PRAGMA busy_timeout = 0")
    sweep.outcome = "collected"
    outcome = collectStore(database, options, store, agent, sweep)
  } catch {
    sweep.outcome = "skipped"
    outcome = "unreadable"
  } finally {
    database.close()
  }
  // Closing the last connection checkpoints the WAL, so the store is measured after.
  return done(outcome)
}

/** Marks, then deletes what's unmarked and shaped as a root; the reason it stopped short, if it did. */
function collectStore(database: DatabaseSync, options: CursorCollectOptions, store: string, agent: IndexedAgent, sweep: CursorCheckpointSweep): CursorSweepReason | undefined {
  const newest = () => RowidSchema.parse(database.prepare("SELECT max(rowid) AS rowid FROM blobs").get()).rowid ?? 0
  const through = newest()
  const read = database.prepare("SELECT data FROM blobs WHERE id = ?")
  const exists = database.prepare("SELECT 1 AS held FROM blobs WHERE id = ?")
  const held = (id: string) => exists.get(id) !== undefined
  const marked = new Set<string>()
  const windows = new Set<string>()
  const pending = [...agent.named, ...metaIds(database)]
  while (pending.length) {
    const id = pending.pop()
    if (id === undefined || marked.has(id)) continue
    const row = read.get(id)
    if (!row) continue
    marked.add(id)
    const bytes = DataRowSchema.parse(row).data
    if (isCheckpointRoot(bytes, held)) {
      sweep.roots += 1
      for (const window of parseRootExtent(bytes).windows) windows.add(window)
    }
    for (const named of idsNamedBy(bytes)) if (!marked.has(named)) pending.push(named)
  }
  sweep.marked = marked.size
  // The fold places each summary by searching a run's intermediate roots; the ones it settles on stay, so it settles the same.
  const placed = new Set<number>()
  cursorCompactionReadings(database, agent.runs, windows, (row) => placed.add(row))
  const doomed: { rowid: number; id: string }[] = []
  const size = database.prepare("SELECT length(data) AS size FROM blobs WHERE rowid = ?")
  const data = database.prepare("SELECT data FROM blobs WHERE rowid = ?")
  for (const raw of database.prepare("SELECT rowid, id FROM blobs WHERE rowid <= ? ORDER BY rowid").iterate(through)) {
    const row = IdRowSchema.parse(raw)
    sweep.blobs += 1
    if (marked.has(row.id)) continue
    const body = data.get(row.rowid)
    if (!body || !isCheckpointRoot(DataRowSchema.parse(body).data, held)) continue
    sweep.roots += 1
    if (placed.has(row.rowid)) {
      sweep.placed += 1
      continue
    }
    doomed.push(row)
    sweep.deletedBytes += SizeRowSchema.parse(size.get(row.rowid)).size
  }
  if (options.dryRun) {
    sweep.deleted = doomed.length
    return "dry run"
  }
  sweep.deletedBytes = 0
  const remove = database.prepare("DELETE FROM blobs WHERE rowid = ? AND id = ?")
  for (let start = 0; start < doomed.length; start += BATCH_ROWS) {
    options.beforeBatch?.(start / BATCH_ROWS)
    database.exec("BEGIN IMMEDIATE")
    let committed = false
    try {
      if (newest() !== through || !unmoved(options, agent)) return "moved"
      for (const row of doomed.slice(start, start + BATCH_ROWS)) {
        const bytes = size.get(row.rowid)
        if (remove.run(row.rowid, row.id).changes === 1 && bytes) {
          sweep.deleted += 1
          sweep.deletedBytes += SizeRowSchema.parse(bytes).size
        }
      }
      database.exec("COMMIT")
      committed = true
    } finally {
      if (!committed) database.exec("ROLLBACK")
    }
  }
  return compact(database, options, store, sweep)
}

/** Whether the index still holds the agent exactly as the sweep marked it. */
function unmoved(options: CursorCollectOptions, agent: IndexedAgent): boolean {
  let index: DatabaseSync
  try {
    index = options.stores.open(cursorSdkIndexPath(options.stateRoot), { timeout: 2_000 })
  } catch {
    return false
  }
  try {
    return indexedAgents(index, agent.agentId).get(cursorSdkDirectoryName(agent.agentId))?.fingerprint === agent.fingerprint
  } catch {
    return false
  } finally {
    index.close()
  }
}

/** VACUUM once what went is worth it and the disk can hold what's kept twice over. */
function compact(database: DatabaseSync, options: CursorCollectOptions, store: string, sweep: CursorCheckpointSweep): CursorSweepReason | undefined {
  const pages = PragmaSchema.parse(database.prepare("PRAGMA page_count").get())["page_count"] ?? 0
  const free = PragmaSchema.parse(database.prepare("PRAGMA freelist_count").get())["freelist_count"] ?? 0
  const pageSize = PragmaSchema.parse(database.prepare("PRAGMA page_size").get())["page_size"] ?? 4096
  const freeBytes = free * pageSize
  const least = options.vacuumMinBytes ?? VACUUM_MIN_BYTES
  if (freeBytes < least || freeBytes * 4 < pages * pageSize) return undefined
  const kept = (pages - free) * pageSize
  const room = (options.freeBytes ?? diskFree)(store)
  if (room < kept * 2 + VACUUM_MIN_BYTES) return "no room to compact"
  database.exec("VACUUM")
  database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
  sweep.vacuumed = true
  return undefined
}

function diskFree(path: string): number {
  const stats = statfsSync(path)
  return stats.bavail * stats.bsize
}

/** Ids the store's own meta row names: an imported `cursor-agent` store keeps its `latestRootBlobId` there. */
function metaIds(database: DatabaseSync): string[] {
  const ids = new Set<string>()
  for (const row of database.prepare("SELECT value FROM meta").all()) {
    const value = MetaRowSchema.safeParse(row).data?.value
    if (value === undefined) continue
    hexIdsIn(value, ids)
    // The SDK's meta values are hex-encoded JSON; the ids inside are read from the decoded text.
    if (/^(?:[0-9a-f]{2})+$/.test(value)) hexIdsIn(Buffer.from(value, "hex").toString("latin1"), ids)
  }
  return [...ids]
}

/** Every id a blob might name: each 32-byte field at any depth it parses to, and each 64-character hex id in its bytes. */
export function idsNamedBy(data: Uint8Array): Set<string> {
  const ids = new Set<string>()
  hexIdsIn(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1"), ids)
  const visit = (bytes: Uint8Array, depth: number) => {
    const fields = strictFields(bytes)
    if (!fields) return
    for (const { value } of fields) {
      if (!(value instanceof Uint8Array)) continue
      if (value.length === 32) ids.add(Buffer.from(value).toString("hex"))
      else if (depth < MAX_DEPTH) visit(value, depth + 1)
    }
  }
  visit(data, 0)
  return ids
}

/**
 * Whether a blob is a checkpoint root (`ConversationStateStructure`): a
 * protobuf read to its last byte whose field 1 is the message hash list, each
 * 32 bytes, and whose field 10 (its mode) is a number. Messages are JSON,
 * which never starts so; a prompt record (`parsePromptRecord`, which the fold
 * finds by scanning, so nothing names it) keeps its text in field 1 and the
 * state it was sent against in field 10, 32 bytes, and is never one.
 * `held` says whether the store holds a blob: a root's first and last hashes
 * are messages, which no collection deletes.
 */
export function isCheckpointRoot(data: Uint8Array, held: (id: string) => boolean): boolean {
  if (data[0] !== 0x0a || data[1] !== 0x20) return false
  const fields = strictFields(data)
  if (!fields) return false
  const hashes: Uint8Array[] = []
  for (const { field, value } of fields) {
    if (field === 10 && value instanceof Uint8Array) return false
    if (field !== 1) continue
    if (!(value instanceof Uint8Array) || value.length !== 32) return false
    hashes.push(value)
  }
  const first = hashes[0]
  const last = hashes.at(-1)
  return first !== undefined && last !== undefined && held(Buffer.from(first).toString("hex")) && held(Buffer.from(last).toString("hex"))
}

/** A protobuf's top-level fields, or null unless every byte reads as one. */
function strictFields(data: Uint8Array): { field: number; value: number | Uint8Array }[] | null {
  const fields: { field: number; value: number | Uint8Array }[] = []
  let index = 0
  const varint = (): number | undefined => {
    let value = 0
    for (let shift = 0; shift <= 49 && index < data.length; shift += 7) {
      const byte = data[index++] ?? 0
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
    }
    return undefined
  }
  while (index < data.length) {
    const tag = varint()
    if (tag === undefined || tag < 8) return null
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) {
      const value = varint()
      if (value === undefined) return null
      fields.push({ field, value })
    } else if (wire === 2) {
      const length = varint()
      if (length === undefined || length > data.length - index) return null
      fields.push({ field, value: data.subarray(index, index + length) })
      index += length
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4
      if (data.length - index < width) return null
      index += width
    } else return null
  }
  return fields
}

function storeBytes(store: string): number {
  return ["", "-wal"].reduce((total, suffix) => total + (existsSync(store + suffix) ? statSync(store + suffix).size : 0), 0)
}

/** When the store or its WAL was last written; an empty WAL is one a reader made, which holds no write. */
function lastWrite(store: string): number {
  return Math.max(...["", "-wal"].map((suffix) => {
    if (!existsSync(store + suffix)) return 0
    const stats = statSync(store + suffix)
    return suffix && !stats.size ? 0 : stats.mtimeMs
  }))
}

function stampOf(store: string): CursorSweepStamp {
  return { size: storeBytes(store), mtimeMs: lastWrite(store) }
}
