import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { LiveHistoryReader } from "../electron/live-history-reader"
import { historyJsonChunks } from "../electron/live-history-json"
import type { LiveSnapshot } from "../electron/contracts/live-conversations"
import type { LiveHistoryRead, LiveHistoryPage } from "../electron/contracts/live-history"
import { auditSnapshot, auditId } from "./performance-audit-fixtures"

const samples: unknown[] = [null, false, 0, "", [undefined, undefined, null], { no: undefined, yes: ["a\n\"\\\t", "\ud800", "😀東京"] }]
samples.push(JSON.parse('{"__proto__":{"retained":true},"constructor":"data"}'))
for (const value of samples) {
  const result = [...historyJsonChunks(value, 3)].join("")
  assert.deepEqual(JSON.parse(result), JSON.parse(JSON.stringify(value)))
}

async function read<T>(reader: LiveHistoryReader, source: LiveSnapshot, input: LiveHistoryRead): Promise<T> {
  let part = await reader.read(source.session.id, input, async () => source)
  const record = part.record
  const pieces: string[] = []
  let offset = 0
  for (;;) {
    assert.equal(part.record, record)
    assert.equal(part.offset, offset)
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < 2 * 1024 * 1024, "Every frame stays below 2 MiB")
    pieces.push(part.data)
    offset += part.data.length
    if (part.next === null) {
      assert.equal(part.total, offset)
      break
    }
    assert.equal(part.next, offset)
    part = await reader.read(source.session.id, { kind: "part", record, offset }, async () => { throw new Error("A part must not recapture history") })
  }
  // SAFETY: this fixture reads the typed source supplied to this reader above.
  return JSON.parse(pieces.join("")) as T
}

for (const [index, provider] of ["claude", "codex", "cursor", "grok", "devin", "opencode"].entries()) {
  const source = auditSnapshot(300, provider, 256, 120 * 1024)
  source.session.id = auditId(100 + index)
  source.epoch = "source-epoch"
  source.baseCoveredBlocks = 6
  source.base = { ref: { harness: provider, nativeId: "base", path: "fixture" }, start: 0, total: 160, hasEarlier: false,
    entries: Array.from({ length: 160 }, (_, n) => ({ kind: "user", id: `base-${n}`, text: `Base ${n}` })) }
  const reader = new LiveHistoryReader()
  const first = await read<LiveSnapshot>(reader, source, { kind: "snapshot" })
  assert.ok(first.history?.before)
  assert.ok(first.blocks.length < source.blocks.length)
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > 32 * 1024 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 512 * 1024)
  assert.deepEqual(first.requests, source.requests, "Receipts remain complete")
  const blocks = [...first.blocks]
  const entries = [...first.base!.entries]
  let page: LiveHistoryPage = { ...first, history: first.history! }
  let pages = 1
  while (page.history?.before) {
    const before = page.history.before
    page = await read<LiveHistoryPage>(reader, source, { kind: "earlier", token: first.history!.token, before })
    assert.equal(page.history!.blockEnd, before.blocks)
    assert.equal(page.history!.blockStart + page.blocks.length, page.history!.blockEnd)
    blocks.unshift(...page.blocks)
    entries.unshift(...page.base!.entries)
    pages++
    assert.ok(pages < 30, "Every page makes progress")
  }
  assert.equal(blocks.length, source.blocks.length - 6)
  assert.deepEqual(entries, source.base.entries, "All earlier native entries survive")
  const prompts = blocks.filter(block => block.type === "user").map(block => block.text)
  assert.deepEqual(prompts, source.blocks.slice(6).filter(block => block.type === "user").map(block => block.text))
  const tool = first.blocks.find(block => block.type === "tool")
  assert.ok(tool?.type === "tool" && tool.historyRest)
  const full = await read(reader, source, { kind: "detail", token: first.history!.token, at: { kind: "live", index: tool.historyRest.index } })
  assert.deepEqual(full, source.blocks[tool.historyRest.index])
  const later = { ...source, revision: 2, blocks: [...source.blocks.slice(0, -1), { type: "text" as const, text: "newer" }] }
  await read(reader, later, { kind: "snapshot" })
  assert.deepEqual(await read(reader, later, { kind: "detail", token: first.history!.token, at: { kind: "live", index: source.blocks.length - 1 } }), source.blocks.at(-1), "Old token remains immutable")
  await assert.rejects(reader.read("wrong-owner", { kind: "earlier", token: first.history!.token, before: { blocks: 6, base: 1 } }, async () => source), /expired/)
  console.log(`${provider}: >32 MiB history -> ${Buffer.byteLength(JSON.stringify(first))} byte initial view, ${pages} pages, full receipts and tool content`)
}

// A single record larger than the old response ceiling, including escaped and
// surrogate content at chunk boundaries, is lossless without giant JSON encoding.
const giant = auditSnapshot(1, "fixture")
giant.blocks[1] = { type: "tool", id: "giant", title: "Read", status: "completed", input: "command", output: '😀\n"\\'.repeat(6_000_000) }
const giantReader = new LiveHistoryReader()
const summary = { session: giant.session, revision: giant.revision, createdAt: giant.createdAt }
assert.equal(giantReader.present(summary), summary, "A lightweight live summary is not a snapshot")
assert.deepEqual(giantReader.present([summary]), [summary])
assert.equal(giantReader.present({ snapshot: null }).snapshot, null)
assert.ok(giantReader.present({ snapshot: giant }).snapshot.history)
const giantView = await read<LiveSnapshot>(giantReader, giant, { kind: "snapshot" })
assert.ok(JSON.stringify(giantView).length < 32_000)
assert.deepEqual(await read(giantReader, giant, { kind: "detail", token: giantView.history!.token, at: { kind: "live", index: 1 } }), giant.blocks[1])
const concurrent = await Promise.all(Array.from({ length: 12 }, () => giantReader.read(giant.session.id,
  { kind: "detail", token: giantView.history!.token, at: { kind: "live", index: 1 } }, async () => giant)))
for (const part of concurrent) {
  assert.notEqual(part.next, null)
  const next = await giantReader.read(giant.session.id, { kind: "part", record: part.record, offset: part.next! }, async () => giant)
  assert.equal(next.offset, part.next, "Concurrent active reads are never evicted by the completed-read cache")
  assert.deepEqual(await giantReader.read(giant.session.id, { kind: "part", record: part.record, offset: 0 }, async () => giant), part)
}

// Production renderer state: prepend an old page while a newer live batch lands.
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { hydrateLive, loadEarlierLive, applyLiveSnapshot, applyLiveBatch } = await import("../src/state/live-recovery")
const { loadLiveHistoryDetail, completeLiveAnswer } = await import("../src/state/live-history")
installMockBridge()
const source = { ...auditSnapshot(80, "claude", 256, 4096), epoch: "view-epoch" }
const id = source.session.id
const reader = new LiveHistoryReader()
let gate: Promise<void> | undefined
let arrived = () => {}
const bridge = mock.method(getMako(), "liveRead", async (_id, input) => {
  const result = await reader.read(id, input, async () => source)
  if (input.kind === "earlier" && gate) { arrived(); await gate }
  return result
})
try {
  assert.equal(await hydrateLive(id), true)
  acpStore.set({ activeKey: id })
  const initial = acpStore.get().conversations[id]!
  assert.ok(initial.history?.before)
  const stableLastMessage = initial.projection!.messages.at(-1)!.id
  const released = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  gate = released.promise
  arrived = waiting.resolve
  const loading = loadEarlierLive(id)
  await waiting.promise
  const newApproval = { id: "new-question", sessionId: id, title: "Allow the newer command?", options: [{ optionId: "allow", name: "Allow" }] }
  applyLiveBatch({ id, revision: 2, epoch: source.epoch, updates: [{ kind: "text", id: "text-79", text: " APPENDED" }],
    permissions: [newApproval],
    requests: [...source.requests, { id: auditId(999), text: "New queued prompt", status: "queued", attachments: [] }],
    changedFrom: source.blocks.length - 1, blockCount: source.blocks.length })
  released.resolve()
  await loading
  gate = undefined
  let current = acpStore.get().conversations[id]!
  assert.equal(current.revision, 2, "Earlier page cannot rewind current control revision")
  assert.equal(current.requests!.at(-1)!.id, auditId(999), "Earlier page cannot erase a newer prompt receipt")
  assert.deepEqual(current.permission, newApproval, "Earlier page cannot clear a newer approval")
  assert.ok(current.blocks.at(-1)?.type === "text" && current.blocks.at(-1)!.text.endsWith(" APPENDED"))
  assert.equal(current.projection!.messages.at(-1)!.id, stableLastMessage)
  const preview = current.blocks.find(block => block.type === "tool" && block.historyRest)
  assert.ok(preview?.type === "tool" && preview.historyRest)
  await loadLiveHistoryDetail(id, current.history!.token, { kind: "live", index: preview.historyRest.index })
  current = acpStore.get().conversations[id]!
  const detail = current.blocks.find(block => block.type === "tool" && block.id === preview.id)
  assert.ok(detail?.type === "tool" && !detail.historyRest && detail.output!.length > 2048)
  const oldest = current.history!.blockStart
  source.revision = 3
  source.requests = current.requests!
  source.permissions = [newApproval]
  source.blocks = [...source.blocks.slice(0, -1), { type: "text", id: "text-79", text: "Latest full response APPENDED" }]
  assert.equal(await hydrateLive(id), true)
  assert.equal(acpStore.get().conversations[id]!.history!.blockStart, oldest, "Refresh preserves the range explicitly loaded by the reader")
  // A reconnect supersedes an outstanding older page. New approvals/receipts
  // and a new epoch survive its eventual arrival unchanged.
  const late = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  gate = late.promise
  arrived = requested.resolve
  const stale = loadEarlierLive(id)
  await requested.promise
  const reopened = await read<LiveSnapshot>(reader, { ...source, revision: 1, epoch: "new-host" }, { kind: "snapshot" })
  applyLiveSnapshot(reopened)
  late.resolve()
  await stale
  assert.equal(acpStore.get().conversations[id]!.history!.token, reopened.history!.token)
  assert.equal(acpStore.get().conversations[id]!.blocks.length, reopened.blocks.length)
  gate = undefined
  // One answer crosses multiple pages, including a steer whose question is
  // outside the first page. Copy resolves the whole answer without UI mutation.
  source.base = null
  source.blocks = [{ type: "user", requestId: "question", text: "Question" },
    ...Array.from({ length: 240 }, (_, n) => n === 220
      ? { type: "user" as const, text: "Steer", steeringFor: "question" }
      : { type: "text" as const, id: `part-${n}`, text: `Part ${n}.` })]
  source.requests = []
  applyLiveSnapshot(await read<LiveSnapshot>(reader, { ...source, revision: 10, epoch: "copy" }, { kind: "snapshot" }))
  const copyView = acpStore.get().conversations[id]!
  const exchange = copyView.projection!.exchanges[0]!
  assert.equal(exchange.prompt, undefined)
  assert.equal(copyView.projection!.exchanges.length, 1, "A partial steer is not a separate question")
  const fullProjection = (await import("../src/state/live-projection")).projectLive(source)
  const expected = (await import("../src/lib/exchanges")).responseText(fullProjection.exchanges[0]!)
  assert.equal(await completeLiveAnswer(id, exchange), expected)
  assert.equal(acpStore.get().conversations[id], copyView, "Copy leaves the reading position and state intact")
  await tick()
  console.log("PASS: renderer page/stream merge, stable message identity, lazy detail and reconnect fencing")
} finally { bridge.mock.restore(); Reflect.deleteProperty(globalThis, "window") }

// A legacy retained native base with earlier pages still uses the original
// checkpoint, rather than mixing a fresh source with the saved conversation.
const legacy = auditSnapshot(0)
legacy.base = { ref: { harness: "fixture", nativeId: "legacy", path: "legacy" }, checkpoint: 10,
  start: 2, total: 4, hasEarlier: true, entries: [{ kind: "user", text: "two" }, { kind: "user", text: "three" }] }
const native = new LiveHistoryReader(async () => ({ ...legacy.base!, start: 0, hasEarlier: false,
  entries: [{ kind: "user", text: "zero" }, { kind: "user", text: "one" }] }))
const tail = await read<LiveSnapshot>(native, legacy, { kind: "snapshot" })
const earlier = await read<LiveSnapshot>(native, legacy, { kind: "earlier", token: tail.history!.token, before: tail.history!.before! })
assert.deepEqual(earlier.base!.entries.map(entry => entry.kind === "user" ? entry.text : ""), ["zero", "one"])
assert.equal(earlier.history!.before, null)
console.log("PASS: legacy native-page continuation without truncation")

const nativeOutput = { type: "tool" as const, name: "read", output: "whole native result", attachments: [] }
const partial = { ...legacy, base: { ...legacy.base!, start: 0, hasEarlier: false,
  entries: [{ kind: "assistant" as const, blocks: [{ ...nativeOutput, output: "whole", outputLength: nativeOutput.output.length }] }] } }
let changed = false
const nativeDetail = new LiveHistoryReader(async () => ({ ...partial.base, checkpoint: changed ? 11 : 10 }), async () => nativeOutput)
const partialView = await read<LiveSnapshot>(nativeDetail, partial, { kind: "snapshot" })
const address = { kind: "base" as const, entry: 0, block: 0 }
assert.deepEqual(await read(nativeDetail, partial, { kind: "detail", token: partialView.history!.token, at: address }), nativeOutput)
changed = true
await assert.rejects(read(nativeDetail, partial, { kind: "detail", token: partialView.history!.token, at: address }), /native history changed/)
console.log("PASS: native preview completion and changed-source refusal")
