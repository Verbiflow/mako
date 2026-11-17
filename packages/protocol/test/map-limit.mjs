import assert from "node:assert/strict"
import { mapLimit } from "../dist/map-limit.js"

// Every worker pool's one helper (the host's, @mako/sessions' restore and row reads, @mako/git's drafting). A failure starts
// nothing new, waits for what started, then rejects with the first error: a restore that fails a file still lets the
// writes already under way land before it says so.
const tick = (ms) => new Promise((done) => setTimeout(done, ms))
const started = []
const settled = []
await assert.rejects(mapLimit([0, 1, 2, 3, 4, 5, 6], 3, async (value) => {
  started.push(value)
  if (value === 0) { await tick(5); throw new Error("first") }
  if (value === 1) { await tick(10); throw new Error("second") }
  await tick(40)
  settled.push(value)
}), /first/)
assert.deepEqual(started, [0, 1, 2], "nothing starts after a failure")
assert.deepEqual(settled, [2], "what started is waited for")
assert.deepEqual(await mapLimit([3, 1, 2], 2, async (value) => { await tick(value); return value * 10 }), [30, 10, 20], "results in order")
await mapLimit([], 4, async () => { throw new Error("never") })
console.log("map limit: nothing starts after a failure, what started settles before the first error is thrown, results in order")
