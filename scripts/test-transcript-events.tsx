// Every event the transcript draws between messages: the words each kind
// reads as, its one treatment (quiet, attention, or a turn's cause where a
// prompt stands), and that the provider's own words stay available. Static
// render through the production components and projections; the screenshots
// of the same cases come from `scripts/test-transcript-events-ui.mjs`.
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { entriesFromMessages, type DecodedEntry as ThreadEntry, type Entry, type RecordRef } from "@mako/sessions"
import { backgroundReminderTurn, claudeTaskTurn, grokSubagentTurn, grokTaskTurn, parseClaudeTaskNotification } from "@mako/sessions/harnesses"
import { compactionEvent, mcpServerFailedEvent, modelChangedEvent, type TranscriptEvent, type TurnCause } from "@mako/sessions/events"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { backgroundCommandTurn, CODEX_GOAL, codexGoalTurn, outputTail, subagentTurn } from "@mako/sessions/provider-turn"
import { Exchange } from "../src/components/transcript/exchange"
import { TranscriptSourceContext } from "../src/components/transcript/source-context"
import { entriesToMessages } from "../src/lib/entry-messages"
import { createExchangeBuilder } from "../src/components/viewer/exchange-builder"
import type { ViewedThread } from "../src/state/thread-state"
import { promptLabel, toExchanges, type Exchange as ExchangeData } from "../src/lib/exchanges"
import { causeWords, eventLabel, eventWords, setupWords } from "../src/lib/transcript-events"
import { textOf } from "../src/lib/format"
import { acpStore, type LiveAcpConversation } from "../src/state/acp"
import { threadsStore } from "../src/state/threads"
import { fixtureHarnesses } from "../src/dev/harness-fixtures"
import { continueTurnPrompt, makoPrompts, savedMakoPrompt, type MakoPrompt, type TurnStop } from "../src/state/prompt-delivery"
import { savedContinuation } from "@mako/host/contracts/turn-continuation"
import { goalContinuePrompt, goalStartPrompt } from "@mako/host/contracts/live-goals"

threadsStore.set({ descriptors: fixtureHarnesses })
const LIVE = "21111111-1111-4111-8111-111111111111"
const live: LiveAcpConversation = {
  key: LIVE, draftKey: LIVE, kind: "live", harness: "cursor", cwd: "/disposable", blocks: [], queued: [], hiddenUserPrompt: null,
  createdAt: 1, updatedAt: 1, permission: null, sending: false, canceling: false,
  control: { activeBindingId: LIVE, bindings: [], merges: [], transfers: [], actions: [] },
  session: { id: LIVE, harness: "cursor", cwd: "/disposable", connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] },
}
acpStore.set({ activeKey: LIVE, conversations: { [LIVE]: live } })

const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 2, minute)).toISOString()
const saved = (entries: ThreadEntry[], harness = "claude") => toExchanges(entriesToMessages(entriesFromMessages(entries), { kind: "saved", provider: harness }).messages)
const streamed = (updates: LiveUpdate[], harness = "claude") => toExchanges(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running: false, provider: harness }).messages)
const draw = (exchanges: ExchangeData[], extra: { stops?: Record<string, TurnStop>; mako?: Record<string, MakoPrompt> } = {}) =>
  renderToStaticMarkup(
    <TranscriptSourceContext value={{ liveId: LIVE }}>
      {exchanges.map((exchange) => (
        <Exchange key={exchange.id} exchange={exchange} interrupted={extra.stops?.[exchange.id]} sentByMako={extra.mako?.[exchange.id]} />
      ))}
    </TranscriptSourceContext>
  )
/** A `<task-notification>` as Claude Code 2.1.283 writes it into the session (shapes from this Mac's sessions, text neutralized). */
const notification = (fields: { task: string; status: string; summary: string; result?: string; event?: string; durationMs?: number }) => [
  "<task-notification>",
  `<task-id>${fields.task}</task-id>`,
  `<tool-use-id>toolu_01${fields.task}</tool-use-id>`,
  `<output-file>/private/tmp/claude-501/-fixture/session/tasks/${fields.task}.output</output-file>`,
  `<status>${fields.status}</status>`,
  `<summary>${fields.summary}</summary>`,
  ...fields.event === undefined ? [] : [`<event>${fields.event}</event>`],
  ...fields.result === undefined ? [] : [`<result>${fields.result.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</result>`],
  ...fields.durationMs === undefined ? [] : [`<usage><subagent_tokens>632780</subagent_tokens><tool_uses>282</tool_uses><duration_ms>${fields.durationMs}</duration_ms></usage>`],
  "<note>A task-notification fires each time this agent stops with no live background children of its own.</note>",
  "</task-notification>",
].join("\n")
/** What Claude's reader and its live driver both make of a notification. */
const claudeTurn = (text: string, output?: string) => claudeTaskTurn(parseClaudeTaskNotification(text)!, output)
const claudeTask = (summary: string, status: string, minute: number, more: { result?: string; event?: string; durationMs?: number; output?: string } = {}): ThreadEntry => {
  const turn = claudeTurn(notification({ task: "b1", status, summary, ...more }), more.output)
  const entry: Extract<ThreadEntry, { kind: "event" }> = { kind: "event", at: at(minute), label: turn.reason, opensTurn: true }
  if (turn.cause) entry.cause = turn.cause
  if (turn.body) entry.body = turn.body
  return entry
}
const say = (text: string): ThreadEntry => ({ kind: "assistant", blocks: [{ type: "text", text }] })
const go: LiveUpdate = { kind: "user", text: "Run the suite" }
const marker = (event: TranscriptEvent): LiveUpdate => ({ kind: "event", ...event })
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ")

/* ------------------------------------------------------------------ */
/* the words                                                           */
/* ------------------------------------------------------------------ */

const words: Array<[TurnCause, string, string | undefined, string | undefined]> = [
  [{ kind: "command", outcome: "finished", name: "Watch the checks", exitCode: 0 }, "Background command finished", "Watch the checks", undefined],
  [{ kind: "command", outcome: "failed", name: "Run the tests", exitCode: 2 }, "Background command failed (exit 2)", "Run the tests", "error"],
  [{ kind: "command", outcome: "failed" }, "Background command failed", undefined, "error"],
  [{ kind: "command", outcome: "stopped", name: "Tail", signal: "SIGTERM" }, "Background command stopped (SIGTERM)", "Tail", undefined],
  [{ kind: "command", outcome: "unfinished" }, "Background command didn't finish", "its session ended first", undefined],
  [{ kind: "agent", outcome: "finished", name: "Audit" }, "Agent finished", "Audit", undefined],
  [{ kind: "agent", outcome: "failed", name: "Index" }, "Agent failed", "Index", "error"],
  [{ kind: "agent", outcome: "stopped" }, "Agent stopped", undefined, undefined],
  [{ kind: "monitor", outcome: "event", name: "CI turned green" }, "Monitor reported", "CI turned green", undefined],
  [{ kind: "monitor", outcome: "ended", name: "deploy logs" }, "Monitor stopped watching", "deploy logs", undefined],
  [{ kind: "task", outcome: "progress", name: "Deploy preview" }, "Background task reported progress", "Deploy preview", undefined],
  [{ kind: "task", outcome: "finished" }, "Background task finished", undefined, undefined],
  [{ kind: "goal" }, "Continued toward the goal", undefined, undefined],
  [{ kind: "goal", objective: "Ship the event lines" }, "Continued toward the goal", "Ship the event lines", undefined],
  [{ kind: "monitor", outcome: "event", name: "PR #8 checks", output: "compute-local: pass" }, "compute-local: pass", "PR #8 checks", undefined],
  [{ kind: "monitor", outcome: "ended", name: "PR #8 checks", output: "image: fail" }, "image: fail", "PR #8 checks · stopped watching", undefined],
]
for (const [cause, title, detail, tone] of words) {
  const said = causeWords(cause)
  assert.equal(said.title, title)
  assert.equal(said.detail, detail, title)
  assert.equal(said.tone, tone, title)
}
assert.equal(causeWords({ kind: "goal" }, "Codex").title, "Codex continued toward the goal")
assert.equal(causeWords({ kind: "agent", outcome: "finished", name: "Build", durationMs: 3_530_972 }).aside, "58m 50s", "how long an agent ran stands beside its name")
assert.equal(causeWords({ kind: "command", outcome: "finished", name: "Sleep", durationMs: 8_200 }).aside, "8s")
assert.equal(causeWords({ kind: "command", outcome: "finished", name: "Sleep", durationMs: 400 }).aside, undefined, "under a second says nothing")
assert.equal(eventLabel(causeWords({ kind: "agent", outcome: "finished", name: "Build", durationMs: 65_000 })), "Agent finished · Build · 1m 05s")
assert.ok(words.every(([cause]) => !/exit code 0|\(exit 0\)/.test(causeWords(cause).title)), "a clean exit says nothing about its code")

assert.deepEqual(eventWords(mcpServerFailedEvent("linear", "could not connect")), { glyph: "mcp", title: "MCP server linear didn't start", detail: "could not connect", tone: "warning" })
assert.deepEqual(eventWords({ label: "Warning", detail: "Approaching your 5-hour limit · resets 5:10am", tone: "warning" }),
  { glyph: "warning", title: "Approaching your 5-hour limit · resets 5:10am", tone: "warning" }, "a generic label gives way to what it says")
assert.deepEqual(eventWords({ label: "Notice", detail: "/model · Kept model as `Fable 5.1`" }), { glyph: "notice", title: "/model · Kept model as `Fable 5.1`" })
assert.equal(eventWords(compactionEvent({ trigger: "automatic", tokensBefore: 182_000, tokensAfter: 24_000 })).glyph, "compaction")
assert.equal(eventWords(modelChangedEvent("a", "b")).glyph, "model")
assert.equal(eventWords({ label: "Interrupted", detail: "replaced by a newer message" }).glyph, "stop")
assert.equal(eventWords({ label: "Review mode started" }).glyph, "review")
assert.equal(eventWords({ label: "Earlier history not shown", detail: "412 earlier entries (9 user turns) remain" }).glyph, "history")
assert.equal(eventWords({ label: "Rate limited", tone: "warning" }).glyph, "limit")
assert.equal(eventWords({ label: "Authentication failed", tone: "error" }).glyph, "key")
assert.equal(eventWords({ label: "deploy-guard plugin didn't load", tone: "warning", setup: true }).glyph, "plugin")
assert.deepEqual(eventWords({ label: 'Background command "npm test" completed (exit code 0)', cause: { kind: "command", outcome: "finished", name: "npm test", exitCode: 0 } }),
  { glyph: "command", title: "Background command finished", detail: "npm test" }, "a marker with a cause reads as the cause")

const signIn = ["wisprflow", "todoist", "axiom"].map((server) => mcpServerFailedEvent(server, "sign-in required"))
assert.deepEqual(setupWords(signIn), { glyph: "mcp", title: "3 MCP servers need sign-in", detail: "wisprflow, todoist, axiom", tone: "warning" })
assert.deepEqual(setupWords([...signIn, mcpServerFailedEvent("paper", "connection closed")]),
  { glyph: "mcp", title: "4 MCP servers didn't start", detail: "wisprflow, todoist, axiom, paper", tone: "warning" })
assert.deepEqual(setupWords([signIn[0]!, { label: "Warning", detail: "Codex is ignoring 2 settings", tone: "warning", setup: true }]),
  { glyph: "mcp", title: "MCP server wisprflow didn't start", detail: "sign-in required · 1 other setup notice", tone: "warning" })
assert.deepEqual(setupWords([{ label: "Grok permission rules", detail: "2 denied", setup: true }, { label: "deploy-guard plugin didn't load", tone: "warning", setup: true }]),
  { glyph: "warning", title: "2 setup notices", detail: "Grok permission rules, deploy-guard plugin didn't load", tone: "warning" }, "a group names what it holds")
console.log("Words: every cause, marker and setup group reads as a sentence; a clean exit hides its code; numbers carry their nouns")

/* ------------------------------------------------------------------ */
/* turns the provider started                                          */
/* ------------------------------------------------------------------ */

const REPORT = "I built both pieces: the window shortcut and the element tree.\n\n**Checks**\n- Typecheck passes.\n- `<Tree>` renders each frame."
const finished = draw(saved([claudeTask(`Background command "Watch the pull request's checks until done" completed (exit code 0)`, "completed", 20, { output: "build\tpass\nAll checks were successful" }), say("All 14 checks passed.")]))
assert.match(finished, /data-provider-turn="command"/)
assert.match(text(finished), /Background command finished Watch the pull request's checks until done \d{1,2}:20 [AP]M/, "the cause, what it was, and its moment on one line")
assert.doesNotMatch(finished, /continued on its own/, "no boilerplate prefix")
assert.doesNotMatch(finished, /exit code 0|All checks were successful/, "nothing below the line is mounted until it opens")
assert.match(finished, /<button[^>]*data-event-line[^>]*aria-expanded="false"[^>]*aria-controls=/, "the line opens onto the end of the command's output")
assert.match(finished, /justify-end/, "it stands where a prompt would")
assert.match(finished, /<time dateTime="2026-10-12T02:20:00.000Z"/, "the moment is a time element, inline")
assert.doesNotMatch(finished, /lucide-bot/, "a command wears the shell glyph, not a robot")
assert.match(finished, /lucide-square-terminal|lucide-terminal/, "the tool rows' shell glyph")
const outputOpener = saved([claudeTask(`Background command "Watch" completed (exit code 0)`, "completed", 20, { output: "build\tpass\nAll checks were successful" }), say("Done.")])[0]!.opener!
assert.equal(outputOpener.note?.body, "```output\nbuild\tpass\nAll checks were successful\n```", "the end of the output, as written, is what opens")

// A command with nothing left to read is a note: the sentence would only repeat the line.
const bare = draw(saved([claudeTask(`Background command "Watch the test logs" completed (exit code 0)`, "completed", 21), say("Done.")]))
assert.match(bare, /role="note" data-event-line/, "nothing to open, so nothing pretends to open")
assert.doesNotMatch(bare, /aria-expanded/)

const failed = draw(saved([claudeTask(`Background command "Run the test suite" failed with exit code 1`, "failed", 22), say("Two tests fail.")]))
assert.match(failed, /class="[^"]*text-negative">Background command failed \(exit 1\)</, "a failure reads in its tone, with its exit code")

// The reported row: an agent's line is short, its report opens, and Claude's own sentence is nowhere.
const agentTurn = claudeTurn(notification({ task: "afb850976a0db183f", status: "completed", summary: `Agent "Build the window shortcut and element tree" finished`, result: `[harness: subagent output matched instruction-shaped pattern(s): harness-envelope-tag. Control tags below are neutralized.]\n\n${REPORT}`, durationMs: 3_530_972 }))
assert.deepEqual(agentTurn.cause, { kind: "agent", outcome: "finished", agentId: "afb850976a0db183f", name: "Build the window shortcut and element tree", durationMs: 3_530_972 })
assert.equal(agentTurn.body, REPORT, "the report, unescaped and without Claude's note to its model, is the body")
const reported = saved([{ kind: "event", at: at(26), label: agentTurn.reason, cause: agentTurn.cause!, body: agentTurn.body!, opensTurn: true }, say("Both pieces are in.")])
const reportedRow = draw(reported)
assert.match(text(reportedRow), /Agent finished Build the window shortcut and element tree 58m 50s \d{1,2}:26 [AP]M/, "short: what, which, how long, when")
assert.doesNotMatch(reportedRow, /I built both pieces|finished&quot;|Agent &quot;/, "neither the report nor Claude's sentence is in the line")
assert.match(reportedRow, /<button[^>]*data-event-line[^>]*aria-expanded="false"/, "the report opens")
assert.equal(promptLabel(reported[0]!), "Agent finished · Build the window shortcut and element tree · 58m 50s", "the navigator names the turn in the same words")

// Live, the driver reads the same line Claude wrote as the turn's prompt, so live and saved are the same turn.
const liveAgent = streamed([{ kind: "provider-turn", ...agentTurn, at: Date.parse(at(26)) }, { kind: "text", id: "t", text: "Both pieces are in." }])
assert.equal(liveAgent[0]!.opener?.timestamp, Date.parse(at(26)), "a live opener carries the moment the host received it")
assert.equal(liveAgent[0]!.opener?.note?.body, REPORT)
assert.match(text(draw(liveAgent)), /Agent finished Build the window shortcut and element tree 58m 50s \d{1,2}:26 [AP]M/, "live shows its time, as saved does")

// A monitor's event is the news: what it printed is the line, the watch it came from is the detail.
const monitor = claudeTurn(notification({ task: "beswk00fy", status: "completed", summary: `Monitor event: "PR #8 CI checks finishing (pass or fail)"`, event: "compute-local: pass\nconformance: pass" }))
assert.deepEqual(monitor.cause, { kind: "monitor", outcome: "event", name: "PR #8 CI checks finishing (pass or fail)", output: "compute-local: pass" })
assert.equal(monitor.body, "```output\ncompute-local: pass\nconformance: pass\n```", "the whole event opens")
const monitorRow = draw(streamed([{ kind: "provider-turn", ...monitor, at: Date.parse(at(19)) }, { kind: "text", id: "t", text: "Two passed." }]))
assert.match(text(monitorRow), /compute-local: pass PR #8 CI checks finishing \(pass or fail\) \d{1,2}:19 [AP]M/)
assert.match(monitorRow, /data-provider-turn="monitor"/)
const single = claudeTurn(notification({ task: "beswk00fy", status: "completed", summary: `Monitor "PR #8 checks" stream ended`, event: "image: fail" }))
assert.equal(single.body, undefined, "a one-line event is all on the line")
assert.equal(causeWords(single.cause!).title, "image: fail")

const stopped = draw(streamed([{ kind: "provider-turn", ...backgroundCommandTurn({ description: "Tail the dev server log", signal: "SIGTERM" }) }, { kind: "text", id: "t", text: "Stopped." }], "grok"))
assert.match(text(stopped), /Background command stopped \(SIGTERM\) Tail the dev server log/)

const agent = draw(streamed([{ kind: "provider-turn", ...subagentTurn({ description: "Index the repository", state: "failed" }) }, { kind: "text", id: "t", text: "It ran out of memory." }], "devin"))
assert.match(text(agent), /Agent failed Index the repository/)
assert.match(agent, /data-provider-turn="agent"/)
assert.doesNotMatch(agent, /aria-expanded/, "Devin's own sentence for it would only repeat the line")

const goal = draw(streamed([{ kind: "provider-turn", ...CODEX_GOAL }, { kind: "text", id: "t", text: "Next: wire the footer." }], "codex"))
assert.match(text(goal), /Codex continued toward the goal/)
assert.doesNotMatch(goal, /took a turn toward the goal/)
const standing = codexGoalTurn({ objective: "Ship the event lines\nand their screenshots", tokensUsed: 48_210, tokenBudget: 200_000 })
assert.deepEqual(standing.cause, { kind: "goal", objective: "Ship the event lines" })
assert.equal(standing.body, "Ship the event lines\nand their screenshots\n\n48,210 tokens used of a 200,000-token budget.")
assert.equal(codexGoalTurn({ objective: "Ship it", tokensUsed: 0, tokenBudget: null }).body, "0 tokens used so far, with no budget.", "a one-line objective is all on the line")
assert.match(text(draw(streamed([{ kind: "provider-turn", ...standing }, { kind: "text", id: "t", text: "Next." }], "codex"))), /Codex continued toward the goal Ship the event lines/)

const words_ = draw(streamed([{ kind: "provider-turn", reason: "The server restarted while you were working." }, { kind: "text", id: "t", text: "Resuming." }], "opencode"))
assert.match(words_, /data-provider-turn="said"/)
assert.match(text(words_), /The server restarted while you were working\./, "with nothing to reword, the provider's own sentence is the line")
assert.doesNotMatch(words_, /aria-expanded/, "a short sentence of its own has nothing more to open")

const folded = draw(saved([claudeTask(`Background command "Watch the test logs" failed with exit code 1`, "failed", 32), { kind: "user", at: at(33), text: "What failed?" }, say("The watcher exited.")]))
assert.match(folded, /data-provider-turn="command"/, "a cause delivered with the next prompt reads as a cause under it")
assert.doesNotMatch(folded, /h-px flex-1 bg-hairline/, "no hairline separator")

// Cursor's canned message for Build on a plan is not reworded: its label and first line are the line, the rest opens.
const plan = draw(saved([{ kind: "event", at: at(47), label: "Implement plan", detail: "Implement the plan as specified.", body: "Implement the plan as specified. Do NOT edit the plan file itself.", opensTurn: true }, say("Starting.")], "cursor"))
assert.match(text(plan), /Implement plan Implement the plan as specified\./)
assert.match(plan, /data-provider-turn="said"/)
assert.doesNotMatch(plan, /Do NOT edit/, "the body waits until the line is opened")

// Every harness's settled work carries what there is to read: an agent's report, a command's output, a duration.
const grokTask = grokTaskTurn({ task_id: "t", description: "Sleep then print", command: "sleep 8; echo BG-DONE", exit_code: 0, output: "\u001b[32mBG-DONE\u001b[0m\n", start_time: { secs_since_epoch: 100 }, end_time: { secs_since_epoch: 108, nanos_since_epoch: 200_000_000 } })
assert.deepEqual(grokTask.cause, { kind: "command", outcome: "finished", name: "Sleep then print", exitCode: 0, durationMs: 8_200 })
assert.equal(grokTask.body, "```output\nBG-DONE\n```", "terminal colours are left out")
assert.equal(grokTaskTurn({ description: "Watch deploys", kind: "monitor", output: "deploy 41 done" }).cause?.kind, "monitor")
const reminder = `<system-reminder>\nBackground task "t" completed (exit code: 0).\nDescription: Sleep then print | Duration: 8.2s\nUse get_command_or_subagent_output("t") to see the full output.\n</system-reminder>`
const grokSaved = backgroundReminderTurn(reminder, new Map([["t", { task_id: "t", output: "BG-DONE" }]]))!
assert.deepEqual(grokSaved.cause, { kind: "command", outcome: "finished", name: "Sleep then print", exitCode: 0, durationMs: 8_200 }, "saved reads the reminder's duration")
assert.equal(grokSaved.body, "```output\nBG-DONE\n```", "and its task's output, from the snapshot the store kept")
const wake = `<system-reminder>\nWhile you were idle, 1 background subagent completed:\n- [general-purpose] "Sleep 20 then reply" — completed successfully (32.9s, 2 tool calls)\n=== Task 01a0 ===\nCommand: [subagent:general-purpose] Sleep 20 then reply\nStatus: completed\n\n=== Output ===\nCHILD_DONE\n\n<subagent_meta>id=01a0, duration_ms=32944</subagent_meta>\n</system-reminder>`
assert.deepEqual(backgroundReminderTurn(wake), { reason: 'Subagent "Sleep 20 then reply" completed', cause: { kind: "agent", outcome: "finished", agentId: "01a0", name: "Sleep 20 then reply", durationMs: 32_900 }, body: "CHILD_DONE" })
assert.deepEqual(grokSubagentTurn({ sessionUpdate: "subagent_finished", subagent_id: "01a0", status: "completed", duration_ms: 32_944, output: "CHILD_DONE", will_wake: true }, "Sleep 20 then reply"),
  { reason: 'Subagent "Sleep 20 then reply" completed', cause: { kind: "agent", outcome: "finished", agentId: "01a0", name: "Sleep 20 then reply", durationMs: 32_944 }, body: "CHILD_DONE" }, "live reads the same subagent from its finish")
assert.equal(outputTail("one\r10%\r100%\ntwo\n\n"), "100%\ntwo", "a progress bar's line is its last drawing")
console.log("Causes: each stands where a prompt would, in plain words with its time, and opens onto what the work left to read")

// The history viewer builds its exchanges itself, a page at a time: a cause opens its own turn there too.
const viewed = (entries: ThreadEntry[]) => {
  const flat = entriesFromMessages(entries)
  const thread: ViewedThread = { ref: { harness: "claude", nativeId: "n", path: "/fixture/viewed.jsonl" }, entries: flat, pageStart: 0, totalEntries: flat.length, hasEarlier: false }
  return createExchangeBuilder()(thread)
}
const viewedTurns = viewed([{ kind: "user", text: "Watch the checks" }, say("Watching."), claudeTask(`Background command "Watch the checks" completed (exit code 0)`, "completed", 20), say("All green.")])
assert.equal(viewedTurns.length, 2, "the cause opens a second exchange, as toExchanges draws it")
assert.equal(viewedTurns[1]!.opener?.note?.cause?.kind, "command")
assert.match(text(draw(viewedTurns)), /Background command finished Watch the checks/)
const viewedFolded = viewed([claudeTask(`Background command "Watch" failed with exit code 1`, "failed", 30), { kind: "user", text: "What failed?" }, say("It exited.")])
assert.match(draw(viewedFolded), /data-provider-turn="command"/)
assert.doesNotMatch(draw(viewedFolded), /h-px flex-1 bg-hairline/)


/* ------------------------------------------------------------------ */
/* markers inside a turn                                               */
/* ------------------------------------------------------------------ */

const markers = draw(streamed([
  go,
  { kind: "text", id: "a1", text: "Reading." },
  marker(compactionEvent({ trigger: "automatic", tokensBefore: 182_000, tokensAfter: 24_000, durationMs: 8_000, summary: "Kept: the plan." })),
  marker(modelChangedEvent("gpt-6-astra", "gpt-5.5", "capacity")),
  marker({ label: "Interrupted", detail: "replaced by a newer message" }),
  { kind: "text", id: "a2", text: "Continuing." },
]))
assert.match(text(markers), /Context compacted Automatic · 182k → 24k tokens · took 8s/)
assert.match(text(markers), /Model changed gpt-6-astra → gpt-5\.5 · capacity/)
assert.match(text(markers), /Interrupted replaced by a newer message/)
assert.equal(markers.match(/role="note" data-event-line/g)?.length, 2, "quiet markers are notes, one line each")
assert.equal(markers.match(/<button[^>]*data-event-line/g)?.length, 1, "only the marker with a body opens")
assert.doesNotMatch(markers, /Kept: the plan/, "a summary stays unmounted until opened")
assert.doesNotMatch(markers, /text-caution|text-negative/, "ambient markers carry no hue")

const warning = draw(streamed([go, marker({ label: "Warning", detail: "Approaching your 5-hour limit · resets 5:10am", tone: "warning" })]))
assert.match(warning, /lucide-triangle-alert[^"]*text-caution/, "a warning's glyph takes the caution hue")
assert.match(warning, /data-event-title="true" class="[^"]*text-foreground">Approaching your 5-hour limit/, "its words stand at full strength, not painted")
assert.doesNotMatch(text(warning), /Warning Approaching/, "the category label gives way to what it says")

const failure = draw(streamed([go, marker({ label: "Turn failed", detail: "stream disconnected before completion", tone: "error" })]))
assert.match(failure, /lucide-circle-alert[^"]*text-negative/)
assert.match(failure, /class="[^"]*text-negative">Turn failed</)

const long = draw(streamed([go, marker({ label: "Warning", detail: "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings in config.toml.", tone: "warning" })]))
assert.match(long, /<button[^>]*data-event-line[^>]*aria-expanded="false"/, "a line too long to fit opens onto the whole of it")

const queued = draw(saved([{ kind: "user", at: at(35), text: "Keep going" }, say("Working."), { kind: "event", label: `Background command "npm test" completed (exit code 0)`, cause: { kind: "command", outcome: "finished", name: "npm test", exitCode: 0 } }, say("Tests pass.")]))
assert.match(text(queued), /Background command finished npm test/, "a queued notification inside a turn reads as the cause it is")
// A monitor's event Claude took in mid-turn: live, the driver reads the `queued_command` line saved history reads, and draws it where saved history does.
const tick = claudeTurn(notification({ task: "bmon1", status: "completed", summary: `Monitor event: "PR #8 CI checks"`, event: "compute-local: pass\nconformance: pass" }))
const tickMarker = { label: tick.reason, ...tick.cause && { cause: tick.cause }, ...tick.body && { body: tick.body } }
const liveTick = streamed([go, { kind: "tool", id: "b", name: "Bash", title: "Bash", status: "completed", input: '{"command":"npm run build"}', output: "built" },
  { kind: "event", ...tickMarker, id: "l1", source: { harness: "claude", record: "l1" } }, { kind: "text", id: "a", text: "Two checks passed." }])
const savedTick = saved([{ kind: "user", at: at(35), text: "Run the suite" },
  { kind: "assistant", blocks: [{ type: "tool", id: "b", name: "Bash", input: '{"command":"npm run build"}', output: "built" }] },
  { kind: "event", id: "l1", source: { harness: "claude", record: "l1" }, ...tickMarker }, say("Two checks passed.")])
const order = (exchanges: ExchangeData[]) => exchanges.flatMap((exchange) => exchange.response.map((message) => message.note ? `note:${message.note.label}:${message.note.source?.record}` : message.blocks.map((block) => block.type).join(",")))
assert.deepEqual(order(liveTick), order(savedTick), "live draws the monitor's event between the command and the reply, as saved history does, citing the same line")
assert.match(text(draw(liveTick)), /compute-local: pass PR #8 CI checks/, "and words it from what the monitor printed")
// A turn Claude ran on a notification cites the prompt line it ran on, live as saved.
const cited = entriesToMessages(reduceLiveUpdates([], [{ kind: "provider-turn", ...tick, source: { harness: "claude", record: "p1" }, at: 1 }]), { kind: "live", running: false, provider: "claude" }).messages
assert.deepEqual(cited[0]?.note?.source, { harness: "claude", record: "p1" }, "the live opener carries the line it was read from")
console.log("Markers: one quiet line each in the tool column; attention is the hue on the glyph, the words at full strength, red only for errors")

/* ------------------------------------------------------------------ */
/* setup notices                                                       */
/* ------------------------------------------------------------------ */

const setup = draw(streamed([...signIn.map(marker), go, { kind: "text", id: "a", text: "Going ahead." }]))
assert.match(text(setup), /3 MCP servers need sign-in wisprflow, todoist, axiom/)
assert.equal(setup.match(/data-event-line/g)?.length, 1, "three notices, one line")
const history = draw(saved([...signIn.map((note): ThreadEntry => ({ kind: "event", ...note })), { kind: "user", text: "Go" }, say("Going ahead.")]))
assert.match(text(history), /3 MCP servers need sign-in/, "setup notices read back from history gather too")

// What a session said as it opened sits under the prompt it opened for, whichever side of it the harness reported it on.
const where = (exchanges: ExchangeData[]) => exchanges.map((exchange) => [exchange.prompt ? textOf(exchange.prompt.blocks) : exchange.id,
  exchange.system.map((note) => `${note.message.note?.label}@${note.after}`)])
const before = where(streamed([...signIn.map(marker), go, { kind: "text", id: "a", text: "Going ahead." }]))
const after = where(streamed([go, ...signIn.map(marker), { kind: "text", id: "a", text: "Going ahead." }]))
assert.deepEqual(before, after, "a notice before the first prompt reads as one after it does")
assert.deepEqual(before.map(([prompt]) => prompt), ["Run the suite"], "and leaves no exchange of its own above it")
const reopened = streamed([go, { kind: "text", id: "a", text: "Going ahead." }, ...signIn.map(marker), { kind: "user", text: "And QA?" }, { kind: "text", id: "b", text: "QA too." }])
assert.deepEqual(where(reopened), [["Run the suite", []], ["And QA?", signIn.map((note) => `${note.label}@0`)]],
  "a session that opens again (a fork, a reconnect) reports under the next prompt, not at the end of the answer before it")
assert.match(text(draw(reopened)), /And QA\? Copy question Reuse 3 MCP servers need sign-in wisprflow, todoist, axiom Claude Code QA too/)
const midTurn = streamed([go, { kind: "text", id: "a", text: "Reading." }, marker(signIn[0]!), { kind: "text", id: "b", text: "Going ahead." }, { kind: "user", text: "And QA?" }])
assert.deepEqual(where(midTurn)[0], ["Run the suite", [`${signIn[0]!.label}@1`]], "one inside an answer keeps its place")
const unanswered = streamed([go, { kind: "text", id: "a", text: "Going ahead." }, marker(signIn[0]!)])
assert.deepEqual(where(unanswered), [["Run the suite", [`${signIn[0]!.label}@1`]]], "and one with no prompt after it yet stays where it arrived")
const notSetup = streamed([go, { kind: "text", id: "a", text: "Going ahead." }, marker({ label: "Interrupted" }), { kind: "user", text: "And QA?" }])
assert.deepEqual(where(notSetup), [["Run the suite", ["Interrupted@1"]], ["And QA?", []]], "only setup notices move")
const savedReopened = saved([{ kind: "user", text: "Run the suite" }, say("Going ahead."), ...signIn.map((note): ThreadEntry => ({ kind: "event", ...note })), { kind: "user", text: "And QA?" }, say("QA too.")])
assert.deepEqual(where(savedReopened), where(reopened), "saved history places them as live does")
console.log("Setup: notices that arrive together are one line naming what they hold, live and from history, under the prompt their session opened for")

/* ------------------------------------------------------------------ */
/* Mako's own lines, stops and errors                                  */
/* ------------------------------------------------------------------ */

const prompted = (id: string, words = continueTurnPrompt("connection-lost", "mako"), sent: number | undefined = Date.parse(at(40))): ExchangeData => ({
  id,
  prompt: { id, role: "user", requestId: id, ...sent !== undefined && { timestamp: sent }, blocks: [{ type: "text", text: words }] },
  response: [{ id: `${id}-a`, role: "assistant", timestamp: Date.parse(at(41)), blocks: [{ type: "text", text: "Picking up." }] }],
  system: [],
})
const continued = draw([prompted("c")], { mako: { c: { kind: "continued", reason: "connection-lost", sender: "mako" } } })
assert.match(continued, /<button[^>]*data-event-line[^>]*>/, "what Mako told the agent opens under its line")
assert.match(continued, /data-turn-continued="connection-lost" data-continued-by="mako"/)
assert.match(text(continued), /Mako continued the turn after the connection to Cursor dropped \d{1,2}:40 [AP]M/)
assert.doesNotMatch(continued, /Continue where you left off/, "its words wait until the line is opened")
const restarted = draw([prompted("r", continueTurnPrompt("provider-exited", "mako"))], { mako: { r: { kind: "continued", reason: "provider-exited", sender: "mako" } } })
assert.match(restarted, /lucide-refresh-cw/)
assert.match(text(restarted), /Mako restarted Cursor and continued the turn/)
assert.match(text(draw([prompted("m")], { mako: { m: { kind: "moved" } } })), /Mako moved this session onto its own branch/)
assert.match(text(draw([prompted("g")], { mako: { g: { kind: "goal", step: { step: "continue", turn: 3 } } } })), /Mako continued toward the goal turn 3/)

// The person's Continue turn sends Mako's words, not theirs: a quiet line saying they continued it, live and saved.
const pressed = draw([prompted("p", continueTurnPrompt("host-quit", "person"))])
assert.match(text(pressed), /You continued the turn after Mako closed \d{1,2}:40 [AP]M/, "known by its words even with a request behind it")
assert.doesNotMatch(pressed, /Copy question/, "not drawn as the person's bubble")

// Who sent a continuation is in its words, so a saved one says who, as live does; one saved before the words said so claims no one.
for (const reason of ["connection-lost", "provider-exited", "signed-out", "host-quit"] as const)
  for (const sender of ["mako", "person"] as const)
    assert.deepEqual(savedContinuation(continueTurnPrompt(reason, sender)), { reason, sender }, `${reason} by ${sender} reads back`)
assert.deepEqual(savedMakoPrompt(`  ${continueTurnPrompt("signed-out", "mako")}\n`), { kind: "continued", reason: "signed-out", sender: "mako" })
const legacy = continueTurnPrompt("connection-lost", "mako").replace(/ Mako sent this on its own;.*$/, "")
assert.deepEqual(savedContinuation(legacy), { reason: "connection-lost" }, "an older build's words name no sender")
assert.equal(savedContinuation(`${continueTurnPrompt("connection-lost", "person")} Also fix the footer.`), undefined, "an edited continuation is the person's own message")
assert.equal(savedContinuation("Continue where you left off."), undefined)
const savedOne = (words: string) => draw(saved([{ kind: "user", at: at(43), text: words }, { kind: "assistant", blocks: [{ type: "text", text: "Picking up." }] }], "cursor"))
assert.match(text(savedOne(continueTurnPrompt("provider-exited", "mako"))), /Mako restarted Cursor and continued the turn \d{1,2}:43 [AP]M/, "saved history names the harness from the answer")
assert.match(text(savedOne(continueTurnPrompt("connection-lost", "person"))), /You continued the turn after the connection to Cursor dropped/)
const unknown = savedOne(legacy)
assert.match(text(unknown), /The turn continued after the connection to Cursor dropped/, "honest about what isn't known")
assert.match(unknown, /data-continued-by="unknown"/)
assert.doesNotMatch(unknown, /Copy question/, "Mako's words are not drawn as the person's, whoever pressed it")
// Live, Mako's own continuation is known from its request; the person's from its words.
assert.deepEqual([...makoPrompts([{ id: "auto", text: continueTurnPrompt("connection-lost", "mako"), attachments: [], status: "completed", continues: { requestId: "x", reason: "connection-lost", auto: true } }])],
  [["auto", { kind: "continued", reason: "connection-lost", sender: "mako" }]])

// Read back from a store, Mako's goal loop is known by its own words, whole.
const goalSaved = draw(saved([{ kind: "user", at: at(43), text: goalContinuePrompt("Ship the event lines") }, say("Next step.")]))
assert.match(goalSaved, /data-goal-step="continue"/)
assert.doesNotMatch(goalSaved, /Copy question|&lt;objective&gt;/, "Mako's instructions are not drawn as the user's words")
assert.match(draw(saved([{ kind: "user", text: goalStartPrompt("Ship the event lines") }, say("Starting.")])), /data-goal-step="set"/)
assert.match(draw(saved([{ kind: "user", text: `${goalContinuePrompt("Ship the event lines")}\nAlso fix the footer.` }, say("Ok.")])), /Copy question/, "an edited goal prompt is the user's")

// A live prompt carries the moment the host sent it, so a live line of Mako's shows its time as a saved one does.
const sentLive = streamed([{ kind: "user", text: continueTurnPrompt("connection-lost", "person"), requestId: "r1", at: Date.parse(at(44)) }, { kind: "text", id: "t", text: "Picking up." }], "cursor")
assert.equal(sentLive[0]!.prompt?.timestamp, Date.parse(at(44)))
assert.match(text(draw(sentLive)), /You continued the turn after the connection to Cursor dropped \d{1,2}:44 [AP]M/)

const yours = draw([prompted("s", "Refactor the store")], { stops: { s: { reason: "stopped", continuable: false, automatic: false } } })
assert.match(yours, /data-turn-stopped="stopped"[^>]*>[^]*?lucide-circle-stop/)
assert.doesNotMatch(yours, /text-caution/, "your own Stop is not an alarm")
const quit = draw([prompted("q", "Refactor the store")], { stops: { q: { reason: "host-quit", continuable: true, automatic: false } } })
assert.match(quit, /data-turn-stopped="host-quit"[^>]*>[^]*?lucide-triangle-alert[^"]*text-caution/)
assert.match(quit, /Continue turn/)

const errored = draw([{ id: "e", prompt: { id: "e", role: "user", blocks: [{ type: "text", text: "Summarize" }] },
  response: [{ id: "e-a", role: "assistant", blocks: [{ type: "text", text: "Reading." }], error: "Request failed: 529 Overloaded\nTry again in a moment." }], system: [] }])
assert.match(errored, /role="alert" data-event-error/)
assert.match(errored, /Request failed: 529 Overloaded\nTry again in a moment\./, "the whole failure shows")
assert.doesNotMatch(errored, /rounded-lg border border-negative/, "no tinted card")

const separator = draw([{ id: "x", prompt: { id: "x", role: "user", blocks: [{ type: "text", text: "Go" }] }, response: [],
  system: [{ after: 0, message: { id: "sys", role: "system", blocks: [{ type: "text", text: "Session resumed from a checkpoint" }] } }] }])
assert.match(separator, /data-system-note/)
assert.doesNotMatch(separator, /h-px flex-1 bg-hairline/, "a plain system line is the same quiet line, not a rule")
console.log("Mako's lines, stops, errors and system lines: one line where a prompt would be; Mako's and the provider's interruptions are attention, yours is not")

// Each message names the entries it was drawn from and their bytes; Original
// is offered where an entry names its record, and an unread record shows
// collapsed, as the JSON it is.
{
  const path = "/sessions/rollout.jsonl"
  const entries: Entry[] = [
    { type: "user", id: "u1", text: "Read the config", record: { ranges: [[0, 40]] } },
    { type: "text", id: "a1", text: "Reading it.", record: { ranges: [[40, 90]] } },
    { type: "tool", id: "call_1", name: "exec_command", status: "completed", input: JSON.stringify({ cmd: "cat config.toml" }), output: "ok", record: { ranges: [[90, 140], [140, 190]] } },
    { type: "unread", id: "@190", kind: "response_item/telepathy", reason: "unknown", raw: { type: "telepathy", note: "```not a fence```" }, record: { ranges: [[190, 260]] } },
    { type: "text", id: "a2", text: "Done." },
  ]
  const { messages } = entriesToMessages(entries, { kind: "saved", provider: "codex", path })
  const prompt = messages.find((message) => message.role === "user")!
  assert.deepEqual(prompt.origin, { path, entries: [{ id: "u1", type: "user", record: { ranges: [[0, 40]] } }] })
  const drawn = messages.flatMap((message) => message.origin?.entries ?? [])
  assert.deepEqual(drawn.map((entry) => entry.id), ["u1", "a1", "call_1", "@190", "a2"], "every entry is named by the message it is drawn in")
  assert.deepEqual(drawn.find((entry) => entry.id === "call_1"), { id: "call_1", type: "tool", label: "exec_command", record: { ranges: [[90, 140], [140, 190]] } })
  const unread = messages.find((message) => message.origin?.entries[0]?.type === "unread")!
  assert.equal(unread.note?.label, "Unread record: response_item/telepathy")
  assert.equal(unread.note?.body, `\`\`\`\`json\n${JSON.stringify({ type: "telepathy", note: "```not a fence```" }, null, 2)}\n\`\`\`\``, "the record whole, fenced as JSON past its own backticks")
  assert.equal(entriesToMessages(entries, { kind: "saved", provider: "codex" }).messages.some((message) => message.origin), false, "a source without a path names nothing")

  const before = draw(toExchanges(messages))
  assert.doesNotMatch(before, /data-show-original/, "a window without a host can't read originals, so it doesn't offer them")
  // SAFETY: the server render reads only `window.mako`'s presence; this fixture sets and deletes just that.
  const host = globalThis as { window?: unknown }
  host.window = { mako: {} }
  try {
    const html = draw(toExchanges(messages))
    assert.equal(html.match(/data-show-original/g)?.length, 2, "the prompt's and the answer's footers offer Original; the unread line's opens with its record")
    assert.match(html, /data-event="Unread record: response_item\/telepathy"[^]*?aria-expanded="false"/, "the unread record starts collapsed")
    // SAFETY: dropping `record` leaves each entry valid, as `record` is optional on every entry type.
    const unrecorded = draw(toExchanges(entriesToMessages(entries.map(({ record: _record, ...entry }) => entry as Entry), { kind: "saved", provider: "codex", path }).messages))
    assert.doesNotMatch(unrecorded, /data-show-original/, "entries that name no record (Mako's older copies) offer nothing to open")
  } finally {
    delete host.window
  }
  console.log("Originals: each message names its entries and their bytes; Original only where a record is named; unread records collapsed as JSON")

  // A live conversation's entries name the stream frames they came from, by their address in its view.
  const frames: RecordRef = { file: "mako-streams:codex/rollout.jsonl", ranges: [[0, 120]] }
  const blocks: Entry[] = [
    { type: "user", requestId: "r1", text: "Read the config", stream: frames },
    { type: "text", text: "Reading it.", stream: { ...frames, ranges: [[120, 300]] } },
  ]
  const streamedLive = entriesToMessages(blocks, { kind: "live", running: false, provider: "codex", cursor: { start: 0, turn: 0, plan: [], offset: 4, token: "view" } }).messages
  assert.deepEqual(streamedLive.map((message) => message.origin), [
    { entries: [{ type: "user", stream: frames, at: { kind: "live", index: 4 } }] },
    { entries: [{ type: "text", stream: { ...frames, ranges: [[120, 300]] }, at: { kind: "live", index: 5 } }] },
  ], "a live block names its frames at its place in the conversation")
  assert.equal(entriesToMessages(blocks, { kind: "live", running: false, provider: "codex" }).messages.some((message) => message.origin), false, "outside a view, a live block has no address to read it by")
  const mergedBase = entriesToMessages([{ ...entries[0]!, stream: frames }], { kind: "saved", provider: "codex", path, token: "view" }).messages
  assert.deepEqual(mergedBase[0]!.origin, { path, entries: [{ id: "u1", type: "user", record: { ranges: [[0, 40]] }, stream: frames, at: { kind: "base", id: "u1" } }] }, "a merged entry names its record and its frames")
  host.window = { mako: {} }
  try {
    assert.equal(draw(toExchanges(streamedLive)).match(/data-show-original/g)?.length, 2, "a live prompt and answer offer what they streamed")
  } finally {
    delete host.window
  }
  console.log("Live originals: live blocks and merged entries name their stream frames by their address in the view, and offer them")
}
