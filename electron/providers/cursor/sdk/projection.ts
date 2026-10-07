import { basename } from "node:path"
import { z } from "zod"
import type { ToolDetail } from "@mako/sessions"
import { MAX_STREAMED_TOOL_OUTPUT, type LiveUpdate } from "@mako/sessions/live-content"
import { sameJson } from "../../../codex-app-json.js"
import type { JsonValue, SdkDelta, SdkMessage } from "./wire.js"

const MAX_TOOL_TEXT = 32 * 1024

/**
 * The summary Cursor wrote when it compacted the conversation. The SDK
 * turns its `summary` update into a `task` message carrying only text
 * (SDK 1.0.31); a task message with a status is something else.
 */
export function compactionSummary(message: SdkMessage): string | undefined {
  if (message.type !== "task" || message.status !== undefined) return undefined
  const summary = message.text?.trim()
  return summary || undefined
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

  delta(delta: SdkDelta): LiveUpdate[] {
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

  message(message: SdkMessage): LiveUpdate[] {
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
        const started = this.tools.get(message.call_id)
        const updates: LiveUpdate[] = []
        if (!started) {
          this.remember(message.call_id, message.name, message.args)
          updates.push(...this.toolStarted(message.call_id, message.name, message.args))
        }
        const failed = message.status === "error" || resultFailed(message.result)
        const args = message.args ?? started?.input
        const update: LiveUpdate = {
          kind: "tool-update",
          id: message.call_id,
          status: failed ? "failed" : "completed",
        }
        if (started && args !== undefined && !sameJson(started.input, args)) {
          // Full arguments that arrive only at completion still replace the
          // placeholder the row opened with.
          update.title = toolTitle(message.name, args)
          update.input = clip(JSON.stringify(args, null, 2))
        }
        const output = toolOutput(message.name, message.result)
        if (output !== undefined) update.output = output
        const details = toolDetails(message.name, args, message.result)
        if (details) update.details = details
        updates.push(update)
        if (!failed) {
          const plan = planEntries(message.name, args)
          if (plan) updates.push({ kind: "plan", entries: plan })
          const proposal = proposedPlan(message.call_id, message.name, args, "proposed")
          if (proposal) updates.push(proposal)
        }
        this.tools.delete(message.call_id)
        return updates
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

  /**
   * Closes every tool row the run left open when the turn ends.
   *
   * A call the SDK rejects before it runs never gets a terminal `tool_call`
   * message (verified with SDK 1.0.31: a `.cursor/hooks.json` hook answering
   * `deny`, and the `autoReview` classifier Mako no longer enables, each
   * emitted one `running` event and nothing more; the reason went to the
   * model only). Without this the row would spin forever.
   */
  finish(outcome: "finished" | "cancelled" | "error", note: string): LiveUpdate[] {
    const updates: LiveUpdate[] = []
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

const StringSchema = z.string()
const NumberSchema = z.number()

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

/** A string field, including the empty string (a deletion's new text). */
function stringOf(value: JsonValue | undefined): string | undefined {
  const parsed = StringSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** A non-empty string field. */
function text(value: JsonValue | undefined): string | undefined {
  const value_ = stringOf(value)
  return value_ !== undefined && value_.length > 0 ? value_ : undefined
}

function numberOf(value: JsonValue | undefined): number | undefined {
  const parsed = NumberSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
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
