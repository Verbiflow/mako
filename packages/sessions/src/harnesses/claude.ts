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
