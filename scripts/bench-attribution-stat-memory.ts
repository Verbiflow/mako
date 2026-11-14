import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { JournalStore, type StatRow } from "@mako/host/attribution/journal-store"
import type { StatCache } from "@mako/host/attribution/stat-cache"
import { makeSyntheticJournal } from "./lib/synthetic-journal.ts"

/*
 * The heap the tracker's stat caches take, every root's held as resuming them holds them, on a journal the size of
 * the person's (`node --expose-gc --import tsx scripts/bench-attribution-stat-memory.ts [--journal <file>]`): as the
 * `StatCache` columns the tracker keeps now, and as the `Map` of a row object each it kept before (the same rows).
 * On 2026-11-12 the person's tracker held 1,016,086 rows for 154 roots.
 */
const { values } = parseArgs({ options: { journal: { type: "string" } } })
const gc = globalThis.gc
if (!gc) throw new Error("Run with --expose-gc.")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-stat-memory-")))
const source = values.journal ?? join(scratch, "made.sqlite")
if (!values.journal) makeSyntheticJournal(source)
const file = join(scratch, "journal.sqlite")
execFileSync("cp", ["-c", source, file])
const store = JournalStore.open(file, { device: "bench" })
const roots = store.roots().map((root) => root.id)

const heap = () => {
  gc()
  const usage = process.memoryUsage()
  return usage.heapUsed + usage.arrayBuffers
}
function held<Value>(build: () => Value) {
  const before = heap()
  const started = performance.now()
  const value = build()
  const ms = performance.now() - started
  return { value, mb: (heap() - before) / 1024 / 1024, ms }
}

const packed = held(() => roots.map((root) => store.stats(root)))
const rows = packed.value.reduce((sum, cache: StatCache) => sum + cache.size, 0)
const asObjects = held(() => packed.value.map((cache) => new Map<string, StatRow>(cache)))
const report = {
  roots: roots.length,
  rows,
  statCacheMb: Math.round(packed.mb),
  statCacheBytesPerRow: Math.round((packed.mb * 1024 * 1024) / rows),
  // Built from the columns, so its path strings are the columns' own: the row objects and their Map alone.
  rowObjectsMbBesides: Math.round(asObjects.mb),
  loadMs: Math.round(packed.ms),
}
console.log(JSON.stringify(report))
console.log(`as row objects, the same rows would take ${Math.round(packed.mb + asObjects.mb)} MB (the paths shared); as columns ${Math.round(packed.mb)} MB`)
store.close()
rmSync(scratch, { recursive: true, force: true })
