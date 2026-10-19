import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { archiveMigrationStatus, defaultCatalog } from "../packages/sessions/src/index.ts"
import { makoViews } from "../packages/sessions/src/view-cache.ts"
import { backfillProgress } from "../packages/sessions/src/record-backfill.ts"
import { RecordCapture } from "../packages/sessions/src/record-capture.ts"
import type { RecordRoot } from "../packages/sessions/src/harness-records.ts"
import { RecordStore, taggedRow } from "../packages/sessions/src/record-store.ts"
import { makoRecords, streamFiles, streamsOf, streamsRoot, STREAMS_ROOT, withStreams } from "../packages/sessions/src/record-streams.ts"
import { newestWriter, outdatedText, writersOf } from "../packages/sessions/src/record-writers.ts"
import { storeReader } from "./decode-compare.ts"

/**
 * The record store from a terminal: what it holds for a session, any
 * version's bytes, and capture and restore by hand.
 *
 *   tsx scripts/records.ts [--store <dir>] <command>
 *
 *   sessions [harness]                     every session kept, with its units, bytes and the harness versions that wrote it
 *   writers <harness> <native id>          every harness version that wrote the session, each from its records or observed running it, the newest first
 *   captures [harness [native id]] [--limit n]   the newest captures that took versions or were slow
 *   units <harness> <native id>            a session's units: role, versions, size, newest kind
 *   versions <harness> <unit key>          a unit's versions
 *   cat <harness> <unit key> [seq]         a version's bytes (a row or schema decoded)
 *   capture <harness> <session path>…      take what's new, with the session's streams; the harness reads from --home (default ~)
 *   streams [harness]                      each stream file beside what the store holds of it, and launches never bound to a session
 *   backfill [harness] [--pending n]       the backfill's last pass, then every session in the rail (read
 *                                          read-only, as the catalog lists it) against the store's stamps:
 *                                          held as it stands, held at an older stamp, or not held, newest first
 *   restore <harness> <native id> --home <dir> [--root <name>=<dir>]… [--dry-run] [--fork] [--installed <version>]
 *                                          a root kept outside the session's home (`units` prints
 *                                          each key's root before its colon) goes where --root says;
 *                                          with --fork, a copy there that went on without Mako stays
 *                                          as it is and the arriving version becomes the harness's own fork;
 *                                          with --installed, nothing is written when that version of the harness
 *                                          is older than the newest that wrote the records (`restoreGate`)
 *   archive [--archive <dir>] [--migrate]  the archive's migration: rows dropped, Mako's copies kept, rows
 *                                          still to look at, and the file's size; --migrate runs a pass now
 *   attachments [--archive <dir>] [--app-data <dir>] [--sweep | --restore-trash]
 *                                          the attachments saved beside the archive's copies: what's named and
 *                                          by whom, what a sweep takes, what the store also holds, the trash;
 *                                          a dry run unless --sweep (scripts/record-attachments.ts)
 *   orphans [--list] [--limit n]           chunks no version names, read only: why each is there (a deleted session, a
 *                                          capture cut short, nothing known), whether the next repack drops it or why
 *                                          not, each capture's intent and its owner's standing, and the packs' dead space
 *   repack [--quiet-minutes n] [--sweep]   drop what deleted sessions and captures cut short left, lay quiet sessions
 *                                          out together, compact packs; --sweep looks for unnamed chunks now
 *   stats                                  units, versions, chunks, bytes before and after compression
 *   verify                                 read every chunk back and check its hash
 *
 * The store defaults to ~/.mako/records. Unit keys are as `units` prints them.
 */

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const [value] = args.splice(at, 2).slice(1)
  return value
}
const flag = (name: string): boolean => {
  const at = args.indexOf(name)
  if (at >= 0) args.splice(at, 1)
  return at >= 0
}
const folder = resolve(option("--store") ?? makoRecords())
const streams = streamsRoot(folder)
const home = resolve(option("--home") ?? homedir())
const roots: RecordRoot[] = []
for (let root = option("--root"); root !== undefined; root = option("--root")) {
  const at = root.indexOf("=")
  if (at < 1) throw new Error(`--root takes <name>=<dir>, not ${root}`)
  roots.push({ name: root.slice(0, at), path: resolve(root.slice(at + 1)) })
}
const dryRun = flag("--dry-run")
const installed = option("--installed")
const forking = flag("--fork")
const limit = Number(option("--limit") ?? 50)
const pending = Number(option("--pending") ?? 10)
const json = flag("--json")
const archiveFolder = resolve(option("--archive") ?? join(homedir(), ".mako", "archive"))
const migrate = flag("--migrate")
const [command, ...rest] = args

// Before the store opens, which would migrate it: read only, so a store in a newer format reads too.
if (command === "orphans") {
  const { GRACE_MS, orphanReport, SWEEP_MS } = await import("../packages/sessions/src/record-orphans.ts")
  const listing = flag("--list")
  const report = await orphanReport(folder, { list: listing ? limit : 0 })
  if (json) {
    console.log(JSON.stringify({ ...report, listed: report.listed.map((chunk) => ({ ...chunk, hash: chunk.hash.toString("hex") })) }, null, 2))
    process.exit(0)
  }
  const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  const what = {
    forgotten: "dropped by the next repack: only sessions the person deleted named them",
    abandoned: "dropped by the next repack: the capture that stored them failed or its process is gone",
    unnamed: `dropped by the next repack: unnamed, with nothing claiming them, for over ${GRACE_MS / 60_000} minutes`,
    running: "kept: a capture in progress may still name them",
    waiting: `kept until they have stayed unnamed ${GRACE_MS / 60_000} minutes`,
  } as const
  console.log(`${folder}: ${report.chunks} chunks, ${report.unnamed} named by no version (read in ${report.ms} ms)`)
  for (const verdict of ["forgotten", "abandoned", "unnamed", "running", "waiting"] as const) {
    const counted = report.verdicts[verdict]
    if (counted.chunks) console.log(`  ${verdict.padEnd(9)} ${String(counted.chunks).padStart(7)} chunks ${size(counted.bytes).padStart(10)}  ${what[verdict]}`)
  }
  if (!report.intents.length) console.log("No capture has an intent open: none in progress, none cut short")
  else console.log("Captures' intents (each in progress, failed or cut short):")
  for (const { row, standing, chunks, bytes } of report.intents)
    console.log(`  #${row.id} ${row.session}  pid ${row.pid}, began ${new Date(row.began).toISOString()}: ${standing.state}, ${standing.reason}; ${chunks} unnamed chunks (${size(bytes)})${standing.state === "failed" || standing.state === "gone" ? ", dropped with it by the next repack" : ""}`)
  const sweep = report.lastSweep === null ? "No sweep has run; the next repack sweeps" : `Last sweep ${new Date(report.lastSweep).toISOString()}; the next after ${new Date(report.lastSweep + SWEEP_MS).toISOString()}`
  console.log(`${sweep} (records.ts repack --sweep sweeps now)`)
  const packBytes = report.packs.reduce((sum, pack) => sum + pack.bytes, 0)
  const live = report.packs.reduce((sum, pack) => sum + pack.live, 0)
  console.log(`Packs: ${report.packs.length} files, ${size(packBytes)}; the index names ${size(live)}, and ${size(packBytes - live)} is dropped entries and tails of writes cut short, given back as a pack below the newest falls under half live`)
  const tail = report.tail
  if (tail && tail.size > tail.end) console.log(`The newest pack, ${String(tail.pack).padStart(8, "0")}.pack, has ${size(tail.size - tail.end)} past its last indexed entry (a write cut short before its commit): ${tail.blocked ? `kept while ${tail.blocked}` : "trimmed by the next repack"}`)
  else if (tail) console.log(`The newest pack, ${String(tail.pack).padStart(8, "0")}.pack, ends at its last indexed entry`)
  if (report.pendingTrim) console.log(`A trim was cut short (${String(report.pendingTrim.pack).padStart(8, "0")}.pack from ${report.pendingTrim.from} to ${report.pendingTrim.length} bytes, ${new Date(report.pendingTrim.at).toISOString()}); the next repack finishes it`)
  for (const pack of report.packs) if (pack.bytes > pack.live) console.log(`  ${String(pack.pack).padStart(8, "0")}.pack  ${size(pack.bytes)}, ${size(pack.live)} live (${Math.round((pack.live / Math.max(1, pack.bytes)) * 100)}%)`)
  for (const chunk of report.listed)
    console.log(`  ${chunk.hash.toString("hex").slice(0, 16)}  ${String(chunk.pack).padStart(8, "0")}.pack:${chunk.offset}  ${chunk.stored} bytes  ${chunk.verdict}: ${chunk.reason}`)
  if (listing && report.unnamed > report.listed.length) console.log(`  … and ${report.unnamed - report.listed.length} more (--limit n)`)
  process.exit(0)
}

// Before the store opens: a dry run reads every store read-only and writes nothing.
if (command === "attachments") {
  const { attachmentsCommand } = await import("./record-attachments.ts")
  process.exit(await attachmentsCommand(rest, { store: folder, archive: archiveFolder, json }))
}

const stores = new NativeStores(false)
const store = new RecordStore(folder, stores)
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
const shown = (key: string) => key.replaceAll("\t", " │ ")
const unshown = (key: string) => key.replaceAll(" │ ", "\t")
const print = <T,>(value: T) => console.log(JSON.stringify(value, null, 2))

try {
  switch (command) {
    case "sessions": {
      const sessions = store.sessions(rest[0])
      if (json) print(sessions.map((session) => ({ ...session, writers: store.writers(session.harness, session.nativeId) })))
      else for (const session of sessions) console.log(`${session.harness.padEnd(9)} ${session.nativeId}  ${session.units} units  ${mib(session.bytes)}  ${wroteBy(session.harness, session.nativeId)}`)
      break
    }
    case "captures": {
      const [harness, nativeId] = rest
      const captures = store.captures({ harness, nativeId, limit })
      if (json) print(captures)
      else for (const capture of captures) console.log(`${new Date(capture.at).toISOString()} ${capture.harness.padEnd(9)} ${capture.nativeId}  ${String(capture.versions).padStart(4)} versions  ${mib(capture.newBytes).padStart(10)} → ${mib(capture.storedBytes).padStart(10)}  ${capture.ms} ms${capture.waitedMs ? ` (and ${capture.waitedMs} ms letting others go first)` : ""}${capture.reads ? `, ${capture.rowsRead} rows read whole in ${capture.reads} database reads, the longest ${capture.longestReadMs} ms` : ""}${capture.rowsMatched ? `, ${capture.rowsMatched} held rows matched by their keys' digest` : ""}`)
      break
    }
    case "writers": {
      const [harness, nativeId] = need(2, "writers <harness> <native id>")
      const writers = store.writers(harness, nativeId)
      if (!writers) throw new Error(`Mako holds no records of ${harness} session ${nativeId}`)
      if (json) print({ ...writers, newest: newestWriter(writers) })
      else {
        const all = writersOf(writers).reverse()
        const words = { record: "stated by its records", observed: "observed running it", log: "named by its harness's log", install: "the only install while it was written" }
        for (const writer of all) console.log(`${writer.version.padEnd(20)} ${words[writer.source]}`)
        const evidence = writers.evidence
        if (evidence) {
          if (evidence.source === "range") console.log(`range: no newer than ${evidence.upTo}${evidence.from ? `, no older than ${evidence.from}` : ""}${evidence.line ? ` (${evidence.line})` : ""}, bound by ${evidence.bound ?? "its harness's evidence"}`)
          if (evidence.source === "unknown") console.log("unknown: nothing names or bounds the version that wrote it, so a restore goes only into an install provably newer")
          if (evidence.writes) console.log(`written ${new Date(evidence.writes.first).toISOString()} to ${new Date(evidence.writes.last).toISOString()}`)
          console.log(`why: ${evidence.why}`)
        } else if (!all.length) console.log("Nothing known yet: the backfill's next pass looks (`fillWriters`)")
      }
      break
    }
    case "units": {
      const [harness, nativeId] = need(2, "units <harness> <native id>")
      const units = store.units(harness, nativeId)
      if (json) print(units)
      else for (const unit of units) console.log(`${unit.role.padEnd(6)} ${String(unit.versions).padStart(4)}v ${mib(unit.size).padStart(10)} ${unit.kind.padEnd(7)} ${shown(unit.key)}`)
      break
    }
    case "versions": {
      const [harness, key] = need(2, "versions <harness> <unit key>")
      const versions = store.versions(harness, unshown(key))
      if (json) print(versions)
      else for (const version of versions) console.log(`${String(version.seq).padStart(4)} ${version.kind.padEnd(7)} at ${version.at} → ${version.size} bytes, ${version.chunks} chunks, ${version.capturedAt}${version.digest ? ` ${version.digest.slice(0, 16)}` : ""}${version.writer ? `, written by ${version.writer.versions.join(" then ")} (${version.writer.source})` : ""}`)
      break
    }
    case "cat": {
      const [harness, key, seq] = need(2, "cat <harness> <unit key> [seq]")
      const unit = unshown(key)
      if (/\t(?:row|schema)(?:\t|$)/.test(unit)) {
        const decoded = await store.decoded(harness, unit, seq === undefined ? undefined : Number(seq))
        print("statements" in decoded ? decoded : taggedRow(decoded))
      }
      else for await (const chunk of store.content(harness, unit, seq === undefined ? undefined : Number(seq))) process.stdout.write(chunk)
      break
    }
    case "capture": {
      const [harness, ...paths] = need(2, "capture <harness> <session path>…")
      const reader = storeReader(harness, home)
      for (const path of paths) {
        const absolute = resolve(path)
        const info = await stat(absolute).catch(() => null)
        const ref = await reader.peek({ path: absolute, bytes: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 })
        const own = await reader.records(absolute)
        if (!ref || !own) throw new Error(`${harness} doesn't read a session at ${absolute}`)
        const records = withStreams(own, streams, await streamsOf(streams, harness, ref.nativeId))
        const report = await store.capture({ harness, nativeId: ref.nativeId, home, records })
        if (json) print({ nativeId: ref.nativeId, ...report })
        else console.log(`${ref.nativeId}: ${wroteIn(report.writers)}${report.taken} versions (${summary(report.versions.map((version) => version.kind))}${report.taken > report.versions.length ? `, the first ${report.versions.length} listed` : ""}), ${report.unchanged} unchanged, ${report.newChunks} new chunks, ${mib(report.newBytes)} → ${mib(report.storedBytes)}, ${report.rowsRead} rows read whole in ${report.reads} database reads (the longest ${report.longestReadMs} ms), ${report.rowsMatched} held rows matched by their keys' digest, ${report.ms} ms`)
      }
      break
    }
    case "restore": {
      const [harness, nativeId] = need(2, "restore <harness> <native id> --home <dir> [--root <name>=<dir>]… [--dry-run] [--fork]")
      const report = await store.restore({ harness, nativeId, home, roots, dryRun, ...forking && { fork: storeReader(harness, home).fork }, ...installed !== undefined && { installed } })
      if (json) print(report)
      else {
        for (const action of report.actions) if (action.action !== "skip") console.log(`${action.action.padEnd(11)} ${mib(action.bytes).padStart(10)} ${shown(action.unit)}`)
        for (const rows of report.rows)
          console.log(`${"rows".padEnd(11)} ${mib(rows.bytes).padStart(10)} ${rows.path} ${rows.table}: ${rows.insert} inserted, ${rows.replace} replaced, ${rows.delete} deleted, ${rows.skip} already there`)
        console.log(`${report.actions.filter((action) => action.action === "skip").length} files already there`)
        if (report.movedPaths) console.log(`${report.movedPaths} paths in rows moved to where their records now are`)
        for (const diverged of report.diverged) console.log(`DIVERGED ${shown(diverged.unit)}: ${diverged.reason}`)
        for (const kept of report.kept) console.log(`KEPT ${shown(kept.unit)}: ${kept.reason}`)
        if (report.fork) {
          console.log(`FORK ${report.fork.nativeId}${report.fork.written ? " written" : ""}`)
          for (const from of report.fork.from) console.log(`  went on from ${shown(from.unit)}${from.shared ? `, sharing its first ${mib(from.shared)}` : ""}`)
          for (const action of report.fork.actions) if (action.action !== "skip") console.log(`  ${action.action.padEnd(11)} ${mib(action.bytes).padStart(10)} ${action.path}`)
          for (const rows of report.fork.rows) console.log(`  ${"rows".padEnd(11)} ${mib(rows.bytes).padStart(10)} ${rows.path} ${rows.table}: ${rows.insert} inserted, ${rows.skip} already there`)
          for (const diverged of report.fork.diverged) console.log(`  FORK WENT ON ${shown(diverged.unit)}: ${diverged.reason}`)
        }
        if (report.outdated) console.log(`OUTDATED ${outdatedText(harness, report.outdated)} Nothing written`)
        console.log(report.written ? `Restored under ${home}` : dryRun ? "Dry run: nothing written" : report.diverged.length || report.outdated ? "Nothing written" : "Already there: nothing to write")
      }
      break
    }
    case "streams": {
      const found = await streamFiles(streams)
      const held = new Map<string, Map<string, number>>()
      const rows = []
      for (const file of found.sessions) {
        if (rest[0] && file.harness !== rest[0]) continue
        const session = `${file.harness}\t${file.nativeId}`
        let units = held.get(session)
        if (!units) held.set(session, units = new Map(store.units(file.harness, file.nativeId).map((unit) => [unit.key, unit.size])))
        const bytes = (await stat(file.path)).size
        const kept = units.get(`${STREAMS_ROOT}:${relative(streams, file.path)}`)
        rows.push({ ...file, bytes, held: kept ?? null, state: kept === undefined ? "not held" : kept === bytes ? "held" : kept < bytes ? "behind" : "ahead" })
      }
      if (json) print({ files: rows, unbound: found.unbound })
      else {
        for (const row of rows) console.log(`${row.state.padEnd(8)} ${mib(row.bytes).padStart(10)}${row.state === "behind" || row.state === "ahead" ? ` (store ${mib(row.held ?? 0)})` : ""} ${row.harness.padEnd(9)} ${row.nativeId}  ${relative(streams, row.path)}`)
        for (const path of found.unbound) console.log(`unbound  ${relative(streams, path)}: a launch that never learned its session`)
        const off = rows.filter((row) => row.state !== "held").length
        console.log(`${rows.length} stream files, ${off ? `${off} not as the store holds them` : "each held as it is on disk"}${found.unbound.length ? `, ${found.unbound.length} unbound` : ""}`)
      }
      break
    }
    case "backfill": {
      const last = await backfillProgress(folder)
      const catalog = defaultCatalog({ readOnly: true })
      const rail = (await catalog.scan()).filter((ref) => !ref.archived && (!rest[0] || ref.harness === rest[0]))
      // The stamp each capture keeps, worked out as the catalog's capture does: the catalog's stamp of the native records, and the streams'.
      const stamps = new RecordCapture(store, async () => null, { streams, stampOf: (ref) => catalog.stampOf(ref.path) })
      const held = store.heldStamps()
      const harnesses = new Map<string, { rail: number; held: number; behind: number; missing: number }>()
      const waiting: { harness: string; nativeId: string; updatedAt?: string; state: string }[] = []
      for (const ref of rail) {
        const row = harnesses.get(ref.harness) ?? { rail: 0, held: 0, behind: 0, missing: 0 }
        harnesses.set(ref.harness, row)
        row.rail += 1
        const kept = held.get(`${ref.harness}\n${ref.nativeId}`)
        const now = await stamps.stamp(ref)
        const state = kept === undefined ? (store.units(ref.harness, ref.nativeId).length ? "behind" : "missing") : kept === now ? "held" : "behind"
        row[state] += 1
        if (state !== "held") waiting.push({ harness: ref.harness, nativeId: ref.nativeId, ...ref.updatedAt && { updatedAt: ref.updatedAt }, state })
      }
      await catalog.stop()
      if (json) print({ last, harnesses: Object.fromEntries(harnesses), waiting })
      else {
        if (!last) console.log("No backfill pass has written its progress here yet")
        else {
          const when = (at: number) => new Date(at).toISOString()
          console.log(`Last pass (${last.reason}, pid ${last.pid}): started ${when(last.startedAt)}, ${last.endedAt ? `done ${when(last.endedAt)}` : "not finished: cut short, or still running"}`)
          console.log(`  ${last.done} of ${last.sessions} sessions asked: ${last.held} held, ${last.captured} taken, ${last.live} left to live capture, ${last.gone} gone, ${last.refused} refused for disk, ${last.failed} failed`)
          console.log(`  ${mib(last.newBytes)} read → ${mib(last.storedBytes)} stored, ${last.ms} ms of its own and ${last.yieldedMs} ms yielded; longest ${last.longestMs} ms${last.longest ? ` (${last.longest})` : ""}, longest database read ${last.longestReadMs} ms`)
          if (last.firstRefusal) console.log(`  first refusal: ${last.firstRefusal}`)
          if (last.firstFailure) console.log(`  first failure: ${last.firstFailure}`)
          if (last.repack) console.log(`  repack: ${last.repack.dropped} chunks dropped (${mib(last.repack.droppedBytes)}, ${mib(last.repack.scrubbedBytes)} overwritten where they lay), ${last.repack.grouped} sessions laid out together (${last.repack.alreadyGrouped} were already), ${last.repack.copied} chunks copied (${mib(last.repack.copiedBytes)}), ${last.repack.packsWritten} packs written and ${last.repack.packsRemoved} removed, packs ${mib(last.repack.packBytesBefore)} → ${mib(last.repack.packBytesAfter)}, in ${last.repack.ms} ms, holding the store's turn at most ${last.repack.longestTurnMs} ms`)
          const orphans = last.repack?.orphans
          if (orphans?.scanned) console.log(`  unnamed chunks: ${orphans.unnamed} found; dropped ${orphans.forgotten} of deleted sessions, ${orphans.abandoned} of captures cut short, ${orphans.swept} past the grace; kept ${orphans.running} of captures in progress, ${orphans.waiting} waiting (records.ts orphans says why)`)
          if (last.archive) {
            const archive = last.archive
            console.log(`  archive: ${archive.migrated} rows dropped (${archive.viaHarness} their harness has, ${archive.viaRecords} the store holds), ${archive.copies} Mako's copies only, ${archive.pending} waiting for the store, ${archive.failed} kept for failing${archive.firstFailure ? ` (first: ${archive.firstFailure})` : ""}, ${archive.children} child agents; ${archive.left.rows} rows left, ${archive.left.migrated} dropped ever; ${archive.ms} ms${archive.reclaim?.ran ? `, reclaimed ${mib(archive.reclaim.bytesBefore)} → ${mib(archive.reclaim.bytesAfter)} in ${Math.round(archive.reclaim.ms)} ms` : archive.reclaim?.why ? `; ${mib(archive.reclaim.freeBytes)} free inside, not reclaimed: ${archive.reclaim.why}` : ""}`)
          }
          if (last.prune) console.log(`  streams: ${last.prune.pruned} of ${last.prune.files} files pruned (${mib(last.prune.bytes)}; ${last.prune.prunedEnded} by their ended line, the rest by their writer gone; ${last.prune.restamped} sessions restamped), ${last.prune.live} still being written, ${last.prune.unnamed} from before writers were named, ${last.prune.notHeld} not held whole yet, ${last.prune.differs} differ from the store, ${last.prune.unbound} unbound, in ${last.prune.ms} ms`)
        }
        console.log("The rail now:")
        for (const [harness, row] of [...harnesses].sort()) console.log(`  ${harness.padEnd(10)} ${String(row.rail).padStart(5)} sessions: ${row.held} held as they stand, ${row.behind} held at an older stamp, ${row.missing} not held`)
        for (const entry of waiting.slice(0, pending)) console.log(`  ${entry.state.padEnd(7)} ${entry.harness.padEnd(10)} ${entry.nativeId}  ${entry.updatedAt ?? ""}`)
        if (waiting.length > pending) console.log(`  … and ${waiting.length - pending} more (--pending n)`)
      }
      break
    }
    case "archive": {
      const report = migrate
        ? await (async () => {
          const catalog = defaultCatalog({ archivePath: archiveFolder, recordsPath: folder, viewsPath: makoViews() })
          try {
            await catalog.scan()
            return await catalog.migrateArchive()
          } finally {
            await catalog.stop()
          }
        })()
        : null
      const status = archiveMigrationStatus(archiveFolder)
      if (json) print({ status, report })
      else {
        if (migrate && !report) console.log("No pass ran: no archive, or a backfill pass holds the store's lock")
        if (report) console.log(`This pass: ${report.rows} rows, ${report.migrated} dropped (${report.viaHarness} their harness has, ${report.viaRecords} the store holds), ${report.newCopies} newly found to be Mako's copy only, ${report.pending} waiting for the store, ${report.failed} kept for failing${report.firstFailure ? ` (first: ${report.firstFailure})` : ""}, in ${report.ms} ms`)
        if (!status) console.log(`No archive at ${archiveFolder}`)
        else console.log(`${archiveFolder}: ${status.migrated} rows dropped, ${status.copies} Mako's copies only (kept), ${status.pending} still to look at (of ${status.rows} rows); ${mib(status.bytes)}, ${mib(status.freeBytes)} free inside`)
      }
      break
    }
    case "repack": {
      const report = await store.repack({ quietMs: Number(option("--quiet-minutes") ?? 60) * 60_000, ...flag("--sweep") && { sweep: true } })
      const orphans = report.orphans
      if (json) print(report)
      else if (!report.ran) console.log("Another repack holds the store's repack lock")
      else {
        if (orphans.scanned) console.log(`Unnamed chunks: ${orphans.unnamed} found ${orphans.sweep ? "by a sweep of every chunk" : "among the candidates"} (versions read in ${orphans.scanMs} ms, the store's turn held ${orphans.turnMs} ms to judge and drop); dropped ${orphans.forgotten} only deleted sessions named, ${orphans.abandoned} from captures that failed or whose process is gone (${orphans.intentsCleared} intents cleared), ${orphans.swept} unnamed past the grace; kept ${orphans.running} a capture in progress may name, ${orphans.waiting} waiting out the grace`)
        else console.log("Unnamed chunks: nothing to look for (no deleted session's chunks, no capture cut short, no sweep due)")
        const trim = report.trim
        if (trim.skipped) console.log(`The newest pack's tail: not trimmed while ${trim.skipped}`)
        else if (trim.bytes) console.log(`The newest pack's tail: ${mib(trim.bytes)} past its last indexed entry trimmed from ${String(trim.pack).padStart(8, "0")}.pack${trim.resumed ? ", finishing a trim cut short" : ""}`)
        else if (trim.resumed) console.log("The newest pack's tail: a trim cut short was already done; its record removed")
        console.log(`${report.dropped} chunks dropped (${mib(report.droppedBytes)}, ${mib(report.scrubbedBytes)} overwritten where they lay), ${report.grouped} sessions laid out together (${report.alreadyGrouped} were already), ${report.copied} chunks copied (${mib(report.copiedBytes)}), ${report.packsWritten} packs written, ${report.packsRemoved} removed, ${report.leftovers} leftovers of a repack cut short removed; packs ${mib(report.packBytesBefore)} → ${mib(report.packBytesAfter)} in ${report.ms} ms, the store's turn held at most ${report.longestTurnMs} ms`)
      }
      break
    }
    case "stats": {
      const stats = store.stats()
      if (json) print(stats)
      else console.log(`${stats.sessions} sessions, ${stats.units} units, ${stats.versions} versions, ${stats.chunks} chunks: ${mib(stats.bytes)} → ${mib(stats.stored)} stored`)
      break
    }
    case "verify": {
      const broken = await store.verify()
      for (const failure of broken) console.log(failure)
      console.log(broken.length ? `${broken.length} chunks fail` : "Every chunk reads back with its hash")
      if (broken.length) process.exitCode = 1
      break
    }
    default:
      console.error("Commands: sessions, captures, units, versions, cat, capture, streams, backfill, archive, attachments, repack, restore, stats, verify (see the top of scripts/records.ts)")
      process.exitCode = 2
  }
} finally {
  await store.close()
}

/** The harness versions that wrote a session, newest first, each marked where only observed. */
function wroteBy(harness: string, nativeId: string): string {
  const writers = store.writers(harness, nativeId)
  const all = writersOf(writers).reverse()
  if (all.length) return `written by ${all.map((writer) => `${writer.version}${writer.source === "record" ? "" : ` (${writer.source})`}`).join(", ")}`
  const evidence = writers?.evidence
  return evidence?.source === "range" ? `written by ${evidence.upTo} or older (range, ${evidence.bound ?? "evidence"})` : evidence ? "writer unknown" : "writer not looked for yet"
}

/** The versions a capture stamped, for its line. */
function wroteIn(writers: { record: string[]; observed: string[] }): string {
  const parts = [...writers.record.map((version) => `${version}`), ...writers.observed.map((version) => `${version} observed`)]
  return parts.length ? `by ${parts.join(", ")}: ` : ""
}

function need(count: number, usage: string): string[] {
  if (rest.length < count) {
    console.error(`Usage: records.ts ${usage}`)
    process.exit(2)
  }
  return rest
}

function summary(kinds: string[]): string {
  const counts = new Map<string, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"
}
