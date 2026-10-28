import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { compactionEvent, modelChangedEvent } from "@mako/sessions/events"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { Exchange } from "../src/components/transcript/exchange"
import { ToolRow } from "../src/components/transcript/tool-row"
import { agentGroupWords, groupAgentCalls } from "../src/lib/agent-groups"
import { AgentGroup } from "../src/components/transcript/agent-group"
import { HarnessContext, TranscriptSourceContext, TurnRunningContext } from "../src/components/transcript/source-context"
import { callEntryId, entriesToMessages } from "../src/lib/entry-messages"
import { responseSections, toExchanges, type Exchange as ExchangeData } from "../src/lib/exchanges"
import { argumentsSoFar, entryToolIdentity, pairTools, relativeTo } from "../src/lib/tools"
import { turnFolds } from "../src/lib/turn-fold"
import { liveVerb } from "../src/state/agent-activity"
import { stoppedWorkWords } from "../src/state/prompt-delivery"
import { setTurnFoldOpen, turnFoldKey } from "../src/state/turn-folds"
import { TOOL_KINDS } from "@mako/sessions/tool-identity"

/**
 * How a turn's work is drawn: one column of rows, a summary of what finished
 * with one glyph, then a row for each call running (the transcript's own
 * row, its words under one sweep), one fold once it settles, agents started
 * together as one row with their harness's mark, boundaries as dividers.
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
const tool = (id: string, name: string, input: Record<string, string>, status = "completed", times: { at?: number; endedAt?: number } = {}): LiveUpdate => ({ kind: "tool", id, title: name, name, status, input: JSON.stringify(input), ...times })
/** The text under each sweep in `html`, each sweep's element whole. */
const sweeps = (html: string): string[] => {
  const found: string[] = []
  for (let start = html.indexOf('class="shimmer-text'); start >= 0; start = html.indexOf('class="shimmer-text', start + 1)) {
    const open = html.lastIndexOf("<", start)
    const tag = /^<(\w+)/.exec(html.slice(open))![1]!
    let depth = 0
    let index = open
    do {
      const next = html.slice(index).search(new RegExp(`<(/?)${tag}[\\s>]`))
      if (next < 0) break
      index += next
      depth += html[index + 1] === "/" ? -1 : 1
      index += 1
    } while (depth > 0)
    found.push(html.slice(open, html.indexOf(">", index) + 1).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
  }
  return found
}
/** The live step's own markup, from its element to the end of the turn. */
const liveStepOf = (html: string): string => html.slice(html.indexOf("data-live-step"))
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
  assert.deepEqual(sweeps(html), ["Running npm test"], "the running call's verb and what it runs sweep as one")
  assert.doesNotMatch(liveStepOf(html), /activity-orb|activity-mark|<canvas| running</, "the sweep is the row's only running signal: no mark at its end, no count")
  assert.doesNotMatch(html, /class="[^"]*(changing-label|animate-)[^"]*shimmer-text|class="[^"]*shimmer-text[^"]*(changing-label|animate-)/, "nothing else animates a sweeping element, so nothing replaces its sweep")
  assert.match(html, /data-work-summary[^>]*>[^]*Made an edit, read a file and searched once/, "what finished reads as today's summary")
  assert.equal(html.match(/data-transcript-tool=/g)?.length, 1, "the finished rows stay unmounted until the list opens")
  assert.match(liveStepOf(html), /data-transcript-tool="[^"]*test"[^>]*>[^]*data-pending="true"/, "the running call is the transcript's own row for it, so nothing is swapped when it returns")
  assert.match(html, /data-turn-clock/, "the turn's head carries its clock")
  // One column: the summary's single glyph over the rows' glyphs, nothing hung on a rail, no chevron at a row's end.
  const summary = /<button[^>]*data-work-summary[^]*?<\/button>/.exec(html)![0]
  assert.equal(summary.match(/<svg/g)?.length, 2, "the summary has one glyph, and the chevron that takes its place under the pointer")
  assert.ok(summary.indexOf("lucide-chevron-right") < summary.indexOf("Made an edit"), "its chevron is in the glyph's column, not after its words")
  assert.match(summary, /lucide-layers/, "steps of several kinds read as a stack of steps")
  assert.doesNotMatch(html, /data-work-log[^>]*border-l/, "the steps are not indented on a rail")
}

// Between steps, the live row says "Working" with the ellipsis, the one mark for work in progress; no heartbeat.
{
  const waiting = draw(exchangesOf([go, tool("read", "Read", { file_path: "/p/src/guard.ts" })], true).at(-1)!, { streaming: true })
  assert.deepEqual(sweeps(liveStepOf(waiting)), ["Working"])
  assert.match(liveStepOf(waiting), /lucide-ellipsis/)
  assert.doesNotMatch(waiting, /lucide-activity|activity-meter/, "no heartbeat, no meter")
}

// Calls the model made at once each have a row that sweeps; one that returns first settles in its place.
{
  const before = [
    go,
    text("plan", "Running the suite while I look for the expiry check."),
    tool("read", "Read", { file_path: "/p/src/guard.ts" }, "completed", { at: at(5), endedAt: at(6) }),
  ]
  const suite = tool("suite", "Bash", { command: "npm test -- src/router" }, "in_progress", { at: at(10) })
  const grep = tool("grep", "Grep", { pattern: "expiresAt", path: "src" }, "in_progress", { at: at(10.2) })
  const all = draw(exchangesOf([...before, suite, tool("tests", "Read", { file_path: "/p/src/guard.test.ts" }, "in_progress", { at: at(10.1) }), grep], true).at(-1)!, { streaming: true })
  assert.deepEqual(sweeps(all), ["Running npm test -- src/router", "Reading /p/src/guard.test.ts", "Searching expiresAt · src"], "each running call has its own sweeping row, in the order they began")
  assert.equal(all.match(/data-live-step="calls"/g)?.length, 1, "one live step stands for them")
  assert.match(all, /data-work-summary[^>]*>[^]*Read a file/, "the summary holds what finished before them")
  assert.doesNotMatch(liveStepOf(all), /guard\.ts</, "and the call before them is not in the step")
  assert.doesNotMatch(all, /Copy answer/, "a running turn offers no whole answer to copy")

  const settling = draw(exchangesOf([...before, suite, tool("tests", "Read", { file_path: "/p/src/guard.test.ts" }, "completed", { at: at(10.1), endedAt: at(12) }), grep], true).at(-1)!, { streaming: true })
  assert.deepEqual(sweeps(settling), ["Running npm test -- src/router", "Searching expiresAt · src"], "the calls still running sweep on")
  const step = liveStepOf(settling)
  assert.ok(step.indexOf("npm test") < step.indexOf("guard.test.ts") && step.indexOf("guard.test.ts") < step.indexOf("expiresAt"), "the finished call keeps its place between them")
  assert.match(step, /data-transcript-tool="[^"]*tests"[^]*Read[^]*guard\.test\.ts/, "drawn as the row the list will show for it")
  assert.match(settling, /data-work-summary[^>]*>[^]*Read a file</, "and not counted in the summary twice")

  const settled = draw(exchangesOf([...before, tool("suite", "Bash", { command: "npm test -- src/router" }, "completed", { at: at(10), endedAt: at(40) }), tool("tests", "Read", { file_path: "/p/src/guard.test.ts" }, "completed", { at: at(10.1), endedAt: at(12) }), tool("grep", "Grep", { pattern: "expiresAt", path: "src" }, "completed", { at: at(10.2), endedAt: at(11) }), text("done", "The suite passes.")], false).at(-1)!)
  assert.deepEqual(sweeps(settled), [], "a finished turn never sweeps")
  assert.doesNotMatch(settled, /data-live-step/)
  assert.match(settled, /Copy answer/, "and its answer can be copied whole")
}

// Only a running turn's calls sweep: a call a finished record left without a result keeps its settled words.
{
  const [call] = pairTools(exchangesOf([go, tool("hung", "Bash", { command: "npm run dev" }, "in_progress")], true).at(-1)!.response.flatMap((message) => message.blocks))
  assert.ok(call?.pending)
  assert.deepEqual(sweeps(renderToStaticMarkup(<TurnRunningContext value={true}><ToolRow call={call} /></TurnRunningContext>)), ["Running npm run dev"])
  const still = renderToStaticMarkup(<ToolRow call={call} />)
  assert.deepEqual(sweeps(still), [], "outside a running turn it does not sweep")
  assert.match(still, /<span class="min-w-0 truncate text-muted-foreground"><span>npm run dev<\/span><\/span>/, "and reads as its settled row: a command is its own words")
  assert.doesNotMatch(still, />Shell</, "not \"Shell npm run dev\"")
  assert.doesNotMatch(still, /font-mono/, "in the row's one face; the command reads in code when the row opens")
  assert.doesNotMatch(still, /activity-mark|Running/, "with no running mark")
}

// A row reads a path from the conversation's folder; a path elsewhere, or the folder alone, stays whole.
assert.equal(relativeTo("/work/app", "/work/app/src/guard.ts"), "src/guard.ts")
assert.equal(relativeTo("/work/app/", "/work/app/a.ts → /work/app/b.ts"), "a.ts → b.ts")
assert.equal(relativeTo("/work/app", "returnTo · /work/app/src"), "returnTo · src")
assert.equal(relativeTo("/work/app", "/other/work/app/x"), "/other/work/app/x", "only where a path begins")
assert.equal(relativeTo("/work/a.p", "/work/axp/q"), "/work/axp/q", "the folder is matched as written")
assert.equal(relativeTo("/work/app", "/work/app"), "/work/app")
assert.equal(relativeTo(undefined, "/work/app/x"), "/work/app/x")

// An agent is named by what it was asked to do from its first characters, while the model still writes its call.
{
  const full = JSON.stringify({ description: "Map every protected route", prompt: "Read \"every\" route", subagent_type: "Explore", n: 12, ok: true, list: [1, { a: "b" }] })
  assert.deepEqual(argumentsSoFar(full), JSON.parse(full), "a whole input reads whole")
  assert.deepEqual(argumentsSoFar(full.slice(0, full.indexOf("Read") + 8)), { description: "Map every protected route", prompt: "Read \"e" }, "a string cut mid-way keeps what it has")
  assert.deepEqual(argumentsSoFar(full.slice(0, full.indexOf("Read") + 6)), { description: "Map every protected route", prompt: "Read " }, "and drops half an escape")
  assert.deepEqual(argumentsSoFar(full.slice(0, full.indexOf("prompt") + 4)), { description: "Map every protected route" }, "a key with no value yet is left out")
  assert.deepEqual(argumentsSoFar(full.slice(0, full.indexOf("12") + 1)), { description: "Map every protected route", prompt: "Read \"every\" route", subagent_type: "Explore", n: 1 })
  assert.equal(argumentsSoFar("npm test"), undefined, "input that isn't an object names nothing")
  const writing = { type: "tool" as const, id: "agent-1", name: "Agent", status: "pending", input: full.slice(0, 50) }
  assert.equal(entryToolIdentity(writing, "claude").target, "Map every protected route", "a running agent whose input is still arriving is named")
  assert.equal(entryToolIdentity({ ...writing, status: "completed" }, "claude").target, undefined, "a finished call is read from its whole input only")
}

// An agent's glyph is its harness's mark, never a robot, in the group and on each agent's row.
{
  const running = exchangesOf([
    go,
    tool("a1", "Agent", { description: "Map routes", prompt: "x", subagent_type: "Explore" }, "in_progress", { at: at(1) }),
    tool("a2", "Agent", { description: "Trace refresh", prompt: "x", subagent_type: "Explore" }, "in_progress", { at: at(1) }),
    tool("a3", "Agent", { description: "Find tests", prompt: "x", subagent_type: "Explore" }, "completed", { at: at(1), endedAt: at(20) }),
  ], true).at(-1)!
  const calls = running.response.flatMap((message) => pairTools(message.blocks))
  const group = renderToStaticMarkup(
    <HarnessContext value="claude"><TurnRunningContext value={true}><AgentGroup calls={calls} /></TurnRunningContext></HarnessContext>
  )
  assert.deepEqual(sweeps(group), ["Running 3 agents"], "while they run, the title sweeps and says so")
  assert.match(group, /1 done/)
  assert.doesNotMatch(group, /\d working/, "\"working\" is the title's word, not a count beside it")
  assert.doesNotMatch(group, /lucide-bot|activity-mark|activity-orb|<canvas/, "the harness's mark, no robot, no mark at the end")
  const settled = renderToStaticMarkup(<HarnessContext value="claude"><AgentGroup calls={calls.map((call) => ({ ...call, pending: false }))} /></HarnessContext>)
  assert.deepEqual(sweeps(settled), [])
  const row = renderToStaticMarkup(<HarnessContext value="claude"><TurnRunningContext value={true}><ToolRow call={calls[0]!} /></TurnRunningContext></HarnessContext>)
  assert.deepEqual(sweeps(row), ["Map routes"], "a running agent's row is what it was asked to do, swept")
  assert.doesNotMatch(row, /lucide-bot|>Agent</)
  assert.match(renderToStaticMarkup(<ToolRow call={calls[0]!} />), /lucide-bot/, "with no harness known, the agent glyph")
  assert.match(draw(running, { streaming: true }), /data-agent-group="3"/, "the live step is the group")
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

console.log("Turn presentation: one column of work, one live row per running call under one sweep, a call settling in place, the ellipsis for working, paths from the folder, agents named while they run with their harness's mark, no sweep once finished, a settled fold that keeps its answer and boundaries, stop words")
