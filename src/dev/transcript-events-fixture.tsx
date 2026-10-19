// Every event the transcript draws between messages, one case each, through
// the same projection a real Thread takes, `entriesToMessages`: saved
// history as its reader's entries, a live session through
// `reduceLiveUpdates`. The words are the ones each harness's reader or
// decoder produces (see docs/audits/2026-10-12/transcript-events/README.md).
import type { ReactNode } from "react"
import type { Entry, EntryOf } from "@mako/sessions/entries"
import { backgroundReminderTurn, claudeTaskTurn, grokSubagentTurn, grokTaskTurn, parseClaudeTaskNotification, type GrokTaskSnapshot } from "@mako/sessions/harnesses"
import { compactionEvent, mcpServerFailedEvent, modelChangedEvent, type TranscriptEvent } from "@mako/sessions/events"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { backgroundCommandTurn, codexGoalTurn, subagentTurn, type ProviderTurnCause } from "@mako/sessions/provider-turn"
import { goalContinuePrompt } from "@mako/host/contracts/live-goals"
import { continueTurnPrompt } from "@mako/host/contracts/turn-continuation"
import { entriesToMessages } from "@/lib/entry-messages"
import { toExchanges, type Exchange as ExchangeData } from "@/lib/exchanges"
import { Exchange } from "@/components/transcript/exchange"
import { TranscriptSourceContext } from "@/components/transcript/source-context"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { threadsStore } from "@/state/thread-store"
import { fixtureHarnesses } from "./harness-fixtures"
import type { MakoPrompt, TurnStop } from "@/state/prompt-delivery"
import type { LiveSnapshot } from "@/lib/types"

const LIVE_ID = "71111111-1111-4111-8111-111111111111"
const at = (minute: number) => Date.UTC(2026, 9, 12, 2, minute)

let seeded = false
/** A live Cursor conversation, so Mako's lines and the footer can name the provider and offer Continue. */
function seed() {
  if (seeded) return
  seeded = true
  threadsStore.set({ descriptors: fixtureHarnesses })
  const snapshot: LiveSnapshot = {
    session: {
      id: LIVE_ID,
      nativeId: "events-fixture",
      harness: "cursor",
      cwd: "/fixture/project",
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    revision: 1,
    createdAt: 1,
    base: null,
    requests: [],
    permissions: [],
    blocks: [],
  }
  applyLiveSnapshot(snapshot)
}

/**
 * A `<task-notification>` as Claude Code 2.1.283 writes it, field for field
 * (shapes from this Mac's sessions on 2026-10-12, text neutralized): what
 * Claude's history reader and its live driver both read the turn's cause from.
 */
function notification(fields: { task: string; status: string; summary: string; result?: string; event?: string; durationMs?: number }): string {
  const escaped = (text: string) => text.replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return [
    "<task-notification>",
    `<task-id>${fields.task}</task-id>`,
    `<tool-use-id>toolu_01Fixture${fields.task}</tool-use-id>`,
    `<output-file>/private/tmp/claude-501/-fixture/session/tasks/${fields.task}.output</output-file>`,
    `<status>${fields.status}</status>`,
    `<summary>${fields.summary}</summary>`,
    ...fields.event === undefined ? [] : [`<event>${fields.event}</event>`],
    ...fields.result === undefined ? [] : [`<result>${escaped(fields.result)}</result>`],
    ...fields.durationMs === undefined ? [] : [`<usage><subagent_tokens>632780</subagent_tokens><tool_uses>282</tool_uses><duration_ms>${fields.durationMs}</duration_ms></usage>`],
    "</task-notification>",
  ].join("\n")
}

/** A notification Claude took in mid-turn, as its reader marks it. */
const queuedMarker = (turn: ProviderTurnCause): TranscriptEvent => ({ label: turn.reason, ...turn.cause && { cause: turn.cause }, ...turn.body && { body: turn.body } })

/** The turn Claude runs on a notification, as both its reader and its driver make it; `output` is the end of the command's output file. */
function claudeTurn(text: string, output?: string): ProviderTurnCause {
  const read = parseClaudeTaskNotification(text)
  if (!read) throw new Error("not a task notification")
  return claudeTaskTurn(read, output)
}

/** What Claude Code's history reader makes of a `<task-notification>` it ran a turn on. */
function claudeTask(text: string, minute: number, output?: string): Entry {
  return opener(claudeTurn(text, output), minute)
}

const ask = (text: string, minute: number): Entry => ({ type: "user", at: at(minute), text })
function say(text: string, minute?: number): Entry {
  const entry: Entry = { type: "text", text }
  if (minute !== undefined) entry.at = at(minute)
  return entry
}
const started: Entry[] = [
  { type: "tool", id: "bash", at: at(1), name: "Bash", input: '{"command":"gh pr checks --watch","run_in_background":true}', output: "Command running in background with ID: b79s33s60" },
  { type: "text", text: "Watching the checks in the background." },
]

/** Saved entries as a reader gives them: each with its id, here its place. */
function saved(entries: Entry[], harness = "claude"): ExchangeData[] {
  const named = entries.map((entry, index) => ({ ...entry, id: entry.id ?? `@${index}` }))
  return toExchanges(entriesToMessages(named, { kind: "saved", provider: harness }).messages)
}
function live(updates: LiveUpdate[], harness = "claude"): ExchangeData[] {
  return toExchanges(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running: false, provider: harness }).messages)
}
/** A turn the provider started, stamped with the moment the host received it, as the live engine stamps it. */
const turn = (cause: ProviderTurnCause, minute = 30): LiveUpdate => ({ kind: "provider-turn", ...cause, at: at(minute) })
const marker = (event: TranscriptEvent): LiveUpdate => ({ kind: "event", ...event })
const go: LiveUpdate = { kind: "user", text: "Run the suite and fix what fails" }
const reply = (id: string, text: string): LiveUpdate => ({ kind: "text", id, text })
const prompted = (id: string, text: string, minute: number): ExchangeData => ({
  id,
  prompt: { id, role: "user", requestId: id, timestamp: at(minute), blocks: [{ type: "text", text }] },
  response: [{ id: `${id}-answer`, role: "assistant", timestamp: at(minute + 1), blocks: [{ type: "text", text: "Picking up where the turn stopped." }] }],
  system: [],
})

interface EventCase {
  id: string
  title: string
  exchanges: ExchangeData[]
  stops?: Record<string, TurnStop>
  mako?: Record<string, MakoPrompt>
  failed?: string
}

/** A saved turn opener as each harness's history reader writes it (asserted in packages/sessions/test/provider-turns.mjs). */
function opener(turn: ProviderTurnCause, minute: number, more: Partial<EntryOf<"provider-turn">> = {}): Entry {
  const entry: EntryOf<"provider-turn"> = { type: "provider-turn", at: at(minute), reason: turn.reason, ...more }
  if (turn.cause) entry.cause = turn.cause
  if (turn.body && !entry.body) entry.body = turn.body
  return entry
}

/** An agent's report, shaped like the one the user opened (a real one, shortened and neutralized). */
const AGENT_REPORT = `I built both pieces: the window shortcut and the element tree with positions. Both work end to end on this Mac, tested against a fixture window.

**What changed**
- \`Cmd+Shift+2\` captures the window under the pointer and attaches it to the composer.
- The capture carries the element tree, each element with its frame in window points.

**Checks**
- Typecheck passes everywhere; lint has zero errors in these files.
- \`npm run test:appshots\` passes (12 cases).

**Left open**
- The tree is read once per capture; a window that animates while it's read can show stale frames.`

const SESSION_LIMIT = "You've hit your session limit · resets 3:20am (America/Los_Angeles)"

/** The end of an output file, as `claudeTaskOutputTail` reads it. */
const CHECKS_OUTPUT = "build\tpass\t2m10s\nlint\tpass\t41s\ntest\tpass\t3m02s\nconformance\tpass\t1m18s\nAll checks were successful"
const TESTS_OUTPUT = " ✓ src/lib/exchanges.test.ts (31 tests) 84ms\n ✗ src/components/footer.test.tsx (2 failed)\n   → footer shows the stop reason\n   → footer offers Continue turn\n\nTest Files  1 failed | 40 passed (41)\n     Tests  2 failed | 512 passed (514)"

/** Grok's settled task, as its live snapshot and its store both carry it (grok 1.0.46). */
const grokTask = (task: Partial<GrokTaskSnapshot>): GrokTaskSnapshot => ({
  task_id: "01a0e0a7-task",
  start_time: { secs_since_epoch: 1_790_475_450, nanos_since_epoch: 508_212_000 },
  end_time: { secs_since_epoch: 1_790_475_461, nanos_since_epoch: 900_000_000 },
  ...task,
})
const grokReminder = (status: string, description: string, seconds: string) =>
  `<system-reminder>\nBackground task "01a0e0a7-task" ${status}.\nDescription: ${description} | Duration: ${seconds}s\nUse get_command_or_subagent_output("01a0e0a7-task") to see the full output.\n</system-reminder>`
const grokSubagents = `<system-reminder>
While you were idle, 3 background subagents completed:
- [general-purpose] "Review the parser" — completed successfully (41.2s, 6 tool calls)
- [general-purpose] "Review the footer" — completed successfully (38.9s, 4 tool calls)
- [general-purpose] "Review the store" — failed (12.0s, 1 tool calls)
=== Task 01a0-a ===
Command: [subagent:general-purpose] Review the parser
Status: completed

=== Output ===
The parser handles nested comments; one edge case left (an unterminated block at end of file).

<subagent_meta>id=01a0-a, type=general-purpose, tool_calls=6, turns=2, duration_ms=41200</subagent_meta>
=== Task 01a0-b ===
Command: [subagent:general-purpose] Review the footer
Status: completed

=== Output ===
The footer reads well; nothing to change.

<subagent_meta>id=01a0-b, type=general-purpose, tool_calls=4, turns=1, duration_ms=38900</subagent_meta>
=== Task 01a0-c ===
Command: [subagent:general-purpose] Review the store
Status: failed

=== Output ===
The model request failed: context window exceeded.
</system-reminder>`

const CASES: EventCase[] = [
  // A turn the provider started itself, per harness, live and from saved history.
  {
    id: "turn-claude-saved-command",
    title: "Claude Code, saved: a background command finished, its output's end opens",
    exchanges: saved([ask("Watch the PR checks in the background", 0), ...started, claudeTask(notification({ task: "b79s33s60", status: "completed", summary: `Background command "Watch the pull request's checks until done" completed (exit code 0)` }), 20, CHECKS_OUTPUT), say("All 14 checks passed.", 21)]),
  },
  {
    id: "turn-claude-live-command-failed",
    title: "Claude Code, live: a background command failed",
    exchanges: live([turn(claudeTurn(notification({ task: "b1n1n3k8v", status: "failed", summary: `Background command "Run the test suite" failed with exit code 1` }), TESTS_OUTPUT), 22), reply("t1", "Two tests in `footer.test.tsx` fail on the new footer.")]),
  },
  {
    id: "turn-claude-saved-agent",
    title: "Claude Code, saved: a background agent finished (the reported row): its report opens",
    exchanges: saved([claudeTask(notification({ task: "afb850976a0db183f", status: "completed", summary: `Agent "Build the window shortcut and element tree" finished`, result: AGENT_REPORT, durationMs: 3_530_972 }), 26), say("Both pieces are in. Next I'll review the element tree's frames.", 27)]),
  },
  {
    id: "turn-claude-live-agent",
    title: "Claude Code, live: the same agent, read from the line Claude wrote as the turn's prompt",
    exchanges: live([turn(claudeTurn(notification({ task: "afb850976a0db183f", status: "completed", summary: `Agent "Build the window shortcut and element tree" finished`, result: AGENT_REPORT, durationMs: 3_530_972 })), 26), reply("t1", "Both pieces are in.")]),
  },
  {
    id: "turn-claude-live-monitor",
    title: "Claude Code, live: a monitor reported, and what it printed is the line",
    exchanges: live([turn(claudeTurn(notification({ task: "beswk00fy", status: "completed", summary: `Monitor event: "PR #8 CI checks finishing (pass or fail)"`, event: "compute-local: pass\nconformance: pass" })), 19), reply("t1", "Two checks passed; waiting on the image build.")]),
  },
  {
    id: "turn-claude-saved-monitor-ended",
    title: "Claude Code, saved: a monitor's last event as its watch ended",
    exchanges: saved([claudeTask(notification({ task: "beswk00fy", status: "completed", summary: `Monitor "PR #8 CI checks finishing (pass or fail)" stream ended`, event: "image: fail" }), 24), say("The image check failed; reading its log.", 25)]),
  },
  {
    id: "turn-claude-saved-unfinished",
    title: "Claude Code, saved: a command outlived its session",
    exchanges: saved([claudeTask(notification({ task: "b2k1nn4zu", status: "stopped", summary: "Background shell command didn't finish before the previous session ended" }), 24), say("The build never finished; starting it again.", 25)]),
  },
  {
    id: "turn-claude-saved-folded",
    title: "Claude Code, saved: a notification delivered with the next prompt",
    exchanges: saved([claudeTask(notification({ task: "b3xzq26wm", status: "failed", summary: `Background command "Watch the test logs" failed with exit code 1` }), 32), ask("What failed in the watcher?", 33), say("The watcher exited after the fixture server closed.", 34)]),
  },
  {
    id: "turn-claude-saved-queued",
    title: "Claude Code, saved: a notification queued mid-turn (a marker, not a turn)",
    exchanges: saved([ask("Keep going on the parser", 35), say("Working on comments."), { type: "event", at: at(36), ...queuedMarker(claudeTurn(notification({ task: "b5g5u5a7c", status: "completed", summary: `Background command "npm test" completed (exit code 0)` }), "Test Files  41 passed (41)\n     Tests  514 passed (514)")) }, say("Tests pass; comments are next.")]),
  },
  {
    id: "turn-claude-live-monitor-midturn",
    title: "Claude Code, live: a monitor reported while the turn ran a command (read from the line Claude wrote, where saved history draws it)",
    exchanges: live([
      go,
      { kind: "tool", id: "watch", name: "Monitor", title: "Monitor", status: "completed", input: '{"command":"gh pr checks 8 --watch","description":"PR #8 CI checks"}', output: "Monitor started (task beswk00fy)" },
      { kind: "tool", id: "build", name: "Bash", title: "Bash", status: "completed", input: '{"command":"npm run build","description":"Build the app"}', output: "built in 41s" },
      { kind: "event", ...queuedMarker(claudeTurn(notification({ task: "beswk00fy", status: "completed", summary: `Monitor event: "PR #8 CI checks"`, event: "compute-local: pass\nconformance: pass" }))), id: "a567bd01", source: { harness: "claude", record: "a567bd01" } },
      reply("t1", "Two checks passed while it built; the image build is still running."),
    ]),
  },
  {
    id: "turn-claude-saved-kept-output",
    title: "Claude Code, saved after a reboot: the command's output file is gone, and its end opens from the copy Mako kept",
    exchanges: saved([ask("Keep going on the parser", 35), say("Working on comments."), { type: "event", at: at(36), id: "0434dbbe", source: { harness: "claude", record: "0434dbbe", body: "kept-copy" }, ...queuedMarker(claudeTurn(notification({ task: "bx5mpaqj8", status: "completed", summary: `Background command "Build the machine image" completed (exit code 0)` }), "pushed image fixture/runner:latest\nBuild finished in 4m12s")) }, say("The image is built; wiring the runner next.")]),
  },
  {
    id: "turn-codex-live-goal",
    title: "Codex, live: a turn toward its goal, with the objective and its spend",
    exchanges: live([turn(codexGoalTurn({ objective: "Make every transcript event say what's worth knowing, live and saved, on every harness.", tokensUsed: 48_210, tokenBudget: 200_000 }), 37), reply("t1", "Next: wire the footer.")], "codex"),
  },
  {
    id: "turn-codex-saved-goal",
    title: "Codex, saved: a turn toward its goal, read from the prompt Codex wrote",
    exchanges: saved([opener(codexGoalTurn({ objective: "A file named goal-proof.txt in the current folder containing exactly goal-db81cc39. Ask me nothing.", tokensUsed: 0, tokenBudget: null }), 37), say("Next: wire the footer.", 38)], "codex"),
  },
  {
    id: "turn-grok-live-stopped",
    title: "Grok, live: a background command was stopped",
    exchanges: live([turn(grokTaskTurn(grokTask({ description: "Tail the dev server log", command: "tail -f dev.log", signal: "SIGTERM", explicitly_killed: true, output: "GET /api/health 200 3ms\nGET /api/threads 200 41ms" })), 38), reply("t1", "The log tail was stopped.")], "grok"),
  },
  {
    id: "turn-grok-saved-finished",
    title: "Grok, saved: a background command finished; the store's snapshot holds its output",
    exchanges: saved([opener(backgroundReminderTurn(grokReminder("completed (exit code: 0)", "Sleep briefly then print BG-DONE", "8.2"), new Map([["01a0e0a7-task", grokTask({ output: "BG-DONE" })]]))!, 39), say("It printed BG-DONE.", 40)], "grok"),
  },
  {
    id: "turn-grok-saved-subagents",
    title: "Grok, saved: several subagents finished (its own count); each report opens",
    exchanges: saved([opener(backgroundReminderTurn(grokSubagents)!, 41), say("Two reviews are in; the third ran out of context.", 42)], "grok"),
  },
  {
    id: "turn-grok-live-subagent",
    title: "Grok, live: a background subagent finished and woke it",
    exchanges: live([turn(grokSubagentTurn({ sessionUpdate: "subagent_finished", subagent_id: "01a0c67b", status: "completed", duration_ms: 32_944, output: "CHILD_DONE_GROK_A", will_wake: true }, "Sleep 20 then reply"), 41), reply("t1", "The subagent replied CHILD_DONE_GROK_A.")], "grok"),
  },
  {
    id: "turn-devin-live-agent-failed",
    title: "Devin, live: a subagent failed",
    exchanges: live([turn(subagentTurn({ description: "Index the repository", state: "failed", durationMs: 95_000, result: "The indexer ran out of memory after 41,000 files." }), 42), reply("t1", "The indexer ran out of memory.")], "devin"),
  },
  {
    id: "turn-devin-saved-agent",
    title: "Devin, saved: a subagent completed; its completion's report opens",
    exchanges: saved([opener(subagentTurn({ description: "Run the checks", state: "completed", durationMs: 16_100, result: "The command `sleep 6 && echo checks-done` ran in the foreground and completed successfully.\n\n- **Output:** `checks-done`" }), 43), say("The checks passed.", 44)], "devin"),
  },
  {
    id: "turn-cursor-live-adopted",
    title: "Cursor, live: a turn Mako picked up again",
    exchanges: live([turn({ reason: "Cursor was already working on this turn when Mako picked it up again." }, 44), reply("t1", "Still refactoring the store.")], "cursor"),
  },
  {
    id: "turn-cursor-saved-failed",
    title: "Cursor, saved: a background shell failed; its terminal file's end opens",
    exchanges: saved([opener(backgroundCommandTurn({ description: "pnpm build", failed: true, exitCode: 1, durationMs: 15_470, output: "src/store.ts:41:7 - error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 1 error in src/store.ts:41" }), 45, { tone: "error" }), say("The build fails on one type error.", 46)], "cursor"),
  },
  {
    id: "turn-cursor-saved-progress",
    title: "Cursor, saved: a background task reported progress",
    exchanges: saved([opener({ reason: `"Deploy preview" reported progress`, cause: { kind: "task", name: "Deploy preview", outcome: "progress" } }, 30, { body: "Uploading 312 of 480 assets" }), say("The preview deploy is two-thirds done.", 31)], "cursor"),
  },
  {
    id: "turn-cursor-saved-plan",
    title: "Cursor, saved: Build pressed on a plan (Cursor's canned message)",
    exchanges: saved([opener({ reason: "Implement plan" }, 47, { detail: "Implement the plan as specified, it is attached for your reference.", body: "Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself." }), say("Starting on step 1.", 48)], "cursor"),
  },
  {
    id: "turn-opencode-live-command",
    title: "OpenCode, live: a background command finished; its output opens",
    // What `openCodeNoticeTurn` reads from `<shell … command="sleep 8 && echo done">done\n\nCommand exited with code 0.</shell>`.
    exchanges: live([turn(backgroundCommandTurn({ description: "sleep 8 && echo done", exitCode: 0, output: "done" }), 49), reply("t1", "It printed done.")], "opencode"),
  },
  {
    id: "turn-opencode-saved-agent",
    title: "OpenCode, saved: a subagent finished; its reply opens",
    // What `openCodeNoticeTurn` reads from `<subagent … state="completed" description="Run the checks">…</subagent>`.
    exchanges: saved([opener(subagentTurn({ description: "Run the checks", state: "completed", result: "All **41** checks pass. The slowest is `conformance` at 1m 18s." }), 49), say("The checks passed.", 50)], "opencode"),
  },
  {
    id: "turn-opencode-live-words",
    title: "OpenCode, live: its own notice, no structure",
    exchanges: live([turn({ reason: "The server restarted while you were working. Pick up where you left off." }, 50), reply("t1", "Resuming the migration.")], "opencode"),
  },
  // Mako's own lines where a prompt would be.
  {
    id: "mako-continued",
    title: "Mako, live: continued after the connection dropped",
    exchanges: [prompted("continued", continueTurnPrompt("connection-lost", "mako"), 40)],
    mako: { continued: { kind: "continued", reason: "connection-lost", sender: "mako" } },
  },
  {
    id: "mako-restarted",
    title: "Mako, live: restarted the provider and continued",
    exchanges: [prompted("restarted", continueTurnPrompt("provider-exited", "mako"), 41)],
    mako: { restarted: { kind: "continued", reason: "provider-exited", sender: "mako" } },
  },
  {
    id: "mako-signed-in",
    title: "Mako, live: continued after the provider signed in again",
    exchanges: [prompted("signed-in", continueTurnPrompt("signed-out", "mako"), 41)],
    mako: { "signed-in": { kind: "continued", reason: "signed-out", sender: "mako" } },
  },
  {
    id: "continued-by-person",
    title: "You, live: pressed Continue turn after Mako quit (known by its words)",
    exchanges: [prompted("by-person", continueTurnPrompt("host-quit", "person"), 41)],
  },
  {
    id: "continued-saved-mako",
    title: "Mako, saved: its own continuation, read back from the store",
    exchanges: saved([ask(continueTurnPrompt("provider-exited", "mako"), 41), say("Picking up where the turn stopped.", 42)], "cursor"),
  },
  {
    id: "continued-saved-person",
    title: "You, saved: Continue turn after the connection dropped, read back from the store",
    exchanges: saved([ask(continueTurnPrompt("connection-lost", "person"), 41), say("Picking up where the turn stopped.", 42)], "cursor"),
  },
  {
    id: "continued-saved-unknown",
    title: "Saved before the words named a sender: who continued is not claimed",
    exchanges: saved([ask(continueTurnPrompt("connection-lost", "mako").replace(/ Mako sent this on its own;.*$/, ""), 41), say("Picking up where the turn stopped.", 42)], "cursor"),
  },
  {
    id: "mako-moved",
    title: "Mako, live: moved the session onto its branch",
    exchanges: [prompted("moved", "You're on the Thread's own branch now.", 42)],
    mako: { moved: { kind: "moved" } },
  },
  {
    id: "mako-goal",
    title: "Mako, live: the goal took its next turn",
    exchanges: [prompted("goal", "Continue toward the goal.", 43)],
    mako: { goal: { kind: "goal", step: { step: "continue", turn: 3 } } },
  },
  {
    id: "mako-goal-saved",
    title: "Mako, saved: the goal's next turn, read back from the store",
    exchanges: saved([ask(goalContinuePrompt("Make every transcript event read as one line"), 43), say("Picking up where the turn stopped.", 44)]),
  },
  {
    id: "mako-review",
    title: "Mako, live: a review it was asked for",
    exchanges: [prompted("review", "Review the uncommitted changes.", 44)],
    mako: { review: { kind: "review", target: { kind: "changes" } } },
  },
  // Markers inside a turn.
  {
    id: "marker-compaction",
    title: "Context compacted, with the provider's summary",
    exchanges: live([go, reply("a1", "Reading the failures."), marker(compactionEvent({ trigger: "automatic", tokensBefore: 182_000, tokensAfter: 24_000, durationMs: 8_000, summary: "The conversation so far: fixing variant matching." })), reply("a2", "Continuing with the fix.")]),
  },
  {
    id: "marker-model-changed",
    title: "The provider changed the model",
    exchanges: live([go, marker(modelChangedEvent("claude-fable-5-1", "claude-opus-4-8", "after a refusal", "Fable 5.1's safeguards flagged this message. Switched to Opus 4.8.")), reply("a1", "Here is the audit.")]),
  },
  {
    id: "marker-notice",
    title: "A provider notice (Claude's /model output)",
    exchanges: live([go, marker({ label: "Notice", detail: "/model · Kept model as `Fable 5.1`" }), reply("a1", "Kept.")]),
  },
  {
    id: "marker-review-mode",
    title: "Codex review mode started and ended",
    exchanges: live([go, marker({ label: "Review mode started", detail: "uncommitted changes" }), reply("a1", "Two findings."), marker({ label: "Review mode ended" })], "codex"),
  },
  {
    id: "marker-interrupted",
    title: "The provider's own Interrupted marker between parts",
    exchanges: live([go, reply("a1", "Starting on the parser."), marker({ label: "Interrupted", detail: "replaced by a newer message" }), reply("a2", "Switching to the newer request.")], "codex"),
  },
  {
    id: "marker-history-cut",
    title: "Earlier history not shown",
    exchanges: saved([{ type: "event", label: "Earlier history not shown", detail: "412 earlier entries (9 user turns) remain in the native session file" }, ask("Pick up the migration", 45), say("Picking it up.")], "codex"),
  },
  {
    id: "marker-warning",
    title: "A warning: approaching a usage limit",
    exchanges: live([go, marker({ label: "Warning", detail: "Approaching your 5-hour limit · resets 5:10am", tone: "warning" }), reply("a1", "Continuing.")]),
  },
  {
    id: "marker-rate-limited",
    title: "Rate limited",
    exchanges: live([go, marker({ label: "Rate limited", detail: "Reached your 5-hour limit · resets 5:10am (America/Los_Angeles)", tone: "warning" })]),
  },
  {
    id: "marker-rate-limited-agents",
    title: "Rate limited: one line for every agent it stopped",
    exchanges: live([
      go,
      reply("a1", "Started six audits in the background."),
      marker({ label: "Rate limited", detail: "Reached your 5-hour limit · resets 3:20am", tone: "warning", limit: { window: "5-hour limit" } }),
      ...["Audit decoders", "Audit watchers", "Audit drivers", "Audit usage", "Audit moves", "Audit footprints"].flatMap((name, index) => [
        turn(claudeTaskTurn(parseClaudeTaskNotification(`<task-notification>\n<task-id>a${index}</task-id>\n<status>failed</status>\n<summary>Agent "${name}" failed: Agent terminated early due to an API error: ${SESSION_LIMIT} (error type rate_limit, HTTP 429)</summary>\n</task-notification>`)!), 31 + index),
        marker({ label: "Rate limited", detail: SESSION_LIMIT, tone: "warning", limit: {} }),
      ]),
      turn({ reason: "A background task finished", cause: { kind: "task", outcome: "finished" } }, 40),
      marker({ label: "Rate limited", detail: SESSION_LIMIT, tone: "warning", limit: {} }),
    ]),
  },
  {
    id: "marker-turn-ended",
    title: "Grok ended the turn by its own rule",
    exchanges: live([go, reply("a1", "Retrying the same edit."), marker({ label: "Turn ended", detail: "Grok stopped making progress", tone: "warning" })], "grok"),
  },
  {
    id: "marker-compaction-failed",
    title: "Compaction failed",
    exchanges: live([go, marker({ label: "Compaction failed", detail: "The summary request timed out", tone: "warning" })]),
  },
  {
    id: "marker-turn-failed",
    title: "Turn failed, with the provider's body",
    exchanges: live([go, reply("a1", "Running the suite."), marker({ label: "Turn failed", detail: "stream disconnected before completion", body: "stream disconnected before completion: error sending request for url (https://api.example.test/v1/responses)\nCaused by: connection reset by peer", tone: "error" })], "codex"),
    failed: "acp-request-",
  },
  {
    id: "marker-auth-failed",
    title: "Authentication failed",
    exchanges: live([go, marker({ label: "Authentication failed", detail: "Login expired · Please run /login", tone: "error" })]),
  },
  // Setup notices.
  {
    id: "setup-mcp-one",
    title: "One MCP server didn't start",
    exchanges: live([marker(mcpServerFailedEvent("linear", "could not connect")), go, reply("a1", "Working without Linear.")], "codex"),
  },
  {
    id: "setup-group",
    title: "A session start's setup report, gathered",
    exchanges: live([
      marker({ label: "Warning", detail: "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.", body: "unknown keys: model_reasoning_summary_format, experimental_resume", tone: "warning", setup: true }),
      go,
      marker(mcpServerFailedEvent("wisprflow", "sign-in required")),
      marker(mcpServerFailedEvent("todoist", "sign-in required")),
      marker(mcpServerFailedEvent("axiom", "sign-in required")),
      marker(mcpServerFailedEvent("paper", "MCP startup failed: handshaking with MCP server failed: connection closed: initialize response\nCaused by: process exited with status 1")),
      reply("a1", "Variant matching required every option to be encoded."),
    ], "codex"),
  },
  {
    id: "setup-sign-in",
    title: "Several servers need sign-in",
    exchanges: live([
      marker(mcpServerFailedEvent("wisprflow", "sign-in required")),
      marker(mcpServerFailedEvent("todoist", "sign-in required")),
      marker(mcpServerFailedEvent("axiom", "sign-in required")),
      go,
      reply("a1", "Going ahead without them."),
    ]),
  },
  {
    id: "setup-permission-rules",
    title: "Grok's permission rules (informational setup)",
    exchanges: live([
      marker({ label: "Grok permission rules", detail: "2 denied, 1 always ask, 3 allowed · ~/.grok/config.toml", body: "Grok merges these rules from its own settings. Deny beats ask, and ask beats allow, whichever file a rule is in.\n\n**Denied, at every access level**\n- `rm -rf`\n- `git push --force`", setup: true }),
      marker({ label: "deploy-guard plugin didn't load", detail: "Cannot find module './guard.js'", tone: "warning", setup: true }),
      go,
      reply("a1", "Starting."),
    ], "grok"),
  },
  // How a turn ended early.
  {
    id: "stop-user",
    title: "Stopped by the user",
    exchanges: [prompted("stop-user", "Refactor the store", 50)],
    stops: { "stop-user": { reason: "stopped", continuable: false, automatic: false } },
  },
  {
    id: "stop-host-quit",
    title: "Interrupted when Mako quit, newest turn",
    exchanges: [prompted("stop-quit", "Refactor the store", 51)],
    stops: { "stop-quit": { reason: "host-quit", continuable: true, automatic: false } },
  },
  {
    id: "stop-crashed",
    title: "Interrupted when Mako closed unexpectedly, older turn",
    exchanges: [prompted("stop-crashed", "Refactor the store", 52)],
    stops: { "stop-crashed": { reason: "host-crashed", continuable: false, automatic: false } },
  },
  {
    id: "stop-connection",
    title: "The connection dropped; Mako is continuing",
    exchanges: [prompted("stop-connection", "Refactor the store", 53)],
    stops: { "stop-connection": { reason: "connection-lost", continuable: false, automatic: true } },
  },
  {
    id: "stop-provider-exited",
    title: "The provider stopped unexpectedly",
    exchanges: [prompted("stop-exited", "Refactor the store", 54)],
    stops: { "stop-exited": { reason: "provider-exited", continuable: true, automatic: false } },
  },
  // Other lines.
  {
    id: "steer",
    title: "A message steered in mid-turn",
    exchanges: saved([{ type: "user", id: "u-parser", at: at(55), text: "Build the parser" }, say("Working on it."), { type: "user", at: at(56), id: "steer", text: "Also handle comments", steeringFor: "u-parser" }, say("Done with both.")]),
  },
  {
    id: "error-row",
    title: "An answer that ended in an error",
    exchanges: [{
      id: "error-row",
      prompt: { id: "error-row", role: "user", timestamp: at(57), blocks: [{ type: "text", text: "Summarize the logs" }] },
      response: [{ id: "error-row-answer", role: "assistant", timestamp: at(58), blocks: [{ type: "text", text: "Reading the logs." }], error: "Request failed: 529 Overloaded\nThe API is temporarily overloaded. Try again in a moment." }],
      system: [],
    }],
  },
]

/** Each case under its name, the way the reader meets it in a transcript. */
export function EventCases(): ReactNode {
  seed()
  return (
    <TranscriptSourceContext value={{ liveId: LIVE_ID, threadPath: "/fixture/native-thread" }}>
      <div className="flex flex-col">
        {CASES.map((entry) => {
          const failed = entry.failed ? entry.exchanges.find((exchange) => exchange.id.startsWith(entry.failed!))?.id : undefined
          return (
            <section key={entry.id} data-event-case={entry.id} className="border-b border-hairline px-6 pt-4 pb-6">
              <h2 className="mb-4 text-label text-faint">{entry.title}</h2>
              <div className="flex flex-col gap-8">
                {entry.exchanges.map((exchange) => (
                  <Exchange
                    key={exchange.id}
                    exchange={exchange}
                    interrupted={entry.stops?.[exchange.id]}
                    sentByMako={entry.mako?.[exchange.id]}
                    failed={exchange.id === failed}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </TranscriptSourceContext>
  )
}
