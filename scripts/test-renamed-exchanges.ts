import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { renamedExchanges, toExchanges, type Exchange } from "../src/lib/exchanges.ts"
import { projectLive } from "../src/state/live-projection.ts"
import type { ChatMessage, LiveSnapshot } from "../src/lib/types.ts"

// A host checkpoint hands the finished turns to native history: the same
// conversation, projected again under the provider's message ids.
const blocks: LiveSnapshot["blocks"] = [
  { type: "user", requestId: "r1", text: "Why does the transcript jump after an answer?" },
  { type: "text", id: "t1", text: "Every turn is renamed." },
  { type: "user", requestId: "r2", text: "Keep the reader where they were." },
  { type: "text", id: "t2", text: "Done." },
]
const ref = { harness: "codex" as const, nativeId: "n", path: "n.jsonl", bytes: 10 }
const live = projectLive({ blocks, base: null, session: { status: "ready", harness: "codex" } })
const checkpointed = projectLive({
  blocks,
  base: {
    ref,
    entries: [
      { kind: "user", id: "u1", text: "Why does the transcript jump after an answer?" },
      { kind: "assistant", id: "a1", blocks: [{ type: "text", text: "Every turn is renamed." }] },
      { kind: "user", id: "u2", text: "Keep the reader where they were." },
      { kind: "assistant", id: "a2", blocks: [{ type: "text", text: "Done." }] },
    ],
    start: 0, total: 4, hasEarlier: false, checkpoint: 10,
  },
  baseCoveredBlocks: blocks.length,
  session: { status: "ready", harness: "codex" },
})
assert.deepEqual(live.exchanges.map((exchange) => exchange.id), ["acp-request-r1", "acp-request-r2"])
assert.notDeepEqual(checkpointed.exchanges.map((exchange) => exchange.id), live.exchanges.map((exchange) => exchange.id),
  "the checkpoint renames every turn, which is what this guards against")
assert.deepEqual([...renamedExchanges(live.exchanges, checkpointed.exchanges)], [
  ["acp-request-r1", checkpointed.exchanges[0]!.id],
  ["acp-request-r2", checkpointed.exchanges[1]!.id],
], "each live turn is matched to its native one")

const turns = (prefix: string, prompts: string[]): Exchange[] =>
  toExchanges(prompts.flatMap((text, index): ChatMessage[] => [
    { id: `${prefix}-u${index}`, role: "user", blocks: [{ type: "text", text }] },
    { id: `${prefix}-a${index}`, role: "assistant", blocks: [{ type: "text", text: `Answer ${index}` }] },
  ]))
const prompts = ["Question one about the scroller", "Question two about the anchor", "yes", "Question four about paging"]
const renames = (after: Exchange[]) => Object.fromEntries(renamedExchanges(turns("live", prompts), after))

assert.deepEqual(renames(turns("native", prompts.map((text) => `[Attachment 1]  ${text.replace(/ /g, "  ")}`))), {
  "live-u0": "native-u0", "live-u1": "native-u1", "live-u2": "native-u2", "live-u3": "native-u3",
}, "a prompt retold with attachments and other spacing is the same prompt; a short one between matches goes by position")
assert.deepEqual(renames(turns("native", prompts.map((_, index) => `Native ${index}`))), {
  "live-u0": "native-u0", "live-u1": "native-u1", "live-u2": "native-u2", "live-u3": "native-u3",
}, "with no prompt matching, as many turns on each side are the same turns in order")
assert.deepEqual(renames(turns("native", [prompts[0]!, prompts[2]!, prompts[3]!, "Continue where you left off."])), {
  "live-u0": "native-u0", "live-u2": "native-u1", "live-u3": "native-u2",
}, "a dropped prompt and an added one: the rest still match, the dropped one goes unmatched")
assert.deepEqual(renames(turns("native", ["Something else", "I said yes to that one"])), {},
  "a short prompt inside another is not taken for it, and uneven stretches stay unmatched")
assert.equal(renamedExchanges(turns("live", prompts), [...turns("live", prompts), ...turns("next", ["A new question entirely"])]).size, 0,
  "a turn arriving with none gone is a new turn")
assert.equal(renamedExchanges(turns("live", prompts), turns("live", prompts).slice(1)).size, 0,
  "a turn gone with none arriving is gone")

const count = 10000
const longBefore = turns("old", Array.from({ length: count }, (_, index) => `Original question number ${index}`))
const longAfter = turns("new", Array.from({ length: count }, (_, index) => `Completely rewritten native prompt ${index}`))
const began = performance.now()
assert.equal(renamedExchanges(longBefore, longAfter).size, count, "equal gaps retain visual continuity without quadratic search")
const elapsed = performance.now() - began
assert.ok(elapsed < 1000, `10,000 entirely rewritten prompts took ${elapsed.toFixed(1)}ms`)
let reads = 0
const known = longBefore.map(item => ({ ...item, prompt: item.prompt && { ...item.prompt,
  get blocks() { reads++; return item.prompt!.blocks },
} }))
assert.equal(renamedExchanges(known, known).size, 0)
assert.equal(reads, 0, "stable proven identities never read historical prompt text")
console.log(`Checkpoint layout matching: 10,000 rewritten prompts in ${elapsed.toFixed(1)}ms; stable IDs read zero prompt bodies`)

console.log("renamed exchanges: a checkpoint's native turns matched to the live ones by prompt, retold prompts, reworded turns by position, uneven stretches left alone, arrivals and removals never renames")
