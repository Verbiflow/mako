import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRepository, confirmed, type Paired } from "./perf-reference"

/**
 * Where a performance reference's history is read. A checkout reads its own;
 * Settings › Updates builds a copy with no `.git` in `<updates>/checkout`,
 * whose source the updater passes as `MAKO_BUILD_SOURCE`, or, from an
 * installed app that predates it, names in `<updates>/source.json`.
 */

const root = mkdtempSync(join(tmpdir(), "mako-perf-reference-"))
try {
  // Folders of its own, so the test reads the same wherever it runs, a build copy without `.git` included.
  const repository = join(root, "checkout-with-history")
  mkdirSync(join(repository, ".git"), { recursive: true })
  const updates = join(root, "updates")
  const copy = join(updates, "checkout")
  mkdirSync(copy, { recursive: true })

  assert.equal(buildRepository(repository, undefined), repository, "a checkout reads its own history")
  assert.equal(buildRepository(copy, "/somewhere/else"), "/somewhere/else", "the updater's MAKO_BUILD_SOURCE wins")
  assert.equal(buildRepository(copy, undefined), copy, "with nothing naming a source, the copy is all there is")

  writeFileSync(join(updates, "source.json"), JSON.stringify(repository))
  assert.equal(buildRepository(copy, undefined), repository, "an older updater's source.json names the checkout")

  writeFileSync(join(updates, "source.json"), JSON.stringify(join(root, "gone")))
  assert.equal(buildRepository(copy, undefined), copy, "a named checkout with no repository isn't taken")
  writeFileSync(join(updates, "source.json"), "{not json")
  assert.equal(buildRepository(copy, undefined), copy, "nor an unreadable record")
  console.log("PASS: a performance reference reads the history of the checkout, the updater's source, or the checkout source.json names")
} finally {
  rmSync(root, { recursive: true, force: true })
}

// A row over its allowance on its first rounds is measured again before it's called slower: three processes that
// drew the slower cores read 30% apart on unchanged code, and settle on the rest; a real regression stays over.
const ALLOWED = 1.25
const unlucky: Paired = { key: "merge/merge large (same)", reference: [0.49, 0.485, 0.506], head: [0.634, 0.698, 0.623] }
const fine: Paired = { key: "merge/other", reference: [1, 1, 1], head: [1.05, 1, 1.02] }
const asked: string[][] = []
const settledRows = await confirmed([unlucky, fine], ALLOWED, async (keys) => {
  asked.push(keys)
  return [{ key: unlucky.key, reference: [0.58, 0.6, 0.57, 0.59], head: [0.6, 0.61, 0.59, 0.6] }]
})
assert.deepEqual(asked, [["merge/merge large (same)"]], "only the row over its allowance is measured again")
const confirmedRow = settledRows.find((row) => row.key === unlucky.key)!
assert.equal(confirmedRow.head.length, 7, "decided on every run both sides made")
const ratio = (row: Paired) => [...row.head].sort((a, b) => a - b)[3]! / [...row.reference].sort((a, b) => a - b)[3]!
assert.ok(ratio(confirmedRow) < ALLOWED, "an unlucky draw settles under the allowance")
assert.deepEqual(settledRows.find((row) => row.key === fine.key), fine, "a row within it is left as it was")
const slower = await confirmed([unlucky], ALLOWED, async () => [{ key: unlucky.key, reference: [0.5, 0.52, 0.51, 0.5], head: [0.7, 0.69, 0.72, 0.7] }])
assert.ok(ratio(slower[0]!) > ALLOWED, "a real regression stays over")
assert.deepEqual(await confirmed([fine], ALLOWED, async () => assert.fail("nothing to confirm")), [fine])
console.log("PASS: a row over its allowance is measured again, and called slower only on every run")
