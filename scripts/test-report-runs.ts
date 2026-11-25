import assert from "node:assert/strict"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { FROM_AGENTS } from "@mako/host/contracts/children"
import { appendFinReports, type FinReportCard } from "@mako/host/contracts/fin-reports"
import { entriesToMessages } from "../src/lib/entry-messages"
import { promptLabel, toExchanges, type Exchange } from "../src/lib/exchanges"
import { runPhrase } from "../src/lib/fin-report-words"
import { foldReportRuns, REMARK_CHARS, reportTurn } from "../src/lib/report-runs"

/**
 * A run of an Apex's turns that its Fins' reports woke reads as one row (`foldReportRuns`): only turns whose prompt
 * is Mako's digest and whose answer is a remark, never the person's own turn or an answer they'd read; counted with
 * what needs the person first (`runPhrase`); the transcript's newest turn standing until something follows it; and
 * the same objects from one frame to the next.
 */

const card = (name: string, status: FinReportCard["status"], more: Partial<FinReportCard> = {}): FinReportCard => ({ report: `report:${name}:${status}`, fin: `thread-${name}`, name, status, line: `${name} said so.`, ...more })
const digest = (...cards: FinReportCard[]) => appendFinReports([FROM_AGENTS, `${cards.length} reported.`].join("\n"), cards)
const person = (id: string, words: string): LiveUpdate => ({ kind: "user", text: words, requestId: id })
const wake = (id: string, ...cards: FinReportCard[]): LiveUpdate => ({ kind: "user", text: digest(...cards), requestId: id })
const text = (id: string, words: string): LiveUpdate => ({ kind: "text", id, text: words })
const tool = (id: string, status = "completed"): LiveUpdate => ({ kind: "tool", id, title: "Bash", name: "Bash", status, input: JSON.stringify({ command: "npm test" }), ...(status !== "pending" && { output: "ran" }) })
const exchangesOf = (updates: LiveUpdate[]) =>
  toExchanges(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running: false, provider: "claude" }).messages)
const none = () => false
const drawnRows = (exchanges: readonly Exchange[]) => exchanges.map((exchange) => (exchange.run ? exchange.run.turns.length : exchange.prompt ? "turn" : "other"))

const asks = card("Push wording", "needs-input", { forPerson: true })
const afternoon: LiveUpdate[] = [
  person("p1", "Split the list into Threads."), text("a1", "Twelve pieces."),
  wake("w1", card("Haptics", "done"), card("Share sheet", "done")), tool("t1"), text("a2", "Both are in."),
  wake("w2", card("Outbox", "failed")), text("a3", "Outbox failed; sent back."),
  wake("w3", asks, card("Swipe", "done")), text("a4", "The tone is yours to pick."),
  person("p2", "How are the queued ones doing?"), text("a5", "Two wait on the tree."),
]

// Three wakes between two of the person's messages are one row; the person's own turns stand either side of it.
{
  const exchanges = exchangesOf(afternoon)
  assert.deepEqual(drawnRows(exchanges), ["turn", "turn", "turn", "turn", "turn"])
  const folded = foldReportRuns(exchanges, none)
  assert.deepEqual(drawnRows(folded), ["turn", 3, "turn"])
  const run = folded[1]!
  assert.equal(run.id, exchanges[1]!.id, "the row goes by its first turn's id")
  assert.deepEqual(run.run!.cards.map((each) => each.name), ["Haptics", "Share sheet", "Outbox", "Push wording", "Swipe"], "every report is in the row, in order")
  assert.deepEqual(run.run!.turns, exchanges.slice(1, 4), "and every turn, as it was")
  // What needs the person first, then what went wrong, then the rest, each Fin once.
  assert.equal(runPhrase(run.run!.cards, (each) => each.report === asks.report), "1 Fin needs you · 1 failed · 3 finished")
  // Where nothing says a question is still open, it was asked.
  assert.equal(run.run!.label, "1 Fin failed · 1 asked · 3 finished")
  assert.equal(promptLabel(run), run.run!.label, "the navigator calls the row what it says")

  // The same turns fold to the same objects: a frame that changes nothing draws nothing.
  const again = foldReportRuns(exchanges.slice(), none, folded)
  assert.equal(again[1], run, "an unchanged run is the same object")
  // A stream below changes the last turn alone; the run above it is still the same object.
  const last = exchanges.at(-1)!
  const streamed = [...exchanges.slice(0, -1), { ...last, response: [...last.response, last.response.at(-1)!] }]
  assert.equal(foldReportRuns(streamed, none, folded)[1], run)

  // The turn that streams, or was stopped or failed, stands as itself, and one turn is no run.
  assert.deepEqual(drawnRows(foldReportRuns(exchanges, (exchange) => exchange.id === exchanges[3]!.id)), ["turn", 2, "turn", "turn"])
  assert.deepEqual(drawnRows(foldReportRuns(exchanges, (exchange) => exchange.id === exchanges[2]!.id)), ["turn", "turn", "turn", "turn", "turn"])
  assert.equal(foldReportRuns(exchanges, (exchange) => exchange.id === exchanges[2]!.id), exchanges, "with no run the list is the one given")

  // Earlier history arriving above a run leaves its id as it was while its first turn is still in it.
  const earlier = exchangesOf([wake("w0", card("Dictation", "done")), text("a0", "Dictation is in."), ...afternoon.slice(2)])
  const paged = foldReportRuns(earlier, none, folded)
  assert.deepEqual(drawnRows(paged), [4, "turn"])
  assert.equal(paged[0]!.id, run.id, "a run that grew upward keeps its id")
}

// The newest turn of the transcript stands while nothing follows it, so what the Apex last said is read as a turn. It
// joins the run above it once it's no longer the last, and that run is the row it was: its id, so its open fold.
{
  const wakes = [
    wake("w1", card("Haptics", "done")), text("a2", "Haptics is in."),
    wake("w2", card("Outbox", "failed")), text("a3", "Outbox failed; sent back."),
    wake("w3", card("Swipe", "done")), text("a4", "Swipe is in."),
    wake("w4", card("Share sheet", "done")), text("a5", "The share sheet is in."),
  ]
  const upTo = (count: number, ...more: LiveUpdate[]) => exchangesOf([person("p1", "Split the list into Threads."), text("a1", "Twelve pieces."), ...wakes.slice(0, count * 2), ...more])
  // One report turn, and two with the second the newest, are turns: a run is two behind the one that stands.
  for (const count of [1, 2]) {
    const exchanges = upTo(count)
    assert.equal(foldReportRuns(exchanges, none), exchanges, `${count}: with no run the list is the one given`)
  }
  const three = upTo(3)
  const folded = foldReportRuns(three, none)
  assert.deepEqual(drawnRows(folded), ["turn", 2, "turn"], "two fold, and the newest stands under them")
  assert.equal(folded[2], three[3], "as the turn it is")
  const run = folded[1]!
  assert.deepEqual(run.run!.cards.map((each) => each.name), ["Haptics", "Outbox"], "the row counts what's in it, not the turn that stands")
  // A frame that changes nothing, or streams into the newest turn, keeps the run the same object.
  assert.equal(foldReportRuns(three.slice(), none, folded)[1], run)
  const streaming = [...three.slice(0, -1), { ...three[3]!, response: [...three[3]!.response, three[3]!.response.at(-1)!] }]
  assert.equal(foldReportRuns(streaming, (exchange) => exchange.id === three[3]!.id, folded)[1], run)
  // Another report turn follows: the one that stood joins the run, and the new one stands.
  const four = upTo(4)
  const grown = foldReportRuns(four, none, folded)
  assert.deepEqual(drawnRows(grown), ["turn", 3, "turn"])
  assert.equal(grown[1]!.id, run.id, "the run it joined is the same row: its id, and so its fold, as they were")
  assert.deepEqual(grown[1]!.run!.turns.slice(0, 2), run.run!.turns, "its turns the same objects, the joined one after them")
  assert.equal(grown[2], four[4])
  // The person writes: every report turn is behind their message now, so all of them are the run.
  const asked = upTo(4, person("p2", "How are the queued ones doing?"))
  const behind = foldReportRuns(asked, none, grown)
  assert.deepEqual(drawnRows(behind), ["turn", 4, "turn"])
  assert.equal(behind[1]!.id, run.id)
  // Two report turns and then the person's message: the run forms only now, by its first turn's id.
  const late = upTo(2, person("p2", "How are the queued ones doing?"))
  assert.deepEqual(drawnRows(foldReportRuns(late, none, foldReportRuns(upTo(2), none))), ["turn", 2, "turn"])
}

// An answer the person would read is never folded, whatever woke it: long words, or anything but words and calls.
{
  const long = "The sheet and the chips both measured the inset. ".repeat(8)
  assert.ok(long.length > REMARK_CHARS)
  const exchanges = exchangesOf([
    person("p1", "Go."), text("a1", "Started."),
    wake("w1", card("Haptics", "done")), text("a2", "In."),
    wake("w2", card("Dictation", "done")), text("a3", long),
    wake("w3", card("Swipe", "done")), text("a4", "In."),
    wake("w4", card("Outbox", "done")), tool("t4", "failed"), text("a5", "In."),
  ])
  assert.deepEqual(exchanges.map((exchange) => reportTurn(exchange) !== undefined), [false, true, false, true, false])
  assert.deepEqual(drawnRows(foldReportRuns(exchanges, none)), ["turn", "turn", "turn", "turn", "turn"], "a long answer or a failed call parts the run")
  // The person's own words are theirs even when they quote a digest's header after their first line.
  const quoted = exchangesOf([person("p1", `Why did I get this?\n${digest(card("Haptics", "done"))}`), text("a1", "It's a report.")])
  assert.equal(reportTurn(quoted[0]!), undefined)
}

// The words: each Fin once a phrase, the first phrase carrying the noun, a decision the person's while it waits.
{
  const decision = card("Pull to refresh", "done", { decides: "person" })
  assert.equal(runPhrase([card("A", "done"), card("A", "done", { report: "again" }), card("B", "done")]), "2 Fins finished")
  assert.equal(runPhrase([card("A", "progress"), card("B", "failed", { unfinished: true })]), "1 Fin ended without a result · 1 reported")
  assert.equal(runPhrase([decision, card("B", "done")], (each) => each.report === decision.report), "1 Fin needs you · 1 finished")
  assert.equal(runPhrase([decision, card("B", "done")]), "2 Fins finished")
  assert.equal(runPhrase([card("Docs", "done", { apex: true }), card("B", "needs-input")]), "1 Fin asked · 1 Thread replied")
}

console.log("report runs: a run of wakes is one row, the person's turns, real answers and the newest turn stand, and its words count what needs them first")
