import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { LiveHistoryReader } from "../electron/live-history-reader"
import { auditId, auditSnapshot, auditStats } from "./performance-audit-fixtures"
const evidence = "docs/audits/2026-09-23/live-history-performance"
await mkdir(evidence, { recursive: true })
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { hydrateLive, loadEarlierLive, applyLiveBatch } = await import("../src/state/live-recovery")
const { loadLiveHistoryDetail } = await import("../src/state/live-history")
installMockBridge()
const results = []
for (const [index, provider] of ["claude", "codex", "cursor", "grok", "devin", "opencode"].entries()) {
  const source = { ...auditSnapshot(300, provider, 256, 120 * 1024), epoch: "performance" }
  source.session.id = auditId(index + 10000)
  const id = source.session.id
  const reader = new LiveHistoryReader()
  let bytes = 0, reads = 0, details = 0
  const bridge = mock.method(getMako(), "liveRead", async (_id, input) => {
    reads++; if (input.kind === "detail") details++
    const result = await reader.read(id, input, async () => source)
    bytes += Buffer.byteLength(JSON.stringify(result))
    return result
  })
  try {
    acpStore.set({ activeKey: id })
    const start = performance.now()
    await hydrateLive(id)
    const coldMs = performance.now() - start
    await loadEarlierLive(id)
    await loadEarlierLive(id)
    const held = acpStore.get().conversations[id]!
    const tool = held.blocks.find(block => block.type === "tool" && block.historyRest)
    assert.ok(tool?.type === "tool" && tool.historyRest)
    const at = { kind: "live" as const, index: tool.historyRest.index }
    await loadLiveHistoryDetail(id, held.history!.token, at)
    const beforeBytes = bytes, beforeReads = reads, beforeDetails = details
    const samples = []
    for (let n = 0; n < 30; n++) {
      const then = performance.now(); await hydrateLive(id); samples.push(performance.now() - then)
      const current = acpStore.get().conversations[id]!
      const block = current.blocks.find(item => item.type === "tool" && item.id === tool.id)
      if (block?.type === "tool" && block.historyRest) await loadLiveHistoryDetail(id, current.history!.token, at)
    }
    const reopened = acpStore.get().conversations[id]!
    const retainedBeforeChange = reopened.blocks.find(block => block.type === "tool" && block.id === tool.id)
    source.revision++
    source.blocks = [...source.blocks, { type: "text", text: "A new independent answer fragment" }]
    await hydrateLive(id)
    const changed = acpStore.get().conversations[id]!
    const retainedAfterChange = changed.blocks.find(block => block.type === "tool" && block.id === tool.id)
    if (!process.argv.includes("--baseline")) {
      assert.equal(details - beforeDetails, 0, `${provider}: refresh must reuse expanded details`)
      assert.equal(retainedAfterChange, retainedBeforeChange, `${provider}: unrelated revisions preserve tool content`)
      assert.ok(bytes - beforeBytes < 512 * 1024, `${provider}: conditional refresh stays small`)
    }
    results.push({ provider, coldMs, refresh: auditStats(samples), refreshBytes: bytes - beforeBytes,
      refreshReads: reads - beforeReads, repeatedDetails: details - beforeDetails,
      detailSurvivesNewRevision: retainedAfterChange === retainedBeforeChange,
      loadedBlocks: changed.blocks.length })
    const readsBeforeStream = reads
    const firstBlock = changed.blocks[0]
    const streamStart = performance.now()
    for (let n = 1; n <= 1000; n++) applyLiveBatch({ id, epoch: source.epoch, revision: source.revision + n,
      updates: [{ kind: "text", id: "stream-performance", text: "token " }],
      changedFrom: source.blocks.length, blockCount: source.blocks.length + 1 })
    assert.equal(reads, readsBeforeStream, "Token streaming does not fetch history")
    assert.equal(acpStore.get().conversations[id]!.blocks[0], firstBlock, "Streaming retains older block references")
    console.log(`${provider}: 1,000 incremental batches ${(performance.now() - streamStart).toFixed(1)} ms, zero history reads`)
  } finally { bridge.mock.restore() }
}
const filename = process.argv.includes("--baseline") ? "baseline.json" : "after.json"
await writeFile(`${evidence}/${filename}`, JSON.stringify(results, null, 2) + "\n")
console.log(JSON.stringify(results, null, 2))
if (globalThis.gc) {
  acpStore.set({ conversations: {}, activeKey: null })
  const reader = new LiveHistoryReader()
  const sample = () => { globalThis.gc!(); return process.memoryUsage() }
  const retained = []
  const cpu = process.cpuUsage()
  const start = performance.now()
  for (let wave = 0; wave < 3; wave++) {
    for (let n = 0; n < 40; n++) {
      const source = auditSnapshot(1)
      source.session.id = auditId(20000 + wave * 40 + n)
      source.blocks[1] = { type: "tool", id: "unique", title: "Read", status: "completed",
        output: randomBytes(768 * 1024).toString("base64") }
      await reader.read(source.session.id, { kind: "snapshot" }, async () => source)
    }
    retained.push(sample())
  }
  assert.ok(retained[2]!.heapUsed - retained[0]!.heapUsed < 8 * 1024 * 1024, "Evicted conversations must not accumulate in the heap")
  assert.ok(retained[2]!.external - retained[0]!.external < 8 * 1024 * 1024, "External tool strings must not accumulate")
  await writeFile(`${evidence}/resources.json`, JSON.stringify({
    scenario: "120 unique 1 MiB histories, 40 per wave; forced GC after each wave; count-bounded cache",
    memoryBytes: retained, elapsedMs: performance.now() - start, cpu: process.cpuUsage(cpu),
  }, null, 2) + "\n")
}
Reflect.deleteProperty(globalThis, "window")
