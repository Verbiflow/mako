import assert from "node:assert/strict"
import { compactionEvent } from "@mako/sessions/events"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { entriesToMessages } from "../src/lib/entry-messages"
import { arrivedSince, endOf, responseSections, toExchanges } from "../src/lib/exchanges"
import { turnRows, type FoldRow, type TurnEntry, type TurnRow } from "../src/lib/turn-rows"
import { bodyIsResult, pairTools, summarizeToolWork, toolOpens } from "../src/lib/tools"
import { workHeadline } from "../src/lib/work-headline"

/**
 * A turn's rows (`turnRows`): everything between two messages behind one line worded from its parts, what needs
 * someone left out of it, and a running turn's work left as it is.
 */

const at = (seconds: number) => Date.parse("2026-11-17T10:00:00.000Z") + seconds * 1000
const go: LiveUpdate = { kind: "user", text: "Fix the redirect", at: at(0) }
const tool = (id: string, name: string, input: Record<string, string>, status = "completed", when = 10): LiveUpdate => ({ kind: "tool", id, title: name, name, status, input: JSON.stringify(input), at: at(when), ...(status === "completed" && { endedAt: at(when + 1) }) })
const text = (id: string, words: string): LiveUpdate => ({ kind: "text", id, text: words })
const exchangeOf = (updates: LiveUpdate[], running = false) =>
  toExchanges(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running, provider: "claude" }).messages).at(-1)!
const sectionsOf = (updates: LiveUpdate[], running = false) => {
  const exchange = exchangeOf(updates, running)
  return { sections: responseSections(exchange.response, exchange.system), began: exchange.prompt?.timestamp }
}
const folds = (rows: readonly TurnRow[]) => rows.filter((row): row is FoldRow => row.kind === "fold")
const kinds = (rows: readonly TurnRow[]) => rows.map((row) => (row.kind === "message" && row.entry.kind === "section" ? row.entry.section.kind : row.kind))
const card = (name: string, status: FinReportCard["status"], more: Partial<FinReportCard> = {}): FinReportCard => ({ report: `report:${name}`, fin: `thread-${name}`, name, status, line: `${name} said so.`, ...more })
function report(each: FinReportCard, open = false): TurnEntry {
  return { kind: "report", id: each.report, card: each, open }
}

// A plain turn: its work and the words on the way fold behind one line, the answer stays a message.
{
  const turn = sectionsOf([go, tool("read", "Read", { file_path: "/p/a.ts" }), text("interim", "Looking."), tool("test", "Bash", { command: "npm test" }, "completed", 30), text("answer", "Fixed.")])
  const rows = turnRows(turn)
  assert.deepEqual(kinds(rows), ["fold", "prose"])
  const [fold] = folds(rows)
  assert.match(fold!.title ?? "", /^Worked for \d+s$/)
  assert.deepEqual(fold!.parts.map((part) => part.kind), ["worked"])
  assert.equal(fold!.members.length, 3, "the interim words fold with the work")
  assert.equal(fold!.needs, false)
  assert.equal(fold!.work.tools, 2)
  assert.deepEqual(kinds(turnRows(sectionsOf([go, text("only", "Just words.")]))), ["prose"], "a turn of words alone has nothing to fold")
  assert.match(folds(turnRows({ ...turn, stop: "chosen" }))[0]!.title ?? "", /^Stopped after \d+s$/)
  assert.match(folds(turnRows({ ...turn, stop: "cut" }))[0]!.title ?? "", /^Interrupted after \d+s$/)
}

// A call that failed and was never put right makes the line stand out; one a later call fixed doesn't.
{
  const failing = sectionsOf([go, tool("lint", "Bash", { command: "npm run lint" }, "failed"), text("answer", "It fails.")])
  assert.equal(folds(turnRows(failing))[0]!.needs, true)
  const fixed = sectionsOf([go, tool("lint", "Bash", { command: "npm run lint" }, "failed"), tool("lint-2", "Bash", { command: "npm run lint" }, "completed", 20), text("answer", "Fixed.")])
  assert.equal(folds(turnRows(fixed))[0]!.needs, false)
}

// An Apex's turn woken by six reports: the one that needs a decision and the one that failed stand as their own
// blocks before the line; the other four are one phrase of it.
{
  const reports = [
    card("Docs pass", "done"), card("Token sweep", "done"), card("Sheet motion", "needs-input", { forPerson: true }),
    card("Haptics audit", "done"), card("Outbox retry", "failed"), card("Deep links", "done"),
  ]
  const turn = sectionsOf([go, tool("list", "Bash", { command: "gh pr list" }), text("answer", "Four finished; Sheet motion asks you.")])
  const rows = turnRows({ ...turn, opening: reports.map((each) => report(each)) })
  assert.deepEqual(kinds(rows), ["report", "report", "fold", "prose"])
  assert.deepEqual(rows.flatMap((row) => (row.kind === "report" ? [row.entry.card.name] : [])), ["Sheet motion", "Outbox retry"])
  const [fold] = folds(rows)
  assert.match(fold!.title ?? "", /^4 Fins finished · worked for \d+s$/)
  assert.equal(fold!.members.filter((entry) => entry.kind === "report").length, 4, "every folded report is a member, one click away")
  assert.equal(fold!.members.length, 5)
  assert.deepEqual(fold!.kept, [])
  // One report alone is named; an end without a result is never folded; a decision the roster still holds open isn't either.
  assert.match(folds(turnRows({ ...turn, opening: [report(card("fin:auth", "done"))] }))[0]!.title ?? "", /^fin:auth finished · worked for \d+s$/)
  assert.deepEqual(kinds(turnRows({ ...turn, opening: [report(card("fin:auth", "failed", { unfinished: true }))] })), ["report", "fold", "prose"])
  assert.deepEqual(kinds(turnRows({ ...turn, opening: [report(card("fin:auth", "done", { decides: "lead" }), true)] })), ["report", "fold", "prose"])
  assert.deepEqual(kinds(turnRows({ ...turn, opening: [report(card("fin:auth", "done", { decides: "lead" }), false)] })), ["fold", "prose"], "answered, it folds")
  assert.match(folds(turnRows({ ...turn, opening: [report(card("a", "done")), report(card("b", "progress"))] }))[0]!.title ?? "", /^2 Fins reported · worked for \d+s$/)
  // Reports with no work behind them still fold: the line saves their rows.
  const quiet = turnRows({ sections: sectionsOf([go, text("answer", "Noted.")]).sections, opening: reports.map((each) => report(each)) })
  assert.deepEqual(kinds(quiet), ["report", "report", "fold", "prose"])
  assert.equal(folds(quiet)[0]!.title, "4 Fins finished")
}

// Notices, a provider's own turn and a compaction are phrases of the line; a failure and a stop stay in view.
{
  const turn = sectionsOf([
    go,
    tool("read", "Read", { file_path: "/p/a.ts" }),
    { kind: "event", ...compactionEvent({ trigger: "automatic", tokensBefore: 182_000, tokensAfter: 24_000 }) },
    { kind: "event", label: "Hook", detail: "formatted 2 files" },
    tool("grep", "Grep", { pattern: "x" }, "completed", 30),
    text("answer", "Done."),
  ])
  const rows = turnRows({ ...turn, opening: [{ kind: "line", id: "opener", title: "Command finished" }] })
  assert.deepEqual(kinds(rows), ["fold", "prose"])
  const [fold] = folds(rows)
  assert.match(fold!.title ?? "", /^Command finished · Context compacted · Hook · worked for \d+s$/)
  assert.deepEqual(fold!.kept, [], "a compaction folds: the line says it")
  assert.ok(fold!.members.some((entry) => entry.kind === "section" && entry.section.kind === "note" && entry.section.message.note?.label === "Context compacted"), "and opening the line reaches it")
  assert.equal(fold!.parts.filter((part) => part.kind !== "worked").length, 3, "at most three phrases before the time")
  // Past three phrases the notices are counted.
  const many = turnRows({ ...turn, opening: [{ kind: "line", id: "opener", title: "Command finished" }, report(card("a", "done"))] })
  assert.match(folds(many)[0]!.title ?? "", /^a finished · Command finished · 2 notices · worked for \d+s$/)
  // A line that wants attention, a warning and a stop stay drawn under the closed line.
  const loud = sectionsOf([go, tool("read", "Read", { file_path: "/p/a.ts" }), { kind: "event", label: "Hook failed", detail: "exit 2", tone: "error" }, text("answer", "Done.")])
  const [kept] = folds(turnRows({ ...loud, opening: [{ kind: "line", id: "opener", title: "Agent failed", tone: "error" }] }))
  assert.deepEqual(kept!.kept.map((entry) => entry.kind), ["line", "section"])
  assert.match(kept!.title ?? "", /^Worked for \d+s$/, "what stays in view isn't said twice")
  // With no work, one notice is already one line; two fold.
  const words = sectionsOf([go, text("answer", "ok")])
  const moved: TurnEntry = { kind: "line", id: "a", title: "Model changed" }
  assert.deepEqual(kinds(turnRows({ ...words, opening: [moved] })), ["message", "prose"])
  const two = turnRows({ ...words, opening: [moved, { kind: "line", id: "b", title: "Hook ran" }] })
  assert.deepEqual(kinds(two), ["fold", "prose"])
  assert.equal(folds(two)[0]!.title, "Model changed · Hook ran")
}

// A turn still live: its work stays as it draws, and only the reports that opened it stand behind the line, which
// keeps its id when the turn settles so the same row takes the work in.
{
  const live = sectionsOf([go, tool("read", "Read", { file_path: "/p/a.ts" }), tool("test", "Bash", { command: "npm test" }, "in_progress", 30)], true)
  assert.deepEqual(kinds(turnRows({ ...live, mode: "head" })), ["work"], "a running turn of work alone has no line yet")
  const opening = [report(card("Docs pass", "done")), report(card("Sheet motion", "needs-input", { forPerson: true }))]
  const rows = turnRows({ ...live, opening, mode: "head" })
  assert.deepEqual(kinds(rows), ["report", "fold", "work"])
  const [head] = folds(rows)
  assert.equal(head!.head, true)
  assert.equal(head!.title, "Docs pass finished")
  assert.equal(head!.worked, undefined)
  assert.deepEqual(head!.members.map((entry) => entry.kind), ["report"])
  const settled = folds(turnRows({ ...sectionsOf([go, tool("read", "Read", { file_path: "/p/a.ts" }), text("answer", "Done.")]), opening }))[0]!
  assert.equal(settled.id, head!.id)
  assert.match(settled.title ?? "", /^Docs pass finished · worked for \d+s$/)
}

// A batch's headline is generated from its counts: what failed and stayed failed first, three phrases at most.
{
  const callsOf = (updates: LiveUpdate[]) => exchangeOf([go, ...updates]).response.flatMap((message) => pairTools(message.blocks))
  const reads = Array.from({ length: 12 }, (_, index) => tool(`r${index}`, "Read", { file_path: `/p/${index}.ts` }))
  const plain = workHeadline(summarizeToolWork(callsOf([...reads, tool("g1", "Grep", { pattern: "a" }), tool("g2", "Grep", { pattern: "b" })]), "claude"))
  assert.equal(plain.text, "read 12 files · searched 2 times")
  assert.equal(plain.failed, undefined)
  const failing = callsOf([
    tool("t1", "Bash", { command: "npm test" }, "failed"), tool("t2", "Bash", { command: "npm run lint" }, "failed"),
    tool("e", "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }), ...reads, tool("g", "Grep", { pattern: "a" }), tool("s", "Skill", { skill: "x" }),
  ])
  const headline = workHeadline(summarizeToolWork(failing, "claude"))
  assert.match(headline.failed ?? "", /^2 commands failed/)
  assert.equal(headline.did.length, 2, "with a failure said, two phrases are left")
  assert.match(headline.did[1]!, /more steps$/, "and the kinds past them are counted")
  assert.equal(headline.text.split(" · ").length, 3)
  // A failure a later run of the same command put right is no longer the headline's.
  const fixed = callsOf([tool("t1", "Bash", { command: "npm test" }, "failed"), tool("t2", "Bash", { command: "npm test" }, "completed", 20)])
  assert.equal(workHeadline(summarizeToolWork(fixed, "claude")).failed, undefined)
  // A row opens only onto what its line can't say.
  const [read, grep, bash, edit, failedRead] = callsOf([tool("r", "Read", { file_path: "/p/a.ts" }), tool("g", "Grep", { pattern: "a" }), tool("b", "Bash", { command: "ls" }), tool("e", "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }), tool("r2", "Read", { file_path: "/p/gone.ts" }, "failed")])
  assert.deepEqual([read, grep, bash, edit, failedRead].map((call) => toolOpens(call!)), [false, true, true, true, true], "a read says all it has; a search opens onto what it found")
  assert.deepEqual([read, grep, bash].map((call) => bodyIsResult(call!.tool.kind)), [false, true, false], "and a search's body is its result alone")
}

// A stretch of Mako's own tools alone is worded from what they did, never "used another tool".
{
  const sent = sectionsOf([go, tool("send", "mcp__mako__agents_send", { to: "Sheet motion on iPad", text: "Next." }), text("answer", "Passed on.")])
  const [fold] = folds(turnRows({ sections: sent.sections }))
  assert.match(fold!.did ?? "", /^Messaged /, `a message to a Fin says so: ${fold!.did}`)
  assert.doesNotMatch(fold!.did ?? "", /another tool/)
  const mixed = sectionsOf([go, tool("send", "mcp__mako__agents_send", { to: "a", text: "x" }), tool("r", "Read", { file_path: "/p/a.ts" }), text("answer", "ok")])
  assert.equal(folds(turnRows({ sections: mixed.sections }))[0]!.did, "read a file · used another tool", "mixed work is counted by kind")
}

// "Jump to latest" counts what arrived below a reader who left the end: later turns and what the last turn gained.
{
  const first = exchangeOf([go, text("a", "One.")])
  const left = endOf([first])
  assert.equal(arrivedSince([first], left), 0)
  const grown = { ...first, response: [...first.response, ...first.response] }
  const later = { ...first, id: "later" }
  assert.equal(arrivedSince([grown], left), first.response.length, "messages the turn gained")
  assert.equal(arrivedSince([grown, later, { ...later, id: "last" }], left), first.response.length + 2, "and each later turn")
  assert.equal(arrivedSince([{ ...first, id: "earlier" }, first], left), 0, "a page loaded above counts nothing")
  assert.equal(arrivedSince([later], left), 0, "a turn no longer here counts nothing")
}

console.log("PASS: a turn's rows fold what is between two messages behind one line")
