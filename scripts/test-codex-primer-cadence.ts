// When Codex's primer goes (`CodexPrimer`), how it's cut into entries Codex
// shows whole (`primerEntries`), and what a thread's rollout says it already
// holds (`rolloutHoldsPrimer`): under each key the newest developer message
// with no compaction or rollback after it, and only when each says exactly the
// current entry. Read back from the end, past lines longer than a read and
// past ones too long to read.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexPrimer, CONTEXT_ENTRY_BYTES, primerEntries, rolloutHoldsPrimer } from "@mako/host/harnesses/codex/primer-cadence"

// Codex shows each entry whole up to 4,000 bytes and cuts the middle of a longer one: every entry fits, each block
// that fits is one entry, a longer block goes between its lines, and their keys sort in the blocks' order.
const routes = Array.from({ length: 40 }, (_, at) => `- Route ${at}: ${"word ".repeat(30)}é`).join("\n")
const entries = primerEntries([routes, "Policy.", "Server."])
const values = Object.values(entries)
for (const value of values) assert.ok(Buffer.byteLength(value) <= CONTEXT_ENTRY_BYTES, `an entry of ${Buffer.byteLength(value)} bytes fits`)
assert.ok(Buffer.byteLength(routes) > CONTEXT_ENTRY_BYTES && values.length === 4, "a block past the limit is two entries, each other block one")
assert.equal(values.slice(0, 2).join("\n"), routes, "cut between lines, nothing lost")
assert.deepEqual(Object.keys(entries), ["mako_01", "mako_02", "mako_03", "mako_04"])
assert.deepEqual(Object.keys(entries), Object.keys(entries).toSorted(), "Codex shows them in its keys' order")
const sentences = Array.from({ length: 300 }, (_, at) => `Sentence ${at} says one thing.`).join(" ")
assert.equal(Object.values(primerEntries([sentences])).join(""), sentences, "a line past the limit is cut between its sentences")
assert.ok(Object.values(primerEntries([sentences])).every((value) => Buffer.byteLength(value) <= CONTEXT_ENTRY_BYTES))
assert.equal(Object.values(primerEntries(["x".repeat(9_000)])).join(""), "x".repeat(9_000), "and one sentence past it between characters")

const PRIMER = { mako_01: "Prefer Mako's tool for this Thread.", mako_02: "Never put a secret in a commit." }
const developer = (...texts: string[]) => ({ type: "response_item", payload: { type: "message", role: "developer", content: texts.map((text) => ({ type: "input_text", text })) } })
const entry = (key: string, value: string) => developer(`<${key}>${value}</${key}>`)
/** Each entry a developer message of its own, as Codex records them. */
const primer = (value: Record<string, string>) => Object.entries(value).map(([key, text]) => entry(key, text))
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
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), user("hi")]), PRIMER), true, "the primer it was given")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER)], false), PRIMER), true, "on the file's only, unfinished line")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), user("hi"), compacted, user("more")]), PRIMER), false, "a compaction since dropped it")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), compacted, ...primer(PRIMER), user("hi")]), PRIMER), true, "given again after the compaction")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), rolledBack]), PRIMER), false, "a rollback since may have dropped it")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), user("hi")]), { ...PRIMER, mako_02: "Changed." }), false, "a primer one entry of which changed goes again")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), entry("mako_02", "Older.")]), PRIMER), false, "only the newest under each key counts")
  assert.equal(await rolloutHoldsPrimer(rollout([entry("mako_02", "Older."), ...primer(PRIMER)]), PRIMER), true, "an older one before it says nothing")
  assert.equal(await rolloutHoldsPrimer(rollout([entry("mako_01", PRIMER.mako_01), user("hi")]), PRIMER), false, "every entry, not some")
  assert.equal(await rolloutHoldsPrimer(rollout([developer(...primer(PRIMER).map((each) => each.payload.content[0]!.text))]), PRIMER), true, "entries in one message count too")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), developer(`<mako>${PRIMER.mako_01}</mako>`)]), PRIMER), true, "an earlier build's single <mako> says nothing of them")
  assert.equal(await rolloutHoldsPrimer(rollout([developer(`<mako>${Object.values(PRIMER).join("\n\n")}</mako>`)]), PRIMER), false, "so a thread that holds only that one gets them")
  assert.equal(await rolloutHoldsPrimer(rollout([user(`<mako_01>${PRIMER.mako_01}</mako_01>`), user(`<mako_02>${PRIMER.mako_02}</mako_02>`)]), PRIMER), false, "the person's words are never the primer")

  // Lines across reads: a 3 MB output after it, and one past the longest line read (skipped unread).
  const big = "x".repeat(3 * 1024 * 1024)
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), user(big), user("hi")]), PRIMER), true, "a line longer than a read")
  assert.equal(await rolloutHoldsPrimer(rollout([user(big), ...primer(PRIMER), user(big)]), PRIMER), true, "between long lines")
  const huge = "y".repeat(17 * 1024 * 1024)
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), user(huge), user("hi")]), PRIMER), true, "past a line too long to read")
  assert.equal(await rolloutHoldsPrimer(rollout([...primer(PRIMER), compacted, user(huge)]), PRIMER), false, "a compaction before such a line still counts")

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
