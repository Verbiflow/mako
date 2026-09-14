import { normalizeToolOutput } from "@mako/sessions/tool-output"
import type { Block, ChatMessage } from "@/lib/types"
import type { ToolCall } from "@/extend/slots"

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

const TOOL_LABELS = new Map([
  ["bash", "Shell"],
  ["Bash", "Shell"],
  ["shell", "Shell"],
  ["Shell", "Shell"],
  ["exec_command", "Shell"],
  ["edit", "Edit"],
  ["Edit", "Edit"],
  ["write", "Write"],
  ["Write", "Write"],
  ["read", "Read"],
  ["Read", "Read"],
  ["grep", "Search"],
  ["Grep", "Search"],
  ["rg", "Search"],
  ["find", "Find"],
  ["glob", "Find"],
  ["Glob", "Find"],
  ["ls", "List"],
  ["webfetch", "Web"],
  ["WebFetch", "Web"],
  ["websearch", "Web search"],
  ["WebSearch", "Web search"],
  ["apply_patch", "Edit"],
  ["ReadFile", "Read"],
  ["read_file", "Read"],
  ["web_search", "Web search"],
  ["list_agents", "Agents"],
  ["wait_agent", "Wait for agent"],
  ["send_message", "Message agent"],
  ["read_subagent", "Read agent"],
  ["Agent", "Agent"],
  ["Subagent", "Agent"],
  ["subagent", "Agent"],
  ["Task", "Agent"],
  ["task", "Agent"],
  ["run_subagent", "Background agent"],
  ["AwaitShell", "Wait for shell"],
  ["wait", "Wait for command"],
  ["write_stdin", "Terminal input"],
  ["TodoWrite", "Plan"],
  ["todo_write", "Plan"],
  ["update_plan", "Plan"],
  ["updateTodos", "Plan"],
  ["CreatePlan", "Plan"],
  ["createPlan", "Plan"],
  ["askQuestion", "Question"],
  ["AskQuestion", "Question"],
  ["AskUserQuestion", "Question"],
  ["generateImage", "Generate image"],
  ["TaskCreate", "Create task"],
  ["TaskUpdate", "Update task"],
  ["ToolSearch", "Find tool"],
  ["ScheduleWakeup", "Schedule"],
  ["delete", "Delete"],
  ["move", "Move"],
  ["think", "Think"],
  ["switch_mode", "Switch mode"],
])
/**
 * ACP names a tool by what it does (`execute`, `search`), Devin by its
 * inference name (`exec`), Claude and history by the tool's own name. The
 * transcript keys icons, labels and views on names, so every live source
 * lands on the same vocabulary here.
 */
const LIVE_TOOL_KINDS = new Map([
  ["execute", "bash"],
  ["exec", "bash"],
  ["shell", "bash"],
  ["command", "bash"],
  ["read", "read"],
  ["edit", "edit"],
  ["write", "write"],
  ["search", "grep"],
  ["fetch", "webfetch"],
  ["delete", "delete"],
  ["move", "move"],
  ["think", "think"],
  ["switch_mode", "switch_mode"],
])

/** Titles that only restate the kind carry no identity of their own. */
const WEAK_TITLES = /^(tool|command|other|shell|execute|search|fetch|read|edit)$/i

export function liveToolName(kind: string | undefined, title: string): string {
  if (kind) {
    const mapped = LIVE_TOOL_KINDS.get(kind.toLowerCase())
    if (mapped) return mapped
    if (kind !== "other") return kind
  }
  // `other` and no kind at all: the title is the only name there is, and only
  // when it is a name ("read_file", "server: tool") rather than a sentence.
  const candidate = title.trim()
  if (candidate && !WEAK_TITLES.test(candidate) && /^[\w.:-]+(?:\s[\w.-]+)?$/.test(candidate))
    return candidate.replace(/:\s/, ".")
  return kind ?? "tool"
}

const NORMALIZED_TOOL_LABELS = new Map(
  [...TOOL_LABELS].map(([name, label]) => [name.toLowerCase(), label])
)

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
      stringContent(edit?.oldText) ?? stringContent(edit?.old_string) ?? "",
    newText:
      stringContent(edit?.newText) ?? stringContent(edit?.new_string) ?? "",
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
      order.push(id)
      byId.set(id, {
        id,
        name: block.name ?? "tool",
        arguments: block.arguments,
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
      existing.pending = block.streaming === true
      existing.rest = block.rest
    } else {
      order.push(id)
      byId.set(id, {
        id,
        name: block.name ?? "tool",
        result: block.text,
        attachments: block.attachments,
        details: block.details,
        isError: block.isError,
        isCanceled: block.isCanceled,
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
}

export function summarizeToolWork(calls: ToolCall[]): ToolWorkSummary {
  const changedFiles = new Set<string>()
  let unlocatedChanges = 0
  let commands = 0
  let reads = 0
  let searches = 0
  let skills = 0
  let agents = 0
  let plans = 0
  let other = 0
  let failed = 0
  for (const call of calls) {
    const name = call.name.toLowerCase()
    if (call.isError) failed += 1
    if (isSubagentLaunch(call)) {
      agents += 1
      continue
    }
    if (["edit", "multiedit", "apply_patch", "write", "delete", "move"].includes(name)) {
      const path = primaryArgument(call.arguments)
      if (path) changedFiles.add(path)
      else unlocatedChanges += 1
    } else if (["bash", "shell", "exec_command"].includes(name)) {
      commands += 1
    } else if (["read", "readfile", "read_file"].includes(name)) {
      reads += 1
    } else if (
      [
        "grep",
        "rg",
        "find",
        "glob",
        "webfetch",
        "websearch",
        "web_search",
        "toolsearch",
      ].includes(name)
    ) {
      searches += 1
    } else if (name === "skill") {
      skills += 1
    } else if (
      ["todowrite", "todo_write", "update_plan", "updatetodos", "plan", "createplan", "taskcreate", "taskupdate"].includes(name)
    ) {
      plans += 1
    } else {
      other += 1
    }
  }
  return {
    tools: calls.length,
    changedFiles: changedFiles.size + unlocatedChanges,
    commands,
    reads,
    searches,
    skills,
    agents,
    plans,
    other,
    failed,
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
    "description", "task", "prompt",
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

export const SUBAGENT_LAUNCH_TOOLS = [
  "Agent",
  "Subagent",
  "Task",
  "task",
  "run_subagent",
  "spawn_agent",
] as const

export const SUBAGENT_CONTROL_TOOLS = [
  "subagent",
  "read_subagent",
  "send_input",
  "close_agent",
  "send_message",
  "list_agents",
  "wait_agent",
] as const

export const SUBAGENT_TOOLS = [
  ...SUBAGENT_LAUNCH_TOOLS,
  ...SUBAGENT_CONTROL_TOOLS,
] as const

export function isSubagentLaunch(call: ToolCall): boolean {
  const name = call.name.toLowerCase()
  if (
    SUBAGENT_LAUNCH_TOOLS.some((candidate) => candidate.toLowerCase() === name)
  ) {
    return true
  }
  return (
    name === "subagent" &&
    Boolean(
      argAt(call.arguments, "task") ??
      argAt(call.arguments, "prompt") ??
      argAt(call.arguments, "description") ??
      argAt(call.arguments, "agent_id") ??
      argAt(call.arguments, "agentId")
    )
  )
}

export function isSubagentTool(name: string): boolean {
  const normalized = name.toLowerCase()
  return SUBAGENT_TOOLS.some(
    (candidate) => candidate.toLowerCase() === normalized
  )
}

export function reportedSubagentCount(call: ToolCall): number {
  if (call.name !== "list_agents" || !call.result) return 0
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

export function toolLabel(name: string): string {
  const label = NORMALIZED_TOOL_LABELS.get(name.toLowerCase())
  if (label) return label
  if (name.startsWith("mako_macos_")) {
    return `macOS ${name.slice("mako_macos_".length).replaceAll("_", " ")}`
  }
  if (name.startsWith("browser_")) {
    return `Browser ${name.slice("browser_".length).replaceAll("_", " ")}`
  }
  return name
}

export function countLines(text?: string) {
  if (!text) return 0
  let lines = 1
  for (const char of text) if (char === "\n") lines += 1
  return lines
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
