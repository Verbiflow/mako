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
  concepts: {
    checked, instructions: { files: ["GEMINI.md"], rules: [".agents/rules"], user: ["~/.gemini/GEMINI.md"], order: "The CLI loads its global and project instructions." },
    hooks: { absent: "Mako does not install hooks for the ACP worker." },
    skills: [".agents/skills", ".gemini/skills", ".agent/skills", "~/.gemini/config/skills", "~/.gemini/antigravity-cli/skills"],
    commands: { folders: [".agents/workflows"] }, agents: [], mcpConfig: ["~/.gemini/config/mcp_config.json"],
    output: { live: "ACP over stdio", headless: ["text", "json", "stream-json"] },
    models: "The model and thinking-level config options in ACP session/new.",
  },
  storage: { checked, where: "A SQLite file per conversation under the agent's data directory, and one row in conversation_summaries.db.",
    encodings: ["plain"], history: {}, stream: [SETUP_NOTICES, DIRECT_MESSAGES] },
})
