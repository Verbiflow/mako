import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendPromptAttachments, readPromptAttachments } from "../dist/prompt-attachments.js"
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
assert.deepEqual(thread.entries.flatMap((entry) => entry.kind === "event" ? [entry.source?.record] : []),
  ["c1", "t2:failed", "t3:failed", "t4:failed", undefined, undefined],
  "a compaction cites its turn item, which follows it, and a failed turn its turn, as live markers do")

const aborted = join(sessions, "rollout-aborted.jsonl")
await writeFile(aborted,
  line("session_meta", { id: "aborted", cwd: home, history_mode: "paginated" }) +
  user("Start the migration") +
  line("event_msg", { type: "turn_aborted", turn_id: "t9", reason: "interrupted" })
)
assert.deepEqual((await new CodexProvider(home).read(aborted)).entries.flatMap((entry) => entry.kind === "event" ? [[entry.label, entry.source?.record]] : []),
  [["Interrupted", "t9:interrupted"]], "a stopped turn cites the turn Codex aborted")

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

// Codex records no start for a compaction. Inside a turn it starts right after
// the record before it; outside one that record could be hours old.
const timed = join(sessions, "rollout-timed.jsonl")
const at = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload }) + "\n"
await writeFile(timed,
  line("session_meta", { id: "timed", cwd: home }) +
  at("2026-08-18T02:43:08.427Z", "event_msg", { type: "task_complete", turn_id: "t0", error: null }) +
  at("2026-08-18T08:24:29.964Z", "event_msg", { type: "task_started", turn_id: "t1" }) +
  at("2026-08-18T08:24:40.350Z", "compacted", { message: "", replacement_history: [] }) +
  at("2026-08-18T08:24:40.630Z", "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Compacted." }] }) +
  at("2026-08-18T08:24:41.000Z", "event_msg", { type: "task_complete", turn_id: "t1", error: null }) +
  at("2026-08-18T14:00:00.000Z", "compacted", { message: "", replacement_history: [] })
)
assert.deepEqual(markers(await new CodexProvider(home).read(timed)), [
  { label: "Context compacted", detail: "took 10s" },
  { label: "Context compacted" },
], "a compaction in a turn is timed from the record before it; one outside a turn is not")

const planned = join(sessions, "rollout-plan.jsonl")
await writeFile(planned,
  line("session_meta", { id: "planned", cwd: home }) +
  user("Plan the parser refactor") +
  answer("Here is the plan.\n\n<proposed_plan>\n# Parser\n\n1. Move parsing to the boundary.\n</proposed_plan>") +
  line("event_msg", { type: "item_completed", thread_id: "planned", turn_id: "t1", item: { type: "Plan", id: "t1-plan", text: "# Parser\n\n1. Move parsing to the boundary." } }) +
  line("event_msg", { type: "task_complete", turn_id: "t1", error: null })
)
const plannedBlocks = (await new CodexProvider(home).read(planned)).entries.flatMap((entry) => entry.kind === "assistant" ? entry.blocks : [])
assert.deepEqual(plannedBlocks, [
  { type: "text", text: "Here is the plan." },
  { type: "proposed-plan", id: "codex:t1:t1-plan", text: "# Parser\n\n1. Move parsing to the boundary.", status: "proposed" },
], "a saved plan is the card the live turn showed, and the reply does not repeat it")

const attached = join(sessions, "rollout-mixed-assets.jsonl")
const literal = "User attachment example.pdf (application/pdf): /example.pdf"
const imagePath = join(home, "sample.png")
const reference = { name: "report.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", path: join(home, "report.docx") }
const manifest = appendPromptAttachments("", [reference])
await writeFile(attached,
  line("session_meta", { id: "mixed", cwd: home }) +
  line("response_item", { type: "message", role: "user", content: [
    { type: "input_text", text: literal },
    { type: "input_text", text: `<image name=[Image #1] path="${imagePath}">` },
    { type: "input_image", image_url: "data:image/png;base64,cHJvb2Y=" },
    { type: "input_text", text: "</image>" },
    { type: "input_text", text: "User attachment two pages.pdf (application/pdf): /tmp/two pages.pdf" },
    { type: "input_text", text: manifest },
  ] })
)
const mixed = (await new CodexProvider(home).read(attached)).entries.find(entry => entry.kind === "user")
assert.equal(mixed.text, literal, "the first authored part remains literal; later carrier parts are metadata")
assert.deepEqual(mixed.attachments, [
  { type: "attachment", name: "sample.png", mimeType: "image/png", source: { kind: "inline", data: "cHJvb2Y=" } },
  { type: "attachment", name: "two pages.pdf", mimeType: "application/pdf", source: { kind: "file", path: "/tmp/two pages.pdf" } },
  { type: "attachment", name: reference.name, mimeType: reference.mimeType, source: { kind: "file", path: reference.path } },
], "mixed files retain names, MIME and real native image bytes")
for (const sample of [manifest.replace('"version":1', '"version":2'), manifest.replace('</mako-attachments>', ''), "```json" + manifest])
  assert.deepEqual(readPromptAttachments(sample), { text: sample, attachments: [] }, "unknown, truncated and fenced manifests stay readable")
assert.deepEqual(readPromptAttachments(appendPromptAttachments("Inspect these", [reference])).text, "Inspect these")
assert.throws(() => appendPromptAttachments("", [{ ...reference, path: "relative/path" }]))
assert.throws(() => appendPromptAttachments("", Array.from({ length: 129 }, () => reference)))
await rm(home, { recursive: true, force: true })
console.log("Codex history markers: compactions, failed turns, stops, review boundaries and plans read as Mako events, citing Codex's own ids.")
