import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { comparePair, PairSchema, PAIRS_FOLDER, storeDrawing } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"

/**
 * Items Codex records only as their completed item: a standalone web search,
 * an image generation and a Codex app tool's output. No scripted model can
 * run them (search and generation call OpenAI's backends), so each is
 * spliced into a recorded pair twice, as the app-server sends it and as the
 * rollout keeps it, in the shapes Codex 0.159 writes, and both sides must
 * draw it the same.
 */

const source = join(FIXTURE_ROOT, "codex", PAIRS_FOLDER, "read-and-answer")
const pairDir = await mkdtemp(join(tmpdir(), "mako-codex-items-"))
await cp(source, pairDir, { recursive: true })
const pair = PairSchema.parse(JSON.parse(await readFile(join(pairDir, "pair.json"), "utf8")))
const rollout = join(pairDir, "home", pair.stores[0]!.path)

const action = { type: "search", query: "release train schedule", queries: ["release train schedule"] }
const results = [
  { type: "result", ref_id: "r1", title: "Release train", url: "https://example.com/release-train", domain: "example.com", snippet: "Weekly." },
  { type: "result", ref_id: "r2", title: "No address", snippet: "A result without a URL draws nothing." },
]
const image = { id: "ig_1", status: "completed", revisedPrompt: "A release calendar", result: "iVBORw0KGgo=", transparentBackground: false, failure: null, savedPath: "/tmp/mako-pair/codex/generated_images/ig_1.png" }
const live = [
  { type: "webSearch", id: "ws_1", query: "release train schedule", action, results },
  { type: "imageGeneration", ...image },
  { type: "functionCallOutput", id: "fc_1", name: "send_message_to_thread", namespace: "codex_app", output: "Message sent." },
]
const stored = [
  { type: "Extension", kind: "web.search", id: "ws_1", query: "release train schedule", action, results },
  { type: "Extension", kind: "image_gen.generation", ...image },
  { type: "FunctionCallOutput", id: "fc_1", name: "send_message_to_thread", namespace: "codex_app", output: "Message sent." },
]

const RolloutLine = z.object({ payload: z.object({ type: z.string() }).loose() }).loose()

const after = (lines: string[], test: (line: string) => boolean): number => {
  const index = lines.findIndex(test)
  assert.ok(index >= 0, "the splice point is in the recording")
  return index + 1
}
const capture = (await readFile(join(pairDir, "capture.jsonl"), "utf8")).trimEnd().split("\n")
const ended = after(capture, (line) => line.includes('"method":"item/completed"') && line.includes('"type":"commandExecution"'))
const { threadId, turnId } = JSON.parse(capture[ended - 1]!).message.params
capture.splice(ended, 0, ...live.flatMap((item) => ["item/started", "item/completed"].map((method) =>
  JSON.stringify({ message: { method, params: { item, threadId, turnId } } }))))
await writeFile(join(pairDir, "capture.jsonl"), `${capture.join("\n")}\n`)

const records = (await readFile(rollout, "utf8")).trimEnd().split("\n")
const output = after(records, (line) => RolloutLine.safeParse(JSON.parse(line)).data?.payload.type === "function_call_output")
const at = JSON.parse(records[output - 1]!).timestamp
records.splice(output, 0, ...stored.map((item) =>
  JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "item_completed", thread_id: threadId, turn_id: turnId, item } })))
await writeFile(rollout, `${records.join("\n")}\n`)

const { stores } = await comparePair(pairDir)
assert.deepEqual(stores[0]!.unexplained, [], "the live wire and the rollout draw the spliced items the same")
assert.deepEqual(stores[0]!.unread, [], "every spliced item is one the rollout reader knows")

// A record a later Codex adds reaches the pair check by its kind, so a pair
// recorded from that Codex fails until the reader learns it.
records.splice(output, 0, JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "future_item", note: "spliced" } }))
await writeFile(rollout, `${records.join("\n")}\n`)
const future = await comparePair(pairDir)
assert.deepEqual(future.stores[0]!.unread.map(({ kind, reason, count }) => ({ kind, reason, count })), [
  { kind: "response_item future_item", reason: "unknown", count: 1 },
])
const drawn = (await storeDrawing("codex", "codex", join(pairDir, "home"), rollout)).join("\n")
assert.match(drawn, /web_search .*release train schedule.* -> Release train\\nhttps:\/\/example\.com\/release-train\n/, "the search draws what it looked for and the results with an address")
assert.match(drawn, /ig_1\.png image\/png/, "the generated image draws as the file Codex saved")
assert.match(drawn, /codex_app\.send_message_to_thread.*Message sent\./, "the app tool draws with its output")
await rm(pairDir, { recursive: true, force: true })
console.log("PASS: a Codex web search, generated image and app tool output draw the same live and from the rollout, and a record the reader doesn't know reaches the pair check")
