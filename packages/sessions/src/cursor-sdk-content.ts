import { basename } from "node:path"
import { z } from "zod"
import type { ToolDetail } from "./content.js"
import { compactionEvent } from "./events.js"
import type { ThreadEntry } from "./format.js"
import { MAX_STREAMED_TOOL_OUTPUT, type LiveUpdate } from "./live-content.js"
import { liveTurnEntries } from "./live-entries.js"
import type { CursorToolResult } from "./providers/cursor-records.js"

/**
 * What Cursor's SDK says while a run streams, and how the transcript draws
 * it. The live child forwards these messages and deltas as they arrive, and
 * `index.db` keeps every message of every run in `run_events`, so the live
 * window and a reopened conversation read one vocabulary through one
 * projection (`CursorSdkProjection`, `cursorRunEntries`).
 */

type JsonValue = z.infer<ReturnType<typeof z.json>>
/**
 * A value inside a message, which reaches this vocabulary through
 * `JSON.parse` (a `run_events` row, a line from the SDK child) and so is JSON
 * already. Walking it again with `z.json()` took 5.4 s of a 10 s open for an
 * agent whose tool calls kept 196 MB of arguments and results.
 */
const JsonSchema = z.custom<JsonValue>((value) => value !== undefined)

export const CursorSdkModelParamSchema = z.object({ id: z.string(), value: z.string() })
export const CursorSdkModelSelectionSchema = z.object({
  id: z.string(),
  params: z.array(CursorSdkModelParamSchema).optional(),
})
export type CursorSdkModelSelection = z.infer<typeof CursorSdkModelSelectionSchema>

export const CursorSdkTokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
})

const messageBase = { agent_id: z.string(), run_id: z.string() }

/** The SDK's `SDKMessage`, as `run.stream()` yields it and `run_events` keeps it. */
export const CursorSdkMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...messageBase,
    type: z.literal("system"),
    subtype: z.literal("init").optional(),
    model: CursorSdkModelSelectionSchema.optional(),
    tools: z.array(z.string()).optional(),
  }),
  z.object({
    ...messageBase,
    type: z.literal("assistant"),
    message: z.object({
      role: z.literal("assistant"),
      content: z.array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({
            type: z.literal("tool_use"),
            id: z.string(),
            name: z.string(),
            input: JsonSchema.optional(),
          }),
        ])
      ),
    }),
  }),
  z.object({
    ...messageBase,
    type: z.literal("user"),
    message: z.object({
      role: z.literal("user"),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
  }),
  z.object({
    ...messageBase,
    type: z.literal("tool_call"),
    call_id: z.string(),
    name: z.string(),
    status: z.enum(["running", "completed", "error"]),
    args: JsonSchema.optional(),
    result: JsonSchema.optional(),
    truncated: z.object({ args: z.boolean().optional(), result: z.boolean().optional() }).optional(),
  }),
  z.object({
    ...messageBase,
    type: z.literal("thinking"),
    text: z.string(),
    thinking_duration_ms: z.number().optional(),
  }),
  z.object({
    ...messageBase,
    type: z.literal("status"),
    status: z.enum(["CREATING", "RUNNING", "FINISHED", "ERROR", "CANCELLED", "EXPIRED"]),
    message: z.string().optional(),
  }),
  z.object({ ...messageBase, type: z.literal("request"), request_id: z.string() }),
  z.object({
    ...messageBase,
    type: z.literal("task"),
    status: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({ ...messageBase, type: z.literal("usage"), usage: CursorSdkTokenUsageSchema }),
])
export type CursorSdkMessage = z.infer<typeof CursorSdkMessageSchema>

/** The streamed deltas the transcript renders as they arrive; the rest of the SDK's update union is summarised by `CursorSdkMessage`. */
export const CursorSdkDeltaSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), text: z.string() }),
  z.object({ type: z.literal("thinking-delta"), text: z.string() }),
  z.object({ type: z.literal("thinking-completed") }),
  z.object({ type: z.literal("turn-ended") }),
  /**
   * Cursor is summarising the conversation to fit its context;
   * `summary-completed` ends it. The summary itself arrives as a `task`
   * message. SDK 1.0.31 withholds all three deltas from `onDelta`, so there
   * the message is the only sign of a compaction.
   */
  z.object({ type: z.literal("summary-started") }),
  z.object({ type: z.literal("summary-completed") }),
  /** The tail of what a running shell command printed since the last one, coalesced by the child. */
  z.object({ type: z.literal("shell-output"), text: z.string() }),
  /**
   * A call a running subagent made, from the SDK's `tool-call-delta`: `task`
   * is the parent's `task` call the subagent runs under. The child forwards a
   * call's start and its end, with long strings in `args` clipped and the
   * result left out; the subagent's text and thinking are not forwarded.
   */
  z.object({
    type: z.literal("subagent-call"),
    task: z.string(),
    callId: z.string(),
    name: z.string(),
    status: z.enum(["running", "completed", "error"]),
    args: z.json().optional(),
  }),
  /** An update kind this child does not know, sent once per kind. */
  z.object({ type: z.literal("unhandled"), kind: z.string() }),
])
export type CursorSdkDelta = z.infer<typeof CursorSdkDeltaSchema>

export type CursorTurnOutcome = "finished" | "cancelled" | "error"

/**
 * Why a tool row is still open when its turn has ended. The SDK has no
 * approval prompt: a call a hook rejects is refused before it runs, the
 * reason is fed to the model only, and no terminal event follows.
 */
export function cursorUnfinishedToolNote(outcome: CursorTurnOutcome, error?: string): string {
  switch (outcome) {
    case "cancelled":
      return "Stopped before this call finished."
    case "error":
      return `This call was still running when the turn ended, so it never returned a result${error ? `: ${error}` : "."}`
    case "finished":
      return "Cursor did not run this call. A hook in .cursor/hooks.json or the runtime rejected it before it ran and told the agent why; the SDK has no approval prompt."
  }
}

const MAX_TOOL_TEXT = 32 * 1024

/**
 * The summary Cursor wrote when it compacted the conversation. The SDK
 * turns its `summary` update into a `task` message carrying only text
 * (SDK 1.0.31); a task message with a status is something else.
 */
export function compactionSummary(message: CursorSdkMessage): string | undefined {
  if (message.type !== "task" || message.status !== undefined) return undefined
  const summary = message.text?.trim()
  return summary || undefined
}

/** One message of a run as `run_events` keeps it, with when it was written. */
export interface CursorSdkRunEvent {
  message: CursorSdkMessage
  /** Its place among what the run streamed, from 0: the `seq` the live child gave it. */
  index: number
  at?: string
}

/** The results a run's checkpoint kept for `callIds`, asked once, when the run ends with calls still open. */
export type CursorSettled = (callIds: ReadonlySet<string>) => ReadonlyMap<string, CursorToolResult>

/** A run message's native identity, the same live and saved: its run, and its place among what the run streamed. */
export function cursorSdkMessageRecord(message: CursorSdkMessage, index: number): string {
  return `${message.run_id}:${index}`
}

/** What a saved run's replay needs beyond its messages. */
export interface CursorSdkReplay {
  runId: string
  /** The prompt's entry id, which a message steered into the run names. */
  prompt?: string
  model?: string
  /** How the run ended; absent while it runs, so its open calls stay running. */
  ending?: { outcome: CursorTurnOutcome; error?: string; at?: string }
  /**
   * The results of calls the stream never ended, from the conversation the
   * run checkpointed (`CursorSdkProjection.finish`).
   */
  settled?: CursorSettled
}

/**
 * A run as the live window drew it, as saved entries: its messages go
 * through the projection the live decoder runs and the reducer the window
 * runs. `run_events` keeps messages, not deltas, and the projection draws
 * the whole reply from either. A message steered in is the SDK's `user`
 * message, placed where the run read it; a compaction is its summary.
 */
export function cursorRunEntries(events: Iterable<CursorSdkRunEvent>, replay: CursorSdkReplay): ThreadEntry[] {
  const projection = new CursorSdkProjection(replay.runId)
  const updates: LiveUpdate[] = []
  const at: (string | undefined)[] = []
  const add = (more: readonly LiveUpdate[], time: string | undefined) => {
    for (const update of more) {
      updates.push(update)
      at.push(time)
    }
  }
  for (const { message, index, at: time } of events) {
    if (message.type === "user") {
      const text = message.message.content.map((part) => part.text).join("")
      add([{ kind: "user", text, ...replay.prompt && { steeringFor: replay.prompt } }], time)
      continue
    }
    add(projection.message(message), time)
    const summary = compactionSummary(message)
    if (summary) add([{ kind: "event", ...compactionEvent({ summary }), source: { harness: "cursor", record: cursorSdkMessageRecord(message, index) } }], time)
  }
  const ending = replay.ending
  if (ending) add(projection.finish(ending.outcome, cursorUnfinishedToolNote(ending.outcome, ending.error), replay.settled), ending.at)
  const entries = liveTurnEntries(updates, at)
  if (replay.model) for (const entry of entries) if (entry.kind === "assistant") entry.model = replay.model
  return entries
}

/**
 * Projects one SDK run into the shared transcript contract.
 *
 * Text and thinking reach the child twice: `onDelta` streams each chunk, and
 * the run's message stream echoes the same chunk as an `assistant` or
 * `thinking` message a moment later (verified against SDK 1.0.31: "Done"
 * then "." arrived as two deltas and two assistant messages, never as one
 * consolidated message). Either source alone must produce the whole reply,
 * so both feed one accumulator per open block and only the bytes not yet
 * seen from the other source are appended. A tool call closes the current
 * text block, because a reply that resumes after a tool is a new paragraph,
 * not a continuation; `thinking-completed` closes the thinking block.
 */
export class CursorSdkProjection {
  private segment = 0
  private text = new Accumulated()
  private thinking = new Accumulated()
  private readonly tools = new Map<string, { name: string; input: JsonValue | undefined; output?: string }>()
  private readonly settled = new Set<string>()
  /** Calls the stream ended with an error result, by name, until their checkpoint says what the model was told. */
  private readonly reported = new Map<string, string>()

  private readonly turn: string

  constructor(turn: string) {
    this.turn = turn
  }

  private get textId(): string {
    return `${this.turn}:text:${this.segment}`
  }

  private get thinkingId(): string {
    return `${this.turn}:thinking:${this.segment}`
  }

  private closeText(): void {
    if (this.text.open || this.thinking.open) this.segment += 1
    this.text = new Accumulated()
    this.thinking = new Accumulated()
  }

  private closeThinking(): void {
    if (!this.thinking.open) return
    this.segment += 1
    this.thinking = new Accumulated()
  }

  private appendText(chunk: string, source: Source): LiveUpdate[] {
    const fresh = this.text.take(chunk, source)
    return fresh ? [{ kind: "text", id: this.textId, text: fresh }] : []
  }

  private appendThinking(chunk: string, source: Source): LiveUpdate[] {
    const fresh = this.thinking.take(chunk, source)
    return fresh ? [{ kind: "thinking", id: this.thinkingId, text: fresh }] : []
  }

  delta(delta: CursorSdkDelta): LiveUpdate[] {
    switch (delta.type) {
      case "text-delta":
        return this.appendText(delta.text, "delta")
      case "thinking-delta":
        return this.appendThinking(delta.text, "delta")
      case "thinking-completed":
        this.closeThinking()
        return []
      // Text after a compaction starts a block of its own, below its marker.
      case "turn-ended":
      case "summary-completed":
        this.closeText()
        return []
      case "shell-output":
        return this.shellOutput(delta.text)
      // A subagent's own calls show as its progress; its `task` row holds what it reported.
      case "subagent-call":
      case "summary-started":
      case "unhandled":
        return []
    }
  }

  /**
   * Streamed output names no call, so it goes to the one shell call still
   * running; with two running it is dropped, and each completed call shows
   * its whole output anyway.
   */
  private shellOutput(text: string): LiveUpdate[] {
    let id: string | undefined
    for (const [candidate, tool] of this.tools) {
      if (tool.name !== "shell") continue
      if (id) return []
      id = candidate
    }
    const tool = id === undefined ? undefined : this.tools.get(id)
    if (id === undefined || !tool) return []
    const output = (tool.output ?? "") + text
    tool.output = output.length > MAX_STREAMED_TOOL_OUTPUT ? output.slice(-MAX_STREAMED_TOOL_OUTPUT) : output
    return [{ kind: "tool-update", id, outputAppend: text }]
  }

  message(message: CursorSdkMessage): LiveUpdate[] {
    switch (message.type) {
      case "assistant": {
        const updates: LiveUpdate[] = []
        for (const part of message.message.content) {
          if (part.type === "text") {
            updates.push(...this.appendText(part.text, "message"))
            continue
          }
          if (!this.tools.has(part.id)) {
            this.remember(part.id, part.name, part.input)
            updates.push(...this.toolStarted(part.id, part.name, part.input))
          }
        }
        return updates
      }
      case "thinking": {
        // The final thinking message carries no text and the duration: the block is done.
        if (!message.text) {
          if (message.thinking_duration_ms !== undefined) this.closeThinking()
          return []
        }
        return this.appendThinking(message.text, "message")
      }
      case "tool_call": {
        if (message.status === "running") {
          const started = this.tools.get(message.call_id)
          if (!started) {
            this.remember(message.call_id, message.name, message.args)
            return this.toolStarted(message.call_id, message.name, message.args)
          }
          // Arguments stream in while the call is being written; the row
          // opened with a placeholder and must not keep it. Cursor's
          // createPlan begins `{"plan":""}` and fills in behind it.
          if (message.args === undefined || sameJson(started.input, message.args)) return []
          started.input = message.args
          const updates: LiveUpdate[] = [
            this.toolInput(message.call_id, message.name, message.args),
          ]
          const plan = planEntries(message.name, message.args)
          if (plan) updates.push({ kind: "plan", entries: plan })
          const proposal = proposedPlan(message.call_id, message.name, message.args, "drafting")
          if (proposal) updates.push(proposal)
          return updates
        }
        if (cursorCallErrored(message.status, isObject(message.result) ? stringOf(message.result.status) : undefined))
          this.reported.set(message.call_id, message.name)
        return this.toolEnded(message.call_id, message.name, message.status === "error", message.args, message.result)
      }
      case "task":
        if (compactionSummary(message) !== undefined) this.closeText()
        return []
      case "user":
      case "system":
      case "status":
      case "request":
        return []
      // The decoder counts the turn's spend; nothing here is transcript.
      case "usage":
        return []
    }
  }

  private toolEnded(id: string, name: string, errored: boolean, args: JsonValue | undefined, result: JsonValue | undefined): LiveUpdate[] {
    const started = this.tools.get(id)
    const updates: LiveUpdate[] = []
    // A call settled from the checkpoint that the stream ends after all keeps its one row.
    if (!started && !this.settled.has(id)) {
      this.remember(id, name, args)
      updates.push(...this.toolStarted(id, name, args))
    }
    const failed = errored || resultFailed(result)
    const input = args ?? started?.input
    const update: LiveUpdate = { kind: "tool-update", id, status: failed ? "failed" : "completed" }
    if (started && input !== undefined && !sameJson(started.input, input)) {
      // Full arguments that arrive only at completion still replace the
      // placeholder the row opened with.
      update.title = toolTitle(name, input)
      update.input = clip(JSON.stringify(input, null, 2))
    }
    const output = toolOutput(name, result)
    if (output !== undefined) update.output = output
    const details = toolDetails(name, input, result)
    if (details) update.details = details
    updates.push(update)
    if (!failed) {
      const plan = planEntries(name, input)
      if (plan) updates.push({ kind: "plan", entries: plan })
      const proposal = proposedPlan(id, name, input, "proposed")
      if (proposal) updates.push(proposal)
    }
    this.tools.delete(id)
    return updates
  }

  /**
   * Closes every tool row the run left open when the turn ends: with the
   * result its checkpoint kept (`settled`), else with `note`.
   *
   * Some calls never get a terminal `tool_call` message (verified with SDK
   * 1.0.31): a read that fails, whose "Error: File not found" reaches only
   * the checkpoint, and a call refused before it ran, by a
   * `.cursor/hooks.json` hook answering `deny` or the `autoReview` classifier
   * Mako no longer enables, which emitted one `running` event and nothing
   * more. Without this the row would spin forever.
   */
  finish(outcome: CursorTurnOutcome, note: string, settled?: CursorSettled): LiveUpdate[] {
    const asked = new Set([...this.tools.keys(), ...this.reported.keys()])
    const updates = settled && asked.size ? this.settle(settled(asked)) : []
    for (const id of this.tools.keys()) {
      const update: LiveUpdate = {
        kind: "tool-update",
        id,
        status: outcome === "cancelled" ? "cancelled" : "failed",
        output: note,
      }
      // A run that errored stopped its calls midway; one that finished had
      // refused them before they ran, and one the user stopped says so.
      if (outcome === "error") update.unfinished = true
      updates.push(update)
    }
    this.tools.clear()
    return updates
  }

  /**
   * Shows what a checkpoint kept for calls the stream left open, or ended
   * with only an error result: what the model itself was told. The child
   * reads them while the run goes on, as Cursor saves each step, and again
   * when it ends.
   */
  settle(results: ReadonlyMap<string, CursorToolResult>): LiveUpdate[] {
    const updates: LiveUpdate[] = []
    const calls = [...this.tools].map(([id, tool]) => [id, tool.name] as const).concat([...this.reported])
    for (const [id, name] of calls) {
      const result = results.get(id)
      if (!result) continue
      this.reported.delete(id)
      this.settled.add(id)
      updates.push(...this.toolEnded(id, name, result.failed, undefined, result.failed ? { status: "error", error: result.output } : result.output))
    }
    return updates
  }

  private remember(id: string, name: string, input: JsonValue | undefined): void {
    this.tools.set(id, { name, input })
    if (this.tools.size > 4096) this.tools.delete(this.tools.keys().next().value ?? "")
  }

  private toolStarted(id: string, name: string, args: JsonValue | undefined): LiveUpdate[] {
    this.closeText()
    const updates: LiveUpdate[] = []
    const tool: LiveUpdate = {
      kind: "tool",
      id,
      title: toolTitle(name, args),
      name,
      status: "running",
    }
    const input = args === undefined ? undefined : clip(JSON.stringify(args, null, 2))
    if (input !== undefined) tool.input = input
    const details = toolDetails(name, args, undefined)
    if (details) tool.details = details
    updates.push(tool)
    const plan = planEntries(name, args)
    if (plan) updates.push({ kind: "plan", entries: plan })
    const proposal = proposedPlan(id, name, args, "drafting")
    if (proposal) updates.push(proposal)
    return updates
  }

  private toolInput(id: string, name: string, args: JsonValue): LiveUpdate {
    const update: LiveUpdate = {
      kind: "tool-update",
      id,
      title: toolTitle(name, args),
      input: clip(JSON.stringify(args, null, 2)),
    }
    const details = toolDetails(name, args, undefined)
    if (details) update.details = details
    return update
  }
}

type Source = "delta" | "message"

/**
 * One block's text as seen from each source. Whichever source is ahead has
 * already been emitted; the other only contributes what extends past it.
 */
class Accumulated {
  private readonly seen = { delta: "", message: "" }
  private emitted = ""

  get open(): boolean {
    return this.emitted.length > 0
  }

  take(chunk: string, source: Source): string {
    if (!chunk) return ""
    this.seen[source] += chunk
    const total = this.seen[source]
    if (total.length <= this.emitted.length) return ""
    const fresh = total.slice(this.emitted.length)
    this.emitted = total
    return fresh
  }
}

// Read on every message, mostly on fields that are absent: a failed parse
// builds an error, so absence passes and anything else falls to undefined.
const StringSchema = z.string().nullish().catch(undefined)
const NumberSchema = z.number().nullish().catch(undefined)

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

/** Equal JSON, compared in place: no serialization, and it stops at the first difference. */
function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true
  if (Array.isArray(left))
    return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJson(item, right[index]))
  if (!isObject(left) || !isObject(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
}

/** A string field, including the empty string (a deletion's new text). */
function stringOf(value: JsonValue | undefined): string | undefined {
  return StringSchema.parse(value) ?? undefined
}

/** A non-empty string field. */
function text(value: JsonValue | undefined): string | undefined {
  const value_ = stringOf(value)
  return value_ !== undefined && value_.length > 0 ? value_ : undefined
}

function numberOf(value: JsonValue | undefined): number | undefined {
  return NumberSchema.parse(value) ?? undefined
}

/** Long text keeps both ends: a command's error and a report's conclusion come last. */
export function clip(value: string): string {
  if (value.length <= MAX_TOOL_TEXT) return value
  const half = MAX_TOOL_TEXT / 2
  return `${value.slice(0, half)}\n\n… ${value.length - 2 * half} characters left out …\n\n${value.slice(-half)}`
}

/**
 * A subagent's reply to its parent: the messages it wrote after its last
 * call. `conversationSteps` is its whole run, one `{ thinkingMessage }`,
 * `{ assistantMessage }` or `{ toolCall }` per step, every call's full result
 * included; a research run passes 32 KB within a few calls, so the run
 * itself is no row output. `resultSuffix` is what Cursor adds to the reply
 * it hands the parent.
 */
function subagentReply(value: { [key: string]: JsonValue }): string | undefined {
  const steps = Array.isArray(value.conversationSteps) ? value.conversationSteps : []
  const said = (step: JsonValue) =>
    isObject(step) && isObject(step.assistantMessage) ? text(step.assistantMessage.text) : undefined
  const calls = (step: JsonValue | undefined) => isObject(step) && step.toolCall !== undefined
  let lastCall = steps.length - 1
  while (lastCall >= 0 && !calls(steps[lastCall])) lastCall--
  let reply = steps.slice(lastCall + 1).flatMap((step) => said(step) ?? []).join("\n\n")
  if (!reply) reply = steps.map(said).filter((message) => message !== undefined).at(-1) ?? ""
  const suffix = text(value.resultSuffix)
  const whole = [reply, suffix].filter(Boolean).join("\n\n")
  return whole || undefined
}

/** The SDK's tool vocabulary as a transcript row title. */
export function toolTitle(name: string, args: JsonValue | undefined): string {
  const input = isObject(args) ? args : undefined
  const path = text(input?.path)
  switch (name) {
    case "shell":
      return text(input?.command) ?? "Run command"
    case "read":
      return path ? `Read ${basename(path)}` : "Read file"
    case "edit":
      return path ? `Edit ${basename(path)}` : "Edit file"
    case "write":
      return path ? `Write ${basename(path)}` : "Write file"
    case "delete":
      return path ? `Delete ${basename(path)}` : "Delete file"
    case "grep":
      return text(input?.pattern) ? `Search ${text(input?.pattern)}` : "Search"
    case "glob":
      return text(input?.globPattern) ? `Find ${text(input?.globPattern)}` : "Find files"
    case "ls":
      return path ? `List ${basename(path) || path}` : "List directory"
    case "semSearch":
      return text(input?.query) ? `Search ${text(input?.query)}` : "Semantic search"
    case "webSearch":
      return text(input?.query) ?? text(input?.searchTerm) ?? "Web search"
    case "webFetch":
      return text(input?.url) ?? "Fetch page"
    case "readLints":
      return "Read lints"
    case "updateTodos":
      return "Update plan"
    case "readTodos":
      return "Read plan"
    case "createPlan":
      return "Create plan"
    case "askQuestion":
      return "Ask a question"
    case "task":
      return text(input?.description) ?? "Run subagent"
    case "mcp": {
      const tool = text(input?.toolName)
      const server = text(input?.providerIdentifier)
      return tool ? (server ? `${server}: ${tool}` : tool) : "MCP tool"
    }
    case "generateImage":
      return "Generate image"
    default:
      return name
  }
}

/** A call that errored, or an MCP tool that answered with `isError`. */
/**
 * A call the SDK ended as an error. Its error can say less than the
 * checkpoint: SDK 1.0.31 ended a read of a missing file with
 * `{status: "error", error: {message: "error"}}`, and its checkpoint kept
 * "Error: File not found". A command that exits non-zero completes with its
 * output, and isn't one.
 */
export function cursorCallErrored(status: string, resultStatus: string | undefined): boolean {
  return status === "error" || resultStatus === "error"
}

function resultFailed(result: JsonValue | undefined): boolean {
  if (!isObject(result)) return false
  return result.status === "error" || (isObject(result.value) && result.value.isError === true)
}

function toolOutput(name: string, result: JsonValue | undefined): string | undefined {
  if (result === undefined) return undefined
  if (isObject(result)) {
    if (result.status === "error") {
      const error = result.error
      return clip(stringOf(error) ?? JSON.stringify(error ?? "error", null, 2))
    }
    const value = isObject(result.value) ? result.value : undefined
    if (value) {
      switch (name) {
        case "shell": {
          const stdout = text(value.stdout) ?? ""
          const stderr = text(value.stderr) ?? ""
          const code = numberOf(value.exitCode)
          const parts = [stdout, stderr].filter((part) => part.length > 0)
          if (code !== undefined && code !== 0) parts.push(`exit ${code}`)
          return clip(parts.join("\n"))
        }
        case "read":
          return text(value.content) === undefined ? undefined : clip(text(value.content) ?? "")
        case "edit":
          return text(value.diffString) === undefined ? undefined : clip(text(value.diffString) ?? "")
        case "semSearch":
          return text(value.results) === undefined ? undefined : clip(text(value.results) ?? "")
        case "grep": {
          const lines = grepLines(value.workspaceResults)
          return lines === undefined ? clip(JSON.stringify(value, null, 2)) : clip(lines)
        }
        case "glob": {
          if (!Array.isArray(value.files)) return clip(JSON.stringify(value, null, 2))
          const files = value.files.flatMap((file) => {
            const path = text(file)
            return path === undefined ? [] : [path]
          })
          const truncated = value.clientTruncated === true || value.ripgrepTruncated === true
          const total = numberOf(value.totalFiles)
          const note = truncated ? [`… ${total ?? "more"} files in all`] : []
          return clip([...files, ...note].join("\n") || "No files matched")
        }
        case "mcp": {
          // An MCP result arrives as `content: [{ text: { text } }]`; the
          // texts are the answer, the wrapping is not.
          const texts = mcpTexts(value.content)
          return texts === undefined ? clip(JSON.stringify(value, null, 2)) : clip(texts)
        }
        case "task": {
          const reply = subagentReply(value)
          return clip(reply ?? JSON.stringify(value, null, 2))
        }
        default:
          return clip(JSON.stringify(value, null, 2))
      }
    }
  }
  return clip(stringOf(result) ?? JSON.stringify(result, null, 2))
}

/**
 * A grep result as `rg` would print it. The SDK returns one entry per
 * workspace root, each `content` (matches with a file, a line number and the
 * line), `files` (paths only) or `count` (per-file counts); a `content` hit
 * can arrive without its line (SDK 1.0.31 reports `line: undefined` for a
 * files-only search), so it is written as its file alone.
 */
function grepLines(results: JsonValue | undefined): string | undefined {
  if (!isObject(results)) return undefined
  const lines: string[] = []
  for (const workspace of Object.values(results)) {
    if (!isObject(workspace) || !isObject(workspace.output)) continue
    const output = workspace.output
    if (Array.isArray(output.matches)) {
      for (const match of output.matches) {
        if (!isObject(match)) continue
        const file = text(match.file)
        if (!file) continue
        const line = stringOf(match.line)
        const number = numberOf(match.lineNumber)
        lines.push(
          line === undefined ? file : `${file}:${number === undefined ? "" : `${number}:`} ${line}`
        )
      }
      const total = numberOf(output.totalMatches)
      if (total !== undefined && total > output.matches.length)
        lines.push(`… ${total} matches in all`)
    } else if (Array.isArray(output.files)) {
      for (const file of output.files) {
        const path = text(file)
        if (path !== undefined) lines.push(path)
      }
    } else if (Array.isArray(output.counts)) {
      for (const entry of output.counts) {
        if (!isObject(entry)) continue
        const file = text(entry.file)
        const count = numberOf(entry.count)
        if (file && count !== undefined) lines.push(`${file}: ${count}`)
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No matches"
}

function mcpTexts(content: JsonValue | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const part of content) {
    if (!isObject(part)) continue
    const direct = text(part.text)
    if (direct !== undefined) {
      texts.push(direct)
      continue
    }
    const nested = isObject(part.text) ? text(part.text.text) : undefined
    if (nested !== undefined) texts.push(nested)
  }
  return texts.length > 0 ? texts.join("\n") : undefined
}

function toolDetails(
  name: string,
  args: JsonValue | undefined,
  result: JsonValue | undefined
): ToolDetail[] | undefined {
  const input = isObject(args) ? args : undefined
  const path = text(input?.path)
  const fileText = stringOf(input?.fileText)
  if (name === "write" && path && fileText !== undefined)
    return [{ type: "diff", path, oldText: null, newText: fileText }]
  if (name === "edit" && path) {
    const replace = isObject(input?.strReplace) ? input.strReplace : input
    const oldText = text(replace?.oldText)
    const newText = stringOf(replace?.newText)
    if (oldText !== undefined && newText !== undefined)
      return [{ type: "diff", path, oldText, newText }]
    const value = isObject(result) && isObject(result.value) ? result.value : undefined
    if (value && text(value.diffString) === undefined) return undefined
  }
  const plan = planEntries(name, args)
  return plan ? [{ type: "plan", entries: plan }] : undefined
}

/**
 * Cursor's plan tool gets the shared plan artifact Claude's ExitPlanMode and
 * Codex's plan item already produce: `plan` streams in the arguments, so the
 * block drafts as it fills and is proposed when the call completes.
 */
function proposedPlan(
  id: string,
  name: string,
  args: JsonValue | undefined,
  status: "drafting" | "proposed"
): LiveUpdate | undefined {
  if (name !== "createPlan") return undefined
  const input = isObject(args) ? args : undefined
  const plan = text(input?.plan)
  if (plan === undefined) return undefined
  return { kind: "proposed-plan", id, text: plan, status, replace: true }
}

const TODO_STATUS = new Map([
  ["pending", "pending"],
  ["inProgress", "in_progress"],
  ["in_progress", "in_progress"],
  ["completed", "completed"],
  ["cancelled", "cancelled"],
])

export function planEntries(
  name: string,
  args: JsonValue | undefined
): { content: string; status: string }[] | undefined {
  if (name !== "updateTodos") return undefined
  const input = isObject(args) ? args : undefined
  if (!Array.isArray(input?.todos)) return undefined
  const entries: { content: string; status: string }[] = []
  for (const todo of input.todos) {
    if (!isObject(todo)) continue
    const content = text(todo.content)
    if (!content) continue
    const status = text(todo.status) ?? "pending"
    entries.push({ content, status: TODO_STATUS.get(status) ?? status })
  }
  return entries.length > 0 ? entries : undefined
}
