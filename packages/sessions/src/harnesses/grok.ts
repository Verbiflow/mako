import { z } from "zod"
import { defineVocabulary } from "./vocabulary.js"

/**
 * Names are `_meta["x.ai/tool"].name` on each ACP tool call. Server-side
 * search tools carry no name, only their title; `titles` names them.
 */
export const GROK_VOCABULARY = defineVocabulary({
  harness: "grok",
  checked: {
    version: "1.0.46",
    on: "2026-10-06",
    against: "the model request of grok agent stdio 1.0.46 in every Mako mode (scripts/fixtures/native-tools), and ~/.grok/sessions updates.jsonl through audit:tools",
  },
  mcp: ["s__t"],
  tools: {
    run_terminal_command: { kind: "shell" },
    monitor: { kind: "shell" },
    get_command_or_subagent_output: { kind: "shell-output", label: "Command output" },
    kill_command_or_subagent: { kind: "shell-stop" },
    read_file: { kind: "read" },
    list_dir: { kind: "list" },
    grep: { kind: "search" },
    search_replace: { kind: "edit" },
    write: { kind: "write" },
    web_search: { kind: "web-search" },
    x_search: { kind: "web-search", label: "X search", unlisted: "A server-side xAI search, reported by title; the request Grok sends defines no such tool." },
    web_fetch: { kind: "web-fetch", unlisted: "An older Grok's (last recorded 2026-09-24); 1.0.46 defines none." },
    search_tool: { kind: "tool-search" },
    todo_write: { kind: "todo" },
    spawn_subagent: { kind: "agent" },
    enter_plan_mode: { kind: "mode", label: "Plan mode" },
    exit_plan_mode: { kind: "plan-exit" },
    ask_user_question: { kind: "question" },
    use_tool: { kind: "mcp", wraps: { form: "arguments", tool: "tool_name", args: "tool_input" } },
    workflow: { kind: "agent", label: "Workflow" },
    scheduler_create: { kind: "other", label: "Schedule" },
    scheduler_delete: { kind: "other", label: "Remove schedule" },
    scheduler_list: { kind: "other", label: "Schedules" },
    send_feedback: { kind: "other", label: "Send feedback" },
    image_gen: { kind: "image" },
    image_edit: { kind: "image", label: "Edit image" },
    image_to_video: { kind: "image", label: "Generate video" },
    reference_to_video: { kind: "image", label: "Generate video" },
  },
  concepts: {
    checked: {
      version: "1.0.46",
      on: "2026-10-06",
      against: "the user guide grok 1.0.46 ships in ~/.grok/docs, grok --help, an initialize-only ACP call, and the binary through harness:self-report",
    },
    instructions: {
      files: ["Agents.md", "Claude.md", "CLAUDE.md", "CLAUDE.local.md", "AGENT.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/CLAUDE.local.md"],
      rules: [".grok/rules", ".claude/rules", ".cursor/rules"],
      user: ["~/.grok/rules", "~/.claude/rules", "~/.cursor/rules"],
      order: "Home first (Grok, Claude, Cursor), then the repo root down to the working directory, every match loaded and deeper ones winning; project files need folder trust.",
    },
    hooks: {
      config: ["~/.grok/hooks", ".grok/hooks", "~/.grok/config.toml", "~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json", "~/.cursor/hooks.json", ".cursor/hooks.json"],
      events: [
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "StopFailure",
        "StopCancelled", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "SessionEnd",
      ],
      control: "UserPromptSubmit, PreToolUse and Stop block: decision allow|deny|ask|defer, exit 2 denies, other failures pass. Claude tool names map to Grok's in matchers. An ACP client registers its own through _x.ai/hooks.",
    },
    skills: [".grok/skills", ".claude/skills", ".cursor/skills", ".agents/skills", "~/.grok/skills", "~/.claude/skills", "~/.cursor/skills"],
    commands: { folders: [".grok/commands", ".claude/commands", ".agents/commands", "~/.grok/commands", "~/.claude/commands"] },
    agents: [".grok/agents", ".claude/agents", "~/.grok/agents", "~/.claude/agents"],
    mcpConfig: ["~/.grok/config.toml", ".grok/config.toml", "~/.claude.json", "~/.cursor/mcp.json", ".cursor/mcp.json", ".mcp.json"],
    output: {
      live: "ACP over stdio, with _x.ai extensions",
      headless: ["plain", "json", "streaming-json", "streaming-messages-json"],
      store: "~/.grok/sessions/<encoded working directory>/<id>/updates.jsonl, one ACP update per line, with summary.json and plan.md",
    },
    models: "grok models; the ACP initialize model list",
    distinct: [
      { name: "X search", via: "x_keyword_search and x_semantic_search tools" },
      { name: "Image and video generation", via: "image_gen, /imagine, /imagine-video" },
      { name: "Announcements", via: "_x.ai/announcements/update" },
      { name: "Folder trust", via: "_x.ai/folder_trust/request, ~/.grok/trusted_folders.toml" },
    ],
  },
})

/** Titles that name a server-side tool, which reports no name of its own. */
const GROK_TOOL_TITLES: readonly (readonly [RegExp, string])[] = [
  [/^web search\b/i, "web_search"],
  [/^x search\b/i, "x_search"],
]

/** The part of a Grok tool call's `_meta` that names the tool. */
export const GrokToolMeta = z.object({ "x.ai/tool": z.object({ name: z.string().trim().min(1).optional() }).optional() })
export type GrokToolMeta = z.infer<typeof GrokToolMeta>

/** Grok's name for a tool call, live or saved: `_meta["x.ai/tool"].name`, or the server-side tool its title names. */
export function grokToolName(meta: GrokToolMeta | undefined, title: string | undefined): string | undefined {
  return meta?.["x.ai/tool"]?.name ?? (title ? GROK_TOOL_TITLES.find(([pattern]) => pattern.test(title))?.[1] : undefined)
}
