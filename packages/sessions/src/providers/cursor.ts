import { cursorModelSettings } from "./cursor-settings.js"
import { CursorDesktopStore } from "./cursor-desktop.js"
import { attachmentFromUrl, type AttachmentContent } from "../content.js"
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
  removeCursorSdkAgent,
  type CursorSdkAgentMatch,
  type CursorSdkAgentRecord,
} from "./cursor-sdk-index.js"
import { cursorSdkReportedSettings } from "./cursor-sdk-models.js"
import {
  cursorSdkIndexPath,
  cursorSdkStateRoot,
  cursorSdkStorePath,
} from "./cursor-sdk-paths.js"
import { dirname, join, basename, sep } from "node:path"
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite"
import {
  clip,
  EntrySink,
  titleFrom,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import { normalizeToolOutput } from "../tool-output.js"
import { todoDetails } from "../tool-plan.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./types.js"

/** Where a user turn begins: its index in the root's hash list and in the entries. */
interface ExchangeStart {
  hash: number
  entry: number
}

/**
 * Where stopped runs ended: the hash-list length at the run's last
 * checkpoint, and when it was cancelled.
 */
type RunStops = Map<number, string | undefined>

/** What a fold reads: the root, its hash list and its stopped runs. */
interface FoldInput {
  rootId: string
  hashes: string[]
  stops: RunStops
}

function stopKey(stops: RunStops): string {
  return JSON.stringify([...stops].sort(([a], [b]) => a - b))
}

/** One translated store, keyed by the root blob and stops that produced it. */
interface StoreFold {
  rootId: string
  stopKey: string
  hashes: string[]
  entries: ThreadEntry[]
  exchanges: ExchangeStart[]
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
}

/**
 * Past this many entries the sink starts dropping history and entry indices
 * no longer line up with the hash list, so an incremental fold gives way to
 * a whole one (the sink's own budget is 6000).
 */
const FOLD_INCREMENTAL_LIMIT = 6000

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue | undefined
}

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

interface CursorRoot {
  hashes: string[]
  cwd?: string
}

interface CursorTextPart {
  type: "text"
  text: string
}

interface CursorReasoningPart {
  type: "reasoning"
  text: string
}

interface CursorToolCallPart {
  type: "tool-call"
  toolName: string
  args?: JsonValue
  toolCallId?: string
}

interface CursorToolResultPart {
  type: "tool-result"
  toolCallId: string
  result?: JsonValue
  attachments: AttachmentContent[]
}

interface CursorOtherPart {
  type: "other"
}

type CursorAssistantPart =
  | CursorTextPart
  | CursorReasoningPart
  | CursorToolCallPart
  | CursorOtherPart
  | { type: "attachment"; value: AttachmentContent }
type CursorToolPart = CursorToolResultPart | CursorOtherPart
type CursorTextContent = string | CursorTextPart[]

interface CursorUserMessage {
  role: "user"
  attachments: AttachmentContent[]
  content: CursorTextContent
}

interface CursorAssistantMessage {
  role: "assistant"
  content: CursorAssistantPart[]
  model?: string
}

interface CursorToolMessage {
  role: "tool"
  content: CursorToolPart[]
  isError: boolean
}

interface CursorOtherMessage {
  role: "other"
}

type CursorMessage =
  | CursorUserMessage
  | CursorAssistantMessage
  | CursorToolMessage
  | CursorOtherMessage

type SqliteStatementResult = ReturnType<StatementSync["get"]>
type SqliteRows = ReturnType<StatementSync["all"]>
type ToolBlock = Extract<EntryBlock, { type: "tool" }>

interface MetaValueRow {
  value: string | NodeJS.NonSharedUint8Array
}

interface BlobDataRow {
  data: NodeJS.NonSharedUint8Array
}

let sqliteOpen: ((path: string) => DatabaseSync) | null | undefined

/** `node:sqlite` loaded once, lazily; null when the runtime lacks it. */
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

function isStringValue(
  value: JsonValue | SQLOutputValue | undefined
): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBytesValue(
  value: SQLOutputValue | undefined
): value is NodeJS.NonSharedUint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]"
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isStringValue(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

function parseJson(raw: string): JsonValue | undefined {
  try {
    const value: JsonValue = JSON.parse(raw)
    return value
  } catch {
    return undefined
  }
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

/** The two protobuf reads the root blob needs: hash list and workspace URI. */
function parseRoot(data: Uint8Array): CursorRoot {
  const hashes: string[] = []
  let cwd: string | undefined
  let index = 0
  const varint = (): number | undefined => {
    let value = 0
    let shift = 0
    while (index < data.length && shift <= 49) {
      const byte = data[index]
      if (byte === undefined) return undefined
      index += 1
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
      shift += 7
    }
    return undefined
  }
  while (index < data.length) {
    const tag = varint()
    if (tag === undefined) break
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) {
      if (varint() === undefined) break
    } else if (wire === 2) {
      const length = varint()
      if (length === undefined || length > data.length - index) break
      const bytes = data.subarray(index, index + length)
      index += length
      if (field === 1 && length === 32) {
        hashes.push(Buffer.from(bytes).toString("hex"))
      }
      if (field === 9) {
        const uri = Buffer.from(bytes).toString("utf8")
        if (uri.startsWith("file://")) cwd = decodeURIComponent(uri.slice(7))
      }
    } else if (wire === 5) {
      if (data.length - index < 4) break
      index += 4
    } else if (wire === 1) {
      if (data.length - index < 8) break
      index += 8
    } else {
      break // An unknown wire type means we are lost; stop rather than misread.
    }
  }
  return { hashes, cwd }
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/

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
  private acpRoot: string
  /**
   * Mako's own Cursor SDK agents: `<state root>/index.db` names them and
   * `<state root>/agents/agent-<sha256(id)>/store.db` holds each transcript.
   */
  private sdkStateRoot: string
  private sdkRoot: string
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
   * index.db, so that file's stat is part of every SDK store's revision:
   * a pointer that moved after the last blob write still reads as a change.
   */
  private async nativeStores(paths: string[]): Promise<NativeFile[]> {
    const files = await nativeFiles(paths)
    if (!files.some((file) => this.isSdkStore(file.path))) return files
    const index = cursorSdkIndexPath(this.sdkStateRoot)
    const stamps = await Promise.all(
      [index, `${index}-wal`].map((candidate) =>
        stat(candidate).catch(() => null)
      )
    )
    const revision = stamps
      .map((info) => (info ? `${info.size}:${info.mtimeMs}` : "missing"))
      .join("|")
    const mtimeMs = Math.max(...stamps.map((info) => info?.mtimeMs ?? 0))
    return files.map((file) =>
      this.isSdkStore(file.path)
        ? {
            ...file,
            mtimeMs: Math.max(file.mtimeMs, mtimeMs),
            revision: `${file.revision}|index:${revision}`,
          }
        : file
    )
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
   * The root to fold and, for an SDK agent, where each stopped run ended.
   * A run's own checkpoint marks its end only while that checkpoint is a
   * prefix of the current conversation; a rewritten history marks nothing.
   */
  private foldInput(database: DatabaseSync, path: string): FoldInput | null {
    const meta = this.readMeta(database)
    if (!meta) return null
    const agent = this.isSdkStore(path) ? this.sdkAgentOf(path, meta) : null
    const rootId = this.isSdkStore(path) ? agent?.rootId : meta.latestRootBlobId
    const root = this.readRoot(database, rootId)
    if (!rootId || !root) return null
    const stops: RunStops = new Map()
    for (const run of agent?.cancelled ?? []) {
      const at = this.readRoot(database, run.rootId)?.hashes
      if (!at?.length || at.length > root.hashes.length || at.some((hash, index) => hash !== root.hashes[index])) continue
      stops.set(at.length, run.cancelledAt)
    }
    return { rootId, hashes: root.hashes, stops }
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
    const workspaces = await readdir(this.chatRoot).catch((): string[] => [])
    for (const workspace of workspaces) {
      const root = join(this.chatRoot, workspace)
      const sessions = await readdir(root).catch((): string[] => [])
      for (const session of sessions)
        paths.push(join(root, session, "store.db"))
    }
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
          agentId = this.readMeta(database)?.agentId
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
      const meta = this.readMeta(database)
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
      // (verified 2026-09-12). The two hold different turns, so the chats
      // copy is its own row. Either continues through the SDK, which imports
      // the store it is asked to reopen.
      if (this.ownsChat(file.path)) ref.identity = `chats:${nativeId}`
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
              const message = this.readMessage(statement, hash)
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
          if (fold && fold.rootId === input.rootId && fold.stopKey === stopKey(input.stops)) return unchanged()
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
      if (held && held.path === path && held.rootId === input.rootId && held.stopKey === stopKey(input.stops))
        return { ref, entries: held.entries }
      const { fold } = this.foldStore(database, input)
      this.lastFold = { ...fold, path }
      return { ref, entries: fold.entries }
    } finally {
      database.close()
    }
  }

  /** Translate the whole hash list into entries. */
  private foldStore(database: DatabaseSync, input: FoldInput): FoldStep {
    const { rootId, hashes, stops } = input
    const folded = this.foldHashes(database, hashes, 0, stops)
    return {
      fold: {
        rootId,
        stopKey: stopKey(stops),
        hashes,
        entries: folded.entries,
        // Dropped history shifts every index; no exchange is a safe restart.
        exchanges: folded.dropped ? [] : folded.exchanges,
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
    let shared = 0
    while (
      shared < previous.hashes.length &&
      shared < hashes.length &&
      previous.hashes[shared] === hashes[shared]
    )
      shared++
    if (shared === previous.hashes.length && previous.exchanges.length) {
      // Pure append. When the first new message opens an exchange of its
      // own, nothing before it can merge with it and the previous entries
      // stand; a tool result or assistant chunk first belongs to the last
      // exchange and takes the path below.
      const appended = this.foldHashes(database, hashes, shared, stops)
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
            hashes,
            entries: [...previous.entries, ...appended.entries],
            exchanges: [
              ...previous.exchanges,
              ...appended.exchanges.map((item) => ({
                hash: item.hash,
                entry: previous.entries.length + item.entry,
              })),
            ],
          },
          replaceFrom: previous.entries.length,
        }
    }
    let exchange = { hash: 0, entry: 0 }
    for (const candidate of previous.exchanges) {
      if (candidate.hash > shared) break
      exchange = candidate
    }
    const tail = this.foldHashes(database, hashes, exchange.hash, stops)
    const total = exchange.entry + tail.entries.length
    if (tail.dropped || total > FOLD_INCREMENTAL_LIMIT)
      return this.foldStore(database, input)
    const kept = previous.exchanges.filter((item) => item.hash < exchange.hash)
    return {
      fold: {
        rootId,
        stopKey: previous.stopKey,
        hashes,
        entries: [...previous.entries.slice(0, exchange.entry), ...tail.entries],
        exchanges: [
          ...kept,
          ...tail.exchanges.map((item) => ({
            hash: item.hash,
            entry: exchange.entry + item.entry,
          })),
        ],
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
    hashes: string[],
    start: number,
    stops: RunStops
  ): FoldedHashes {
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
      if (index === start || !stops.has(index)) return
      for (const call of calls) if (call.output === undefined && !call.error) call.canceled = true
      calls = []
      assistant = null
      const at = stops.get(index)
      sink.push(at ? { kind: "event", at, label: "Interrupted" } : { kind: "event", label: "Interrupted" })
    }

    for (let index = start; index < hashes.length; index++) {
      stop(index)
      const hash = hashes[index]
      if (hash === undefined) continue
      const message = this.readMessage(statement, hash)
      if (!message) continue
      switch (message.role) {
        case "user": {
          const spoken = spokenText(message.content)
          if (!spoken && !message.attachments.length) continue
          assistant = null
          calls = []
          exchanges.push({ hash: index, entry: sink.entries.length })
          sink.push({
            kind: "user",
            id: hash,
            text: spoken ?? "",
            attachments: message.attachments,
          })
          continue
        }
        case "tool":
          for (const part of message.content) {
            if (part.type !== "tool-result") continue
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
                if (part.toolName === "TodoWrite") {
                  const details = todoDetails(input)
                  if (details) block.details = details
                }
                if (part.toolCallId) toolsById.set(part.toolCallId, block)
                calls.push(block)
                assistant.blocks.push(block)
                break
              }
              case "other":
                break
            }
          }
          continue
        case "other":
          continue
      }
    }
    stop(hashes.length)
    const entries = sink.done()
    // The sink prepends one event when it dropped history; indices past it
    // no longer match the hash list, so the caller re-folds from the start.
    const dropped = entries.length > 0 && entries.length !== sink.entries.length
    return { entries, exchanges, dropped }
  }

  /* ------------------------------------------------------------ sqlite */

  private readMeta(database: DatabaseSync): CursorMeta | null {
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
    } catch {
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

  private readRoot(
    database: DatabaseSync,
    rootId: string | undefined
  ): CursorRoot | null {
    if (!rootId) return null
    try {
      const result = database
        .prepare("SELECT data FROM blobs WHERE id = ?")
        .get(rootId)
      const row = parseBlobDataRow(result)
      return row ? parseRoot(row.data) : null
    } catch {
      return null
    }
  }

  private readMessage(
    statement: StatementSync,
    hash: string
  ): CursorMessage | null {
    try {
      const row = parseBlobDataRow(statement.get(hash))
      return row
        ? parseCursorMessage(Buffer.from(row.data).toString("utf8"))
        : null
    } catch {
      return null
    }
  }
}

function parseMetaValueRow(result: SqliteStatementResult): MetaValueRow | null {
  if (!result) return null
  const value = result["value"]
  return isStringValue(value) || isBytesValue(value) ? { value } : null
}

function parseBlobDataRow(result: SqliteStatementResult): BlobDataRow | null {
  if (!result) return null
  const data = result["data"]
  return isBytesValue(data) ? { data } : null
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

function parseCursorMessage(raw: string): CursorMessage | null {
  const value = parseJson(raw)
  if (!isJsonObject(value)) return null
  switch (stringValue(value["role"])) {
    case "user":
      return {
        role: "user",
        content: parseTextContent(value["content"]),
        attachments: cursorAttachments(value["content"]),
      }
    case "assistant":
      return {
        role: "assistant",
        content: parseAssistantContent(value["content"]),
        model: stringValue(value["model"]),
      }
    case "tool":
      return {
        role: "tool",
        content: parseToolContent(value["content"]),
        isError: cursorToolError(value["providerOptions"]),
      }
    default:
      return { role: "other" }
  }
}

function parseTextContent(value: JsonValue | undefined): CursorTextContent {
  if (isStringValue(value)) return value
  if (!Array.isArray(value)) return []
  const parts: CursorTextPart[] = []
  for (const candidate of value) {
    if (!isJsonObject(candidate) || stringValue(candidate["type"]) !== "text")
      continue
    const text = stringValue(candidate["text"])
    if (text !== undefined) parts.push({ type: "text", text })
  }
  return parts
}

function parseAssistantContent(
  value: JsonValue | undefined
): CursorAssistantPart[] {
  if (!Array.isArray(value)) return []
  return value.map(parseAssistantPart)
}

function parseAssistantPart(value: JsonValue): CursorAssistantPart {
  if (!isJsonObject(value)) return { type: "other" }
  const attachment = cursorAttachments([value])[0]
  if (attachment) return { type: "attachment", value: attachment }
  switch (stringValue(value["type"])) {
    case "text": {
      const text = stringValue(value["text"])
      return text === undefined ? { type: "other" } : { type: "text", text }
    }
    case "reasoning": {
      const text = stringValue(value["text"])
      return text === undefined
        ? { type: "other" }
        : { type: "reasoning", text }
    }
    case "tool-call":
      return {
        type: "tool-call",
        toolName: stringValue(value["toolName"]) ?? "tool",
        args: value["args"],
        toolCallId: stringValue(value["toolCallId"]),
      }
    default:
      return { type: "other" }
  }
}

function cursorToolError(value: JsonValue | undefined): boolean {
  const provider = isJsonObject(value) ? value : undefined
  const cursor = isJsonObject(provider?.["cursor"])
    ? provider["cursor"]
    : undefined
  const result = isJsonObject(cursor?.["highLevelToolCallResult"])
    ? cursor["highLevelToolCallResult"]
    : undefined
  return result?.["isError"] === true
}

function parseToolContent(value: JsonValue | undefined): CursorToolPart[] {
  if (!Array.isArray(value)) return []
  return value.map(parseToolPart)
}

function parseToolPart(value: JsonValue): CursorToolPart {
  if (!isJsonObject(value) || stringValue(value["type"]) !== "tool-result") {
    return { type: "other" }
  }
  return {
    type: "tool-result",
    toolCallId: stringValue(value["toolCallId"]) ?? "",
    result: value["result"],
    attachments: cursorAttachments(value["experimental_content"]),
  }
}

function formatJson(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value)
}

function formatToolResult(value: JsonValue | undefined): string {
  const text = isStringValue(value)
    ? value
    : (JSON.stringify(value ?? "") ?? "")
  return normalizeToolOutput(text)
}

function plainText(content: CursorTextContent): string {
  return Array.isArray(content)
    ? content.map((part) => part.text).join("")
    : content
}

function cursorAttachments(
  content: JsonValue | undefined
): AttachmentContent[] {
  if (!Array.isArray(content)) return []
  const result: AttachmentContent[] = []
  for (const candidate of content) {
    if (!isJsonObject(candidate)) continue
    const type = stringValue(candidate["type"])
    if (type !== "image" && type !== "file") continue
    const name = stringValue(candidate["filename"]) ?? type
    const mimeType =
      stringValue(candidate["mimeType"]) ??
      stringValue(candidate["mediaType"]) ??
      (type === "image" ? "image/png" : "application/octet-stream")
    const value =
      stringValue(candidate["image"]) ??
      stringValue(candidate["data"]) ??
      stringValue(candidate["url"])
    const path = stringValue(candidate["path"])
    result.push(
      value
        ? /^(?:https?:|file:|data:)/.test(value)
          ? attachmentFromUrl(name, mimeType, value)
          : {
              type: "attachment",
              name,
              mimeType,
              source: { kind: "inline", data: value },
            }
        : {
            type: "attachment",
            name,
            mimeType,
            source: path
              ? { kind: "file", path }
              : {
                  kind: "unavailable",
                  reason:
                    "Attachment bytes are unavailable in this native record",
                },
          }
    )
  }
  return result
}
