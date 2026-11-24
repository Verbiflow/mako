import { exclusiveTokens, type HarnessTokens } from "./tokens.js"
import { defineVocabulary } from "./vocabulary.js"
import { DIRECT_MESSAGES, SETUP_NOTICES } from "../stream-merge.js"

const checked = { version: "1.5.15", on: "2026-11-23", against: "The official agy ACP worker's Gemini request, session/new response and saved conversation." }
export const ANTIGRAVITY_VOCABULARY = defineVocabulary({
  harness: "antigravity", checked, mcp: [],
  tools: {
    read_file: { kind: "read" }, run_command: { kind: "shell" }, manage_task: { kind: "todo" },
    send_message: { kind: "agent-message" }, schedule: { kind: "other" }, invoke_subagent: { kind: "agent" },
    define_subagent: { kind: "agents" }, manage_subagents: { kind: "agents" }, write_file: { kind: "write" },
    edit_file: { kind: "edit" }, search_web: { kind: "web-search" }, run_workflow: { kind: "skill" },
    swarm: { kind: "agents" }, ask_question: { kind: "question" },
  },
  lacks: { search: "It defines no search tool: the agent searches files with grep or rg through run_command." },
  concepts: {
    checked, instructions: { files: ["GEMINI.md"], rules: [".agents/rules"], user: ["~/.gemini/GEMINI.md"], order: "The CLI loads its global and project instructions." },
    hooks: { absent: "Mako does not install hooks for the ACP worker." },
    // In the order the CLI reads them, the first skill of a name winning; it never reads `~/.agents/skills`.
    skills: ["~/.gemini/config/skills", ".gemini/skills", "~/.gemini/antigravity-cli/skills", ".agents/skills", ".agent/skills"],
    commands: { folders: [".agents/workflows"] }, agents: [], mcpConfig: ["~/.gemini/config/mcp_config.json"],
    output: { live: "ACP over stdio", headless: ["text", "json", "stream-json"] },
    models: "The model and thinking-level config options in ACP session/new.",
  },
  storage: { checked, where: "A SQLite file per conversation under the agent's data directory, and one row in conversation_summaries.db.",
    encodings: ["plain"], history: {}, stream: [SETUP_NOTICES, DIRECT_MESSAGES] },
})

/** A protobuf message the CLI stores, by field number: its varints, and its length-delimited values. */
export interface ProtoFields {
  varints: ReadonlyMap<number, number>
  bytes: ReadonlyMap<number, readonly Uint8Array[]>
}

/**
 * A call's counts in the CLI's store, by field number: input the cache didn't
 * supply (2), read from the cache (5), written to it (4), and output (3), or
 * its reasoning (9) and its reply (10) where those are all it gives.
 */
export function agyStoredTokens(usage: ProtoFields): HarnessTokens {
  const count = (field: number) => usage.varints.get(field) ?? 0
  const output = Math.max(count(3), count(9) + count(10))
  return exclusiveTokens({ input: count(2), cacheRead: count(5), cacheWrite: count(4), output, reasoning: Math.min(output, count(9)) })
}
