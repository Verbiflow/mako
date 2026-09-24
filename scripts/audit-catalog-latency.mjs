// Read native stores, keep probe caches private, and never schedule archive captures.
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { defaultCatalog } from "@mako/sessions"
import { DatabaseSync, backup } from "node:sqlite"

const root = await mkdtemp(join(tmpdir(), "mako-catalog-latency-"))
const seed = process.argv[2]
const archivePath = join(root, "archive")
await mkdir(archivePath)
const sourceArchive =
  process.env.MAKO_AUDIT_ARCHIVE ?? join(homedir(), ".mako/archive")
const source = new DatabaseSync(join(sourceArchive, "archive.sqlite"), {
  readOnly: true,
})
try {
  if (source.prepare("PRAGMA user_version").get().user_version !== 1)
    throw Error("Probe requires an already migrated archive")
  await backup(source, join(archivePath, "archive.sqlite"))
} finally {
  source.close()
}
let baseline = process.env.MAKO_AUDIT_BASELINE_INDEX === "1"
const compare = process.env.MAKO_AUDIT_COMPARE_INDEX === "1"
const prepare = DatabaseSync.prototype.prepare
if (baseline || compare)
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    return prepare.call(
      this,
      baseline
        ? sql.replace(
            "sessions INDEXED BY sessions_capture_revision USING",
            "sessions USING"
          )
        : sql,
      ...args
    )
  }
const report = {
  root,
  node: process.version,
  baseline,
  archiveSnapshot:
    "SQLite backup; legacy directories excluded; capture scheduling cancelled",
  runs: [],
}
try {
  for (const archived of [false, true]) {
    const cachePath = join(
      root,
      archived ? "archive-cache.json" : "native-cache.json"
    )
    if (seed) await copyFile(resolve(seed), cachePath)
    const options = { cachePath }
    if (archived) options.archivePath = archivePath
    const catalog = defaultCatalog(options)
    const phases = new Map()
    let metrics = {}
    const wrap = (object, method, label) => {
      const original = object[method]
      if (!original) return
      object[method] = async function (...args) {
        const start = performance.now()
        try {
          return await original.apply(this, args)
        } finally {
          const held = (metrics[label] ??= {
            calls: 0,
            sumMs: 0,
            maxMs: 0,
            startMs: start - started,
          })
          const ms = performance.now() - start
          held.calls++
          held.sumMs += ms
          held.maxMs = Math.max(held.maxMs, ms)
          held.endMs = performance.now() - started
        }
      }
    }
    wrap(catalog, "loadCache", "cache.load")
    if (catalog.archive) {
      const archive = catalog.archive
      const note = archive.note.bind(archive)
      archive.note = (ref, read) => {
        const start = performance.now()
        try {
          note(ref, read)
        } finally {
          archive.cancel(ref.path)
          const held = (metrics["archive.note"] ??= {
            calls: 0,
            sumMs: 0,
            maxMs: 0,
            startMs: start - started,
          })
          const ms = performance.now() - start
          held.calls++
          held.sumMs += ms
          held.maxMs = Math.max(held.maxMs, ms)
          held.endMs = performance.now() - started
        }
      }
      wrap(catalog.archive, "load", "archive.load")
    }
    for (const provider of catalog.providers) {
      const name = provider.constructor.name
      phases.set(name, provider.harness)
      for (const method of ["discover", "peek", "refine", "read"])
        wrap(provider, method, `${name}.${method}`)
    }
    let started = 0
    try {
      for (const phase of compare && archived
        ? [
            "first",
            "baseline-warm",
            "indexed-warm",
            "baseline-repeat",
            "indexed-repeat",
          ]
        : ["first", "warm"]) {
        if (compare) baseline = phase.startsWith("baseline")
        metrics = {}
        started = performance.now()
        const cpu = process.cpuUsage()
        const refs = await catalog.scan()
        const usage = process.cpuUsage(cpu)
        const row = {
          archived,
          baseline,
          phase,
          seeded: Boolean(seed),
          wallMs: performance.now() - started,
          cpuMs: (usage.user + usage.system) / 1000,
          sessions: refs.length,
          providers: Object.fromEntries(phases),
          metrics,
        }
        report.runs.push(row)
        console.log(JSON.stringify(row))
      }
    } finally {
      await catalog.stop()
    }
  }
} finally {
  DatabaseSync.prototype.prepare = prepare
  await rm(archivePath, { recursive: true, force: true })
}
await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
console.log(`Catalog latency evidence: ${root}/result.json`)
