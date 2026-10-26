import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { compactionEvent, modelChangedEvent } from "@mako/sessions/events"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { Exchange } from "../src/components/transcript/exchange"
import { agentGroupWords, groupAgentCalls } from "../src/lib/agent-groups"
import { TranscriptSourceContext } from "../src/components/transcript/source-context"
import { callEntryId, entriesToMessages } from "../src/lib/entry-messages"
import { responseSections, toExchanges, type Exchange as ExchangeData } from "../src/lib/exchanges"
import { pairTools } from "../src/lib/tools"
import { turnFolds } from "../src/lib/turn-fold"
import { liveVerb } from "../src/state/agent-activity"
import { stoppedWorkWords } from "../src/state/prompt-delivery"
import { setTurnFoldOpen, turnFoldKey } from "../src/state/turn-folds"
import { TOOL_KINDS } from "@mako/sessions/tool-identity"

/**
 * How a turn's work is drawn: one live row while it runs, one fold once it
 * settles, agents started together as one row, boundaries as dividers.
 */

const LIVE = "conversation"
const at = (seconds: number) => Date.parse("2026-10-25T10:00:00.000Z") + seconds * 1000
const exchangesOf = (updates: LiveUpdate[], running: boolean) =>
  toExchanges(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running, provider: "claude" }).messages)
const draw = (exchange: ExchangeData, props: { streaming?: boolean; interrupted?: boolean } = {}) =>
  renderToStaticMarkup(
    <TranscriptSourceContext value={{ liveId: LIVE }}>
      <Exchange exchange={exchange} {...props} />
    </TranscriptSourceContext>
  )
const tool = (id: string, name: string, input: Record<string, string>, status = "completed"): LiveUpdate => ({ kind: "tool", id, title: name, name, status, input: JSON.stringify(input) })
const text = (id: string, words: string): LiveUpdate => ({ kind: "text", id, text: words })
const go: LiveUpdate = { kind: "user", text: "Fix the redirect", at: at(0) }

// A running turn draws what it has done as one summary and the step running now as one row, not a row per call.
{
  const running = exchangesOf([
    go,
    tool("read", "Read", { file_path: "/p/src/guard.ts" }),
    tool("grep", "Grep", { pattern: "returnTo" }),
    tool("edit", "Edit", { file_path: "/p/src/guard.ts", old_string: "a", new_string: "b" }),
    tool("test", "Bash", { command: "npm test" }, "in_progress"),
  ], true)
  const html = draw(running.at(-1)!, { streaming: true })
  assert.equal(html.match(/data-live-step/g)?.length, 1, "one live row")
  assert.match(html, /shimmer-text[^>]*>Running</, "the running step's verb sweeps")
  assert.match(html, />npm test</, "and says what it runs")
  assert.match(html, /data-work-summary[^>]*>[^]*Made an edit, read a file and searched once/, "what finished reads as today's summary")
  assert.doesNotMatch(html, /data-transcript-tool/, "the rows stay unmounted until the list opens")
  assert.match(html, /data-turn-clock/, "the turn's head carries its clock")
}

// The same turn settled folds behind one row and leaves the answer in view.
{
  const updates: LiveUpdate[] = [
    go,
    tool("read", "Read", { file_path: "/p/src/guard.ts" }),
    text("interim", "The guard drops it on refresh."),
    tool("test", "Bash", { command: "npm test" }),
    text("answer", "Fixed: the guard keeps returnTo."),
  ]
  const settled = exchangesOf(updates, false).at(-1)!
  const sections = responseSections(settled.response)
  const folds = turnFolds(sections, settled.prompt?.timestamp)
  assert.equal(folds.length, 1)
  assert.equal(sections[folds[0]!.end]?.kind, "prose", "the answer is left out of the fold")
  const html = draw(settled)
  assert.match(html, /data-turn-fold="closed"/)
  assert.match(html, /Fixed: the guard keeps returnTo\./, "the answer shows")
  assert.doesNotMatch(html, /The guard drops it on refresh\./, "words on the way to it fold with the work")
  assert.match(draw(settled, { interrupted: true }), /data-turn-fold[^]*?<span class="shrink-0">Stopped(?: after [^<]+)?<\/span>/, "a stopped turn's fold says so")
  setTurnFoldOpen(turnFoldKey(LIVE, settled.id, 0), true)
  assert.match(draw(settled), /data-turn-fold="open"[^]*The guard drops it on refresh\./, "opened, it is kept open by exchange")
  setTurnFoldOpen(turnFoldKey(LIVE, settled.id, 0), false)
  // Failures are their own answer; a turn of words alone has nothing to fold.
  const failed = { ...settled, response: settled.response.map((message, index) => (index === settled.response.length - 1 ? { ...message, error: "Server overloaded" } : message)) }
  assert.doesNotMatch(draw(failed), /data-turn-fold/, "a failed turn is not folded")
  const words = exchangesOf([go, text("only", "Just words.")], false).at(-1)!
  assert.equal(turnFolds(responseSections(words.response)).length, 0)
}

// A fold keeps boundaries and attention in view; a steer starts a stretch of its own.
{
  const updates: LiveUpdate[] = [
    go,
    tool("read", "Read", { file_path: "/p/a.ts" }),
    { kind: "event", ...compactionEvent({ trigger: "automatic", tokensBefore: 182_000, tokensAfter: 24_000 }) },
    { kind: "event", label: "Hook", detail: "formatted 2 files" },
    tool("grep", "Grep", { pattern: "x" }),
    text("first", "First answer."),
  ]
  const exchange = exchangesOf(updates, false).at(-1)!
  const sections = responseSections(exchange.response, exchange.system)
  const folds = turnFolds(sections)
  const kept = folds.flatMap((fold) => fold.kept.map((index) => sections[index]!))
  assert.ok(kept.some((section) => section.kind === "note" && section.message.note?.label === "Context compacted"), "a compaction stays in view")
  assert.ok(!kept.some((section) => section.kind === "note" && section.message.note?.label === "Hook"), "an ambient note folds")
  const html = draw(exchange)
  assert.match(html, /data-event-divider[^]*Context compacted[^]*182k → 24k tokens/, "a compaction is a divider with its tokens, in view while the turn is folded")
  assert.doesNotMatch(html, /formatted 2 files/)
  assert.match(draw(exchangesOf([go, { kind: "event", ...modelChangedEvent("a", "b") }, text("x", "ok")], false).at(-1)!), /data-event-divider/, "so is a model change")
  // A steer splits the turn: each stretch folds on its own, the second "continued".
  const work = sections.find((section) => section.kind === "work")!
  const prose = sections.find((section) => section.kind === "prose")!
  const steer = { kind: "steer" as const, id: "steer", message: { id: "steer", role: "user" as const, blocks: [], timestamp: at(60) } }
  const split = turnFolds([work, prose, steer, { ...work, id: "work-2" }, { ...prose, id: "prose-2" }], at(0))
  assert.deepEqual(split.map((fold) => [fold.part, fold.start, fold.end, fold.continued, fold.from]), [[0, 0, 1, false, at(0)], [1, 3, 4, true, at(60)]])
  assert.deepEqual(turnFolds([prose, work]).map((fold) => [fold.start, fold.end]), [[0, 2]], "a stretch that ends on work has no answer and folds whole")
}

// Agents started in one response are one row; their standing is counted.
{
  const exchange = exchangesOf([
    go,
    tool("a1", "Task", { description: "Map routes", prompt: "x", subagent_type: "Explore" }, "in_progress"),
    tool("a2", "Task", { description: "Trace refresh", prompt: "x", subagent_type: "Explore" }, "in_progress"),
    tool("a3", "Task", { description: "Find tests", prompt: "x", subagent_type: "Explore" }),
    tool("r", "Read", { file_path: "/p/a.ts" }),
  ], true).at(-1)!
  const calls = exchange.response.flatMap((message) => pairTools(message.blocks))
  const items = groupAgentCalls(calls)
  assert.deepEqual(items.map((item) => item.kind), ["agents", "call"])
  assert.equal(callEntryId(calls[0]!.id), "a1", "a roster entry names the call by the harness's id")
  assert.deepEqual(agentGroupWords(["working", "working", "done", "failed"]), {
    title: "4 agents",
    counts: [{ word: "working", count: 2 }, { word: "done", count: 1 }, { word: "failed", count: 1 }],
  })
  assert.deepEqual(groupAgentCalls(calls.slice(2)).map((item) => item.kind), ["call", "call"], "one agent alone is its own row")
}

// Words: every kind has a running verb, and a stop names what else it stopped.
for (const kind of TOOL_KINDS) assert.ok(liveVerb(kind).length > 0, kind)
assert.equal(stoppedWorkWords([]), undefined)
assert.equal(stoppedWorkWords(["npm run dev"])?.text, "and stopped npm run dev")
assert.equal(stoppedWorkWords(["npm run dev", "npm run test:watch"])?.text, "and stopped 2 background tasks")
assert.equal(stoppedWorkWords(["npm run dev", "npm run test:watch"])?.all, "npm run dev\nnpm run test:watch")

console.log("Turn presentation: one live row, a settled fold that keeps its answer and boundaries, agents together, stop words")
