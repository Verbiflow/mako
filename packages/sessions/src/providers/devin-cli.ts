import { z } from "zod"
import {
  devinReferences,
  devinPromptImages,
  devinMcpCall,
} from "./devin-presentation.js"
import { todoDetails } from "../tool-plan.js"
import {
  attachmentFromUrl,
  ProposedPlans,
  type AttachmentContent,
} from "../content.js"
import { acpShownDetails, acpToolFields, AcpToolUpdateSchema, mergeAcpTool, type AcpToolFields } from "../acp-tool-details.js"
import { DEVIN_TOOL_READING, DevinCallMetrics, devinStoredTokens } from "../harnesses/devin.js"
import { tokenSum } from "../harnesses/tokens.js"
import { devinCliDirectory } from "./devin-location.js"
import {
  DevinPlanCallSchema,
  DevinPlanTracker,
  type DevinPlanCall,
} from "./devin-plans.js"
/**
 * devin-cli's own sessions — the ones Zed's agent panel (or any ACP host)
 * drives.
 *
 * The Devin IDE journals ACP traffic itself; the *CLI* keeps its own store:
 * one SQLite database at `~/.local/share/devin/cli/sessions.db` with a
 * `sessions` table (id, working_directory, model, title, activity) and a
 * `message_nodes` forest whose rows are JSON chat messages. A Devin thread
 * run through Zed exists only here — no per-session file anywhere.
 *
 * One database, many sessions, so discovery synthesizes one NativeFile per
 * session (`…/sessions.db#<id>`), sized by its highest message row and
 * dated by its last activity — the catalog's cheap change detection works
 * unchanged. The provider marks itself `rescanRoot`: a write to the db (or
 * its WAL) re-runs discovery instead of stat-ing a path that does not
 * exist as a file.
 */

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { removeSessionRows } from "../sqlite-removal.js"
import { nativeStoreVersion, openNativeStore } from "../read-only-sqlite.js"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import {
  clip,
  EntrySink,
  agentTitleFrom,
  titleFrom,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
  type TurnUsage,
} from "../format.js"
import { normalizeToolOutput } from "../tool-output.js"
import { subagentLabel } from "../provider-turn.js"
import { compactionEvent } from "../events.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./types.js"

type SqliteFields = Record<string, SQLOutputValue>
type StoredTimestamp = number | undefined
type ToolBlock = Extract<EntryBlock, { type: "tool" }>
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

type TextSource = JsonValue | SQLOutputValue | undefined

interface JsonObject {
  [key: string]: JsonValue
}

type ChatContent = JsonValue

interface ToolFunction {
  name?: string
  arguments?: JsonValue
}

interface ToolCall {
  id?: string
  name?: string
  arguments?: JsonValue
  function?: ToolFunction
}

interface ChatMessage {
  role?: string
  content?: ChatContent
  images?: JsonValue
  thinking?: ChatContent
  tool_calls?: ToolCall[]
  tool_call_id?: string
  usage?: TurnUsage
  /** Devin's per-message annotations, `metadata.extensions`. */
  extensions?: JsonObject
  /** When Devin made the message, `metadata.created_at`; it writes a steered one after the step it waited for. */
  writtenAt?: string
}

interface DiscoveryRow {
  id: string
  activity: StoredTimestamp
  top: number
  title: string | null
  cwd: string | null
}

interface SessionRow {
  workingDirectory?: string
  model?: string
  title?: string
  createdAt: StoredTimestamp
  lastActivityAt: StoredTimestamp
}

interface MessageRow {
  rowId: number
  chatMessage?: string
  createdAt: StoredTimestamp
  usage?: TurnUsage
  /** On a compaction's summary, the node the history it summarizes ends at. */
  summarizedFrom?: number
}

interface MessageTranslator {
  push(row: MessageRow): void
  snapshot(): ThreadEntry[]
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

/** Epoch seconds or millis — the store has carried both readings. */
function isoOf(value: StoredTimestamp): string | undefined {
  if (value === undefined || value <= 0) return undefined
  return new Date(value > 1e12 ? value : value * 1000).toISOString()
}

export class DevinCliProvider implements SessionProvider {
  harness = "devin" as const
  displayName = "Devin"
  /** Refresh cached titles after native image/control/attachment labels are projected. */
  peekVersion = 1
  /** One store, many sessions: a db write means re-discover, not re-stat. */
  rescanRoot = (): boolean => true
  rescanDebounceMs = 500

  private dir: string
  private db: DatabaseSync | null = null
  private dbIdentity: string | null = null

  /**
   * `env` is the environment Devin runs with. The process's own is read only
   * for the default home: a provider built on another home is an isolated
   * world (a fixture, a mirror).
   */
  constructor(home?: string, env = home === undefined ? process.env : {}) {
    this.dir = devinCliDirectory(env, home ?? homedir())
  }

  roots(): string[] {
    return [this.dir]
  }

  observationPaths(): string[] {
    const database = this.dbPath()
    return [database, `${database}-wal`]
  }

  /** Only the locks folder: logs and plugin state beside it change without a session moving. */
  watchRoots(): string[] {
    return [this.lockPath()]
  }

  pollFiles(): string[] {
    return this.observationPaths()
  }

  /**
   * Sessions live in the database and their locks; the logs, plugin state
   * and summaries beside them change without a session moving.
   */
  watchTarget(path: string): string | null {
    return path.startsWith(this.dbPath()) ||
      path.startsWith(`${this.lockPath()}${sep}`)
      ? path
      : null
  }

  private dbPath(): string {
    return join(this.dir, "sessions.db")
  }

  private async connection(): Promise<DatabaseSync | null> {
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return null
    const identity = `${info.dev}:${info.ino}:${nativeStoreVersion(this.dbPath())}`
    if (this.db && this.dbIdentity === identity) return this.db
    this.db?.close()
    this.db = await openDatabase(this.dbPath())
    this.dbIdentity = this.db ? identity : null
    return this.db
  }

  private resetConnection(): void {
    this.db?.close()
    this.db = null
    this.dbIdentity = null
  }

  private lockPath(): string {
    return join(this.dir, "session_locks")
  }

  async discover(): Promise<NativeFile[]> {
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return []
    const db = await this.connection()
    if (!db) return []
    try {
      const stored = db
        .prepare(
          `SELECT s.id AS id, s.last_activity_at AS activity,
                  COALESCE(s.main_chain_id, -1) AS top,
                  s.title AS title, s.working_directory AS cwd
           FROM sessions s WHERE s.hidden = 0`
        )
        .all()
      const rows = stored
        .map(parseDiscoveryRow)
        .filter((row): row is DiscoveryRow => row !== null)
      const locked = await lockedSessionIds(
        this.lockPath(),
        rows.map((row) => row.id)
      )
      const files: NativeFile[] = []
      for (const row of rows) {
        const at = isoOf(row.activity)
        const isLocked = locked.has(row.id)
        // Synthetic sessions share one database; this fractional revision lets
        // lock-only changes invalidate one cached ref without moving its cursor.
        files.push({
          path: `${this.dbPath()}#${row.id}`,
          bytes: row.top,
          mtimeMs: (at ? Date.parse(at) : info.mtimeMs) + (isLocked ? 0.5 : 0),
          // Devin renames a session without touching last_activity_at.
          revision: JSON.stringify([row.title, row.cwd]),
          locked: isLocked,
        })
      }
      return files
    } catch {
      this.resetConnection()
      return []
    }
  }

  /** Remove a session and every row that names it; the read connection is reset so it cannot serve the ghost. */
  async remove(path: string): Promise<boolean> {
    const id = idOf(path)
    if (!id || path.slice(0, path.lastIndexOf("#")) !== this.dbPath())
      return false
    this.resetConnection()
    return removeSessionRows(this.dbPath(), id, ["sessions"])
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const id = idOf(file.path)
    if (!id) return null
    const db = await this.connection()
    if (!db) return null
    try {
      const stored = db
        .prepare(
          "SELECT working_directory, model, title, created_at, last_activity_at FROM sessions WHERE id = ?"
        )
        .get(id)
      if (!stored) return null
      const row = parseSessionRow(stored)
      let title = agentTitleFrom(row.title)
      if (!title) {
        for (const entry of translatedMainChain(db, id, mainChainId(db, id))) {
          if (entry.kind !== "user") continue
          title = titleFrom(entry.text)
          if (title) break
        }
      }
      return {
        harness: this.harness,
        nativeId: id,
        path: file.path,
        cwd: row.workingDirectory,
        title,
        model: row.model,
        settings: { model: row.model },
        modelProvider: "devin",
        startedAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.lastActivityAt),
        bytes: file.bytes,
        locked: file.locked,
      }
    } catch {
      this.resetConnection()
      return null
    }
  }

  async read(path: string): Promise<Thread | null> {
    const id = idOf(path)
    if (!id) return null
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return null
    const locked = (await lockedSessionIds(this.lockPath(), [id])).has(id)
    const ref = await this.peek({
      path,
      bytes: 0,
      mtimeMs: info.mtimeMs,
      locked,
    })
    if (!ref) return null
    const db = await this.connection()
    if (!db) return null
    try {
      const cursor = mainChainId(db, id)
      ref.bytes = cursor
      return { ref, entries: translatedMainChain(db, id, cursor) }
    } catch {
      this.resetConnection()
      return null
    }
  }

  createFollower(path: string, fromByte: number): SessionFollower {
    const id = idOf(path)
    let cursor = fromByte
    let previous: string[] | null = null

    return {
      get offset() {
        return cursor
      },
      next: async (): Promise<SessionUpdate> => {
        if (!id) return unchangedUpdate(cursor)
        const db = await this.connection()
        if (!db) return unchangedUpdate(cursor)
        try {
          if (previous === null) {
            previous = translatedMainChain(db, id, cursor).map(entryDigest)
          }
          const nextCursor = mainChainId(db, id)
          if (nextCursor === cursor) return unchangedUpdate(cursor)
          const current = translatedMainChain(db, id, nextCursor)
          const signatures = current.map(entryDigest)
          let shared = 0
          while (
            shared < previous.length &&
            previous[shared] === signatures[shared]
          ) {
            shared += 1
          }
          const appended = shared === previous.length
          const entries = appended
            ? current.slice(previous.length)
            : current.slice(shared)
          previous = signatures
          cursor = nextCursor
          const update: SessionUpdate = {
            entries: structuredClone(entries),
            nextByte: cursor,
            replace: !appended,
          }
          if (!appended) update.replaceFrom = shared
          return update
        } catch {
          this.resetConnection()
          return unchangedUpdate(cursor)
        }
      },
    }
  }

  close(): void {
    this.resetConnection()
  }
}

function mainChainId(db: DatabaseSync, sessionId: string): number {
  const stored = db
    .prepare(
      "SELECT COALESCE(main_chain_id, -1) AS main_chain_id FROM sessions WHERE id = ?"
    )
    .get(sessionId)
  return stored && isSqliteNumber(stored.main_chain_id)
    ? stored.main_chain_id
    : -1
}

/**
 * The main chain, each compaction's earlier history read before it: Devin
 * 3000.10.23 starts a new chain after compacting, whose summary row's
 * `summarized_from` names the node the earlier chain ends at.
 */
function mainChainRows(
  db: DatabaseSync,
  sessionId: string,
  leafId: number,
  read = new Set<number>()
): MessageRow[] {
  if (leafId < 0 || read.has(leafId)) return []
  read.add(leafId)
  const rows = chainRows(db, sessionId, leafId)
  const from = rows.find((row) => row.summarizedFrom !== undefined)?.summarizedFrom
  return from === undefined ? rows : [...mainChainRows(db, sessionId, from, read), ...rows]
}

function chainRows(
  db: DatabaseSync,
  sessionId: string,
  leafId: number
): MessageRow[] {
  const metadata = db
    .prepare("PRAGMA table_info(message_nodes)")
    .all()
    .some((row) => row.name === "metadata")
    ? "metadata"
    : "NULL"
  const stored = db
    .prepare(
      `WITH RECURSIVE chain(
         row_id, node_id, parent_node_id, chat_message, metadata, created_at, depth
       ) AS (
         SELECT row_id, node_id, parent_node_id, chat_message, ${metadata}, created_at, 0
         FROM message_nodes
         WHERE session_id = ? AND node_id = ?
         UNION ALL
         SELECT m.row_id, m.node_id, m.parent_node_id, m.chat_message,
                ${metadata === "metadata" ? "m.metadata" : "NULL"},
                m.created_at, chain.depth + 1
         FROM message_nodes m
         JOIN chain ON m.node_id = chain.parent_node_id
         WHERE m.session_id = ?
       )
       SELECT row_id, chat_message, metadata, created_at
       FROM chain
       ORDER BY depth DESC`
    )
    .all(sessionId, leafId, sessionId)
  return stored.map(parseMessageRow)
}

function translatedMainChain(
  db: DatabaseSync,
  sessionId: string,
  leafId: number
): ThreadEntry[] {
  const cwd = sqliteText(db.prepare("SELECT working_directory AS cwd FROM sessions WHERE id = ?").get(sessionId)?.cwd)
  const into = translator(sessionId, acpToolCalls(db, sessionId), cwd)
  for (const row of mainChainRows(db, sessionId, leafId)) into.push(row)
  return into.snapshot()
}

interface AcpToolCallState {
  call?: DevinPlanCall
  update?: DevinPlanCall
  /** The tool as Devin showed its client: the stored call with its final update over it, read as the live decoder reads them. */
  shown: AcpToolFields
}

function storedTool(value: SQLOutputValue | undefined): AcpToolFields {
  const text = sqliteText(value)
  if (!text) return {}
  try {
    const parsed = AcpToolUpdateSchema.safeParse(JSON.parse(text))
    return parsed.success ? acpToolFields(parsed.data, DEVIN_TOOL_READING) : {}
  } catch {
    return {}
  }
}

/**
 * The input Devin showed its client. Its stored call can drop arguments the
 * model gave (an edit's strings, which its diff holds); when every field it
 * kept matches the model's, the model's arguments are what was shown.
 */
function shownInput(stored: string | undefined, model: string | undefined): string | undefined {
  if (stored === undefined || model === undefined) return stored ?? model
  const kept = jsonObject(stored)
  const given = jsonObject(model)
  if (!kept || !given) return stored
  const abridged = Object.entries(kept).every(([key, value]) => key in given && JSON.stringify(given[key]) === JSON.stringify(value))
  return abridged ? model : stored
}

function jsonObject(text: string): Record<string, JsonValue> | undefined {
  try {
    return z.record(z.string(), z.json()).safeParse(JSON.parse(text)).data
  } catch {
    return undefined
  }
}

/**
 * Each tool call as Devin reported it over ACP, which is where a plan file's
 * rendered text and path live; the chat messages hold only the model's own
 * arguments. Older stores have no such table.
 */
function acpToolCalls(
  db: DatabaseSync,
  sessionId: string
): Map<string, AcpToolCallState> {
  const calls = new Map<string, AcpToolCallState>()
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_call_state'"
    )
    .get()
  if (!table) return calls
  const rows = db
    .prepare(
      "SELECT tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE session_id = ?"
    )
    .all(sessionId)
  for (const row of rows) {
    const id = sqliteText(row.tool_call_id)
    if (id)
      calls.set(id, {
        call: planCall(row.tool_call_json),
        update: planCall(row.tool_call_update_json),
        shown: mergeAcpTool(storedTool(row.tool_call_json), storedTool(row.tool_call_update_json)),
      })
  }
  return calls
}

function planCall(
  value: SQLOutputValue | undefined
): DevinPlanCall | undefined {
  const text = sqliteText(value)
  if (!text) return undefined
  try {
    return DevinPlanCallSchema.safeParse(JSON.parse(text)).data
  } catch {
    return undefined
  }
}

function entryDigest(entry: ThreadEntry): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("base64url")
}

/** Native lock files accumulate after sessions disappear. Only read locks for
 * the sessions this operation actually returns; recheck their PIDs every time. */
async function lockedSessionIds(
  path: string,
  ids: string[]
): Promise<Set<string>> {
  const locked = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 8) {
    await Promise.all(
      ids.slice(offset, offset + 8).map(async (id) => {
        // Session IDs are database data, never permission to read outside locks.
        if (id.includes("/") || id.includes("\\")) return
        const raw = await readFile(join(path, `${id}.lock`), "utf8").catch(
          () => ""
        )
        const pid = Number(raw.trim())
        if (!Number.isInteger(pid) || pid <= 0) return
        try {
          process.kill(pid, 0)
          locked.add(id)
        } catch {
          /* No live lock owner. */
        }
      })
    )
  }
  return locked
}

/** A read's result as the model saw it, the file between line-number gutters. */
const FILE_VIEW = /^<file-view\b[^>]*\bstart_line="(\d+)"[^>]*\bend_line="(\d+)"[^>]*\btotal_lines="(\d+)"[^>]*>[\s\S]*<\/file-view>\s*$/

const ReadRange = z.object({ offset: z.number().optional(), limit: z.number().optional() }).loose()

/**
 * A result Devin showed its client but didn't keep in its stored update
 * (devin 3000.10.23): a read was "N lines", and "N lines (truncated)" when
 * Devin cut it short of both the file's end and the lines asked for (about
 * 30 KB of a file read whole); the file itself stays the model's. Any other
 * such result showed no words.
 */
function devinClientResult(output: string, input: string | undefined): string {
  const view = FILE_VIEW.exec(output)
  if (!view) return ""
  const [start, end, total] = [Number(view[1]), Number(view[2]), Number(view[3])]
  const asked = ReadRange.safeParse(input === undefined ? undefined : jsonObject(input)).data
  const askedEnd = asked?.limit === undefined ? total : (asked.offset ?? 1) + asked.limit - 1
  return `${end - start + 1} lines${end < Math.min(total, askedEnd) ? " (truncated)" : ""}`
}

/**
 * A question's picks (devin 3000.10.23), which its client was shown as the
 * call's result: "Friday" for one question answered with one option. The
 * model read them as JSON in the result's text.
 */
const DEVIN_QUESTION_ANSWERS = "chisel/user_question_answers"
const DevinQuestionAnswers = z.object({ answers: z.array(z.object({ selected: z.array(z.string()) }).loose()) }).loose()

function devinPicks(answers: JsonValue | undefined): string | undefined {
  const picked = DevinQuestionAnswers.safeParse(answers).data
  return picked && picked.answers.map((answer) => answer.selected.join(", ")).join("\n")
}

const ImageSize = z.object({ width: z.number(), height: z.number() }).loose()

/**
 * What a read of an image showed Devin's client (devin 3000.10.23): `View
 * image ./swatch.png (32x32)`, the path from the session's folder. The
 * model got the image itself.
 */
function viewedImage(input: string | undefined, images: JsonValue | undefined, cwd: string | undefined): string | undefined {
  const size = ImageSize.safeParse(Array.isArray(images) ? images[0] : undefined).data
  const path = input === undefined ? undefined : jsonObject(input)?.["file_path"]
  if (!size || !isTextValue(path)) return undefined
  const inside = cwd ? relative(cwd, path) : undefined
  const shown = inside && !inside.startsWith("..") && !isAbsolute(inside) ? `./${inside}` : path
  return `View image ${shown} (${size.width}x${size.height})`
}

/** A grep result's header for each file it matched in. */
const GREP_FILE = /^-- \d+ match(?:es)? in (\/.+)$/gm

/**
 * The files a search showed its client as links, which its stored update
 * dropped (devin 3000.10.23): a find's result lists one path a line, a
 * grep's heads each file's matches with its path.
 */
function devinFoundFiles(name: string | undefined, output: string): AttachmentContent[] {
  const paths =
    name === "find_file_by_name" ? output.split("\n").filter((line) => line.startsWith("/"))
    : name === "grep" ? [...output.matchAll(GREP_FILE)].map((match) => match[1] ?? "")
    : []
  return paths.map((path) => attachmentFromUrl(basename(path), "application/octet-stream", `file://${path}`))
}

/** The system message Devin appends to a turn the user stopped. */
const DEVIN_STOP_NOTICE = "[Response interrupted by user]"
/**
 * Annotations on a saved message (devin 3000.10.23): the system message that
 * replaces compacted history carries `devin-rs/summary`, and a tool result
 * that failed carries `chisel/tool_failure` with its reason.
 */
const DEVIN_SUMMARY = "devin-rs/summary"
const DEVIN_TOOL_FAILURE = "chisel/tool_failure"
/** Why a tool failed; a call the person stopped failed `Canceled`. */
const DevinToolFailure = z.object({ reason: z.string() }).loose()
/**
 * A command's output and exit (devin 3000.10.23). A command that exited
 * non-zero isn't a `chisel/tool_failure`, though it failed: `cat` of a
 * missing file is kept `success: true` with exit code 1.
 */
const DEVIN_TERMINAL_OUTPUT = "chisel/terminal_output"
const DevinTerminalOutput = z.object({ exit: z.object({ exit_code: z.number().nullish() }).loose().nullish() }).loose()

/** The summary a compaction message holds, after the preamble that names where the full history went. */
function compactionSummary(text: string): string {
  const at = text.indexOf("\nSummary:\n")
  return at === -1 ? text : text.slice(at + "\nSummary:\n".length)
}

function translator(
  sessionId: string,
  acp: ReadonlyMap<string, AcpToolCallState>,
  cwd: string | undefined
): MessageTranslator {
  const sink = new EntrySink()
  const tools = new Map<string, ToolBlock>()
  const plans = new DevinPlanTracker()
  const cards = new ProposedPlans()
  /** A turn ends with an assistant message that calls no tool, or a stop. */
  let running = false
  /** The prompt that opened the running turn, which a steered message names. */
  let opener: string | undefined
  /** When the message before this one was made. */
  let previous = Number.NaN
  const subagentCalls = new Map<string, string>()
  const subagentTitles = new Map<string, string>()

  return {
    push(row) {
      if (!row.chatMessage) return
      const message = parseChatMessage(row.chatMessage)
      if (!message) return
      const at = isoOf(row.createdAt)
      const written = Date.parse(message.writtenAt ?? "")
      const before = previous
      if (Number.isFinite(written)) previous = written
      if (message.role === "system") {
        const text = contentText(message.content)
        if (text.trim() === DEVIN_STOP_NOTICE) {
          running = false
          sink.push({
            kind: "event",
            id: String(row.rowId),
            source: { harness: "devin", record: String(row.rowId) },
            at,
            label: "Interrupted",
          })
          return
        }
        if (message.extensions?.[DEVIN_SUMMARY] !== undefined) {
          sink.push({
            kind: "event",
            id: String(row.rowId),
            source: { harness: "devin", record: String(row.rowId) },
            at,
            ...compactionEvent({ summary: clip(compactionSummary(text)) }),
          })
          return
        }
        const completion = parseSubagentCompletion(text)
        if (!completion) return
        // Devin runs a turn on a completion that arrives while it is idle.
        if (!running) {
          sink.push({
            kind: "event",
            id: String(row.rowId),
            at,
            label: subagentLabel({
              description: subagentTitles.get(completion.id),
              state: completion.status === "completed" ? "completed" : "failed",
            }),
            opensTurn: true,
          })
          running = true
        }
        sink.push({
          kind: "assistant",
          at,
          blocks: [
            {
              type: "tool",
              name: "subagent",
              input: JSON.stringify({
                agent_id: completion.id,
                status: completion.status,
              }),
              output: clip(completion.output),
              error: completion.status !== "completed",
            },
          ],
        })
        return
      }
      if (message.role === "user") {
        const prompt = devinPromptImages(contentText(message.content))
        const text = prompt.text
        const images = storedImages(message.images)
        const byPath = new Map(images.flatMap(image => image.path ? [[image.path, image.attachment] as const] : []))
        const referenced = new Set(prompt.attachments.flatMap(item => item.source.kind === "file" ? [item.source.path] : []))
        const attachments = [
          ...devinAttachments(message.content),
          ...prompt.attachments.map(item => item.source.kind === "file" ? byPath.get(item.source.path) ?? item : item),
          ...images.filter(image => !image.path || !referenced.has(image.path)).map(image => image.attachment),
        ]
        // Devin holds a message steered into a running turn until the step
        // it arrived during ends, so it was made before the row it follows.
        const steers = running && written < before ? opener : undefined
        if (!steers) opener = String(row.rowId)
        running = true
        if (text.trim() || attachments.length)
          sink.push({
            kind: "user",
            id: String(row.rowId),
            at,
            ...steers && { steeringFor: steers },
            text,
            attachments,
          })
        return
      }
      if (message.role === "assistant") {
        const blocks: EntryBlock[] = [...devinAttachments(message.content)]
        const thinking = contentText(message.thinking)
        if (thinking.trim())
          blocks.push({ type: "thinking", text: devinReferences(thinking) })
        running = (message.tool_calls?.length ?? 0) > 0
        // The model's words come before the calls they introduce.
        const text = contentText(message.content)
        if (text.trim())
          blocks.push({ type: "text", text: devinReferences(text) })
        for (const call of message.tool_calls ?? []) {
          const name = call.name ?? call.function?.name ?? "tool"
          const rawInput = call.arguments ?? call.function?.arguments
          // Over ACP a todo list arrives as a plan, never as the call that wrote it.
          if (name === "todo_write") {
            blocks.push({ type: "tool", name: "Plan", output: "", details: todoDetails(toolInputText(rawInput)) })
            continue
          }
          const title =
            name === "run_subagent" ? subagentTitle(rawInput) : undefined
          if (call.id && title) subagentCalls.set(call.id, title)
          const shown = call.id ? acp.get(call.id)?.shown : undefined
          const block: ToolBlock = {
            type: "tool",
            id: call.id,
            name,
            input: shownInput(shown?.input, toolInputText(rawInput)),
          }
          const details = shown && acpShownDetails(shown)
          if (details) block.details = details
          if (shown?.attachments) block.attachments = shown.attachments
          const mcp =
            name === "mcp_call_tool" ? devinMcpCall(block.input) : undefined
          if (mcp) {
            block.name = mcp.name
            block.input = mcp.input
          }
          blocks.push(block)
          if (call.id) tools.set(call.id, block)
          const plan = call.id
            ? plans.observe(acp.get(call.id)?.call, sessionId)
            : undefined
          const proposed = plan && cards.propose(plan.id, plan.text)
          if (proposed && !proposed.revised) blocks.push(proposed.card)
        }
        const usage = message.usage ?? row.usage
        if (blocks.length > 0 || usage) {
          const entry: Extract<ThreadEntry, { kind: "assistant" }> = {
            kind: "assistant",
            at,
            blocks,
          }
          if (usage) entry.usage = usage
          sink.push(entry)
        }
        return
      }
      if (message.role === "tool") {
        running = true
        const block = message.tool_call_id
          ? tools.get(message.tool_call_id)
          : undefined
        if (message.tool_call_id)
          plans.observe(acp.get(message.tool_call_id)?.update, sessionId)
        if (!block) return
        const output = contentText(message.content)
        const title = message.tool_call_id
          ? subagentCalls.get(message.tool_call_id)
          : undefined
        const agent = title
          ? /^Background subagent started with agent_id=([^\s.]+)/.exec(
              output
            )?.[1]
          : undefined
        if (title && agent) subagentTitles.set(agent, title)
        const shown = message.tool_call_id ? acp.get(message.tool_call_id)?.shown : undefined
        const viewed = block.name === "read" ? viewedImage(block.input, message.images, cwd) : undefined
        const picks = devinPicks(message.extensions?.[DEVIN_QUESTION_ANSWERS])
        block.output = clip(normalizeToolOutput(shown ? shown.output ?? viewed ?? picks ?? devinClientResult(output, block.input) : output))
        const failure = message.extensions?.[DEVIN_TOOL_FAILURE]
        const exitCode = DevinTerminalOutput.safeParse(message.extensions?.[DEVIN_TERMINAL_OUTPUT]).data?.exit?.exit_code
        if (failure !== undefined && DevinToolFailure.safeParse(failure).data?.reason === "Canceled") block.canceled = true
        else if (failure !== undefined || (exitCode != null && exitCode !== 0)) block.error = true
        const attachments = devinAttachments(message.content)
        if (attachments.length) block.attachments = attachments
        const found = shown && !shown.attachments ? devinFoundFiles(block.name, output) : []
        if (found.length) block.attachments = [...block.attachments ?? [], ...found]
      }
    },
    snapshot() {
      return sink.snapshot()
    },
  }
}

function parseSubagentCompletion(text: string): {
  id: string
  status: string
  output: string
} | null {
  const match =
    /^<subagent_completion_notification>\s*\n\[Background subagent with agent_id=([^\s\]]+) ([^\]]+)\]\s*\n([\s\S]*?)\s*<\/subagent_completion_notification>\s*$/.exec(
      text
    )
  if (!match) return null
  return {
    id: match[1]!,
    status: match[2]!,
    output: match[3]?.trim() ?? "",
  }
}

function unchangedUpdate(nextByte: number): SessionUpdate {
  return { entries: [], nextByte, replace: false }
}

function parseDiscoveryRow(fields: SqliteFields): DiscoveryRow | null {
  if (!isTextValue(fields.id) || !fields.id) return null
  return {
    id: fields.id,
    activity: sqliteNumber(fields.activity),
    top: isSqliteNumber(fields.top) ? fields.top : 0,
    title: isTextValue(fields.title) ? fields.title : null,
    cwd: isTextValue(fields.cwd) ? fields.cwd : null,
  }
}

function parseSessionRow(fields: SqliteFields): SessionRow {
  return {
    workingDirectory: sqliteText(fields.working_directory),
    model: sqliteText(fields.model) || undefined,
    title: sqliteText(fields.title),
    createdAt: sqliteNumber(fields.created_at),
    lastActivityAt: sqliteNumber(fields.last_activity_at),
  }
}

function parseMessageRow(fields: SqliteFields): MessageRow {
  const metadata = parseMetadata(sqliteText(fields.metadata))
  return {
    rowId: isSqliteNumber(fields.row_id) ? fields.row_id : 0,
    chatMessage: sqliteText(fields.chat_message),
    createdAt: sqliteNumber(fields.created_at),
    usage: usageFromMetadata(metadata),
    summarizedFrom: SummarizedFromSchema.safeParse(metadata).data?.summarized_from,
  }
}

const SummarizedFromSchema = z.object({ summarized_from: z.number() })

function usageFromMetadata(
  metadata: JsonValue | undefined
): TurnUsage | undefined {
  const metrics = isJsonObject(metadata) ? DevinCallMetrics.safeParse(metadata.metrics).data : undefined
  if (!metrics) return undefined
  const tokens = devinStoredTokens(metrics)
  const { input, output, cacheRead, cacheWrite } = tokens
  return tokenSum(tokens) > 0 ? { input, output, cacheRead, cacheWrite } : undefined
}

function parseMetadata(text: string | undefined): JsonValue | undefined {
  if (!text) return undefined
  try {
    const metadata: JsonValue = JSON.parse(text)
    return metadata
  } catch {
    return undefined
  }
}

function parseChatMessage(text: string): ChatMessage | null {
  try {
    const parsed: JsonValue = JSON.parse(text)
    if (!isJsonObject(parsed)) return null
    return {
      role: jsonText(parsed.role),
      content: parsed.content,
      images: parsed.images,
      thinking: parsed.thinking,
      tool_calls: parseToolCalls(parsed.tool_calls),
      tool_call_id: jsonText(parsed.tool_call_id),
      usage: usageFromMetadata(parsed.metadata),
      extensions:
        isJsonObject(parsed.metadata) &&
        isJsonObject(parsed.metadata.extensions)
          ? parsed.metadata.extensions
          : undefined,
      writtenAt: isJsonObject(parsed.metadata) ? jsonText(parsed.metadata.created_at) : undefined,
    }
  } catch {
    return null
  }
}

function parseToolCalls(value: JsonValue | undefined): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: ToolCall[] = []
  for (const item of value) {
    if (!isJsonObject(item)) continue
    calls.push({
      id: jsonText(item.id),
      name: jsonText(item.name),
      arguments: item.arguments,
      function: parseToolFunction(item.function),
    })
  }
  return calls
}

function parseToolFunction(
  value: JsonValue | undefined
): ToolFunction | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    name: jsonText(value.name),
    arguments: value.arguments,
  }
}

function sqliteText(value: SQLOutputValue | undefined): string | undefined {
  return isTextValue(value) ? value : undefined
}

function jsonText(value: JsonValue | undefined): string | undefined {
  return isTextValue(value) ? value : undefined
}

function sqliteNumber(value: SQLOutputValue | undefined): StoredTimestamp {
  return isSqliteNumber(value) ? value : undefined
}

function isTextValue(value: TextSource): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isSqliteNumber(value: SQLOutputValue | undefined): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(Number(value))
  )
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value)
  )
}

function subagentTitle(input: JsonValue | undefined): string | undefined {
  if (isJsonObject(input)) return jsonText(input.title)
  if (!isTextValue(input)) return undefined
  try {
    const parsed: JsonValue = JSON.parse(input)
    return isJsonObject(parsed) ? jsonText(parsed.title) : undefined
  } catch {
    return undefined
  }
}

function toolInputText(input: JsonValue | undefined): string | undefined {
  if (input === undefined) return undefined
  return clip(isTextValue(input) ? input : JSON.stringify(input))
}

function idOf(path: string): string | null {
  const at = path.lastIndexOf("#")
  return at === -1 ? null : path.slice(at + 1) || null
}

function contentText(content: ChatContent | undefined): string {
  if (isTextValue(content)) return content
  if (isJsonObject(content)) {
    if (isTextValue(content.text)) return content.text
    if (isTextValue(content.thinking)) return content.thinking
    if (content.content !== undefined) return contentText(content.content)
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isTextValue(part)) return part
        return isJsonObject(part) && isTextValue(part.text) ? part.text : ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

function devinAttachments(
  content: ChatContent | undefined
): AttachmentContent[] {
  if (!Array.isArray(content)) return []
  const attachments: AttachmentContent[] = []
  for (const part of content) {
    if (!isJsonObject(part)) continue
    const type = jsonText(part.type)
    if (type !== "image_url" && type !== "input_audio" && type !== "file")
      continue
    const image = isJsonObject(part.image_url) ? part.image_url : undefined
    const audio = isJsonObject(part.input_audio) ? part.input_audio : undefined
    const url =
      jsonText(image?.url) ?? jsonText(part.image_url) ?? jsonText(part.url)
    const mimeType =
      type === "image_url"
        ? "image/png"
        : type === "input_audio"
          ? `audio/${jsonText(audio?.format) ?? "wav"}`
          : "application/octet-stream"
    const data = jsonText(audio?.data)
    attachments.push(
      url
        ? attachmentFromUrl(type, mimeType, url)
        : {
            type: "attachment",
            name: jsonText(part.filename) ?? type,
            mimeType,
            source: data
              ? { kind: "inline", data }
              : {
                  kind: "unavailable",
                  reason: "The provider did not retain attachment bytes",
                },
          }
    )
  }
  return attachments
}

const StoredImage = z.object({
  source_path: z.string().refine(isAbsolute).optional(),
  mime_type: z.string().regex(/^image\/[\w.+-]+$/),
  base64_data: z.string().optional(),
})
interface NativeStoredImage {
  path?: string
  attachment: AttachmentContent
}

/** Devin stores image bytes outside chat content; use them even after the staged file disappears. */
function storedImages(value: JsonValue | undefined): NativeStoredImage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const parsed = StoredImage.safeParse(item)
    if (!parsed.success) return []
    const image = parsed.data
    let source: AttachmentContent["source"]
    if (image.base64_data)
      source = image.base64_data.length > 28 * 1024 * 1024
        ? { kind: "unavailable", reason: "The native image exceeds the inline preview limit; original bytes remain in the Devin store" }
        : { kind: "inline", data: image.base64_data }
    else if (image.source_path) source = { kind: "file", path: image.source_path }
    else return []
    const attachment: AttachmentContent = {
      type: "attachment",
      name: image.source_path ? basename(image.source_path) : "Image",
      mimeType: image.mime_type,
      source,
    }
    return [{ path: image.source_path, attachment }]
  })
}
