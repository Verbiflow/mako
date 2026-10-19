import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import { z } from "zod"
import { SessionArchive, archiveMigrationStatus } from "../packages/sessions/src/archive.ts"
import { ArchiveMigration, type ArchiveMigrationReport } from "../packages/sessions/src/archive-migration.ts"
import { SessionCatalog } from "../packages/sessions/src/catalog.ts"
import { DecodeAside } from "../packages/sessions/src/decode-aside.ts"
import { threadIdentity, type ThreadRef } from "../packages/sessions/src/format.ts"
import { NativeStores } from "../packages/sessions/src/read-only-sqlite.ts"
import { SAVED_HISTORY_READERS } from "../packages/sessions/src/readers.ts"

/**
 * The archive's migration on a clone of this Mac's own archive.
 *
 *   npm run bench:archive-migration                 at most 3 GiB of the newest archived sessions held first
 *   npm run bench:archive-migration -- --gib 1 --json
 *   npm run bench:archive-migration -- --keep       keep the scratch folder
 *
 * The archive (`~/.mako/archive/archive.sqlite` and its legacy folders) is
 * copied with SQLite's `VACUUM INTO` from a read-only connection, never
 * opened for writing. The rail is read through the catalog's own readers,
 * every harness store read-only (`NativeStores`). Into a scratch record
 * store the catalog holds the newest archived sessions whose harness still
 * has them, up to `--gib` of their records, as the backfill would; then:
 *
 * 1. Where each row stands: its harness still has it, the store holds it,
 *    or nothing else does (the copies that stay), by harness.
 * 2. The migration pass itself on the clone: rows dropped, copies noted,
 *    what's left pending, time, peak memory, the longest the event loop was
 *    held, and the archive's bytes before and after reclaiming.
 * 3. A second pass, which must change nothing.
 * 4. The whole migration as it will end once the backfill holds every
 *    session: every row whose harness has it dropped, then reclaimed.
 * 5. Opening a kept copy (its first page) before and after.
 *
 * Everything written goes under `$MAKO_THREAD_DATA_DIR` and is removed unless `--keep`.
 */

const { values: options } = parseArgs({
  options: {
    gib: { type: "string", default: "3" },
    /** Sessions past this many MiB of records aren't held first, so the budget covers more rows. */
    "max-session-mib": { type: "string", default: "64" },
    source: { type: "string", default: join(homedir(), ".mako", "archive") },
    sample: { type: "string", default: "60" },
    keep: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
})
const MIB = 1024 ** 2
const GIB = 1024 ** 3
const budget = Number(options.gib) * GIB
const say = (text: string) => { if (!options.json) console.log(text) }
const ms = (value: number) => Math.round(value * 10) / 10
const mib = (bytes: number) => Math.round((bytes / MIB) * 10) / 10
const percentile = (values: readonly number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}
const fileBytes = (path: string) => ["", "-wal"].reduce((sum, suffix) => sum + (statSync(`${path}${suffix}`, { throwIfNoEntry: false })?.size ?? 0), 0)

const source = join(options.source, "archive.sqlite")
if (!existsSync(source)) throw new Error(`No archive at ${source}`)
const base = process.env.MAKO_THREAD_DATA_DIR ?? join(homedir(), ".mako", "tmp")
const scratch = join(base, `bench-archive-migration-${Date.now()}`)
const archivePath = join(scratch, "archive")
mkdirSync(archivePath, { recursive: true })

// 0. The clone: SQLite's own consistent copy from a read-only connection, and the legacy folders beside it.
const sourceBytes = fileBytes(source)
const free = (() => { const disk = statfsSync(scratch); return disk.bavail * disk.bsize })()
if (free < sourceBytes * 2 + budget + 2 * GIB) throw new Error(`The disk has ${(free / GIB).toFixed(1)} GiB free; the clone needs about ${((sourceBytes * 2 + budget) / GIB + 2).toFixed(1)} GiB`)
const cloneStarted = performance.now()
{
  const reader = new DatabaseSync(source, { readOnly: true })
  try {
    reader.exec("PRAGMA busy_timeout=5000")
    reader.prepare("VACUUM INTO ?").run(join(archivePath, "archive.sqlite"))
  } finally {
    reader.close()
  }
  for (const name of readdirSync(options.source)) if (/^[0-9a-f]{24}$/.test(name)) cpSync(join(options.source, name), join(archivePath, name), { recursive: true })
}
const cloneMs = performance.now() - cloneStarted
const cloneBytes = fileBytes(join(archivePath, "archive.sqlite"))
say(`The archive: ${mib(sourceBytes)} MiB with its write-ahead log, cloned into ${mib(cloneBytes)} MiB in ${(cloneMs / 1000).toFixed(1)} s`)

// The rail, read read-only, with a scratch record store and view store.
const stores = new NativeStores(true)
const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores)), {
  archivePath, recordsPath: join(scratch, "records"), viewsPath: join(scratch, "views"), cachePath: join(scratch, "cache.json"),
  readBack: { readers: SAVED_HISTORY_READERS, stores }, decodeAside: new DecodeAside(),
})
const scanned = performance.now()
const rail = await catalog.scan()
const live = rail.filter((ref) => !ref.archived)
const undiscovered = [...catalog.undiscoveredHarnesses]
say(`The rail: ${rail.length} rows, ${live.length} from their harness, discovered in ${Math.round(performance.now() - scanned)} ms${undiscovered.length ? `; discovery failed for ${undiscovered.join(", ")}, whose rows wait` : ""}`)

// 1. Where each row stands.
const archive = new SessionArchive(archivePath, { readOnly: true })
await archive.load()
const rows = archive.copies()
await archive.stop()
const byPath = new Map(live.map((ref) => [ref.path, ref]))
const byIdentity = new Map(live.map((ref) => [threadIdentity(ref), ref]))
const listedOf = (ref: ThreadRef): ThreadRef | undefined => byPath.get(ref.path) ?? byIdentity.get(threadIdentity(ref))
const waits = (ref: ThreadRef) => !listedOf(ref) && undiscovered.includes(ref.harness)
const rowBytes = (() => {
  const db = new DatabaseSync(join(archivePath, "archive.sqlite"), { readOnly: true })
  try {
    return new Map(z.object({ path: z.string(), bytes: z.number() }).array().parse(db.prepare("SELECT path, length(entries) + length(ref) AS bytes FROM sessions").all()).map((row) => [row.path, row.bytes]))
  } finally {
    db.close()
  }
})()
type Standing = "harness" | "copy" | "child"
const standing = new Map<string, Standing>()
const table: Record<string, Record<Standing, number>> = {}
for (const ref of rows) {
  const kind: Standing = ref.childOf ? "child" : listedOf(ref) || waits(ref) ? "harness" : "copy"
  standing.set(ref.path, kind)
  const row = (table[ref.harness] ??= { harness: 0, copy: 0, child: 0 })
  row[kind] += 1
}
const sum = (kind: Standing) => Object.values(table).reduce((total, row) => total + row[kind], 0)
const bytesOf = (kind: Standing) => rows.filter((ref) => standing.get(ref.path) === kind).reduce((total, ref) => total + (rowBytes.get(ref.path) ?? 0), 0)
say(`Rows: ${rows.length}; their harness still has ${sum("harness")} (${mib(bytesOf("harness"))} MiB), nothing else holds ${sum("copy")} (${mib(bytesOf("copy"))} MiB), child agents ${sum("child")}`)
for (const [harness, row] of Object.entries(table)) say(`  ${harness}: ${row.harness} still in the harness, ${row.copy} copies only, ${row.child} children`)

// 5, before: a kept copy's first page, cold, as the rail opens it.
const copies = rows.filter((ref) => standing.get(ref.path) === "copy")
const largest = [...copies].sort((a, b) => (rowBytes.get(b.path) ?? 0) - (rowBytes.get(a.path) ?? 0)).slice(0, 5)
const sample = [...new Map([...copies.slice(0, Number(options.sample)), ...largest].map((ref) => [ref.path, ref])).values()]
async function opens(over: SessionCatalog = catalog): Promise<{ p50: number; p95: number; max: number; largestMs: number }> {
  const times: number[] = []
  let largestMs = 0
  for (const ref of sample) {
    const started = performance.now()
    const page = await over.page(ref.path, undefined, 100)
    const took = performance.now() - started
    if (!page) throw new Error(`A kept copy didn't open: ${ref.path}`)
    times.push(took)
    if (ref.path === largest[0]?.path) largestMs = took
  }
  return { p50: ms(percentile(times, 50)), p95: ms(percentile(times, 95)), max: ms(Math.max(0, ...times)), largestMs: ms(largestMs) }
}
const openedBefore = await opens()
say(`A kept copy's first page, before: p50 ${openedBefore.p50} ms, p95 ${openedBefore.p95} ms, max ${openedBefore.max} ms (the largest, ${mib(rowBytes.get(largest[0]?.path ?? "") ?? 0)} MiB: ${openedBefore.largestMs} ms), over ${sample.length}`)

// The backfill's part: the newest archived sessions their harness has, held up to the budget.
const ownerOf = (path: string) => SAVED_HISTORY_READERS.map((reader) => reader(stores)).find((provider) => provider.roots().some((root) => path === root || path.startsWith(`${root}/`)))
async function estimate(ref: ThreadRef): Promise<number> {
  const provider = ownerOf(ref.path)
  const own = provider?.recordBytes ? await provider.recordBytes(ref.path).catch(() => null) : null
  const records = provider ? await provider.records(ref.path).catch(() => null) : null
  if (!records) return 0
  const files = await Promise.all(records.files.map((path) => stat(path).then((info) => info.size, () => 0)))
  const databases = own ?? (await Promise.all(records.databases.map((database) => stat(database.path).then((info) => info.size, () => 0)))).reduce((total, size) => total + size, 0)
  return files.reduce((total, size) => total + size, 0) + databases
}
let planned = 0
let held = 0
const holdStarted = performance.now()
for (const ref of rows) {
  const listed = standing.get(ref.path) === "harness" ? listedOf(ref) : undefined
  if (!listed) continue
  const bytes = await estimate(listed)
  if (bytes > Number(options["max-session-mib"]) * MIB || planned + bytes > budget) continue
  planned += bytes
  if (await catalog.hold(listed.path)) held += 1
}
const holdMs = performance.now() - holdStarted
say(`Held first, as the backfill would: ${held} sessions, about ${mib(planned)} MiB of records, in ${(holdMs / 1000).toFixed(1)} s`)

// 2. The pass.
let peakRss = process.memoryUsage().rss
let peakHeap = process.memoryUsage().heapUsed
const rssBefore = peakRss
const sampler = setInterval(() => {
  const memory = process.memoryUsage()
  peakRss = Math.max(peakRss, memory.rss)
  peakHeap = Math.max(peakHeap, memory.heapUsed)
}, 25)
const loop = monitorEventLoopDelay({ resolution: 5 })
loop.enable()
const passStarted = performance.now()
const first = await catalog.migrateArchive()
const passMs = performance.now() - passStarted
loop.disable()
clearInterval(sampler)
if (!first) throw new Error("The migration didn't run")
const afterPassBytes = fileBytes(join(archivePath, "archive.sqlite"))
say(describe("The pass", first, passMs))
say(`  peak RSS ${mib(peakRss)} MiB (${mib(rssBefore)} before), peak heap ${mib(peakHeap)} MiB; the event loop held at most ${ms(loop.max / 1e6)} ms (p99 ${ms(loop.percentile(99) / 1e6)} ms)`)

// 3. Again: nothing changes.
const againStarted = performance.now()
const second = await catalog.migrateArchive()
const againMs = performance.now() - againStarted
// Nothing it settled changes; a row whose decode failed is asked again, and may go now.
if (!second || second.migrated > first.failed || second.newCopies || second.legacyFolded || second.legacyRemoved) throw new Error(`The second pass changed something: ${JSON.stringify(second)}`)
say(`A second pass: ${second.rows} rows looked at in ${Math.round(againMs)} ms; nothing it settled changed${second.migrated ? `, and ${second.migrated} of the ${first.failed} whose decode failed read this time and went` : ""}`)

// 5, after.
const openedAfter = await opens()
say(`A kept copy's first page, after: p50 ${openedAfter.p50} ms, p95 ${openedAfter.p95} ms, max ${openedAfter.max} ms (the largest: ${openedAfter.largestMs} ms)`)
await catalog.stop()

// 4. The whole migration, once every session the harness has is held: those rows dropped, and the space reclaimed.
const whole = new SessionArchive(archivePath)
const liveSessions = new Set(live.map((ref) => `${ref.harness}\n${ref.nativeId}`))
const wholeLoop = monitorEventLoopDelay({ resolution: 5 })
wholeLoop.enable()
const wholeStarted = performance.now()
const all = await new ArchiveMigration(whole, {
  live: () => live,
  discovered: () => true,
  // Every session its harness has is held; none its harness deleted is (this Mac's store kept none before the harness deleted them).
  captured: (ref) => liveSessions.has(`${ref.harness}\n${ref.nativeId}`),
  decodesNative: async () => 1,
  decodesRecords: async () => null,
  keepListing: async () => true,
}).pass({ stopped: () => false, yieldToPerson: async () => {} })
const wholeMs = performance.now() - wholeStarted
wholeLoop.disable()
await whole.stop()
const status = archiveMigrationStatus(archivePath)
// 5, at the end: the kept copies, from the archive as the whole migration leaves it.
const reader = new SessionCatalog([], { archivePath, readOnly: true })
await reader.prepare()
const openedEnd = await opens(reader)
await reader.stop()
say(describe("All of it, once held (decoding skipped)", all, wholeMs))
say(`  the event loop held at most ${ms(wholeLoop.max / 1e6)} ms; the archive ends at ${mib(fileBytes(join(archivePath, "archive.sqlite")))} MiB: ${status?.copies} copies, ${status?.pending} pending (children)`)
say(`A kept copy's first page, from the archive the whole migration leaves: p50 ${openedEnd.p50} ms, p95 ${openedEnd.p95} ms, max ${openedEnd.max} ms (the largest: ${openedEnd.largestMs} ms)`)

// 6. The attachment bytes earlier builds saved beside the copies (`assets/`): what the copies left still name.
const assetsFolder = join(options.source, "assets")
const assetSizes = new Map(existsSync(assetsFolder) ? readdirSync(assetsFolder).map((name) => [name, statSync(join(assetsFolder, name)).size] as const) : [])
const named = new Set<string>()
{
  const db = new DatabaseSync(join(archivePath, "archive.sqlite"), { readOnly: true })
  try {
    const assetName = /\/archive\/assets\/([^"\\/]+)/g
    for (const row of db.prepare("SELECT entries FROM sessions").iterate()) {
      for (const match of z.object({ entries: z.string() }).parse(row).entries.matchAll(assetName)) named.add(match[1]!)
    }
  } finally {
    db.close()
  }
}
const assetBytes = [...assetSizes.values()].reduce((total, size) => total + size, 0)
const namedBytes = [...named].reduce((total, name) => total + (assetSizes.get(name) ?? 0), 0)
say(`Attachments saved beside copies: ${assetSizes.size} files, ${mib(assetBytes)} MiB; the copies left name ${named.size} of them (${mib(namedBytes)} MiB)`)

const result = {
  archive: { sourceMiB: mib(sourceBytes), cloneMiB: mib(cloneBytes), cloneMs: Math.round(cloneMs), rows: rows.length, byHarness: table, stillInHarness: sum("harness"), copiesOnly: sum("copy"), children: sum("child") },
  held: { sessions: held, recordsMiB: mib(planned), ms: Math.round(holdMs) },
  pass: { ...summary(first), ms: Math.round(passMs), archiveMiBAfter: mib(afterPassBytes), peakRssMiB: mib(peakRss), rssBeforeMiB: mib(rssBefore), peakHeapMiB: mib(peakHeap), eventLoopMaxMs: ms(loop.max / 1e6), eventLoopP99Ms: ms(loop.percentile(99) / 1e6) },
  again: { ms: Math.round(againMs), rows: second.rows },
  whole: { ...summary(all), ms: Math.round(wholeMs), eventLoopMaxMs: ms(wholeLoop.max / 1e6), archiveMiBAfter: mib(fileBytes(join(archivePath, "archive.sqlite"))) },
  assets: { files: assetSizes.size, miB: mib(assetBytes), namedByCopies: named.size, namedMiB: mib(namedBytes) },
  keptCopyOpen: { sample: sample.length, before: openedBefore, afterPass: openedAfter, afterWhole: openedEnd },
}
if (options.json) console.log(JSON.stringify(result, null, 2))
if (options.keep) say(`Kept: ${scratch}`)
else rmSync(scratch, { recursive: true, force: true })

function summary(report: ArchiveMigrationReport) {
  const { reclaim, ...counts } = report
  return { ...counts, reclaim: reclaim && { ...reclaim, miBBefore: mib(reclaim.bytesBefore), miBAfter: mib(reclaim.bytesAfter), ms: Math.round(reclaim.ms) } }
}

function describe(what: string, report: ArchiveMigrationReport, took: number): string {
  const reclaim = report.reclaim?.ran ? `; reclaimed in a thread of its own: ${mib(report.reclaim.bytesBefore)} → ${mib(report.reclaim.bytesAfter)} MiB in ${Math.round(report.reclaim.ms)} ms` : `; nothing reclaimed (${mib(report.reclaim?.freeBytes ?? 0)} MiB free inside${report.reclaim?.why ? `: ${report.reclaim.why}` : ""})`
  return `${what}: ${report.rows} rows in ${(took / 1000).toFixed(1)} s (own ${(report.ms / 1000).toFixed(1)} s, yielded ${report.yieldedMs} ms): ${report.migrated} dropped (${report.viaHarness} their harness has, ${report.viaRecords} the store holds), ${report.copies} copies (${report.newCopies} new), ${report.pending} pending, ${report.failed} kept for failing${report.firstFailure ? ` (first: ${report.firstFailure})` : ""}, ${report.children} children, legacy ${report.legacyFolded} folded and ${report.legacyRemoved} removed; decoding ${(report.decodeMs / 1000).toFixed(1)} s (longest ${Math.round(report.longestDecodeMs)} ms), longest drop transaction ${ms(report.longestDropMs)} ms, longest row ${report.longestMs} ms (${report.longest ?? "none"})${reclaim}`
}
