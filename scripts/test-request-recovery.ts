import assert from "node:assert/strict"
import { PROVIDER_FAILURE_KINDS, describeProviderFailure } from "@mako/host/contracts/provider-failure"
import { limitResetAt } from "@mako/host/contracts/account-usage"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { composerResume, recoveryLabel, requestRecovery, usageLimitReset } from "../src/state/request-recovery"
import { recoveriesByPlace, turnStopLabel, turnStops } from "../src/state/prompt-delivery"
import { orderNotices, type ComposerNotice } from "../src/extend/notices"

/**
 * Where a failed message's recovery is said (the transcript row, the
 * composer's button, the line above it) and what it offers, from the
 * host's failure kind and delivery evidence alone.
 */

const now = Date.UTC(2026, 9, 25, 13, 0)
const failed = (failure: LiveRequest["failure"], evidence?: "accepted" | "not-accepted"): LiveRequest => ({
  id: `failed-${failure}`, text: "Fix the retry policy", attachments: [], status: "failed", failure,
  ...evidence && {
    nativeDelivery: {
      attemptId: "11111111-1111-4111-8111-111111111111", bindingId: "b", ownerEpoch: "e",
      evidence: evidence === "accepted" ? { kind: "accepted", source: "native-response" } : { kind: "not-accepted", source: "preflight", reason: "Not connected" },
    },
  },
})
const context = { provider: "Claude Code", now }

// Every kind keeps the distinctions the host made: a repeat only when one can work, the right word for it by evidence.
for (const kind of PROVIDER_FAILURE_KINDS) {
  const recovery = requestRecovery(failed(kind, "not-accepted"), context)
  const repeatable = describeProviderFailure(kind).retriable
  const offers = [recovery.primary, ...recovery.more].map((action) => action?.kind)
  assert.equal(offers.includes("resend"), repeatable, `${kind}: Send again only when an unchanged attempt may succeed`)
  assert.ok(offers.includes("copy") && offers.includes("restore"), `${kind}: the words are always one click away`)
  assert.equal(new Set(offers).size, offers.length, `${kind}: nothing is offered twice`)
  assert.ok(recovery.title.length > 0 && recovery.title.length <= 42, `${kind}: a headline, not a paragraph`)
}
assert.deepEqual(requestRecovery(failed("network", "not-accepted"), context).primary, { kind: "resend", label: "Send again" })
assert.deepEqual(requestRecovery(failed("network", "accepted"), context).primary, { kind: "continue", reason: "connection-lost" }, "the agent got it and only the connection dropped: its work stands, so it goes on")
assert.ok(requestRecovery(failed("network", "accepted"), context).more.some((action) => action.kind === "resend" && action.label === "Send another copy"), "a copy stays one click away")
assert.deepEqual(requestRecovery(failed("provider-unavailable", "accepted"), context).primary, { kind: "resend", label: "Send another copy" }, "the agent got it: a repeat is another copy")
assert.deepEqual(requestRecovery(failed("network"), context).primary, { kind: "resend", label: "Send another copy" }, "no receipt: a repeat is another copy")
assert.match(requestRecovery(failed("network", "accepted"), context).delivery, /received this message/)
assert.equal(requestRecovery(failed("auth"), context).primary?.kind, "sign-in")
assert.equal(requestRecovery(failed("transcript-rejected"), context).primary?.kind, "fresh")
assert.equal(requestRecovery(failed("context-exhausted"), { ...context, canCompact: true }).primary?.kind, "compact")
assert.equal(requestRecovery(failed("context-exhausted"), context).primary?.kind, "fresh", "a harness Mako can't compact gets the new thread")
assert.equal(requestRecovery(failed("context-exhausted"), { ...context, canCompact: true, compacted: true }).primary?.kind, "resend", "after its compaction the message may fit")
assert.equal(requestRecovery(failed("missing-folder"), context).primary?.kind, "copy")
assert.ok(!requestRecovery(failed("missing-folder"), context).more.some((action) => action.kind === "fresh"), "a new thread opens in the same missing folder")
assert.deepEqual(requestRecovery(failed("launch-stalled"), context).more.find((action) => action.kind === "settings"), { kind: "settings", section: "mcp" })
assert.equal(requestRecovery(failed("rate-limited"), context).tone, "caution", "capacity is a wait")
assert.equal(requestRecovery(failed("plan"), context).tone, "danger")
const uncertain = requestRecovery({ ...failed(undefined), status: "uncertain" }, context)
assert.equal(uncertain.primary?.kind, "restore", "an unconfirmed message is restored, never repeated by Mako")
assert.ok(![uncertain.primary, ...uncertain.more].some((action) => action?.kind === "resend"))
assert.equal(recoveryLabel({ kind: "compact" }), "Compact and retry")

// One sentence under the title: what happened to the message and what's safe, by what the evidence settles.
const say = (request: LiveRequest, extra = {}) => requestRecovery(request, { ...context, ...extra }).guidance ?? ""
assert.equal(say(failed("network", "not-accepted")), "It never reached Claude Code, so sending it again is safe.")
assert.equal(say(failed("network", "accepted")), "Claude Code got it before the connection dropped; continue the turn rather than sending a copy.")
assert.equal(say(failed("network")), "Mako can't tell whether Claude Code got it; check the conversation before sending a copy.")
assert.equal(say(failed("provider-unavailable", "accepted")), "Claude Code got it before its service failed; check what it did before sending a copy.")
assert.match(say({ ...failed(undefined), status: "uncertain" }), /^Mako can't tell whether Claude Code got it/)
assert.match(say(failed("context-exhausted"), { canCompact: true }), /^Compacting the conversation makes room for Claude Code/)
assert.match(say(failed("context-exhausted")), /^A new thread with this message gives Claude Code room/)
assert.match(say(failed("context-exhausted"), { compacted: true }), /compacted now/)
assert.match(say(failed("transcript-rejected")), /sending again won't help/)
for (const kind of PROVIDER_FAILURE_KINDS) {
  for (const evidence of ["accepted", "not-accepted", undefined] as const) {
    const words = say(failed(kind, evidence))
    assert.ok(words, `${kind}: says what to do`)
    assert.doesNotMatch(words, /[Rr]eview .* before|another attempt/, `${kind}: no review-before boilerplate`)
    assert.equal(words.split(/(?<=[.!?])\s/).length, 1, `${kind}: one sentence`)
    assert.ok(/Claude Code|Mako|You|It never|This thread|The conversation/.test(words), `${kind}: names who has it`)
  }
}

// A usage limit with a known reset: a wait in the warning tone, and a send held until then.
const reset = Date.UTC(2026, 9, 25, 15, 40)
const usage = { status: "ok" as const, windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: reset }, { usedPercent: 40, windowMinutes: 10_080, resetsAt: reset + 86_400_000 }] }
assert.equal(limitResetAt(usage, now), reset)
assert.equal(limitResetAt({ ...usage, windows: [...usage.windows, { usedPercent: 100, windowMinutes: 10_080, resetsAt: reset + 3_600_000 }] }, now), reset + 3_600_000, "every spent window must give room back")
assert.equal(limitResetAt({ status: "ok", windows: [{ usedPercent: 80, windowMinutes: 300, resetsAt: reset }] }, now), null, "nothing spent, no limit")
assert.equal(limitResetAt({ status: "ok", windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: null }] }, now), null, "a spent window without a reset names no time")
assert.equal(limitResetAt(usage, reset + 1), null, "a reset already past has emptied the window")
const limited = requestRecovery(failed("rate-limited", "not-accepted"), { ...context, resetAt: reset })
assert.equal(limited.title, "Usage limit reached")
assert.match(limited.description ?? "", /^resets /)
assert.equal(limited.tone, "caution")
assert.equal(limited.primary?.kind, "resume-at")
assert.match(limited.primary?.kind === "resume-at" ? limited.primary.label : "", /^Resume at /)
assert.ok(limited.more.some((action) => action.kind === "remind-at"), "Notify me at reset")
assert.ok(limited.more.some((action) => action.kind === "resend"), "sending now stays possible")
const received = requestRecovery(failed("rate-limited", "accepted"), { ...context, resetAt: reset }).primary
assert.match(received?.kind === "resume-at" ? received.label : "", /^Send a copy at /, "a held repeat of a received message is a copy")
assert.equal(usageLimitReset(failed("network"), reset, now), undefined, "only a limit failure waits for a reset")
assert.equal(usageLimitReset(failed("rate-limited"), now - 1, now), undefined, "a reset in the past is no wait")

// The composer's button: Continue turn for a turn Mako's exit cut short, a repeat when one can work, nothing otherwise.
const quit: LiveRequest = { id: "quit", text: "Refactor", attachments: [], status: "interrupted", interruption: { reason: "host-quit", at: 1 } }
assert.deepEqual(composerResume([quit], turnStops([quit], false), context), { kind: "continue", reason: "host-quit", label: "Continue turn" })
const stopped: LiveRequest = { ...quit, interruption: { reason: "stopped", at: 1 } }
assert.equal(composerResume([stopped], turnStops([stopped], false), context), null, "a user's Stop offers nothing")
const automatic: LiveRequest = { ...quit, interruption: { reason: "connection-lost", at: 1, autoContinue: { at: 2 } } }
assert.equal(composerResume([automatic], turnStops([automatic], false), context), null, "Mako continues it itself")
const network = failed("network", "not-accepted")
assert.equal(composerResume([network], new Map(), context)?.label, "Send again")
assert.equal(composerResume([failed("auth")], new Map(), context), null, "a signed-out account isn't fixed by sending again")
assert.equal(composerResume([failed("rate-limited")], new Map(), { ...context, resetAt: reset }), null, "a known reset is offered by the row, as a timed send")
assert.equal(composerResume([network, { ...quit, id: "later", status: "completed" }], new Map(), context), null, "only the newest turn")

// Where each is said: a failure on a turn ends that turn; one that never reached the transcript follows the last turn, since the last answer.
const blocks = [{ type: "user" as const, requestId: "on-turn", text: "Hello" }]
const requests: LiveRequest[] = [
  { ...failed("network"), id: "old-apart" },
  { id: "answered", text: "ok", attachments: [], status: "completed" },
  { ...failed("network"), id: "on-turn" },
  { ...failed("wrong-account", "not-accepted"), id: "new-apart" },
  { ...quit, id: "quit-apart" },
]
const places = recoveriesByPlace({ blocks, requests })
assert.deepEqual([...places.onTurns.keys()], ["on-turn"])
assert.deepEqual(places.apart.map((request) => request.id), ["new-apart", "quit-apart"], "older ones are in the saved messages list")

// A turn Mako stopped because it couldn't save the conversation: its own row, never the person's "Stopped".
const unsaved: LiveRequest = {
  ...failed(undefined, "accepted"), id: "unsaved", status: "interrupted", failure: undefined,
  interruption: { reason: "not-saved", at: 1 }, error: "database or disk is full",
}
const unsavedRow = requestRecovery(unsaved, context)
assert.equal(unsavedRow.title, "Mako couldn't save this conversation")
assert.equal(unsavedRow.guidance, "Mako stopped Claude Code rather than let it work on with nothing saved; what it did so far stands. Once Mako can save again, often after freeing disk space, continue the turn.")
assert.equal(unsavedRow.tone, "danger", "Mako's fault, not a wait")
assert.deepEqual(unsavedRow.primary, { kind: "continue", reason: "not-saved" })
assert.deepEqual(unsavedRow.more.map((action) => action.kind), ["restore", "copy"])
assert.equal(turnStopLabel("not-saved", "Claude Code"), "Stopped when Mako couldn't save")
assert.notEqual(turnStopLabel("not-saved", "Claude Code"), turnStopLabel("stopped", "Claude Code"))
// SAFETY: a reason no build knows yet, as a newer host relays it; the label must still say something.
assert.equal(turnStopLabel("reason-from-a-newer-host" as never, "Claude Code"), "Interrupted", "a reason this build doesn't know still says something")
const unsavedPlaces = recoveriesByPlace({ blocks: [{ type: "user" as const, requestId: "unsaved", text: "Make the page" }], requests: [unsaved, { ...stopped, id: "yours" }] })
assert.deepEqual([...unsavedPlaces.onTurns.keys()], ["unsaved"], "it ends on its failure row; a Stop of the person's keeps its footer")
assert.deepEqual(composerResume([unsaved], turnStops([unsaved], false), context), { kind: "continue", reason: "not-saved", label: "Continue turn" })

// A goal's turn Mako stopped at the token budget the person set: said quietly, never as their Stop, and offered
// nothing, since going on would spend past the budget.
const budget: LiveRequest = { ...stopped, id: "budget", interruption: { reason: "goal-budget", at: 1 } }
assert.equal(turnStopLabel("goal-budget", "Claude Code"), "Stopped at the goal's token budget")
assert.equal(turnStops([budget], false).get("budget")?.continuable, false)
assert.equal(composerResume([budget], turnStops([budget], false), context), null)
assert.deepEqual([...recoveriesByPlace({ blocks: [{ type: "user" as const, requestId: "budget", text: "Fix the tests" }], requests: [budget] }).onTurns.keys()], [], "its footer says it, not a failure row")

// The notice stack's order: urgent first, then work under way, then the rest; registration order breaks ties.
const notice = (id: string, tone: ComposerNotice["tone"], priority?: number): ComposerNotice => ({ id, tone, title: id, ...priority !== undefined && { priority } })
assert.deepEqual(orderNotices([
  { notice: notice("info", "info"), order: 0 },
  { notice: notice("moving", "progress"), order: 0 },
  { notice: notice("late-caution", "caution"), order: 5 },
  { notice: notice("failure", "danger"), order: -5 },
  { notice: notice("pinned", "info", -1), order: 0 },
]).map((entry) => entry.notice.id), ["pinned", "failure", "late-caution", "moving", "info"])

console.log("PASS: failure recovery by kind and delivery evidence, usage-limit resets and timed sends, the composer's resume, where each failure is drawn, a turn Mako stopped unsaved, and the notice stack's order")
