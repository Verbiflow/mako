import type { SessionNotification } from "@agentclientprotocol/sdk"
import { AcpSavedTurns, acpSavedNotification, SavedAcpNotificationSchema } from "../acp-saved-turns.js"
import { acpAttachments, acpText } from "../acp-tool-details.js"
import { GROK_ACP_HOOKS, grokCost, grokTokens, GrokTurnUsage } from "../harnesses/grok.js"
import type { AttachmentContent } from "../content.js"
import type { LiveBlock } from "../live-content.js"
import { backgroundCommandLabel, PROVIDER_TURN_FALLBACK, subagentLabel } from "../provider-turn.js"
import { compactionEvent, compactionFailedEvent, CONTEXT_COMPACTED, event, INTERRUPTED, manualCompaction, modelChangedEvent, plainWords, TURN_FAILED, turnFailedEvent, type TranscriptEvent } from "../events.js"
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
import { basename, dirname, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { readdir, readFile, stat, rm } from "node:fs/promises"
import {
  clip,
  titleFrom,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
  type TurnUsage,
} from "../format.js"
import {
  createJsonlFollower,
  readLines,
  type LineTranslator,
} from "../jsonl.js"
import { normalizeToolOutput } from "../tool-output.js"
import type { NativeFile, SessionProvider } from "./types.js"

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/
const UPDATE_METHODS = new Set(["session/update", "_x.ai/session/update"])
const TRANSCRIPT_UPDATES = "updates.jsonl"
const TRANSCRIPT_LEGACY = "chat_history.jsonl"

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
  | {
      kind: "turn-end"
      at?: string
      stopReason?: string
      /** What Grok said ended the turn: the error's words on an `error` or `rate_limit` stop. */
      result?: string
      usage?: TurnUsage
    }
  /** `rewind_marker`: the conversation goes back to before its `target`-th counted turn. */
  | { kind: "rewind"; at?: string; target: number }
  | { kind: "marker"; at?: string; marker: TranscriptEvent }

/**
 * Grok records the start of the turn it runs after a background command as a
 * user chunk it wrote itself, then closes it with `turn_completed` whose
 * prompt id is `task-completed-<task>` (grok 1.0.41):
 *
 *   <system-reminder>
 *   Background task "<id>" completed (exit code: 0).
 *   Description: <description> | Duration: 8.2s
 *   …
 *
 * A background subagent that finishes while Grok is idle wakes it the same
 * way (grok 1.0.44):
 *
 *   <system-reminder>
 *   While you were idle, 1 background subagent completed:
 *   - [general-purpose] "<description>" — completed successfully (32.9s, 2 tool calls)
 *   …
 */
function backgroundReminderLabel(text: string): string | undefined {
  const body = /^\s*<system-reminder>\s*([\s\S]*?)<\/system-reminder>\s*$/.exec(text)?.[1]
  if (!body) return undefined
  const subagents = /^While you were idle, (\d+) background subagents? \w+:/.exec(body)
  if (subagents) return subagentReminderLabel(body, Number(subagents[1]))
  const status = /^Background task "[^"]*" ([^\n(.]+)/.exec(body)?.[1]?.trim()
  if (!status) return undefined
  const exitCode = /exit code:\s*(-?\d+)/.exec(body)?.[1]
  return backgroundCommandLabel({
    description: /^Description:\s*(.*?)(?:\s*\|\s*Duration:.*)?$/m.exec(body)?.[1],
    exitCode: exitCode === undefined ? undefined : Number(exitCode),
    stopped: /kill|stop|cancel/i.test(status),
  })
}

function subagentReminderLabel(body: string, count: number): string {
  if (count !== 1) return `${count} subagents finished`
  const line = /^- \[[^\]]*\] "(.*)" — (\S+)/m.exec(body)
  const status = line?.[2] ?? ""
  return subagentLabel({
    description: line?.[1],
    state: /^complete/i.test(status) ? "completed" : /cancel|stop|kill/i.test(status) ? "cancelled" : /fail|error/i.test(status) ? "failed" : undefined,
  })
}

/**
 * Grok's own updates that are transcript facts. Saved history and the live
 * connection (electron/providers/grok/notifications.ts) both read them here,
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
        case "failed":
          return turnFailedEvent(grokErrorLabel(stringValue(update["error_type"])), stringValue(update["message"]))
        case "exhausted":
          return turnFailedEvent(update["is_rate_limited"] === true ? "Rate limited" : "Retries exhausted", stringValue(update["reason"]))
        default:
          return undefined
      }
    case "image_dropped": {
      const notes = arrayValue(update["notes"])?.flatMap((note) => stringValue(note) ?? [])
      return { ...event("Warning", "An image was not sent to the model", notes?.join("\n")), tone: "warning" }
    }
    case "hook_annotation": {
      const message = stringValue(update["message"])
      if (!message) return undefined
      return update["kind"] === "tool_outcome" ? { ...event("Hook", message), tone: "warning" } : event("Hook", message)
    }
    case "scheduled_task_created":
      return event("Scheduled task", stringValue(update["human_schedule"]), stringValue(update["prompt"]))
    case "scheduled_task_fired":
      return event("Scheduled task ran", stringValue(update["human_schedule"]), stringValue(update["prompt"]))
    case "scheduled_task_deleted": {
      // `shutdown` only clears the task's chip: the task stays on disk and re-arms on resume.
      const reason = stringValue(update["reason"])
      return reason === "completed" || reason === "expired" || reason === "deleted" ? event("Scheduled task removed", plainWords(reason)) : undefined
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
  | LegacyUserLine
  | LegacyReasoningLine
  | LegacyAssistantLine
  | LegacyToolResultLine

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type GrokToolBlock = EntryBlock & { type: "tool" }

interface GrokTranslator extends LineTranslator {
  done(): ThreadEntry[]
}

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
  if (isString(value)) return clip(value)
  return clip(JSON.stringify(value))
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
  if (!usage) return undefined
  const { input, output, cacheRead, cacheWrite } = grokTokens(usage)
  const parsed: TurnUsage = { input, output, cacheRead, cacheWrite }
  const cost = grokCost(usage)
  if (cost !== undefined) parsed.costUsd = cost
  return parsed
}

function parseSavedLine(raw: string): SavedLine | null {
  const root = parseJsonObject(raw)
  if (!root) return null
  const method = stringValue(root["method"])
  if (!method || !UPDATE_METHODS.has(method)) return null
  const params = objectValue(root["params"])
  const update = objectValue(params?.["update"])
  if (!params || !update) return null
  const sessionUpdate = stringValue(update["sessionUpdate"])
  const at = isoTimestamp(root, params)

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
        stopReason: stringValue(update["stop_reason"]),
        result: stringValue(update["agent_result"]),
        usage: parseUsage(update["usage"]),
      }
    case "rewind_marker": {
      const target = numberValue(update["target_prompt_index"])
      return method === "_x.ai/session/update" && target !== undefined ? { kind: "rewind", at, target } : null
    }
  }
  const saved = method === "session/update" ? SavedAcpNotificationSchema.safeParse(params).data : undefined
  const notification = saved && acpSavedNotification(saved)
  if (notification) return { kind: "update", at, notification }
  const marker = grokUpdateMarker(sessionUpdate, update)
  return marker ? { kind: "marker", at, marker } : null
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
      return null
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
  harness = "grok" as const
  displayName = "Grok"
  private root: string

  /**
   * `env` is the environment Grok runs with. The process's own is read only
   * for the default home: a provider built on another home is an isolated
   * world (a fixture, a mirror).
   */
  constructor(home?: string, env: NodeJS.ProcessEnv = home === undefined ? process.env : {}) {
    this.root = join(grokHome(env, home), "sessions")
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
        if (entry.kind !== "user") continue
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
    const ref = await this.peek({
      path,
      bytes: file.size,
      mtimeMs: file.mtimeMs,
    })
    if (!ref) return null
    const into = createTranslator(path)()
    const checkpoint = await readLines(path, 0, into.push)
    return { ref, checkpoint, entries: into.done() }
  }

  createFollower(path: string, fromByte: number) {
    return createJsonlFollower(path, fromByte, createTranslator(path))
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
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
    ? updatesTranslator
    : legacyTranslator
}

/**
 * How a turn's end shows, as Grok's own viewer draws it (`terminal_marker`,
 * xai-grok-pager `turn_completion`): `cancelled` is the person's stop,
 * `interrupted` a turn lost with Grok's process and `error` or `rate_limit`
 * a failed request, each with Grok's words in `agent_result`. Every other
 * reason finished the turn.
 */
export function grokTurnEnd(stopReason: string | undefined, result: string | undefined): TranscriptEvent | undefined {
  switch (stopReason) {
    case "cancelled":
      return event(INTERRUPTED)
    case "interrupted":
      return turnFailedEvent(undefined, result ?? "Grok stopped before the turn finished.")
    case "rate_limit":
      return turnFailedEvent("Rate limited", result === "Rate limited" ? undefined : result)
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
function updatesTranslator(): GrokTranslator {
  const turns = new AcpSavedTurns(GROK_ACP_HOOKS)
  const count = new GrokTurnCount()
  /** The entry each counted turn begins with, so a rewind cuts where Grok's replay does. */
  const counted: ThreadEntry[] = []
  /** The id of the open turn's prompt, which a steered message names. */
  let prompt: string | undefined
  /** The open turn is one a rewind counts. */
  let counts = false
  /** The turn already showed its failure, as Grok's retry banner does, so its end adds none. */
  let failed = false

  const commit = (usage?: TurnUsage): void => {
    const first = turns.commit(usage)
    if (counts && first) counted.push(first)
    counts = false
    prompt = undefined
  }

  /** Grok 1.0.46 saves a /compact the person typed as its own turn, after the compaction it ran. */
  const relabelCompaction = (): void => {
    if (turns.replaceLast((block): block is Extract<LiveBlock, { type: "event" }> => block.type === "event" && block.label === CONTEXT_COMPACTED, manualCompaction)) return
    const entries = turns.sink.entries
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!
      if (entry.kind !== "event" || entry.label !== CONTEXT_COMPACTED) continue
      turns.sink.replace(index, manualCompaction(entry))
      return
    }
  }

  const push = (raw: string): void => {
    const line = parseSavedLine(raw)
    if (line?.kind !== "user" || line.hostTurn) {
      count.other()
      turns.close()
    }
    if (!line) return

    switch (line.kind) {
      case "user": {
        if (line.hostTurn && line.text.trim() === "/compact") return relabelCompaction()
        if (line.hostTurn) {
          commit()
          turns.prompted({ at: line.at, text: "", attachments: [], opener: backgroundReminderLabel(line.text) ?? PROVIDER_TURN_FALLBACK })
          turns.close()
          return
        }
        const opening = count.user(line.promptIndex)
        const run = turns.prompt
        if (run && !opening.opens) {
          run.text += line.text
          run.attachments.push(...line.attachments)
          return
        }
        if (!line.text && !line.attachments.length) return
        if (line.steered && prompt) {
          turns.prompted({ at: line.at, steeringFor: prompt, text: line.text, attachments: [...line.attachments] })
          return
        }
        commit()
        counts = opening.counts
        prompt = line.promptIndex === undefined ? undefined : `prompt-${line.promptIndex}`
        turns.prompted({
          at: line.at,
          id: prompt,
          text: line.text,
          attachments: [...line.attachments],
          opener: line.attachments.length ? undefined : backgroundReminderLabel(line.text),
        })
        return
      }
      case "update":
        turns.update(line.notification, line.at)
        return
      case "marker":
        if (line.marker.label === TURN_FAILED) failed = true
        turns.queue({ kind: "event", ...line.marker }, line.at)
        return
      case "turn-end": {
        const ended = failed ? undefined : grokTurnEnd(line.stopReason, line.result)
        if (ended) turns.queue({ kind: "event", ...ended }, line.at)
        commit(line.usage)
        failed = false
        return
      }
      case "rewind": {
        commit()
        const start = counted[line.target]
        // A target past the last turn keeps everything, as Grok's replay does.
        if (!start) return
        counted.length = line.target
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
    get needsReset() {
      return turns.needsReset
    },
    get unchanged() {
      return turns.unchanged
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
    if (assistant) sink.push(assistant)
    assistant = null
    if (!preserveTools) toolsById.clear()
  }

  const ensureAssistant = (): AssistantEntry => {
    if (!assistant) assistant = { kind: "assistant", blocks: [] }
    return assistant
  }

  const appendBlockText = (type: "text" | "thinking", text: string): void => {
    const entry = ensureAssistant()
    const last = entry.blocks.at(-1)
    if (last?.type === type) last.text += text
    else entry.blocks.push({ type, text })
  }

  const push = (raw: string): void => {
    const line = parseLegacyLine(raw)
    if (!line) return

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
          block.output = clip(line.output)
          toolsById.delete(line.toolCallId ?? "")
        } else if (line.toolCallId) {
          needsReset = true
        }
        return
      }
    }
  }

  const snapshot = (): ThreadEntry[] => {
    const entries = sink.snapshot()
    return assistant ? [...entries, assistant] : entries
  }

  const done = (): ThreadEntry[] => {
    flushAssistant()
    return sink.snapshot()
  }

  return {
    push,
    snapshot,
    done,
    get needsReset() {
      return needsReset
    },
  }
}
