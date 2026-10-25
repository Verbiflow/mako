import { basename } from "node:path"
import { z } from "zod"
import { attachmentFromUrl, proposedPlanBlock, type AttachmentContent, type ToolDetail } from "../content.js"
import { event as marker, type Compaction, type TranscriptEvent } from "../events.js"
import type { NativeRecordSample, UnreadRecord } from "../format.js"
import { codexRecordReading, CodexRolloutUsage, codexTokens } from "../harnesses/codex.js"
import type { HarnessTokens } from "../harnesses/tokens.js"
import { parseLine, unparsedLine, type LinePlace } from "../jsonl.js"
import type { LiveUpdate } from "../live-content.js"
import { codexServiceTier } from "../model-catalog.js"
import { legacyTextAttachment, readPromptAttachments, type PromptAttachmentProjection } from "../prompt-attachments.js"
import { codexGoalTurn } from "../provider-turn.js"
import { CodexReviewOutputSchema, codexReviewEcho, codexReviewReport, type ReviewReport } from "../review.js"
import type { SessionSettings } from "../settings.js"
import type { ToolEffect } from "../tool-effects.js"
import { normalizeToolOutput } from "../tool-output.js"
import { codexPlanDetails } from "../tool-plan.js"
import { codexToolEffects, type CodexCallFacts } from "./codex-effects.js"
import {
  codexAborted,
  codexCellResult,
  CodexCellOutputSchema,
  codexCommand,
  codexCommandOutput,
  codexExecOutput,
  codexFailureEvent,
  CodexFunctionOutputSchema,
  codexGeneratedImage,
  codexGoalPromptStanding,
  codexImageFile,
  codexPatchInput,
  codexPatchText,
  codexPresentation,
  codexPrompt,
  codexPromptImages,
  codexSearchResults,
  codexSearchTarget,
  firstLine,
  isCodexGoalPrompt,
  isCodexReviewAction,
  type CodexPatchChange,
} from "./codex-presentation.js"

/**
 * Codex's rollout records as Mako's live updates: the one decoding of what
 * a Codex thread said and did. Saved history folds what it reads into
 * entries (`CodexProvider`), and a live session reads the same records as
 * Codex appends them during a turn, with the app-server's streamed deltas
 * drawn under the same ids until the record they belong to lands
 * (`packages/host/src/harnesses/codex`).
 *
 * The rollout holds the model-level `response_item` records in every Codex
 * build, and from 0.153 also the typed items (`event_msg/item_completed`)
 * the app-server sends as notifications. The response items are the only
 * complete record: 0.146–0.148 kept almost no command items, and a command
 * Codex's sandbox refused has no item in any build. A call's typed item,
 * where one exists, wins over the raw output, which is what the model read.
 *
 * Pure: it reads records and its own state, never a file, a clock or a
 * process, so the same records always decode the same way.
 *
 * Native store: `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`.
 * Each line is `{timestamp, type, payload}`:
 *
 *   * `session_meta`   — id, cwd, CLI version; always the first line
 *   * `turn_context`   — per-turn model, effort and folder
 *   * `response_item`  — the transcript proper, as OpenAI Responses items:
 *                        message / reasoning / function_call / function_call_output
 *   * `event_msg`      — turn boundaries, `token_count`, `thread_settings_applied`
 *                        (the turn's model, effort and service tier — the only
 *                        record that carries the tier), a failed `task_complete`,
 *                        `turn_aborted`, review-mode boundaries and typed items;
 *                        the rest are echoes of response items
 *   * `compacted`      — a compaction boundary, in every history mode
 *
 * User turns are read from `response_item` messages rather than `user_message`
 * events, because resumed sessions replay history only as response items —
 * but Codex also injects instructions and environment context as user-role
 * messages, so tag-wrapped injections are filtered out.
 */

type JsonScalar = boolean | number | string | null
export type CodexJsonValue = JsonScalar | CodexJsonObject | CodexJsonValue[]
export interface CodexJsonObject {
  [key: string]: CodexJsonValue | undefined
}

/** Tokens one model call spent, and the context it filled. */
export interface CodexCallUsage extends HarnessTokens {
  context: number
}

/**
 * What one record means. `update` is content, as the live transcript draws
 * it; the rest are facts saved history arranges entries by and a live
 * session takes from the app-server instead (turns, usage, settings).
 *
 * - `marker`: a turn's failure or stop, a review mode's start or end.
 * - `compacted`: a compaction boundary, where its record is.
 * - `compaction-named`: what Codex says of that compaction a few records on:
 *   the item that names it, and its estimate of the context after it.
 * - `turn`: Codex started or ended a turn.
 * - `usage`: one model call's tokens.
 * - `settings`: the turn's model and options.
 * - `rolled-back`: Codex dropped this many of the thread's latest turns.
 * - `unread`: a record this decoder can't draw, kept with its kind.
 * - `unplaced`: content whose start the records read so far don't hold, as
 *   when reading began partway through the rollout.
 * - `mark`: a code cell ended here; a call it started that Codex writes only
 *   later is drawn back here (`CodexPlace`).
 */
export type CodexRead =
  | { kind: "update"; update: LiveUpdate; at?: string; place?: CodexPlace }
  | { kind: "mark"; mark: string; at?: string }
  | { kind: "marker"; marker: TranscriptEvent; at?: string }
  | { kind: "compacted"; compaction: Compaction; at?: string }
  | { kind: "compaction-named"; source?: string; tokensAfter?: number }
  | { kind: "turn"; started: boolean; turnId?: string; at?: string; carry?: CodexCarry }
  | { kind: "usage"; usage: CodexCallUsage; at?: string }
  | { kind: "settings"; model?: string; settings: SessionSettings; cwd?: string; at?: string }
  | { kind: "rolled-back"; turns: number }
  | { kind: "unread"; type: string; reason: UnreadRecord["reason"]; record: NativeRecordSample }
  | { kind: "unplaced" }

/**
 * Where a call goes that Codex wrote after the content that followed its
 * start: at `mark`, among the calls placed there in the order they
 * started (`started`, epoch milliseconds), as the app-server drew them.
 */
export interface CodexPlace {
  mark: string
  started: number
}

interface RolloutBase {
  at?: string
  /** `task_started` opens a turn; `task_complete` and `turn_aborted` close it. */
  turn?: "started" | "ended"
  turnId?: string
}

/** A record as the decoder reads it, before its meaning; `parseCodexRecord`. */
export type CodexRolloutEvent = RolloutBase & (
  | { kind: "session_meta"; id: string; cwd?: string; startedAt?: string; threadSource?: string; forkedFrom?: string }
  | { kind: "turn_context"; model?: string; cwd?: string; settings: SessionSettings }
  | { kind: "user_message_event"; text: string }
  | { kind: "token_count_event"; usage?: CodexCallUsage }
  | { kind: "user_response"; id?: string; text: string; attachments?: AttachmentContent[] }
  | { kind: "assistant_response"; id?: string; text: string; attachments?: AttachmentContent[] }
  | { kind: "plumbing_response" }
  | { kind: "reasoning_response"; id?: string; text: string }
  | { kind: "function_call_response"; callId?: string; name: string; input?: string; output?: string; error?: boolean; canceled?: boolean }
  | { kind: "function_output_response"; callId?: string; output: string; attachments?: AttachmentContent[]; cell?: { failed: boolean; output: string }; raw: string }
  | ToolItem
  | { kind: "code_cell"; callId?: string; source?: string }
  | { kind: "event"; event: TranscriptEvent; aborted?: true; review?: "entered" | "exited" }
  | { kind: "compacted"; source: "record" | "event"; summary?: string }
  | { kind: "compaction_item"; id: string }
  | { kind: "ignored"; unread?: { kind: string; reason: UnreadRecord["reason"]; record: CodexJsonObject } }
  | { kind: "rolled_back"; turns: number }
  | { kind: "item_call"; callId: string; name: string; input?: string; output?: string }
  | NestedCall
  | { kind: "generated_image"; attachment: AttachmentContent }
  | { kind: "plan"; id: string; text: string }
  | { kind: "review"; id?: string; report: ReviewReport; echo?: string }
)

/**
 * A call a code cell made that only its typed item records: an MCP tool, a
 * dynamic tool, an agent call or an image view. A call the model made
 * itself has its own response items, which history reads instead.
 */
interface NestedCall {
  kind: "nested_call"
  callId: string
  name: string
  title: string
  input?: string
  output: string
  error: boolean
  attachments?: AttachmentContent[]
}

/** A tool's typed item: what Codex ran and how it ended, over the call's raw arguments and output. */
interface ToolItem {
  kind: "tool_item"
  callId: string
  /** The tool the model would have called for it, which names a call a code cell made. */
  name: "exec_command" | "apply_patch"
  input?: string
  output?: string
  error: boolean
  facts: CodexCallFacts
  /** The turn it ran in (`item_completed`'s `turn_id`). */
  turnId?: string
  /** When it started (`item_completed`'s `started_at_ms`). */
  startedAt?: number
}

function isString(value: CodexJsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isJsonObject(value: CodexJsonValue | undefined): value is CodexJsonObject {
  return value !== undefined && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]"
}

function objectValue(value: CodexJsonValue | undefined): CodexJsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function stringValue(value: CodexJsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

/** Codex's `TurnAbortReason`. A plain Stop is the label alone. */
const ABORT_DETAILS = new Map([
  ["interrupted", undefined],
  ["replaced", "replaced by a newer message"],
  ["review_ended", "review ended"],
  ["budget_limited", "budget limit reached"],
])

function abortDetail(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  return ABORT_DETAILS.has(reason) ? ABORT_DETAILS.get(reason) : reason.replaceAll("_", " ")
}

function textOf(content: CodexJsonValue | undefined, separator = ""): string {
  if (isString(content)) return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const value of content) parts.push(stringValue(objectValue(value)?.["text"]) ?? "")
  return parts.join(separator)
}

function encodedInput(input: CodexJsonValue | undefined): string | undefined {
  if (input === undefined) return undefined
  return isString(input) ? input : JSON.stringify(input)
}

/** A rollout records an MCP call's server as its `namespace` (`mcp__axiom`), beside the tool's own name. */
function functionName(payload: CodexJsonObject): string {
  const name = stringValue(payload["name"])?.trim() || "tool"
  const namespace = stringValue(payload["namespace"])?.trim()
  return namespace?.startsWith("mcp__") ? `${namespace}__${name}` : name
}

/** How a call the record itself ends ended: its output, and whether it failed or was stopped. */
interface CodexToolCompletion {
  output?: string
  error?: boolean
  canceled?: boolean
}

function completedTool(status: string | undefined): CodexToolCompletion {
  const normalized = status?.toLowerCase() ?? ""
  if (["completed", "complete", "done", "success", "succeeded"].includes(normalized)) return { output: "" }
  if (["failed", "failure", "error", "errored"].includes(normalized)) return { output: "", error: true }
  if (["canceled", "cancelled", "interrupted", "aborted"].includes(normalized)) return { output: "", canceled: true }
  return {}
}

function outputText(output: CodexJsonValue | undefined): string {
  const text = isString(output) ? output : (stringValue(objectValue(output)?.["content"]) ?? JSON.stringify(output ?? "") ?? "")
  return normalizeToolOutput(text)
}

function parseTokenUsage(payload: CodexJsonObject): CodexCallUsage | undefined {
  const usage = CodexRolloutUsage.safeParse(objectValue(payload["info"])?.["last_token_usage"]).data
  return usage && { ...codexTokens(usage), context: usage.total ?? 0 }
}

/** Codex's `SUMMARY_PREFIX`, which opens a locally made compaction summary. */
const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process."

function compactionSummary(message: string | undefined): string | undefined {
  const text = message?.trim()
  if (!text) return undefined
  return text.startsWith(SUMMARY_PREFIX) ? text.slice(text.indexOf("\n") + 1).trim() || undefined : text
}

/** A `CodexErrorInfo`: a bare variant name, or one keyed by it with its fields. */
function errorVariant(value: CodexJsonValue | undefined): string | undefined {
  return stringValue(value) ?? Object.keys(objectValue(value) ?? {})[0]
}

function reviewStarted(hint: string | undefined): TranscriptEvent {
  const text = hint?.trim() ?? ""
  const line = firstLine(text)
  return marker("Review mode started", line, text === line ? undefined : text)
}

function reviewEnded(at: string | undefined, id: string | undefined, output: CodexJsonValue | undefined): CodexRolloutEvent {
  const parsed = CodexReviewOutputSchema.safeParse(output)
  if (!parsed.success) return { kind: "event", at, event: marker("Review mode ended"), review: "exited" }
  return { kind: "review", at, id, report: codexReviewReport(parsed.data), echo: codexReviewEcho(parsed.data) }
}

function parseResponseItem(root: CodexJsonObject, payload: CodexJsonObject, at: string | undefined): CodexRolloutEvent {
  switch (stringValue(payload["type"])) {
    case "message": {
      switch (stringValue(payload["role"])) {
        case "user": {
          const prompt = userResponse(payload["content"])
          return { kind: "user_response", id: stringValue(payload["id"]), at, text: prompt.text, attachments: prompt.attachments }
        }
        case "assistant":
          return { kind: "assistant_response", id: stringValue(payload["id"]), at, text: textOf(payload["content"]), attachments: responseAttachments(payload["content"]) }
        case "developer":
        case "system":
          return { kind: "plumbing_response", at }
        default:
          return { kind: "ignored", at, unread: { kind: `response_item message ${stringValue(payload["role"]) ?? "(no role)"}`, reason: "unknown", record: root } }
      }
    }
    case "reasoning":
      // Codex joins summary parts with a blank line, as the app-server streams them.
      return { kind: "reasoning_response", id: stringValue(payload["id"]), at, text: textOf(payload["summary"], "\n\n") || textOf(payload["content"]) }
    case "tool_search_call":
      return {
        kind: "function_call_response", at, callId: stringValue(payload["call_id"]) ?? stringValue(payload["id"]),
        name: "ToolSearch", input: encodedInput(payload["arguments"]), ...completedTool(stringValue(payload["status"])),
      }
    case "web_search_call":
      return {
        kind: "function_call_response", at, callId: stringValue(payload["call_id"]) ?? stringValue(payload["id"]),
        name: "web_search", input: encodedInput(payload["action"]), ...completedTool(stringValue(payload["status"])),
      }
    case "local_shell_call": {
      const command = objectValue(payload["action"])?.["command"]
      const text = Array.isArray(command) ? command.flatMap((part) => (isString(part) ? [part] : [])).join(" ") : stringValue(command)
      return { kind: "function_call_response", at, callId: stringValue(payload["call_id"]), name: "exec_command", input: text ? JSON.stringify({ cmd: text }) : undefined }
    }
    case "custom_tool_call":
      if (stringValue(payload["name"]) === "exec") return { kind: "code_cell", at, callId: stringValue(payload["call_id"]), source: stringValue(payload["input"]) }
      return { kind: "function_call_response", at, callId: stringValue(payload["call_id"]), name: functionName(payload), input: stringValue(payload["input"]) }
    case "function_call":
      return { kind: "function_call_response", at, callId: stringValue(payload["call_id"]), name: functionName(payload), input: stringValue(payload["arguments"]) ?? stringValue(payload["input"]) }
    case "function_call_output":
    case "custom_tool_call_output":
    case "tool_search_output":
    case "web_search_output": {
      const raw = isString(payload["output"]) ? payload["output"] : ""
      const response: CodexRolloutEvent = {
        kind: "function_output_response", at, callId: stringValue(payload["call_id"]),
        output: outputText(payload["output"]), attachments: responseAttachments(payload["output"]), raw,
      }
      const texts = payload["type"] === "custom_tool_call_output" ? CodexCellOutputSchema.safeParse(payload["output"]).data : undefined
      if (texts) response.cell = codexCellResult(texts)
      return response
    }
    default:
      return { kind: "ignored", at }
  }
}

/**
 * Each turn writes its settings twice: `thread_settings_applied` carries the
 * service tier, `turn_context` the effort. Both describe one turn, so they
 * fold together; a record naming another model starts over.
 */
export function latestCodexSettings(previous: SessionSettings | undefined, next: SessionSettings): SessionSettings {
  if (!previous || (previous.model && next.model && previous.model !== next.model)) return next
  const options = { ...previous.options, ...next.options }
  const settings: SessionSettings = {}
  const model = next.model ?? previous.model
  if (model) settings.model = model
  if (Object.keys(options).length) settings.options = options
  return settings
}

/** A record history can't draw, by what it is; undefined for one it reads or skips. */
function rolloutUnread(root: CodexJsonObject, type: string, payload: CodexJsonObject | undefined): { kind: string; reason: UnreadRecord["reason"]; record: CodexJsonObject } | undefined {
  const nested = type === "response_item" || type === "event_msg"
  const inner = nested ? stringValue(payload?.["type"]) : undefined
  const completed = inner === "item_completed" ? objectValue(payload?.["item"]) : undefined
  const item = stringValue(completed?.["type"])
  const extension = item === "Extension" ? stringValue(completed?.["kind"]) : undefined
  const kind = () => [type, inner, item, extension].filter((part) => part !== undefined).join(" ")
  if ((nested && inner === undefined) || (inner === "item_completed" && item === undefined) || (item === "Extension" && extension === undefined))
    return { kind: `${kind()} (no type)`, reason: "unreadable", record: root }
  const reading = codexRecordReading(type, inner, item, extension)
  if (reading === undefined) return { kind: kind(), reason: "unknown", record: root }
  return reading === "undrawn" ? { kind: kind(), reason: "undrawn", record: root } : undefined
}

/** `event_msg/item_completed` items, as Codex's core serializes them. */
const FunctionOutputItem = z.object({ id: z.string(), name: z.string().min(1), namespace: z.string().nullish(), output: CodexFunctionOutputSchema })
const WebSearchItem = z.object({ id: z.string(), query: z.string().nullish(), action: z.json().nullish(), results: z.array(z.json()).nullish() })
const ParsedCommand = z.array(z.object({ type: z.string(), path: z.string().nullish() }).loose()).catch([])
const CommandItem = z.object({
  id: z.string(),
  command: z.union([z.array(z.string()), z.string()]),
  status: z.string(),
  aggregated_output: z.string().nullish(),
  // A process stopped before it exited has no exit code: the app-server says null, and since 0.164.0 the rollout -1.
  exit_code: z.number().nullish().transform((code) => code === null || code === undefined || code < 0 ? null : code),
  cwd: z.string().nullish().catch(undefined),
  parsed_cmd: ParsedCommand.nullish(),
})
/** When an item started, in epoch milliseconds (`item_completed`'s `started_at_ms`). */
const StartedAt = z.number().nonnegative()
/** An MCP result's content as the model reads it: its text, and a placeholder for each image or resource. */
const McpResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).catch([]),
  isError: z.boolean().nullish(),
}).loose()
const McpItem = z.object({
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: z.json().nullish(),
  status: z.string(),
  result: McpResult.nullish().catch(undefined),
  error: z.object({ message: z.string() }).loose().nullish(),
})
const DynamicItem = z.object({ id: z.string(), namespace: z.string().nullish(), tool: z.string(), arguments: z.json().nullish(), status: z.string(), content_items: z.json().nullish() })
const AgentState = z.object({ status: z.string(), message: z.string().nullish() }).loose()
const CollabItem = z.object({
  id: z.string(),
  tool: z.string(),
  status: z.string(),
  receiver_thread_ids: z.array(z.string()).catch([]),
  prompt: z.string().nullish(),
  model: z.string().nullish(),
  agents_states: z.record(z.string(), AgentState.nullable()).catch({}),
})
const ImageViewItem = z.object({ id: z.string(), path: z.string() })
const SpawnActivity = z.object({ id: z.string(), kind: z.literal("started"), agent_path: z.string() })
/** The model's name for each agent tool, where the item names it otherwise. */
const AGENT_TOOLS = new Map([["wait", "wait_agent"]])
const RolledBackTurns = z.number().int().nonnegative()
const FileChanges = z.record(z.string(), z.object({
  type: z.enum(["add", "delete", "update"]),
  unified_diff: z.string().nullish(),
  content: z.string().nullish(),
  move_path: z.string().nullish(),
}))
const FileChangeItem = z.object({ id: z.string(), status: z.string(), changes: FileChanges })
const PatchApplyEnd = z.object({ call_id: z.string(), success: z.boolean(), changes: FileChanges })

/** A patch's result as the app-server draws its fileChange item. */
function patchItem(at: string | undefined, callId: string, recorded: z.infer<typeof FileChanges>, error: boolean): ToolItem & RolloutBase {
  const changes: CodexPatchChange[] = Object.entries(recorded).map(([path, change]) => ({
    path, type: change.type, movePath: change.move_path, diff: change.unified_diff ?? change.content ?? "",
  }))
  const input = codexPatchInput(changes.map((change) => change.path))
  return { kind: "tool_item", at, callId, name: "apply_patch", input: input && JSON.stringify(input), output: codexPatchText(changes), error, facts: { changes } }
}

/** One rollout record, read for what it is; null for a line that isn't one. */
export function parseCodexRecord(root: CodexJsonObject): CodexRolloutEvent | null {
  const at = stringValue(root["timestamp"])
  const payload = objectValue(root["payload"])
  const type = stringValue(root["type"])
  if (type === undefined) return null
  const unread = rolloutUnread(root, type, payload)
  if (unread) return { kind: "ignored", at, unread }
  const unreadable = (kind: string): CodexRolloutEvent => ({ kind: "ignored", at, unread: { kind, reason: "unreadable", record: root } })
  switch (type) {
    case "session_meta":
      return {
        kind: "session_meta", at,
        id: String(payload?.["id"] ?? payload?.["session_id"] ?? ""),
        cwd: stringValue(payload?.["cwd"]),
        startedAt: stringValue(payload?.["timestamp"]),
        threadSource: stringValue(payload?.["thread_source"]),
        forkedFrom: stringValue(payload?.["forked_from_id"]),
      }
    case "turn_context": {
      const options: NonNullable<SessionSettings["options"]> = {}
      const effort = stringValue(payload?.["effort"])
      const serviceTier = stringValue(payload?.["service_tier"])
      if (effort) options.effort = effort
      if (serviceTier) options.serviceTier = codexServiceTier(serviceTier)
      return { kind: "turn_context", at, model: stringValue(payload?.["model"]), cwd: stringValue(payload?.["cwd"]), settings: { model: stringValue(payload?.["model"]), options } }
    }
    case "event_msg":
      if (!payload) return unreadable("event_msg")
      return parseEvent(payload, at, unreadable)
    case "compacted":
      return { kind: "compacted", at, source: "record", summary: compactionSummary(stringValue(payload?.["message"])) }
    case "response_item":
      return payload ? parseResponseItem(root, payload, at) : unreadable("response_item")
    default:
      return { kind: "ignored", at }
  }
}

function parseEvent(payload: CodexJsonObject, at: string | undefined, unreadable: (kind: string) => CodexRolloutEvent): CodexRolloutEvent {
  switch (stringValue(payload["type"])) {
    case "thread_settings_applied": {
      // The thread's effective settings, written before each turn's
      // `turn_context`. Codex 0.147+ records the service tier only here.
      const applied = objectValue(payload["thread_settings"])
      const options: NonNullable<SessionSettings["options"]> = {}
      const effort = stringValue(applied?.["reasoning_effort"])
      const serviceTier = stringValue(applied?.["service_tier"])
      if (effort) options.effort = effort
      if (serviceTier) options.serviceTier = codexServiceTier(serviceTier)
      const model = stringValue(applied?.["model"])
      return { kind: "turn_context", at, model, settings: { model, options } }
    }
    case "user_message":
      return { kind: "user_message_event", at, text: String(payload["message"] ?? "") }
    case "token_count":
      return { kind: "token_count_event", at, usage: parseTokenUsage(payload) }
    case "task_started":
    case "turn_started":
      return { kind: "ignored", at, turn: "started", turnId: stringValue(payload["turn_id"]) }
    case "thread_rolled_back": {
      const turns = RolledBackTurns.safeParse(payload["num_turns"])
      return turns.success ? { kind: "rolled_back", at, turns: turns.data } : unreadable("event_msg thread_rolled_back")
    }
    case "turn_aborted": {
      const turn = stringValue(payload["turn_id"])
      const stopped = marker("Interrupted", abortDetail(stringValue(payload["reason"])))
      if (turn) stopped.source = { harness: "codex", record: `${turn}:interrupted` }
      return { kind: "event", at, turn: "ended", turnId: turn, event: stopped, aborted: true }
    }
    case "task_complete":
    case "turn_complete": {
      const error = objectValue(payload["error"])
      const turn = stringValue(payload["turn_id"])
      if (!error) return { kind: "ignored", at, turn: "ended", turnId: turn }
      const failure = codexFailureEvent(errorVariant(error["codex_error_info"]), stringValue(error["message"]))
      if (turn) failure.source = { harness: "codex", record: `${turn}:failed` }
      return { kind: "event", at, turn: "ended", turnId: turn, event: failure }
    }
    case "context_compacted":
      return { kind: "compacted", at, source: "event" }
    case "patch_apply_end": {
      // Legacy rollouts record a patch's result here; paginated ones as a FileChange item.
      const patch = PatchApplyEnd.safeParse(payload).data
      return patch ? patchItem(at, patch.call_id, patch.changes, !patch.success) : unreadable("event_msg patch_apply_end")
    }
    case "entered_review_mode":
      return { kind: "event", at, event: reviewStarted(stringValue(payload["user_facing_hint"])), review: "entered" }
    case "exited_review_mode":
      return reviewEnded(at, stringValue(payload["item_id"]), payload["review_output"])
    case "item_completed":
      return parseItem(payload, at, unreadable)
    default:
      return { kind: "ignored", at }
  }
}

/** Paginated rollouts record every item here; most have a response item that history reads instead. */
function parseItem(payload: CodexJsonObject, at: string | undefined, unreadable: (kind: string) => CodexRolloutEvent): CodexRolloutEvent {
  const item = objectValue(payload["item"])
  switch (stringValue(item?.["type"])) {
    case "EnteredReviewMode": {
      const started = reviewStarted(stringValue(item?.["user_facing_hint"]))
      const id = stringValue(item?.["id"])
      if (id) started.source = { harness: "codex", record: id }
      return { kind: "event", at, event: started, review: "entered" }
    }
    case "ExitedReviewMode":
      return reviewEnded(at, stringValue(item?.["id"]), item?.["review_output"])
    case "CommandExecution": {
      const command = CommandItem.safeParse(item).data
      if (!command) return unreadable("event_msg item_completed CommandExecution")
      const script = codexCommand(command.command)
      const facts: CodexCallFacts = { command: script }
      if (command.cwd) facts.cwd = command.cwd
      if (command.exit_code !== null && command.exit_code !== undefined) facts.exitCode = command.exit_code
      if (command.parsed_cmd?.length) facts.parsed = command.parsed_cmd.map((part) => ({ type: part.type, ...part.path && { path: part.path } }))
      const turnId = stringValue(payload["turn_id"])
      const startedAt = StartedAt.safeParse(payload["started_at_ms"]).data
      return {
        kind: "tool_item", at, callId: command.id, name: "exec_command",
        input: JSON.stringify({ command: script }),
        output: codexCommandOutput(command.aggregated_output, command.exit_code),
        error: command.status !== "completed",
        facts,
        ...turnId && { turnId },
        ...startedAt !== undefined && { startedAt },
      }
    }
    case "FileChange": {
      const patch = FileChangeItem.safeParse(item).data
      return patch ? patchItem(at, patch.id, patch.changes, patch.status !== "completed") : unreadable("event_msg item_completed FileChange")
    }
    case "ContextCompaction": {
      const id = stringValue(item?.["id"])
      return id ? { kind: "compaction_item", at, id } : unreadable("event_msg item_completed ContextCompaction")
    }
    case "Plan": {
      // Every history mode records a plan here; its id matches the app-server's.
      const turn = stringValue(payload["turn_id"])
      const id = stringValue(item?.["id"])
      const text = stringValue(item?.["text"])
      return turn && id && text !== undefined ? { kind: "plan", at, id: `codex:${turn}:${id}`, text } : unreadable("event_msg item_completed Plan")
    }
    case "McpToolCall": {
      const call = McpItem.safeParse(item).data
      if (!call) return unreadable("event_msg item_completed McpToolCall")
      const output = call.error?.message || (call.result?.content ?? []).map((part) => part.type === "text" ? (part.text ?? "") : `[${part.type}]`).join("\n")
      return nestedCall(at, call.id, `mcp__${call.server}__${call.tool}`, `${call.server}: ${call.tool}`, call.arguments, output, call.result?.isError ? "failed" : call.status)
    }
    case "DynamicToolCall": {
      const call = DynamicItem.safeParse(item).data
      if (!call) return unreadable("event_msg item_completed DynamicToolCall")
      const name = call.namespace ? `${call.namespace}.${call.tool}` : call.tool
      return nestedCall(at, call.id, name, name, call.arguments, call.content_items === null || call.content_items === undefined ? "" : prettyJson(call.content_items), call.status)
    }
    case "CollabAgentToolCall": {
      const call = CollabItem.safeParse(item).data
      if (!call) return unreadable("event_msg item_completed CollabAgentToolCall")
      const name = AGENT_TOOLS.get(call.tool) ?? call.tool
      const input = name === "spawn_agent"
        ? { prompt: call.prompt ?? "", model: call.model ?? "", receivers: call.receiver_thread_ids }
        : { receivers: call.receiver_thread_ids }
      const states = Object.values(call.agents_states).flatMap((state) => state ? [state.message ? `${state.status}: ${firstLine(state.message)}` : state.status] : []).join("\n")
      return nestedCall(at, call.id, name, agentCallTitle(name, call.prompt, call.receiver_thread_ids.length), input, states, call.status)
    }
    case "ImageView": {
      const view = ImageViewItem.safeParse(item).data
      if (!view) return unreadable("event_msg item_completed ImageView")
      const image = codexImageFile(view.path)
      return { ...nestedCall(at, view.id, "view_image", `View ${image.name}`, { path: view.path }, "", "completed"), attachments: [image] }
    }
    case "SubAgentActivity": {
      // Multi-agent v2 reports a spawn only as its `started` activity, under the spawn call's id.
      const spawn = SpawnActivity.safeParse(item).data
      if (!spawn) return { kind: "ignored", at }
      return nestedCall(at, spawn.id, "spawn_agent", `Agent ${spawn.agent_path.split("/").at(-1) ?? spawn.agent_path}`, { agent: spawn.agent_path }, "", "completed")
    }
    case "FunctionCallOutput": {
      const output = FunctionOutputItem.safeParse(item).data
      if (!output) return unreadable("event_msg item_completed FunctionCallOutput")
      const name = output.namespace ? `${output.namespace}.${output.name}` : output.name
      return { kind: "item_call", at, callId: output.id, name, output: output.output }
    }
    case "Extension":
      switch (item?.["kind"]) {
        case "web.search": {
          const search = WebSearchItem.safeParse(item).data
          if (!search) return unreadable("event_msg item_completed Extension web.search")
          return {
            kind: "item_call", at, callId: search.id, name: "web_search",
            input: JSON.stringify(search.action ?? { query: search.query }),
            output: codexSearchResults(search.results),
          }
        }
        case "image_gen.generation":
          return { kind: "generated_image", at, attachment: codexGeneratedImage(item) }
        default:
          return { kind: "ignored", at }
      }
    default:
      return { kind: "ignored", at }
  }
}

function nestedCall(at: string | undefined, callId: string, name: string, title: string, input: CodexJsonValue | undefined, output: string, status: string): NestedCall & RolloutBase {
  const call: NestedCall & RolloutBase = { kind: "nested_call", at, callId, name, title, output, error: status !== "completed" }
  if (input !== undefined && input !== null) call.input = prettyJson(input)
  return call
}

function prettyJson(value: CodexJsonValue | z.infer<ReturnType<typeof z.json>>): string {
  return JSON.stringify(value, null, 2) ?? ""
}

/** An agent call's row, as the app-server's collab item reads. */
function agentCallTitle(name: string, prompt: string | null | undefined, receivers: number): string {
  const agents = receivers === 1 ? "agent" : `${receivers} agents`
  switch (name) {
    case "spawn_agent":
      return prompt ? `Agent: ${firstLine(prompt)}` : "Agent"
    case "send_input":
    case "send_message":
      return `Message ${agents}`
    case "followup_task":
      return `Follow up with ${agents}`
    case "interrupt_agent":
      return `Interrupt ${agents}`
    case "list_agents":
      return "List agents"
    case "resume_agent":
      return `Resume ${agents}`
    case "wait_agent":
      return receivers ? `Wait for ${agents}` : "Wait for agents"
    case "close_agent":
      return `Close ${agents}`
    default:
      return name
  }
}

/** One rollout line, read for what it is; null for a line that isn't a record. */
export function parseCodexRolloutLine(raw: string): CodexRolloutEvent | null {
  const root = parseLine(raw)
  return root ? parseCodexRecord(root) : null
}

/** `exec_command`'s arguments as the rollout keeps them. */
const ExecArguments = z.object({ cmd: z.string(), workdir: z.string().nullish() }).loose()
/** `view_image`'s and the file tools' arguments. */
const PathArguments = z.object({ path: z.string(), content: z.string().optional() }).loose()
/* What `toolTitle` reads a row's words from; each reads as undefined where it doesn't fit, as a failed `safeParse` builds an `Error`. */
const TitledCommand = z.object({ command: z.string() }).optional().catch(undefined)
const TitledPatch = z.object({ paths: z.array(z.string()) }).optional().catch(undefined)
const TitledSearch = z.json().optional().catch(undefined)

function parsedJson(text: string | undefined): CodexJsonValue | undefined {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Codex hides a plan's markup from the reply; the plan shows as its card. */
function withoutPlanMarkup(text: string): string {
  return text.includes("<proposed_plan>") ? text.replace(/<proposed_plan>[\s\S]*?<\/proposed_plan>/g, "").trim() : text
}

/** What MCP's and the code cell's own names read as on a row before its identity resolves. */
function toolTitle(name: string, input: string | undefined): string {
  if (name === "exec_command") {
    const command = TitledCommand.parse(parsedJson(input))?.command
    if (command) return firstLine(command)
  }
  if (name === "apply_patch") {
    const paths = TitledPatch.parse(parsedJson(input))?.paths
    if (paths?.length) return `Edit ${paths.join(", ")}`.slice(0, 500)
  }
  if (name === "web_search") return codexSearchTarget(TitledSearch.parse(parsedJson(input)) ?? undefined) ?? "Web search"
  if (name === "view_image") {
    const path = PathArguments.safeParse(parsedJson(input)).data?.path
    if (path) return `View ${basename(path)}`
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]}: ${mcp[2]}` : name
}

type ToolStatus = "pending" | "completed" | "failed" | "canceled"

/** A call as the decoder has drawn it so far. */
interface Call {
  id: string
  name: string
  /** The row's words where the call's own name and input don't say more. */
  title?: string
  /** The input the row's words were last read from, so they are read again only when it changes. */
  titled?: { input: string | undefined; title: string }
  input?: string
  output?: string
  status: ToolStatus
  /** A typed item ended it; the raw output the model read no longer redraws it. */
  itemized: boolean
  details?: ToolDetail[]
  attachments?: AttachmentContent[]
  facts: CodexCallFacts
}

/** The latest compaction, while Codex may still name it: its context before, which an estimate after must be under. */
interface OpenCompaction {
  tokensBefore?: number
}

/** The most calls kept for an item or an output that comes after them. */
const MAX_CALLS = 4096

/** A code cell a turn ran, and when it was called (epoch milliseconds; NaN when the record doesn't say). */
interface CellRun {
  id: string
  at: number
}

/** Adds `value` to `set`, keeping at most `MAX_CALLS`, the oldest dropped first. */
function remember(set: Set<string>, value: string): void {
  set.add(value)
  if (set.size > MAX_CALLS) set.delete(set.values().next().value!)
}

/** What `CodexRecords` knew before a turn's first line, which a reader begun there needs. */
export const CodexCarrySchema = z.object({
  started: z.boolean(),
  contextTokens: z.number().optional(),
  cwd: z.string().optional(),
  lastAt: z.string().optional(),
  synthetic: z.number(),
  compaction: z.enum(["record", "event"]).optional(),
  reviewEcho: z.string().optional(),
  reviewing: z.boolean().optional(),
})
export type CodexCarry = z.infer<typeof CodexCarrySchema>

export class CodexRecords {
  /** Every call drawn, by id, for the typed item that may follow it. */
  private readonly calls = new Map<string, Call>()
  /** Calls still waiting for their output; a marker ends the wait. */
  private readonly pending = new Map<string, Call>()
  /** Typed items that came before their call. */
  private readonly items = new Map<string, ToolItem & RolloutBase>()
  /** Code cells whose output hasn't come yet, with their source. */
  private readonly cells = new Map<string, string | undefined>()
  /**
   * The code cells each turn ran, in order. A command a cell started in the
   * background has no call of its own, and Codex writes its item when it
   * ends: after the cell, and after the turn when it outlives it (0.159.3,
   * the flows of 2026-10-16: two `sleep`s a cell left running, stopped by
   * Mako, written after `task_complete` under the turn's id). Once its cell
   * has ended no call can claim it, so it is drawn as the cell's, back where
   * it started: after the cell that ran then (`placeOf`), as the app-server
   * drew it when it started.
   */
  private readonly cellTurns = new Map<string, CellRun[]>()
  /** The turn now open, by Codex's id. */
  private turnId: string | undefined
  /** Turns this reader saw start, when it began partway through the rollout (`placed`). */
  private readonly turnsSeen = new Set<string>()
  /** Proposed plans drawn, by id, so a revision redraws its card. */
  private readonly plans = new Set<string>()
  private started = false
  private turnOpen = false
  /** The open turn's prompt; another prompt Codex saves inside the same turn was steered into it. */
  private prompt: string | undefined
  /** The message Codex sends after a review it ended, repeating the review a row already shows. */
  private reviewEcho: string | undefined
  /**
   * A review runs: its own thread's calls are in this rollout only as typed
   * items (`item_completed` under the review thread's id), with no response
   * items to wait for.
   */
  private reviewing = false
  /** Context tokens at the latest request, which a compaction starts from. */
  private contextTokens: number | undefined
  /** The record that marked the latest compaction, until content follows it. */
  private compaction: "record" | "event" | undefined
  private open: OpenCompaction | undefined
  private lastAt: string | undefined
  private cwd: string | undefined
  private synthetic = 0
  /** Begun at a turn knowing what came before it: content before any prompt is where the rollout put it. */
  private readonly placed: boolean

  constructor(carry?: CodexCarry) {
    this.placed = carry !== undefined
    if (!carry) return
    this.started = carry.started
    this.contextTokens = carry.contextTokens
    this.cwd = carry.cwd
    this.lastAt = carry.lastAt
    this.synthetic = carry.synthetic
    this.compaction = carry.compaction
    this.reviewEcho = carry.reviewEcho
    this.reviewing = carry.reviewing ?? false
  }

  /** What this reader knows now that one begun here would need. */
  private carry(): CodexCarry {
    const carry: CodexCarry = { started: this.started, synthetic: this.synthetic }
    if (this.contextTokens !== undefined) carry.contextTokens = this.contextTokens
    if (this.cwd !== undefined) carry.cwd = this.cwd
    if (this.lastAt !== undefined) carry.lastAt = this.lastAt
    if (this.compaction !== undefined) carry.compaction = this.compaction
    if (this.reviewEcho !== undefined) carry.reviewEcho = this.reviewEcho
    if (this.reviewing) carry.reviewing = true
    return carry
  }

  /** One rollout line. */
  line(raw: string, place?: LinePlace): CodexRead[] {
    const root = parseLine(raw)
    if (root) return this.record(root)
    const sample = unparsedLine(raw, place)
    return sample === undefined ? [] : [{ kind: "unread", type: "line", reason: "unreadable", record: sample }]
  }

  /** One rollout record, parsed. */
  record(root: CodexJsonObject): CodexRead[] {
    const event = parseCodexRecord(root)
    return event ? this.read(event) : []
  }

  /** The end of what was read: a compaction Codex hasn't named by now stays unnamed. */
  flush(): void {
    this.open = undefined
  }

  private read(event: CodexRolloutEvent): CodexRead[] {
    const out: CodexRead[] = []
    const carry = event.turn === "started" ? this.carry() : undefined
    const previousAt = this.lastAt
    const inTurn = this.turnOpen
    if (event.at) this.lastAt = event.at
    if (this.open && !this.names(event)) this.open = undefined
    if (event.turn) {
      this.turnOpen = event.turn === "started"
      if (event.turn === "started") {
        this.turnId = event.turnId
        if (this.placed && event.turnId) remember(this.turnsSeen, event.turnId)
      }
      // What waited for a call when its turn ran a cell was the cell's: no call comes once the turn has ended.
      else for (const item of this.items.values()) if (item.turnId && this.cellTurns.has(item.turnId) && item.turnId === (event.turnId ?? this.turnId)) this.cellItem(out, item)
      this.prompt = undefined
      out.push({ kind: "turn", started: this.turnOpen, ...event.turnId && { turnId: event.turnId }, ...event.at && { at: event.at }, ...carry && { carry } })
    }
    switch (event.kind) {
      // The thread's folder is where it started; each turn's own record says where that turn ran.
      case "session_meta":
        return out
      case "rolled_back":
        // Codex drops the latest turns whole, as its own history does.
        if (!event.turns) return out
        this.pending.clear()
        this.cells.clear()
        this.compaction = undefined
        this.open = undefined
        this.turnOpen = false
        out.push({ kind: "rolled-back", turns: event.turns })
        return out
      case "turn_context":
        if (event.cwd) this.cwd = event.cwd
        out.push({ kind: "settings", ...event.model && { model: event.model }, settings: event.settings, ...event.cwd && { cwd: event.cwd }, ...event.at && { at: event.at } })
        return out
      case "token_count_event":
        if (this.open) {
          // Codex counts the compacted context before the item that names the compaction; the call it counts is the compaction's own.
          if (event.usage?.context && this.open.tokensBefore !== undefined && event.usage.context < this.open.tokensBefore)
            out.push({ kind: "compaction-named", tokensAfter: event.usage.context })
          if (event.usage?.context) this.contextTokens = event.usage.context
          return out
        }
        if (event.usage?.context) this.contextTokens = event.usage.context
        if (event.usage) out.push({ kind: "usage", usage: event.usage, ...event.at && { at: event.at } })
        return out
      case "user_response":
        this.user(out, event, inTurn)
        return out
      case "assistant_response": {
        const text = withoutPlanMarkup(event.text)
        if (!text && !event.attachments?.length) return out
        if (this.reviewEcho !== undefined && text.trim() === this.reviewEcho) {
          this.reviewEcho = undefined
          return out
        }
        this.content(out)
        if (text) out.push(this.update({ kind: "text", ...event.id && { id: event.id }, text: codexPresentation(text), replace: true }, event.at))
        for (const attachment of event.attachments ?? []) out.push(this.update({ kind: "attachment", attachment }, event.at))
        return out
      }
      case "reasoning_response":
        if (!event.text.trim()) return out
        this.content(out)
        out.push(this.update({ kind: "thinking", ...event.id && { id: event.id }, text: codexPresentation(event.text), replace: true }, event.at))
        return out
      case "function_call_response":
        this.call(out, event)
        return out
      case "code_cell":
        if (event.callId) this.cells.set(event.callId, event.source)
        if (this.turnId) {
          let runs = this.cellTurns.get(this.turnId)
          if (!runs) {
            this.cellTurns.set(this.turnId, (runs = []))
            if (this.cellTurns.size > MAX_CALLS) this.cellTurns.delete(this.cellTurns.keys().next().value!)
          }
          if (event.callId && runs.length < MAX_CALLS) runs.push({ id: event.callId, at: event.at === undefined ? Number.NaN : Date.parse(event.at) })
        }
        return out
      case "tool_item":
        this.item(out, event)
        return out
      case "nested_call": {
        // Only a cell's own calls: a call the model made has its response items.
        if (this.calls.has(event.callId) || !this.cells.size) return out
        this.content(out)
        const call = this.track({ id: event.callId, name: event.name, title: event.title, input: event.input, output: event.output, status: event.error ? "failed" : "completed", itemized: true, facts: {} })
        if (event.attachments) call.attachments = event.attachments
        if (event.name === "view_image" && event.attachments?.[0]?.source.kind === "file") call.facts = { path: event.attachments[0].source.path }
        out.push(this.drawn(call, "tool", event.at))
        return out
      }
      case "function_output_response":
        this.output(out, event)
        return out
      case "event":
        // Codex ends a stopped turn without finishing the calls it stopped.
        if (event.aborted)
          for (const call of this.pending.values()) {
            if (call.status !== "pending") continue
            call.status = "canceled"
            out.push(this.drawn(call, "tool-update", event.at))
          }
        if (event.review) this.reviewing = event.review === "entered"
        this.marker(out, event.event, event.at)
        return out
      case "review": {
        this.reviewing = false
        this.content(out)
        const id = event.id ?? this.syntheticId("review")
        out.push(this.update({ kind: "tool", id, title: "Code review", name: "review", status: "completed", details: [{ type: "review", ...event.report }] }, event.at))
        this.reviewEcho = event.echo?.trim()
        return out
      }
      case "plan": {
        const card = proposedPlanBlock(event.id, event.text)
        if (!card) return out
        if (!this.plans.has(event.id)) this.compaction = undefined
        this.plans.add(event.id)
        out.push(this.update({ kind: "proposed-plan", id: card.id, text: card.text, status: "proposed", replace: true, ...card.truncated && { truncated: true } }, event.at))
        return out
      }
      case "compacted":
        this.compacted(out, event.source, event.summary, inTurn ? elapsedBetween(previousAt, event.at) : undefined, event.at)
        return out
      case "compaction_item":
        if (this.open) out.push({ kind: "compaction-named", source: event.id })
        this.open = undefined
        return out
      case "item_call": {
        this.content(out)
        const call = this.track({ id: event.callId, name: event.name, status: "completed", itemized: false, facts: {}, input: event.input, output: event.output ?? "" })
        out.push(this.drawn(call, "tool", event.at))
        return out
      }
      case "generated_image":
        this.content(out)
        out.push(this.update({ kind: "attachment", attachment: event.attachment }, event.at))
        return out
      case "ignored":
        if (event.unread) out.push({ kind: "unread", type: event.unread.kind, reason: event.unread.reason, record: event.unread.record })
        return out
      case "user_message_event":
      case "plumbing_response":
        return out
    }
  }

  /** Whether `event` is one Codex writes between a compaction and the item that names it. */
  private names(event: CodexRolloutEvent): boolean {
    return event.kind === "token_count_event" || event.kind === "turn_context" || event.kind === "compaction_item" ||
      (event.kind === "compacted" && this.compaction !== undefined && this.compaction !== event.source) ||
      (event.kind === "ignored" && !event.turn && !event.unread)
  }

  private compacted(out: CodexRead[], source: "record" | "event", summary: string | undefined, durationMs: number | undefined, at: string | undefined): void {
    // A legacy rollout records one compaction twice; either record alone still marks it.
    if (this.compaction && this.compaction !== source) {
      this.compaction = undefined
      return
    }
    this.compaction = source
    this.pending.clear()
    const compaction: Compaction = {}
    if (this.contextTokens) compaction.tokensBefore = this.contextTokens
    if (summary) compaction.summary = summary.length > 32 * 1024 ? `${summary.slice(0, 32 * 1024)}\n… [${summary.length - 32 * 1024} more characters]` : summary
    if (durationMs !== undefined) compaction.durationMs = durationMs
    this.open = compaction.tokensBefore === undefined ? {} : { tokensBefore: compaction.tokensBefore }
    this.contextTokens = undefined
    out.push({ kind: "compacted", compaction, ...at && { at } })
  }

  private user(out: CodexRead[], event: Extract<CodexRolloutEvent, { kind: "user_response" }>, inTurn: boolean): void {
    // Codex's note of the review's results, for the model's next turn; the review's row shows them.
    if (isCodexReviewAction(event.text)) return
    this.reviewEcho = undefined
    if (isCodexGoalPrompt(event.text)) {
      this.compaction = undefined
      this.started = true
      const goal = codexGoalTurn(codexGoalPromptStanding(event.text))
      out.push(this.update({ kind: "provider-turn", ...goal, ...event.id && { source: { harness: "codex", record: event.id } } }, event.at))
      return
    }
    const text = codexPrompt(event.text)
    const attachments = event.attachments?.length ? event.attachments : codexPromptImages(event.text)
    if (!text && !attachments.length) return
    this.compaction = undefined
    this.started = true
    // Codex 0.145.0 saves its prompts without an id: the turn's own id names the one that opened it, so a message
    // steered into that turn names what it was steered into, as it does on a build that gives prompts ids.
    const id = event.id ?? (inTurn && !this.prompt && this.turnId ? `${this.turnId}:prompt` : undefined)
    const steeringFor = inTurn ? this.prompt : undefined
    if (inTurn && !this.prompt) this.prompt = id
    out.push(this.update({ kind: "user", ...id && { messageId: id }, ...steeringFor && { steeringFor }, text: text ?? "", attachments }, event.at))
  }

  /** Content of a reply: it ends any compaction's hold, and before any prompt it has no place. */
  private content(out: CodexRead[]): void {
    this.compaction = undefined
    if (!this.started && !this.placed) out.push({ kind: "unplaced" })
    this.started = true
  }

  private marker(out: CodexRead[], event: TranscriptEvent, at: string | undefined): void {
    this.pending.clear()
    out.push({ kind: "marker", marker: event, ...at && { at } })
  }

  private call(out: CodexRead[], event: Extract<CodexRolloutEvent, { kind: "function_call_response" }>): void {
    this.content(out)
    const exec = event.name === "exec_command" ? ExecArguments.safeParse(parsedJson(event.input)).data : undefined
    const call: Call = {
      id: event.callId ?? this.syntheticId("call"),
      name: event.name,
      input: exec ? JSON.stringify({ command: exec.cmd }) : event.input,
      status: event.canceled ? "canceled" : event.error ? "failed" : event.output !== undefined ? "completed" : "pending",
      itemized: false,
      facts: this.callFacts(event.name, event.input, exec),
    }
    if (event.output !== undefined) call.output = event.output
    if (event.name === "update_plan" || event.name === "functions.update_plan") call.details = codexPlanDetails(call.input)
    this.track(call)
    if (event.callId) this.pending.set(call.id, call)
    const item = event.callId ? this.items.get(event.callId) : undefined
    if (item) {
      this.items.delete(item.callId)
      this.apply(call, item)
    }
    out.push(this.drawn(call, "tool", event.at))
  }

  /** What the call's arguments say about the machine, before Codex runs it. */
  private callFacts(name: string, input: string | undefined, exec: z.infer<typeof ExecArguments> | undefined): CodexCallFacts {
    const facts: CodexCallFacts = {}
    if (this.cwd) facts.cwd = this.cwd
    if (exec) {
      facts.command = exec.cmd
      if (exec.workdir) facts.cwd = this.cwd ? codexWorkdir(exec.workdir, this.cwd) : exec.workdir
    } else if (name === "apply_patch" && input !== undefined) facts.patch = input
    else if (["view_image", "read_file", "write_file", "append_to_file"].includes(name)) {
      const args = PathArguments.safeParse(parsedJson(input)).data
      if (args) {
        facts.path = args.path
        if (args.content !== undefined) facts.content = args.content
      }
    }
    return facts
  }

  private item(out: CodexRead[], event: ToolItem & RolloutBase): void {
    const call = this.calls.get(event.callId)
    if (call) {
      this.apply(call, event)
      out.push(this.drawn(call, "tool-update", event.at))
      return
    }
    const turn = event.turnId
    // Only a reading of the whole rollout knows what a turn begun before this reader ran, and where its content is.
    if (!this.reviewing && turn !== undefined && this.placed && !this.turnsSeen.has(turn)) {
      out.push({ kind: "unplaced" })
      return
    }
    const late = turn !== undefined && this.cellTurns.has(turn) && !(this.turnOpen && turn === this.turnId)
    if (!this.cells.size && !this.reviewing && !late) {
      this.items.set(event.callId, event)
      if (this.items.size > MAX_CALLS) this.items.delete(this.items.keys().next().value!)
      return
    }
    // A call the open cell, or the review's thread, made, which has no call of its own; or a cell's that outlived it.
    this.cellItem(out, event)
  }

  private cellItem(out: CodexRead[], event: ToolItem & RolloutBase): void {
    this.items.delete(event.callId)
    this.content(out)
    const nested = this.track({ id: event.callId, name: event.name, status: "pending", itemized: false, facts: this.cwd ? { cwd: this.cwd } : {} })
    this.apply(nested, event)
    out.push(this.drawn(nested, "tool", event.at, this.placeOf(event)))
  }

  /**
   * Where a call a cell made goes when that cell has ended: after the cell
   * that was running when it started, the last of its turn called by then
   * (or its turn's last, when the item doesn't say when it started).
   */
  private placeOf(event: ToolItem): CodexPlace | undefined {
    const runs = event.turnId === undefined ? undefined : this.cellTurns.get(event.turnId)
    if (!runs?.length) return undefined
    const started = event.startedAt
    let cell = runs.at(-1)!
    if (started !== undefined) {
      cell = runs[0]!
      for (const run of runs) if (run.at <= started) cell = run
    }
    // A cell still running draws its calls as they come.
    if (this.cells.has(cell.id)) return undefined
    return { mark: cell.id, started: started ?? Number.MAX_SAFE_INTEGER }
  }

  /** A typed item over its call: what Codex ran and how it ended. */
  private apply(call: Call, item: ToolItem): void {
    call.itemized = true
    if (item.input !== undefined) call.input = item.input
    call.facts = { ...call.facts, ...item.facts }
    // A stopped call stays stopped: Codex can record the process it killed
    // afterwards as a failed item exiting -1.
    if (call.status === "canceled") return
    // A completed item ended its call; one that printed nothing still finished.
    call.output = item.output ?? ""
    call.status = item.error || call.status === "failed" ? "failed" : "completed"
  }

  private output(out: CodexRead[], event: Extract<CodexRolloutEvent, { kind: "function_output_response" }>): void {
    const id = event.callId ?? ""
    if (this.cells.has(id)) {
      const source = this.cells.get(id)
      this.cells.delete(id)
      // A cell that finished shows only its calls; one that failed is its own row, where the failure happened.
      if (event.cell?.failed) {
        this.content(out)
        const cell = this.track({ id, name: "exec", input: source, output: event.cell.output, status: "failed", itemized: true, facts: {} })
        out.push(this.drawn(cell, "tool", event.at))
      }
      out.push({ kind: "mark", mark: id, ...event.at && { at: event.at } })
      return
    }
    const call = this.pending.get(id)
    if (!call) {
      if (id) out.push({ kind: "unplaced" })
      return
    }
    this.pending.delete(id)
    const was = [call.status, call.output, call.attachments, call.facts.exitCode, call.facts.background]
    const exec = call.name === "exec_command" ? codexExecOutput(event.output) : undefined
    // `view_image`'s output is the image itself, shown as the call's attachment and named for the file.
    const viewed = call.name === "view_image" ? call.facts.path : undefined
    if (viewed !== undefined) {
      call.output = ""
      if (call.status === "pending") call.status = "completed"
    } else if (codexAborted(event.output)) {
      // Live, a stopped call ends with its turn and no output.
      call.status = "canceled"
      call.output = ""
    } else if (!call.itemized) {
      call.output = exec ? (codexCommandOutput(exec.output, exec.exitCode) ?? "") : event.output
      call.status = exec?.exitCode || call.status === "failed" ? "failed" : call.status === "canceled" ? "canceled" : "completed"
      if (exec?.exitCode !== undefined) call.facts.exitCode ??= exec.exitCode
    }
    if (call.name === "exec_command" && /\nProcess running with session ID \d+\n/.test(event.raw.slice(0, 512))) call.facts.background = true
    if (event.attachments?.length)
      call.attachments = viewed === undefined ? event.attachments : event.attachments.map((attachment) => ({ ...attachment, name: basename(viewed) }))
    // An item already finished the call; its output, which the model read, redraws nothing.
    const now = [call.status, call.output, call.attachments, call.facts.exitCode, call.facts.background]
    if (now.some((value, index) => value !== was[index])) out.push(this.drawn(call, "tool-update", event.at))
  }

  private track(call: Call): Call {
    this.calls.set(call.id, call)
    if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value!)
    return call
  }

  private syntheticId(kind: string): string {
    return `codex-${kind}-${++this.synthetic}`
  }

  /** The call as an update: whole, since a later record can rewrite any of it. */
  private drawn(call: Call, kind: "tool" | "tool-update", at: string | undefined, place?: CodexPlace): CodexRead {
    const effects: ToolEffect[] | undefined = codexToolEffects(call.name, call.facts)
    if (call.titled?.input !== call.input || !call.titled) call.titled = { input: call.input, title: call.title ?? toolTitle(call.name, call.input) }
    const title = call.titled.title
    const update: LiveUpdate = kind === "tool"
      ? { kind, id: call.id, title, name: call.name, status: call.status }
      : { kind, id: call.id, title, status: call.status }
    if (call.input !== undefined) update.input = call.input
    if (call.output !== undefined) update.output = call.output
    if (call.details) update.details = call.details
    if (call.attachments) update.attachments = call.attachments
    if (effects) update.effects = effects
    return this.update(update, at, place)
  }

  private update(update: LiveUpdate, at: string | undefined, place?: CodexPlace): CodexRead {
    const read: Extract<CodexRead, { kind: "update" }> = at ? { kind: "update", update, at } : { kind: "update", update }
    if (place) read.place = place
    return read
  }
}

/** A call's `workdir`, read against the turn's folder when it is relative. */
function codexWorkdir(workdir: string, cwd: string): string {
  return workdir.startsWith("/") ? workdir : `${cwd.replace(/\/$/, "")}/${workdir}`
}

function elapsedBetween(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined
  const elapsed = Date.parse(to) - Date.parse(from)
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

/** Native part boundaries distinguish the authored prompt from file transport. */
function userResponse(content: CodexJsonValue | undefined): PromptAttachmentProjection {
  if (!Array.isArray(content)) return { text: textOf(content), attachments: [] }
  const attachments = responseAttachments(content)
  let text = ""
  let authored = false
  for (const value of content) {
    const part = objectValue(value)
    const valueText = stringValue(part?.["text"])
    if (valueText === undefined) continue
    const manifest = readPromptAttachments(valueText)
    // Legacy metadata was always a later, whole input_text part. Never classify
    // the first authored part or an example embedded within it as an attachment.
    const legacy = authored && part?.["type"] === "input_text" ? legacyTextAttachment(valueText) : undefined
    if (legacy) attachments.push(legacy)
    else {
      text += manifest.text
      attachments.push(...manifest.attachments)
    }
    authored = true
  }
  const images = codexPromptImages(text)
  let image = 0
  for (const attachment of attachments) {
    if (!attachment.mimeType.startsWith("image/")) continue
    const original = images[image++]
    if (original) {
      attachment.name = original.name
      // Keep native inline bytes; the wrapper's path is a fallback only.
      if (attachment.source.kind === "unavailable") attachment.source = original.source
    }
  }
  if (!attachments.length) attachments.push(...images)
  return { text, attachments }
}

function responseAttachments(content: CodexJsonValue | undefined): AttachmentContent[] {
  if (!Array.isArray(content)) return []
  const attachments: AttachmentContent[] = []
  for (const value of content) {
    const part = objectValue(value)
    if (!part) continue
    const type = stringValue(part["type"]) ?? ""
    if (!/image|audio|file/.test(type)) continue
    const name = stringValue(part["filename"]) ?? type.replaceAll("_", " ")
    const mimeType = stringValue(part["mime_type"]) ??
      (type.includes("image") ? "image/png" : type.includes("audio") ? "audio/wav" : "application/octet-stream")
    const url = stringValue(part["audio_url"]) ?? stringValue(part["image_url"]) ?? stringValue(part["url"]) ?? stringValue(part["file_url"])
    const path = stringValue(part["path"])
    attachments.push(url
      ? attachmentFromUrl(name, mimeType, url)
      : {
          type: "attachment",
          name,
          mimeType,
          source: path ? { kind: "file", path } : { kind: "unavailable", reason: "The provider did not retain attachment bytes or a readable URL" },
        })
  }
  return attachments
}
