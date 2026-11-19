// When Codex's primer goes (`CodexPrimer`), and what a thread's rollout says
// it already holds (`rolloutHoldsPrimer`): the newest `<mako>` developer
// message with no compaction or rollback after it, and only when it says
// exactly the current primer. Read back from the end, past lines longer than
// a read and past ones too long to read.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexPrimer, rolloutHoldsPrimer } from "@mako/host/harnesses/codex/primer-cadence"

const PRIMER = "Prefer Mako's tool for this Thread."
const primer = (value: string) => ({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: `<mako>${value}</mako>` }] } })
const user = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })
const compacted = { type: "compacted", payload: { message: "", replacement_history: [] } }
const rolledBack = { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }

const root = mkdtempSync(join(tmpdir(), "mako-codex-primer-"))
let files = 0
const rollout = (records: unknown[], trailingNewline = true) => {
  const path = join(root, `rollout-${files += 1}.jsonl`)
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + (trailingNewline ? "\n" : ""))
  return path
}

try {
  assert.equal(await rolloutHoldsPrimer(join(root, "missing.jsonl"), PRIMER), false, "a thread with no rollout yet holds nothing")
  assert.equal(await rolloutHoldsPrimer(rollout([]), PRIMER), false, "nor an empty one")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), user("hi")]), PRIMER), true, "the primer it was given")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER)], false), PRIMER), true, "on the file's only, unfinished line")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), user("hi"), compacted, user("more")]), PRIMER), false, "a compaction since dropped it")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), compacted, primer(PRIMER), user("hi")]), PRIMER), true, "given again after the compaction")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), rolledBack]), PRIMER), false, "a rollback since may have dropped it")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), user("hi")]), "Changed."), false, "a primer whose text changed goes again")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), primer("Older.")]), PRIMER), false, "only the newest primer counts")
  assert.equal(await rolloutHoldsPrimer(rollout([user(`<mako>${PRIMER}</mako>`)]), PRIMER), false, "the person's words are never the primer")

  // Lines across reads: a 3 MB output after it, and one past the longest line read (skipped unread).
  const big = "x".repeat(3 * 1024 * 1024)
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), user(big), user("hi")]), PRIMER), true, "a line longer than a read")
  assert.equal(await rolloutHoldsPrimer(rollout([user(big), primer(PRIMER), user(big)]), PRIMER), true, "between long lines")
  const huge = "y".repeat(17 * 1024 * 1024)
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), user(huge), user("hi")]), PRIMER), true, "past a line too long to read")
  assert.equal(await rolloutHoldsPrimer(rollout([primer(PRIMER), compacted, user(huge)]), PRIMER), false, "a compaction before such a line still counts")

  // The cadence: Codex compares each turn's context with the turn before's, and forgets an entry left out.
  const fresh = new CodexPrimer(PRIMER, false)
  assert.equal(fresh.forTurn(), true, "a transcript without it gets it")
  assert.equal(fresh.forTurn(), false, "then never again")
  assert.equal(fresh.forTurn(), false)
  fresh.forgot()
  assert.equal(fresh.forTurn(), true, "a compaction sends it again")
  assert.equal(fresh.forTurn(), false)

  const resumed = new CodexPrimer(PRIMER, true)
  assert.equal(resumed.forTurn(), false, "a resumed thread that holds it doesn't get it again")

  const refused = new CodexPrimer(PRIMER, false)
  const sent = refused.forTurn()
  refused.failed(sent)
  assert.equal(refused.forTurn(), false, "after a refused turn/start Codex may hold it, so that turn leaves it out to empty Codex's store")
  assert.equal(refused.forTurn(), true, "and the next carries it")

  const compactedAtOnce = new CodexPrimer(PRIMER, false)
  assert.equal(compactedAtOnce.forTurn(), true)
  compactedAtOnce.forgot()
  assert.equal(compactedAtOnce.forTurn(), false, "compacted in the turn that carried it: Codex would skip it as unchanged, so this turn empties its store")
  assert.equal(compactedAtOnce.forTurn(), true, "and the next carries it")

  const steered = new CodexPrimer(PRIMER, false)
  assert.equal(steered.forTurn(), true)
  steered.steered()
  steered.forgot()
  assert.equal(steered.forTurn(), true, "a steer emptied Codex's store, so a compaction after it resends at once")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("codex primer cadence: the primer goes once per transcript, read from the rollout; again after a compaction, a rollback or a change")
