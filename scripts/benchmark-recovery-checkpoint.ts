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
  const samples = []
  for (let index = 0; index < 100000; index++) {
    const before = performance.now()
    const checkpoint = await nativeCheckpoint(source)
    assert.ok(checkpoint)
    baseline ??= checkpoint
    assert.equal(checkpoint, baseline)
    timings.push(performance.now() - before)
    if ((index + 1) % 1000 === 0) samples.push({ reads: index + 1, elapsedMs: performance.now() - start, ...process.memoryUsage() })
  }
  const durationMs = performance.now() - start
  timings.sort((left, right) => left - right)
  console.log(JSON.stringify({ kind: "bounded checkpoint repeated-read benchmark", sourceBytes: 64 * 1024 * 1024, reads: timings.length, maxTailBytesPerRead: 65536, durationMs, p50Ms: timings[Math.floor(timings.length * .5)], p95Ms: timings[Math.floor(timings.length * .95)], p99Ms: timings[Math.floor(timings.length * .99)], cpuMicros: process.cpuUsage(cpu), rssDeltaBytes: process.memoryUsage().rss - memory.rss, peakRssBytes: Math.max(...samples.map(sample => sample.rss)), samples, limits: "Sparse synthetic file on this filesystem, natural GC, no performance threshold. Records allocation/CPU and latency over 100,000 reads; not a native ownership, whole-app or leak benchmark." }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
