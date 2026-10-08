import { z } from "zod"
import { inclusiveTokens, tokenCount, type HarnessTokens } from "./tokens.js"
import { defineVocabulary } from "./vocabulary.js"

/**
 * The app server reports no tool list. The live decoder names its items
 * (`exec_command` for a command, `apply_patch` for a file change,
 * `mcp__s__t` for an MCP call); rollouts record `function_call` names, with
 * an MCP tool's server in its `namespace`.
 */
const MAKO_COMPUTER = "Mako's own computer tool, which Codex records by its bare name; no Codex build defines it."

export const CODEX_VOCABULARY = defineVocabulary({
  harness: "codex",
  checked: {
    version: "0.159.3",
    on: "2026-10-06",
    against: "the model request of 0.159.3's app-server for every listed model, with and without plan, code mode's nested tools included (scripts/fixtures/native-tools), ~/.codex/sessions rollouts through audit:tools, and the app server's item types (electron/providers/codex/generated)",
  },
  mcp: ["s.t", "s: t"],
  tools: {
    // A code cell's calls arrive as their own items and draw as their own rows; a row of the cell itself is one that failed.
    exec: { kind: "code" },
    exec_command: { kind: "shell", aliases: ["shell", "local_shell"] },
    write_stdin: { kind: "shell-input" },
    wait: { kind: "shell-output", label: "Command output" },
    apply_patch: { kind: "edit" },
    read_file: { kind: "read", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    view_image: { kind: "read" },
    write_file: { kind: "write", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    append_to_file: { kind: "write", label: "Append", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    web_search: { kind: "web-search" },
    update_plan: { kind: "todo", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    request_user_input: { kind: "question" },
    request_user_input_async: { kind: "question" },
    spawn_agent: { kind: "agent" },
    send_message: { kind: "agent-message" },
    send_input: { kind: "agent-message", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    followup_task: { kind: "agent-message" },
    close_agent: { kind: "agent-message", label: "Close agent", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    interrupt_agent: { kind: "agent-message", label: "Interrupt agent" },
    resume_agent: { kind: "agent-message", label: "Resume agent", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    wait_agent: { kind: "agent-wait" },
    list_agents: { kind: "agents" },
    ToolSearch: { kind: "tool-search", aliases: ["tool_search"] },
    js: { kind: "computer", unlisted: MAKO_COMPUTER },
    js_reset: { kind: "computer", label: "Reset script", unlisted: MAKO_COMPUTER },
    sleep: { kind: "wait" },
    new_context: { kind: "other", label: "New context", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    get_context_remaining: { kind: "other", label: "Context left", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    list_windows: { kind: "list", label: "Context windows", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    list_items: { kind: "list", label: "History", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    read_item: { kind: "read", label: "History item", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    search_contents: { kind: "search", label: "Search history", unlisted: "0.159.3 defines it for no listed model; older rollouts record it." },
    get_goal: { kind: "other", label: "Goal" },
    create_goal: { kind: "other", label: "New goal" },
    update_goal: { kind: "other", label: "Update goal" },
    clock__curr_time: { kind: "other", label: "Clock" },
    web__run: { kind: "web-search", label: "Web" },
  },
  concepts: {
    checked: {
      version: "0.159.3",
      on: "2026-10-06",
      against: "app-server types generated from 0.159.3, developers.openai.com/codex (agents-md, hooks, skills, subagents, config-reference), skills/list on probe folders and the binary through harness:self-report",
    },
    instructions: {
      files: ["AGENTS.override.md", "AGENTS.md"],
      rules: [],
      user: ["~/.codex/AGENTS.override.md", "~/.codex/AGENTS.md"],
      order: "The global file, then one file per directory from the project root down to the working directory (override first, then AGENTS.md, then project_doc_fallback_filenames), joined root first and capped at project_doc_max_bytes, 32 KiB.",
    },
    hooks: {
      config: ["~/.codex/hooks.json", "~/.codex/config.toml", ".codex/hooks.json", ".codex/config.toml"],
      events: ["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "Interrupt"],
      control: "Layers merge; project hooks load once the project is trusted, and non-managed hooks need trust by hash (/hooks). Exit 2 or permissionDecision deny blocks a tool; decision block on Stop continues the turn. Handlers: command, mcp_tool. The app-server reports runs as hook/started and hook/completed.",
    },
    skills: ["~/.codex/skills", "~/.agents/skills", ".codex/skills", ".agents/skills"],
    commands: { folders: ["~/.codex/prompts"], note: "Deprecated for skills; /prompts:<name> with $1–$9 and $ARGUMENTS." },
    agents: ["~/.codex/agents", ".codex/agents"],
    mcpConfig: ["~/.codex/config.toml", ".codex/config.toml"],
    output: {
      live: "app-server JSON-RPC over stdio",
      headless: ["exec --json"],
      store: "~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl, indexed in ~/.codex/session_index.jsonl",
    },
    models: "app-server model/list",
    distinct: [
      { name: "Rate-limit reset credits", via: "account/rateLimits/read rateLimitResetCredits, account/rateLimitResetCredit/consume" },
      { name: "Review mode", via: "review/start; enteredReviewMode and exitedReviewMode items" },
      { name: "Goals", via: "thread/goal/*" },
      { name: "Session questions", via: "item/tool/requestUserInput, answered in the session" },
    ],
  },
})

/**
 * Codex's `TokenUsage` in its own terms, from either wire: `input` includes
 * cached input and cache writes, and `output` includes reasoning.
 */
export interface CodexTokenUsage {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
  reasoning: number
  /** Input and output together: the context the call filled. */
  total?: number
}

/** `TokenUsageBreakdown` on the app-server wire (`thread/tokenUsage/updated`'s `last` and `total`). */
export const CodexWireUsage = z.object({
  inputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  cacheWriteInputTokens: tokenCount,
  outputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
  totalTokens: tokenCount,
}).transform((usage): CodexTokenUsage => ({
  input: usage.inputTokens ?? 0,
  cachedInput: usage.cachedInputTokens ?? 0,
  cacheWrite: usage.cacheWriteInputTokens ?? 0,
  output: usage.outputTokens ?? 0,
  reasoning: usage.reasoningOutputTokens ?? 0,
  total: usage.totalTokens ?? undefined,
}))

/** A rollout `token_count` event's `info.last_token_usage` and `info.total_token_usage`. */
export const CodexRolloutUsage = z.object({
  input_tokens: tokenCount,
  cached_input_tokens: tokenCount,
  cache_write_input_tokens: tokenCount,
  output_tokens: tokenCount,
  reasoning_output_tokens: tokenCount,
  total_tokens: tokenCount,
}).transform((usage): CodexTokenUsage => ({
  input: usage.input_tokens ?? 0,
  cachedInput: usage.cached_input_tokens ?? 0,
  cacheWrite: usage.cache_write_input_tokens ?? 0,
  output: usage.output_tokens ?? 0,
  reasoning: usage.reasoning_output_tokens ?? 0,
  total: usage.total_tokens ?? undefined,
}))

export function codexTokens(usage: CodexTokenUsage): HarnessTokens {
  return inclusiveTokens({
    input: usage.input,
    cacheRead: usage.cachedInput,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    reasoning: usage.reasoning,
  })
}
