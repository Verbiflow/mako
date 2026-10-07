import { z } from "zod"
import type { AcpToolReading } from "../acp-tool-details.js"
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
      { name: "Credits and ACUs", via: "usage_update _meta totalCreditCost, totalAcuCost" },
    ],
  },
})

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
  omits: (part) => part.type === "content" && part.content.type === "resource" && part.content.resource.uri === "tool://preview",
  status: (update) => update._meta?.["cognition.ai/canceled"] === true ? "canceled" : undefined,
}

const PlanFileInputSchema = z.object({ file_path: z.string() })
