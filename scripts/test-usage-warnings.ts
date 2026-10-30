// A usage limit's warning is said once a window and reset in a conversation, however many times the harness restarts:
// each Claude process says it again on its first turn, and Mako restarts Claude often. The conversation's own blocks
// (its journal) keep the first, so a restarted host and a restarted harness read the same answer. A refusal is still
// said where the turn failed.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeNotices } from "@mako/host/harnesses/claude/sdk-notices"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import type { Entry } from "@mako/sessions/entries"

const now = Date.UTC(2026, 9, 28, 9)
const week = Math.floor(now / 1000) + 3 * 86_400
/** What one Claude process says of a `rate_limit_event`, as the live engine draws it: an event under the message's id. */
function said(process: ClaudeNotices, info: SDKRateLimitInfo): LiveUpdate[] {
  const message: SDKMessage = { type: "rate_limit_event", rate_limit_info: info, uuid: randomUUID(), session_id: "s" }
  const id = message.uuid
  return (process.decode(message) ?? []).flatMap((notice): LiveUpdate[] =>
    notice.kind === "event" ? [{ kind: "event", ...notice.event, id, source: { harness: "claude", record: id } }] : [])
}
const turn = (text: string): LiveUpdate => ({ kind: "user", text })
const warnings = (blocks: Entry[]) => blocks.flatMap((block) => block.type === "event" && block.label === "Warning" ? [block.detail] : [])

const weekly: SDKRateLimitInfo = { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.75, surpassedThreshold: 0.75, resetsAt: week }
let blocks = reduceLiveUpdates([], [turn("First"), ...said(new ClaudeNotices(() => now), weekly)])
assert.equal(warnings(blocks).length, 1)
assert.match(warnings(blocks)[0] ?? "", /^75% of your weekly limit used · resets \S/, "it says what Claude reported of the window")
// Claude restarts: a new process says it again for the same window, a little further along. The conversation keeps one.
for (const [index, share] of [0.76, 0.79, 0.8].entries())
  blocks = reduceLiveUpdates(blocks, [turn(`Turn ${index + 2}`), ...said(new ClaudeNotices(() => now), { ...weekly, utilization: share })])
assert.equal(warnings(blocks).length, 1, "once a window, across restarts")
// A reset a few seconds off is the same reset, said by another clock.
blocks = reduceLiveUpdates(blocks, said(new ClaudeNotices(() => now), { ...weekly, resetsAt: week + 30 }))
assert.equal(warnings(blocks).length, 1)
// Another window, or the same window after it reset, is a new warning.
blocks = reduceLiveUpdates(blocks, said(new ClaudeNotices(() => now), { ...weekly, rateLimitType: "five_hour", utilization: 0.9, resetsAt: Math.floor(now / 1000) + 3600 }))
blocks = reduceLiveUpdates(blocks, said(new ClaudeNotices(() => now), { ...weekly, resetsAt: week + 7 * 86_400 }))
assert.equal(warnings(blocks).length, 3)
assert.match(warnings(blocks)[1] ?? "", /^90% of your 5-hour limit used/)
// With no figure, it says the limit is near.
assert.match(warnings(reduceLiveUpdates([], said(new ClaudeNotices(() => now), { status: "allowed_warning", rateLimitType: "seven_day_opus", resetsAt: week })))[0] ?? "", /^Approaching your weekly Opus limit · resets/)
// A refusal is the turn's failure: it is said where the turn failed, whatever was said before it.
blocks = reduceLiveUpdates(blocks, said(new ClaudeNotices(() => now), { status: "rejected", rateLimitType: "seven_day", resetsAt: week }))
assert.ok(blocks.some((block) => block.type === "event" && block.label === "Rate limited" && (block.detail ?? "").startsWith("Reached your weekly limit")))
console.log("Usage warnings: once a window and reset per conversation across harness restarts, in Claude's own figures; refusals still said")
