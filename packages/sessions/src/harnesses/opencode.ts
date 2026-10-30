import { z } from "zod"
import { exclusiveTokens, tokenCount, type HarnessTokens } from "./tokens.js"
import { defineVocabulary } from "./vocabulary.js"
import { RETRY_MARKERS, SETUP_NOTICES, STOP_MARKER } from "../stream-merge.js"

/** The server lists agents, commands and skills but not its tools; these come from its events and stores. */
export const OPENCODE_VOCABULARY = defineVocabulary({
  harness: "opencode",
  checked: {
    version: "2.2.3",
    on: "2026-10-30",
    against: "the model request of 2.2.3's native API per agent on an Anthropic and an OpenAI model (scripts/fixtures/native-tools; 2.2.3 adds experimental_image_generate where a provider has an image model, OpenAI's here, and rewords shell and execute), opencode.db and opencode-next.db through audit:tools as of 2026-10-12, and the permission names Mako launches with",
  },
  mcp: [],
  tools: {
    shell: { kind: "shell", aliases: ["bash"], effects: { cwd: "workdir", background: "background", exitCode: "result.exit" } },
    read: { kind: "read" },
    edit: { kind: "edit", aliases: ["multiedit"], effects: { edits: { old: "oldString", new: "newString", all: "replaceAll", list: "edits" }, reported: { form: "files", key: "files" } } },
    patch: { kind: "edit", aliases: ["apply_patch"], effects: { patch: "patchText", reported: { form: "files", key: "files" } } },
    write: { kind: "write", effects: { content: "content", reported: { form: "files", key: "files" } } },
    list: { kind: "list", unlisted: "2.0.27 defines it for neither model family nor any agent Mako uses; older sessions record it." },
    glob: { kind: "find" },
    grep: { kind: "search" },
    webfetch: { kind: "web-fetch" },
    websearch: { kind: "web-search" },
    subagent: { kind: "agent", aliases: ["task"] },
    todowrite: { kind: "todo", aliases: ["todoread"], unlisted: "2.0.27 defines it for neither model family nor any agent Mako uses; older sessions record it." },
    question: { kind: "question" },
    skill: { kind: "skill" },
    execute: { kind: "code", wraps: { form: "script", key: "code" }, effects: { calls: "result.toolCalls" } },
    // Generates or edits an image in the background and saves it to `path`; its job's end is a synthetic notice.
    experimental_image_generate: { kind: "image" },
    search: { kind: "tool-search", unlisted: "2.0.27 defines it for neither model family nor any agent Mako uses; older sessions record it." },
  },
  concepts: {
    checked: {
      version: "2.2.3",
      on: "2026-10-30",
      against: "the 2.2.3 binary's bundled loaders through harness:self-report (every declared name, and every skill and MCP place listed), and @opencode/schema and @opencode/protocol 2.0.27 types as read on 2026-10-12 (opencode.ai/docs still describe 1.x)",
    },
    instructions: {
      files: ["AGENTS.md"],
      rules: [],
      user: ["~/.config/opencode/AGENTS.md"],
      order: "The global file, then every AGENTS.md from the working directory up to the project directory; watched. No CLAUDE.md fallback in 2.x.",
    },
    hooks: {
      config: ["~/.config/opencode/plugins", "~/.config/opencode/plugin", ".opencode/plugins", ".opencode/plugin"],
      events: [
        "tool.execute.before", "tool.execute.after", "session.prompt", "session.title", "session.context", "session.compaction",
        "session.generate", "session.model.request", "session.http.request", "session.http.response", "session.retry",
        "permission.evaluate", "shell.create.before",
      ],
      composed: true,
      control: "Plugins, not shell hooks: a module exporting { id, effect | setup } that mutates the payload of tool execute.before/after, session prompt…retry, permission evaluate and shell create.before. Also the plugins config key.",
    },
    skills: ["~/.config/opencode/skills", "~/.config/opencode/skill", ".opencode/skills", ".opencode/skill", "~/.claude/skills", ".claude/skills", "~/.agents/skills", ".agents/skills"],
    commands: { folders: ["~/.config/opencode/commands", "~/.config/opencode/command", ".opencode/commands", ".opencode/command"], note: "Also the commands config key; $1…$N, $ARGUMENTS and !`cmd`." },
    agents: ["~/.config/opencode/agents", "~/.config/opencode/agent", ".opencode/agents", ".opencode/agent"],
    mcpConfig: ["~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc", "opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"],
    output: {
      live: "opencode serve HTTP API under /api with SSE /api/event, through @opencode/client",
      headless: ["run --format json"],
    },
    models: "GET /api/model (opencode models)",
  },
  storage: {
    checked: {
      version: "2.0.27",
      on: "2026-10-13",
      against: "anomalyco/opencode at 5aabb619c0 (packages/core session projector.ts, revert.ts, sql.ts; packages/schema session-revert.ts) and the opencode.db that 2.0.1 and 2.0.27 wrote",
    },
    where: "~/.local/share/opencode/opencode.db (SQLite: session_v2 and session_message; a store migrated from v1 keeps session, message and part beside them)",
    encodings: ["plain"],
    history: {
      "holds-undo": "session_v2.revert (session.revert in v1): messages from its messageID on, from its partID on in v1, until the next prompt commits it",
      copies: "session_v2.fork_session_id; a v1 fork only by its \"(fork #n)\" title",
      generations: "session (v1) beside session_v2: OpenCode 2 writes only session_v2",
    },
    stream: [SETUP_NOTICES, STOP_MARKER, RETRY_MARKERS],
  },
})

/**
 * A step's `tokens`, on the live event (`session.step.ended`) and in a saved
 * assistant message alike. OpenCode counts cached input beside `input` and
 * reasoning beside `output`.
 */
export const OpenCodeTokens = z.object({
  input: tokenCount,
  output: tokenCount,
  reasoning: tokenCount,
  cache: z.object({ read: tokenCount, write: tokenCount }).nullish().catch(undefined),
})
export type OpenCodeTokens = z.infer<typeof OpenCodeTokens>

/** A saved message's `tokens`, which one that never finished a step lacks. */
export const OpenCodeSavedTokens = OpenCodeTokens.nullish().catch(undefined)

export function openCodeTokens(tokens: OpenCodeTokens): HarnessTokens {
  return exclusiveTokens({
    input: tokens.input,
    cacheRead: tokens.cache?.read,
    cacheWrite: tokens.cache?.write,
    output: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
    reasoning: tokens.reasoning,
  })
}

/**
 * The `session_message` rows OpenCode writes, by `type`, from the
 * `Session.Message.*` schemas in its build, and whether history draws them.
 * System rows are instructions OpenCode tells the model, and skill rows the
 * skills it loaded into context. The switches are the person's own picks of
 * agent, model and working location, which the composer shows and the live
 * session doesn't draw. An idle row marks where a turn ended. `scripts/test-harness-records.ts` holds these
 * tables to the installed OpenCode.
 */
export const OPENCODE_MESSAGES = {
  user: "read",
  assistant: "read",
  synthetic: "read",
  shell: "read",
  compaction: "read",
  system: "skipped",
  skill: "skipped",
  "agent-switched": "skipped",
  "model-switched": "skipped",
  "location-switched": "skipped",
  idle: "skipped",
} as const satisfies Record<string, "read" | "skipped">

/** An assistant row's `content` parts by `type`. */
export const OPENCODE_ASSISTANT_CONTENT: ReadonlySet<string> = new Set(["text", "reasoning", "tool"])

/**
 * The `part` rows OpenCode 1.x wrote, by `type` (its `SessionV1.*Part` schemas).
 * Snapshots, patches and step starts are its own bookkeeping; an agent or
 * subtask part's work is drawn from the tool call that ran it.
 */
export const OPENCODE_LEGACY_PARTS = {
  text: "read",
  reasoning: "read",
  file: "read",
  tool: "read",
  retry: "read",
  "step-finish": "read",
  compaction: "read",
  "step-start": "skipped",
  snapshot: "skipped",
  patch: "skipped",
  agent: "skipped",
  subtask: "skipped",
} as const satisfies Record<string, "read" | "skipped">
