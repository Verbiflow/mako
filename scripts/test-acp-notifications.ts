import assert from "node:assert/strict"
import { nativeRecord } from "../electron/native-source.ts"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { compactionEvent, type TranscriptEvent } from "@mako/sessions/events"
import type { JsonObject } from "../electron/codex-app-json.ts"
import type { NativeNotice } from "../electron/contracts/native-activity.ts"
import type { LiveSessionState } from "../electron/contracts/providers-acp.ts"
import { forward } from "../electron/acp-notifications.ts"
import { AcpDecoder, acpAnswer } from "../electron/acp-decoder.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { grokNotification } from "../electron/providers/grok/notifications.ts"
import { devinAcpSource } from "../electron/providers/devin/acp.ts"
import { devinNotification } from "../electron/providers/devin/notifications.ts"
import { GrokProvider } from "../packages/sessions/src/providers/grok.ts"

assert.equal(grokAcpSource.decodeNotification, grokNotification)
assert.equal(devinAcpSource.decodeNotification, devinNotification)

// Grok: payloads as grok 1.0.44 recorded them in updates.jsonl, and as its
// binary's serde variants name the fields it has not recorded here.
const GROK = "_x.ai/session_notification"
const grok = (update: JsonObject) => grokNotification(GROK, { sessionId: "grok-session", update, _meta: { eventId: "e" } })
const notices = (update: JsonObject) => grok(update)?.notices

assert.deepEqual(grok({ sessionUpdate: "auto_compact_started", tokens_used: 403803, context_window: 500000, percentage: 81, reason: "Context window 81% full" }), {
  sessionId: "grok-session",
  kind: `${GROK}/auto_compact_started`,
  notices: [{ kind: "activity", activity: { kind: "compacting" } }],
  state: undefined,
  usage: [{ kind: "context", used: 403803, size: 500000 }],
  id: "e",
}, "Grok's event id names the event, so a replay of it is drawn once; its reading moves the meter")
assert.equal(grokNotification(GROK, { sessionId: "grok-session", update: { sessionUpdate: "auto_compact_started" } })?.id, undefined)
assert.deepEqual(notices({ sessionUpdate: "auto_compact_completed", tokens_before: 403803, tokens_after: 21289, elapsed_ms: 94952, summary_preview: null }), [
  { kind: "activity", activity: null },
  { kind: "event", event: { label: "Context compacted", detail: "Automatic · 404k → 21k tokens · took 1m 34s" } },
])
assert.deepEqual(grokNotification("session/update", { sessionId: "grok-session", update: { sessionUpdate: "auto_compact_started" } })?.kind,
  "session/update/auto_compact_started", "Grok's own kinds sent on ACP's method, which the SDK refuses, decode the same")
assert.deepEqual(notices({ sessionUpdate: "auto_compact_completed", tokens_before: 1000, tokens_after: 200, summary_preview: "Kept the plan" }), [
  { kind: "activity", activity: null },
  { kind: "event", event: { label: "Context compacted", detail: "Automatic · 1k → 200 tokens", body: "Kept the plan" } },
])
assert.deepEqual(notices({ sessionUpdate: "auto_compact_failed", error: "Summarizer timed out" }), [
  { kind: "activity", activity: null },
  { kind: "event", event: { label: "Compaction failed", detail: "Summarizer timed out", tone: "warning" } },
])
assert.deepEqual(notices({ sessionUpdate: "auto_compact_cancelled", reason: "user" }), [{ kind: "activity", activity: null }])
console.log("PASS: Grok auto-compaction reads as compacting, then a compaction marker or its failure")

assert.deepEqual(notices({ sessionUpdate: "retry_state", state: "retrying", attempt: 2, max_retries: 8, error_type: "rate_limit", is_rate_limited: true }), [
  { kind: "activity", activity: { kind: "retrying", attempt: 2, maxAttempts: 8, reason: "Rate limited" } },
])
assert.deepEqual(notices({ sessionUpdate: "retry_state", state: "Retrying", attempt: 1, max_retries: 8, error_type: "ServerError", is_rate_limited: false }), [
  { kind: "activity", activity: { kind: "retrying", attempt: 1, maxAttempts: 8, reason: "Server error" } },
])
assert.deepEqual(notices({ sessionUpdate: "retry_state", state: "failed", error_type: "invalid_request" }), [{ kind: "activity", activity: null }])
assert.deepEqual(notices({ sessionUpdate: "retry_state", state: "exhausted", attempt: 8, max_retries: 8, error_type: "rate_limit", is_rate_limited: true }), [
  { kind: "activity", activity: null },
  { kind: "event", event: { label: "Turn failed", detail: "Rate limited", tone: "error" } },
])
assert.deepEqual(grok({ sessionUpdate: "retry_state", state: "paused" }), {
  sessionId: "grok-session", kind: `${GROK}/retry_state/paused`, notices: undefined, state: undefined, id: "e",
}, "an unknown retry state is logged under its own name")
console.log("PASS: Grok retry state reads as retrying, and exhausted retries fail the turn")

assert.deepEqual(grok({ sessionUpdate: "session_summary_generated", session_summary: " Fix the flaky build " }), {
  sessionId: "grok-session", kind: `${GROK}/session_summary_generated`, notices: [], state: { title: "Fix the flaky build" }, id: "e",
})
assert.deepEqual(notices({ sessionUpdate: "model_auto_switched", previous_model_id: "grok-4.7", new_model_id: "grok-4.6", reason: "rate_limited" }), [
  { kind: "event", event: { label: "Model changed", detail: "grok-4.7 → grok-4.6 · Rate limited" } },
])
assert.deepEqual(notices({ sessionUpdate: "model_changed", model_id: "grok-4.7" }), [], "the config option update already shows a chosen model")
assert.deepEqual(notices({ sessionUpdate: "image_dropped", reason: "Image exceeds 20 MB" }), [
  { kind: "event", event: { label: "Warning", detail: "An image was not sent to the model", body: "Image exceeds 20 MB", tone: "warning" } },
])
assert.deepEqual(notices({ sessionUpdate: "auto_recovery_exhausted" }), [
  { kind: "event", event: { label: "Warning", detail: "Grok could not recover the turn", tone: "warning" } },
])
console.log("PASS: Grok titles, model switches, dropped images and recovery read in the shared vocabulary")

for (const sessionUpdate of ["hook_execution", "hook_run_started", "memory_dream_started", "response_completed", "turn_usage", "task_backgrounded",
  "compaction_checkpoint", "session_recap", "subagent_progress", "background_tasks", "turn_completed", "subagent_spawned", "subagent_finished"])
  assert.deepEqual(notices({ sessionUpdate }), [], `${sessionUpdate} is known and shows nothing`)
assert.deepEqual(grok({ sessionUpdate: "scheduled_task_fired" }), {
  sessionId: "grok-session", kind: `${GROK}/scheduled_task_fired`, notices: undefined, state: undefined, id: "e",
}, "an unknown update is logged by its own kind, not only by the channel it came on")
assert.deepEqual(grokNotification(GROK, { sessionId: "grok-session" }), { kind: GROK, notices: undefined })
assert.deepEqual(grokNotification("_x.ai/fs/index/delta", {}), { kind: "_x.ai/fs/index/delta", notices: [] })
assert.deepEqual(grokNotification("_x.ai/task_completed", { sessionId: "grok-session" }), { sessionId: "grok-session", kind: "_x.ai/task_completed", notices: [] })
assert.equal(grokNotification("_x.ai/unknown", {}), undefined)
assert.equal(grokNotification("_cognition.ai/compaction", {}), undefined)
console.log("PASS: Grok bookkeeping is known and silent; unknown updates are keyed by kind")

// The saved transcript reads the same markers as the live connection.
const home = await mkdtemp(join(tmpdir(), "mako-grok-markers-"))
try {
  const dir = join(home, ".grok", "sessions", "%2Fwork", "grok-session")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "summary.json"), JSON.stringify({ info: { id: "grok-session", cwd: "/work" }, session_summary: "Markers" }))
  const saved: JsonObject[] = [
    { sessionUpdate: "auto_compact_started", tokens_used: 403803, context_window: 500000, percentage: 81, reason: "Context window 81% full" },
    { sessionUpdate: "compaction_checkpoint", checkpoint_id: "c1" },
    { sessionUpdate: "auto_compact_completed", tokens_before: 403803, tokens_after: 21289, elapsed_ms: 94952, summary_preview: "Kept the plan" },
    { sessionUpdate: "auto_compact_failed", error: "Summarizer timed out" },
    { sessionUpdate: "retry_state", state: "retrying", attempt: 2, max_retries: 8, is_rate_limited: true },
    { sessionUpdate: "retry_state", state: "exhausted", attempt: 8, max_retries: 8, error_type: "server_error", is_rate_limited: false },
    { sessionUpdate: "model_auto_switched", previous_model_id: "grok-4.7", new_model_id: "grok-4.6", reason: "Capacity" },
    { sessionUpdate: "image_dropped", reason: "Image exceeds 20 MB" },
    { sessionUpdate: "auto_recovery_started", reason: "Stream stalled" },
    { sessionUpdate: "auto_recovery_exhausted" },
    { sessionUpdate: "hook_execution", hook: "PreToolUse" },
  ]
  const lines = [
    { timestamp: 1, method: "session/update", params: { sessionId: "grok-session", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Keep going" } } } },
    ...saved.map((update, index) => ({ timestamp: 2 + index, method: "_x.ai/session/update", params: { sessionId: "grok-session", update } })),
  ]
  await writeFile(join(dir, "updates.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
  const thread = await new GrokProvider(home).read(join(dir, "updates.jsonl"))
  const savedMarkers = thread?.entries.flatMap((entry): TranscriptEvent[] =>
    entry.kind === "event" ? [{ label: entry.label, detail: entry.detail, body: entry.body, tone: entry.tone }] : [])
    .map((marker) => JSON.parse(JSON.stringify(marker)))
  const liveMarkers = saved.flatMap((update) => (notices(update) ?? []).flatMap((notice: NativeNotice): TranscriptEvent[] =>
    notice.kind === "event" ? [notice.event] : notice.kind === "compacted" ? [compactionEvent(notice.compaction)] : []))
  assert.equal(liveMarkers.length, 7)
  assert.deepEqual(savedMarkers, liveMarkers, "a Grok marker reads the same live and saved")
  console.log("PASS: Grok's saved transcript shows the markers its live connection showed")
} finally {
  await rm(home, { recursive: true, force: true })
}

// Devin: the payload schemas of the ACP client Devin.app 3000.10.23 ships.
const devin = (method: string, params: JsonObject) => devinNotification(method, { sessionId: "devin-session", ...params })
const devinNotices = (method: string, params: JsonObject) => devin(method, params)?.notices

assert.deepEqual(devin("_cognition.ai/compaction", { status: "started", summary: null }), {
  sessionId: "devin-session", kind: "_cognition.ai/compaction/started", notices: [{ kind: "activity", activity: { kind: "compacting" } }],
})
assert.deepEqual(devinNotices("_cognition.ai/compaction", { status: "completed", summary: "## Request and intent\nFaster builds." }), [
  { kind: "compacted", compaction: { summary: "## Request and intent\nFaster builds." } },
])
assert.deepEqual(devinNotices("_cognition.ai/compaction", { status: "completed" }), [{ kind: "compacted", compaction: undefined }])
assert.deepEqual(devinNotices("_cognition.ai/compaction", { status: "failed" }), [
  { kind: "activity", activity: null },
  { kind: "event", event: { label: "Compaction failed", tone: "warning" } },
])
assert.deepEqual(devin("_cognition.ai/compaction", { status: "paused" }), { sessionId: "devin-session", kind: "_cognition.ai/compaction/paused", notices: undefined })
// Devin sends no event ids; the summary names its compaction, so a replay repeats the id.
const summarized = devin("_cognition.ai/compaction", { status: "completed", summary: "## Request and intent\nFaster builds." })
assert.match(summarized?.id ?? "", /^compaction:[0-9a-f]{16}$/)
assert.equal(devin("_cognition.ai/compaction", { status: "completed", summary: "## Request and intent\nFaster builds." })?.id, summarized?.id)
assert.notEqual(devin("_cognition.ai/compaction", { status: "completed", summary: "## Request and intent\nSlower builds." })?.id, summarized?.id)
assert.equal(devin("_cognition.ai/compaction", { status: "completed" })?.id, undefined)
assert.equal(devin("_cognition.ai/compaction", { status: "started", summary: "same" })?.id, undefined)
console.log("PASS: Devin compaction reads as compacting, then a marker carrying its summary, named by that summary")

assert.deepEqual(devinNotices("_cognition.ai/connection_retry", { attempt: 2, maxAttempts: 5, isStreamRetry: true }), [
  { kind: "activity", activity: { kind: "retrying", attempt: 2, maxAttempts: 5, reason: "Stream interrupted" } },
])
assert.deepEqual(devinNotices("_cognition.ai/connection_retry", { attempt: 1, maxAttempts: 5, isStreamRetry: false }), [
  { kind: "activity", activity: { kind: "retrying", attempt: 1, maxAttempts: 5, reason: "Connection lost" } },
])
console.log("PASS: Devin connection retries read as retrying, with the cause")

for (const cause of ["complete", "cancelled", "interrupted", "restart", "shutdown"])
  assert.deepEqual(devinNotices("_cognition.ai/agent_stopped", { cause, stats: {} }), [], `${cause} ends a turn without failing it`)
assert.deepEqual(devinNotices("_cognition.ai/agent_stopped", { cause: "quota_exhausted", errorMessage: "You have used all of your credits." }), [
  { kind: "event", event: { label: "Turn failed", detail: "Quota exhausted", body: "You have used all of your credits.", tone: "error" } },
])
assert.deepEqual(devinNotices("_cognition.ai/agent_stopped", { cause: "auth_required" }), [
  { kind: "event", event: { label: "Turn failed", detail: "Sign-in required", tone: "error" } },
])
assert.deepEqual(devinNotices("_cognition.ai/agent_stopped", { cause: "error", errorMessage: "Error in agent loop: An internal error occurred" }), [
  { kind: "event", event: { label: "Turn failed", body: "Error in agent loop: An internal error occurred", tone: "error" } },
])
assert.deepEqual(devinNotices("_cognition.ai/agent_stopped", { cause: "output_truncated" }), [
  { kind: "event", event: { label: "Warning", detail: "The response was cut off at the output limit", tone: "warning" } },
])
assert.deepEqual(devin("_cognition.ai/agent_stopped", { cause: "exploded" }), { sessionId: "devin-session", kind: "_cognition.ai/agent_stopped/exploded", notices: undefined })
console.log("PASS: Devin's agent_stopped marks the causes that fail a turn, in plain words")

assert.deepEqual(devinNotices("_cognition.ai/output", { channel: "MCP", message: "Server github failed to start\nspawn gh ENOENT", level: "warn" }), [
  { kind: "event", event: { label: "Warning", detail: "Server github failed to start", body: "Server github failed to start\nspawn gh ENOENT", tone: "warning" } },
])
assert.deepEqual(devinNotices("_cognition.ai/output", { channel: "MCP", message: "Connected", level: "info" }), [])
assert.deepEqual(devinNotices("_cognition.ai/showModal", { message: "Devin was updated", detail: "Restart to use it.", level: "info" }), [
  { kind: "event", event: { label: "Notice", detail: "Devin was updated", body: "Restart to use it." } },
])
assert.deepEqual(devinNotices("_cognition.ai/showModal", { message: "Plan limit reached", detail: "Upgrade to continue.", level: "error" }), [
  { kind: "event", event: { label: "Warning", detail: "Plan limit reached", body: "Upgrade to continue.", tone: "warning" } },
])
assert.deepEqual(devinNotices("_cognition.ai/billingInformation", { title: "Using extra credits", body: "This turn used 12 ACUs." }), [
  { kind: "event", event: { label: "Notice", detail: "Using extra credits", body: "This turn used 12 ACUs." } },
])
for (const method of ["_cognition.ai/turn_stats", "_cognition.ai/thinking_complete", "_cognition.ai/mcp/serversChanged", "_cognition.ai/loadStats"])
  assert.deepEqual(devinNotices(method, {}), [], `${method} is known and shows nothing`)
assert.deepEqual(devin("_cognition.ai/somethingNew", {}), { sessionId: "devin-session", kind: "_cognition.ai/somethingNew", notices: undefined })
assert.equal(devinNotification("_x.ai/session_notification", {}), undefined)
console.log("PASS: Devin output warnings, modals and billing read as notices; bookkeeping is silent")

// Standard ACP updates the host renders as state, or knowingly skips.
const patches: Array<Partial<LiveSessionState>> = []
const unhandled: string[] = []
const send = (update: SessionNotification["update"]) =>
  forward({ id: "c" }, { sessionId: "s", update }, () => assert.fail("nothing is emitted"), (_live, patch) => patches.push(patch), undefined, undefined, (kind) => unhandled.push(kind))
send({ sessionUpdate: "session_info_update", title: " Fix the flaky build ", updatedAt: "2026-09-29T00:00:00Z" })
send({ sessionUpdate: "session_info_update", title: null })
send({ sessionUpdate: "session_info_update", updatedAt: "2026-09-29T00:00:01Z" })
send({ sessionUpdate: "session_info_update", title: 'functions.shell:0{"command": "ls -la"}' })
send({ sessionUpdate: "session_info_update", title: "functions.app_start:0{}" })
send({ sessionUpdate: "usage_update", used: 1, size: 2 })
send({ sessionUpdate: "available_commands_update", availableCommands: [] })
send({ sessionUpdate: "plan_removed", planId: "p" })
assert.deepEqual(patches, [{ title: "Fix the flaky build" }])
assert.deepEqual(unhandled, ["plan_removed"])
console.log("PASS: session_info_update names the thread, never with a leaked tool call; host-read updates are known; unstable plan updates are logged")

// Requests the agent waits on: what each choice sends back, and requests no provider reads.
const exitPlan = grokAcpSource.requests?.decode("_x.ai/exit_plan_mode", { sessionId: "s", toolCallId: "call_1", planContent: null })
assert.ok(exitPlan)
assert.deepEqual(exitPlan.updates, [], "an empty plan file adds no card; the tool call's own copy stands")
assert.deepEqual(exitPlan.ask.request.implementsPlan, { plan: "grok:s:call_1", approve: "approved" })
assert.deepEqual(acpAnswer(exitPlan.ask, { kind: "choice", optionId: "approved" }), { outcome: "approved" })
assert.deepEqual(acpAnswer(exitPlan.ask, { kind: "choice", optionId: "abandoned" }), { outcome: "abandoned" })
assert.deepEqual(acpAnswer(exitPlan.ask, { kind: "choice", optionId: "keep-planning" }), { outcome: "rejected" })
assert.deepEqual(acpAnswer(exitPlan.ask, { kind: "choice", optionId: null }), { outcome: "rejected" }, "a request the session dropped keeps planning; it never builds")
assert.equal(grokAcpSource.requests?.decode("_x.ai/exit_plan_mode", { toolCallId: 1 }), undefined, "a malformed request is refused")
// The request grok 1.0.44 sent when its model called `ask_user_question` on October 5, 2026.
const grokQuestion = grokAcpSource.requests?.decode("_x.ai/ask_user_question", {
  sessionId: "s", toolCallId: "call_q", mode: "default",
  questions: [
    { question: "Which color?", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false },
    { question: "Which sizes?", options: [{ label: "S", description: "" }, { label: "L", description: "" }], multiSelect: true },
  ],
})
assert.ok(grokQuestion, "Grok's question request is read, not refused as an unknown method")
assert.deepEqual(grokQuestion.ask.request.questions?.map((question) => [question.id, question.question, question.valueType, question.options.map((option) => option.label)]), [
  ["0", "Which color?", "string", ["Red", "Blue"]],
  ["1", "Which sizes?", "string-array", ["S", "L"]],
])
assert.deepEqual(acpAnswer(grokQuestion.ask, { kind: "answers", answers: { 0: ["Blue"], 1: ["S", "L"] } }),
  { outcome: "accepted", answers: { "Which color?": "Blue", "Which sizes?": "S, L" }, annotations: {} })
assert.deepEqual(acpAnswer(grokQuestion.ask, { kind: "choice", optionId: null }), { outcome: "skip_interview", partial_answers: {} },
  "a dismissed card lets Grok continue without answers")
assert.equal(grokAcpSource.requests?.decode("_x.ai/ask_user_question", { sessionId: "s", toolCallId: "call_q", questions: [] }), undefined)
// grok 1.0.46 writes chat_history.jsonl from the first prompt and updates.jsonl at the turn's end:
// a session saved mid-turn and the same session resumed name one record.
const grokFolder = "/home/.grok/sessions/%2Fwork/01a10e4d-0e30"
assert.deepEqual(nativeRecord(grokAcpSource, `${grokFolder}/chat_history.jsonl`, "01a10e4d-0e30"), nativeRecord(grokAcpSource, `${grokFolder}/updates.jsonl`, "01a10e4d-0e30"))
assert.equal(nativeRecord(grokAcpSource, `${grokFolder}/updates.jsonl`, "another-session"), undefined, "a folder named for another session is not this record")
assert.equal(new AcpDecoder(grokAcpSource).request("_x.ai/elsewhere", {}), undefined, "a method no provider reads is refused")
assert.equal(new AcpDecoder(undefined).request("_x.ai/exit_plan_mode", {}), undefined)
const untitled = new AcpDecoder(devinAcpSource).permission({ sessionId: "s", toolCall: { toolCallId: "t" },
  options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }] })
assert.equal(untitled.request.title, "The agent wants to use a tool")
assert.equal(untitled.request.implementsPlan, undefined, "a permission for no plan builds none")
console.log("PASS: vendor requests answer each choice the provider's way; unknown and malformed requests are refused")

{
  // Recorded from grok 1.0.44 with a working server, one that exits in its handshake and one that cannot be launched.
  const startup = grokAcpSource.mcpStartup!()
  const said = (method: string, params: JsonObject) => {
    const decoding = startup.decode(method, params)
    return decoding?.notices?.flatMap((notice) => notice.kind === "event" ? [[notice.event.label, notice.event.detail, notice.event.setup]] : [])
  }
  const sessionId = "01a0f6d4"
  assert.deepEqual(said("_x.ai/mcp/servers_updated", { mcpServers: [
    { name: "okserver", source: "local", type: "stdio" }, { name: "missing", source: "local", type: "stdio" }, { name: "crashes", source: "local", type: "stdio" },
  ] }), [])
  assert.deepEqual(said("_x.ai/mcp/init_progress", { total: 3, connected: 2, sessionId }), [])
  assert.deepEqual(said("_x.ai/mcp_initialized", { sessionId, mcpToolCount: 1, elapsedMs: 36 }), [])
  assert.deepEqual(said("_x.ai/mcp/server_status", { sessionId, name: "crashes", source: "local", status: "unavailable", reason: "handshake_failed",
    detail: "MCP server 'crashes' handshake failed: connection closed: initialize response", tools: null }),
  [["MCP server failed", "crashes · could not connect", true]], "in the shared words, without Grok repeating the name")
  assert.deepEqual(said("_x.ai/mcp/server_status", { sessionId, name: "okserver", source: "local", status: "ready", reason: "initialized", tools: null }), [])
  assert.deepEqual(said("_x.ai/mcp/server_status", { sessionId, name: "later", status: "auth_required", reason: "auth_required" }),
    [["MCP server failed", "later · sign-in required", true]], "a status without Grok's own detail reads its reason")
  assert.deepEqual(said("_x.ai/mcp/server_status", { sessionId, name: "slow", status: "unavailable", reason: "startup_timeout" }),
    [["MCP server failed", "slow · timed out", true]])
  const completed = { sessionId, update: { sessionUpdate: "response_completed" } }
  assert.deepEqual(said("_x.ai/session_notification", completed), [["MCP server failed", "missing · could not be launched", true]],
    "a server that never reported is named when the first response completes")
  assert.equal(startup.decode("_x.ai/session_notification", completed), undefined, "and only then: later responses are the ordinary decoder's")
  assert.equal(startup.decode("_x.ai/session_notification", { sessionId, update: { sessionUpdate: "retry_state" } }), undefined)
  assert.deepEqual(said("_x.ai/mcp/server_status", { sessionId, name: "crashes", status: "unavailable", reason: "handshake_failed" }), [],
    "a server reported again keeps its one marker")
  console.log("PASS: Grok's MCP startup names each server that did not start, once, as a setup notice")
}

{
  // Recorded from devin 3000.10.23 with the same three servers; lines before the session exists carry no id.
  const startup = devinAcpSource.mcpStartup!()
  const output = "_cognition.ai/output"
  const line = (channel: string, level: string, message: string, sessionId: string | null = null) => ({ sessionId, channel, level, message })
  const said = (params: JsonObject) => {
    const decoding = startup.decode(output, params)
    return decoding && { sessionId: decoding.sessionId, notices: decoding.notices?.flatMap((notice) => notice.kind === "event" ? [[notice.event.label, notice.event.detail, notice.event.setup]] : []) }
  }
  assert.deepEqual(said(line("MCP: missing", "info", "Connecting to MCP server 'missing'", "")), { sessionId: undefined, notices: [] },
    "a server connecting is quiet")
  assert.deepEqual(said(line("MCP: missing", "warn", "MCP server 'missing' connection failed: cannot find binary path")),
    { sessionId: undefined, notices: [["MCP server failed", "missing · could not be launched", true]] }, "in the words the other harnesses use")
  assert.deepEqual(said(line("MCP", "warn", "Failed to connect to MCP server 'missing' for description: cannot find binary path")),
    { sessionId: undefined, notices: [] }, "Devin's second copy on the shared channel draws nothing")
  assert.deepEqual(said(line("MCP", "warn", "Failed to connect to MCP server 'crashes' for description: connection closed: initialize response", "d1")),
    { sessionId: "d1", notices: [["MCP server failed", "crashes · could not connect", true]] }, "whichever copy comes first names it")
  assert.deepEqual(said(line("MCP: crashes", "warn", "MCP server 'crashes' connection failed: connection closed: initialize response", "d1")),
    { sessionId: "d1", notices: [] })
  assert.deepEqual(said(line("MCP: okserver", "info", "MCP server 'okserver' connected successfully", "d1")), { sessionId: "d1", notices: [] })
  assert.deepEqual(said(line("MCP: linear", "warn", "Interactive OAuth failed for 'linear': browser closed", "d1"))?.notices,
    [["MCP server failed", "linear · sign-in failed: browser closed", true]])
  assert.equal(startup.decode(output, line("MCP: ynab", "warn", "MCP operation failed on cached service for 'ynab', retrying with fresh connection: reset", "d1")), undefined,
    "a retry is not a failed start; the ordinary decoder's warning stands")
  assert.equal(startup.decode(output, line("Agent", "warn", "something else", "d1")), undefined, "other channels are the ordinary decoder's")
  assert.equal(startup.decode("_cognition.ai/compaction", { sessionId: "d1", status: "started" }), undefined)
  const beforeSession = devinNotification(output, line("Agent", "warn", "before the session"))
  const emptySession = devinNotification(output, line("Agent", "warn", "before the session", ""))
  assert.ok(beforeSession && emptySession)
  assert.deepEqual(beforeSession.sessionId, undefined)
  assert.deepEqual(emptySession.sessionId, undefined, "an empty id names no session")
  assert.ok(beforeSession.notices?.length, "a line before the session exists is still read")
  console.log("PASS: Devin's MCP startup names each server that did not start, once, from either copy of its failure")
}
