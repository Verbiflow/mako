import { defineVocabulary } from "./vocabulary.js"

/**
 * Names are the SDK's live ones (`ToolType` in `@cursor/sdk`, which
 * `electron/providers/cursor/sdk/vocabulary-check.ts` holds this list to);
 * aliases are what Cursor's CLI, ACP and Desktop stores record.
 */
const STORES_ONLY = "Cursor's CLI, ACP and Desktop stores record it; the SDK reports no such tool-call type."

export const CURSOR_VOCABULARY = defineVocabulary({
  harness: "cursor",
  checked: {
    version: "SDK 1.0.31",
    on: "2026-10-05",
    against: "@cursor/sdk ToolType and its tool-call schema (scripts/fixtures/native-tools), and Cursor's SDK, CLI and Desktop stores through audit:tools",
  },
  mcp: ["s-t"],
  tools: {
    shell: { kind: "shell" },
    read: { kind: "read", aliases: ["ReadFile"] },
    write: { kind: "write" },
    edit: { kind: "edit", aliases: ["StrReplace", "StrictReplace", "ApplyPatch"] },
    delete: { kind: "delete" },
    glob: { kind: "find", keys: { pattern: ["globPattern", "glob_pattern", "pattern"] } },
    grep: { kind: "search", aliases: ["rg"] },
    ls: { kind: "list" },
    semSearch: { kind: "search", label: "Semantic search" },
    readLints: { kind: "read", label: "Lints" },
    mcp: { kind: "mcp", label: "MCP tool", wraps: { form: "arguments", server: "providerIdentifier", tool: "toolName", args: "args", titleRoute: true } },
    generateImage: { kind: "image" },
    createPlan: { kind: "plan" },
    updateTodos: { kind: "todo", aliases: ["TodoWrite", "todo_write"] },
    readTodos: { kind: "todo", unlisted: STORES_ONLY },
    task: { kind: "agent", aliases: ["Subagent"] },
    recordScreen: { kind: "other", label: "Record screen" },
    askQuestion: { kind: "question", unlisted: STORES_ONLY },
    webSearch: { kind: "web-search", keys: { query: ["query", "searchTerm", "search_term"] }, unlisted: STORES_ONLY },
    webFetch: { kind: "web-fetch", unlisted: STORES_ONLY },
    AwaitShell: { kind: "shell-output", unlisted: STORES_ONLY },
    SwitchMode: { kind: "mode", unlisted: STORES_ONLY },
    GetDynamicTools: { kind: "tool-search", unlisted: STORES_ONLY },
    CallDynamicTool: { kind: "mcp", wraps: { form: "arguments", server: "namespace", tool: "toolName", args: "arguments", builtin: "cursor" }, unlisted: STORES_ONLY },
  },
  concepts: {
    checked: {
      version: "SDK 1.0.31",
      on: "2026-10-06",
      against: "@cursor/sdk 1.0.31 types and bundle (settingSources loaders, hook enum, skill and agent folders), cursor.com/docs (rules, hooks, skills, subagents), and the request context its agent sends, through harness:self-report",
    },
    instructions: {
      files: ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".cursorrules"],
      rules: [".cursor/rules"],
      user: [],
      order: "With settingSources project: each workspace root and its ancestors, nested rules included; each file is always applied. A .cursor/rules/*.mdc applies always, by globs, by description or manually, from its frontmatter. User Rules aren't on disk.",
    },
    hooks: {
      config: ["~/.cursor/hooks.json", ".cursor/hooks.json", "~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"],
      events: [
        "beforeShellExecution", "beforeMCPExecution", "afterShellExecution", "afterMCPExecution", "beforeReadFile", "afterFileEdit",
        "beforeTabFileRead", "afterTabFileEdit", "stop", "beforeSubmitPrompt", "afterAgentResponse", "afterAgentThought",
        "sessionStart", "sessionEnd", "preCompact", "subagentStart", "subagentStop", "preToolUse", "postToolUse", "postToolUseFailure", "workspaceOpen",
      ],
      control: "{ version: 1, hooks } per source; Claude settings map onto these names. permission allow|deny|ask, deny over ask over allow; exit 2 denies, other failures pass unless failClosed. In the SDK a denied shell call throws.",
    },
    // Not `~/.cursor/skills-cursor`: the SDK syncs Cursor's builtin skills
    // there from its service before loading, and a skill put there isn't loaded.
    skills: [
      ".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills", ".grok/skills",
      "~/.cursor/skills", "~/.agents/skills", "~/.claude/skills", "~/.codex/skills", "~/.grok/skills",
    ],
    commands: { absent: "The SDK loads no command folder; Cursor moved commands into skills (disable-model-invocation)." },
    agents: [".cursor/agents", ".claude/agents"],
    mcpConfig: ["~/.cursor/mcp.json", ".cursor/mcp.json"],
    output: {
      live: "@cursor/sdk run stream and deltas, in a Mako-owned child",
      headless: ["text", "json", "stream-json"],
      store: "SQLite index.db and agents/<agent>/store.db under the SDK state root (Mako's: ~/.mako/cursor-sdk); cursor-agent keeps ~/.cursor/chats/<hash>/<id>/store.db",
    },
    models: "Cursor.models.list(), parameters per model",
  },
})

/** Every name Cursor records for writing its todo list, whose arguments hold the list. */
export const CURSOR_TODO_WRITES: ReadonlySet<string> = new Set(["updateTodos", ...CURSOR_VOCABULARY.tools.updateTodos.aliases ?? []])

/**
 * The content parts a Cursor store message holds, by role: the AI SDK's
 * `ModelMessage` parts Cursor's agent writes, as the SDK's own transcript
 * reader (1.0.31) names them. A `system` message is the prompt Cursor
 * sends, never drawn; `redacted-reasoning` is thinking the provider
 * withheld, which history leaves out as Claude's is. 207 local stores on
 * 2026-10-07 held no other role or part.
 */
export const CURSOR_MESSAGE_PARTS = {
  system: [],
  user: ["text", "image", "file"],
  assistant: ["text", "reasoning", "redacted-reasoning", "tool-call", "image", "file"],
  tool: ["tool-result"],
} as const satisfies Record<string, readonly string[]>

const MESSAGE_PARTS = new Map(Object.entries(CURSOR_MESSAGE_PARTS).map(([role, parts]) => [role, new Set<string>(parts)]))

/** Whether a Cursor `role` message holds parts of `type`. */
export function cursorMessagePart(role: string, type: string): boolean {
  return MESSAGE_PARTS.get(role)?.has(type) ?? false
}
