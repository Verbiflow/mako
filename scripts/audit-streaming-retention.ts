import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getHeapStatistics } from "node:v8"
import { mock } from "node:test"
import { registeredHarnessIds } from "./registered-harnesses.ts"
import { auditId, auditSnapshot, auditStats } from "./performance-audit-fixtures.ts"

const output = process.env.MAKO_PERFORMANCE_EVIDENCE
if (!output) throw new Error("Set MAKO_PERFORMANCE_EVIDENCE to the evidence directory")
if (!globalThis.gc) throw new Error("Run with node --expose-gc to measure closed-conversation retention")
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge.ts")
const { getMako } = await import("../src/lib/bridge.ts")
const { acpStore, removeAcpConversation } = await import("../src/state/acp-state.ts")
const { applyLiveSnapshot, applyLiveBatch } = await import("../src/state/live-recovery.ts")
installMockBridge()
let historyReads = 0
const reads = mock.method(getMako(), "liveRead", async () => { historyReads++; throw new Error("Streaming must not fetch history") })
const memory = () => ({ ...process.memoryUsage(), heap: getHeapStatistics() })
async function collect() {
  // Completed async scopes must be released before measuring ownership.
  for (let index = 0; index < 3; index++) {
    await new Promise<void>(resolve => setImmediate(resolve))
    globalThis.gc!()
  }
  return memory()
}

async function stream(round: number, durationMs: number) {
  const states = registeredHarnessIds().map((harness, index) => {
    const snapshot = { ...auditSnapshot(80, harness, 128, 1024), epoch: `retention-${round}` }
    snapshot.session.id = auditId(30000 + round * 100 + index)
    applyLiveSnapshot(snapshot)
    return { id: snapshot.session.id, harness, epoch: snapshot.epoch, revision: snapshot.revision, blocks: snapshot.blocks.length,
      first: acpStore.get().conversations[snapshot.session.id]!.blocks[0], samples: new Array<number>(), count: 0 }
  })
  const cpu = process.cpuUsage(), start = performance.now()
  let batches = 0
  try {
    while (performance.now() - start < durationMs) {
      for (const state of states) {
        const before = performance.now()
        applyLiveBatch({ id: state.id, epoch: state.epoch, revision: ++state.revision,
          updates: [{ kind: "text", id: "sustained-stream", text: "token " }], changedFrom: state.blocks, blockCount: state.blocks + 1 })
        // Bounded measurement storage cannot itself produce sustained growth.
        state.samples[state.count++ % 2048] = performance.now() - before
        batches++
      }
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    assert.equal(historyReads, 0)
    for (const state of states) assert.equal(acpStore.get().conversations[state.id]!.blocks[0], state.first)
    const used = process.cpuUsage(cpu), elapsedMs = performance.now() - start
    return { round, elapsedMs, batches, during: memory(), cpuMicroseconds: used,
      cpuPercentOneCore: (used.user + used.system) / (elapsedMs * 10),
      perHarness: states.map(state => ({ harness: state.harness, totalSamples: state.count, ...auditStats(state.samples) })) }
  } finally { for (const state of states) removeAcpConversation(state.id) }
}

try {
  const baseline = await collect(), rounds = []
  for (let round = 0; round < 4; round++) {
    const result = await stream(round, round === 0 ? 10_000 : 20_000)
    const closed = await collect()
    assert.equal(Object.keys(acpStore.get().conversations).length, 0)
    rounds.push({ ...result, closed })
    console.log(JSON.stringify({ round, batches: result.batches, cpuPercentOneCore: result.cpuPercentOneCore, closedHeap: closed.heapUsed, closedRss: closed.rss }))
  }
  const warm = rounds[0]!.closed, retained = rounds.at(-1)!.closed
  const retainedHeapGrowth = retained.heapUsed - warm.heapUsed
  const budgets = { closedHeapGrowthBytes: 8 * 1024 * 1024, batchP95Ms: 1, cpuPercentOneCore: 10 }
  const result = { scenario: "Production state reducer, fixture transport; four distinct sets of six harness conversations, 80 exchanges each; 10s warmup then three 20s streaming/close cycles. Does not measure native agents, browser painting or preview workers.",
    historyReads, baseline, retainedHeapGrowth, retainedRssGrowth: retained.rss - warm.rss, budgets, rounds }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "streaming-retention.json"), JSON.stringify(result, null, 2) + "\n")
  assert.ok(retainedHeapGrowth <= budgets.closedHeapGrowthBytes, "Closed conversations exceed the 8 MiB warmed heap budget")
  for (const round of rounds.slice(1)) {
    assert.ok(round.cpuPercentOneCore <= budgets.cpuPercentOneCore, "Warmed pipeline exceeds 10% of one core")
    for (const harness of round.perHarness)
      assert.ok(harness.p95Ms <= budgets.batchP95Ms, `${harness.harness} exceeds the 1 ms reducer batch p95 budget`)
  }
  console.log("Streaming/close retention evidence saved; warmed heap, CPU and reducer latency budgets passed")
} finally { reads.mock.restore(); acpStore.set({ conversations: {}, activeKey: null }) }
