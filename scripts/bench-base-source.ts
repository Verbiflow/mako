import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { SAVED_HISTORY_READERS, SessionCatalog, type ThreadRef } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { LiveConversations } from "../packages/host/dist/conversations/live-conversations.js"
import { copiedBaseBytes, inspectJournal, journalIds, LiveJournal } from "../packages/host/dist/conversations/live-journal.js"
import { nativeSessionPath } from "../packages/host/dist/threads/native-source.js"
import { installHostLog } from "../packages/host/dist/base/host-log.js"
import { defaultDataDir } from "./harness-doctor-report.ts"

/**
 * What moving journals' copies of their history onto their sessions'
 * records frees and costs, on clones of real journals. The originals and
 * the harnesses' stores are only read; the clones, the record store the
 * sweep fills and the views live in a scratch folder.
 *
 *   npm run benchmark:base-source                       the installed app's journals
 *   npm run benchmark:base-source -- --from <dir>       another folder of journals
 *   npm run benchmark:base-source -- --limit 20         only the 20 largest copies
 *   npm run benchmark:base-source -- --max-source 4096  include sessions whose store is up to 4 GiB (default 1 GiB)
 *   npm run benchmark:base-source -- --keep             keep the scratch folder, for conversations:doctor
 *   npm run benchmark:base-source -- --json
 *
 * It opens each journal the way the last build did (its stored copy), runs
 * the host's sweep with no pause between journals, waits for compaction,
 * then opens each moved journal again: cold with this build's view, cold
 * after a decoder change (a stale view), cold with no view (a full decode),
 * and warm.
 */

const { values: options } = parseArgs({
  options: {
    from: { type: "string" },
    limit: { type: "string" },
    "max-source": { type: "string", default: "1024" },
    keep: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
})

const from = options.from ?? join(defaultDataDir(), "conversations")
const scratch = await mkdtemp(join(tmpdir(), "mako-bench-base-source-"))
const root = join(scratch, "conversations")
mkdirSync(root, { recursive: true })
installHostLog(join(scratch, "host.log"))

// Clones on APFS: instant, and nothing the bench writes reaches the original.
for (const name of readdirSync(from)) {
  if (!/\.sqlite(-wal)?$/.test(name)) continue
  copyFileSync(join(from, name), join(root, name), constants.COPYFILE_FICLONE)
}
// The sweep takes each session into the scratch record store; a store past `--max-source` would fill the disk, so its journal sits out.
const maxSource = Number(options["max-source"]) * 1024 ** 2
const tooLarge: { id: string; harness: string; source: number }[] = []
const all = journalIds(root).map((id) => ({ id, copy: copiedBaseBytes(root, id) })).filter((journal) => {
  if (journal.copy === 0) return false
  const inspected = inspectJournal(root, journal.id)
  const path = inspected.candidate?.path
  const source = path ? sourceBytes(path) : 0
  if (source <= maxSource) return true
  tooLarge.push({ id: journal.id, harness: inspected.session.harness, source })
  return false
}).sort((a, b) => b.copy - a.copy)
const limit = options.limit ? Number(options.limit) : all.length
const chosen = all.slice(0, limit)
const chosenIds = new Set(chosen.map((journal) => journal.id))
for (const id of journalIds(root)) if (!chosenIds.has(id)) for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, `${id}.sqlite${suffix}`), { force: true })

const fileBytes = (id: string) => ["", "-wal"].reduce((total, suffix) => {
  const path = join(root, `${id}.sqlite${suffix}`)
  return total + (existsSync(path) ? statSync(path).size : 0)
}, 0)

interface Row {
  id: string
  harness: string
  copy: number
  before: number
  /** Once this build has opened and closed it, before the sweep: what compacting the space it already had free saves. */
  opened?: number
  storedOpenMs: number
  sweepMs?: number
  keptBecause?: string
  after?: number
  coldViewMs?: number
  staleViewMs?: number
  decodeMs?: number
  warmMs?: number
}

const rows = new Map<string, Row>()
for (const { id, copy } of chosen) {
  const journal = new LiveJournal(root, id)
  const harness = journal.read()?.session.harness ?? "?"
  journal.close()
  rows.set(id, { id, harness, copy, before: fileBytes(id), storedOpenMs: NaN })
}

// As `defaultCatalog` builds it, with every folder it writes in the scratch folder, and a decoder build of the bench's choosing.
// No archive: the app's already holds every session, and a fresh one copies them all (gigabytes) on the first scan.
const stores = new NativeStores(true)
const catalogAt = (name: string, translator?: string): SessionCatalog => new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores)), {
  recordsPath: join(scratch, "records"),
  viewsPath: join(scratch, name),
  readBack: { readers: SAVED_HISTORY_READERS, stores },
  translator,
})
/** Listed first, as the app's catalog is before any conversation opens. */
async function scanned(catalog: SessionCatalog): Promise<{ catalog: SessionCatalog; refs: ThreadRef[] }> {
  const started = performance.now()
  const refs = await catalog.scan()
  scanMs.push(performance.now() - started)
  return { catalog, refs }
}
const scanMs: number[] = []
const hostWith = ({ catalog, refs }: { catalog: SessionCatalog; refs: ThreadRef[] }, holds = true) => new LiveConversations({
  appPath: scratch,
  root,
  driver: () => undefined,
  emit: () => {},
  history: (path, before) => catalog.page(path, before),
  staleHistory: (path, before) => catalog.page(path, before, undefined, { stale: true }),
  holdHistory: holds ? (path) => catalog.hold(path) : undefined,
  nativePath: (identity) => nativeSessionPath(identity, refs),
})

const sweepCatalog = await scanned(catalogAt("views"))
// The last build's open: the journal's own copy, nothing to read. Nothing is held, so the sweep still finds every copy.
const lastBuild = hostWith(sweepCatalog, false)
for (const row of rows.values()) {
  const started = performance.now()
  await lastBuild.historyReady(row.id)
  row.storedOpenMs = performance.now() - started
}
await lastBuild.stop()
await lastBuild.journalsCompacted()
for (const row of rows.values()) row.opened = fileBytes(row.id)
const sweeper = hostWith(sweepCatalog)
const sweepStarted = performance.now()
const settled = await sweeper.settleHistoryCopies(0)
const sweepMs = performance.now() - sweepStarted
await sweeper.stop()
await sweeper.journalsCompacted()
await sweepCatalog.catalog.stop()
for (const journal of settled.journals) {
  const row = rows.get(journal.id)
  if (!row) continue
  row.sweepMs = journal.ms
  if (journal.keptBecause) row.keptBecause = journal.keptBecause
}
for (const row of rows.values()) row.after = fileBytes(row.id)

const moved = [...rows.values()].filter((row) => row.sweepMs !== undefined && !row.keptBecause)

/** Opens each moved journal on a fresh host until its history is read; `field` keeps the time. */
async function opens(field: "coldViewMs" | "staleViewMs" | "decodeMs" | "warmMs", catalog: { catalog: SessionCatalog; refs: ThreadRef[] }): Promise<void> {
  const host = hostWith(catalog)
  for (const row of moved) {
    const started = performance.now()
    await host.historyReady(row.id)
    row[field] = performance.now() - started
  }
  await host.stop()
  await host.journalsCompacted()
}

const viewsCatalog = await scanned(catalogAt("views"))
await opens("coldViewMs", viewsCatalog)
await opens("warmMs", viewsCatalog)
await viewsCatalog.catalog.stop()
for (const [field, name, translator] of [["staleViewMs", "views", "a-later-build"], ["decodeMs", "no-views", undefined]] as const) {
  const catalog = await scanned(catalogAt(name, translator))
  await opens(field, catalog)
  await catalog.catalog.stop()
}

const list = [...rows.values()]
const total = (pick: (row: Row) => number | undefined) => list.reduce((sum, row) => sum + (pick(row) ?? 0), 0)
const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN
}
const worst = (values: number[]) => Math.max(...values.filter(Number.isFinite), 0)
const recordsBytes = folderBytes(join(scratch, "records"))
const viewsBytes = folderBytes(join(scratch, "views"))
const report = {
  from,
  scratch: options.keep ? scratch : undefined,
  journals: list.length,
  moved: moved.length,
  /** Left out by `--max-source`: their sessions' stores would fill the scratch record store. */
  tooLarge,
  scanMs: scanMs.map(Math.round),
  kept: Object.entries(Object.groupBy(list.filter((row) => row.keptBecause), (row) => row.keptBecause!)).map(([why, kept]) => ({ why, count: kept?.length ?? 0 })),
  bytes: { copies: total((row) => row.copy), before: total((row) => row.before), opened: total((row) => row.opened), after: total((row) => row.after), records: recordsBytes, views: viewsBytes },
  sweep: { ms: Math.round(sweepMs), medianMs: Math.round(median(list.map((row) => row.sweepMs ?? NaN))), worstMs: Math.round(worst(list.map((row) => row.sweepMs ?? NaN))) },
  /** Over the moved journals: what opening each cost the last build, and costs this one. */
  openMs: Object.fromEntries((["storedOpenMs", "coldViewMs", "staleViewMs", "decodeMs", "warmMs"] as const).map((field) => {
    const values = moved.map((row) => row[field] ?? NaN)
    return [field, { median: round(median(values)), worst: round(worst(values)) }]
  })),
  rows: list,
}

if (options.json) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`Journals cloned from ${from}: ${report.journals} keeping a copy of their history, ${size(report.bytes.copies)} of copies`)
  if (tooLarge.length) console.log(`Left out, their session's store being over ${options["max-source"]} MiB: ${tooLarge.map((journal) => `${journal.id.slice(0, 8)} ${journal.harness} ${size(journal.source)}`).join(", ")}`)
  console.log(`Moved onto records: ${report.moved}; kept: ${report.kept.map(({ why, count }) => `${count} (${why})`).join(", ") || "none"}`)
  console.log(`Catalog scans before each pass (not in the open times): ${report.scanMs.join(", ")} ms`)
  console.log(`Disk: ${size(report.bytes.before)} before; ${size(report.bytes.opened)} once this build opened and closed each (${size(report.bytes.before - report.bytes.opened)} of space already free); ${size(report.bytes.after)} after the sweep (${size(report.bytes.opened - report.bytes.after)} more, from the copies)`)
  console.log(`  the record store the sweep filled: ${size(recordsBytes)} (shared with every other use of these sessions); views: ${size(viewsBytes)}`)
  console.log(`Sweep: ${(report.sweep.ms / 1000).toFixed(1)} s for all, ${report.sweep.medianMs} ms median per journal, ${report.sweep.worstMs} ms worst`)
  console.log("Opening a moved journal until its history is read (median / worst, ms):")
  for (const [field, label] of [["storedOpenMs", "from its stored copy (the last build)"], ["coldViewMs", "from this build's view"], ["staleViewMs", "after a decoder change (stale view)"], ["decodeMs", "with no view (full decode)"], ["warmMs", "again, same catalog (in memory)"]] as const)
    console.log(`  ${label.padEnd(40)} ${report.openMs[field]!.median} / ${report.openMs[field]!.worst}`)
  console.log("")
  for (const row of list.sort((a, b) => b.copy - a.copy).slice(0, 25))
    console.log(`${row.id.slice(0, 8)} ${row.harness.padEnd(8)} copy ${size(row.copy).padStart(9)}  ${size(row.before).padStart(9)} → ${size(row.opened ?? row.before).padStart(9)} → ${size(row.after ?? row.before).padStart(9)}  sweep ${Math.round(row.sweepMs ?? 0)} ms  open ${round(row.storedOpenMs)}${row.keptBecause ? ` ms  kept: ${row.keptBecause}` : ` → view ${round(row.coldViewMs)} / stale ${round(row.staleViewMs)} / decode ${round(row.decodeMs)} ms`}`)
  if (options.keep) console.log(`\nScratch kept: ${scratch}\n  npm run conversations:doctor -- --data-dir ${scratch} --records ${join(scratch, "records")} --views ${join(scratch, "views")}`)
}
if (!options.keep) rmSync(scratch, { recursive: true, force: true })

/** A session's store as its harness keeps it: the file, a compressed sibling, a SQLite log. */
function sourceBytes(path: string): number {
  return [path, `${path}.zst`, `${path}-wal`].reduce((total, at) => total + (existsSync(at) ? statSync(at).size : 0), 0)
}

function folderBytes(folder: string): number {
  if (!existsSync(folder)) return 0
  let bytes = 0
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) bytes += statSync(join(entry.parentPath, entry.name)).size
  return bytes
}

function size(bytes: number): string {
  if (Math.abs(bytes) < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (Math.abs(bytes) < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function round(ms: number | undefined): number {
  return ms === undefined || !Number.isFinite(ms) ? NaN : ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms)
}
