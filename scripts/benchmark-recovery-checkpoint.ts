import assert from "node:assert/strict"
import { mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeCheckpoint } from "../electron/native-continuation.ts"

const root = await mkdtemp(join(tmpdir(), "mako-recovery-benchmark-"))
const source = join(root, "64-mib-native-record.jsonl")
try {
  const file = await open(source, "w")
  await file.truncate(64 * 1024 * 1024)
  await file.close()
  const timings: number[] = []
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  const start = performance.now()
  let baseline: string | undefined
  for (let index = 0; index < 1000; index++) {
    const before = performance.now()
    const checkpoint = await nativeCheckpoint(source)
    assert.ok(checkpoint)
    baseline ??= checkpoint
    assert.equal(checkpoint, baseline)
    timings.push(performance.now() - before)
  }
  const durationMs = performance.now() - start
  timings.sort((left, right) => left - right)
  console.log(JSON.stringify({ kind: "bounded checkpoint repeated-read benchmark", sourceBytes: 64 * 1024 * 1024, reads: timings.length, maxTailBytesPerRead: 65536, durationMs, p50Ms: timings[500], p95Ms: timings[950], p99Ms: timings[990], cpuMicros: process.cpuUsage(cpu), rssDeltaBytes: process.memoryUsage().rss - memory.rss, limits: "Sparse synthetic file on this filesystem; not a native ownership, whole-app or leak benchmark." }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
