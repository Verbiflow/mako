import { z } from "zod"
import { exclusiveTokens, tokenCount, type HarnessTokens } from "./tokens.js"
import { defineVocabulary } from "./vocabulary.js"

/** Claude Code's hook events, held to the SDK's `HOOK_EVENTS` by `electron/providers/claude/vocabulary-check.ts`. */
export const CLAUDE_HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit", "UserPromptExpansion",
  "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
  "PreModelSwitch", "PostModelSwitch", "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted",
  "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded",
  "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay",
] as const

/**
 * The record types Claude Code 2.1.283 writes to a session transcript, from
 * its own loader's table of them. History draws `user`, `assistant`,
 * `system` and `attachment` records and reads the titles; the rest is
 * Claude Code's bookkeeping. `scripts/test-harness-records.ts` holds these
 * lists to the Claude Code the SDK bundles, naming what an upgrade adds.
 */
export const CLAUDE_RECORD_TYPES: readonly string[] = [
  "user", "assistant", "system", "attachment", "progress", "file-history-snapshot",
  "file-history-delta", "last-prompt", "continued-in", "content-replacement", "api-request-shape", "api-request-blob",
  "api-request", "fork-context-ref", "frame-link", "summary", "custom-title", "ended-by-model",
  "ai-title", "tag", "relocated", "agent-name", "agent-color", "agent-setting",
  "pr-link", "artifact-comment-monitor", "artifact-autoreact-ledger", "bridge-session", "history-suppression", "attribution-snapshot",
  "mode", "permission-mode", "isolation-latch", "dev-mods", "memory-mode", "atis-latch",
  "worktree-state", "cost-state", "queue-operation", "observer-ref",
]

/**
 * The `system` records Claude Code 2.1.278 to 2.1.293 makes; history draws
 * compactions, refusals and local commands. 2.1.293's additions are signals
 * for a host's UI and its bridge, and a title the transcript's title
 * records also hold.
 */
export const CLAUDE_SYSTEM_SUBTYPES: readonly string[] = [
  "agents_killed", "api_error", "api_retry", "away_summary", "background_tasks_changed",
  "bridge_state", "bridge_status", "cloud_session_delta", "cloud_session_status", "code_change_published",
  "commands_changed", "compact_boundary", "control_request_progress", "dev_intent", "elicitation_complete",
  "feedback_draft_queued", "file_attachments_missing", "file_snapshot", "hook_progress", "hook_response",
  "hook_started", "informational", "init", "instruction_size_warning", "local_command",
  "memory_recall", "memory_saved", "mirror_error", "model_consent_fallback", "model_fallback",
  "model_refusal_fallback", "model_refusal_no_fallback", "notification", "peer_message_hold", "per_turn_effort_changed",
  "permission_check_status", "permission_denied", "permission_retry", "plugin_install", "post_turn_summary",
  "scheduled_task_fire", "session_metadata", "session_state_changed", "session_title_changed", "status",
  "stop_hook_summary", "task_notification", "task_progress", "task_started", "task_summary",
  "task_updated", "thinking_tokens", "tool_host_result", "turn_duration", "turn_handoff_available",
  "turn_preempted", "turn_starting", "ui_focus", "ui_invalidate", "ui_log",
  "ui_panes", "ui_scroll", "ui_status", "ui_toast", "vcs_state_changed",
  "worker_shutting_down",
]

/**
 * The attachments Claude Code 2.1.278 to 2.1.293 names: context it gives the model
 * beside a prompt. History reads only `queued_command`, a prompt the person
 * sent while a turn ran.
 */
export const CLAUDE_ATTACHMENT_TYPES: readonly string[] = [
  "account_memory_recall", "advisor_stripped", "advisor_tool", "agent_listing_delta", "agent_mention",
  "already_read_file", "artifact_opening_prefetch", "async_hook_response", "async_hook_response_batch", "at_mention_reference",
  "attention_budget", "audio_transcript", "auto_mode", "auto_mode_exit", "bash_output_audience_note",
  "batching_reminder", "batching_reminder_sent", "budget_usd", "command_permissions", "compact_file_reference",
  "context_efficiency", "context_sections", "coordinator_context", "cowork_memory_context", "credential_org",
  "critical_system_reminder", "date", "date_change", "deferred_tools_delta", "deferred_tools_record",
  "diagnostics", "dir_sync_notice", "directory", "dynamic_skill", "edited_image_file",
  "edited_text_file", "elapsed_time_reminder", "environment", "file", "fork_briefing",
  "goal_status", "hook_additional_context", "hook_blocking_error", "hook_cancelled", "hook_deferred_tool",
  "hook_error_during_execution", "hook_non_blocking_error", "hook_permission_decision", "hook_plugin_listing", "hook_stopped_continuation",
  "hook_success", "hook_system_message", "inlined_image_paths", "instructions", "invoked_skills",
  "language", "max_turns_reached", "mcp_dropped_tools_delta", "mcp_instructions_delta", "mcp_resource",
  "memory_update", "model", "nested_memory", "opened_file_in_ide", "output_style",
  "output_style_instructions", "output_token_usage", "pdf_reference", "peer_mention", "plan_file_reference",
  "plan_mode", "plan_mode_exit", "plan_mode_reentry", "poll_events", "prefix_delta",
  "proactivity", "prompt_render_point", "prompt_snapshot", "queued_command", "read_truncation_notice",
  "relevant_memories", "remote_session_change", "repl_mcp_needs_auth", "sandbox_instructions", "secondary_reminder", "secondary_reminder_sent",
  "selected_lines_in_diff", "selected_lines_in_ide", "session_context", "session_cron_carry", "session_settings",
  "silent_turn_reminder", "skill_listing", "skill_mention", "structured_output", "task_reminder",
  "task_status", "team_context", "teammate_mailbox", "teammate_shutdown_batch", "thinking_drop",
  "thinking_stripped", "thread_state", "todo_reminder", "token_usage", "tool_host_result_lines",
  "tool_hosts_correction", "tool_hosts_notice", "tool_search_usage_reminder", "total_tokens_reminder", "ultra_effort_enter",
  "ultra_effort_exit", "ultrathink_effort", "unknown_command_fallback", "withheld_memory", "workflow_keyword_request",
  "workflow_size_guideline_change",
]

const MCP_RESOURCES = "Defined only beside an MCP server that offers resources; the capture runs with none."
const NATIVE_SEARCH = "The native build Mako runs searches through Bash with its bundled bfs and defines no such tool in any mode; saved sessions still record it."
const TODO_TOOLS = "Defined only with CLAUDE_CODE_ENABLE_TODO_TOOLS set, which Mako doesn't set; the 2.1.290 CLI's print run defines it."

export const CLAUDE_VOCABULARY = defineVocabulary({
  harness: "claude",
  checked: {
    version: "2.1.283",
    on: "2026-10-06",
    against: "the model request of the SDK's Claude Code 2.1.283, which Mako runs, in every Mako mode (scripts/fixtures/native-tools), the 2.1.290 CLI's print-run tools (scripts/fixtures/native-vocabulary/claude-init.json), and ~/.claude/projects through audit:tools",
  },
  mcp: [],
  tools: {
    Bash: { kind: "shell" },
    Monitor: { kind: "shell" },
    BashOutput: { kind: "shell-output", unlisted: "An older Claude Code's; saved sessions still record it." },
    TaskOutput: { kind: "shell-output", label: "Task output", unlisted: "An older Claude Code's; saved sessions still record it." },
    KillShell: { kind: "shell-stop", aliases: ["KillBash"], unlisted: "An older Claude Code's; saved sessions still record it." },
    TaskStop: { kind: "shell-stop", label: "Stop task" },
    Read: { kind: "read", aliases: ["NotebookRead"] },
    ReadMcpResourceTool: { kind: "read", label: "MCP resource", unlisted: MCP_RESOURCES },
    ReadMcpResourceDirTool: { kind: "list", label: "MCP resources", unlisted: MCP_RESOURCES },
    ListMcpResourcesTool: { kind: "tool-search", label: "MCP resources", unlisted: MCP_RESOURCES },
    Edit: { kind: "edit", aliases: ["MultiEdit"] },
    NotebookEdit: { kind: "edit" },
    Write: { kind: "write" },
    LS: { kind: "list", unlisted: "An older Claude Code's; saved sessions still record it." },
    Grep: { kind: "search", unlisted: NATIVE_SEARCH },
    Glob: { kind: "find", unlisted: NATIVE_SEARCH },
    WebFetch: { kind: "web-fetch" },
    WebSearch: { kind: "web-search" },
    Agent: { kind: "agent", aliases: ["Task"] },
    Workflow: { kind: "agent", label: "Workflow" },
    SendMessage: { kind: "agent-message" },
    ListAgents: { kind: "agents" },
    TodoWrite: { kind: "todo", unlisted: "An older Claude Code's; saved sessions still record it." },
    TaskCreate: { kind: "todo", unlisted: TODO_TOOLS },
    TaskGet: { kind: "todo", unlisted: TODO_TOOLS },
    TaskList: { kind: "todo", unlisted: TODO_TOOLS },
    TaskUpdate: { kind: "todo", unlisted: TODO_TOOLS },
    EnterPlanMode: { kind: "mode", label: "Plan mode" },
    ExitPlanMode: { kind: "plan-exit" },
    AskUserQuestion: { kind: "question" },
    Skill: { kind: "skill", aliases: ["SlashCommand"] },
    ToolSearch: { kind: "tool-search" },
    ScheduleWakeup: { kind: "wait" },
    CronCreate: { kind: "other", label: "Schedule" },
    CronDelete: { kind: "other", label: "Remove schedule" },
    CronList: { kind: "other", label: "Schedules" },
    RemoteTrigger: { kind: "other", label: "Remote trigger", unlisted: "Not in the sealed capture, which has no claude.ai login; the 2.1.290 CLI's print run on one defines it." },
    EnterWorktree: { kind: "other", label: "Enter worktree" },
    ExitWorktree: { kind: "other", label: "Leave worktree" },
    PushNotification: { kind: "other", label: "Notify" },
    SendUserFile: { kind: "other", label: "Send file", unlisted: "An older Claude Code's; saved sessions still record it." },
    ReportFindings: { kind: "other", label: "Report findings" },
    DesignSync: { kind: "other", label: "Design sync" },
  },
  concepts: {
    checked: {
      version: "2.1.290",
      on: "2026-10-06",
      against: "SDK 0.3.283 types (HOOK_EVENTS, Settings, AgentDefinition), code.claude.com docs (memory, hooks, skills, sub-agents, mcp, settings), and the binary through harness:self-report",
    },
    instructions: {
      files: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/AGENTS.md"],
      rules: [".claude/rules"],
      user: ["~/.claude/CLAUDE.md", "~/.claude/rules"],
      order: "Managed policy, then the user's, then every directory from the filesystem root down to the working directory, concatenated, CLAUDE.local.md after CLAUDE.md; a subdirectory's files load when a tool touches it. AGENTS.md is read only where no CLAUDE.md exists (instructionFiles claude-md-or-agents-md). @path imports, four hops deep.",
    },
    hooks: {
      config: ["~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"],
      events: CLAUDE_HOOK_EVENTS,
      control: "Exit 2 blocks with stderr as the reason; exit 0 stdout JSON: continue, decision, hookSpecificOutput (PreToolUse permissionDecision allow|deny|ask|defer, updatedInput). Handlers: command, prompt, agent, http, mcp_tool. Also from plugin hooks/hooks.json and skill or agent frontmatter.",
    },
    skills: ["~/.claude/skills", ".claude/skills"],
    commands: { folders: ["~/.claude/commands", ".claude/commands"], note: "Merged into skills; command files still load, `dir/name.md` as /dir:name." },
    agents: ["~/.claude/agents", ".claude/agents"],
    mcpConfig: ["~/.claude.json", ".mcp.json"],
    output: {
      live: "Agent SDK over stream-json, with control requests",
      headless: ["text", "json", "stream-json"],
      store: "~/.claude/projects/<working directory, non-alphanumerics as ->/<session>.jsonl, with <session>/subagents/",
    },
    models: "SDK supportedModels() (control request list_models)",
    distinct: [
      { name: "Context breakdown", via: "getContextUsage: categories, memory files, MCP tools, messages" },
      { name: "Checkpoints", via: "rewindFiles(userMessageId), /rewind" },
      { name: "Output styles", via: "~/.claude/output-styles, .claude/output-styles; outputStyle" },
      { name: "Plugins", via: ".claude-plugin/plugin.json and marketplaces" },
      { name: "Background agents", via: "claude --bg, claude agents" },
    ],
  },
})

/**
 * The `usage` Claude's API reports on each assistant message and on a
 * turn's result, as the SDK streams it and the session file saves it.
 * `input_tokens` leaves out what the cache supplied.
 */
export const ClaudeUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
  cache_creation: z.object({ ephemeral_1h_input_tokens: tokenCount }).nullish().catch(undefined),
  /** `standard` or `fast`: the mode the call was made in. */
  speed: z.string().nullish().catch(undefined),
})
export type ClaudeUsage = z.infer<typeof ClaudeUsage>

export function claudeTokens(usage: ClaudeUsage): HarnessTokens {
  return exclusiveTokens({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  })
}

/** The part of `cacheWrite` written to the one-hour cache, which Anthropic prices apart from the five-minute one. */
export function claudeHourCacheWrites(usage: ClaudeUsage): number {
  return usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
}
