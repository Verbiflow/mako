import { defineVocabulary } from "./vocabulary.js"
import { SETUP_NOTICES, STOP_MARKER, type StreamDifference } from "../stream-merge.js"

/**
 * Names are the SDK's live ones (`ToolType` in `@cursor/sdk`, which
 * `packages/host/src/harnesses/cursor/sdk/vocabulary-check.ts` holds this list to);
 * aliases are what Cursor's CLI, ACP and Desktop stores record.
 */
const STORES_ONLY = "Cursor's CLI, ACP and Desktop stores record it; the SDK reports no such tool-call type."

/**
 * Why a run expired, as far as its record says: the SDK marks a run whose
 * process died `EXPIRED` (`force_send`) when the next send finds it, and
 * keeps nothing of how the process ended.
 */
export const CURSOR_RUN_LOST = "Cursor's SDK process ended before the turn did"

/**
 * A run whose SDK process died: Mako draws the failure from the exit it saw
 * ("Cursor's SDK process exited (signal SIGKILL)"), the reader from the
 * record (`CURSOR_RUN_LOST`).
 */
/**
 * A summary Cursor made on its server, which SDK 1.0.31 streams nothing
 * about: the child marks it when the first root holding its window lands,
 * and the SDK writes that root only after the step the summary preceded has
 * run. Verified 2026-10-17 (composer-2.5): the root archiving the window,
 * still reading 188,331, was written one row before that step's own
 * checkpoint and after both of its reads had ended. The record places it
 * before the step; the merge keeps the record's place.
 */
const SUMMARY_LANDS_LATE: StreamDifference = {
  holds: "order",
  entry: { type: "event", label: /^Context compacted$/ },
  why: "Cursor writes the checkpoint showing a server-side summary after the step the summary preceded (a real composer-2.5 turn of 2026-10-17), so live the marker lands a step after the record places it.",
}

const RUN_LOST: StreamDifference = {
  holds: "changed",
  entry: { type: "event", label: /^Turn failed$/, detail: new RegExp(`^${CURSOR_RUN_LOST}$`) },
  why: "SDK 1.0.31 records a run its process died under as EXPIRED (force_send) and nothing of how the process ended, which the host words from the exit it saw; the flows' killed turns 82f23d46 (2026-10-16) and 2543fd18 (2026-10-17) read so.",
}

export const CURSOR_VOCABULARY = defineVocabulary({
  harness: "cursor",
  checked: {
    version: "SDK 1.0.40",
    on: "2026-10-25",
    against: "@cursor/sdk ToolType and its tool-call schema (scripts/fixtures/native-tools; 1.0.40 added computerUse), and Cursor's SDK, CLI and Desktop stores through audit:tools",
  },
  mcp: ["s-t"],
  // `cursorUnfinishedToolNote` for a call the SDK's hooks refused: it reports no result of its own.
  refusals: [/^Cursor did not run this call/],
  tools: {
    shell: { kind: "shell", effects: { cwd: ["workingDirectory", "working_directory"], exitCode: "result.value.exitCode" } },
    read: { kind: "read", aliases: ["ReadFile"] },
    write: { kind: "write", effects: { content: ["fileText", "contents", "content"] } },
    edit: {
      kind: "edit", aliases: ["StrReplace", "StrictReplace", "ApplyPatch"],
      effects: { edits: { old: ["old_string", "strReplace.oldText", "oldText"], new: ["new_string", "strReplace.newText", "newText"], all: "replace_all" }, reported: { form: "unified", key: "value.diffString" } },
    },
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
    computerUse: { kind: "computer", label: "Computer use" },
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
      version: "SDK 1.0.40",
      on: "2026-10-25",
      against: "@cursor/sdk 1.0.40 types and bundle (settingSources loaders, hook enum, skill and agent folders), cursor.com/docs (rules, hooks, skills, subagents), and the request context its agent sends, through harness:self-report",
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
    },
    models: "Cursor.models.list(), parameters per model",
  },
  storage: {
    checked: {
      version: "cursor-agent 2026.10.01",
      on: "2026-10-13",
      against: "the store.db files cursor-agent 2026.10.01 and SDK 1.0.31 wrote: every sampled blob plaintext, though meta can carry a blobEncryptionKey",
    },
    where: "SQLite index.db and agents/<agent>/store.db under the SDK state root (Mako's: ~/.mako/cursor-sdk); cursor-agent keeps ~/.cursor/chats/<hash>/<id>/store.db, content-addressed blobs and a meta row",
    encodings: ["plain"],
    history: {
      branches: "meta.latestRootBlobId (an SDK agent's in index.db's agents.latest_checkpoint_ref_json): the root blob whose turns are the conversation; older roots are earlier states, each run's last in runs.latest_checkpoint_ref_json. A fork is a new agent indexed at one of them in a clone of its source's store; nothing in it names the source",
    },
    // Nothing a cut-off run streamed is the stream's alone: the SDK keeps a
    // stopped or killed run whole in its own record (index.db's runs row and
    // run_events, store.db's prompt record), checkpointed or not, and the
    // reader replays it from there (`CursorProvider.unrecordedTurn`).
    stream: [SETUP_NOTICES, STOP_MARKER, RUN_LOST, SUMMARY_LANDS_LATE],
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
