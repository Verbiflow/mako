import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { compactionEvent, type TranscriptEvent } from "@mako/sessions/events"
import type { JsonObject } from "../electron/codex-app-json.ts"
import type { NativeNotice } from "../electron/contracts/native-activity.ts"
import type { LiveSessionState } from "../electron/contracts/providers-acp.ts"
import { forward } from "../electron/acp-notifications.ts"
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
  id: "e",
}, "Grok's event id names the event, so a replay of it is drawn once")
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
send({ sessionUpdate: "usage_update", used: 1, size: 2 })
send({ sessionUpdate: "available_commands_update", availableCommands: [] })
send({ sessionUpdate: "plan_removed", planId: "p" })
assert.deepEqual(patches, [{ title: "Fix the flaky build" }])
assert.deepEqual(unhandled, ["plan_removed"])
console.log("PASS: session_info_update names the thread; host-read updates are known; unstable plan updates are logged")
