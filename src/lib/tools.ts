import { z } from "zod"
import { normalizeToolOutput } from "@mako/sessions/tool-output"
import { commandExitCode, commandFolder, identifyTool, makoToolWords, toolArguments, toolFacts, type ToolFacts, toolKindWork, type HarnessName, type MakoToolWords, type ToolArguments as CallArguments, type ToolIdentity, type ToolKind, type ToolSource } from "@mako/sessions/tool-identity"
import type { Block, ChatMessage } from "@/lib/types"
import type { ToolCall } from "@/extend/slots"
import type { Entry } from "@mako/sessions/entries"


export { normalizeToolOutput }

type ToolScalar = boolean | number | string | null
type ToolContent = ToolScalar | ToolArguments | ToolContent[]

interface ToolArguments {
  [key: string]: ToolContent | undefined
}

interface ToolEdit {
  oldText: string
  newText: string
}

const identities = new WeakMap<Block | Entry, ToolIdentity>()

/**
 * A call's identity, resolved once per source block: blocks are replaced, not
 * mutated, when a call changes, so a long transcript re-resolves only the call
 * that moved.
 */
export function cachedToolIdentity(owner: Block, source: ToolSource): ToolIdentity {
  const cached = identities.get(owner)
  if (cached) return cached
  const identity = identifyTool(source)
  identities.set(owner, identity)
  return identity
}

/**
 * A call entry's identity, live or saved. The title stands in for a target
 * only when the harness put something in it besides the name, as Grok's server-side search
 * does with `Web search: <query>`; Codex's `mako: app_logs` is the name again.
 */
export function entryToolIdentity(block: Extract<Entry, { type: "tool" }>, harness: string | undefined): ToolIdentity {
  const cached = identities.get(block)
  if (cached) return cached
  const source = { harness, name: block.name, acpKind: block.toolKind, title: block.title, input: block.input }
  let identity = identifyTool(source)
  // A call the model is still writing has only the head of its input: what names it is often there already.
  if (!identity.target && block.status === "pending" && block.input) {
    const args = argumentsSoFar(block.input)
    if (args) identity = identifyTool({ ...source, args })
  }
  const title = (block.title ?? "").trim()
  const named = [identity.name, identity.label, identity.server && identity.tool ? `${identity.server}: ${identity.tool}` : undefined]
  if (!identity.target && title && !named.includes(title)) identity.target = title
  identities.set(block, identity)
  return identity
}

/**
 * The arguments a call's input holds so far, while the model is still
 * writing it: the head of a JSON object, closed where it stops. A string cut
 * mid-way keeps what it has; a key with no value yet is left out. Only for
 * naming a running call: what it does is read from its whole input, once
 * there is one.
 */
const CallArgumentsSchema = z.record(z.string(), z.json())

export function argumentsSoFar(input: string): CallArguments | undefined {
  const text = input.trimStart()
  if (!text.startsWith("{")) return undefined
  // Where a value has just ended, and what was open there; then try the latest that parses.
  const ends: Array<{ at: number; open: string }> = []
  const open: string[] = []
  let inString = false
  let escaped = false
  let key = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') {
        inString = false
        if (!key) ends.push({ at: index + 1, open: open.join("") })
      }
      continue
    }
    if (char === '"') {
      inString = true
      // A string is a key where an object expects one: after `{` or `,` inside an object.
      const before = text.slice(0, index).trimEnd().at(-1)
      key = open.at(-1) === "{" && (before === "{" || before === ",")
    } else if (char === "{" || char === "[") open.push(char)
    else if (char === "}" || char === "]") {
      open.pop()
      ends.push({ at: index + 1, open: open.join("") })
    } else if (/[\d.eEtrufalsn-]/.test(char) && !/[\d.eEtrufalsn-]/.test(text[index + 1] ?? "")) ends.push({ at: index + 1, open: open.join("") })
  }
  const close = (open: string) => [...open].reverse().map((each) => (each === "{" ? "}" : "]")).join("")
  // A string cut mid-escape drops the escape's half.
  const candidates = inString && !key ? [`${escaped ? text.slice(0, -1) : text}"${close(open.join(""))}`] : []
  for (const end of ends.slice(-16).reverse()) candidates.push(text.slice(0, end.at) + close(end.open))
  for (const candidate of candidates) {
    try {
      const parsed = CallArgumentsSchema.safeParse(JSON.parse(candidate))
      if (parsed.success) return parsed.data
    } catch {
      // Cut inside a number or a word: an earlier end parses.
    }
  }
  return undefined
}

/** Arguments as `identifyTool` reads them: the JSON text, or a script's source. */
export function toolInputText<Content>(value: Content): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = stringContent(parseToolContent(value))
  if (text !== undefined) return text
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function parseToolContent<Content>(value: Content): ToolContent | undefined {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return undefined
  }
  if (serialized === undefined) return undefined
  try {
    const content: ToolContent = JSON.parse(serialized)
    return content
  } catch {
    return undefined
  }
}

function isToolArguments(
  content: ToolContent | undefined
): content is ToolArguments {
  return (
    content !== undefined &&
    content !== null &&
    !Array.isArray(content) &&
    Object.prototype.toString.call(content) === "[object Object]"
  )
}

function parseToolArguments<Content>(
  value: Content
): ToolArguments | undefined {
  const content = parseToolContent(value)
  if (isToolArguments(content)) return content
  const nested = stringContent(content)
  if (!nested) return undefined
  try {
    const parsed: ToolContent = JSON.parse(nested)
    return isToolArguments(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function stringContent(content: ToolContent | undefined): string | undefined {
  return Object.prototype.toString.call(content) === "[object String]"
    ? String(content)
    : undefined
}

function parseToolEdit(content: ToolContent): ToolEdit {
  const edit = isToolArguments(content) ? content : undefined
  return {
    oldText:
      stringContent(edit?.oldText) ?? stringContent(edit?.old_string) ?? stringContent(edit?.old_str) ?? "",
    newText:
      stringContent(edit?.newText) ?? stringContent(edit?.new_string) ?? stringContent(edit?.new_str) ?? "",
  }
}

/**
 * Fold `tool` messages back into the assistant turn that called them. The
 * engine-owned log keeps results as separate entries; the transcript reads far
 * better when a call and its result are one row.
 */
export function foldTools(messages: ChatMessage[]): ChatMessage[] {
  const output: ChatMessage[] = []
  for (const message of messages) {
    const previous = output.at(-1)
    if (message.role === "tool" && previous?.role === "assistant") {
      output[output.length - 1] = {
        ...previous,
        blocks: [
          ...previous.blocks,
          {
            type: "toolResult",
            id: message.toolCallId,
            name: message.toolName,
            isError: message.isError,
            attachments: message.blocks.flatMap((block) =>
              block.type === "attachment"
                ? [block]
                : block.type === "toolResult"
                  ? (block.attachments ?? [])
                  : []
            ),
            text: message.blocks
              .map((block) =>
                block.type === "text" || block.type === "toolResult"
                  ? block.text
                  : ""
              )
              .filter(Boolean)
              .join("\n"),
          },
        ],
      }
      continue
    }
    output.push(message)
  }
  return output
}

/** Pair `toolCall` blocks with their `toolResult` blocks, preserving order. */
export function pairTools(blocks: Block[]): ToolCall[] {
  const order: string[] = []
  const byId = new Map<string, ToolCall>()

  for (const block of blocks) {
    if (block.type === "toolCall") {
      const id = block.id || `${block.name}-${order.length}`
      const tool = block.tool ?? cachedToolIdentity(block, { name: block.name, acpKind: block.kind, input: toolInputText(block.arguments) })
      order.push(id)
      byId.set(id, {
        id,
        name: block.name ?? tool.name,
        kind: block.kind,
        tool,
        arguments: tool.input ?? block.arguments,
        pending: true,
        ...(block.at !== undefined && { startedAt: block.at }),
      })
      continue
    }
    if (block.type !== "toolResult") continue
    const id =
      block.id ||
      order.find((key) => byId.get(key)?.pending) ||
      `result-${order.length}`
    const existing = byId.get(id)
    if (existing) {
      existing.details = block.details
      existing.attachments = block.attachments
      existing.result = block.text
      existing.isError = block.isError
      existing.isCanceled = block.isCanceled
      existing.isCutOff = block.isCutOff
      if (block.exitCode !== undefined) existing.exitCode = block.exitCode
      if (block.cwd !== undefined) existing.cwd = block.cwd
      existing.pending = block.streaming === true
      if (block.endedAt !== undefined) existing.endedAt = block.endedAt
      existing.rest = block.rest
    } else {
      order.push(id)
      byId.set(id, {
        id,
        name: block.name ?? "tool",
        tool: cachedToolIdentity(block, { name: block.name }),
        result: block.text,
        attachments: block.attachments,
        details: block.details,
        isError: block.isError,
        isCanceled: block.isCanceled,
        isCutOff: block.isCutOff,
        pending: block.streaming === true,
        rest: block.rest,
      })
    }
  }

  return order.map((id) => byId.get(id)!).filter(Boolean)
}

/** A call of Mako's own `mako` server in its own words, its answer read once it returned well; undefined for any other call. */
export function makoCallWords(call: ToolCall, harness?: HarnessName): MakoToolWords | undefined {
  if (call.tool.server !== "mako" || call.tool.kind !== "mcp" || !call.tool.tool) return undefined
  return makoToolWords(call.tool.tool, toolArguments(toolInputText(call.arguments)), call.isError || call.pending ? undefined : call.result, harness)
}

const facts = new WeakMap<ToolIdentity, ToolFacts>()

/** A call's facts (`toolFacts`), read once per identity, which is resolved once per block. */
export function callFacts(call: ToolCall): ToolFacts {
  const known = facts.get(call.tool)
  if (known) return known
  const input = toolInputText(call.arguments)
  const read = toolFacts(call.tool, toolArguments(input), input)
  facts.set(call.tool, read)
  return read
}

/** "+12 −3" for an edit, "+12" for a write: the lines its arguments add and remove. */
export function changedLinesNote(read: ToolFacts): string | undefined {
  const parts = [read.added ? `+${read.added}` : undefined, read.removed ? `−${read.removed}` : undefined].filter(Boolean)
  return parts.length ? parts.join(" ") : undefined
}

/** What a row adds after its target, in the label face: a read's range, an edit's lines. */
export function factsNote(call: ToolCall): string | undefined {
  const read = callFacts(call)
  return read.range ?? changedLinesNote(read)
}

/** What a call acts on, as a row names it: a patch of several files by how many. */
export function callTarget(call: ToolCall): string {
  const files = callFacts(call).files
  return files ? `${files} files` : toolTarget(call.tool)
}

/**
 * How a settled command exited, when that says something: a failed one's
 * code, or the code of one its harness kept as completed though it exited
 * other than 0 (Cursor's does). The code its harness reported beside the
 * answer comes first, then the one its answer's text states.
 */
export function failedExitCode(call: ToolCall, harness: string | undefined): number | undefined {
  if (call.pending || call.tool.kind !== "shell") return undefined
  const code = call.exitCode ?? commandExitCode(harness, call.tool.tool ?? call.name, call.result)
  return call.isError || (code !== undefined && code !== 0) ? code : undefined
}

export interface ToolWorkSummary {
  tools: number
  /**
   * Edits that went through: calls that change a file, less those that
   * failed. Steps, not files: which files a turn changed, and by how much,
   * is the attribution journal's to say, on the line under the answer.
   */
  edits: number
  commands: number
  reads: number
  searches: number
  skills: number
  agents: number
  plans: number
  other: number
  failed: number
  /** Calls stopped with their turn before they finished; not counted as failed. */
  stopped: number
  /** Calls cut off by a lost process or a quit before they finished; not counted as failed. */
  cutOff: number
}

/** A JSON value with its object keys in order, so two spellings of the same arguments compare equal. */
function ordered(value: ToolContent | undefined): ToolContent | undefined {
  if (Array.isArray(value)) return value.map((item) => ordered(item) ?? null)
  if (!isToolArguments(value)) return stringContent(value)?.trim() ?? value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]))
}

/**
 * What makes two calls the same call: their kind (and the server's tool, for
 * an MCP call, whose kind says nothing of it), and their arguments as one
 * normalized text, a command bare of its shell wrapper together with the
 * folder it ran in. A command's folder is the one its harness reported, else
 * the one its arguments name; one with no folder known is the same only as
 * another with none known.
 */
function callKey(call: ToolCall, harness: string | undefined): string {
  const { kind, server, tool, command } = call.tool
  if (kind === "shell" && command) return `${kind}\0\0${command.trim()}\0${call.cwd ?? argumentKey(call, harness)}`
  return `${kind}\0${server ? `${server}:${tool ?? ""}` : ""}\0${argumentKey(call, harness)}`
}

const argumentKeys = new WeakMap<ToolIdentity, string>()

/** What a call's arguments add to its identity, read once per identity: a command's folder, any other call's arguments whole. */
function argumentKey(call: ToolCall, harness: string | undefined): string {
  const known = argumentKeys.get(call.tool)
  if (known !== undefined) return known
  const input = toolInputText(call.arguments)
  const key = call.tool.kind === "shell" && call.tool.command
    ? commandFolder(harness, call.tool.tool ?? call.name, toolArguments(input)) ?? ""
    : JSON.stringify(ordered(parseToolArguments(call.arguments)) ?? input ?? "")
  argumentKeys.set(call.tool, key)
  return key
}

/** A call that went through: it returned, not failed, and exited 0 by the exit facts its row shows (`failedExitCode`). */
function succeeded(call: ToolCall, harness: string | undefined): boolean {
  return !call.isError && !call.pending && !call.isCutOff && !call.isCanceled && failedExitCode(call, harness) === undefined
}

/**
 * How many of `calls` failed and stay failed: a failure counts unless a
 * later call of the same kind, with the same normalized arguments (and, for
 * a command, the same folder), succeeded. Read newest first, so each failure
 * asks only what came after it.
 */
export function unfixedFailures(calls: readonly ToolCall[], harness?: string): number {
  if (!calls.some((call) => call.isError)) return 0
  const fixed = new Set<string>()
  let failed = 0
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!
    if (call.isError) {
      if (!fixed.has(callKey(call, harness))) failed += 1
    } else if (succeeded(call, harness)) fixed.add(callKey(call, harness))
  }
  return failed
}

/** `harness`, the one that made the calls, reads their exit codes and folders as their rows do. */
export function summarizeToolWork(calls: ToolCall[], harness?: string): ToolWorkSummary {
  let edits = 0
  const counts = { command: 0, read: 0, search: 0, skill: 0, agent: 0, plan: 0, other: 0 }
  const failed = unfixedFailures(calls, harness)
  let stopped = 0
  let cutOff = 0
  for (const call of calls) {
    if (call.isCutOff && call.isCanceled) stopped += 1
    else if (call.isCutOff) cutOff += 1
    const work = toolKindWork(call.tool.kind)
    if (work === "change") {
      if (!call.isError) edits += 1
    } else {
      counts[work] += 1
    }
  }
  return {
    tools: calls.length,
    edits,
    commands: counts.command,
    reads: counts.read,
    searches: counts.search,
    skills: counts.skill,
    agents: counts.agent,
    plans: counts.plan,
    other: counts.other,
    failed,
    stopped,
    cutOff,
  }
}

/** The one argument worth putting on a collapsed row. */
export function primaryArgument<Content>(value: Content): string {
  const args = parseToolArguments(value)
  if (!args) return ""
  for (const key of [
    "command", "cmd", "path", "file_path", "filePath", "notebook_path",
    "file", "filename", "pattern", "glob_pattern", "query", "search_query",
    "url", "uri", "directory", "directory_path", "cwd", "skill", "title",
    "description", "task", "prompt", "tier", "processes", "process", "check",
  ]) {
    const value = args[key]
    const text = stringContent(value)
    if (text?.trim()) return text
    if (Array.isArray(value) && value.length && value.every((item) => stringContent(item) !== undefined))
      return value.join(" ")
  }
  return ""
}

export interface ToolExecutionOutput {
  status: string
  duration?: string
  output: string
}

export function parseToolExecutionOutput(
  text: string | undefined
): ToolExecutionOutput | null {
  const normalized = normalizeToolOutput(text)
  const match =
    /^(Script (?:completed|failed))\nWall time ([^\n]+)\nOutput:\n?([\s\S]*)$/.exec(
      normalized
    )
  return match
    ? {
        status: match[1] ?? "Script completed",
        duration: match[2],
        output: match[3] ?? "",
      }
    : null
}

export function hasToolArguments<Content>(value: Content): boolean {
  return parseToolArguments(value) !== undefined
}

export function formatToolArguments<Content>(value: Content): string {
  const parsed = parseToolArguments(value)
  return parsed ? JSON.stringify(parsed, null, 2) : ""
}

export function argAt<Content>(
  value: Content,
  key: string
): string | undefined {
  return stringContent(parseToolArguments(value)?.[key])
}

export function booleanArgAt<Content>(
  value: Content,
  key: string
): boolean | undefined {
  const result = parseToolArguments(value)?.[key]
  return Object.prototype.toString.call(result) === "[object Boolean]"
    ? Boolean(result)
    : undefined
}

export function reportedSubagentCount(call: ToolCall): number {
  if (call.tool.kind !== "agents" || !call.result) return 0
  try {
    const parsed: ToolContent = JSON.parse(call.result)
    const agents = isToolArguments(parsed) ? parsed.agents : undefined
    return Array.isArray(agents) ? agents.length : 0
  } catch {
    return 0
  }
}

/**
 * Where one subagent call stands, from the call alone: a background agent's
 * call returns at once while the agent works on, so its result's words are
 * what say it still runs. The roster's word, where it has one, comes first.
 */
export type SubagentStanding = "working" | "waiting" | "done" | "failed" | "stopped" | "cut off" | "canceled"

export function subagentStanding(call: ToolCall): SubagentStanding {
  if (call.isError) return "failed"
  if (call.isCutOff) return call.isCanceled ? "stopped" : "cut off"
  if (call.isCanceled) return "canceled"
  const background = booleanArgAt(call.arguments, "background") === true || booleanArgAt(call.arguments, "run_in_background") === true
  if (call.pending || (background && /(?:working|running) in the background|state="running"/i.test(call.result ?? ""))) return "working"
  return "done"
}

export function subagentResultId(
  result: string | undefined
): string | undefined {
  if (!result) return undefined
  return /<subagent\s+[^>]*sessionID="([^"]+)"/.exec(result)?.[1]
}

export function subagentResultText(
  result: string | undefined
): string | undefined {
  if (!result) return undefined
  const error = /<task_error>([\s\S]*?)<\/task_error>/.exec(result)?.[1]
  if (error?.trim()) return error.trim()
  const completed = /<task_result>([\s\S]*?)<\/task_result>/.exec(result)?.[1]
  if (completed?.trim()) return completed.trim()
  const subagent = /<subagent\s+[^>]*>([\s\S]*?)<\/subagent>/.exec(result)?.[1]
  if (subagent?.trim()) return subagent.trim()
  return /^<(?:subagent|task_(?:result|error))\b/i.test(result.trim())
    ? "Subagent result was incomplete."
    : result
}

export function countLines(text?: string) {
  if (!text) return 0
  let lines = 1
  for (const char of text) if (char === "\n") lines += 1
  return lines
}

/** What a write call puts in its file, under whichever key the harness uses. */
export function writtenText(call: ToolCall): string | undefined {
  const args = parseToolArguments(call.arguments)
  return stringContent(args?.content) ?? stringContent(args?.contents) ?? stringContent(args?.file_text) ?? stringContent(args?.text)
}

/** Normalize the edit tool's arguments: a list of edits, or the legacy pair. */
export function editsOf(call: ToolCall): ToolEdit[] {
  const args = parseToolArguments(call.arguments)
  if (!args) return []
  if (Array.isArray(args.edits)) return args.edits.map(parseToolEdit)
  const oldText = stringContent(args.oldText) ?? stringContent(args.old_string)
  const newText = stringContent(args.newText) ?? stringContent(args.new_string)
  return oldText === undefined || newText === undefined
    ? []
    : [{ oldText, newText }]
}

/** Kinds whose target is something you could paste into a terminal or editor. */
export const CODE_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>([
  "shell", "shell-input", "read", "edit", "write", "delete", "move",
  "list", "search", "find", "code", "web-fetch",
])

/** An MCP tool's label without the server, which sits at the row's far end. */
export function toolLabel(tool: ToolIdentity): string {
  const prefix = tool.server ? `${tool.server}: ` : ""
  if (!prefix || !tool.label.startsWith(prefix)) return tool.label
  const name = tool.label.slice(prefix.length)
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** Whether a running call's verb ("Using") says nothing of the tool, so its label follows the verb. */
export function namedByLabel(tool: ToolIdentity): boolean {
  return tool.kind === "mcp" || tool.kind === "other" || tool.kind === "computer" || tool.kind === "skill"
}

/**
 * `text` with every absolute path inside `cwd` read from there:
 * "/work/app/src/guard.ts" in `/work/app` is "src/guard.ts". Paths elsewhere,
 * and the folder itself, stay as they are.
 */
export function relativeTo(cwd: string | undefined, text: string): string {
  if (!cwd || cwd === "/") return text
  const folder = (cwd.endsWith("/") ? cwd : `${cwd}/`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Only where a path begins: at the start, or after a space, a quote, a bracket or `=`.
  return text.replace(new RegExp(`(?<=^|[\\s"'(\\[=:,])${folder}`, "g"), "")
}

/** The target, unless it only repeats the tool's own name. */
export function toolTarget(tool: ToolIdentity): string {
  const target = tool.target ?? ""
  return tool.server && tool.tool && target === `${tool.server}: ${tool.tool}` ? "" : target
}
