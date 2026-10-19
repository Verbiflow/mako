import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRepository } from "./perf-reference"

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
