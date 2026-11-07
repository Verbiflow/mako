import assert from "node:assert/strict"
import { childEntry, childState, turnFailedAt, type ChildJournal, type ChildThread, type Report, type ThreadParent } from "../packages/host/src/contracts/agents"
import { childLine, childTime, stoodFor } from "../packages/host/src/contracts/children"
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
assert.equal(turnFailedAt({ createdAt: NOW - HOUR, dispatchedAt: NOW - HOUR }, NOW, SPAWNED), NOW, "a turn that failed just now, whenever it began")
assert.equal(turnFailedAt({ createdAt: NOW - HOUR, dispatchedAt: NOW - 1_000 }, NOW - HOUR, SPAWNED), NOW - 1_000, "one that failed on sending, when it was sent, however long it waited")
assert.equal(turnFailedAt({ createdAt: NOW - HOUR }, undefined, SPAWNED), NOW - HOUR, "with nothing later, the last that's known")
assert.equal(turnFailedAt({}, undefined, SPAWNED), SPAWNED, "and with nothing at all, its start")
assert.equal(since({ queued: { reason: "tree-running", ahead: 1 } }), SPAWNED, "queued, from its start")
assert.equal(since({ starting: "booting" }), SPAWNED, "starting, from its start")
assert.equal(since({ starting: "booting", updatedAt: NOW - HOUR }), NOW - HOUR, "starting again, from what it last did, not its age")
assert.equal(since({ queued: { reason: "tree-running", ahead: 1 }, updatedAt: NOW - HOUR }), NOW - HOUR, "queued again likewise")

// "Answered" says an answer, in plain words, while the Fin works on it.
const asked = report({ status: "needs-input", question: "Which?", at: TURN - 1_000 })
const answered = (fields: Partial<NonNullable<ChildJournal["answered"]>>): ChildJournal => ({ latest: asked, answered: { by: "lead", answer: "Clone in spares only.", ask: "report-1", request: "answer-request", at: TURN, delivered: true, ...fields } })
const line = (journal: ChildJournal, fields: Partial<ChildThread> = {}) => childLine(childState(edge, thread({ working: true, workSince: TURN, workInputs: ["answer-request"], step: "Reading a.ts", ...fields }), journal))
assert.equal(line(answered({})), "Apex answered: Clone in spares only.", "an answer, on the turn it began")
assert.equal(line(answered({ by: "person" })), "You answered: Clone in spares only.")
assert.equal(line(answered({ answer: "[mako · from your Apex (agent), not the person]\nClone in spares only." })), "Apex answered: Clone in spares only.", "the wrapper never reaches a line, kept rows included")
assert.equal(line(answered({ routine: true })), "Reading a.ts", "a plain message from its Apex is its next job, not an answer")
assert.equal(line(answered({ by: "person", routine: true })), "You answered: Clone in spares only.", "the person's own message is theirs to have said")
// Which turn took it says, never how near in time: not the turn after it, however soon, and a queued one whenever it goes.
assert.equal(line(answered({}), { workInputs: ["the-next-job"] }), "Reading a.ts", "a later turn has moved on from it")
assert.equal(line(answered({ at: TURN - 2_000 }), { workInputs: ["the-next-job"] }), "Reading a.ts", "however soon after the answer it began")
assert.equal(line(answered({ at: TURN - HOUR })), "Apex answered: Clone in spares only.", "an answer that waited in the queue, on the turn that took it")
assert.equal(line(answered({}), { workInputs: ["the-running-turn", "answer-request"] }), "Apex answered: Clone in spares only.", "and one steered into a running turn")
assert.equal(line(answered({ at: TURN - 2_000 }), { source: "followed", workInputs: undefined }), "Reading a.ts", "a process has no requests to tell by: an answer from before its turn isn't its")
assert.equal(line(answered({ answer: "[mako · from your Apex (agent), not the person]\n" })), "Reading a.ts", "nothing left to say, nothing said")

// A row always says what it's doing.
assert.equal(childLine({ kind: "working" }), "At work", "with nothing known, it still says so")
const justAsked: Parameters<typeof lastStep>[0] = [{ type: "user", text: "Go" }]
assert.equal(lastStep(justAsked, "claude"), "Thinking", "a turn that's only begun is thinking")

// A time says what it means: where the number alone would read as how long it ran, and in a sentence on every row.
assert.equal(stoodFor(22 * 60_000), "22m")
assert.equal(stoodFor(5 * HOUR + 7 * 60_000), "5h 7m")
assert.equal(stoodFor(80 * HOUR), "3 d", "past a day an hour count is hard to read")
assert.equal(stoodFor(500), "", "under a second, nothing")
const word = (state: Parameters<typeof childTime>[0], ms = 3 * HOUR) => childTime(state, ms)
assert.deepEqual(word({ kind: "working", step: "Reading a.ts" }, 22 * 60_000), { time: "22m", title: "On this turn for 22m" })
assert.deepEqual(word({ kind: "working", step: "Waiting for its Fin device-fins" }), { time: "3h", title: "Waiting for 3h" })
assert.deepEqual(word({ kind: "starting", step: "booting" }, 24_000), { time: "24s", title: "Starting for 24s" })
assert.deepEqual(word({ kind: "queued", reason: "tree-running", ahead: 1 }), { time: "3h", title: "Queued for 3h" })
assert.deepEqual(word({ kind: "blocked", question: "Which?", on: "person" }, 14 * 60_000), { time: "14m", title: "Asked 14m ago" })
assert.deepEqual(word({ kind: "idle" }), { time: "3h", title: "Idle for 3h" })
assert.deepEqual(word({ kind: "idle", waitingOn: [{ kind: "other", text: "the review" }], since: 1 }), { time: "3h", title: "Waiting for 3h" })
assert.deepEqual(word({ kind: "ended", outcome: "done" }), { time: "3h ago", title: "Finished 3h ago" }, "a finished row's number doesn't read as how long it took")
assert.deepEqual(word({ kind: "ended", outcome: "failed" }, 80 * HOUR), { time: "3 d ago", title: "Failed 3 d ago" })
assert.deepEqual(word({ kind: "ended", outcome: "stopped" }), { time: "3h ago", title: "Stopped 3h ago" })
assert.equal(word({ kind: "idle" }, 200).time, "", "no time to say, no words")

console.log("Fin rows: a turn's time, a state's time, plain answers and a line on every row")
