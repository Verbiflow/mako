import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import { getHeapStatistics } from "node:v8"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { nodeFileSystem } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"

/*
 * What the journal's writer holds in memory (`node --expose-gc --import tsx scripts/bench-attribution-writer-memory.ts
 * [--roots 150] [--files 6500] [--wake 10]`): a journal of `--roots` tracked roots with `--files` stat rows each, the
 * size of the person's on 2026-11-17 (153 roots, 994,166 rows), opened as the writer's worker opens it. Prints the
 * heap and the process's resident size with every root asleep, then with `--wake` of them awake, and what one awake
 * root's stat cache takes. The roots that wake are real folders of `--files` files; the rest are rows.
 */
const { values } = parseArgs({ options: { roots: { type: "string", default: "150" }, files: { type: "string", default: "6500" }, wake: { type: "string", default: "10" } } })
const ROOTS = Number(values.roots)
const FILES = Number(values.files)
const WAKE = Number(values.wake)
const gc = globalThis.gc
if (!gc) throw new Error("Run with --expose-gc.")

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-writer-memory-")))
const storage = join(scratch, "storage")
mkdirSync(storage)
const folder = (index: number) => join(scratch, `root-${index}`)
const name = (file: number) => `packages/module-${Math.floor(file / 100)}/file-with-a-longer-name-${file}.ts`
for (let index = 0; index < ROOTS; index++) {
  mkdirSync(folder(index))
  if (index >= WAKE) continue
  for (let file = 0; file < FILES; file++) {
    if (file % 100 === 0) mkdirSync(join(folder(index), "packages", `module-${Math.floor(file / 100)}`), { recursive: true })
    writeFileSync(join(folder(index), name(file)), `export const value${file} = ${file}\n`)
  }
}

const measure = () => {
  gc()
  const usage = process.memoryUsage()
  const heap = getHeapStatistics()
  return { heapMb: usage.heapUsed / 2 ** 20, buffersMb: usage.arrayBuffers / 2 ** 20, rssMb: usage.rss / 2 ** 20, heapLimitMb: heap.heap_size_limit / 2 ** 20 }
}
const line = (label: string, at: ReturnType<typeof measure>, from?: ReturnType<typeof measure>) =>
  console.log(`${label}: heap ${at.heapMb.toFixed(1)} MB, typed arrays ${at.buffersMb.toFixed(1)} MB, resident ${at.rssMb.toFixed(0)} MB` +
    (from ? ` (${(at.heapMb + at.buffersMb - from.heapMb - from.buffersMb).toFixed(1)} MB of heap and arrays, ${(at.rssMb - from.rssMb).toFixed(0)} MB resident, more)` : ""))

const clock = new FakeClock(Date.now())
const events = new FakeEventSource()
const ports = { fs: nodeFileSystem(), events, clock, storage, device: "bench" }
// The roots that wake are tracked for real, so their rows are the files' own; the rest get rows of the same shape.
const first = await LaptopTracker.open(ports)
for (let index = 0; index < WAKE; index++) await first.track({ id: `root-${index}`, path: folder(index), kind: "workspace" })
await first.settled()
await first.close()
const raw = new DatabaseSync(join(storage, "journal.sqlite"))
raw.exec("BEGIN")
const root = raw.prepare("INSERT INTO roots (id, path, kind, repository, seen_at, tracked_at, active) VALUES (?, ?, 'workspace', 0, ?, ?, 1)")
const stat = raw.prepare("INSERT INTO stats (root, path, dev, ino, size, mode, mtime_ns, ctime_ns, ref, checked_ns) VALUES (?, ?, 16777230, ?, 40, 33188, ?, ?, ?, ?)")
const stamp = BigInt(Date.now()) * 1_000_000n
for (let index = WAKE; index < ROOTS; index++) {
  root.run(`root-${index}`, folder(index), clock.now(), clock.now())
  for (let file = 0; file < FILES; file++) stat.run(`root-${index}`, name(file), index * FILES + file, stamp, stamp, file % 5 ? `sha256:${(index * FILES + file).toString(16).padStart(64, "0")}` : null, stamp)
}
raw.exec("COMMIT")
const rows = raw.prepare("SELECT count(*) AS count FROM stats").get()?.count
raw.close()

const before = measure()
const tracker = await LaptopTracker.open(ports)
await tracker.settled()
const asleep = measure()
const started = performance.now()
for (let index = 0; index < WAKE; index++) await tracker.track({ id: `root-${index}`, path: folder(index), kind: "workspace" })
await tracker.settled()
const wokeMs = performance.now() - started
const awake = measure()
// One root's cache alone, read as a wake reads it.
const one = measure()
const cache = tracker.store.stats("root-0")
const held = measure()
console.log(`${ROOTS} roots, ${rows} stat rows, ${WAKE} woken in ${wokeMs.toFixed(0)} ms (heap limit ${before.heapLimitMb.toFixed(0)} MB)`)
line("before the journal opens", before)
line("open, every root asleep", asleep, before)
line(`${WAKE} roots awake`, awake, asleep)
line(`one root's stat cache (${cache.size} rows)`, held, one)
console.log(`a row of an awake root: ${(((awake.heapMb + awake.buffersMb - asleep.heapMb - asleep.buffersMb) * 2 ** 20) / (WAKE * FILES)).toFixed(0)} bytes`)
await tracker.close()
rmSync(scratch, { recursive: true, force: true })
