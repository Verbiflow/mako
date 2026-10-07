import { normalizeToolOutput } from "@mako/sessions/tool-output"
import { identifyTool, toolKindWork, type ToolIdentity, type ToolSource } from "@mako/sessions/tool-identity"
import type { Block, ChatMessage, EntryBlock } from "@/lib/types"
import type { ToolCall } from "@/extend/slots"
import type { LiveBlock } from "@mako/sessions/live-content"

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

const identities = new WeakMap<Block | EntryBlock | LiveBlock, ToolIdentity>()

/**
 * A call's identity, resolved once per source block: blocks are replaced, not
 * mutated, when a call changes, so a long transcript re-resolves only the call
 * that moved.
 */
export function cachedToolIdentity(owner: Block | EntryBlock, source: ToolSource): ToolIdentity {
  const cached = identities.get(owner)
  if (cached) return cached
  const identity = identifyTool(source)
  identities.set(owner, identity)
  return identity
}

/**
 * A live call's identity. The title stands in for a target only when the
 * harness put something in it besides the name, as Grok's server-side search
 * does with `Web search: <query>`; Codex's `mako: app_logs` is the name again.
 */
export function liveToolIdentity(block: Extract<LiveBlock, { type: "tool" }>, harness: string | undefined): ToolIdentity {
  const cached = identities.get(block)
  if (cached) return cached
  const identity = identifyTool({ harness, name: block.name, acpKind: block.toolKind, title: block.title, input: block.input })
  const title = block.title.trim()
  const named = [identity.name, identity.label, identity.server && identity.tool ? `${identity.server}: ${identity.tool}` : undefined]
  if (!identity.target && title && !named.includes(title)) identity.target = title
  identities.set(block, identity)
  return identity
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
      existing.pending = block.streaming === true
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

export interface ToolWorkSummary {
  tools: number
  changedFiles: number
  commands: number
  reads: number
  searches: number
  skills: number
  agents: number
  plans: number
  other: number
  failed: number
  /** Calls the turn's end left without a result; not counted as failed. */
  cutOff: number
}

export function summarizeToolWork(calls: ToolCall[]): ToolWorkSummary {
  const changedFiles = new Set<string>()
  let unlocatedChanges = 0
  const counts = { command: 0, read: 0, search: 0, skill: 0, agent: 0, plan: 0, other: 0 }
  let failed = 0
  let cutOff = 0
  for (const call of calls) {
    if (call.isError) failed += 1
    if (call.isCutOff) cutOff += 1
    const work = toolKindWork(call.tool.kind)
    if (work === "change") {
      if (call.tool.path) changedFiles.add(call.tool.path)
      else unlocatedChanges += 1
    } else {
      counts[work] += 1
    }
  }
  return {
    tools: calls.length,
    changedFiles: changedFiles.size + unlocatedChanges,
    commands: counts.command,
    reads: counts.read,
    searches: counts.search,
    skills: counts.skill,
    agents: counts.agent,
    plans: counts.plan,
    other: counts.other,
    failed,
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
