import { z } from "zod"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import type { AcpDecoderHooks } from "../acp-decoder.js"
import type { AcpToolReading } from "../acp-tool-details.js"
import { DevinPlanUpdates } from "../providers/devin-plans.js"
import { exclusiveTokens, inclusiveTokens, tokenCount, type HarnessTokens } from "./tokens.js"
import { defineVocabulary } from "./vocabulary.js"

/** Names are `_meta["cognition.ai/inferenceToolName"]` live and in the IDE journal, and the chat tool name in the CLI store. */
export const DEVIN_VOCABULARY = defineVocabulary({
  harness: "devin",
  checked: {
    version: "3000.10.23",
    on: "2026-10-05",
    against: "Devin's CLI store and IDE journal through audit:tools, and the 3000.10.23 plan capture",
  },
  mcp: ["s.t"],
  tools: {
    exec: { kind: "shell" },
    get_output: { kind: "shell-output" },
    write_to_process: { kind: "shell-input" },
    kill_shell: { kind: "shell-stop" },
    read: { kind: "read" },
    edit: { kind: "edit" },
    write: { kind: "write" },
    grep: { kind: "search" },
    code_search: { kind: "search", label: "Code search", keys: { query: ["search_term", "query"], path: ["search_folder_absolute_uri", "path"] } },
    find_file_by_name: { kind: "find" },
    web_search: { kind: "web-search" },
    webfetch: { kind: "web-fetch" },
    run_subagent: { kind: "agent" },
    subagent: { kind: "agent-wait", label: "Agent status" },
    read_subagent: { kind: "agent-wait" },
    todo_write: { kind: "todo" },
    write_plan: { kind: "plan" },
    exit_plan_mode: { kind: "plan-exit" },
    ask_user_question: { kind: "question" },
    skill: { kind: "skill" },
    mcp_list_tools: { kind: "tool-search" },
    mcp_list_servers: { kind: "tool-search", label: "MCP servers" },
    mcp_call_tool: { kind: "mcp" },
    request_scope: { kind: "other", label: "Request access" },
  },
  concepts: {
    checked: {
      version: "3000.10.23",
      on: "2026-10-06",
      against: "the docs devin 3000.10.23 ships (extensibility, subagents, permissions, mcp), devin skills paths, and the binary through harness:self-report",
    },
    instructions: {
      files: ["AGENTS.md", "agents.md", "AGENTS.local.md", "AGENT.md", ".windsurfrules", "CLAUDE.md"],
      rules: [".devin/rules", ".windsurf/rules", ".cursor/rules"],
      user: ["~/.config/devin/AGENTS.md", "~/.devin/rules", "~/.devin/global_rules.md", "~/.claude/CLAUDE.md"],
      order: "The workspace root down to the working directory, a subdirectory's files when the agent touches it; .devin/global_rules.md over .windsurf's; each always-on rule capped at 32 KiB. read_config_from turns off each other tool's files.",
    },
    hooks: {
      config: [".devin/hooks.v1.json", ".devin/config.json", ".devin/config.local.json", ".claude/settings.json", ".claude/settings.local.json", "~/.config/devin/config.json", "~/.claude.json", "~/.claude/settings.json", "~/.claude/settings.local.json"],
      events: ["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit", "Stop", "PostCompaction", "SessionStart", "SessionEnd"],
      control: "Exit 2 blocks; stdout decision approve|block, hookSpecificOutput additionalContext and updatedInput; a blocking Stop makes the agent continue. Handlers: command, prompt.",
    },
    skills: [".agents/skills", ".devin/skills", ".cognition/skills", ".windsurf/skills", ".claude/skills", "~/.agents/skills", "~/.config/devin/skills", "~/.config/cognition/skills"],
    commands: { absent: "Skills are its slash commands; .claude/commands are imported as skills." },
    agents: [".devin/agents", ".agents/agents", "~/.config/devin/agents"],
    mcpConfig: ["~/.config/devin/mcp_config.json", ".devin/mcp_config.json", ".devin/mcp_config.local.json"],
    output: {
      live: "ACP over stdio, with cognition.ai extensions",
      headless: ["print (plain text)", "export (ATIF)"],
      store: "~/.local/share/devin/cli/sessions.db (SQLite: sessions, messages, message_nodes, tool_call_state)",
    },
    models: "devin models list --format json",
    distinct: [
      { name: "Cloud handoff", via: "/handoff, /cloud-attach" },
      { name: "Step revert and fork", via: "cognition.ai/revert/*" },
      { name: "Editable approvals", via: "cognition.ai/editableCommand, command/revise" },
      { name: "Credits and ACUs", via: "usage_update _meta totalCreditCost and totalAcuCost, for an account billed in credits or ACUs rather than quota; never seen sent, so unread" },
    ],
  },
})

/**
 * A live `usage_update._meta` (3000.10.23): one call's
 * `cognition.ai/inputTokens`, which includes the input either cache
 * supplied, `outputTokens` and, once the cache is warm, `cachedReadTokens`
 * and `cachedWriteTokens`. A main-agent call is reported twice, the second
 * time with `cognition.ai/subagent_context.parentAgentId` set to `root`; a
 * subagent's call comes once, naming its parent there.
 */
export const DevinUsageMeta = z.object({
  "cognition.ai/inputTokens": tokenCount,
  "cognition.ai/outputTokens": tokenCount,
  "cognition.ai/cachedReadTokens": tokenCount,
  "cognition.ai/cachedWriteTokens": tokenCount,
  "cognition.ai/subagent_context": z.object({ parentAgentId: z.string().min(1) }).nullish().catch(undefined),
})

/** What one live usage reading counts: a repeat counts nothing; a call without both counts has no tokens. */
export type DevinUsageReading = { of: "repeat" } | { of: "agent" | "subagent"; tokens?: HarnessTokens }

const ROOT_AGENT = "root"

export function devinUsageReading(meta: z.input<typeof DevinUsageMeta> | undefined): DevinUsageReading {
  const read = DevinUsageMeta.safeParse(meta ?? {}).data
  if (!read) return { of: "agent" }
  // A tag Mako can't read is taken for the root's repeat, which counts nothing, rather than counted twice.
  const tagged = meta !== undefined && Object.hasOwn(meta, "cognition.ai/subagent_context")
  const parent = read["cognition.ai/subagent_context"]?.parentAgentId
  if (tagged && (parent === undefined || parent === ROOT_AGENT)) return { of: "repeat" }
  const of = parent === undefined ? "agent" : "subagent"
  const input = read["cognition.ai/inputTokens"]
  const output = read["cognition.ai/outputTokens"]
  if (input == null || output == null) return { of }
  return {
    of,
    tokens: inclusiveTokens({
      input,
      output,
      cacheRead: read["cognition.ai/cachedReadTokens"],
      cacheWrite: read["cognition.ai/cachedWriteTokens"],
    }),
  }
}

/**
 * A call's `metadata.metrics` in Devin's CLI store (3000.10.23). Unlike the
 * live reading, `input_tokens` leaves out what the cache supplied: a call
 * reported live as 11,496 input with 327 read from cache is stored as 11,169
 * and 327. The store keeps one call in several rows (two sibling rows, and
 * a copy in each chain plan mode rebuilds), all with the call's
 * `metadata.request_id`.
 */
export const DevinCallMetrics = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_tokens: tokenCount,
  cache_creation_tokens: tokenCount,
})
export type DevinCallMetrics = z.infer<typeof DevinCallMetrics>

/** What a stored call's `metadata` says about its spend: the call, when it was written, the model that answered (`compactor` for a compaction), and its metrics. */
export const DevinStoredCall = z.object({
  request_id: z.string().min(1).nullish().catch(undefined),
  created_at: z.string().nullish().catch(undefined),
  generation_model: z.string().min(1).nullish().catch(undefined),
  metrics: DevinCallMetrics,
})

export function devinStoredTokens(metrics: DevinCallMetrics): HarnessTokens {
  return exclusiveTokens({
    input: metrics.input_tokens,
    output: metrics.output_tokens,
    cacheRead: metrics.cache_read_tokens,
    cacheWrite: metrics.cache_creation_tokens,
  })
}

/**
 * Devin's tool updates (3000.10.23): a command's call carries the command
 * again as an embedded `tool://preview` resource, for Devin's own client to
 * draw; the call's input already holds it. A call the person stopped ends
 * `failed` with `_meta["cognition.ai/canceled"]`. A `write_plan` call
 * (`cognition.ai/isPlanFileEdit`) sends the plan as `rawInput.content` beside
 * a diff of the whole file; its saved `tool_call_state` keeps only the path.
 */
export const DEVIN_TOOL_READING: AcpToolReading = {
  input: (update) => update._meta?.["cognition.ai/isPlanFileEdit"] === true ? PlanFileInputSchema.safeParse(update.rawInput).data : undefined,
  omits: (part) => devinPreview(part),
  status: (update) => update._meta?.["cognition.ai/canceled"] === true ? "canceled" : undefined,
}

const PlanFileInputSchema = z.object({ file_path: z.string() })

function devinPreview(part: { type: string; content?: { type: string; resource?: { uri?: string } } }): boolean {
  return part.type === "content" && part.content?.type === "resource" && part.content.resource?.uri === "tool://preview"
}

const InferenceMeta = z.object({ "cognition.ai/inferenceToolName": z.string().trim().min(1).max(512) })
/** An MCP call (3000.10.23): `mcp_call_tool`, its tool named `mcp__<server>__<tool>`, its `rawInput` the tool's own arguments. */
const McpCallMeta = z.object({
  "cognition.ai/inferenceToolName": z.literal("mcp_call_tool"),
  "cognition.ai/toolName": z.string().regex(/^mcp__.+?__.+$/),
})

/**
 * Devin's `todo_write` input. Live, 3000.10.23 sends the list as a `plan`
 * update and no call; its CLI store keeps the call, and `session/load` (so
 * the IDE journal too) replays the call and no plan.
 */
export const DevinTodoWrite = z.looseObject({
  todos: z.array(z.looseObject({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
})

/**
 * A question's picks as Devin's client shows them for the call's result
 * (3000.10.23): "Friday" for one question, and `<header>: <picks>` on a line
 * for each of several.
 */
export function devinAnswersShown(answers: readonly { index: number; picks: readonly string[] }[], headers: readonly (string | null | undefined)[]): string {
  return answers.map(({ index, picks }) => {
    const header = answers.length > 1 ? headers[index] : undefined
    return header ? `${header}: ${picks.join(", ")}` : picks.join(", ")
  }).join("\n")
}

/** A command that printed nothing, as Devin's client shows its result (3000.10.23). */
export function devinQuietExitShown(code: number): string {
  return `Exited with code ${code}`
}

type DevinToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>

const TerminalExitMeta = z.object({ terminal_exit: z.object({ exit_code: z.number().int() }).loose() })
const ClientMessageMeta = z.object({ "cognition.ai/clientMessageId": z.string().min(1) })

/**
 * What a question's last update carries beside its result, live and
 * replayed. The replay sends no result, so the answers are the result.
 */
const DevinAnsweredMeta = z.object({
  "cognition.ai/answers": z.array(z.object({ question_index: z.number().int().nonnegative(), selected_options: z.array(z.string()) })),
  "cognition.ai/originalQuestions": z.array(z.object({ header: z.string().nullish() }).loose()),
})

function devinTodoPlan(update: DevinToolUpdate): SessionUpdate | null | undefined {
  if (update.sessionUpdate === "tool_call_update") return null
  const todos = DevinTodoWrite.safeParse(update.rawInput).data?.todos
  // ACP requires a priority, which Mako doesn't draw; Devin sends every entry `medium` live.
  return todos && { sessionUpdate: "plan", entries: todos.map(({ content, status }) => ({ content, status, priority: "medium" })) }
}

/** A finished call replayed without the result it showed live, with the result its `_meta` still implies. */
function devinShownResult(update: DevinToolUpdate, tool: string): SessionUpdate | undefined {
  if (update.status !== "completed" || update.content?.some((part) => !devinPreview(part))) return undefined
  const text = tool === "ask_user_question" ? devinAnswers(update._meta) : tool === "exec" ? devinQuietExit(update._meta) : undefined
  return text === undefined ? undefined : { ...update, content: [{ type: "content", content: { type: "text", text } }] }
}

function devinAnswers(meta: DevinToolUpdate["_meta"]): string | undefined {
  const answered = DevinAnsweredMeta.safeParse(meta).data
  if (!answered) return undefined
  const answers = answered["cognition.ai/answers"].map((answer) => ({ index: answer.question_index, picks: answer.selected_options }))
  return devinAnswersShown(answers, answered["cognition.ai/originalQuestions"].map((question) => question.header))
}

function devinQuietExit(meta: DevinToolUpdate["_meta"]): string | undefined {
  const code = TerminalExitMeta.safeParse(meta).data?.terminal_exit.exit_code
  return code === undefined ? undefined : devinQuietExitShown(code)
}

/** What Devin's updates mean beyond ACP's own fields, read the same live and from its stores. */
export const DEVIN_ACP_HOOKS = {
  /**
   * ACP's kind describes the action; `_meta["cognition.ai/inferenceToolName"]`
   * names Devin's tool, and an MCP call is named `server.tool`.
   */
  toolName: (tool) => {
    const mcp = McpCallMeta.safeParse(tool._meta).data?.["cognition.ai/toolName"]
    if (mcp) return mcp.replace(/^mcp__(.+?)__/, "$1.")
    return InferenceMeta.safeParse(tool._meta).data?.["cognition.ai/inferenceToolName"]
  },
  toolReading: DEVIN_TOOL_READING,
  /**
   * Devin's status line for its own client, `_meta["cognition.ai/displayMessage"]`:
   * 3000.10.23 reports /compact's result this way ("Context compacted") beside
   * `_cognition.ai/compaction`, and keeps it out of its store. The live
   * compaction spec still reads it.
   */
  transient: (notification) => notification.update.sessionUpdate === "agent_message_chunk" && notification.update._meta?.["cognition.ai/displayMessage"] === true,
  plans: () => new DevinPlanUpdates(),
  /**
   * `session/load` replays a `todo_write` call where it sent the list live as
   * a plan, and a finished call without the result it showed live: a
   * question's picks, a quiet command's exit. Devin.app's journal keeps that
   * replay, each call folded into one record. It replays a prompt's text and
   * each image as chunks that name their message in `_meta`, not `messageId`.
   */
  restated: (update, calls) => {
    if (update.sessionUpdate === "user_message_chunk") {
      const message = ClientMessageMeta.safeParse(update._meta).data?.["cognition.ai/clientMessageId"]
      return message && !update.messageId ? { ...update, messageId: message } : undefined
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined
    const tool = InferenceMeta.safeParse(update._meta).data?.["cognition.ai/inferenceToolName"]
    if (tool === "todo_write") return devinTodoPlan(update)
    // Live, a stopped command's late exit follows the cancellation it already showed.
    return tool && !calls.hasAnswered(update.toolCallId) ? devinShownResult(update, tool) : undefined
  },
} satisfies AcpDecoderHooks<DevinPlanUpdates>

/**
 * The file Devin saves a compaction's full history to, which its summary
 * names live and saved alike: the compaction's identity, since Devin gives
 * the notification none.
 */
export function devinCompactionRecord(summary: string): string | undefined {
  return /\/summaries\/(history_[0-9a-f]+)\.md\b/.exec(summary)?.[1]
}
