// Code review end to end through LiveConversations with injected drivers: a
// harness's own review sent as the command its client types (Claude Code,
// OpenCode), started by a call (Codex), or Mako's review prompt on a harness
// without one (Devin, Cursor, Grok); a review queued behind a running turn;
// the targets Mako accepts; then each harness's findings as Mako reads them.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { makoReviewPrompt, reviewDisplayText, reviewTargetLabel, ReviewTargetSchema, type ReviewTarget } from "@mako/host/contracts/live-reviews"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver, ReviewCapability } from "@mako/host/harnesses/live-driver"
import { claudeReviewCommand } from "@mako/host/harnesses/claude/review"
import { openCodeReviewCommand } from "@mako/host/harnesses/opencode/review"
import { claudeReviewReport, CodexReviewOutputSchema, codexReviewEcho, codexReviewReport, codexReviewText, makoReviewReport, REVIEW_FENCE } from "@mako/sessions/review"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const FIXTURE = "Injected driver fixture"
const NOTE = "Local Control: use the mako-control CLI."
const CHANGES: ReviewTarget = { kind: "changes" }
const BRANCH: ReviewTarget = { kind: "branch", base: "main" }
const COMMIT: ReviewTarget = { kind: "commit", sha: "1a2b3c4d5e6f", title: "Parse empty headers" }

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/** `hold`: the first turn runs until `finish`. */
function reviewHost(review: ReviewCapability, options: { hold?: true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mako-live-reviews-"))
  const id = randomUUID()
  const sent: string[] = []
  const calls: { binding: string; target: ReviewTarget }[] = []
  let owner: LiveConversations
  let holding = options.hold ?? false
  const state = (status: LiveSessionState["status"]): LiveSessionState => ({
    id, nativeId: id, harness: "test-provider", cwd: root, status, connection: "connected", modes: [], currentMode: null, configOptions: [],
  })
  const turn = (reply: string) => {
    owner.observe({ type: "live-session", session: state("running") })
    owner.observe({ type: "live-update", id, update: { kind: "text", text: reply } })
    if (holding) holding = false
    else owner.observe({ type: "live-session", session: state("ready") })
  }
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    review: review.kind === "native" && review.start.via === "call"
      ? { ...review, start: { via: "call", run: async (binding, target, _settings, dispatch) => {
          calls.push({ binding, target })
          dispatch.report({ kind: "submitted", source: "transport-call" })
          dispatch.report({ kind: "accepted", source: "native-response", referenceId: "review-turn" })
          turn("Reviewed.")
        } } }
      : review,
    approvalEvidence: { kind: "submission-only", reason: FIXTURE },
    launchEnvironment: { kind: "unavailable", reason: FIXTURE },
    nativeIdentity: { kind: "unavailable", reason: FIXTURE },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: FIXTURE, feedback: { kind: "next-message", reason: FIXTURE } },
    backgroundStop: { kind: "ends-with-turn", evidence: FIXTURE },
    turnRecovery: { kind: "manual", reason: FIXTURE },
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async () => state("ready"),
    prompt: async (_id, text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      sent.push(text)
      turn("Done.")
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    controlInstructions: () => [NOTE],
  })
  return {
    id,
    sent,
    calls,
    owner,
    requests: () => owner.snapshot(id)?.requests ?? [],
    settled: () => (owner.snapshot(id)?.requests ?? []).every((request) => request.status === "completed"),
    finish: () => owner.observe({ type: "live-session", session: state("ready") }),
    start: () => owner.start("test-provider", root, { conversationId: id }),
    cleanup: () => {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const noted = (text: string) => `<mako-local-control>\n${NOTE}\n</mako-local-control>\n\n${text}`

async function aCommandGoesAsWritten() {
  const host = reviewHost({ kind: "native", via: FIXTURE, start: { via: "message", text: claudeReviewCommand } })
  try {
    await host.start()
    host.owner.review(host.id, BRANCH)
    await waitFor(() => host.sent.length === 1 && host.settled(), "the review never ran")
    assert.deepEqual(host.sent, ["/code-review main...HEAD"], "the harness reads its command only at the start of the message")
    const [review] = host.requests()
    assert.equal(review?.displayText, "/review changes against main", "the transcript shows the review, not the harness's command")
    assert.deepEqual(review?.review, BRANCH)
    assert.equal(review?.verbatim, true)
    host.owner.submit(host.id, randomUUID(), "Fix the first one")
    await waitFor(() => host.sent.length === 2, "the next message never went")
    assert.equal(host.sent[1], noted("Fix the first one"), "Mako's note rides on the next message")
  } finally {
    host.cleanup()
  }
}

async function aCallStartsTheReview() {
  const host = reviewHost({ kind: "native", via: FIXTURE, start: { via: "call", run: async () => {} } })
  try {
    await host.start()
    host.owner.review(host.id, COMMIT)
    await waitFor(() => host.calls.length === 1 && host.settled(), "the review call never ran")
    assert.deepEqual(host.calls.map((call) => call.target), [COMMIT])
    assert.deepEqual(host.sent, [], "a review the harness starts by a call sends no message")
    const [review] = host.requests()
    assert.equal(review?.displayText, "/review commit 1a2b3c4")
    assert.equal(review?.nativeDelivery?.evidence.kind, "accepted", "the call reports delivery the way a prompt does")
  } finally {
    host.cleanup()
  }
}

async function makosPromptOnAHarnessWithout() {
  const reviewer = "Hand the review to your review subagent."
  const host = reviewHost({ kind: "mako", reason: FIXTURE, reviewer })
  try {
    await host.start()
    host.owner.review(host.id, CHANGES)
    await waitFor(() => host.sent.length === 1 && host.settled(), "Mako's review never ran")
    assert.equal(host.sent[0], noted(makoReviewPrompt(CHANGES, reviewer)), "Mako's prompt is prose, so its note goes with it")
    assert.match(host.sent[0]!, new RegExp("```" + REVIEW_FENCE))
    assert.match(host.sent[0]!, /Hand the review to your review subagent\. Don't change any files\./)
    assert.match(host.sent[0]!, /git status --short/)
    const [review] = host.requests()
    assert.equal(review?.displayText, "/review uncommitted changes")
    assert.equal(review?.verbatim, undefined)
  } finally {
    host.cleanup()
  }
}

async function aReviewQueuesBehindTheTurn() {
  const host = reviewHost({ kind: "native", via: FIXTURE, start: { via: "message", text: openCodeReviewCommand } }, { hold: true })
  try {
    await host.start()
    host.owner.submit(host.id, randomUUID(), "Add the parser")
    await waitFor(() => host.owner.snapshot(host.id)?.session.status === "running", "the first turn never ran")
    host.owner.review(host.id, CHANGES)
    assert.equal(host.requests()[1]?.status, "queued", "a review waits for the running turn")
    assert.equal(host.sent.length, 1)
    host.finish()
    await waitFor(() => host.sent.length === 2 && host.settled(), "the queued review never ran")
    assert.equal(host.sent[1], "/review")
  } finally {
    host.cleanup()
  }
}

function targets() {
  assert.equal(reviewTargetLabel(CHANGES), "uncommitted changes")
  assert.equal(reviewTargetLabel(BRANCH), "changes against main")
  assert.equal(reviewTargetLabel(COMMIT), "commit 1a2b3c4")
  assert.equal(reviewDisplayText(COMMIT), "/review commit 1a2b3c4")
  for (const base of ["main", "release/2.0", "feature_x-1"])
    assert.ok(ReviewTargetSchema.safeParse({ kind: "branch", base }).success, base)
  for (const base of ["", "--upload-pack=touch", "main..evil", "main; rm", "a b"])
    assert.equal(ReviewTargetSchema.safeParse({ kind: "branch", base }).success, false, `"${base}" isn't a branch name`)
  for (const sha of ["abc", "zzzzzzz", "1a2b3c4 --x"])
    assert.equal(ReviewTargetSchema.safeParse({ kind: "commit", sha }).success, false, `"${sha}" isn't a commit`)
  assert.deepEqual([CHANGES, BRANCH, COMMIT].map(claudeReviewCommand), ["/code-review uncommitted changes", "/code-review main...HEAD", "/code-review 1a2b3c4d5e6f"])
  assert.deepEqual([CHANGES, BRANCH, COMMIT].map(openCodeReviewCommand), ["/review", "/review main", "/review 1a2b3c4d5e6f"])
  assert.match(makoReviewPrompt(COMMIT), /commit 1a2b3c4d5e6f \("Parse empty headers"\)\. Run `git show 1a2b3c4d5e6f`\./)
  assert.match(makoReviewPrompt(BRANCH), /Run `git diff main\.\.\.HEAD`\./)
}

/** Recorded from codex-cli 0.159.3's `ReviewOutputEvent` and the text its app-server renders from it. */
function codexFindings() {
  const output = CodexReviewOutputSchema.parse({
    findings: [
      { title: "[P1] Empty header crashes the parser", body: "`split` returns one part for \"\", so `parts[1]` is undefined.\n\nGuard the empty case.", confidence_score: 0.8, priority: 1, code_location: { absolute_file_path: "/repo/src/parse.ts", line_range: { start: 12, end: 14 } } },
      { title: "[P3] Unused import", body: "", confidence_score: 0.4, priority: 3, code_location: { absolute_file_path: "/repo/src/index.ts", line_range: { start: 1, end: 1 } } },
    ],
    overall_correctness: "patch is incorrect",
    overall_explanation: "The parser change breaks empty headers.",
    overall_confidence_score: 0.7,
  })
  const report = codexReviewReport(output)
  assert.deepEqual(report, {
    summary: "The parser change breaks empty headers.",
    findings: [
      { title: "Empty header crashes the parser", body: "`split` returns one part for \"\", so `parts[1]` is undefined.\n\nGuard the empty case.", path: "/repo/src/parse.ts", line: 12, endLine: 14, priority: 1 },
      { title: "Unused import", path: "/repo/src/index.ts", line: 1, priority: 3 },
    ],
  })
  const echo = codexReviewEcho(output)
  assert.match(echo, /^The parser change breaks empty headers\.\n\nFull review comments:\n\n- \[P1\] Empty header crashes the parser — \/repo\/src\/parse\.ts:12-14\n {2}`split`/)
  assert.deepEqual(codexReviewText(echo), report, "the live item's text reads back as the rollout's typed findings")
  assert.equal(codexReviewText("Reviewer failed to output a response."), undefined)
  assert.deepEqual(codexReviewText("Looks good to me."), { summary: "Looks good to me.", findings: [] }, "a review with no findings is its explanation")
  const one = codexReviewEcho({ findings: [output.findings[1]!], overall_explanation: "" })
  assert.match(one, /^Review comment:/)
  assert.equal(codexReviewText(one)?.findings.length, 1)
}

/** Claude Code 2.1.283's `ReportFindings` input. */
function claudeFindings() {
  const input = JSON.stringify({
    level: "medium",
    findings: [
      { file: "src/parse.ts", line: 12, summary: "parts[1] is undefined for an empty header", short_summary: "Empty header crashes the parser", failure_scenario: "parse(\"\") throws TypeError", category: "bug", verdict: "confirmed" },
      { file: "src/index.ts", summary: "Unused import of fs" },
    ],
  })
  assert.deepEqual(claudeReviewReport(input), {
    findings: [
      { title: "Empty header crashes the parser", body: "parts[1] is undefined for an empty header\n\nparse(\"\") throws TypeError", path: "src/parse.ts", line: 12, category: "bug" },
      { title: "Unused import of fs", path: "src/index.ts" },
    ],
  })
  assert.equal(claudeReviewReport("{\"findings\": 3}"), undefined)
  assert.equal(claudeReviewReport("not json"), undefined)
}

/** A `mako-review` block as an agent writes it, with the slips agents make. */
function makoFindings() {
  const source = JSON.stringify({
    summary: "One real bug.",
    findings: [
      { title: "Empty header crashes the parser", body: "parse(\"\") throws", path: "src/parse.ts", line: 12, endLine: 12, priority: "P1" },
      { title: "", body: "A finding with no title is dropped" },
      { title: "Odd priority", priority: "urgent" },
    ],
  })
  assert.deepEqual(makoReviewReport(source), {
    summary: "One real bug.",
    findings: [
      { title: "Empty header crashes the parser", body: "parse(\"\") throws", path: "src/parse.ts", line: 12, priority: 1 },
      { title: "Odd priority" },
    ],
  })
  assert.deepEqual(makoReviewReport("{\"findings\": []}"), { findings: [] })
  assert.equal(makoReviewReport("{\"findings\": [ broken"), undefined)
}

targets()
codexFindings()
claudeFindings()
makoFindings()
await aCommandGoesAsWritten()
await aCallStartsTheReview()
await makosPromptOnAHarnessWithout()
await aReviewQueuesBehindTheTurn()
console.log("live reviews: a harness's command goes as written and its call starts the review; Mako's prompt goes to the rest; reviews queue; targets are checked; each harness's findings read the same")
