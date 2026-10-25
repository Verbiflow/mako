import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { WriterEvidenceLookups } from "../record-evidence.js"
import type { WriterEvidence } from "../record-writers.js"
import { AcpSavedTurns, acpSavedNotification, acpSavedRefusal, SavedAcpNotificationSchema } from "../acp-saved-turns.js"
import { acpAttachments, acpText } from "../acp-tool-details.js"
import { backgroundReminderTurn, GROK_ACP_HOOKS, grokCost, grokHostCommand, grokLineMillis, GrokTaskSnapshot, grokTokens, grokTurnsBetween, GrokTurnUsage, grokUpdateReading, grokWakingChild, GrokWokenSpend } from "../harnesses/grok.js"
import type { AttachmentContent } from "../content.js"
import { UNNAMED_TURN } from "../provider-turn.js"
import { compactionEvent, compactionFailedEvent, CONTEXT_COMPACTED, event, INTERRUPTED, manualCompaction, modelChangedEvent, plainWords, TURN_ENDED, TURN_FAILED, turnFailedEvent, usageLimitEvent, type TranscriptEvent } from "../events.js"
/**
 * Grok sessions.
 *
 * Modern sessions keep their authoritative live transcript in `updates.jsonl`:
 * the ACP `session/update` notifications Grok sent, read by the live
 * client's own decoder, plus private
 * `_x.ai/session/update` turn boundaries. `summary.json` remains the authority
 * for identity, title, timestamps, current model, and reasoning effort. Older
 * sessions have only `chat_history.jsonl`; discovery falls back to that file,
 * but never returns both logs for one session.
 *
 * A session directory also holds sidecars Grok rewrites constantly
 * (`summary.json`, `chat_history.jsonl` beside updates, `events.jsonl`).
 * Those are not session files. Peeking them as rows makes the catalog
 * oscillate between two titles for one native id.
 *
 * `session/new` writes the directory before any prompt. That placeholder is
 * not a catalog thread; the row appears when a user turn or generated title
 * lands. Subagent children also live in the normal sessions tree — skip them
 * via `session_kind` or the parent's `subagents/<id>/meta.json`, the same
 * way Codex skips `thread_source=subagent` and Cursor skips `subagentInfo`.
 * Forks only carry `parent_session_id` and stay visible.
 */

import { homedir } from "node:os"
import { z } from "zod"
import { basename, dirname, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { readdir, readFile, stat, rm } from "node:fs/promises"
import { titleFrom, type DecodedBlock, type Thread, type DecodedEntry, type NativeRecordSample, type ThreadRef, type ThreadTail, type TurnUsage, type UnreadRecord } from "../format.js"
import {
  createJsonlFollower,
  decodeFrom,
  decodeRecord,
  lineRecord,
  readLines,
  type LinePlace,
  unparsedLine,
  type RecordTranslator,
  type FollowStart,
  type ResumePoint,
} from "../jsonl.js"
import { normalizeToolOutput } from "../tool-output.js"
import type { NativeFile, SessionProvider } from "./types.js"
import { filesUnder, type RecordRoot, type SessionRecords } from "../harness-records.js"
import type { ChildTranscript } from "../children.js"
import { GrokChildren } from "./grok-children.js"
import { TurnUsageSchema, type Entry } from "../entries.js"
import { EntrySink, type TurnState } from "../entry-sink.js"
import { grokFork } from "./grok-fork.js"

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/
const UPDATE_METHODS = new Set(["session/update", "_x.ai/session/update"])
const TRANSCRIPT_UPDATES = "updates.jsonl"
const TRANSCRIPT_LEGACY = "chat_history.jsonl"
const TRANSCRIPT_NAMES = new Set([TRANSCRIPT_UPDATES, TRANSCRIPT_LEGACY])

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue
}

interface GrokSummary {
  id: string
  cwd?: string
  title?: string
  createdAt?: string
  model?: string
  effort?: string
  sessionKind?: string
  hidden?: boolean
  parentSessionId?: string
}

/**
 * One line of `updates.jsonl` as the locator reads it. Grok saves the wire:
 * ACP's own `session/update` notifications, which go to the shared decoder
 * as the live client's do, and its `_x.ai/session/update` lines. Those carry
 * what the live client learns another way: the end of a turn (its prompt's
 * answer), rewinds, and Grok's markers, which both read through
 * `grokUpdateMarker`.
 */
type SavedLine =
  | {
      kind: "user"
      at?: string
      text: string
      attachments: AttachmentContent[]
      /** The chunk's `_meta.promptIndex`: Grok's number for the prompt it belongs to. */
      promptIndex?: number
      /** A turn Grok started itself (`_meta.hostTurn`), which a rewind does not count. */
      hostTurn: boolean
      /** A message steered into the running turn (`_meta.interjection`), which carries no `promptIndex`. */
      steered: boolean
    }
  | { kind: "update"; at?: string; notification: SessionNotification }
  /** A background task settled; the reminder of the turn Grok runs on it names it, and this holds its output. */
  | { kind: "task"; task: GrokTaskSnapshot & { task_id: string }; sessionId?: string }
  /** A call left a watch running as a background task (`task_backgrounded` with `monitor_description`). */
  | { kind: "watch"; call: string; task: string }
  /** A line Mako has no meaning for: an update kind it doesn't know, or a known one it couldn't read. */
  | { kind: "unread"; type: string; reason: UnreadRecord["reason"]; raw: NativeRecordSample }
  /** A subagent finished while the session was idle and will wake it (`grokWakingChild`); `ms` is when. */
  | { kind: "woke"; child: string; ms?: number }
  | {
      kind: "turn-end"
      at?: string
      /** When it ended, in epoch ms, as `grokLineMillis` reads a line. */
      ms?: number
      stopReason?: string
      /** What Grok said ended the turn: the error's words on an `error` or `rate_limit` stop. */
      result?: string
      usage?: TurnUsage
      /** The notification's `_meta`, which says why Grok cancelled or ended the turn itself. */
      meta?: JsonObject
      source?: TranscriptEvent["source"]
    }
  /** `rewind_marker`: the conversation goes back to before its `target`-th counted turn. */
  | { kind: "rewind"; at?: string; target: number }
  | { kind: "marker"; at?: string; marker: TranscriptEvent }

/**
 * Grok's own updates that are transcript facts. Saved history and the live
 * connection (packages/host/src/harnesses/grok/notifications.ts) both read them here,
 * so a marker says the same thing in both.
 */
/** What a Grok error kind (`SamplingErrorKind`, xai-grok-sampler, or a shell error type) says to the person. */
export function grokErrorLabel(kind: string | undefined): string | undefined {
  switch (kind) {
    case undefined:
      return undefined
    case "rate_limited":
      return "Rate limited"
    case "auth":
      return "Not signed in"
    case "http":
      return "Network error"
    case "api":
      return "Server error"
    case "idle_timeout":
      return "The model stopped responding"
    case "empty_response":
      return "The model sent nothing"
    case "max_tokens_truncation":
      return "The reply was cut off"
    case "doom_loop_detected":
      return "The model was repeating itself"
    case "context_length":
      return "The conversation is too long"
    case "disk_full":
      return "Out of disk space"
    default:
      return plainWords(kind)
  }
}

export function grokUpdateMarker(kind: string | undefined, update: JsonObject): TranscriptEvent | undefined {
  switch (kind) {
    case "auto_compact_completed":
      return compactionEvent({
        trigger: "automatic",
        tokensBefore: numberValue(update["tokens_before"]),
        tokensAfter: numberValue(update["tokens_after"]),
        durationMs: numberValue(update["elapsed_ms"]),
        summary: stringValue(update["summary_preview"]),
      })
    case "auto_compact_failed":
      return compactionFailedEvent(reasonOf(update))
    case "model_auto_switched": {
      const reason = stringValue(update["reason"])
      return modelChangedEvent(stringValue(update["previous_model_id"]), stringValue(update["new_model_id"]), reason && plainWords(reason))
    }
    // Grok 1.0.45 ends its retries with `failed`, the banner of the error that ends the turn; `exhausted` is in its schema but sent by nothing.
    case "retry_state":
      switch (stringValue(update["type"])) {
        case "failed": {
          const failed = turnFailedEvent(grokErrorLabel(stringValue(update["error_type"])), stringValue(update["message"]))
          return stringValue(update["error_type"]) === "rate_limited" ? usageLimitEvent(failed) : failed
        }
        case "exhausted":
          return update["is_rate_limited"] === true
            ? usageLimitEvent(turnFailedEvent("Rate limited", stringValue(update["reason"])))
            : turnFailedEvent("Retries exhausted", stringValue(update["reason"]))
        default:
          return undefined
      }
    case "image_dropped": {
      const notes = arrayValue(update["notes"])?.flatMap((note) => stringValue(note) ?? [])
      return { ...event("Warning", "An image was not sent to the model", notes?.join("\n")), tone: "warning" }
    }
    case "hook_annotation": {
      const message = stringValue(update["message"])?.trim()
      if (!message) return undefined
      // Grok writes its pager's warning sign into a blocked prompt's note ("⚠ Prompt blocked by …").
      const warned = message.startsWith("\u26a0")
      const text = warned ? message.slice(1).trim() : message
      return warned || update["kind"] === "tool_outcome" ? { ...event("Hook", text), tone: "warning" } : event("Hook", text)
    }
    case "auto_recovery_started":
      return event("Notice", "Grok is recovering the turn", reasonOf(update))
    case "auto_recovery_exhausted":
      return { ...event("Warning", "Grok could not recover the turn", reasonOf(update)), tone: "warning" }
    default:
      return undefined
  }
}

function reasonOf(update: JsonObject): string | undefined {
  return stringValue(update["reason"]) ?? stringValue(update["error"]) ?? stringValue(update["message"])
}

interface LegacyUserLine {
  type: "user"
  text: string
}

interface LegacyReasoningLine {
  type: "reasoning"
  text: string
}

interface LegacyAssistantCall {
  id?: string
  name: string
  input?: string
}

interface LegacyAssistantLine {
  type: "assistant"
  text: string
  calls: LegacyAssistantCall[]
}

interface LegacyToolResultLine {
  type: "tool_result"
  toolCallId?: string
  output: string
}

type LegacyGrokLine =
  | { type: "unread"; kind: string; raw: JsonObject }
  | LegacyUserLine
  | LegacyReasoningLine
  | LegacyAssistantLine
  | LegacyToolResultLine

type AssistantEntry = Extract<DecodedEntry, { kind: "assistant" }>
type GrokToolBlock = DecodedBlock & { type: "tool" }

type GrokTranslator = RecordTranslator

/** What an `updates.jsonl` translator knew before a turn's prompt line (`TurnPoint.state`). */
const GrokTurnStateSchema = z.object({
  started: z.boolean(),
  /** Counted turns before it, which a rewind's target counts from. */
  counted: z.number().int().nonnegative(),
  marked: z.boolean(),
  inUser: z.boolean(),
  current: z.number().optional(),
  failed: z.boolean(),
  /** Settled tasks by id, oldest first. */
  tasks: z.array(z.tuple([z.string(), GrokTaskSnapshot])),
  /** Watches still running, by task id, each with the call that started it. */
  watches: z.array(z.tuple([z.string(), z.string()])).optional(),
  /** When the last turn ended (epoch ms): a subagent's turns after it are in none of this session's turns. */
  ended: z.number().optional(),
  /** Subagent turns that woke the session, which count in its next turn (`GrokWokenSpend`). */
  woken: z.array(TurnUsageSchema).optional(),
})
type GrokTurnState = z.infer<typeof GrokTurnStateSchema>

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
  return value === true || value === false ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined
}

function arrayValue(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function parseJsonObject(raw: string): JsonObject | null {
  try {
    const parsed: JsonValue = JSON.parse(raw)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function encodedJson(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isString(value)) return value
  return JSON.stringify(value)
}

function isoTimestamp(
  root: JsonObject,
  params: JsonObject
): string | undefined {
  const metadata = objectValue(params["_meta"])
  const agentTimestamp = numberValue(metadata?.["agentTimestampMs"])
  if (agentTimestamp !== undefined) return dateFromMillis(agentTimestamp)

  const timestamp = root["timestamp"]
  if (isString(timestamp)) {
    const millis = Date.parse(timestamp)
    return Number.isNaN(millis) ? undefined : new Date(millis).toISOString()
  }
  const numeric = numberValue(timestamp)
  if (numeric === undefined) return undefined
  return dateFromMillis(numeric > 10_000_000_000 ? numeric : numeric * 1000)
}

function dateFromMillis(millis: number): string | undefined {
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function parseSummary(raw: string): GrokSummary | null {
  const root = parseJsonObject(raw)
  if (!root) return null
  const info = objectValue(root["info"])
  const id = stringValue(info?.["id"])
  if (!id) return null
  return {
    id,
    cwd: stringValue(info?.["cwd"]),
    title:
      stringValue(root["generated_title"]) ||
      stringValue(root["session_summary"]),
    createdAt: stringValue(root["created_at"]),
    model: stringValue(root["current_model_id"]),
    effort: stringValue(root["reasoning_effort"]),
    sessionKind: stringValue(root["session_kind"]),
    hidden: booleanValue(root["hidden"]),
    parentSessionId: stringValue(root["parent_session_id"]),
  }
}

/**
 * Grok's own rule for leaving a session out of its history
 * (`SessionSummary::is_hidden`): an explicit `hidden`, else a `session_kind`
 * of `subagent` or `subagent_fork`. A session from before `session_kind` is
 * a subagent when its parent lists it under `subagents/<child-id>`.
 */
function isHiddenSession(
  summary: GrokSummary,
  transcriptPath: string
): boolean {
  if (summary.hidden !== undefined) return summary.hidden
  if (summary.sessionKind) return summary.sessionKind.startsWith("subagent")
  const parentId = summary.parentSessionId
  if (!parentId || parentId === summary.id) return false
  const parentDir = join(dirname(dirname(transcriptPath)), parentId)
  return (
    existsSync(join(parentDir, "subagents", summary.id, "meta.json")) ||
    existsSync(join(parentDir, "subagents", `${summary.id}.json`))
  )
}

function parseUsage(value: JsonValue | undefined): TurnUsage | undefined {
  const usage = GrokTurnUsage.safeParse(value).data
  return usage && turnUsage(usage)
}

function turnUsage(usage: GrokTurnUsage): TurnUsage {
  const { input, output, cacheRead, cacheWrite } = grokTokens(usage)
  const parsed: TurnUsage = { input, output, cacheRead, cacheWrite }
  const cost = grokCost(usage)
  if (cost !== undefined) parsed.costUsd = cost
  return parsed
}

/** A saved line as its kind, or null for one read on purpose to draw nothing. */
function parseSavedLine(raw: string, place?: LinePlace): SavedLine | null {
  const root = parseJsonObject(raw)
  if (!root) {
    const sample = unparsedLine(raw, place)
    return sample === undefined ? null : { kind: "unread", type: "line", reason: "unreadable", raw: sample }
  }
  const method = stringValue(root["method"])
  if (!method || !UPDATE_METHODS.has(method)) return { kind: "unread", type: method ?? "(no method)", reason: "unknown", raw: root }
  const params = objectValue(root["params"])
  const update = objectValue(params?.["update"])
  if (!params || !update) return { kind: "unread", type: method, reason: "unreadable", raw: root }
  const sessionUpdate = stringValue(update["sessionUpdate"])
  const at = isoTimestamp(root, params)
  // The id Grok gave the notification live, which a marker drawn from it cites there too.
  const eventId = stringValue(objectValue(params["_meta"])?.["eventId"])
  const source = eventId ? { harness: "grok", record: eventId } : undefined

  switch (sessionUpdate) {
    case "user_message_chunk": {
      // Grok marks the chunk itself, not the notification (xai-grok-shell `session/storage`):
      // `promptIndex`, `hostTurn`, and `interjection` with what the person typed in `displayText`.
      const chunk = objectValue(update["_meta"])
      const content = objectValue(update["content"])
      const steered = chunk?.["interjection"] === true ? stringValue(objectValue(content?.["_meta"])?.["displayText"]) : undefined
      return {
        kind: "user",
        at,
        text: steered ?? acpText(update["content"]),
        attachments: acpAttachments(update["content"]),
        promptIndex: numberValue(chunk?.["promptIndex"]),
        hostTurn: chunk?.["hostTurn"] === true,
        steered: steered !== undefined,
      }
    }
    case "turn_completed":
      return {
        kind: "turn-end",
        at,
        ms: grokLineMillis(root),
        stopReason: stringValue(update["stop_reason"]),
        result: stringValue(update["agent_result"]),
        usage: parseUsage(update["usage"]),
        meta: objectValue(params["_meta"]),
        source,
      }
    case "task_completed": {
      const task = GrokTaskSnapshot.safeParse(update["task_snapshot"]).data
      return task?.task_id ? { kind: "task", task: { ...task, task_id: task.task_id }, sessionId: stringValue(params["sessionId"]) } : null
    }
    case "task_backgrounded": {
      const call = stringValue(update["tool_call_id"])
      const task = stringValue(update["task_id"])
      return call && task && update["monitor_description"] !== undefined ? { kind: "watch", call, task } : null
    }
    case "rewind_marker": {
      const target = numberValue(update["target_prompt_index"])
      return method === "_x.ai/session/update" && target !== undefined ? { kind: "rewind", at, target } : null
    }
    case "subagent_finished": {
      const child = grokWakingChild(update)
      if (child) return { kind: "woke", child, ms: grokLineMillis(root) }
      break
    }
  }
  const saved = method === "session/update" ? SavedAcpNotificationSchema.safeParse(params).data : undefined
  const notification = saved && acpSavedNotification(saved)
  if (notification) return { kind: "update", at, notification }
  const marker = grokUpdateMarker(sessionUpdate, update)
  if (marker) return { kind: "marker", at, marker: source ? { ...marker, source } : marker }
  if (!sessionUpdate) return { kind: "unread", type: method, reason: "unreadable", raw: root }
  if (grokUpdateReading(sessionUpdate)) return null
  const reason = method === "session/update" ? acpSavedRefusal(sessionUpdate) : "unknown"
  return reason ? { kind: "unread", type: `${method}/${sessionUpdate}`, reason, raw: root } : null
}

function parseLegacyCalls(value: JsonValue | undefined): LegacyAssistantCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const call = objectValue(item)
    if (!call) return []
    return [
      {
        id: stringValue(call["id"]),
        name: stringValue(call["name"]) ?? "tool",
        input: encodedJson(call["arguments"]),
      },
    ]
  })
}

function parseLegacyLine(raw: string): LegacyGrokLine | null {
  const root = parseJsonObject(raw)
  if (!root) return null
  switch (stringValue(root["type"])) {
    case "user":
      return { type: "user", text: acpText(root["content"]) }
    case "reasoning":
      return { type: "reasoning", text: acpText(root["summary"]) }
    case "assistant":
      return {
        type: "assistant",
        text: acpText(root["content"]),
        calls: parseLegacyCalls(root["tool_calls"]),
      }
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: stringValue(root["tool_call_id"]),
        output: normalizeToolOutput(acpText(root["content"])),
      }
    default:
      return { type: "unread", kind: stringValue(root["type"]) ?? "(no type)", raw: root }
  }
}

/** Grok's own folder: `GROK_HOME`, else `~/.grok`. Its sessions, sign-in, skills and model cache live there. */
export function grokHome(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.GROK_HOME || join(home, ".grok")
}

/**
 * The working directory a folder under Grok's `sessions` stands for. Grok
 * names it by the URL-encoded path, or, past 255 bytes, by a `slug-hash`
 * with the path in `.cwd` (`decode_cwd_from_dirname`, xai-grok-config).
 */
export function grokWorkspaceCwd(folder: string): string | undefined {
  try {
    const decoded = decodeURIComponent(basename(folder))
    if (decoded.startsWith("/")) return decoded
  } catch {
    // A slug-hash name is not URL-encoded; its path is in `.cwd`.
  }
  try {
    return readFileSync(join(folder, ".cwd"), "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

export class GrokProvider implements SessionProvider {
  /** Its records state no version: what its harness leaves beside them says (`record-evidence.ts`). */
  writerEvidence(path: string, reader: WriterEvidenceLookups): Promise<WriterEvidence | null> {
    return reader.grokSession(path)
  }

  harness = "grok" as const
  displayName = "Grok"
  /** How a session is written again as its own fork (`grok-fork.ts`). */
  readonly fork = grokFork
  private root: string
  private readonly childLinks: GrokChildren

  /**
   * `env` is the environment Grok runs with. The process's own is read only
   * for the default home: a provider built on another home is an isolated
   * world (a fixture, a mirror).
   */
  constructor(home?: string, env: NodeJS.ProcessEnv = home === undefined ? process.env : {}) {
    this.root = join(grokHome(env, home), "sessions")
    this.childLinks = new GrokChildren(this.root)
  }

  roots(): string[] {
    return [this.root]
  }

  async discover(): Promise<NativeFile[]> {
    const files: NativeFile[] = []
    let workspaces: string[]
    try {
      workspaces = await readdir(this.root)
    } catch {
      return []
    }
    await Promise.all(
      workspaces.map(async (workspace) => {
        let sessions: string[]
        const workspacePath = join(this.root, workspace)
        try {
          sessions = await readdir(workspacePath)
        } catch {
          return
        }
        await Promise.all(
          sessions.map(async (session) => {
            const sessionPath = join(workspacePath, session)
            const updatesPath = join(sessionPath, TRANSCRIPT_UPDATES)
            const updatesInfo = await stat(updatesPath).catch(() => null)
            const summaryInfo = await stat(
              join(sessionPath, "summary.json")
            ).catch(() => null)
            const revision = summaryInfo
              ? String(summaryInfo.mtimeMs)
              : undefined
            if (updatesInfo) {
              files.push({
                path: updatesPath,
                bytes: updatesInfo.size,
                mtimeMs: updatesInfo.mtimeMs,
                revision,
              })
              return
            }
            const legacyPath = join(sessionPath, TRANSCRIPT_LEGACY)
            const legacyInfo = await stat(legacyPath).catch(() => null)
            if (legacyInfo) {
              files.push({
                path: legacyPath,
                bytes: legacyInfo.size,
                mtimeMs: legacyInfo.mtimeMs,
                revision,
              })
            }
          })
        )
      })
    )
    return files
  }

  /** The session's folder, every file in it: the transcripts and what Grok keeps beside them. */
  /** `grok`: Grok's home, the folder its sessions are under. */
  recordRoots(): RecordRoot[] {
    return [{ name: "grok", path: dirname(this.root) }]
  }

  async records(path: string): Promise<SessionRecords | null> {
    const directory = dirname(path)
    if (dirname(dirname(directory)) !== this.root || !(await stat(path).catch(() => null))?.isFile()) return null
    // Its subagents' sessions sit elsewhere in the tree and are never rows: they come with it.
    // Grok's records state no version of the CLI that wrote them (`summary.json` has only its chat format's): what wrote them is the CLI installed as a write lands.
    const subagents = await this.childLinks.recordsOf(path)
    return { roots: this.recordRoots(), files: [...await filesUnder(directory), ...subagents.files], databases: [], writer: { installed: true }, children: subagents.children }
  }

  /** Its subagents, from `subagents/` beside it and its own updates. */
  async children(path: string): Promise<ChildTranscript[] | null> {
    if (!TRANSCRIPT_NAMES.has(basename(path))) return null
    return this.childLinks.list(path)
  }

  /** Remove a session directory (`<root>/<workspace>/<session>/`). */
  async remove(path: string): Promise<boolean> {
    const directory = dirname(path)
    if (dirname(dirname(directory)) !== this.root) return false
    await rm(directory, { recursive: true, force: true })
    return true
  }

  /**
   * Sidecar writes belong to the native transcript, never to a second row.
   * `summary.json` next to `updates.jsonl` is a title store, not a session.
   */
  watchTarget(path: string): string | null {
    const name = basename(path)
    if (name === TRANSCRIPT_UPDATES) return path
    if (name === TRANSCRIPT_LEGACY) {
      const updates = join(dirname(path), TRANSCRIPT_UPDATES)
      return existsSync(updates) ? updates : path
    }
    const sessionDir = this.sessionDirectory(path)
    if (!sessionDir) return null
    return this.transcriptPath(sessionDir)
  }

  observationPaths(path: string): string[] {
    return [path, join(dirname(path), "summary.json")]
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const name = basename(file.path)
    if (name !== TRANSCRIPT_UPDATES && name !== TRANSCRIPT_LEGACY) return null
    if (name === TRANSCRIPT_LEGACY) {
      const updates = await stat(
        join(dirname(file.path), TRANSCRIPT_UPDATES)
      ).catch(() => null)
      if (updates) return null
    }
    const raw = await readFile(
      join(dirname(file.path), "summary.json"),
      "utf8"
    ).catch(() => null)
    if (!raw) return null
    const summary = parseSummary(raw)
    if (!summary) return null
    if (isHiddenSession(summary, file.path)) return null
    let title = titleFrom(summary.title)
    let sawUser = false
    if (!title) {
      const into = createTranslator(file.path)()
      let spent = 0
      await readLines(file.path, 0, (line) => {
        spent += line.length + 1
        into.push(line)
        return spent < 8 * 1024 * 1024
      })
      for (const entry of into.done()) {
        if (entry.type !== "user") continue
        sawUser = true
        title = titleFrom(entry.text)
        if (title) break
      }
    }
    // A directory written at session/new, with only hooks or a skills
    // reminder, is not a conversation yet. The row appears when the first
    // user turn or generated title lands.
    if (!title && !sawUser) return null
    const ref: ThreadRef = {
      harness: this.harness,
      nativeId: summary.id,
      path: file.path,
      cwd: summary.cwd,
      title,
      model: summary.model,
      settings: {
        model: summary.model,
        options: summary.effort ? { effort: summary.effort } : {},
      },
      startedAt: summary.createdAt,
      // The transcript moves only when the conversation does. summary.json's
      // `updated_at` is rewritten every minute by an open TUI and by title
      // generation, which once kept a day-old thread at the top of the rail.
      updatedAt: new Date(file.mtimeMs).toISOString(),
      bytes: file.bytes,
    }
    if (summary.parentSessionId && summary.parentSessionId !== summary.id) ref.parentNativeId = summary.parentSessionId
    return ref
  }

  /**
   * Grok names the thread in `summary.json` while the transcript keeps
   * growing. Re-read that sidecar without walking the jsonl again.
   */
  async refine(ref: ThreadRef, _fromByte: number): Promise<ThreadRef> {
    const raw = await readFile(
      join(dirname(ref.path), "summary.json"),
      "utf8"
    ).catch(() => null)
    if (!raw) return ref
    const summary = parseSummary(raw)
    if (!summary) return ref
    return {
      ...ref,
      cwd: summary.cwd ?? ref.cwd,
      title: titleFrom(summary.title) ?? ref.title,
      model: summary.model ?? ref.model,
      settings: {
        model: summary.model ?? ref.settings?.model,
        options: summary.effort
          ? { effort: summary.effort }
          : (ref.settings?.options ?? {}),
      },
    }
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const ref =
      (await this.peek({
        path,
        bytes: file.size,
        mtimeMs: file.mtimeMs,
      })) ?? (await this.childLinks.ref(path, file.size, file.mtimeMs))
    if (!ref) return null
    const decode = await decodeRecord([{ path }], createTranslator(path)())
    const thread: Thread = { ref, checkpoint: decode.checkpoint, entries: decode.entries }
    if (decode.unread) thread.unread = decode.unread
    if (decode.resume) thread.resume = decode.resume
    return thread
  }

  async readFrom(path: string, from: ResumePoint, after: string | undefined): Promise<ThreadTail | null> {
    if (basename(path) !== TRANSCRIPT_UPDATES) return null
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const ref = (await this.peek({ path, bytes: file.size, mtimeMs: file.mtimeMs })) ?? (await this.childLinks.ref(path, file.size, file.mtimeMs))
    const decode = ref && (await decodeFrom(path, from, updatesTranslator(after, from.state, childTurnsBeside(path))))
    return decode && { ref, ...decode }
  }

  createFollower(path: string, fromByte: number, start?: FollowStart) {
    if (basename(path) !== TRANSCRIPT_UPDATES) return createJsonlFollower(path, fromByte, legacyTranslator)
    return createJsonlFollower(path, fromByte, (after, state) => updatesTranslator(after, state, childTurnsBeside(path)), undefined, start)
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: Entry[]; nextByte: number }> {
    const into = createTranslator(path)()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }

  private sessionDirectory(path: string): string | null {
    const prefix = `${this.root}/`
    if (path === this.root || !path.startsWith(prefix)) return null
    const parts = path.slice(prefix.length).split("/")
    if (
      parts.length < 3 ||
      parts.some((part) => part === "" || part === "." || part === "..")
    )
      return null
    return join(this.root, parts[0]!, parts[1]!)
  }

  private transcriptPath(sessionDir: string): string | null {
    const updates = join(sessionDir, TRANSCRIPT_UPDATES)
    if (existsSync(updates)) return updates
    const history = join(sessionDir, TRANSCRIPT_LEGACY)
    return existsSync(history) ? history : null
  }
}

function createTranslator(path: string): () => GrokTranslator {
  return basename(path) === TRANSCRIPT_UPDATES
    ? () => updatesTranslator(undefined, undefined, childTurnsBeside(path))
    : legacyTranslator
}

/** A subagent's turns that ended after `after` and by `until` (epoch ms), from its own session. */
type ChildTurns = (child: string, after: number | undefined, until: number | undefined) => TurnUsage[]

/** The turns of a subagent of the session whose transcript is `path`: a session of its own beside it. */
function childTurnsBeside(path: string): ChildTurns {
  return (child, after, until) => {
    // The id is the store's own data; it names a folder beside the session's and nothing else.
    if (!/^[\w-]+$/.test(child)) return []
    let text: string
    try {
      text = readFileSync(join(dirname(dirname(path)), child, TRANSCRIPT_UPDATES), "utf8")
    } catch {
      return []
    }
    return grokTurnsBetween(text, child, after, until).map((turn) => turnUsage(turn.usage))
  }
}

/** A turn's own spend with the subagent turns that woke it, field by field. */
function withWoken(usage: TurnUsage | undefined, woken: readonly TurnUsage[]): TurnUsage | undefined {
  if (!woken.length) return usage
  const total: TurnUsage = {}
  for (const part of [usage, ...woken])
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const) {
      const value = part?.[key]
      if (value !== undefined) total[key] = (total[key] ?? 0) + value
    }
  return total
}

/**
 * How a turn's end shows, as Grok's own viewer draws it (`terminal_marker`,
 * xai-grok-pager `turn_completion`): `cancelled` is the person's stop,
 * `interrupted` a turn lost with Grok's process and `error` or `rate_limit`
 * a failed request, each with Grok's words in `agent_result`. Every other
 * reason finished the turn.
 */
/**
 * Why Grok ended a turn by its own rule, from the `_meta` of its
 * `turn_completed` (`PromptCompletionKind`, xai-grok-shell 1.0.45
 * `session/commands.rs`); the `session/prompt` response and
 * `_x.ai/session/prompt_complete` carry the same fields. Live and saved
 * history both read it here. `null` is an end Grok's own `hook_annotation`
 * already explains ("Prompt blocked by …"); `undefined` is a turn Grok gives
 * no rule for, which its stop reason describes.
 */
export function grokTurnCause(meta: JsonObject | undefined): TranscriptEvent | null | undefined {
  switch (stringValue(meta?.["cancellationCategory"])) {
    case "HookDenied":
      return null
    case "PermissionRejected":
      return event(TURN_ENDED, "A permission was denied")
    case "PermissionCancelled":
      return event(TURN_ENDED, "The permission request was dismissed")
    case "max_turns_reached":
      return { ...event(TURN_ENDED, "Reached the turn limit"), tone: "warning" }
    // Grok's quiet end of a turn whose actions changed nothing, round after round.
    case "action_stationarity":
      return { ...event(TURN_ENDED, "Grok stopped making progress"), tone: "warning" }
    default:
      return undefined
  }
}

/** What stopped a cancelled turn, when it was not the person (`cancelTrigger`, the same `_meta`). */
function cancelledBy(trigger: string | undefined): string | undefined {
  switch (trigger) {
    case "session_close":
    case "session_delete":
      return "The session closed"
    case "shutdown":
      return "Grok shut down"
    default:
      return undefined
  }
}

export function grokTurnEnd(stopReason: string | undefined, result: string | undefined, meta?: JsonObject): TranscriptEvent | undefined {
  const cause = grokTurnCause(meta)
  if (cause !== undefined) return cause ?? undefined
  switch (stopReason) {
    case "cancelled":
      return event(INTERRUPTED, cancelledBy(stringValue(meta?.["cancelTrigger"])))
    case "interrupted":
      return turnFailedEvent(undefined, result ?? "Grok stopped before the turn finished.")
    case "rate_limit":
      return usageLimitEvent(turnFailedEvent("Rate limited", result === "Rate limited" ? undefined : result))
    case "error":
      return turnFailedEvent(undefined, result)
    default:
      return undefined
  }
}

/**
 * Grok's count of the turns a rewind addresses, as its own replay counts them
 * (`UserRunTurnTracker`, xai-grok-shell `session/storage`): a run of user
 * chunks is one turn and a new `promptIndex` starts the next; once any chunk
 * carries a `promptIndex`, only chunks with one count. A turn Grok started
 * itself, and any other line, ends a run.
 */
interface GrokRun {
  /** The chunk starts a run of user chunks. */
  opens: boolean
  /** That run is one of the turns a rewind counts. */
  counts: boolean
}

class GrokTurnCount {
  private marked = false
  private inUser = false
  private current: number | undefined

  constructor(state?: Pick<GrokTurnState, "marked" | "inUser" | "current">) {
    if (!state) return
    this.marked = state.marked
    this.inUser = state.inUser
    this.current = state.current
  }

  /** What a counter begun here would need. */
  get state(): Pick<GrokTurnState, "marked" | "inUser" | "current"> {
    return { marked: this.marked, inUser: this.inUser, ...this.current !== undefined && { current: this.current } }
  }

  /** Whether this chunk starts a run, and whether that run is a counted turn. */
  user(promptIndex: number | undefined): GrokRun {
    if (promptIndex !== undefined) this.marked = true
    const opens = !this.inUser || ((this.marked || promptIndex !== undefined) && promptIndex !== this.current)
    if (opens) this.current = promptIndex
    this.inUser = true
    return { opens, counts: opens && (!this.marked || promptIndex !== undefined) }
  }

  other(): void {
    this.inUser = false
    this.current = undefined
  }
}

/**
 * `updates.jsonl` read as a locator (`AcpSavedTurns` with `GROK_ACP_HOOKS`).
 * Grok marks the rest itself: the person's prompts and the messages they
 * steered in, the end of each turn, its markers, and rewinds.
 */
function updatesTranslator(after?: string, state?: TurnState, childTurns?: ChildTurns): GrokTranslator {
  const carried = state === undefined ? undefined : GrokTurnStateSchema.safeParse(state).data
  const turns = new AcpSavedTurns(GROK_ACP_HOOKS, after, carried?.started)
  const count = new GrokTurnCount(carried)
  /** The entry each counted turn begins with, so a rewind cuts where Grok's replay does. */
  const counted: DecodedEntry[] = []
  /** Counted turns before this translator began, which only a read from the start holds. */
  const earlier = carried?.counted ?? 0
  /** The id of the open turn's prompt, which a steered message names. */
  let prompt: string | undefined
  /** The open turn is one a rewind counts. */
  let counts = false
  /** The turn already showed its failure, as Grok's retry banner does, so its end adds none. */
  let failed = carried?.failed ?? false
  /** Settled tasks by id, for the reminder that opens the turn on one; the newest few are enough. */
  const tasks = new Map<string, GrokTaskSnapshot>(carried?.tasks)
  /**
   * Watches by task id, each with the call that started it. Grok 1.0.70 streams a watch's output into its call as it
   * runs and keeps none of that in `updates.jsonl`, only the task's snapshot when it ends; the snapshot's output is
   * given to the call as the stream's last update gave it.
   */
  const watches = new Map<string, string>(carried?.watches)
  /** When the last turn ended, and the subagent turns that woke the session since. */
  let lastEnded = carried?.ended
  const woken = new GrokWokenSpend<TurnUsage>(carried?.woken)
  /** A line reached back before where this translator began. */
  let reachedBack = state !== undefined && !carried
  /** What the line being read found, for a turn it begins. */
  let before: GrokTurnState | undefined

  const commit = (usage?: TurnUsage): void => {
    const first = turns.commit(usage)
    if (counts && first) counted.push(first)
    counts = false
    prompt = undefined
  }

  /** Grok 1.0.46 saves a /compact the person typed as its own turn, after the compaction it ran. */
  const relabelCompaction = (): void => {
    if (turns.replaceLast((block): block is Extract<Entry, { type: "event" }> => block.type === "event" && block.label === CONTEXT_COMPACTED, manualCompaction)) return
    const entries = turns.sink.entries
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!
      if (entry.kind !== "event" || entry.label !== CONTEXT_COMPACTED) continue
      turns.sink.replace(index, manualCompaction(entry))
      return
    }
    if (carried) reachedBack = true
  }

  const push = (raw: string, place?: LinePlace): void => {
    turns.sink.reading(lineRecord(place))
    before = undefined
    const line = parseSavedLine(raw, place)
    if (line?.kind === "user" && !line.hostTurn)
      before = { started: turns.began, counted: earlier + counted.length, ...count.state, failed, tasks: [...tasks].map(([id, task]) => [id, structuredClone(task)]), watches: [...watches], ended: lastEnded, woken: [...woken.pending] }
    if (line?.kind !== "user" || line.hostTurn) {
      count.other()
      turns.close()
    }
    if (!line) return

    switch (line.kind) {
      case "user": {
        if (line.hostTurn && line.text.trim() === "/compact") return relabelCompaction()
        // A command Grok ran itself (`/goal clear`) is the person's, as Mako sent it.
        if (line.hostTurn && grokHostCommand(line.text)) {
          commit()
          turns.prompted({ at: line.at, text: line.text.trim(), attachments: [] })
          turns.close()
          return
        }
        if (line.hostTurn) {
          commit()
          turns.prompted({ at: line.at, text: "", attachments: [], opener: backgroundReminderTurn(line.text, tasks) ?? UNNAMED_TURN })
          turns.close()
          return
        }
        const opening = count.user(line.promptIndex)
        const run = turns.prompt
        if (run && !opening.opens) {
          turns.gathered(line.text, line.attachments)
          return
        }
        if (!line.text && !line.attachments.length) return
        if (line.steered && prompt) {
          turns.prompted({ at: line.at, steeringFor: prompt, text: line.text, attachments: [...line.attachments] })
          return
        }
        commit()
        if (before) turns.sink.turn({ ...before, counted: earlier + counted.length })
        counts = opening.counts
        prompt = line.promptIndex === undefined ? undefined : `prompt-${line.promptIndex}`
        turns.prompted({
          at: line.at,
          id: prompt,
          text: line.text,
          attachments: [...line.attachments],
          opener: line.attachments.length ? undefined : backgroundReminderTurn(line.text, tasks),
        })
        return
      }
      case "update":
        turns.update(line.notification, line.at)
        return
      case "task": {
        tasks.delete(line.task.task_id)
        tasks.set(line.task.task_id, line.task)
        if (tasks.size > 64) tasks.delete(tasks.keys().next().value!)
        const call = watches.get(line.task.task_id)
        watches.delete(line.task.task_id)
        const output = line.task.output
        if (!call || !output || !line.sessionId) return
        const saved = SavedAcpNotificationSchema.safeParse({ sessionId: line.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: call, content: [{ type: "content", content: { type: "text", text: output } }] } }).data
        const notification = saved && acpSavedNotification(saved)
        if (notification) turns.update(notification, undefined)
        return
      }
      case "watch":
        watches.set(line.task, line.call)
        if (watches.size > 64) watches.delete(watches.keys().next().value!)
        return
      case "unread":
        turns.unread(line.type, line.reason, line.raw)
        return
      case "marker":
        if (line.marker.label === TURN_FAILED) failed = true
        turns.queue({ kind: "event", ...line.marker }, line.at)
        return
      case "turn-end": {
        const ended = failed ? undefined : grokTurnEnd(line.stopReason, line.result, line.meta)
        if (ended) {
          const marker: DecodedEntry = { kind: "event", ...ended }
          if (line.source) marker.source = line.source
          turns.queue(marker, line.at)
        }
        commit(withWoken(line.usage, woken.parentTurn()))
        lastEnded = line.ms ?? lastEnded
        failed = false
        return
      }
      case "woke":
        woken.finished(line.child, true, childTurns?.(line.child, lastEnded, line.ms))
        return
      case "rewind": {
        commit()
        if (line.target < earlier) {
          reachedBack = true
          return
        }
        const start = counted[line.target - earlier]
        // A target past the last turn keeps everything, as Grok's replay does.
        if (!start) return
        counted.length = line.target - earlier
        turns.sink.truncate(Math.max(0, turns.sink.entries.indexOf(start)))
        return
      }
    }
  }

  return {
    push,
    snapshot: () => turns.snapshot(),
    done: () => {
      commit()
      return turns.done()
    },
    unread: () => turns.sink.unreadRecords,
    get needsReset() {
      return turns.needsReset || reachedBack
    },
    get unchanged() {
      return turns.unchanged
    },
    get resume() {
      return turns.sink.resume
    },
  }
}

function legacyTranslator(): GrokTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const toolsById = new Map<string, GrokToolBlock>()
  let started = false
  let needsReset = false

  const flushAssistant = (preserveTools = false): void => {
    assistant = null
    if (!preserveTools) toolsById.clear()
  }

  const ensureAssistant = (): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", blocks: [] }
      sink.push(assistant)
    }
    return assistant
  }

  const appendBlockText = (type: "text" | "thinking", text: string): void => {
    const entry = ensureAssistant()
    const last = entry.blocks.at(-1)
    if (last?.type === type) last.text += text
    else entry.blocks.push({ type, text })
  }

  const push = (raw: string, place?: LinePlace): void => {
    sink.reading(lineRecord(place))
    const line = parseLegacyLine(raw)
    if (!line) {
      const sample = unparsedLine(raw, place)
      if (sample !== undefined) sink.unread("line", "unreadable", sample)
      return
    }

    switch (line.type) {
      case "user": {
        const query = USER_QUERY.exec(line.text)
        const spoken = (query?.[1] ?? "").trim()
        if (!spoken) return
        flushAssistant()
        started = true
        sink.push({ kind: "user", text: spoken })
        return
      }
      case "reasoning":
        if (!started) needsReset = true
        started = true
        if (line.text.trim()) appendBlockText("thinking", line.text)
        return
      case "assistant": {
        if (!started) needsReset = true
        started = true
        if (line.text.trim()) appendBlockText("text", line.text)
        for (const call of line.calls) {
          const block: GrokToolBlock = {
            type: "tool",
            ...call.id && { id: call.id },
            name: call.name,
            input: call.input,
          }
          ensureAssistant().blocks.push(block)
          if (call.id) toolsById.set(call.id, block)
        }
        return
      }
      case "tool_result": {
        const block = line.toolCallId
          ? toolsById.get(line.toolCallId)
          : undefined
        if (block) {
          block.output = line.output
          toolsById.delete(line.toolCallId ?? "")
        } else if (line.toolCallId) {
          needsReset = true
        }
        return
      }
      case "unread":
        sink.unread(line.kind, "unknown", line.raw)
        return
    }
  }

  const snapshot = (): Entry[] => sink.snapshot()

  const done = (): Entry[] => {
    flushAssistant()
    return sink.snapshot()
  }

  return {
    push,
    snapshot,
    done,
    unread: () => sink.unreadRecords,
    get needsReset() {
      return needsReset
    },
  }
}
