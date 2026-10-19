import { createHash } from "node:crypto"
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { ThreadRef } from "../packages/sessions/src/format.ts"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { NativeStores } from "../packages/sessions/src/read-only-sqlite.ts"
import { SAVED_HISTORY_READERS } from "../packages/sessions/src/readers.ts"
import { SessionCatalog } from "../packages/sessions/src/catalog.ts"
import { RecordBackfill } from "../packages/sessions/src/record-backfill.ts"
import { ENTRY_HEADER_BYTES } from "../packages/sessions/src/record-chunks.ts"
import { RecordCapture } from "../packages/sessions/src/record-capture.ts"
import { type CaptureInput, type CaptureReport, RecordStore } from "../packages/sessions/src/record-store.ts"
import { streamPath, streamsRoot } from "../packages/sessions/src/record-streams.ts"

/**
 * What the backfill costs on this Mac's own sessions: the newest sessions in
 * the rail (every harness, read read-only through `NativeStores`), taken
 * into a scratch record store as the catalog worker's backfill takes them,
 * while a live session is written beside it.
 *
 *   npm run bench:backfill                      the newest 200 sessions, at most 5 GiB of records
 *   npm run bench:backfill -- --sessions 50 --gib 1
 *   npm run bench:backfill -- --only <id> --no-live   one session, nothing written beside it
 *   npm run bench:backfill -- --keep            keep the scratch store (records.ts --store <dir> backfill)
 *   npm run bench:backfill -- --json
 *
 * Measures sessions/s and MiB/s taken, what the store keeps of it, peak
 * memory, the longest harness database read and the longest the event loop
 * was held, then how long a live capture waited for the store while the
 * backfill ran against a baseline with none running, and the second pass,
 * where every session is held at its stamp. The harnesses' stores are only
 * read; everything written goes under `$MAKO_THREAD_DATA_DIR` (or the temp
 * folder) and is removed unless `--keep`.
 */

const { values: options } = parseArgs({
  options: {
    sessions: { type: "string", default: "200" },
    gib: { type: "string", default: "5" },
    "live-ms": { type: "string", default: "50" },
    /** Only sessions whose native id starts with this, to look at one. */
    only: { type: "string" },
    /** No live session written beside the backfill. */
    "no-live": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
})
const limit = Number(options.sessions)
const budget = Number(options.gib) * 1024 ** 3
const liveEvery = Number(options["live-ms"])
const GIB = 1024 ** 3
const MIB = 1024 ** 2

const base = process.env.MAKO_THREAD_DATA_DIR ?? join(homedir(), ".mako", "tmp")
const scratch = join(base, `bench-backfill-${Date.now()}`)
const folder = join(scratch, "records")
mkdirSync(folder, { recursive: true })
const say = (text: string) => { if (!options.json) console.log(text) }

// The rail, read read-only: the same readers as the catalog worker, strict about never writing a harness's store.
const stores = new NativeStores(true)
const providers = SAVED_HISTORY_READERS.map((reader) => reader(stores))
const catalog = new SessionCatalog(providers, { readOnly: true })
const scanned = Date.now()
const rail = (await catalog.scan()).filter((ref) => !ref.archived)
say(`The rail: ${rail.length} sessions, discovered in ${Date.now() - scanned} ms`)

const ownerOf = (path: string): SessionProvider | null => providers.find((provider) => provider.roots().some((root) => path === root || path.startsWith(`${root}/`))) ?? null
const recordsOf = async (ref: ThreadRef) => {
  const records = (await ownerOf(ref.path)?.records(ref.path)) ?? null
  return records
}

/** What a session's records come to on disk: its own rows where the reader can say, else its files and databases whole. */
async function estimate(ref: ThreadRef): Promise<number> {
  const provider = ownerOf(ref.path)
  const own = provider?.recordBytes ? await provider.recordBytes(ref.path).catch(() => null) : null
  const records = await recordsOf(ref)
  if (!records) return 0
  const files = await Promise.all(records.files.map((path) => stat(path).then((info) => info.size, () => 0)))
  const databases = own ?? (await Promise.all(records.databases.map((database) => stat(database.path).then((info) => info.size, () => 0)))).reduce((sum, size) => sum + size, 0)
  return files.reduce((sum, size) => sum + size, 0) + databases
}

// Newest first, within the session and byte bounds; a session larger than what's left of the budget sits out.
const chosen: ThreadRef[] = []
const skipped: { ref: string; bytes: number }[] = []
let planned = 0
for (const ref of rail) {
  if (chosen.length >= limit) break
  if (options.only && !ref.nativeId.startsWith(options.only)) continue
  const bytes = await estimate(ref)
  if (planned + bytes > budget) {
    skipped.push({ ref: `${ref.harness} ${ref.nativeId}`, bytes })
    continue
  }
  planned += bytes
  chosen.push(ref)
}
const byHarness = new Map<string, number>()
for (const ref of chosen) byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
const free = (() => { const disk = statfsSync(folder); return disk.bavail * disk.bsize })()
say(`Chosen: ${chosen.length} sessions, about ${(planned / GIB).toFixed(2)} GiB of records (${[...byHarness].map(([harness, count]) => `${harness} ${count}`).join(", ")}); ${skipped.length} larger than the budget left sat out. The disk has ${(free / GIB).toFixed(1)} GiB free.`)

/**
 * The store, timing each capture of the live session from the moment it asks
 * for the store until its versions are committed. Alone, that's the
 * capture's own cost; beside the backfill, what it adds is the wait.
 */
const LIVE = "bench-live"
const waits: number[] = []
class TimedStore extends RecordStore {
  override async capture(input: CaptureInput): Promise<CaptureReport> {
    const asked = performance.now()
    const report = await super.capture(input)
    if (input.nativeId === LIVE) waits.push(performance.now() - asked)
    return report
  }
}
const store = new TimedStore(folder, new NativeStores(true))
const liveFile = join(scratch, "live.jsonl")
writeFileSync(liveFile, "")
const liveRef: ThreadRef = { harness: "claude", nativeId: LIVE, path: liveFile }
const capture = new RecordCapture(
  store,
  async (ref) => ref.nativeId === LIVE ? { roots: [{ name: "bench", path: scratch }], files: [liveFile], databases: [] } : recordsOf(ref),
  {
    home: homedir(), streams: streamsRoot(folder), stampOf: (ref) => catalog.stampOf(ref.path),
    rowBytesOf: async (ref) => (await ownerOf(ref.path)?.recordBytes?.(ref.path)) ?? null,
  }
)
const backfill = new RecordBackfill(capture, store, { sessions: () => chosen, listed: () => true, streams: streamsRoot(folder), log: () => {} })

// Streams of launches that ended, for the newest sessions, as drivers leave them: the pass takes them, then prunes them.
const STREAMED = Math.min(50, chosen.length)
for (const ref of chosen.slice(0, STREAMED)) {
  const path = streamPath(streamsRoot(folder), ref.harness, "2026-10-16T00-00-00-000Z-bench.jsonl", ref.nativeId)
  mkdirSync(join(path, ".."), { recursive: true })
  const frames = Array.from({ length: 120 }, (_, index) => `${JSON.stringify({ at: new Date().toISOString(), message: { method: "update", index, text: "x".repeat(200) } })}\n`).join("")
  writeFileSync(path, `${JSON.stringify({ capture: 1, harness: ref.harness, conversation: "bench", session: {}, writer: { id: "1-1", pid: process.pid } })}\n${frames}${JSON.stringify({ at: new Date().toISOString(), ended: true })}\n`)
}

/** Appends to the live session every `liveEvery` ms and tells capture, as a harness streaming a reply would, until `done`. */
async function writeLive(done: () => boolean): Promise<void> {
  let line = 0
  while (!done()) {
    appendFileSync(liveFile, `${JSON.stringify({ type: "assistant", line: line++, text: "x".repeat(400) })}\n`)
    capture.wrote(liveRef)
    await new Promise((resolve) => setTimeout(resolve, liveEvery))
  }
}

const percentile = (values: readonly number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

// Baseline: the live session alone, for as many captures as the pace allows in three seconds.
{
  const until = Date.now() + 3_000
  await writeLive(() => Date.now() >= until)
}
const alone = waits.splice(0)

// The backfill, with the live session written beside it the whole time.
const rssBefore = process.memoryUsage().rss
const heapBefore = process.memoryUsage().heapUsed
let peakRss = rssBefore
let peakHeap = heapBefore
const sampler = setInterval(() => {
  const memory = process.memoryUsage()
  peakRss = Math.max(peakRss, memory.rss)
  peakHeap = Math.max(peakHeap, memory.heapUsed)
}, 25)
const loop = monitorEventLoopDelay({ resolution: 5 })
loop.enable()
const started = performance.now()
let running = true
const live = options["no-live"] ? Promise.resolve() : writeLive(() => !running)
await backfill.wake("start")
running = false
await live
const took = performance.now() - started
loop.disable()
clearInterval(sampler)
const during = waits.splice(0)
const first = backfill.progress!
const stats = store.stats()

// The second pass: everything held at its stamp.
const again = performance.now()
await backfill.wake("start")
const second = backfill.progress!
const secondMs = performance.now() - again

// The repack, on the store the backfill wrote: as written, then after the person deleted a fifth of its sessions.
const sessionRuns = (harness: string, nativeId: string) => {
  // How a whole read of the session takes its chunks: in how many contiguous runs.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
  const db = new DatabaseSync(join(folder, "records.sqlite"), { readOnly: true })
  try {
    let runs = 0
    let chunks = 0
    let end = ""
    // Each chunk the first time it comes, as the repack counts them: a chunk named again is read from where it is.
    const seen = new Set<string>()
    for (const row of db.prepare(`SELECT v.chunks FROM sessions s JOIN session_units su ON su.session = s.id JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id WHERE s.harness = ? AND s.native_id = ? ORDER BY u.id, v.seq`).iterate(harness, nativeId)) {
      const list = Buffer.from(z.object({ chunks: z.instanceof(Uint8Array) }).parse(row).chunks)
      for (let at = 0; at < list.length; at += 32) {
        const hash = list.subarray(at, at + 32).toString("base64")
        if (seen.has(hash)) continue
        seen.add(hash)
        const place = z.object({ pack: z.number(), offset: z.number(), stored: z.number() }).optional().parse(db.prepare("SELECT pack, offset, stored FROM chunks WHERE hash = ?").get(list.subarray(at, at + 32)))
        if (!place) continue
        chunks += 1
        if (end !== `${place.pack}:${place.offset}`) runs += 1
        end = `${place.pack}:${place.offset + place.stored + ENTRY_HEADER_BYTES}`
      }
    }
    return { chunks, runs }
  } finally {
    db.close()
  }
}
const asWritten = await store.repack({ quietMs: 0 })
const doomed = chosen.filter((_, index) => index % 5 === 4)
const forgetStarted = performance.now()
for (const ref of doomed) await store.forget(ref.harness, ref.nativeId)
const forgetMs = performance.now() - forgetStarted
const afterDeletion = await store.repack({ quietMs: 0 })

// Live growth: sessions written a slice at a time side by side, as live capture takes them, then laid out by the repack.
const LIVE_SESSIONS = 20
// The largest transcripts, up to 8 MiB each: long sessions are the ones live capture spreads out.
const sizeOf = (path: string) => { try { return statSync(path).size } catch { return 0 } }
const growing = chosen.filter((ref) => ref.path.endsWith(".jsonl")).map((ref) => ({ ref, bytes: sizeOf(ref.path) })).sort((left, right) => right.bytes - left.bytes).slice(0, LIVE_SESSIONS).map((entry) => entry.ref)
const liveRoot = join(scratch, "live")
mkdirSync(liveRoot, { recursive: true })
const sources = growing.map((ref, index) => {
  const bytes = Buffer.alloc(Math.min(8 * MIB, sizeOf(ref.path)))
  const fd = openSync(ref.path, "r")
  try {
    readSync(fd, bytes, 0, bytes.length, 0)
  } finally {
    closeSync(fd)
  }
  return { id: `live-${index}`, bytes, path: join(liveRoot, `live-${index}.jsonl`) }
})
for (const source of sources) writeFileSync(source.path, "")
const SLICE = 64 * 1024
for (let at = 0; sources.some((source) => at < source.bytes.length); at += SLICE)
  for (const source of sources) {
    if (at >= source.bytes.length) continue
    appendFileSync(source.path, source.bytes.subarray(at, at + SLICE))
    await store.capture({ harness: "bench", nativeId: source.id, home: liveRoot, records: { roots: [{ name: "bench", path: liveRoot }], files: [source.path], databases: [] } })
  }
const readWhole = async (id: string) => {
  const started = performance.now()
  const digest = createHash("sha256")
  for (const unit of store.units("bench", id)) for await (const part of store.content("bench", unit.key)) digest.update(part)
  return { ms: performance.now() - started, digest: digest.digest("hex") }
}
const layouts = async () => {
  const found = []
  for (const source of sources) found.push({ ...sessionRuns("bench", source.id), read: await readWhole(source.id) })
  return found
}
const before = await layouts()
const grouping = await store.repack({ quietMs: 0 })
const after = await layouts()
for (const [index, source] of sources.entries()) {
  if (after[index]!.read.digest !== before[index]!.read.digest || after[index]!.read.digest !== createHash("sha256").update(readFileSync(source.path)).digest("hex"))
    throw new Error(`${source.id} reads back otherwise after the repack`)
}
const median = (values: number[]) => percentile(values, 50)

await capture.stop()
await catalog.stop()
const ms = (value: number) => Math.round(value * 10) / 10
const result = {
  rail: rail.length,
  sessions: chosen.length,
  byHarness: Object.fromEntries(byHarness),
  first: {
    ms: Math.round(took),
    ownMs: first.ms,
    yieldedMs: first.yieldedMs,
    captured: first.captured, held: first.held, live: first.live, refused: first.refused, failed: first.failed, gone: first.gone,
    sessionsPerSecond: ms(first.captured / (took / 1000)),
    readMiBPerSecond: ms(first.newBytes / MIB / (took / 1000)),
    newMiB: ms(first.newBytes / MIB),
    storedMiB: ms(first.storedBytes / MIB),
    longestSessionMs: first.longestMs,
    longestSession: first.longest,
    longestDatabaseReadMs: first.longestReadMs,
    eventLoopMaxMs: ms(loop.max / 1e6),
    eventLoopP99Ms: ms(loop.percentile(99) / 1e6),
    rssBeforeMiB: ms(rssBefore / MIB),
    peakRssMiB: ms(peakRss / MIB),
    heapBeforeMiB: ms(heapBefore / MIB),
    peakHeapMiB: ms(peakHeap / MIB),
    firstFailure: first.firstFailure ?? null,
  },
  store: { chunks: stats.chunks, distinctMiB: ms(stats.bytes / MIB), storedMiB: ms(stats.stored / MIB) },
  liveWait: {
    alone: { captures: alone.length, p50: ms(percentile(alone, 50)), p99: ms(percentile(alone, 99)), max: ms(Math.max(0, ...alone)) },
    duringBackfill: { captures: during.length, p50: ms(percentile(during, 50)), p99: ms(percentile(during, 99)), max: ms(Math.max(0, ...during)) },
  },
  second: { ms: Math.round(secondMs), held: second.held, captured: second.captured, perSessionMs: ms(secondMs / Math.max(1, second.sessions)), repackMs: second.repack?.ms ?? 0 },
  streams: { written: STREAMED, prune: first.prune ?? null, secondPassCaptured: second.captured },
  repack: {
    asWritten: { ms: asWritten.ms, grouped: asWritten.grouped, alreadyGrouped: asWritten.alreadyGrouped, copiedMiB: ms(asWritten.copiedBytes / MIB), longestTurnMs: asWritten.longestTurnMs, packMiB: ms(asWritten.packBytesAfter / MIB) },
    afterDeletion: { sessionsForgotten: doomed.length, forgetMs: Math.round(forgetMs), ms: afterDeletion.ms, dropped: afterDeletion.dropped, reclaimedMiB: ms((afterDeletion.packBytesBefore - afterDeletion.packBytesAfter) / MIB), droppedMiB: ms(afterDeletion.droppedBytes / MIB), scrubbedMiB: ms(afterDeletion.scrubbedBytes / MIB), copiedMiB: ms(afterDeletion.copiedBytes / MIB), packsRemoved: afterDeletion.packsRemoved, longestTurnMs: afterDeletion.longestTurnMs, packMiBBefore: ms(afterDeletion.packBytesBefore / MIB), packMiBAfter: ms(afterDeletion.packBytesAfter / MIB) },
    liveGrowth: {
      sessions: sources.length, readMiB: ms(sources.reduce((sum, source) => sum + source.bytes.length, 0) / MIB),
      ms: grouping.ms, grouped: grouping.grouped, copiedMiB: ms(grouping.copiedBytes / MIB), longestTurnMs: grouping.longestTurnMs,
      runsBefore: median(before.map((entry) => entry.runs)), runsAfter: median(after.map((entry) => entry.runs)), chunks: median(before.map((entry) => entry.chunks)),
      readMsBefore: ms(before.reduce((sum, entry) => sum + entry.read.ms, 0)), readMsAfter: ms(after.reduce((sum, entry) => sum + entry.read.ms, 0)),
    },
  },
}

if (options.json) console.log(JSON.stringify(result, null, 2))
else {
  const f = result.first
  console.log(`First pass: ${f.captured} sessions taken in ${(f.ms / 1000).toFixed(1)} s (${f.sessionsPerSecond} sessions/s, ${f.readMiBPerSecond} MiB/s read), ${f.yieldedMs} ms yielded to the live session; ${f.held} already held, ${f.refused} refused for disk, ${f.failed} failed${f.firstFailure ? ` (first: ${f.firstFailure})` : ""}`)
  console.log(`  ${f.newMiB} MiB read → ${f.storedMiB} MiB stored; the store holds ${result.store.distinctMiB} MiB of distinct chunks in ${result.store.storedMiB} MiB`)
  console.log(`  longest session ${f.longestSessionMs} ms (${f.longestSession}), longest harness database read ${f.longestDatabaseReadMs} ms, event loop held at most ${f.eventLoopMaxMs} ms (p99 ${f.eventLoopP99Ms} ms), RSS ${f.rssBeforeMiB} MiB before (the catalog of the whole rail) and ${f.peakRssMiB} MiB at most during; V8 heap ${f.heapBeforeMiB} MiB before, ${f.peakHeapMiB} MiB at most`)
  const { alone: a, duringBackfill: d } = result.liveWait
  console.log(`A live capture, from asking for the store to committed: alone p50 ${a.p50} ms, p99 ${a.p99} ms (${a.captures} captures); during the backfill p50 ${d.p50} ms, p99 ${d.p99} ms, max ${d.max} ms (${d.captures} captures)`)
  console.log(`Second pass: ${result.second.held} held at their stamps, ${result.second.captured} taken again, in ${result.second.ms} ms (${result.second.perSessionMs} ms a session)`)
  const p = result.streams.prune
  if (p) console.log(`Streams: ${p.pruned} of ${result.streams.written} ended streams pruned (${p.prunedEnded} by their ended line) in ${p.ms} ms, ${p.restamped} sessions restamped; the second pass took ${result.streams.secondPassCaptured} captures`)
  const r = result.repack
  console.log(`The pass after (walk, prune and repack check): ${result.second.ms} ms, of which the repack ${result.second.repackMs} ms`)
  console.log(`Repack as the backfill wrote it: ${r.asWritten.alreadyGrouped} sessions laid out already, ${r.asWritten.grouped} grouped (${r.asWritten.copiedMiB} MiB copied) in ${r.asWritten.ms} ms, the store's turn held at most ${r.asWritten.longestTurnMs} ms`)
  console.log(`After deleting ${r.afterDeletion.sessionsForgotten} sessions (forget ${r.afterDeletion.forgetMs} ms): ${r.afterDeletion.dropped} chunks dropped (${r.afterDeletion.droppedMiB} MiB stored, ${r.afterDeletion.scrubbedMiB} MiB overwritten in place), packs ${r.afterDeletion.packMiBBefore} → ${r.afterDeletion.packMiBAfter} MiB (${r.afterDeletion.reclaimedMiB} MiB reclaimed, ${r.afterDeletion.copiedMiB} MiB copied, ${r.afterDeletion.packsRemoved} packs removed) in ${r.afterDeletion.ms} ms, the turn held at most ${r.afterDeletion.longestTurnMs} ms`)
  console.log(`Live growth: ${r.liveGrowth.sessions} sessions (${r.liveGrowth.readMiB} MiB) written 64 KiB at a time side by side; median ${r.liveGrowth.chunks} chunks in ${r.liveGrowth.runsBefore} runs → ${r.liveGrowth.runsAfter} after the repack (${r.liveGrowth.grouped} grouped, ${r.liveGrowth.copiedMiB} MiB copied in ${r.liveGrowth.ms} ms, turn at most ${r.liveGrowth.longestTurnMs} ms); reading all of them whole ${r.liveGrowth.readMsBefore} → ${r.liveGrowth.readMsAfter} ms (warm page cache)`)
}
if (options.keep) say(`Kept: ${folder} (npx tsx scripts/records.ts --store ${folder} stats)`)
else rmSync(scratch, { recursive: true, force: true })
