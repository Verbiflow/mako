import { readPromptAttachments } from "../prompt-attachments.js"
import { cursorModelSettings } from "./cursor-settings.js"
import { CursorDesktopStore } from "./cursor-desktop.js"
import { cursorFailure, cursorTaskOpener } from "./cursor-presentation.js"
import { compactionEvent } from "../events.js"
import { proposedPlanBlock, type ProposedPlan } from "../content.js"
/**
 * Cursor CLI sessions.
 *
 * Native store: `~/.cursor/chats/<workspace-hash>/<session-uuid>/store.db`,
 * an SQLite pair of tables: `blobs(id, data)` holds content-addressed
 * messages as JSON, and `meta` holds one JSON row naming the session and the
 * `latestRootBlobId`. The root blob is a protobuf whose repeated field 1 is
 * the ordered list of message hashes — that list *is* the transcript order —
 * with the workspace URI in field 9. A sibling `meta.json` (newer sessions)
 * carries cwd and timestamps without touching SQLite at all.
 *
 * Messages: `system` / `user` / `assistant` / `tool` roles; assistant
 * content is `text`, `reasoning` and `tool-call` parts; `tool` messages
 * carry the paired `tool-result`. Like Grok, Cursor wraps what the user
 * actually typed in a `<user_query>` tag inside a message that is mostly
 * injected context; user messages without the tag are scaffolding and are
 * skipped. A store whose meta carries `subagentInfo` is a Task child of
 * another agent and is not a catalog thread. Verified against 181 real
 * session stores.
 *
 * SQLite comes from `node:sqlite` — present in the Node this app ships with;
 * where it is missing the provider reports no sessions rather than failing
 * the catalog.
 */

import { readdir, readFile, stat, rm } from "node:fs/promises"
import { homedir } from "node:os"
import {
  newestCursorSdkAgentId,
  cursorSdkAgentIdForDirectory,
  readCursorSdkAgent,
  readCursorSdkAgentStamps,
  readCursorSdkRunEvents,
  removeCursorSdkAgent,
  type CursorSdkAgentMatch,
  type CursorSdkAgentRecord,
  type CursorSdkAgentStamp,
  type CursorSdkRun,
} from "./cursor-sdk-index.js"
import { cursorRunEntries, type CursorSdkReplay } from "../cursor-sdk-content.js"
import { cursorSdkReportedSettings } from "./cursor-sdk-models.js"
import {
  cursorChatIdentity,
  cursorSdkIndexPath,
  cursorSdkStateRoot,
  cursorSdkStorePath,
} from "./cursor-sdk-paths.js"
import { dirname, join, basename, sep } from "node:path"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import {
  clip,
  EntrySink,
  titleFrom,
  type EntryBlock,
  type Thread,
  type UnreadRecord,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import {
  type JsonValue,
  type CursorRoot,
  type CursorTextContent,
  type SqliteStatementResult,
  isStringValue,
  isNumberValue,
  isBytesValue,
  isJsonObject,
  stringValue,
  parseJson,
  eachField,
  parseRoot,
  parseBlobDataRow,
  formatToolResult,
  plainText,
  cursorAttachments,
  cursorToolResults,
  parseRootExtent,
  readCursorMessage,
  type CursorRootExtent,
} from "./cursor-records.js"
import { todoDetails } from "../tool-plan.js"
import { CURSOR_TODO_WRITES } from "../harnesses/cursor.js"
import { isBusy, READ_BUSY_TIMEOUT_MS, SqliteFailure } from "./sqlite-busy.js"
import { openNativeStore } from "../read-only-sqlite.js"
import { filesUnder, tableColumns, type RecordDatabase, type SessionRecords } from "../harness-records.js"
import {
  SessionUnreadable,
  type NativeFile,
  type SessionFollower,
  type SessionProvider,
  type SessionUpdate,
} from "./types.js"

/** Where a user turn begins: its index in the root's hash list and in the entries. */
interface ExchangeStart {
  hash: number
  entry: number
}

/**
 * Stopped runs by where they sit in the hash list: a recorded run where its
 * last checkpoint ended, an unrecorded one where the conversation stood when
 * it started.
 */
type RunStops = Map<number, CursorSdkRun[]>

/**
 * A run whose messages `run_events` kept, by where it sits in the hash list:
 * from its prompt up to where its last checkpoint ended. The fold replays it
 * (`cursorRunEntries`) instead of reading the messages it checkpointed.
 */
interface RunSpan {
  run: CursorSdkRun
  end: number
}

/** What a fold reads: the root, its whole hash list, its summaries, its stopped runs and the runs it replays. */
interface FoldInput {
  rootId: string
  hashes: string[]
  compactions: Compactions
  stops: RunStops
  /** Replayed runs by their prompt's index. */
  spans: Map<number, RunSpan>
  /** Where each run's messages and an unrecorded run's prompt are read from. */
  indexPath: string
}

function stopKey(stops: RunStops): string {
  return JSON.stringify(
    [...stops]
      .sort(([a], [b]) => a - b)
      .map(([at, runs]) => [at, runs.map((run) => [run.runId, run.end?.kind, run.endedAt])])
  )
}

/** Every index each hash sits at, ascending: a message can repeat. */
function hashPositions(hashes: readonly string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>()
  hashes.forEach((hash, index) => {
    const known = positions.get(hash)
    if (known) known.push(index)
    else positions.set(hash, [index])
  })
  return positions
}

/** The index in `indices` closest to `target`. */
function nearest(indices: readonly number[] | undefined, target: number): number | undefined {
  let best: number | undefined
  for (const index of indices ?? []) if (best === undefined || Math.abs(index - target) < Math.abs(best - target)) best = index
  return best
}

/**
 * How a run's turn ended, as the live driver settles it: a run that expired
 * lost the process running it, so its open calls stopped midway like a
 * failed run's. Absent while it runs.
 */
function runEnding(run: CursorSdkRun): CursorSdkReplay["ending"] {
  if (run.running) return undefined
  const outcome = run.end?.kind === "cancelled" ? "cancelled" : run.end ? "error" : "finished"
  const error = run.end?.kind === "failed" ? run.end.error : undefined
  return { outcome, ...error && { error }, ...run.endedAt && { at: run.endedAt } }
}

/** Each replayed run at its prompt, with what changes its replay: where it ends and whether it has. */
function spanKeys(spans: Map<number, RunSpan>): SpanKey[] {
  return [...spans]
    .sort(([a], [b]) => a - b)
    .map(([prompt, { run, end }]) => ({ prompt, key: `${run.runId}:${end}:${run.running ? "running" : (run.end?.kind ?? "finished")}` }))
}

interface SpanKey {
  prompt: number
  key: string
}

function sameSpans(left: readonly SpanKey[], right: readonly SpanKey[]): boolean {
  return left.length === right.length && left.every((span, index) => span.key === right[index]?.key && span.prompt === right[index]?.prompt)
}

/** One translated store, keyed by the root blob, stops and replayed runs that produced it. */
interface StoreFold {
  rootId: string
  stopKey: string
  spans: SpanKey[]
  hashes: string[]
  entries: ThreadEntry[]
  exchanges: ExchangeStart[]
  unread: UnreadRecord[] | undefined
}

/** A fold plus the entry index from which a listener must replace. */
interface FoldStep {
  fold: StoreFold
  replaceFrom: number
}

/** Entries translated from a slice of the hash list. */
interface FoldedHashes {
  entries: ThreadEntry[]
  exchanges: ExchangeStart[]
  /** The sink dropped history: indices no longer line up with the hash list. */
  dropped: boolean
  unread: UnreadRecord[] | undefined
}

/**
 * The unread records of a fold that went on from `earlier`'s. Appended
 * messages add to its counts; messages folded again were counted in both,
 * so each kind keeps the larger count, never fewer than it found.
 */
function laterUnread(earlier: UnreadRecord[] | undefined, later: UnreadRecord[] | undefined, refolded: boolean): UnreadRecord[] | undefined {
  if (!earlier || !later) return earlier ?? later
  const records = new Map(earlier.map((record) => [`${record.reason}\0${record.kind}`, { ...record }]))
  for (const record of later) {
    const known = records.get(`${record.reason}\0${record.kind}`)
    if (!known) records.set(`${record.reason}\0${record.kind}`, record)
    else known.count = refolded ? Math.max(known.count, record.count) : known.count + record.count
  }
  return [...records.values()]
}

/**
 * Past this many entries the sink starts dropping history and entry indices
 * no longer line up with the hash list, so an incremental fold gives way to
 * a whole one (the sink's own budget is 6000).
 */
const FOLD_INCREMENTAL_LIMIT = 6000

/** Checkpoints whose placement is kept: every run of the few longest agents. */
const MAX_CHECKPOINTS = 4096

interface CursorMeta {
  agentId?: string
  name?: string
  createdAt?: string | number
  latestRootBlobId?: string
  model?: string
  /** Set when this store is a child of another agent, not a user-facing thread. */
  subagent?: boolean
}

interface CursorSidecar {
  cwd?: string
  title?: string
  createdAtMs?: number
  updatedAtMs?: number
  model?: string
}

/** Indices in `hashes` where a summary replaced everything before them: the archived window's blob, and its summary when it kept one. */
type Compactions = Map<number, { window: string; summary?: string }>

/** A root with its summarized-away windows restored ahead of the live one. */
interface CursorConversation extends CursorRoot {
  compactions: Compactions
}

type SqliteRows = ReturnType<StatementSync["all"]>
type ToolBlock = Extract<EntryBlock, { type: "tool" }>

interface MetaValueRow {
  value: string | NodeJS.NonSharedUint8Array
}

let sqliteOpen: ((path: string) => DatabaseSync) | null | undefined

/** `node:sqlite` loaded once, lazily; null when the runtime lacks it. */
async function openDatabase(path: string): Promise<DatabaseSync | null> {
  if (sqliteOpen === undefined) {
    try {
      await import("node:sqlite")
      sqliteOpen = (file) => openNativeStore(file, { timeout: READ_BUSY_TIMEOUT_MS })
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

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

/** Epoch millis or an ISO string — Cursor's meta has carried both. */
function isoOf(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isNumberValue(value)) return new Date(value).toISOString()
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && asNumber > 1e12)
    return new Date(asNumber).toISOString()
  return value
}

/** The summary an archived window was replaced by: its field 2. */
function windowSummary(data: Uint8Array): string | undefined {
  let summary: string | undefined
  eachField(data, (field, value) => {
    if (field === 2 && value instanceof Uint8Array) summary = Buffer.from(value).toString("utf8").trim()
  })
  return summary || undefined
}

/**
 * The SDK's record of one prompt as sent: its text (field 1), the state it
 * was sent against (field 10) and when (field 25, epoch millis). A turn
 * record in the root points at it once the turn checkpoints.
 */
function parsePromptRecord(data: Uint8Array): { text: string; at: number } | null {
  let text: string | undefined
  let state = false
  let at: number | undefined
  eachField(data, (field, value) => {
    if (value instanceof Uint8Array) {
      if (field === 1) text = Buffer.from(value).toString("utf8")
      if (field === 10 && value.length === 32) state = true
    } else if (field === 25) at = value
  })
  return text?.trim() && state && at !== undefined ? { text: text.trim(), at } : null
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/
const SUMMARY_PREFIX = /^\s*\[Previous conversation summary\]:?\s*/

/** What the user actually typed, or null for an injected scaffold message. */
function spokenText(content: CursorTextContent): string | null {
  const text = plainText(content)
  const match = USER_QUERY.exec(text)
  if (match) return (match[1] ?? "").trim() || null
  // Older messages carry the bare prompt with no scaffolding at all.
  const trimmed = text.trim()
  if (
    !trimmed ||
    trimmed.startsWith("<") ||
    trimmed.startsWith("[Previous conversation summary]")
  ) {
    return null
  }
  return trimmed
}

async function nativeFiles(paths: string[]): Promise<NativeFile[]> {
  const files: NativeFile[] = []
  const iterator = paths.values()
  const worker = async () => {
    while (true) {
      const item = iterator.next()
      if (item.done) return
      // A session directory without a store yet.
      const info = await stat(item.value).catch(() => null)
      if (info) {
        const sidecars = await Promise.all([
          stat(`${item.value}-wal`).catch(() => null),
          stat(join(dirname(item.value), "meta.json")).catch(() => null),
        ])
        const revision = [info, ...sidecars]
          .map((value) =>
            value
              ? `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
              : "missing"
          )
          .join("|")
        files.push({
          path: item.value,
          bytes: info.size,
          mtimeMs: Math.max(
            info.mtimeMs,
            ...sidecars.map((value) => value?.mtimeMs ?? 0)
          ),
          revision,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, worker))
  return files
}

export class CursorProvider implements SessionProvider {
  harness = "cursor" as const
  displayName = "Cursor"
  /**
   * Only the desktop chats share one database and need discovery re-run on
   * a write. An ACP or CLI store is one file per session: a write there
   * refreshes that session alone, never the other hundred.
   */
  rescanRoot = (path: string): boolean => this.isDesktopPath(path)
  rescanDebounceMs = 250
  private readonly desktop: CursorDesktopStore
  private chatRoot: string
  /** The chats stores of each session id, by the session directory's name. */
  private chatStores = new Map<string, Set<string>>()
  private acpRoot: string
  /**
   * Mako's own Cursor SDK agents: `<state root>/index.db` names them and
   * `<state root>/agents/agent-<sha256(id)>/store.db` holds each transcript.
   */
  private sdkStateRoot: string
  private sdkRoot: string
  private sdkStamps = new Map<string, CursorSdkAgentStamp>()
  private sdkStampsAt: string | null = null
  /**
   * 2: every `cursor-agent` store resumes live (the SDK imports it), and an
   * SDK agent Mako imported carries the legacy row's identity.
   */
  peekVersion = 2
  /**
   * The last full fold of a per-session store, kept so a follower opened on
   * it can continue from that transcript and so `read` of an unchanged root
   * costs one query instead of one per message.
   */
  private lastFold: (StoreFold & { path: string }) | null = null
  private readonly checkpoints = new Map<string, { length: number; last?: string }>()
  private readonly extents = new Map<string, CursorRootExtent>()

  constructor(home = homedir(), env: NodeJS.ProcessEnv = process.env) {
    this.desktop = new CursorDesktopStore(home)
    this.chatRoot = join(home, ".cursor", "chats")
    this.acpRoot = join(home, ".cursor", "acp-sessions")
    this.sdkStateRoot = cursorSdkStateRoot(env, home)
    this.sdkRoot = join(this.sdkStateRoot, "agents")
  }

  roots(): string[] {
    return [this.chatRoot, this.acpRoot, this.sdkStateRoot, this.desktop.root]
  }

  /** Desktop's globalStorage is mostly extension storage and agent-worker logs, written many times a second. */
  watchRoots(): string[] {
    return [this.chatRoot, this.acpRoot, this.sdkStateRoot]
  }

  pollFiles(): string[] {
    const database = join(this.desktop.root, "state.vscdb")
    return [database, `${database}-wal`]
  }

  /**
   * A write inside a session directory — the database, its WAL, or
   * `meta.json` — refreshes that session's store. Desktop writes pass
   * through to the rescan rule.
   */
  watchTarget(path: string): string | null {
    if (this.isDesktopPath(path)) return path
    // Cursor's extensions write under globalStorage constantly; only the
    // chat database itself is a reason to rescan.
    if (path.startsWith(`${this.desktop.root}${sep}`)) return null
    // The SDK records a checkpoint by writing the root blob into the agent's
    // store and then moving the pointer in index.db. The store write is
    // noticed on its own; the index write names the agent it moved for, and
    // that store is what a follower must read again.
    if (this.isSdkIndexPath(path)) {
      const agentId = newestCursorSdkAgentId(cursorSdkIndexPath(this.sdkStateRoot))
      return agentId ? cursorSdkStorePath(this.sdkStateRoot, agentId) : null
    }
    return this.storeOf(path)
  }

  async stat(path: string): Promise<NativeFile | null> {
    if (this.isDesktopPath(path)) return null
    const [file] = await this.nativeStores([path])
    return file ?? null
  }

  observationPaths(path: string): string[] {
    const database = this.isDesktopPath(path)
      ? join(this.desktop.root, "state.vscdb") : path
    const files = [database, `${database}-wal`]
    if (!this.isDesktopPath(path)) files.push(join(dirname(path), "meta.json"))
    if (this.isSdkStore(path)) {
      const index = cursorSdkIndexPath(this.sdkStateRoot)
      files.push(index, `${index}-wal`)
    }
    return files
  }

  /** `index.db`, its WAL or its shm under the SDK state root. */
  private isSdkIndexPath(path: string): boolean {
    return (
      dirname(path) === this.sdkStateRoot &&
      basename(path).startsWith("index.db")
    )
  }

  private isSdkStore(path: string): boolean {
    return path.startsWith(`${this.sdkRoot}${sep}`)
  }

  /**
   * Stores with their revision. An SDK store's root pointer lives in
   * index.db, so the agent's index facts are part of its store's revision:
   * a pointer that moved after the last blob write still reads as a change.
   * Only that agent's facts: the file itself changes whenever any agent
   * streams, and every agent re-reading on it re-archived them all.
   */
  private async nativeStores(paths: string[]): Promise<NativeFile[]> {
    const files = await nativeFiles(paths)
    if (!files.some((file) => this.isSdkStore(file.path))) return files
    const index = cursorSdkIndexPath(this.sdkStateRoot)
    const indexStamp = (
      await Promise.all(
        [index, `${index}-wal`].map((candidate) => stat(candidate).catch(() => null))
      )
    )
      .map((info) => (info ? `${info.size}:${info.mtimeMs}` : "missing"))
      .join("|")
    // An unchanged index answers from the last read; a read that fails keeps
    // the last stamps, so a busy moment doesn't flip every agent to changed.
    if (indexStamp !== this.sdkStampsAt) {
      const stamps = readCursorSdkAgentStamps(index)
      if (stamps) {
        this.sdkStamps = stamps
        this.sdkStampsAt = indexStamp
      }
    }
    return files.map((file) => {
      if (!this.isSdkStore(file.path)) return file
      const stamp = this.sdkStamps.get(basename(dirname(file.path)))
      return {
        ...file,
        mtimeMs: Math.max(file.mtimeMs, stamp?.updatedMs ?? 0),
        revision: `${file.revision}|index:${stamp?.revision ?? "missing"}`,
      }
    })
  }

  /**
   * The blob id of the root to fold. Cursor's own stores name it in `meta`;
   * an SDK store's `meta.latestRootBlobId` stays empty and the pointer is
   * the agent's latest checkpoint in index.db.
   */
  private rootIdOf(path: string, meta: CursorMeta | null): string | undefined {
    if (!meta) return undefined
    if (!this.isSdkStore(path)) return meta.latestRootBlobId
    return this.sdkAgentOf(path, meta)?.rootId
  }

  /**
   * The root to fold and, for an SDK agent, where each stopped run sits and
   * which runs it replays. A run's checkpoint places it only while that
   * checkpoint is a prefix of the current conversation from its first spoken
   * turn on: the SDK rewrites the leading system prompt and context whenever
   * the model changes, and a rewritten history places nothing.
   */
  private foldInput(database: DatabaseSync, path: string): FoldInput | null {
    const meta = this.readMeta(database, path)
    if (!meta) return null
    const agent = this.isSdkStore(path) ? this.sdkAgentOf(path, meta) : null
    const rootId = this.isSdkStore(path) ? agent?.rootId : meta.latestRootBlobId
    const root = rootId ? this.readRoot(database, rootId) : null
    if (rootId && !root) return null
    const hashes = root?.hashes ?? []
    const stops: RunStops = new Map()
    const spans = new Map<number, RunSpan>()
    let spoken: number | undefined
    let positions: Map<string, number[]> | undefined
    // A checkpoint ends where its last message is. Usually that is its
    // length, but a compaction rewrites messages ahead of the live list, so
    // an older checkpoint's last message sits a few places off its length:
    // on an agent with 53 compactions, 100 of 112 checkpoints did.
    const place = (checkpoint: string | undefined): number | undefined => {
      if (!checkpoint) return 0
      const at = this.checkpointOf(database, checkpoint)
      if (!at) return undefined
      if (at.length <= hashes.length && hashes[at.length - 1] === at.last) return at.length
      spoken ??= this.firstSpokenIndex(database, hashes)
      if (at.length <= spoken) return at.length
      if (at.last === undefined) return undefined
      positions ??= hashPositions(hashes)
      const found = nearest(positions.get(at.last), at.length - 1)
      return found === undefined ? undefined : found + 1
    }
    for (const run of agent?.runs ?? []) {
      const start = place(run.startRootId)
      if (run.end) {
        const stop = run.rootId ? place(run.rootId) : start
        if (stop !== undefined && (!run.rootId || stop > 0)) stops.set(stop, [...(stops.get(stop) ?? []), run])
      }
      if (start === undefined || !run.evented || (!run.rootId && !run.running)) continue
      const end = run.running ? hashes.length : place(run.rootId)
      if (end === undefined || end <= start) continue
      const prompt = this.promptIn(database, hashes, start, end)
      if (prompt !== undefined) spans.set(prompt, { run, end })
    }
    if (!rootId && !stops.size) return null
    return {
      rootId: rootId ?? "",
      hashes,
      compactions: root?.compactions ?? new Map(),
      stops,
      spans,
      indexPath: cursorSdkIndexPath(this.sdkStateRoot),
    }
  }

  /**
   * A checkpoint's length and last message. A checkpoint is content
   * addressed, so what it holds never changes: a long agent has a few
   * hundred runs, each checkpoint a few hundred kilobytes of hashes, and
   * each is read once.
   */
  private checkpointOf(database: DatabaseSync, id: string): { length: number; last?: string } | undefined {
    const known = this.checkpoints.get(id)
    if (known) return known
    const blobs = database.prepare("SELECT data FROM blobs WHERE id = ?")
    const extent = this.rootExtent(blobs, id)
    if (!extent) return undefined
    let length = extent.count
    let last = extent.last
    for (const window of extent.windows) {
      const archived = this.rootExtent(blobs, window)
      if (!archived) continue
      length += archived.count
      if (!extent.count) last = archived.last ?? last
    }
    const checkpoint = last ? { length, last } : { length }
    this.remember(this.checkpoints, id, checkpoint)
    return checkpoint
  }

  /** A root or window's extent. A window never changes and later checkpoints keep every earlier one, so each is read once. */
  private rootExtent(blobs: StatementSync, id: string): CursorRootExtent | undefined {
    const known = this.extents.get(id)
    if (known) return known
    try {
      const row = parseBlobDataRow(blobs.get(id))
      if (!row) return undefined
      const extent = parseRootExtent(row.data)
      if (extent.windows.length === 0) this.remember(this.extents, id, extent)
      return extent
    } catch {
      return undefined
    }
  }

  private remember<Value>(cache: Map<string, Value>, id: string, value: Value): void {
    cache.set(id, value)
    if (cache.size > MAX_CHECKPOINTS) cache.delete(cache.keys().next().value ?? "")
  }

  /** Where in `hashes[start..end)` the person's prompt is: the first message the fold draws as theirs. */
  private promptIn(database: DatabaseSync, hashes: readonly string[], start: number, end: number): number | undefined {
    const statement = database.prepare("SELECT data FROM blobs WHERE id = ?")
    for (let index = start; index < end; index++) {
      const hash = hashes[index]
      const message = hash === undefined ? null : readCursorMessage(statement, hash)
      if (message?.role !== "user" || message.summary) continue
      if (cursorTaskOpener(plainText(message.content), hash ?? "")) return undefined
      if (spokenText(message.content) || message.attachments.length) return index
    }
    return undefined
  }

  /** Index of the first message the user typed; everything before it is injected preamble. */
  private firstSpokenIndex(database: DatabaseSync, hashes: string[]): number {
    const statement = database.prepare("SELECT data FROM blobs WHERE id = ?")
    for (let index = 0; index < hashes.length; index++) {
      const hash = hashes[index]
      const message = hash === undefined ? null : readCursorMessage(statement, hash)
      if (message?.role === "user" && spokenText(message.content)) return index
    }
    return hashes.length
  }

  /**
   * The index row of the agent an SDK store belongs to. The directory names
   * the agent, not the store's meta row: a store Mako imported from a
   * `cursor-agent` session keeps that session's meta, and when the same
   * session had been imported twice (an `acp-sessions` store and its
   * `chats/` fork share one agent id) the second lives under a fresh id.
   */
  private sdkAgentOf(path: string, meta: CursorMeta | null): CursorSdkAgentRecord | null {
    const index = cursorSdkIndexPath(this.sdkStateRoot)
    const agentId =
      cursorSdkAgentIdForDirectory(index, basename(dirname(path))) ?? meta?.agentId
    return agentId ? readCursorSdkAgent(index, agentId) : null
  }

  /** A desktop chat row, or a write to the desktop database or its WAL. */
  private isDesktopPath(path: string): boolean {
    return (
      this.desktop.owns(path) ||
      (dirname(path) === this.desktop.root &&
        basename(path).startsWith("state.vscdb"))
    )
  }

  /** The `store.db` of the session directory a path lies in, or null outside one. */
  private storeOf(path: string): string | null {
    const roots = [this.acpRoot, this.sdkRoot, this.chatRoot]
    for (const root of roots) {
      if (!path.startsWith(`${root}${sep}`)) continue
      const relative = path.slice(root.length + 1).split(sep)
      // acp-sessions/<id>/…, agents/agent-<hash>/… or chats/<workspace>/<id>/…
      const depth = root === this.chatRoot ? 2 : 1
      if (relative.length <= depth) return null
      return join(root, ...relative.slice(0, depth), "store.db")
    }
    return null
  }

  async discover(): Promise<NativeFile[]> {
    const paths: string[] = []
    const chatStores = new Map<string, Set<string>>()
    const workspaces = await readdir(this.chatRoot).catch((): string[] => [])
    for (const workspace of workspaces) {
      const root = join(this.chatRoot, workspace)
      const sessions = await readdir(root).catch((): string[] => [])
      for (const session of sessions) {
        const store = join(root, session, "store.db")
        paths.push(store)
        chatStores.set(session, (chatStores.get(session) ?? new Set()).add(store))
      }
    }
    this.chatStores = chatStores
    const acpSessions = await readdir(this.acpRoot).catch((): string[] => [])
    for (const session of acpSessions)
      paths.push(join(this.acpRoot, session, "store.db"))
    const agents = await readdir(this.sdkRoot).catch((): string[] => [])
    for (const agent of agents)
      if (agent.startsWith("agent-")) paths.push(join(this.sdkRoot, agent, "store.db"))
    return [
      ...(await this.nativeStores(paths)),
      ...(await this.desktop.discover()),
    ]
  }

  private ownsChat(path: string): boolean {
    return path.startsWith(`${this.chatRoot}${sep}`)
  }

  /**
   * The identity of a chats store, told apart from the same session id in
   * other workspaces. Discovery lists them all; a store peeked since joins
   * its session's set, so one resumed elsewhere between sweeps is counted.
   */
  private chatIdentity(store: string, nativeId: string): string {
    const session = basename(dirname(store))
    const stores = (this.chatStores.get(session) ?? new Set<string>()).add(store)
    this.chatStores.set(session, stores)
    return cursorChatIdentity(store, nativeId, stores)
  }

  /**
   * A desktop chat's rows in the editor's database; any other session's
   * folder: `store.db`, whose blobs are content-addressed and never
   * rewritten, and what Cursor keeps beside it (`meta.json`). An SDK agent's
   * runs and their events sit in `index.db` under its id.
   */
  async records(path: string): Promise<SessionRecords | null> {
    if (this.desktop.owns(path)) return this.desktop.records(path)
    const directory = dirname(path)
    const chats = dirname(dirname(directory)) === this.chatRoot
    if (basename(path) !== "store.db" || !(chats || [this.acpRoot, this.sdkRoot].includes(dirname(directory)))) return null
    const tables = [...tableColumns(path).keys()]
    if (!tables.length) return null
    const databases: RecordDatabase[] = [{ path, tables: tables.map((table) => (table === "blobs" ? { table, immutable: true } : { table })) }]
    if (this.isSdkStore(path)) {
      const index = cursorSdkIndexPath(this.sdkStateRoot)
      const agentId = cursorSdkAgentIdForDirectory(index, basename(directory))
      if (agentId) databases.push({ path: index, tables: [
        { table: "agents", where: "agent_id = ?", params: [agentId] },
        { table: "runs", where: "agent_id = ?", params: [agentId] },
        { table: "run_events", where: "run_id IN (SELECT run_id FROM runs WHERE agent_id = ?)", params: [agentId] },
      ] })
    }
    const files = (await filesUnder(directory)).filter((file) => !/^store\.db(?:-wal|-shm|-journal)?$/.test(basename(file)))
    return { files, databases }
  }

  /**
   * Remove an ACP session or SDK agent directory. Cursor Desktop's own chats
   * are not ours to delete. An SDK agent is also forgotten in `index.db`, or
   * the SDK would still list it and the index's newest row could name a
   * store that no longer exists.
   */
  async remove(path: string): Promise<boolean> {
    const directory = dirname(path)
    const parent = dirname(directory)
    if ((parent !== this.acpRoot && parent !== this.sdkRoot) || basename(path) !== "store.db") return false
    if (parent === this.sdkRoot) {
      const database = await openDatabase(path)
      let agentId: string | undefined
      if (database) {
        try {
          agentId = this.readMeta(database, path)?.agentId
        } finally {
          database.close()
        }
      }
      const match: CursorSdkAgentMatch = { directoryName: basename(directory) }
      if (agentId) match.agentId = agentId
      removeCursorSdkAgent(cursorSdkIndexPath(this.sdkStateRoot), match)
    }
    await rm(directory, { recursive: true, force: true })
    return true
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    if (this.desktop.owns(file.path)) return this.desktop.peek(file)
    const database = await openDatabase(file.path)
    if (!database) return null
    try {
      const meta = this.readMeta(database, file.path)
      if (!meta) return null
      // Cursor writes each Task/subagent as its own store.db with
      // `subagentInfo` pointing at the parent. Those are tool calls, not
      // conversations; listing them next to the parent is the same mistake
      // as showing Codex `thread_source=subagent` rollouts.
      if (meta.subagent) return null
      // "New Agent" is the placeholder Cursor writes before a session is
      // named; the first real prompt makes a better title than that.
      const named =
        meta.name && meta.name !== "New Agent"
          ? titleFrom(meta.name)
          : undefined
      const agent = this.isSdkStore(file.path) ? this.sdkAgentOf(file.path, meta) : null
      const nativeId =
        agent?.agentId ?? meta.agentId ?? dirname(file.path).split("/").pop() ?? ""
      const ref: ThreadRef = {
        harness: this.harness,
        nativeId,
        path: file.path,
        title: named,
        model: meta.model,
        settings: cursorModelSettings(meta.model),
        startedAt: isoOf(meta.createdAt),
        // The store file's mtime lies: Cursor batch-touches old stores
        // (migrations, vacuums), which once made month-old sessions read as
        // "just now". meta.json's updatedAtMs is Cursor's own record of the
        // last turn; mtime is only the fallback when the sidecar is absent.
        updatedAt: new Date(file.mtimeMs).toISOString(),
        bytes: file.bytes,
        revision: file.revision,
      }
      // `cursor-agent -p --resume <id>` on an ACP session once wrote its new
      // turns to a second store under chats/ with the same agent id
      // (verified 2026-09-12), and one run from another folder writes a
      // store under that folder's workspace. Each holds different turns, so
      // each is its own row. Any continues through the SDK, which imports
      // the store it is asked to reopen.
      if (this.ownsChat(file.path)) ref.identity = this.chatIdentity(file.path, nativeId)
      // An agent Mako imported is the continuation of a legacy row: it takes
      // that row's identity so the catalog shows one thread, and being the
      // newer of the two it is the one shown.
      if (agent?.imported) ref.identity = agent.imported.identity
      // meta.json is the cheap source of cwd and honest activity times.
      const sidecar = await readFile(
        join(dirname(file.path), "meta.json"),
        "utf8"
      ).catch(() => null)
      if (agent) {
        // The SDK's index is the record of an agent: where it ran, what the
        // newest turn ran under, and when the SDK last touched it. The
        // store's own meta carries none of these.
        if (agent.cwd) ref.cwd = agent.cwd
        if (!ref.title && agent.name && agent.name !== "New Agent")
          ref.title = titleFrom(agent.name)
        if (agent.model) {
          ref.settings = cursorSdkReportedSettings(agent.model, [])
          ref.model = agent.model.id
        }
        if (agent.updatedAt) ref.updatedAt = agent.updatedAt
        if (agent.createdAt) ref.startedAt = agent.createdAt
      } else if (sidecar) {
        const parsed = parseSidecar(sidecar)
        if (parsed?.cwd) ref.cwd = parsed.cwd
        if (!ref.title && parsed?.title) ref.title = titleFrom(parsed.title)
        if (parsed?.model) {
          ref.model = parsed.model
          ref.settings = cursorModelSettings(parsed.model)
        }
        if (parsed?.updatedAtMs)
          ref.updatedAt = new Date(parsed.updatedAtMs).toISOString()
        if (parsed?.createdAtMs)
          ref.startedAt = new Date(parsed.createdAtMs).toISOString()
      } else {
        // Old-format stores have no sidecar. The last-inserted blobs carry
        // the real timestamps of the final turns; scan a few for the newest
        // plausible epoch instead of trusting a touched file.
        const activity = this.readLastActivity(database)
        if (activity) ref.updatedAt = activity
      }
      if (!ref.cwd || !ref.title) {
        const root = this.readRoot(database, this.rootIdOf(file.path, meta))
        if (root) {
          ref.cwd ??= root.cwd
          if (!ref.title) {
            const statement = database.prepare(
              "SELECT data FROM blobs WHERE id = ?"
            )
            for (const hash of root.hashes) {
              const message = readCursorMessage(statement, hash)
              if (message?.role === "user") {
                const spoken = spokenText(message.content)
                if (spoken) ref.title = titleFrom(spoken)
                if (ref.title) break
              }
            }
          }
        }
      }
      return ref.nativeId ? ref : null
    } finally {
      database.close()
    }
  }

  /**
   * Live sync for a per-session store. The root blob names every message
   * hash in order and a streaming turn rewrites only its tail, so an update
   * re-reads from the start of the exchange that changed, never the whole
   * conversation, and an unchanged root costs one `meta` query.
   */
  createFollower(path: string, fromByte: number): SessionFollower | null {
    if (this.desktop.owns(path)) return this.desktop.createFollower(path)
    if (!this.storeOf(path)) return null
    // Unseeded on purpose: nothing proves the listener holds the entries of
    // the last fold, so the first change after opening delivers the whole
    // transcript once with `reset`, and every change after it delivers only
    // the exchange that moved.
    let fold: StoreFold | null = null
    let offset = fromByte
    let rebased = false
    const unchanged = (): SessionUpdate => ({
      entries: [],
      nextByte: offset,
      replace: false,
    })
    return {
      get offset() {
        return offset
      },
      next: async (): Promise<SessionUpdate> => {
        const [file] = await this.nativeStores([path])
        if (!file) return unchanged()
        const database = await openDatabase(path)
        if (!database) return unchanged()
        try {
          const input = this.foldInput(database, path)
          offset = file.bytes
          if (!input) return unchanged()
          if (fold && fold.rootId === input.rootId && fold.stopKey === stopKey(input.stops) && sameSpans(fold.spans, spanKeys(input.spans))) return unchanged()
          const next = fold
            ? this.foldFrom(database, fold, input)
            : this.foldStore(database, input)
          const from = fold ? next.replaceFrom : 0
          fold = next.fold
          this.lastFold = { ...next.fold, path }
          const update: SessionUpdate = {
            entries: next.fold.entries.slice(from),
            nextByte: offset,
            replace: true,
            replaceFrom: from,
          }
          if (!rebased) {
            update.reset = true
            rebased = true
          }
          return update
        } finally {
          database.close()
        }
      },
    }
  }

  async read(path: string): Promise<Thread | null> {
    if (this.desktop.owns(path)) return this.desktop.read(path)
    const [file] = await this.nativeStores([path])
    if (!file) return null
    const ref = await this.peek(file)
    if (!ref) return null
    const database = await openDatabase(path)
    if (!database) return null
    try {
      const input = this.foldInput(database, path)
      if (!input) return { ref, entries: [] }
      const held = this.lastFold
      const fold = held && held.path === path && held.rootId === input.rootId && held.stopKey === stopKey(input.stops) && sameSpans(held.spans, spanKeys(input.spans))
        ? held
        : this.foldStore(database, input).fold
      this.lastFold = { ...fold, path }
      const thread: Thread = { ref, entries: fold.entries }
      if (fold.unread) thread.unread = fold.unread
      return thread
    } finally {
      database.close()
    }
  }

  /**
   * The newest exchanges, folded from the end of the hash list alone: from
   * the earliest prompt within the last `bytes` of message blobs. A whole
   * fold reads every blob, and a long agent's store holds a gigabyte of
   * tool output behind the few prompts a first page shows. Null when that
   * prompt opens the conversation, where the whole fold is the same work.
   */
  async recent(path: string, bytes: number): Promise<ThreadEntry[] | null> {
    if (this.desktop.owns(path) || !this.storeOf(path)) return null
    const database = await openDatabase(path)
    if (!database) return null
    try {
      const input = this.foldInput(database, path)
      if (!input) return null
      const sizes = database.prepare("SELECT length(data) AS size FROM blobs WHERE id = ?")
      const blobs = database.prepare("SELECT data FROM blobs WHERE id = ?")
      let read = 0
      let start = 0
      let index = input.hashes.length - 1
      for (; index >= 0 && (read < bytes || !start); index--) {
        const hash = input.hashes[index]
        if (hash === undefined) continue
        const size = sizes.get(hash)?.["size"]
        read += isNumberValue(size) ? size : 0
        const message = readCursorMessage(blobs, hash)
        if (message?.role === "user" && (spokenText(message.content) || message.attachments.length))
          start = index
      }
      if (index < 0 || !start) return null
      // A message steered into a replayed run is drawn by that run's replay, so the window starts at the run's prompt.
      for (const [prompt, span] of input.spans) if (prompt < start && start < span.end) start = prompt
      const folded = this.foldHashes(database, input, start)
      return folded.dropped ? null : folded.entries
    } finally {
      database.close()
    }
  }

  /** Translate the whole hash list into entries. */
  private foldStore(database: DatabaseSync, input: FoldInput): FoldStep {
    const { rootId, hashes, stops } = input
    const folded = this.foldHashes(database, input, 0)
    return {
      fold: {
        rootId,
        stopKey: stopKey(stops),
        spans: spanKeys(input.spans),
        hashes,
        entries: folded.entries,
        // Dropped history shifts every index; no exchange is a safe restart.
        exchanges: folded.dropped ? [] : folded.exchanges,
        unread: folded.unread,
      },
      replaceFrom: 0,
    }
  }

  /**
   * Translate only what moved since `previous`: the exchange holding the
   * first differing hash and everything after it. Entries before that
   * exchange are reused untouched, so `replaceFrom` is the index the
   * listener keeps up to. Falls back to a whole fold when the transcript
   * would exceed the sink's history budget, where indices stop lining up.
   */
  private foldFrom(
    database: DatabaseSync,
    previous: StoreFold,
    input: FoldInput
  ): FoldStep {
    const { rootId, hashes, stops } = input
    // A stop recorded after its messages lands inside entries already kept.
    if (previous.stopKey !== stopKey(stops)) return this.foldStore(database, input)
    const spans = spanKeys(input.spans)
    let shared = 0
    while (
      shared < previous.hashes.length &&
      shared < hashes.length &&
      previous.hashes[shared] === hashes[shared]
    )
      shared++
    // A run that ended, or moved, replays again from its prompt.
    const moved = spans.findIndex((span, index) => span.key !== previous.spans[index]?.key || span.prompt !== previous.spans[index]?.prompt)
    const changed = moved < 0 ? undefined : Math.min(spans[moved]?.prompt ?? hashes.length, previous.spans[moved]?.prompt ?? hashes.length)
    if (changed !== undefined) shared = Math.min(shared, changed)
    if (shared === previous.hashes.length && previous.exchanges.length) {
      // Pure append. When the first new message opens an exchange of its
      // own, nothing before it can merge with it and the previous entries
      // stand; a tool result or assistant chunk first belongs to the last
      // exchange and takes the path below.
      const appended = this.foldHashes(database, input, shared)
      const total = previous.entries.length + appended.entries.length
      if (
        appended.exchanges[0]?.hash === shared &&
        !appended.dropped &&
        total <= FOLD_INCREMENTAL_LIMIT
      )
        return {
          fold: {
            rootId,
            stopKey: previous.stopKey,
            spans,
            hashes,
            entries: [...previous.entries, ...appended.entries],
            exchanges: [
              ...previous.exchanges,
              ...appended.exchanges.map((item) => ({
                hash: item.hash,
                entry: previous.entries.length + item.entry,
              })),
            ],
            unread: laterUnread(previous.unread, appended.unread, false),
          },
          replaceFrom: previous.entries.length,
        }
    }
    let exchange = { hash: 0, entry: 0 }
    for (const candidate of previous.exchanges) {
      if (candidate.hash > shared) break
      exchange = candidate
    }
    const tail = this.foldHashes(database, input, exchange.hash)
    const total = exchange.entry + tail.entries.length
    if (tail.dropped || total > FOLD_INCREMENTAL_LIMIT)
      return this.foldStore(database, input)
    const kept = previous.exchanges.filter((item) => item.hash < exchange.hash)
    return {
      fold: {
        rootId,
        stopKey: previous.stopKey,
        spans,
        hashes,
        entries: [...previous.entries.slice(0, exchange.entry), ...tail.entries],
        exchanges: [
          ...kept,
          ...tail.exchanges.map((item) => ({
            hash: item.hash,
            entry: exchange.entry + item.entry,
          })),
        ],
        unread: laterUnread(previous.unread, tail.unread, true),
      },
      replaceFrom: exchange.entry,
    }
  }

  /**
   * Fold `hashes[start..]` into entries with one prepared statement. Each
   * exchange starts at a user message; tool results pair with calls inside
   * the same exchange, so a fold that starts at an exchange boundary sees
   * exactly what a whole fold would.
   */
  private foldHashes(
    database: DatabaseSync,
    input: FoldInput,
    start: number
  ): FoldedHashes {
    const { hashes, compactions, stops } = input
    const statement = database.prepare("SELECT data FROM blobs WHERE id = ?")
    const sink = new EntrySink()
    const exchanges: ExchangeStart[] = []
    type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
    let assistant: AssistantEntry | null = null
    const toolsById = new Map<string, ToolBlock>()
    // Calls of the current exchange; a stopped run leaves unanswered ones.
    let calls: ToolBlock[] = []
    // A stop at `start` is already in the entries this fold continues.
    const stop = (index: number) => {
      if (index === start) return
      for (const run of stops.get(index) ?? []) {
        const end = run.end
        if (!end) continue
        if (!run.rootId) {
          const turn = this.unrecordedTurn(database, input.indexPath, run)
          if (!turn.length) continue
          calls = []
          for (const entry of turn) sink.push(entry)
        }
        for (const call of calls) {
          if (call.output !== undefined || call.error) continue
          if (end.kind === "failed") call.error = true
          else call.canceled = true
        }
        calls = []
        assistant = null
        const marker = {
          ...end.kind === "failed" ? cursorFailure(end.error ?? "") : { label: "Interrupted" },
          source: { harness: "cursor", record: `${run.runId}:${end.kind}` },
        }
        sink.push(run.endedAt ? { kind: "event", at: run.endedAt, ...marker } : { kind: "event", ...marker })
      }
    }
    // The marker of the compaction just passed, until the conversation goes
    // on: the summary message that follows it gives it its text when the
    // window kept none.
    type EventEntry = Extract<ThreadEntry, { kind: "event" }>
    let compacted: EventEntry | null = null
    // Like a stop, a summary at `start` is already in the continued entries.
    const compact = (index: number): EventEntry | null => {
      if (index === start || !compactions.has(index)) return null
      assistant = null
      const compaction = compactions.get(index)!
      const marker: EventEntry = {
        kind: "event",
        ...compactionEvent({ summary: compaction.summary }),
        source: { harness: "cursor", record: compaction.window },
      }
      sink.push(marker)
      return marker
    }

    for (let index = start; index < hashes.length; index++) {
      stop(index)
      compacted = compact(index) ?? compacted
      const hash = hashes[index]
      if (hash === undefined) continue
      const message = readCursorMessage(statement, hash)
      if (!message) continue
      switch (message.role) {
        case "user": {
          for (const part of message.unread) sink.unread(part.kind, part.reason, part.record)
          if (message.summary) {
            const summary = plainText(message.content).replace(SUMMARY_PREFIX, "")
            // A root that kept no window for this summary still marks it.
            if (!compacted) sink.push({ kind: "event", ...compactionEvent({ summary }), source: { harness: "cursor", record: hash } })
            else if (!compacted.body) Object.assign(compacted, compactionEvent({ summary }))
            compacted = null
            continue
          }
          const text = plainText(message.content)
          const opener = cursorTaskOpener(text, hash)
          const spoken = opener ? null : spokenText(message.content)
          if (!opener && !spoken && !message.attachments.length) continue
          assistant = null
          calls = []
          compacted = null
          exchanges.push({ hash: index, entry: sink.entries.length })
          if (opener) {
            sink.push(opener)
            continue
          }
          const span = input.spans.get(index)
          sink.push({
            kind: "user",
            id: hash,
            ...span?.run.startedAt && { at: span.run.startedAt },
            text: spoken ?? "",
            attachments: message.attachments,
          })
          if (!span) continue
          for (const entry of this.replayRun(database, input, span.run, hash, index, span.end)) sink.push(entry)
          for (let passed = index + 1; passed < span.end; passed++) stop(passed)
          index = span.end - 1
          continue
        }
        case "tool":
          for (const part of message.content) {
            if (part.type !== "tool-result") {
              if (part.unread) sink.unread(part.unread.kind, part.unread.reason, part.unread.record)
              continue
            }
            const block = toolsById.get(part.toolCallId)
            if (block) {
              block.output = clip(formatToolResult(part.result))
              const attachments = [
                ...part.attachments,
                ...cursorAttachments(
                  isJsonObject(part.result)
                    ? part.result["content"]
                    : part.result
                ),
              ]
              if (attachments.length) block.attachments = attachments
              if (message.isError) block.error = true
              toolsById.delete(part.toolCallId)
            }
          }
          continue
        case "assistant":
          compacted = null
          if (!assistant) {
            assistant = {
              kind: "assistant",
              id: hash,
              model: message.model,
              blocks: [],
            }
            sink.push(assistant)
          } else if (!assistant.model && message.model) {
            assistant.model = message.model
          }
          for (const part of message.content) {
            switch (part.type) {
              case "text":
                if (part.text)
                  assistant.blocks.push({ type: "text", text: part.text })
                break
              case "reasoning":
                if (part.text)
                  assistant.blocks.push({ type: "thinking", text: part.text })
                break
              case "attachment":
                assistant.blocks.push(part.value)
                break
              case "tool-call": {
                const input = formatJson(part.args)
                const block: ToolBlock = {
                  type: "tool",
                  id: part.toolCallId,
                  name: part.toolName,
                  input: clip(input),
                }
                if (CURSOR_TODO_WRITES.has(part.toolName)) {
                  const details = todoDetails(input)
                  if (details) block.details = details
                }
                if (part.toolCallId) toolsById.set(part.toolCallId, block)
                calls.push(block)
                assistant.blocks.push(block)
                const plan = part.toolCallId ? createPlanBlock(part.toolCallId, part.toolName, part.args) : undefined
                if (plan) assistant.blocks.push(plan)
                break
              }
              case "other":
                if (part.unread) sink.unread(part.unread.kind, part.unread.reason, part.unread.record)
                break
            }
          }
          continue
        case "other":
          if (message.unread) sink.unread(message.unread.kind, message.unread.reason, message.unread.record)
          continue
      }
    }
    stop(hashes.length)
    const entries = sink.done()
    // The sink prepends one event when it dropped history; indices past it
    // no longer match the hash list, so the caller re-folds from the start.
    const dropped = entries.length > 0 && entries.length !== sink.entries.length
    return { entries, exchanges, dropped, unread: sink.unreadRecords }
  }

  /* ------------------------------------------------------------ sqlite */

  /** The store's meta row; null for a store without one. A writer that
   * outlasts the busy timeout is `SessionUnreadable`, never "no meta". */
  private readMeta(database: DatabaseSync, path: string): CursorMeta | null {
    try {
      const result = database
        .prepare("SELECT value FROM meta WHERE key = '0'")
        .get()
      const row = parseMetaValueRow(result)
      if (!row) return null
      const text = isStringValue(row.value)
        ? /^[0-9a-f]+$/i.test(row.value)
          ? Buffer.from(row.value, "hex").toString("utf8")
          : row.value
        : Buffer.from(row.value).toString("utf8")
      return parseCursorMeta(text)
    } catch (error) {
      const failure = SqliteFailure.safeParse(error)
      if (failure.success && isBusy(failure.data))
        throw new SessionUnreadable(path, { cause: error })
      return null
    }
  }

  /**
   * The newest epoch-millis found in the last few blobs — insertion order is
   * conversation order, so this is when the session truly last moved. A
   * varint scan yields false positives; bounds and max() filter them.
   */
  private readLastActivity(database: DatabaseSync): string | undefined {
    try {
      const rows: SqliteRows = database
        .prepare(
          "SELECT data FROM blobs WHERE length(data) < 262144 ORDER BY rowid DESC LIMIT 30"
        )
        .all()
      const floor = Date.UTC(2015, 0, 1)
      const ceiling = Date.now() + 10 * 60_000
      let best = 0
      for (const result of rows) {
        const row = parseBlobDataRow(result)
        if (!row) continue
        const buffer = row.data
        if (buffer[0] === 0x7b) {
          // A JSON blob (messages are JSON): epoch millis appear as plain
          // 13-digit numbers in the text.
          const text = Buffer.from(buffer).toString("utf8")
          for (const match of text.matchAll(/\b1[5-9]\d{11}\b/g)) {
            const value = Number(match[0])
            if (value > floor && value < ceiling && value > best) best = value
          }
          continue
        }
        for (let i = 0; i < buffer.length; i++) {
          // A single-byte varint cannot be an epoch timestamp. Most bytes in
          // these protobuf blobs are ASCII; do not run the decoder for them.
          const first = buffer[i]
          if (first === undefined || first < 0x80) continue
          let value = 0
          let shift = 0
          let factor = 1
          let j = i
          while (j < buffer.length && shift <= 49) {
            const byte = buffer[j]
            if (byte === undefined) break
            value += (byte & 0x7f) * factor
            if ((byte & 0x80) === 0) break
            shift += 7
            factor *= 128
            j++
          }
          if (value > floor && value < ceiling && value > best) best = value
        }
      }
      return best > 0 ? new Date(best).toISOString() : undefined
    } catch {
      return undefined
    }
  }

  /** The root's whole conversation: archived windows, then the live list. */
  private readRoot(
    database: DatabaseSync,
    rootId: string | undefined
  ): CursorConversation | null {
    if (!rootId) return null
    try {
      const statement = database.prepare("SELECT data FROM blobs WHERE id = ?")
      const row = parseBlobDataRow(statement.get(rootId))
      if (!row) return null
      const root = parseRoot(row.data)
      const hashes: string[] = []
      const compactions: Compactions = new Map()
      for (const id of root.windows) {
        const window = parseBlobDataRow(statement.get(id))
        if (!window) continue
        hashes.push(...parseRoot(window.data).hashes)
        const summary = windowSummary(window.data)
        compactions.set(hashes.length, summary === undefined ? { window: id } : { window: id, summary })
      }
      hashes.push(...root.hashes)
      return { hashes, cwd: root.cwd, compactions }
    } catch {
      return null
    }
  }

  /** The turn a run stopped before its first checkpoint: its prompt, then what it streamed. */
  private unrecordedTurn(database: DatabaseSync, indexPath: string, run: CursorSdkRun): ThreadEntry[] {
    const entries: ThreadEntry[] = []
    const prompt = this.promptBetween(database, run)
    if (prompt) {
      const projected = readPromptAttachments(prompt.text)
      entries.push({ kind: "user", id: prompt.id, ...run.startedAt && { at: run.startedAt }, text: projected.text, attachments: projected.attachments })
    }
    const replay: CursorSdkReplay = { runId: run.runId, ...prompt && { prompt: prompt.id }, ...run.model && { model: run.model } }
    const ending = runEnding(run)
    if (ending) replay.ending = ending
    entries.push(...cursorRunEntries(readCursorSdkRunEvents(indexPath, run.runId), replay))
    return entries
  }

  /**
   * A run as the live window drew it, from the messages `run_events` kept.
   * A call its stream never ended takes the result the run checkpointed in
   * `hashes[from..end)`, read only when there is such a call.
   */
  private replayRun(database: DatabaseSync, input: FoldInput, run: CursorSdkRun, prompt: string, from: number, end: number): ThreadEntry[] {
    const replay: CursorSdkReplay = {
      runId: run.runId,
      prompt,
      ...run.model && { model: run.model },
      settled: (callIds) => cursorToolResults(database.prepare("SELECT data FROM blobs WHERE id = ?"), input.hashes, from, end, callIds),
    }
    const ending = runEnding(run)
    if (ending) replay.ending = ending
    return cursorRunEntries(readCursorSdkRunEvents(input.indexPath, run.runId), replay)
  }

  /**
   * The prompt record written between the run's start and its stop. Prompt
   * records name no run, but one agent's runs never overlap, so the window
   * does. Blobs are appended, so the search starts at the run's starting
   * checkpoint and ends at the first record past the stop.
   */
  private promptBetween(database: DatabaseSync, run: CursorSdkRun): { id: string; text: string } | null {
    const from = run.startedAt ? Date.parse(run.startedAt) : -Infinity
    const to = run.endedAt ? Date.parse(run.endedAt) : Infinity
    try {
      const start = run.startRootId
        ? database.prepare("SELECT rowid FROM blobs WHERE id = ?").get(run.startRootId)?.["rowid"]
        : 0
      const rows = database
        .prepare("SELECT id, data FROM blobs WHERE rowid > ? AND substr(data, 1, 1) = x'0a' ORDER BY rowid")
        .iterate(isNumberValue(start) ? start : 0)
      for (const row of rows) {
        const id = row["id"]
        const data = row["data"]
        if (!isStringValue(id) || !isBytesValue(data)) continue
        const record = parsePromptRecord(data)
        if (!record || record.at < from) continue
        return record.at > to ? null : { id, text: record.text }
      }
    } catch {
      return null
    }
    return null
  }
}

function parseMetaValueRow(result: SqliteStatementResult): MetaValueRow | null {
  if (!result) return null
  const value = result["value"]
  return isStringValue(value) || isBytesValue(value) ? { value } : null
}

function parseCursorMeta(raw: string): CursorMeta | null {
  const value = parseJson(raw)
  if (!isJsonObject(value)) return null
  const createdAt =
    stringValue(value["createdAt"]) ?? numberValue(value["createdAt"])
  return {
    agentId: stringValue(value["agentId"]),
    name: stringValue(value["name"]),
    createdAt,
    latestRootBlobId: stringValue(value["latestRootBlobId"]),
    model: stringValue(value["model"]),
    subagent: isJsonObject(value["subagentInfo"]),
  }
}

function parseSidecar(raw: string): CursorSidecar | null {
  const value = parseJson(raw)
  if (!isJsonObject(value)) return null
  return {
    cwd: stringValue(value["cwd"]),
    title: stringValue(value["title"]),
    createdAtMs: numberValue(value["createdAtMs"]),
    updatedAtMs: numberValue(value["updatedAtMs"]),
    model: stringValue(value["model"]),
  }
}

function formatJson(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value)
}

/**
 * Cursor's plan tool, saved as `CreatePlan` (`createPlan` over the SDK), shows
 * its plan as the card live gives it; the stored call id is the live one.
 */
function createPlanBlock(id: string, name: string, args: JsonValue | undefined): ProposedPlan | undefined {
  if (name !== "CreatePlan" && name !== "createPlan") return undefined
  const plan = isJsonObject(args) ? stringValue(args["plan"]) : undefined
  return plan === undefined ? undefined : proposedPlanBlock(id, plan)
}
