import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { setTimeout as pause } from "node:timers/promises"
import { LiveJournal } from "../electron/live-journal"
import {
  LiveUpdateSchema,
  reduceLiveUpdates,
} from "@mako/sessions/live-content"
import { projectLive } from "../src/state/live-projection"
import {
  auditId,
  auditSnapshot,
  auditStats,
} from "./performance-audit-fixtures"

const root = await mkdtemp(join(tmpdir(), "mako-concurrent-streams-"))
const results = []
const updateBatch = LiveUpdateSchema.array()
for (const count of [1, 4, 8]) {
  const group = Array.from({ length: count }, (_, index) => {
    const snapshot = auditSnapshot(1000)
    snapshot.session.id = auditId(count * 100 + index)
    const journal = new LiveJournal(
      join(root, String(count)),
      snapshot.session.id
    )
    journal.commit(snapshot)
    return { snapshot, journal, projection: projectLive(snapshot) }
  })
  const work: number[] = []
  const writes: number[] = []
  const projections: number[] = []
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()
  try {
    for (let frame = 0; frame < 90; frame++) {
      const began = performance.now()
      for (const item of group) {
        const updates = updateBatch.parse(
          JSON.parse(
            JSON.stringify([{ kind: "text", id: "text-999", text: " delta" }])
          )
        )
        const previous = item.snapshot
        item.snapshot = {
          ...previous,
          revision: previous.revision + 1,
          blocks: reduceLiveUpdates(previous.blocks, updates),
        }
        const persist = performance.now()
        item.journal.commit(item.snapshot, previous)
        writes.push(performance.now() - persist)
        const project = performance.now()
        item.projection = projectLive(item.snapshot, item.projection)
        projections.push(performance.now() - project)
      }
      work.push(performance.now() - began)
      await pause(16)
    }
    for (const item of group)
      assert.deepEqual(item.journal.read()?.blocks, item.snapshot.blocks)
    results.push({
      conversations: count,
      historyTurnsEach: 1000,
      frames: work.length,
      combinedBatchWork: auditStats(work),
      journalPerConversation: auditStats(writes),
      projectionPerConversation: auditStats(projections),
      loopDelayP99Ms: lag.percentile(99) / 1e6,
      rssBytes: process.memoryUsage().rss,
    })
  } finally {
    lag.disable()
    for (const item of group) item.journal.close()
  }
}
await writeFile(
  join(root, "result.json"),
  JSON.stringify(
    {
      kind: "Synthetic production reduction, JSON validation, durable journal and projection; combined in one process, not provider network throughput",
      cpu: cpus()[0]?.model,
      results,
    },
    null,
    2
  )
)
console.log(JSON.stringify(results))
console.log(`Concurrent stream evidence: ${join(root, "result.json")}`)
for (const count of [1, 4, 8])
  await rm(join(root, String(count)), { recursive: true, force: true })
