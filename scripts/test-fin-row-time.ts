import assert from "node:assert/strict"
import { childEntry, childState, type ChildJournal, type ChildThread, type Report, type ThreadParent } from "../packages/host/src/contracts/agents"
import { childLine } from "../packages/host/src/contracts/children"
import { SessionIdSchema, ThreadIdSchema } from "../packages/host/src/contracts/thread-identity"
import { lastStep } from "../packages/host/src/conversations/agent-runs"

/*
 * What a crew row says about a Fin. Its time is how long it has stood as it stands, from `since`: a working Fin's
 * current turn, not its age; one waiting on its own Fins from when its turn ended; the rest from when they got there;
 * nothing at all when the start isn't known. Its line says what it's doing, always, and "answered" only for an answer
 * to the turn it's on, in plain words.
 */

const HOUR = 3_600_000
const NOW = 1_800_000_000_000
const SPAWNED = NOW - 80 * HOUR
const TURN = NOW - 3 * 60_000

const apexSession = SessionIdSchema.parse("22222222-2222-4222-8222-222222222222")
const edge: ThreadParent = {
  child: ThreadIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  parent: ThreadIdSchema.parse("33333333-3333-4333-8333-333333333333"),
  parentSession: apexSession,
  name: "fin",
  role: "worker",
  origin: "started",
  asked: { brief: { objective: "Do the thing" }, harness: "claude" },
  op: "start:fin",
  startedBy: { kind: "agent", session: apexSession },
  createdAt: SPAWNED,
}
const thread = (fields: Partial<ChildThread>): ChildThread => ({ source: "live", startedAt: SPAWNED, ...fields })
const since = (fields: Partial<ChildThread>, journal: ChildJournal = {}) => childEntry(edge, thread(fields), journal).since
// SAFETY: a report with the fields `childState` reads.
const report = (fields: Partial<Report>) => ({ id: "report-1", at: NOW - HOUR, summary: "On it.", status: "progress", ...fields }) as Report

// A working Fin's time is its turn's, however old the Fin.
assert.equal(since({ working: true, workSince: TURN, step: "Reading a.ts" }), TURN, "a working row counts its turn")
assert.equal(since({ working: true }), undefined, "a working row with no known turn says no time, rather than the Fin's age")
// One waiting on its own Fins isn't working: it counts from when its turn ended.
assert.equal(since({ working: true, awaiting: "device-fins", workSince: NOW - HOUR, step: "Waiting for device-fins" }), NOW - HOUR)
// A process Mako follows has one long turn: the run.
assert.equal(since({ source: "followed", working: true, startedAt: NOW - 2 * HOUR }), NOW - 2 * HOUR)
// The rest stand from when they got there.
assert.equal(since({ updatedAt: NOW - 2 * HOUR }), NOW - 2 * HOUR, "idle, from its last activity")
assert.equal(since({ updatedAt: NOW - 2 * HOUR }, { latest: report({ status: "progress", waitingOn: [{ kind: "other", text: "the review" }], at: NOW - HOUR }) }), NOW - HOUR, "waiting on something outside, from its report")
assert.equal(since({ updatedAt: NOW }, { latest: report({ status: "needs-input", question: "Which?", at: NOW - HOUR }) }), NOW - HOUR, "asking, from the ask")
assert.equal(since({ updatedAt: NOW, waiting: { question: "Allow?", on: "approval" } }), NOW, "an approval, from when it came up")
assert.equal(since({ ended: { outcome: "done", at: NOW - HOUR } }), NOW - HOUR, "finished, from the end")
assert.equal(since({ queued: { reason: "tree-running", ahead: 1 } }), SPAWNED, "queued, from its start")
assert.equal(since({ starting: "booting" }), SPAWNED, "starting, from its start")
assert.equal(since({ starting: "booting", updatedAt: NOW - HOUR }), NOW - HOUR, "starting again, from what it last did, not its age")
assert.equal(since({ queued: { reason: "tree-running", ahead: 1 }, updatedAt: NOW - HOUR }), NOW - HOUR, "queued again likewise")

// "Answered" says an answer, in plain words, while the Fin works on it.
const asked = report({ status: "needs-input", question: "Which?", at: TURN - 1_000 })
const answered = (fields: Partial<NonNullable<ChildJournal["answered"]>>): ChildJournal => ({ latest: asked, answered: { by: "lead", answer: "Clone in spares only.", ask: "report-1", at: TURN, delivered: true, ...fields } })
const line = (journal: ChildJournal, fields: Partial<ChildThread> = {}) => childLine(childState(edge, thread({ working: true, workSince: TURN, step: "Reading a.ts", ...fields }), journal))
assert.equal(line(answered({})), "Apex answered: Clone in spares only.", "an answer, on the turn it began")
assert.equal(line(answered({ by: "person" })), "You answered: Clone in spares only.")
assert.equal(line(answered({ answer: "[mako · from your Apex (agent), not the person]\nClone in spares only." })), "Apex answered: Clone in spares only.", "the wrapper never reaches a line, kept rows included")
assert.equal(line(answered({ routine: true })), "Reading a.ts", "a plain message from its Apex is its next job, not an answer")
assert.equal(line(answered({ by: "person", routine: true })), "You answered: Clone in spares only.", "the person's own message is theirs to have said")
assert.equal(line(answered({ at: TURN - HOUR })), "Reading a.ts", "a later turn has moved on from it")
assert.equal(line(answered({ answer: "[mako · from your Apex (agent), not the person]\n" })), "Reading a.ts", "nothing left to say, nothing said")

// A row always says what it's doing.
assert.equal(childLine({ kind: "working" }), "At work", "with nothing known, it still says so")
const justAsked: Parameters<typeof lastStep>[0] = [{ type: "user", text: "Go" }]
assert.equal(lastStep(justAsked, "claude"), "Thinking", "a turn that's only begun is thinking")

console.log("Fin rows: a turn's time, a state's time, plain answers and a line on every row")
