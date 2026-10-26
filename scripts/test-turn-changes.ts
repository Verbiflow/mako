import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LiveRequest, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { TURN_CHANGES_VERSION, type TurnChanges } from "@mako/host/contracts/turn-changes"
import { LiveJournal, LiveRequestSchema } from "@mako/host/conversations/live-journal"
import { residentOf } from "@mako/host/conversations/live-runtime"
import { LiveTurnChanges, type TurnLedger } from "@mako/host/conversations/live-turn-changes"
import { changeCounts } from "../src/state/thread-changes.ts"
import { recordedTurnChanges, turnChangeSummary, turnChangeWords, UNSURE_LABEL, unsureWords } from "../src/lib/turn-changes.ts"
import { writerLabel } from "../src/lib/turn-writers.ts"
import { undoneWords } from "../src/lib/turn-undone.ts"
import { requestedTurn, type TurnReviewRequest } from "../src/state/review-scope.ts"

// The line's words carry their noun, one file or many.
assert.equal(turnChangeWords(1), "Changed a file")
assert.equal(turnChangeWords(4), "Changed 4 files")
assert.equal(turnChangeWords(1200), "Changed 1,200 files")

// Counts sum over the files that report one; a binary file adds to the files only.
assert.deepEqual(
  turnChangeSummary([
    { insertions: 12, deletions: 9 },
    { insertions: 41, deletions: 3 },
    { insertions: null, deletions: null },
  ]),
  { files: 3, insertions: 53, deletions: 12, unsure: { lines: 0, files: 0 }, settling: false }
)
assert.deepEqual(turnChangeSummary([{ insertions: 5, deletions: null }]), { files: 1, insertions: 5, deletions: null, unsure: { lines: 0, files: 0 }, settling: false })
assert.deepEqual(turnChangeSummary([{ insertions: null, deletions: null }]), { files: 1, insertions: null, deletions: null, unsure: { lines: 0, files: 0 }, settling: false })
assert.deepEqual(turnChangeSummary([]), { files: 0, insertions: null, deletions: null, unsure: { lines: 0, files: 0 }, settling: false })

// A requested turn is the scope only in the repository its checkpoints saved.
const request: TurnReviewRequest = { workspace: "/repo", turn: { kind: "turn", conversation: "c", requestId: "r", prompt: "Fix it" } }
assert.equal(requestedTurn(request, "/repo"), request.turn)
assert.equal(requestedTurn(request, "/other"), null)
assert.equal(requestedTurn(null, "/repo"), null)


// ---------------------------------------------------------------------------
// The line from the request's own record, live and reopened alike.

const summary: TurnChanges = {
  version: TURN_CHANGES_VERSION,
  state: "settled",
  thread: "T1",
  turn: "9b2f6c1e-5d4a-4e3b-8c2d-1a0b9c8d7e6f",
  own: { files: 2, added: 14, removed: 3 },
  maybe: { files: 1, added: 2, removed: 0 },
  others: { files: 0, added: 0, removed: 0 },
  files: [
    { path: "/repo/src/a.ts", root: "r-1", relative: "src/a.ts", kind: "modify", own: { added: 12, removed: 3 }, before: `sha256:${"a".repeat(64)}`, after: `sha256:${"b".repeat(64)}`, entries: { first: 4, last: 9 } },
    { path: "/repo/src/b.ts", root: "r-1", relative: "src/b.ts", kind: "create", own: { added: 2, removed: 0 }, before: null, after: `sha256:${"c".repeat(64)}`, entries: { first: 5, last: 5 } },
    { path: "/repo/notes.md", root: "r-1", relative: "notes.md", kind: "modify", maybe: { added: 2, removed: 0 }, before: `sha256:${"d".repeat(64)}`, after: `sha256:${"e".repeat(64)}`, entries: { first: 7, last: 7 } },
  ],
  more: 0,
  journal: "5f1e2d3c-4b5a-4968-8776-655443322110",
  through: 9,
  at: 1_790_000_000_000,
}
// The agent's own files and lines; what is not sure whose is counted apart.
assert.deepEqual(recordedTurnChanges(summary), { files: 2, insertions: 14, deletions: 3, unsure: { lines: 2, files: 0 }, settling: false })
// Changes › Turn in the turn's repository reads the same as the line under the answer.
assert.deepEqual(recordedTurnChanges(summary, "/repo"), recordedTurnChanges(summary), "one count, the header's and the line's")
// A turn across two repositories: each one's header counts its own files, and the two add up to the line.
const across: TurnChanges = {
  ...summary,
  own: { files: 3, added: 15, removed: 3 },
  files: [...summary.files, { path: "/api/x.ts", root: "r-2", relative: "x.ts", kind: "modify", own: { added: 1, removed: 0 }, maybe: { added: 0, removed: 1 }, before: `sha256:${"f".repeat(64)}`, after: `sha256:${"0".repeat(64)}`, entries: { first: 8, last: 8 } }],
  maybe: { files: 2, added: 2, removed: 1 },
}
assert.deepEqual(recordedTurnChanges(across, "/repo"), { files: 2, insertions: 14, deletions: 3, unsure: { lines: 2, files: 0 }, settling: false })
assert.deepEqual(recordedTurnChanges(across, "/api"), { files: 1, insertions: 1, deletions: 0, unsure: { lines: 1, files: 0 }, settling: false })
assert.equal(recordedTurnChanges({ version: TURN_CHANGES_VERSION, state: "pending" }), undefined, "nothing drawn while the count is on its way")
assert.equal(recordedTurnChanges(undefined), undefined, "a turn from before the record falls back to its checkpoints")
assert.equal(recordedTurnChanges({ ...summary, state: "settling" })?.settling, true)
// One name for it everywhere: the line, the header, the writer rows.
assert.equal(unsureWords({ lines: 2, files: 0 }), "2 lines not sure whose")
assert.equal(unsureWords({ lines: 1, files: 0 }), "1 line not sure whose")
assert.equal(unsureWords({ lines: 0, files: 1 }), "1 file not sure whose", "a picture counts whole")
assert.equal(unsureWords({ lines: 3, files: 2 }), "3 lines and 2 files not sure whose")
// A picture the turn may or may not have made counts as a file, never as no lines.
const picture: TurnChanges = { ...summary, maybe: { files: 1, added: 0, removed: 0 }, files: [...summary.files.slice(0, 2), { path: "/repo/shot.png", root: "r-1", relative: "shot.png", kind: "create", maybe: null, before: null, after: `sha256:${"9".repeat(64)}`, entries: { first: 8, last: 8 } }] }
assert.deepEqual(recordedTurnChanges(picture)?.unsure, { lines: 0, files: 1 })
assert.equal(writerLabel({ writer: "maybe" }), UNSURE_LABEL)
assert.match(undoneWords({ at: 1_790_000_000_000, scope: "turn", files: 2, left: 1, backup: "refs/mako/moves/x" }), /^Undone at .+: this turn's lines came out of 2 files\. 1 stretch someone had edited since was left as it was\. The checkout from before is kept as refs\/mako\/moves\/x\.$/)

// The record as the conversation's journal keeps it is the record the live line drew: reopened, the line is the same.
const root = mkdtempSync(join(tmpdir(), "mako-turn-changes-"))
const id = "c0ffee00-1234-4abc-8def-0123456789ab"
const snapshotOf = (requests: LiveRequest[]): LiveSnapshot => ({
  session: { connection: "connected", id, harness: "claude", cwd: "/repo", status: "ready", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt: 1_790_000_000_000,
  blocks: [],
  base: null,
  permissions: [],
  requests,
})
const live: LiveRequest = { id: summary.turn, text: "Add b.ts", attachments: [], status: "completed", changes: summary }
try {
  const journal = new LiveJournal(root, id)
  journal.commit(snapshotOf([live]))
  journal.close()
  const reopened = new LiveJournal(root, id)
  const saved = reopened.read()?.requests[0]
  reopened.close()
  assert.deepEqual(saved?.changes, summary, "stored whole")
  assert.deepEqual(recordedTurnChanges(saved?.changes), recordedTurnChanges(live.changes), "the reopened line is the live one")
  // An undo is kept on the request beside its record, and reads back the same.
  const undone = { at: 1_790_000_100_000, scope: "turn" as const, files: 1, left: 0, backup: "refs/mako/moves/undo" }
  const keptRoot = mkdtempSync(join(tmpdir(), "mako-turn-undone-"))
  const kept = new LiveJournal(keptRoot, id)
  kept.commit(snapshotOf([{ ...live, undone }]))
  kept.close()
  const again = new LiveJournal(keptRoot, id)
  assert.deepEqual(again.read()?.requests[0]?.undone, undone, "the undo survives a reopen")
  again.close()
  rmSync(keptRoot, { recursive: true, force: true })
  assert.equal(LiveRequestSchema.parse({ ...live, undone: { at: "soon" } }).undone, undefined, "an undo this build can't read is dropped")
  // A record of a version this build doesn't read is dropped, never misread.
  assert.equal(LiveRequestSchema.parse({ ...live, changes: { ...summary, version: 99 } }).changes, undefined)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// Counting: pending as the turn ends, settling once the journal has every change heard, settled once it settles them.
{
  const counted: TurnChanges[] = []
  let settledYet = false
  const ledger: TurnLedger = {
    placement: () => ({ thread: "T1", session: "S1" }),
    flushed: async () => undefined,
    countTurn: (thread, turn, state) => ({ ...summary, thread, turn, state }),
    settledThrough: () => settledYet,
    counted: (record) => counted.push(record),
    turnsChangedAfter: () => new Map(),
    settleMs: 20,
  }
  const scratch = mkdtempSync(join(tmpdir(), "mako-turn-counting-"))
  const journal = new LiveJournal(scratch, id)
  const request: LiveRequest = { id: summary.turn, text: "Add b.ts", attachments: [], status: "completed" }
  const resident = residentOf(snapshotOf([request]), journal)
  let flushes = 0
  const counts = new LiveTurnChanges({ ledger: () => ledger, flush: () => void flushes++ })
  const state = () => resident.snapshot.requests[0]!.changes?.state
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(done())
  }
  counts.ended(resident, request.id)
  assert.equal(state(), "pending")
  assert.equal(resident.counting, 1, "kept in memory while its count is due")
  await until(() => state() === "settling")
  // The journal hasn't settled the turn's changes yet: the count waits.
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(state(), "settling")
  settledYet = true
  await until(() => state() === "settled")
  assert.equal(resident.counting, 0)
  assert.deepEqual(counted.map((record) => [record.turn, record.state]), [[summary.turn, "settled"]], "kept beside the entries for changes made")
  assert.ok(flushes >= 3)
  // A conversation reopened with a count still due is counted when it loads.
  const loaded = residentOf(snapshotOf([{ ...request, changes: { ...summary, state: "settling" } }]), journal)
  counts.loaded(loaded)
  await until(() => loaded.snapshot.requests[0]!.changes?.state === "settled")
  // A turn that ended before the journal opened stays due, and is counted once it opens (`journalOpened`).
  let open: TurnLedger | undefined
  const early = new LiveTurnChanges({ ledger: () => open, flush: () => void flushes++ })
  const before = residentOf(snapshotOf([{ ...request }]), journal)
  early.ended(before, request.id)
  assert.equal(before.snapshot.requests[0]!.changes?.state, "pending")
  assert.equal(before.counting ?? 0, 0, "nothing to wait on while the journal is closed")
  open = ledger
  early.loaded(before)
  await until(() => before.snapshot.requests[0]!.changes?.state === "settled")
  journal.close()
  rmSync(scratch, { recursive: true, force: true })
}

// "Changes made" says paths outside the checkouts were touched only when the Thread's calls named them.
{
  const thread = { files: { created: 0, changed: 2, deleted: 0, renamed: 0 }, lines: { added: 4, removed: 2 }, commands: 0, maybe: 0 }
  assert.equal(changeCounts({ ...thread, outside: { named: 0, maybe: 5 } })?.outside, 0, "five paths that only changed while it ran aren't its")
  assert.equal(changeCounts({ ...thread, outside: { named: 2, maybe: 5 } })?.outside, 2)
}

console.log("turn changes record: ok")
