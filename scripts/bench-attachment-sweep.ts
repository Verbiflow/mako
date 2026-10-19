import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { appDataFolder } from "@mako/host/transport/service"
import { attachmentReaders } from "../packages/host/src/threads/attachment-readers.ts"
import { sessionMemoryPath } from "../packages/host/src/threads/session-memory.ts"
import { AttachmentSweep, ASSET_GRACE_MS, ASSET_TRASH_KEEP_MS, totals, type AttachmentReaders, type AttachmentSweepReport } from "../packages/sessions/src/attachment-sweep.ts"
import { SessionArchive } from "../packages/sessions/src/archive.ts"
import { ArchiveMigration } from "../packages/sessions/src/archive-migration.ts"
import { defaultCatalog } from "../packages/sessions/src/index.ts"
import { openReadOnly } from "../packages/sessions/src/read-only-sqlite.ts"
import type { JsonValue } from "../packages/sessions/src/store-format.ts"
import { makoViews } from "../packages/sessions/src/view-cache.ts"

/**
 * The sweep of Mako's attachment files (`attachment-sweep.ts`: the archive's
 * `assets/`, each profile's `LiveAssets`, the staged `~/.mako/attachments`),
 * on this Mac's own stores.
 *
 *   npm run bench:attachment-sweep                  the dry run, then the sweep on a clone
 *   npm run bench:attachment-sweep -- --dry-only    only the dry run over the real stores
 *   npm run bench:attachment-sweep -- --here        read in this process, not in a child (the old way, to compare)
 *   npm run bench:attachment-sweep -- --keep        keep the scratch clone
 *
 * 1. A dry run over the real stores, read-only, its marks in memory: the
 *    bytes a sweep would take, cold and again warm; this process's added RSS
 *    (sampled), the reading child's peak, and the longest the event loop was
 *    held.
 * 2. A clone of everything it reads into a scratch folder: the archive
 *    (SQLite's own copy, `VACUUM INTO`, from read-only connections), the
 *    attachment folders (APFS clones), and every profile's journals, native
 *    requests, own stores and renderer storage. The browsers' storage is
 *    read where it is, read-only.
 * 3. On the clone, the sweep as things stand: a pass that trashes, a pass
 *    that finds nothing moved, and a pass a day later that deletes.
 * 4. On the clone, the archive's whole migration as it ends once the store
 *    holds every session, then the sweep again.
 *
 * Nothing under the real `~/.mako` or Application Support is written.
 */

const { values: options } = parseArgs({
  options: {
    "dry-only": { type: "boolean", default: false },
    "no-migrate": { type: "boolean", default: false },
    here: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
})
const MIB = 1024 ** 2
const mib = (bytes: number) => Math.round((bytes / MIB) * 10) / 10
const say = (text: string) => { if (!options.json) console.log(text) }
const app = "mako"
const realArchive = join(homedir(), ".mako", "archive")
const realAppData = appDataFolder()
const aside = options.here ? {} : { aside: process.execPath }
const results: Record<string, JsonValue> = {}

/** A pass, timed, with this process's added RSS and heap, the child's peak, and the event loop's longest hold. */
async function measured(sweep: AttachmentSweep, sweeping: boolean) {
  const rssBefore = process.memoryUsage().rss
  let peakRss = rssBefore
  let peakHeap = process.memoryUsage().heapUsed
  const sampler = setInterval(() => {
    const memory = process.memoryUsage()
    peakRss = Math.max(peakRss, memory.rss)
    peakHeap = Math.max(peakHeap, memory.heapUsed)
  }, 5)
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  const started = performance.now()
  const report = await sweep.pass({ stopped: () => false, yieldToPerson: async () => {} }, { sweep: sweeping })
  const ms = Math.round(performance.now() - started)
  loop.disable()
  clearInterval(sampler)
  return { report, ms, addedRssMiB: mib(peakRss - rssBefore), rssBeforeMiB: mib(rssBefore), peakHeapMiB: mib(peakHeap), childPeakMiB: mib(report.childPeakRss ?? 0), loopMaxMs: Math.round(loop.max / 1e6) }
}

function line(what: string, pass: Awaited<ReturnType<typeof measured>>): string {
  const r = pass.report
  return `${what}: ${pass.ms} ms (${r.ran ? `${r.sources.read} sources read, ${r.sources.cached} unchanged` : "nothing moved since the last pass"}); this process +${pass.addedRssMiB} MiB RSS over ${pass.rssBeforeMiB}${pass.childPeakMiB ? `, its reading child peaked at ${pass.childPeakMiB} MiB` : ""}; event loop held at most ${pass.loopMaxMs} ms`
}

function summary(r: AttachmentSweepReport) {
  const folders: Record<string, JsonValue> = {}
  for (const [label, folder] of Object.entries(r.folders))
    folders[label] = { files: folder.files, miB: mib(folder.bytes), namedMiB: mib(folder.named.bytes), heldMiB: mib(folder.held.bytes), keptMiB: mib(folder.kept.bytes), reclaimableMiB: mib(folder.reclaimable.bytes), trashedMiB: mib(folder.trashed.bytes), deletedMiB: mib(folder.deleted.bytes), trashMiB: mib(folder.trash.bytes) }
  const all = totals(r)
  return { miB: mib(all.bytes), namedMiB: mib(all.named.bytes), heldMiB: mib(all.held.bytes), keptMiB: mib(all.kept.bytes), reclaimableMiB: mib(all.reclaimable.bytes), trashedMiB: mib(all.trashed.bytes), restored: all.restored, deletedMiB: mib(all.deleted.bytes), trashMiB: mib(all.trash.bytes), folders, stopped: r.stopped ?? null }
}

function describe(r: AttachmentSweepReport): string {
  const lines: string[] = []
  for (const [label, folder] of Object.entries(r.folders)) {
    if (!folder.files && !folder.trash.files && !folder.deleted.files) continue
    lines.push(`  ${label}: ${folder.files} files, ${mib(folder.bytes)} MiB; named ${mib(folder.named.bytes)}, held ${mib(folder.held.bytes)}, kept ${mib(folder.kept.bytes)}, young ${mib(folder.young.bytes)}, reclaimable ${mib(folder.reclaimable.bytes)} MiB; trash ${mib(folder.trash.bytes)} MiB${r.swept ? `; this pass trashed ${mib(folder.trashed.bytes)}, brought back ${folder.restored}, deleted ${mib(folder.deleted.bytes)} MiB` : ""}`)
  }
  if (r.stopped) lines.push(`  stopped: ${r.stopped}`)
  return lines.join("\n")
}

const realReaders = () => attachmentReaders({ appData: realAppData, app, dataRoot: join(realAppData, app), sessionMemory: sessionMemoryPath(), home: homedir() })

// 1. The dry run over the real stores.
const real = new AttachmentSweep({ archive: realArchive, views: makoViews(), readers: realReaders, state: null, ...aside })
const cold = await measured(real, false)
const warm = await measured(real, false)
say(line(`Dry run over this Mac's stores, cold${options.here ? ", read here" : ""}`, cold))
say(describe(cold.report))
say(line("Again, warm", warm))
results.dryRun = { cold: { ms: cold.ms, addedRssMiB: cold.addedRssMiB, childPeakMiB: cold.childPeakMiB, peakHeapMiB: cold.peakHeapMiB, loopMaxMs: cold.loopMaxMs, ...summary(cold.report) }, warm: { ms: warm.ms, addedRssMiB: warm.addedRssMiB, childPeakMiB: warm.childPeakMiB, loopMaxMs: warm.loopMaxMs } }
if (options["dry-only"]) finish(null)
else {
  // 2. The clone.
  const scratch = mkdtempSync(join(tmpdir(), "mako-bench-attachments-"))
  const free = (() => { const disk = statfsSync(scratch); return disk.bavail * disk.bsize })()
  if (free < 8 * 1024 * MIB) throw new Error(`The disk has ${mib(free)} MiB free; the clone needs about 8 GiB`)
  const home = join(scratch, "home")
  const archive = join(home, ".mako", "archive")
  const appData = join(scratch, "Application Support")
  const cloneStarted = performance.now()
  let copiedBytes = 0
  const sqliteCopy = (from: string, to: string) => {
    mkdirSync(join(to, ".."), { recursive: true })
    const { database } = openReadOnly(from, { timeout: 5_000 })
    try {
      database.prepare("VACUUM INTO ?").run(to)
    } finally {
      database.close()
    }
    copiedBytes += statSync(to).size
  }
  const clone = (from: string, to: string) => {
    mkdirSync(join(to, ".."), { recursive: true })
    // An APFS clone: the copy shares the blocks until either side writes.
    execFileSync("cp", ["-c", "-R", from, to])
  }
  mkdirSync(archive, { recursive: true })
  for (const name of readdirSync(realArchive)) {
    const from = join(realArchive, name)
    if (name.endsWith(".sqlite")) sqliteCopy(from, join(archive, name))
    else if (name === "assets" || /^[0-9a-f]{24}$/.test(name)) clone(from, join(archive, name))
  }
  for (const name of readdirSync(join(homedir(), ".mako"))) if (name.endsWith(".sqlite") && !name.includes("before")) sqliteCopy(join(homedir(), ".mako", name), join(home, ".mako", name))
  if (existsSync(join(homedir(), ".mako", "attachments"))) clone(join(homedir(), ".mako", "attachments"), join(home, ".mako", "attachments"))
  const found = await realReaders()
  let profiles = 0
  for (const root of found.roots) {
    const to = join(appData, basename(root))
    mkdirSync(to, { recursive: true })
    profiles += 1
    for (const name of readdirSync(root)) if (name.endsWith(".sqlite")) sqliteCopy(join(root, name), join(to, name))
    for (const folder of ["conversations", "native-requests"]) {
      const from = join(root, folder)
      if (!existsSync(from)) continue
      for (const name of readdirSync(from)) if (name.endsWith(".sqlite")) sqliteCopy(join(from, name), join(to, folder, name))
    }
    if (existsSync(join(root, "conversations", "assets"))) clone(join(root, "conversations", "assets"), join(to, "conversations", "assets"))
    for (const name of readdirSync(root)) if (name.endsWith(".json")) cpSync(join(root, name), join(to, name))
    if (existsSync(join(root, "Local Storage", "leveldb"))) clone(join(root, "Local Storage"), join(to, "Local Storage"))
  }
  const cloneMs = Math.round(performance.now() - cloneStarted)
  say(`Cloned into ${scratch}: ${profiles} Mako folders, ${mib(copiedBytes)} MiB of SQLite copied and the attachment folders cloned, in ${(cloneMs / 1000).toFixed(1)} s`)

  // 3. The sweep on the clone, as things stand. A clone's files are new to the filesystem, so the sweep's clock starts past their grace.
  let now = Date.now() + ASSET_GRACE_MS
  const cloneReaders = async (): Promise<AttachmentReaders> => ({ ...found, roots: found.roots.map((root) => join(appData, basename(root))), holds: found.holds.map((hold) => ({ ...hold, through: hold.through + ASSET_GRACE_MS })) })
  const sweeper = () => new AttachmentSweep({ archive, shared: join(home, ".mako"), readers: cloneReaders, now: () => now, ...aside })
  const trashing = await measured(sweeper(), true)
  say(line("The sweep on the clone, first pass", trashing))
  say(describe(trashing.report))
  const quiet = await measured(sweeper(), true)
  say(line("The next pass, nothing changed (a new process's sweep, its marks from the state file)", quiet))
  now += ASSET_TRASH_KEEP_MS
  const deleting = await measured(sweeper(), true)
  say(line("A pass a day later", deleting))
  say(describe(deleting.report))
  results.clone = { ms: cloneMs, profiles, copiedMiB: mib(copiedBytes) }
  results.sweep = { first: { ms: trashing.ms, addedRssMiB: trashing.addedRssMiB, childPeakMiB: trashing.childPeakMiB, ...summary(trashing.report) }, quiet: { ms: quiet.ms, ran: quiet.report.ran }, dayLater: { ms: deleting.ms, ...summary(deleting.report) } }

  // 4. The whole migration on the clone, then the sweep again.
  if (!options["no-migrate"]) {
    const catalog = defaultCatalog({ readOnly: true })
    const rail = (await catalog.scan()).filter((ref) => !ref.archived)
    const undiscovered = new Set(catalog.undiscoveredHarnesses)
    await catalog.stop()
    const liveSessions = new Set(rail.map((ref) => `${ref.harness}\n${ref.nativeId}`))
    const whole = new SessionArchive(archive)
    const migrated = await new ArchiveMigration(whole, {
      live: () => rail,
      discovered: (harness) => !undiscovered.has(harness),
      captured: (ref) => liveSessions.has(`${ref.harness}\n${ref.nativeId}`),
      decodesNative: async () => 1,
      decodesRecords: async () => null,
      keepListing: async () => true,
    }).pass({ stopped: () => false, yieldToPerson: async () => {} })
    await whole.stop()
    say(`The whole migration on the clone: ${migrated.migrated} rows dropped, ${migrated.left.copies} copies and ${migrated.children} child agents' rows stay`)
    now += 1
    const afterMigration = await measured(sweeper(), true)
    say(line("The sweep after the migration", afterMigration))
    say(describe(afterMigration.report))
    now += ASSET_TRASH_KEEP_MS
    const finalPass = await measured(sweeper(), true)
    say(line("A pass a day later", finalPass))
    say(describe(finalPass.report))
    results.afterMigration = { rowsDropped: migrated.migrated, copies: migrated.left.copies, first: { ms: afterMigration.ms, ...summary(afterMigration.report) }, dayLater: { ms: finalPass.ms, ...summary(finalPass.report) } }
  }
  finish(scratch)
}

function finish(scratch: string | null): void {
  if (options.json) console.log(JSON.stringify(results, null, 2))
  if (!scratch) return
  if (options.keep) say(`Kept: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}
