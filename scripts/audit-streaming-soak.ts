import assert from "node:assert/strict"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mock } from "node:test"
import { registeredHarnessIds } from "./registered-harnesses.ts"
import { auditId, auditSnapshot, auditStats } from "./performance-audit-fixtures.ts"

const output = process.env.MAKO_PERFORMANCE_EVIDENCE
if (!output) throw new Error("Set MAKO_PERFORMANCE_EVIDENCE to the private evidence directory")
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge.ts")
const { getMako } = await import("../src/lib/bridge.ts")
const { acpStore } = await import("../src/state/acp-state.ts")
const { applyLiveSnapshot, applyLiveBatch } = await import("../src/state/live-recovery.ts")
installMockBridge()
let historyReads = 0
const reads = mock.method(getMako(), "liveRead", async () => { historyReads++; throw new Error("Streaming must not fetch history") })
const states = registeredHarnessIds().map((harness, index) => {
  const snapshot = { ...auditSnapshot(80, harness, 128, 1024), epoch: "stream-soak" }
  snapshot.session.id = auditId(30000 + index)
  applyLiveSnapshot(snapshot)
  return { id: snapshot.session.id, harness, revision: snapshot.revision, blocks: snapshot.blocks.length, first: acpStore.get().conversations[snapshot.session.id]!.blocks[0], samples: new Array<number>() }
})
const delay = monitorEventLoopDelay({ resolution: 10 })
delay.enable()
globalThis.gc?.()
const baseline = process.memoryUsage()
const cpu = process.cpuUsage()
const start = performance.now()
const memory = []
let lastSample = start, batches = 0
try {
  while (performance.now() - start < 60_000) {
    for (const state of states) {
      const before = performance.now()
      applyLiveBatch({ id: state.id, epoch: "stream-soak", revision: ++state.revision,
        updates: [{ kind: "text", id: "sustained-stream", text: "token " }],
        changedFrom: state.blocks, blockCount: state.blocks + 1 })
      state.samples.push(performance.now() - before)
      batches++
    }
    const now = performance.now()
    if (now - lastSample >= 1000) { memory.push({ elapsedMs: now - start, ...process.memoryUsage() }); lastSample = now }
    // Pace synthetic arrivals at ~100 batches/second per harness rather than a
    // tight loop. This is a state-pipeline soak, not browser/native throughput.
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  assert.equal(historyReads, 0)
  for (const state of states) assert.equal(acpStore.get().conversations[state.id]!.blocks[0], state.first)
  globalThis.gc?.()
  const retained = process.memoryUsage()
  const used = process.cpuUsage(cpu)
  await mkdir(output, { recursive: true })
  const result = { scenario: "Six registered harnesses; 80 retained exchanges each, paced token updates for 60 seconds; production state reducer with fixture transport; no native agent, browser painting or worker CPU", elapsedMs: performance.now() - start, batches, historyReads, baseline, retained, memory, cpuMicroseconds: used,
    eventLoopDelayMs: { mean: delay.mean / 1e6, p95: delay.percentile(95) / 1e6, max: delay.max / 1e6 },
    perHarness: states.map(state=>({ harness:state.harness, ...auditStats(state.samples) })) }
  await writeFile(join(output, "streaming-soak.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify({ ...result, memory: `${memory.length} recorded samples` }, null, 2))
} finally { reads.mock.restore(); delay.disable(); acpStore.set({ conversations: {}, activeKey: null }) }
