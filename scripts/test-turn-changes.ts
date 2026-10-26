import assert from "node:assert/strict"
import { turnChangeSummary, turnChangeWords } from "../src/lib/turn-changes.ts"
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
  { files: 3, insertions: 53, deletions: 12 }
)
assert.deepEqual(turnChangeSummary([{ insertions: 5, deletions: null }]), { files: 1, insertions: 5, deletions: null })
assert.deepEqual(turnChangeSummary([{ insertions: null, deletions: null }]), { files: 1, insertions: null, deletions: null })
assert.deepEqual(turnChangeSummary([]), { files: 0, insertions: null, deletions: null })

// A requested turn is the scope only in the repository its checkpoints saved.
const request: TurnReviewRequest = { workspace: "/repo", turn: { kind: "turn", conversation: "c", requestId: "r", prompt: "Fix it" } }
assert.equal(requestedTurn(request, "/repo"), request.turn)
assert.equal(requestedTurn(request, "/other"), null)
assert.equal(requestedTurn(null, "/repo"), null)

console.log("turn changes: ok")
