import { z } from "zod"
import { VOCABULARIES } from "./harnesses/index.js"
import type { ArgumentWrapper, FieldKeys, McpNaming, NativeTool, ScriptWrapper, ToolField } from "./harnesses/vocabulary.js"
import { makoToolWords } from "./mako-tools.js"

export { isWordedMakoTool, MAKO_TOOL_NAMES, makoToolGroup, makoToolWords, type HarnessName, type MakoToolGroup, type MakoToolWords } from "./mako-tools.js"

/**
 * What a tool call is, whichever harness made it.
 *
 * Every harness names its tools its own way (`Bash`, `exec_command`,
 * `run_terminal_command`, `exec`), wraps other tools in its own way (Grok's
 * `use_tool`, Cursor's `CallDynamicTool`, Codex's and OpenCode's code-mode
 * scripts) and spells arguments its own way (`path`, `file_path`,
 * `target_file`). Each harness declares that once, in its vocabulary under
 * `harnesses/`, and `identifyTool` resolves any call to one shared kind,
 * label and target. The transcript, the work summary and the activity line
 * read the identity, never a native name, so a harness's new tool needs one
 * line in its vocabulary and nothing in the desk. The names below are the
 * fallback for a tool a harness hasn't declared and for a harness with no
 * vocabulary.
 *
 * `npx tsx scripts/audit-native-tools.ts` lists the names in this machine's
 * own stores that resolve to `other`.
 */

export const TOOL_KINDS = [
  "shell", "shell-output", "shell-input", "shell-stop",
  "read", "edit", "write", "delete", "move", "list", "search", "find",
  "web-fetch", "web-search",
  "code", "computer",
  "agent", "agent-message", "agent-wait", "agents",
  "todo", "plan", "plan-exit", "question", "review",
  "tool-search", "skill", "mcp", "mode", "think", "image", "wait",
  "other",
] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

/** Which count a call adds to a turn's folded summary. */
export type ToolWork = "change" | "command" | "read" | "search" | "skill" | "agent" | "plan" | "other"

/** What the activity line says the agent is doing while the call runs. */
export type ToolActivity = "editing" | "searching" | "executing"

interface KindInfo {
  label: string
  work: ToolWork
  activity: ToolActivity
}

const KINDS = {
  shell: { label: "Shell", work: "command", activity: "executing" },
  "shell-output": { label: "Shell output", work: "other", activity: "executing" },
  "shell-input": { label: "Terminal input", work: "other", activity: "executing" },
  "shell-stop": { label: "Stop shell", work: "other", activity: "executing" },
  read: { label: "Read", work: "read", activity: "searching" },
  edit: { label: "Edit", work: "change", activity: "editing" },
  write: { label: "Write", work: "change", activity: "editing" },
  delete: { label: "Delete", work: "change", activity: "editing" },
  move: { label: "Move", work: "change", activity: "editing" },
  list: { label: "List", work: "read", activity: "searching" },
  search: { label: "Search", work: "search", activity: "searching" },
  find: { label: "Find", work: "search", activity: "searching" },
  "web-fetch": { label: "Web", work: "search", activity: "searching" },
  "web-search": { label: "Web search", work: "search", activity: "searching" },
  code: { label: "Script", work: "command", activity: "executing" },
  computer: { label: "Computer", work: "other", activity: "executing" },
  agent: { label: "Agent", work: "agent", activity: "executing" },
  "agent-message": { label: "Message agent", work: "other", activity: "executing" },
  "agent-wait": { label: "Wait for agent", work: "other", activity: "executing" },
  agents: { label: "Agents", work: "other", activity: "executing" },
  todo: { label: "To-dos", work: "plan", activity: "executing" },
  plan: { label: "Plan", work: "plan", activity: "executing" },
  "plan-exit": { label: "Plan ready", work: "plan", activity: "executing" },
  question: { label: "Question", work: "other", activity: "executing" },
  review: { label: "Code review", work: "other", activity: "executing" },
  "tool-search": { label: "Find tool", work: "search", activity: "searching" },
  skill: { label: "Skill", work: "skill", activity: "executing" },
  mcp: { label: "Tool", work: "other", activity: "executing" },
  mode: { label: "Switch mode", work: "other", activity: "executing" },
  think: { label: "Think", work: "other", activity: "executing" },
  image: { label: "Generate image", work: "other", activity: "executing" },
  wait: { label: "Wait", work: "other", activity: "executing" },
  other: { label: "Tool", work: "other", activity: "executing" },
} as const satisfies { readonly [Kind in ToolKind]: KindInfo }

export function toolKindLabel(kind: ToolKind): string {
  return KINDS[kind].label
}

export function toolKindWork(kind: ToolKind): ToolWork {
  return KINDS[kind].work
}

export function toolKindActivity(kind: ToolKind): ToolActivity {
  return KINDS[kind].activity
}

export interface ToolIdentity {
  kind: ToolKind
  /** The name the harness recorded. */
  name: string
  /** What the row calls it. */
  label: string
  /** The MCP server a tool came from, when it came from one. */
  server?: string
  /** The tool that actually ran, when `name` wrapped it (`use_tool`, a script). */
  tool?: string
  /** The wrapper's own name, when `tool` ran inside one. */
  via?: string
  /** The one argument the collapsed row shows. */
  target?: string
  path?: string
  command?: string
  pattern?: string
  query?: string
  url?: string
  /** The arguments the tool ran with, as JSON, when they came from inside a wrapper. */
  input?: string
  /** A Mako tool's words while it runs and once it returned, from its arguments alone (`makoToolWords`); `label` names it. */
  running?: string
  done?: string
}

export interface ToolSource {
  /** The harness that made the call; unknown harnesses get the shared vocabulary. */
  harness?: string
  /** The native tool name, when the source has one. */
  name?: string
  /** The call's arguments: JSON for most tools, source text for a script. */
  input?: string
  /** ACP's kind for the call (`execute`, `read`), for a name no vocabulary knows. */
  acpKind?: string
  /** The display title the harness sent, the last resort for a name. */
  title?: string
  /** The arguments already parsed, which spares parsing `input` again; `input` is still what a script wrapper reads. */
  args?: ToolArguments
}

type Field = ToolField
type ToolSpec = NativeTool
type Vocabulary = ReadonlyMap<string, ToolSpec>

const SHARED_KEYS = {
  path: [
    "path", "file_path", "filePath", "target_file", "notebook_path", "target_notebook", "file", "filename",
    "absolute_path", "relative_workspace_path", "target_directory", "directory", "directory_path", "dir_path", "paths",
  ],
  command: ["command", "cmd"],
  pattern: ["pattern", "glob_pattern", "regex", "glob"],
  query: ["query", "search_query", "q"],
  url: ["url", "uri"],
  description: ["description", "title", "task_name", "subject", "summary"],
  prompt: ["prompt", "task", "message"],
  code: ["code", "source", "script"],
} as const satisfies { readonly [Name in Field]: readonly string[] }

function vocabulary(entries: readonly (readonly [readonly string[], ToolSpec])[]): Vocabulary {
  const map = new Map<string, ToolSpec>()
  for (const [names, spec] of entries) for (const name of names) map.set(name.toLowerCase(), spec)
  return map
}

/**
 * The tool block Mako draws for an agent's plan, ACP's `plan` update: the
 * to-do list itself rather than a call that wrote it. No harness names it.
 */
export const AGENT_PLAN_TOOL = "Plan"

/** Whether Mako drew this block itself, so no harness's vocabulary declares its name. */
export function isDrawnByMako(name: string): boolean {
  return name === AGENT_PLAN_TOOL
}

/** Names every harness, or several, use for the same tool. */
const SHARED = vocabulary([
  [["bash", "shell", "sh", "exec_command", "run_terminal_cmd", "run_terminal_command", "local_shell", "monitor"], { kind: "shell" }],
  [["bashoutput", "awaitshell", "get_output", "read_output"], { kind: "shell-output" }],
  [["write_stdin"], { kind: "shell-input" }],
  [["killshell", "killbash", "kill_shell", "kill_command", "kill_command_or_subagent"], { kind: "shell-stop" }],
  [["read", "readfile", "read_file", "notebookread", "view_image"], { kind: "read" }],
  [["edit", "multiedit", "strreplace", "applypatch", "strictreplace", "str_replace", "search_replace", "edit_file", "apply_patch", "patch", "notebookedit", "editnotebook"], { kind: "edit" }],
  [["write", "write_file", "create_file"], { kind: "write" }],
  [["delete", "delete_file"], { kind: "delete" }],
  [["move", "rename", "move_file"], { kind: "move" }],
  [["ls", "list", "list_dir", "list_files", "listdir"], { kind: "list" }],
  [["grep", "rg", "grep_search", "codebase_search", "semanticsearch", "codesearch"], { kind: "search" }],
  [["glob", "find", "file_search"], { kind: "find" }],
  [["webfetch", "web_fetch"], { kind: "web-fetch" }],
  [["websearch", "web_search"], { kind: "web-search" }],
  [["task", "agent", "subagent", "run_subagent", "spawn_agent", "spawn_subagent"], { kind: "agent" }],
  [["send_message", "send_input", "followup_task"], { kind: "agent-message" }],
  [["close_agent"], { kind: "agent-message", label: "Close agent" }],
  [["wait_agent", "read_subagent"], { kind: "agent-wait" }],
  [["list_agents"], { kind: "agents" }],
  [["todowrite", "todo_write", "todoread", "todo_read", "update_plan", "updatetodos", "taskcreate", "taskupdate", "tasklist", AGENT_PLAN_TOOL], { kind: "todo" }],
  [["createplan", "write_plan"], { kind: "plan" }],
  [["exitplanmode", "exit_plan_mode"], { kind: "plan-exit" }],
  [["askquestion", "askuserquestion", "ask_user_question", "question", "request_user_input", "request_user_input_async", "requestuserinput", "awaituserinput", "humaninput", "promptuser"], { kind: "question" }],
  [["toolsearch", "search_tool", "getdynamictools", "mcp_list_tools", "listmcpresourcestool"], { kind: "tool-search" }],
  [["skill"], { kind: "skill" }],
  [["generateimage", "generate_image"], { kind: "image" }],
  [["switchmode", "switch_mode"], { kind: "mode" }],
  [["think"], { kind: "think" }],
  [["sleep", "schedulewakeup"], { kind: "wait" }],
  [["readlints", "read_lints"], { kind: "read", label: "Lints" }],
])

/** Each harness's declared tools, by lower-cased name and alias. */
const HARNESSES: ReadonlyMap<string, Vocabulary> = new Map(VOCABULARIES.map((declared) => {
  const names = new Map<string, ToolSpec>()
  for (const [name, tool] of Object.entries<NativeTool>(declared.tools))
    for (const spelling of [name, ...(tool.aliases ?? [])]) names.set(spelling.toLowerCase(), tool)
  return [declared.harness, names]
}))

/** How each harness names MCP tools; a harness with no vocabulary may use any form but Cursor's. */
const MCP_NAMING: ReadonlyMap<string, readonly McpNaming[]> = new Map(VOCABULARIES.map((declared) => [declared.harness, declared.mcp]))
const ANY_MCP_NAMING: readonly McpNaming[] = ["s__t", "s: t", "s.t"]

/** Mako's own `mako` server is worded by tool in `mako-tools.ts` (`makoToolWords`), for every surface at once. */
const MAKO_SERVER = "mako"

/** Local Control's servers; their programs are the computer acting. */
const COMPUTER_SERVERS = new Set(["mako-computer", "mako-control", "mako_computer", "mako_control", "mako-local-control", "mako-browser-use"])

/** ACP describes a call by what it does; the fallback when its name is unknown. */
const ACP_KINDS: ReadonlyMap<string, ToolKind> = new Map([
  ["execute", "shell"],
  ["read", "read"],
  ["edit", "edit"],
  ["delete", "delete"],
  ["move", "move"],
  ["search", "search"],
  ["fetch", "web-fetch"],
  ["think", "think"],
  ["switch_mode", "mode"],
])

const Json = z.json()
type JsonValue = z.infer<typeof Json>
const Arguments = z.record(z.string(), Json)
type JsonRecord = z.infer<typeof Arguments>
/** A call's arguments as an object of JSON values. */
export type ToolArguments = JsonRecord
const Text = z.union([z.string(), z.number().transform(String)])
const Texts = z.array(z.string())

function parseArguments(input: string | undefined): JsonRecord | undefined {
  if (!input) return undefined
  const trimmed = input.trimStart()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const parsed = Arguments.safeParse(JSON.parse(trimmed))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** A call's arguments as `identifyTool` reads them: a JSON object's fields, or undefined for anything else. */
export function toolArguments(input: string | undefined): ToolArguments | undefined {
  return parseArguments(input)
}

function sourceArguments(source: ToolSource): JsonRecord | undefined {
  return source.args ?? parseArguments(source.input)
}

function textOf(value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = Text.safeParse(value)
  if (text.success) return text.data.trim() || undefined
  const parts = Texts.safeParse(value)
  return parts.success && parts.data.length ? parts.data.join(" ") : undefined
}

function field(args: JsonRecord | undefined, name: Field, keys?: FieldKeys): string | undefined {
  if (!args) return undefined
  for (const key of keys?.[name] ?? SHARED_KEYS[name]) {
    const value = textOf(args[key])
    if (value) return value
  }
  return undefined
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").map((line) => line.trim()).find(Boolean)
}

// The command starts at its first non-space, so the spaces before it are read one way only: a long run of them can't
// make the match try every split (polynomial backtracking on a command the harness sent).
const SHELL_WRAPPER = /^(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(\S[\s\S]*)$/

/**
 * The command inside `/bin/zsh -lc '…'`, which is how Codex records every
 * command it runs. Only a wrapper whose quoting closes exactly at the end is
 * opened; anything else is shown as recorded.
 */
export function bareCommand(command: string): string {
  const rest = SHELL_WRAPPER.exec(command.trim())?.[1]
  if (!rest) return command
  const quote = rest[0]
  if (quote === "'") {
    const inner = /^'((?:[^']|'\\'')*)'$/.exec(rest)?.[1]
    return inner === undefined ? command : inner.replaceAll("'\\''", "'")
  }
  if (quote === '"') {
    const inner = /^"((?:[^"\\]|\\.)*)"$/.exec(rest)?.[1]
    return inner === undefined ? command : inner.replace(/\\(["\\$`])/g, "$1")
  }
  return rest
}

/** `run_terminal_command` → "Run terminal command", `askQuestion` → "Ask question". */
export function humanToolName(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : name
}

interface McpName {
  server: string
  tool: string
}

const MCP_FORMS = {
  "s__t": /^([\w-]+)__(\w.*)$/,
  "s: t": /^([\w-]+): (.+)$/,
  "s.t": /^([\w-]+)\.(\w+)$/,
  "s-t": /^([\w-]+)-(\w+)$/,
} as const satisfies Record<McpNaming, RegExp>

/**
 * The MCP server and tool behind a name in the forms the harness uses
 * (`HarnessVocabulary.mcp`), or Mako's own `mcp__mako__app_start`.
 */
function mcpName(name: string, forms: readonly McpNaming[]): McpName | undefined {
  const own = makoMcpName(name)
  if (own) return own
  const match = forms.reduce<RegExpExecArray | null>((found, form) => found ?? MCP_FORMS[form].exec(name), null)
  return match ? { server: match[1]!, tool: match[2]! } : undefined
}

/**
 * `mcp__<server>__<tool>`: the server ends at the first `__` after one
 * character of it, and both parts are on one line. Read by position, not by
 * a lazy pattern, so a long name of repeated `__` costs one pass.
 */
function makoMcpName(name: string): McpName | undefined {
  if (!name.startsWith("mcp__") || /[\n\r\u2028\u2029]/.test(name)) return undefined
  const split = name.indexOf("__", "mcp__".length + 1)
  if (split < 0 || split + 2 >= name.length) return undefined
  return { server: name.slice("mcp__".length, split), tool: name.slice(split + 2) }
}

function mcpForms(harness: string | undefined): readonly McpNaming[] {
  return (harness ? MCP_NAMING.get(harness) : undefined) ?? ANY_MCP_NAMING
}

function specFor(harness: string | undefined, name: string): ToolSpec | undefined {
  const key = name.toLowerCase()
  return (harness ? HARNESSES.get(harness)?.get(key) : undefined) ?? SHARED.get(key)
}

/** Resolve one call to its shared identity. Pure; callers cache by block. */
export function identifyTool(source: ToolSource): ToolIdentity {
  const acpKind = source.acpKind?.trim()
  const acp = acpKind ? ACP_KINDS.get(acpKind.toLowerCase()) : undefined
  // Before live blocks carried `name`, `toolKind` held the native name for
  // every harness but ACP; retained blocks still do.
  const legacy = acpKind && !acp && acpKind !== "other" ? acpKind : undefined
  const name = source.name?.trim() || legacy || nameFromTitle(source.title)
  if (!name) return describe(source, acpKind || "tool", { kind: acp ?? "other" })
  const spec = specFor(source.harness, name)
  if (spec?.wraps) {
    const inner = unwrap(source, name, spec.wraps)
    if (inner) return inner
  }
  if (spec) return describe(source, name, spec)
  const mcp = mcpName(name, mcpForms(source.harness))
  if (mcp) return describeMcp(source, name, mcp, sourceArguments(source))
  return describe(source, name, { kind: acp ?? "other", label: acp ? undefined : humanToolName(name) })
}

/** A title is a name only when it reads like one (`read_file`, `mako: app_start`), not a phrase. */
function nameFromTitle(title: string | undefined): string | undefined {
  const candidate = title?.trim()
  if (!candidate || /^(tool|command|other|shell|execute|search|fetch|read|edit)$/i.test(candidate)) return undefined
  return /^[\w.-]+$/.test(candidate) || /^[\w-]+: \w+$/.test(candidate) ? candidate : undefined
}

function describe(source: ToolSource, name: string, spec: ToolSpec, args = sourceArguments(source)): ToolIdentity {
  const identity: ToolIdentity = { kind: spec.kind, name, label: spec.label ?? KINDS[spec.kind].label }
  fill(identity, spec.kind, args, spec.keys, source.input)
  return identity
}

function describeMcp(source: ToolSource, name: string, mcp: McpName, args: JsonRecord | undefined): ToolIdentity {
  const server = mcp.server
  const builtin = specFor(source.harness, mcp.tool)
  if (server === MAKO_SERVER) {
    const words = makoToolWords(mcp.tool, args)
    return { kind: "mcp", name, label: words.label, server, tool: mcp.tool, running: words.running, done: words.done }
  }
  if (COMPUTER_SERVERS.has(server)) {
    const identity: ToolIdentity = { kind: "computer", name, label: computerLabel(mcp.tool), server, tool: mcp.tool }
    fill(identity, "computer", args, undefined, undefined)
    return identity
  }
  if (builtin && !builtin.wraps) {
    const identity = describe(source, name, builtin, args)
    identity.server = server
    identity.tool = mcp.tool
    return identity
  }
  const identity: ToolIdentity = { kind: "mcp", name, label: `${server}: ${humanToolName(mcp.tool).toLowerCase()}`, server, tool: mcp.tool }
  identity.target = firstScalar(args)
  return identity
}

function computerLabel(tool: string): string {
  const action = tool.replace(/^mako_(?:browser|computer|control)_/, "")
  if (action === "js" || action === "exec") return "Computer"
  if (action === "help") return "Computer reference"
  return `Computer: ${humanToolName(action).toLowerCase()}`
}

function firstScalar(args: JsonRecord | undefined): string | undefined {
  if (!args) return undefined
  for (const value of Object.values(args)) {
    const text = textOf(value)
    if (text) return firstLine(text)
  }
  return undefined
}

function fill(identity: ToolIdentity, kind: ToolKind, args: JsonRecord | undefined, keys: FieldKeys | undefined, input: string | undefined): void {
  const path = field(args, "path", keys) ?? (kind === "edit" ? patchedPath(args, input) : undefined)
  const command = field(args, "command", keys)
  const pattern = field(args, "pattern", keys)
  const query = field(args, "query", keys)
  const url = field(args, "url", keys)
  if (path) identity.path = path
  if (command) identity.command = bareCommand(command)
  if (pattern) identity.pattern = pattern
  if (query) identity.query = query
  if (url) identity.url = url
  const target = targetFor(kind, identity, args, keys, input)
  if (target) identity.target = target
}

/** What a row says of a call after its target: the lines a read asked for, and the lines and files a change touches. */
export interface ToolFacts {
  /** ":120–180", or ":120+" to the end. */
  range?: string
  added?: number
  removed?: number
  /** The files a patch touches, when it touches more than one. */
  files?: number
}

/**
 * A call's facts, from its arguments (`args`, or `input` when they aren't a
 * JSON object, as a raw patch isn't). Only a row that draws them reads them,
 * so a decoder identifying every call never counts a patch's lines.
 */
export function toolFacts(identity: Pick<ToolIdentity, "kind">, args: ToolArguments | undefined, input: string | undefined): ToolFacts {
  if (identity.kind === "read") {
    const range = readRange(args)
    return range ? { range } : {}
  }
  if (identity.kind !== "edit" && identity.kind !== "write") return {}
  const lines = changedLines(identity.kind, args, input)
  if (!lines) return {}
  return { added: lines.added, removed: lines.removed, ...lines.files > 1 && { files: lines.files } }
}

const Whole = z.union([z.number().int(), z.string().trim().regex(/^-?\d+$/).transform(Number)])

function numberOf(value: JsonValue | undefined): number | undefined {
  return Whole.safeParse(value).data
}

/**
 * The lines a read asked for, as its row says them: ":120–180", or ":120+"
 * to the end. Every harness's read takes a first line and a count
 * (`offset`, `limit`), some a first and last (`start_line`, `end_line`,
 * `view_range`); a negative first line counts from the end and isn't shown.
 */
function readRange(args: JsonRecord | undefined): string | undefined {
  if (!args) return undefined
  const range = Array.isArray(args["view_range"]) ? args["view_range"] : undefined
  const first = numberOf(args["offset"]) ?? numberOf(args["start_line"]) ?? numberOf(args["line_start"]) ?? numberOf(range?.[0])
  const limit = numberOf(args["limit"]) ?? numberOf(args["max_lines"])
  const last = numberOf(args["end_line"]) ?? numberOf(args["line_end"]) ?? numberOf(range?.[1])
  if (first === undefined && limit === undefined && last === undefined) return undefined
  if (first !== undefined && first < 0) return undefined
  const from = Math.max(1, first ?? 1)
  const to = last !== undefined && last >= from ? last : limit !== undefined && limit > 0 ? from + limit - 1 : undefined
  return to === undefined ? `:${from}+` : `:${from}–${to}`
}

const OLD_KEYS = ["old_string", "oldString", "old_str", "oldText"] as const
const NEW_KEYS = ["new_string", "newString", "new_str", "newText"] as const
const CONTENT_KEYS = ["content", "contents", "file_text", "fileText", "text"] as const

function lineCount(text: string): number {
  if (!text) return 0
  const lines = text.split("\n").length
  return text.endsWith("\n") ? lines - 1 : lines
}

/** The lines one replacement removes and adds, past the lines its old and new text share at either end. */
function replacedLines(before: string, after: string): Omit<ChangedLines, "files"> {
  const left = before ? before.split("\n") : []
  const right = after ? after.split("\n") : []
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1
  let tail = 0
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1
  return { added: right.length - head - tail, removed: left.length - head - tail }
}

function firstText(args: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = z.string().safeParse(args[key])
    if (value.success) return value.data
  }
  return undefined
}

/** The lines a change adds and removes, and the files it touches. */
interface ChangedLines {
  added: number
  removed: number
  files: number
}

/**
 * How many lines an edit or write adds and removes, and how many files it
 * touches, from what its arguments hold: its replacements, the file's whole
 * text, or a patch (Codex's envelope or a unified diff). Undefined where the
 * arguments don't hold the text.
 */
function changedLines(kind: ToolKind, args: JsonRecord | undefined, input: string | undefined): ChangedLines | undefined {
  const patch = textOf(args?.["patchText"]) ?? textOf(args?.["patch"]) ?? textOf(args?.["input"]) ?? (args ? undefined : input)
  if (patch && /^(?:\*\*\* Begin Patch|--- |diff --git |\*\*\* (?:Update|Add|Delete) File: )/m.test(patch)) return patchLines(patch)
  if (!args) return undefined
  if (kind === "write") {
    const content = firstText(args, CONTENT_KEYS)
    return content === undefined ? undefined : { added: lineCount(content), removed: 0, files: 1 }
  }
  const pairs = Array.isArray(args["edits"]) ? args["edits"] : [args]
  let added = 0
  let removed = 0
  let found = false
  for (const pair of pairs) {
    const edit = Arguments.safeParse(pair)
    if (!edit.success) continue
    const before = firstText(edit.data, OLD_KEYS)
    const after = firstText(edit.data, NEW_KEYS)
    if (before === undefined || after === undefined) continue
    const lines = replacedLines(before, after)
    added += lines.added
    removed += lines.removed
    found = true
  }
  return found ? { added, removed, files: 1 } : undefined
}

function patchLines(patch: string): ChangedLines {
  let added = 0
  let removed = 0
  let envelope = 0
  let unified = 0
  for (const line of patch.split("\n")) {
    if (/^\*\*\* (?:Update|Add|Delete) File: /.test(line)) envelope += 1
    else if (line.startsWith("+++ ")) unified += 1
    else if (line.startsWith("--- ") || line.startsWith("*** ")) continue
    else if (line.startsWith("+")) added += 1
    else if (line.startsWith("-")) removed += 1
  }
  return { added, removed, files: Math.max(1, envelope || unified) }
}

function targetFor(kind: ToolKind, identity: ToolIdentity, args: JsonRecord | undefined, keys: FieldKeys | undefined, input: string | undefined): string | undefined {
  switch (kind) {
    case "shell":
      return identity.command ?? field(args, "description", keys)
    case "read": case "edit": case "write": case "delete": case "move":
      return identity.path
    case "list":
      return identity.path ?? "."
    case "search":
      return [identity.pattern ?? identity.query, identity.path].filter(Boolean).join(" · ") || undefined
    case "find":
      return identity.pattern ?? identity.path
    case "web-fetch":
      return identity.url
    case "web-search":
      return identity.query ?? textOf(args?.["search_term"])
    case "agent":
      return field(args, "description", keys) ?? firstLine(field(args, "prompt", keys)) ?? textOf(args?.["subagent_type"]) ?? textOf(args?.["agent_id"])
    case "agent-message": case "agent-wait":
      return textOf(args?.["target"]) ?? textOf(args?.["agent_id"]) ?? textOf(args?.["agentId"]) ?? firstLine(field(args, "prompt", keys))
    case "question":
      return firstQuestion(args) ?? textOf(args?.["question"]) ?? field(args, "prompt", keys)
    case "plan":
      return field(args, "description", keys) ?? textOf(args?.["name"]) ?? firstLine(textOf(args?.["overview"]))
    case "skill":
      return textOf(args?.["skill"]) ?? textOf(args?.["name"]) ?? textOf(args?.["id"])
    case "tool-search":
      return identity.query ?? textOf(args?.["server_name"]) ?? textOf(args?.["namespace"]) ?? textOf(args?.["pattern"])
    case "mode":
      return textOf(args?.["mode"]) ?? textOf(args?.["modeId"]) ?? textOf(args?.["mode_id"]) ?? textOf(args?.["target_mode_id"])
    case "shell-output": case "shell-stop": case "shell-input":
      return textOf(args?.["shell_id"]) ?? textOf(args?.["shellId"]) ?? textOf(args?.["cell_id"]) ?? textOf(args?.["task_ids"]) ?? textOf(args?.["task_id"]) ?? textOf(args?.["session_id"]) ?? textOf(args?.["id"])
    case "code":
      return field(args, "description", keys) ?? firstLine(field(args, "code", keys) ?? (args ? undefined : input))
    case "computer":
      return field(args, "description", keys) ?? firstLine(field(args, "code", keys)) ?? identity.url ?? identity.query ??
        textOf(args?.["text"]) ?? textOf(args?.["key"]) ?? firstLine(textOf(args?.["expression"])) ?? textOf(args?.["topic"]) ?? textOf(args?.["method"])
    case "wait": {
      const milliseconds = Number(textOf(args?.["duration_ms"]))
      return Number.isFinite(milliseconds) && milliseconds > 0 ? `${milliseconds / 1000}s` : textOf(args?.["reason"])
    }
    case "todo": case "plan-exit": case "think": case "image": case "agents": case "mcp": case "other":
      return field(args, "description", keys) ?? (kind === "other" || kind === "mcp" ? firstScalar(args) : undefined)
  }
}

const Questions = z.array(z.object({ question: z.string().optional(), title: z.string().optional(), header: z.string().optional() }).loose())

function firstQuestion(args: JsonRecord | undefined): string | undefined {
  const parsed = Questions.safeParse(args?.["questions"])
  const first = parsed.success ? parsed.data[0] : undefined
  return first?.question ?? first?.title ?? first?.header
}

/** The first file a patch touches: `*** Update File: path`, or a unified diff's `+++ b/path`. */
function patchedPath(args: JsonRecord | undefined, input: string | undefined): string | undefined {
  const text = textOf(args?.["patchText"]) ?? textOf(args?.["patch"]) ?? textOf(args?.["input"]) ?? (args ? undefined : input)
  if (!text) return undefined
  return /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(text)?.[1]?.trim() ?? /^\+\+\+ (?:b\/)?(.+)$/m.exec(text)?.[1]?.trim()
}

function unwrap(source: ToolSource, name: string, wrapper: ArgumentWrapper | ScriptWrapper): ToolIdentity | undefined {
  return wrapper.form === "arguments" ? unwrapArguments(source, name, wrapper) : unwrapScript(source, name, wrapper)
}

function unwrapArguments(source: ToolSource, name: string, wrapper: ArgumentWrapper): ToolIdentity | undefined {
  const args = sourceArguments(source)
  const tool = textOf(args?.[wrapper.tool])
  // A file in place of the arguments, or of the whole call, until the harness reports what it read there.
  const file = args && wrapper.files && !(wrapper.args in args)
    ? (wrapper.files.args ? textOf(args[wrapper.files.args]) : undefined) ?? (wrapper.files.call ? textOf(args[wrapper.files.call]) : undefined)
    : undefined
  if (!tool && file) {
    const identity = describe(source, name, { kind: "mcp" }, undefined)
    identity.target = `arguments in ${file}`
    return identity
  }
  if (!args || !tool) {
    const title = wrapper.titleRoute ? nameFromTitle(source.title) : undefined
    const route = title ? mcpName(title, ["s: t"]) : undefined
    if (!route) return undefined
    const identity = describeMcp(source, name, route, undefined)
    identity.via = name
    return identity
  }
  const server = wrapper.server ? textOf(args[wrapper.server]) : undefined
  const innerArgs = Arguments.safeParse(args[wrapper.args])
  const inputText = innerArgs.success ? JSON.stringify(innerArgs.data) : undefined
  const innerName = server && server !== wrapper.builtin ? `mcp__${server}__${tool}` : tool
  const identity = identifyTool({ harness: source.harness, name: innerName, input: inputText })
  identity.name = name
  identity.via = name
  identity.tool ??= tool
  if (inputText) identity.input = inputText
  else if (file) identity.target = `arguments in ${file}`
  return identity
}

/** A code-mode script: the tools it calls, `tools.exec_command({…})` or `tools.mako.app_start()`. */
function unwrapScript(source: ToolSource, name: string, wrapper: ScriptWrapper): ToolIdentity | undefined {
  const args = sourceArguments(source)
  const code = args ? textOf(args[wrapper.key ?? "code"]) : source.input
  if (!code) return undefined
  const calls = scriptCalls(code)
  if (wrapper.callsShown) {
    const ran = new Set(calls.map((call) => {
      const inner = identifyScriptCall(source, call)
      return inner.command ?? inner.path ?? inner.url ?? inner.query ?? inner.pattern ?? inner.label
    }))
    return scriptIdentity(name, code, ran.size ? [...ran].join(", ") : undefined)
  }
  if (calls.length !== 1) return scriptIdentity(name, code, calls.length ? calls.map((call) => call.name).join(", ") : undefined)
  const call = calls[0]!
  const identity = identifyScriptCall(source, call)
  identity.name = name
  identity.via = name
  identity.tool ??= /^[\w-]+\.(\w+)$/.exec(call.name)?.[1] ?? call.name
  if (call.input) identity.input = call.input
  return identity
}

function scriptIdentity(name: string, code: string, ran: string | undefined): ToolIdentity {
  const identity: ToolIdentity = { kind: "code", name, label: KINDS.code.label }
  const shown = ran ?? firstLine(code.replace(/^\s*(?:return\s+)?(?:await\s+)?/, ""))
  if (shown) identity.target = shown
  return identity
}

/** `tools.exec_command(…)`, or `tools.mako.app_start(…)` for an MCP server's tool. */
function identifyScriptCall(source: ToolSource, call: ScriptCall): ToolIdentity {
  const dotted = /^([\w-]+)\.(\w+)$/.exec(call.name)
  return identifyTool({ harness: source.harness, name: dotted ? `mcp__${dotted[1]}__${dotted[2]}` : call.name, input: call.input })
}

interface ScriptCall {
  name: string
  input?: string
}

const MAX_SCRIPT = 20_000

function scriptCalls(code: string): ScriptCall[] {
  const source = code.slice(0, MAX_SCRIPT)
  const calls: ScriptCall[] = []
  const pattern = /\btools\.([\w$]+(?:\.[\w$]+)?)\s*\(|(?<![\w.])(search)\s*\(\s*\{/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const callName = match[1] ?? match[2]!
    const open = source.indexOf("(", match.index)
    calls.push({ name: callName, input: literalArguments(source, open) })
  }
  return calls
}

/**
 * The scalar fields of the object literal a script passes (`{cmd:'ls', max:3}`),
 * as JSON. Not a JavaScript parser: nested objects are skipped, which is enough
 * to name a command, a path or a tier.
 */
function literalArguments(source: string, open: number): string | undefined {
  const close = matchingParen(source, open)
  const body = source.slice(open + 1, close).trim()
  const text = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*$/.exec(body)
  if (text) return JSON.stringify({ input: unquote(text[1]!) })
  if (!body.startsWith("{")) return undefined
  const result = new Map<string, string | number | boolean>()
  const entry = /([\w$]+)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|-?\d+(?:\.\d+)?|true|false)/g
  let depth = 0
  let last = 0
  for (let match = entry.exec(body); match; match = entry.exec(body)) {
    depth += nesting(body.slice(last, match.index))
    last = match.index
    if (depth !== 1) continue
    const raw = match[2]!
    if (raw === "true" || raw === "false") result.set(match[1]!, raw === "true")
    else if (/^-?\d/.test(raw)) result.set(match[1]!, Number(raw))
    else result.set(match[1]!, unquote(raw))
  }
  return JSON.stringify(Object.fromEntries(result))
}

function nesting(text: string): number {
  let depth = 0
  let quote = ""
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = ""
      continue
    }
    if (char === "\"" || char === "'" || char === "`") quote = char
    else if (char === "{" || char === "[") depth += 1
    else if (char === "}" || char === "]") depth -= 1
  }
  return depth
}

function matchingParen(source: string, open: number): number {
  let depth = 0
  let quote = ""
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = ""
      continue
    }
    if (char === "\"" || char === "'" || char === "`") quote = char
    else if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return source.length
}

function unquote(raw: string): string {
  const body = raw.slice(1, -1)
  return body.replace(/\\(.)/g, (_, escaped: string) => (escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped))
}

/** The vocabulary a harness declares, lower-cased with its aliases, for audits and tests. */
export function declaredToolNames(harness: string): string[] {
  return [...(HARNESSES.get(harness)?.keys() ?? [])]
}

export function hasVocabulary(harness: string): boolean {
  return HARNESSES.has(harness)
}

/**
 * Whether the harness's vocabulary accounts for a native tool name: a
 * declared tool or alias, or an MCP tool in a form it declares. A name it
 * doesn't is a tool the harness gained or renamed. False for a harness with
 * no vocabulary.
 */
export function isDeclaredTool(harness: string, name: string): boolean {
  const declared = HARNESSES.get(harness)
  if (!declared) return false
  return declared.has(name.toLowerCase()) || mcpName(name, mcpForms(harness)) !== undefined
}

/** What a harness calls its tools of one kind, by their primary native names: how to name them to that harness. */
export function nativeToolNames(harness: string, kind: ToolKind): string[] {
  const declared = VOCABULARIES.find((vocabulary) => vocabulary.harness === harness)
  return declared ? Object.entries<NativeTool>(declared.tools).filter(([, tool]) => tool.kind === kind).map(([name]) => name) : []
}

/** What a harness declares of one native tool, by name or alias; the shared table's entry for a name it doesn't declare. */
export function toolDeclaration(harness: string | undefined, name: string): NativeTool | undefined {
  return specFor(harness, name)
}

/**
 * A call as one line where no row draws it (a Fin's last step): a Mako
 * tool's own words, running or done, else its label and target.
 */
export function toolPhrase(identity: ToolIdentity, running: boolean): string {
  const said = running ? identity.running : identity.done
  if (said) return said
  return identity.target ? `${identity.label} ${identity.target}` : identity.label
}

/**
 * The exit code a failed command's answer states, in the shape its
 * harness's shell declares (`EffectReading.exitText`); undefined where the
 * harness states none in its text.
 */
export function commandExitCode(harness: string | undefined, name: string | undefined, output: string | undefined): number | undefined {
  const pattern = name ? specFor(harness, name)?.effects?.exitText : undefined
  const code = pattern && output ? pattern.exec(output)?.[1] : undefined
  return code === undefined ? undefined : Number(code)
}

/** Where a shell's arguments name the folder it runs in, besides what its harness declares (`EffectReading.cwd`). */
const FOLDER_KEYS = ["cwd", "workdir", "workingDirectory", "working_directory", "directory"]

/**
 * The folder a command's arguments say it runs in: under the key its
 * harness's shell declares, else a common one. Undefined where they name
 * none; a key read from the harness's result isn't in the arguments.
 */
export function commandFolder(harness: string | undefined, name: string | undefined, args: ToolArguments | undefined): string | undefined {
  if (!args) return undefined
  const declared = name ? specFor(harness, name)?.effects?.cwd : undefined
  for (const key of [...[declared ?? []].flat(), ...FOLDER_KEYS]) {
    if (key.startsWith("result.")) continue
    const folder = z.string().trim().min(1).safeParse(args[key])
    if (folder.success) return folder.data
  }
  return undefined
}

/** How a harness's results say it refused a call before it ran (`HarnessVocabulary.refusals`). */
export function toolRefusals(harness: string | undefined): readonly RegExp[] {
  return (harness ? VOCABULARIES.find((declared) => declared.harness === harness)?.refusals : undefined) ?? []
}

/**
 * Each call a code-mode script makes, identified as `identifyTool` would
 * identify it alone, with the arguments the script passes it as `input`.
 * Empty for a call that wraps no script.
 */
export function scriptToolCalls(source: ToolSource): ToolIdentity[] {
  const name = source.name?.trim()
  const wrapper = name ? specFor(source.harness, name)?.wraps : undefined
  if (wrapper?.form !== "script") return []
  const args = sourceArguments(source)
  const code = args ? textOf(args[wrapper.key ?? "code"]) : source.input
  if (!code) return []
  return scriptCalls(code).map((call) => {
    const identity = identifyScriptCall(source, call)
    if (call.input) identity.input = call.input
    return identity
  })
}
