import assert from "node:assert/strict"
import { joined } from "../dist/entries.js"

/**
 * `joined` makes a new reference and never changes one an entry already
 * handed out: a stream that continues shares the ranges before its last,
 * and a list that arrives out of order is sorted and merged on copies.
 */

const freeze = (ref) => JSON.stringify(ref)

// A stream's next lines: merged onto the last range, the earlier ones shared, the held reference unchanged.
const held = { file: "s.jsonl", ranges: [[0, 10], [20, 30]] }
const before = freeze(held)
const grown = joined(held, { file: "s.jsonl", ranges: [[25, 40], [50, 60]] })
assert.deepEqual(grown.ranges, [[0, 10], [20, 40], [50, 60]])
assert.equal(freeze(held), before, "the held reference is unchanged")

// Out of order: the slow path sorts and merges, and must not widen the caller's ranges in place.
const scattered = { file: "s.jsonl", ranges: [[10, 20], [40, 50]] }
const scatteredBefore = freeze(scattered)
const added = { file: "s.jsonl", ranges: [[0, 15], [45, 70]] }
const addedBefore = freeze(added)
const merged = joined(scattered, added)
assert.deepEqual(merged.ranges, [[0, 20], [40, 70]])
assert.equal(freeze(scattered), scatteredBefore, "an out-of-order join leaves the held ranges as they were")
assert.equal(freeze(added), addedBefore, "and the added ones")
merged.ranges[0][1] = 999
assert.equal(freeze(scattered), scatteredBefore, "nor does a later change to the result reach them")

// Held ranges that touch each other (not as joinedRanges leaves them) with ranges after them: the merge widens a
// copy, never the held range it came from.
const overlapping = { file: "s.jsonl", ranges: [[0, 10], [5, 20]] }
const overlappingBefore = freeze(overlapping)
assert.deepEqual(joined(overlapping, { file: "s.jsonl", ranges: [[30, 40]] }).ranges, [[0, 20], [30, 40]])
assert.equal(freeze(overlapping), overlappingBefore, "merging touching held ranges leaves them as they were")

// Another file's record is left out; nothing joins onto nothing.
assert.equal(joined(held, { file: "other.jsonl", ranges: [[0, 1]] }), held)
assert.equal(joined(undefined, held), held)
console.log("PASS: a record reference joined with more of its file is a new one; the references it came from never change")
