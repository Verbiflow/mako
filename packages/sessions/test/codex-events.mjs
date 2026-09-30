import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexProvider } from "../dist/providers/codex.js"

const home = await mkdtemp(join(tmpdir(), "mako-codex-events-"))
const sessions = join(home, ".codex", "sessions")
await mkdir(sessions, { recursive: true })
const line = (type, payload) => JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", type, payload }) + "\n"
const user = (text) => line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] })
const answer = (text) => line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] })
const tokens = (total) => line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } } })
const markers = (thread) => thread.entries.flatMap((entry) =>
  entry.kind === "event" ? [{ label: entry.label, detail: entry.detail, body: entry.body, tone: entry.tone }] : [])
  .map((marker) => Object.fromEntries(Object.entries(marker).filter(([, value]) => value !== undefined)))

// Paginated rollouts, the only mode Codex writes now, never record
// `event_msg/context_compacted`; the top-level `compacted` record is the boundary.
const paginated = join(sessions, "rollout-paginated.jsonl")
await writeFile(paginated,
  line("session_meta", { id: "paginated", cwd: home, history_mode: "paginated" }) +
  user("Refactor the parser") +
  answer("Working on it.") +
  tokens(245_000) +
  line("compacted", { message: "", replacement_history: [{ type: "compaction", encrypted_content: "opaque" }] }) +
  line("event_msg", { type: "item_completed", item: { type: "ContextCompaction", id: "c1" } }) +
  answer("Continuing after compaction.") +
  line("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "Continuing after compaction.", error: null }) +
  user("Keep going") +
  line("event_msg", { type: "task_complete", turn_id: "t2", last_agent_message: null, error: {
    message: "Selected model is at capacity. Please try a different model.", codex_error_info: "server_overloaded",
  } }) +
  user("Try the new model") +
  line("event_msg", { type: "task_complete", turn_id: "t3", last_agent_message: null, error: {
    message: "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The model requires a newer version of Codex.\"}}",
    codex_error_info: "other",
  } }) +
  line("event_msg", { type: "task_complete", turn_id: "t4", last_agent_message: null, error: {
    message: "Error running remote compact task: stream disconnected before completion", codex_error_info: { response_stream_disconnected: { http_status_code: null } },
  } }) +
  line("event_msg", { type: "item_completed", item: { type: "EnteredReviewMode", id: "r1", target: { type: "uncommittedChanges" }, user_facing_hint: "current changes" } }) +
  line("event_msg", { type: "item_completed", item: { type: "ExitedReviewMode", id: "r2", review_output: { findings: [], overall_correctness: "correct", overall_explanation: "No issues found.", overall_confidence_score: 0.9 } } })
)
const thread = await new CodexProvider(home).read(paginated)
assert.ok(thread)
assert.deepEqual(markers(thread), [
  { label: "Context compacted", detail: "from 245k tokens" },
  { label: "Turn failed", detail: "Server overloaded", body: "Selected model is at capacity. Please try a different model.", tone: "error" },
  { label: "Turn failed", detail: "The model requires a newer version of Codex.", tone: "error" },
  { label: "Compaction failed", detail: "Connection lost", tone: "warning" },
  { label: "Review mode started", detail: "current changes" },
  { label: "Review mode ended", body: "No issues found." },
])
assert.equal(thread.entries.filter((entry) => entry.kind === "assistant").length, 2, "the compaction splits the turn around it")

// Legacy rollouts record one compaction twice, with the local summary.
const legacy = join(sessions, "rollout-legacy.jsonl")
await writeFile(legacy,
  line("session_meta", { id: "legacy", cwd: home }) +
  user("First") +
  answer("One") +
  line("compacted", { message: "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools.\nThe parser now streams.", replacement_history: [] }) +
  line("event_msg", { type: "context_compacted" }) +
  answer("Two") +
  line("event_msg", { type: "context_compacted" }) +
  line("compacted", { message: "", replacement_history: [] }) +
  answer("Three") +
  line("event_msg", { type: "context_compacted" })
)
assert.deepEqual(markers(await new CodexProvider(home).read(legacy)), [
  { label: "Context compacted", body: "The parser now streams." },
  { label: "Context compacted" },
  { label: "Context compacted" },
], "a compaction recorded twice is marked once; a lone record still marks one")

await rm(home, { recursive: true, force: true })
console.log("Codex history markers: compactions, failed turns and review boundaries read as Mako events.")
