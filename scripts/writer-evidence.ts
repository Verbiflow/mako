import { createReadStream } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { NativeStores, openReadOnly } from "../packages/sessions/src/read-only-sqlite.ts"
import { SAVED_HISTORY_READERS } from "../packages/sessions/src/readers.ts"
import { SessionCatalog } from "../packages/sessions/src/catalog.ts"
import { plainRecordPath } from "../packages/sessions/src/record-files.ts"
import { qualify } from "../packages/sessions/src/record-roots.ts"
import { WriterEvidenceReader } from "../packages/sessions/src/record-evidence.ts"
import { npmReleaseTimeline, NpmTimesSchema, npmTimelineKey, readReleaseTimelines, type ReleaseTimelines } from "../packages/sessions/src/record-releases.ts"
import { makoRecords } from "../packages/sessions/src/record-streams.ts"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { makoRuntimeReadings } from "../packages/sessions/src/record-observed.ts"
import { RecordStore } from "../packages/sessions/src/record-store.ts"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import type { WriterEvidence } from "../packages/sessions/src/record-writers.ts"

/**
 * Which build of its harness wrote each session on this Mac, and where that's
 * known from: `record` (its records state it), `log` (its harness's log names
 * it), `install` (the only install there was while it was written), `range`
 * (bounded: by a build's day, the vendor's release dates or Mako's pins), or
 * `unknown`. Read-only: every store is opened read-only and nothing is
 * written, unless `--store` names a scratch record store to fill
 * (`SessionCatalog.fillWriters`, the backfill pass's own step). Release
 * dates come from the record store's evidence folder, and any the host
 * hasn't read in the last day are read from npm into memory.
 *
 *   npx tsx scripts/writer-evidence.ts                   every session in the rail, counted by harness and source
 *   npx tsx scripts/writer-evidence.ts --only devin --list
 *   npx tsx scripts/writer-evidence.ts --store <dir>     fill a record store's sessions nothing named a writer of, timed
 */

const { values: options } = parseArgs({
  options: {
    only: { type: "string" },
    list: { type: "boolean", default: false },
    store: { type: "string" },
  },
})

const stores = new NativeStores(true)
const home = homedir()
const providers = SAVED_HISTORY_READERS.map((reader) => reader(stores))
const catalog = new SessionCatalog(providers, { readOnly: true })

if (options.store) {
  const folder = resolve(options.store)
  const store = new RecordStore(folder, new NativeStores(true, join(folder, "restored")))
  const filling = new SessionCatalog(providers, { readOnly: true, runtimeReadings: makoRuntimeReadings() })
  const before = store.sessionsWithoutWriters().length
  const started = performance.now()
  const report = await filling.fillWriters(store, folder, { stopped: () => false, yieldToPerson: async () => {} })
  console.log(`Filled ${report.looked} of ${before} sessions nothing named a writer of in ${Math.round(performance.now() - started)} ms: ${report.record} record, ${report.log} log, ${report.install} install, ${report.range} range, ${report.unknown} unknown, ${report.failed} failed`)
  const again = performance.now()
  const second = await filling.fillWriters(store, folder, { stopped: () => false, yieldToPerson: async () => {} })
  console.log(`A second pass looked at ${second.looked} in ${Math.round(performance.now() - again)} ms`)
  await store.close()
  await filling.stop()
  process.exit(0)
}

const started = performance.now()
await catalog.scan()
const refs = catalog.list().filter((ref) => !ref.archived && !ref.childOf && (!options.only || ref.harness === options.only))
console.log(`The rail: ${refs.length} sessions in ${Math.round(performance.now() - started)} ms`)
const reader = new WriterEvidenceReader({ home, readings: makoRuntimeReadings(), cache: null, releases: await releaseTimelines() })
type Column = "record" | "log" | "install" | "build-day" | "releases" | "pins" | "unknown"
const COLUMNS: Column[] = ["record", "log", "install", "build-day", "releases", "pins", "unknown"]
const counts = new Map<string, Record<Column, number>>()
const times = new Map<string, number>()
for (const ref of refs) {
  const provider = providers.find((each) => each.roots().some((root) => ref.path === root || ref.path.startsWith(`${root}/`))) ?? providers.find((each) => each.harness === ref.harness)
  const began = performance.now()
  let source: Column = "unknown"
  let detail = ""
  const stated = provider ? await recordVersions(provider, ref.path).catch(() => []) : []
  if (stated.length) {
    source = "record"
    detail = stated.join(", ")
  } else {
    const evidence = await (provider ? reader.evidence(provider, ref.path) : Promise.resolve(null)).catch((error: Error): WriterEvidence => ({ source: "unknown", why: error.message, at: 0 }))
    if (evidence) {
      source = evidence.source === "range" ? evidence.bound ?? "build-day" : evidence.source
      detail = evidence.versions?.join(", ") ?? (evidence.upTo ? `≤ ${evidence.upTo} (${evidence.bound})` : evidence.why)
    } else detail = "its records state none and nothing beside its store is read for this store"
  }
  times.set(ref.harness, (times.get(ref.harness) ?? 0) + performance.now() - began)
  const row = counts.get(ref.harness) ?? { record: 0, log: 0, install: 0, "build-day": 0, releases: 0, pins: 0, unknown: 0 }
  row[source] += 1
  counts.set(ref.harness, row)
  if (options.list) console.log(`${ref.harness.padEnd(9)} ${source.padEnd(8)} ${ref.nativeId.slice(0, 36).padEnd(37)} ${detail.slice(0, 140)}`)
}
console.log(`\n${"harness".padEnd(9)} ${COLUMNS.map((column) => (column === "build-day" || column === "releases" || column === "pins" ? `range:${column}` : column).padStart(15)).join("")}  time`)
for (const [harness, row] of [...counts].sort(([a], [b]) => a.localeCompare(b)))
  console.log(`${harness.padEnd(9)} ${COLUMNS.map((column) => String(row[column]).padStart(15)).join("")}  ${Math.round(times.get(harness) ?? 0)} ms`)
await catalog.stop()

/** The release dates the host keeps, and any it hasn't read in the last day read from npm now, in memory only. */
async function releaseTimelines(): Promise<ReleaseTimelines> {
  const timelines = readReleaseTimelines(join(makoRecords(), "evidence"))
  const declared = createHarnessHost(detachedHarnessContext(new NativeStores(true))).updateSources.list().flatMap((source) => source.versions?.releases?.npm ?? [])
  for (const npmPackage of new Set(declared)) {
    const key = npmTimelineKey(npmPackage)
    if (timelines[key] && Date.now() - timelines[key].checkedAt < 24 * 60 * 60 * 1000) continue
    const response = await fetch(`https://registry.npmjs.org/${npmPackage.replace("/", "%2F")}`, { signal: AbortSignal.timeout(10_000) })
    if (response.ok) timelines[key] = npmReleaseTimeline(npmPackage, NpmTimesSchema.parse(await response.json()), Date.now())
  }
  return timelines
}

/** The versions a session's own records state, read from its harness's store with its rule, read-only. */
async function recordVersions(provider: SessionProvider, path: string): Promise<string[]> {
  const rule = provider.recordWriter
  if (!rule) return []
  const records = await provider.records(path)
  if (!records) return []
  const found = new Set<string>()
  for (const file of records.files) {
    let key: string
    try {
      const plain = plainRecordPath(qualify(records.roots, file))
      key = records.place?.(plain)?.key ?? plain
    } catch {
      continue
    }
    const scan = rule.file?.(key)
    if (!scan) continue
    // A compressed rollout is read as its harness wrote it; its first line is the session's own.
    if (file.endsWith(".zst")) continue
    for await (const chunk of createReadStream(file)) scan.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    for (const version of scan.end()) found.add(version)
  }
  if (rule.row) {
    for (const database of records.databases) {
      const { database: db } = openReadOnly(database.path, { timeout: 5_000 })
      try {
        for (const table of database.tables) {
          if (!["threads", "session", "session_v2"].includes(table.table)) continue
          const rows = db.prepare(`SELECT * FROM "${table.table}"${table.where ? ` WHERE ${table.where}` : ""}`).all(...(table.params ?? []))
          for (const row of rows) {
            const version = rule.row(table.table, { ...row })
            if (version) found.add(version)
          }
        }
      } finally {
        db.close()
      }
    }
  }
  return [...found]
}
