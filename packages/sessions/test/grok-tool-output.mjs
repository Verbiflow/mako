import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acpToolFields } from "../dist/acp-tool-details.js"
import { GROK_ACP_HOOKS } from "../dist/harnesses/grok.js"
import { GrokProvider } from "../dist/providers/grok.js"

/**
 * Grok (1.0.46) keeps what a tool gave the model in `rawOutput`, under a field
 * its `type` names; ACP's `content` holds a line for Grok's own client or
 * nothing. The shapes below are from real sessions. Read live (the decoder's
 * `acpToolFields` with Grok's hooks) and saved (`updates.jsonl` through the
 * provider), each call shows the same output: the model's, never the client's
 * "found 5 matches" or nothing at all.
 */

const grepped = '<workspace_result workspace_path="/work">\nFound 2 matching lines:\nnotes.md:3: Remember: Priya owns billing.\nnotes.md:9: The flag is ledger_backfill_v4.\n</workspace_result>'
const calls = [
  {
    id: "grep",
    title: "grep Priya|flag",
    update: { content: [{ type: "content", content: { type: "text", text: "found 2 matches" } }], rawOutput: { type: "GrepSearch", stdout: [...Buffer.from(grepped)], stderr: [], exit_code: 0, match_count: 2 } },
    output: grepped,
  },
  {
    id: "list",
    title: "list /work",
    update: { rawOutput: { type: "ListDir", Content: { content: "- /work/\n  - a1.txt\n  - notes.md", absolute_root_path: "/work" } } },
    output: "- /work/\n  - a1.txt\n  - notes.md",
  },
  {
    id: "mcp",
    title: "thread_history",
    update: { rawOutput: { type: "MCP", tool_name: "thread_history", server_name: "mako", output: { OkayOutput: '1 hit for "flag", newest first.\n[3.2/output] ledger_backfill_v4' } } },
    output: '1 hit for "flag", newest first.\n[3.2/output] ledger_backfill_v4',
  },
  {
    id: "mcp-error",
    title: "thread_history",
    status: "failed",
    update: { rawOutput: { type: "MCP", tool_name: "thread_history", server_name: "mako", output: { Error: "thread:devin:1 isn't one this Thread's messages referenced." }, is_error: true } },
    output: "thread:devin:1 isn't one this Thread's messages referenced.",
  },
  {
    id: "edit",
    title: "edit NEXT.md",
    update: {
      content: [{ type: "diff", path: "/work/NEXT.md", oldText: "", newText: "orca\n" }],
      rawOutput: { type: "SearchReplace", EditsApplied: { old_string: "", new_string: "orca\n", tool_output_for_prompt: "The file /work/NEXT.md has been created.", absolute_path: "/work/NEXT.md", edits: [] } },
    },
    output: "The file /work/NEXT.md has been created.",
  },
  {
    id: "todo",
    title: "todos",
    update: { rawOutput: { type: "Todo", TodosUpdated: { summary_for_prompt: "- [in_progress] create: Create goal-proof.txt", todos: [], state: { todos: {} } } } },
    output: "- [in_progress] create: Create goal-proof.txt",
  },
  {
    id: "bash",
    title: "echo hi",
    update: { content: [{ type: "content", content: { type: "text", text: "hi\n" } }], rawOutput: { type: "Bash", output: [...Buffer.from("hi\n")], output_for_prompt: "hi\nexit: 0\n", exit_code: 0, command: "echo hi" } },
    output: "hi\n",
  },
]

// Live: the decoder reads each update with Grok's hooks.
for (const call of calls) {
  const fields = acpToolFields({ toolCallId: call.id, status: call.status ?? "completed", ...call.update }, GROK_ACP_HOOKS.toolReading)
  assert.equal(fields.output, call.output, `${call.id}: live`)
}
assert.equal(acpToolFields({ toolCallId: "plain", status: "completed", content: [{ type: "content", content: { type: "text", text: "plain" } }] }, GROK_ACP_HOOKS.toolReading).output, "plain", "an update without rawOutput reads as ACP does")

// Saved: the same updates in `updates.jsonl`, read by the provider.
const home = mkdtempSync(join(tmpdir(), "sessions-grok-tool-output-"))
try {
  const dir = join(home, ".grok", "sessions", "%2Fwork", "tool-output-session")
  await mkdir(dir, { recursive: true })
  let event = 0
  const line = (update, at) => `${JSON.stringify({ timestamp: at, method: "session/update", params: { sessionId: "tool-output-session", update, _meta: { eventId: `event-${event++}`, agentTimestampMs: at * 1000 } } })}\n`
  let text = line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "look around" } }, 1)
  let at = 2
  for (const call of calls) {
    text += line({ sessionUpdate: "tool_call", toolCallId: call.id, title: call.title, status: "in_progress", rawInput: {} }, at++)
    text += line({ sessionUpdate: "tool_call_update", toolCallId: call.id, status: call.status ?? "completed", ...call.update }, at++)
  }
  const updates = join(dir, "updates.jsonl")
  await writeFile(updates, text)
  await writeFile(join(dir, "summary.json"), JSON.stringify({ info: { id: "tool-output-session", cwd: "/work" }, created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:01:00.000Z" }))
  const thread = await new GrokProvider(home).read(updates)
  assert.ok(thread, "the saved session reads")
  for (const call of calls) {
    const tool = thread.entries.find((entry) => entry.type === "tool" && entry.id.endsWith(call.id))
    assert.ok(tool, `${call.id}: saved call is drawn`)
    assert.equal(tool.output, call.output, `${call.id}: saved`)
  }
  console.log("PASS: Grok's search, listing, MCP result and error, edit and todo outputs read from rawOutput, live and saved alike; a command's reads as before")
} finally {
  rmSync(home, { recursive: true, force: true })
}
