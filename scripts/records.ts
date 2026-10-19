import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { relative, resolve } from "node:path"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { RecordRoot } from "../packages/sessions/src/harness-records.ts"
import { RecordStore, taggedRow } from "../packages/sessions/src/record-store.ts"
import { makoRecords, streamFiles, streamsOf, streamsRoot, STREAMS_ROOT, withStreams } from "../packages/sessions/src/record-streams.ts"
import { storeReader } from "./decode-compare.ts"

/**
 * The record store from a terminal: what it holds for a session, any
 * version's bytes, and capture and restore by hand.
 *
 *   tsx scripts/records.ts [--store <dir>] <command>
 *
 *   sessions [harness]                     every session kept, with its units and bytes
 *   captures [harness [native id]] [--limit n]   the newest captures that took versions or were slow
 *   units <harness> <native id>            a session's units: role, versions, size, newest kind
 *   versions <harness> <unit key>          a unit's versions
 *   cat <harness> <unit key> [seq]         a version's bytes (a row or schema decoded)
 *   capture <harness> <session path>…      take what's new, with the session's streams; the harness reads from --home (default ~)
 *   streams [harness]                      each stream file beside what the store holds of it, and launches never bound to a session
 *   restore <harness> <native id> --home <dir> [--root <name>=<dir>]… [--dry-run] [--fork]
 *                                          a root kept outside the session's home (`units` prints
 *                                          each key's root before its colon) goes where --root says;
 *                                          with --fork, a copy there that went on without Mako stays
 *                                          as it is and the arriving version becomes the harness's own fork
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
const forking = flag("--fork")
const limit = Number(option("--limit") ?? 50)
const json = flag("--json")
const [command, ...rest] = args

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
      if (json) print(sessions)
      else for (const session of sessions) console.log(`${session.harness.padEnd(9)} ${session.nativeId}  ${session.units} units  ${mib(session.bytes)}`)
      break
    }
    case "captures": {
      const [harness, nativeId] = rest
      const captures = store.captures({ harness, nativeId, limit })
      if (json) print(captures)
      else for (const capture of captures) console.log(`${new Date(capture.at).toISOString()} ${capture.harness.padEnd(9)} ${capture.nativeId}  ${String(capture.versions).padStart(4)} versions  ${mib(capture.newBytes).padStart(10)} → ${mib(capture.storedBytes).padStart(10)}  ${capture.ms} ms${capture.waitedMs ? ` (and ${capture.waitedMs} ms letting others go first)` : ""}${capture.reads ? `, ${capture.rowsRead} rows read whole in ${capture.reads} database reads, the longest ${capture.longestReadMs} ms` : ""}${capture.rowsMatched ? `, ${capture.rowsMatched} held rows matched by their keys' digest` : ""}`)
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
      else for (const version of versions) console.log(`${String(version.seq).padStart(4)} ${version.kind.padEnd(7)} at ${version.at} → ${version.size} bytes, ${version.chunks} chunks, ${version.capturedAt}${version.digest ? ` ${version.digest.slice(0, 16)}` : ""}`)
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
        else console.log(`${ref.nativeId}: ${report.taken} versions (${summary(report.versions.map((version) => version.kind))}${report.taken > report.versions.length ? `, the first ${report.versions.length} listed` : ""}), ${report.unchanged} unchanged, ${report.newChunks} new chunks, ${mib(report.newBytes)} → ${mib(report.storedBytes)}, ${report.rowsRead} rows read whole in ${report.reads} database reads (the longest ${report.longestReadMs} ms), ${report.rowsMatched} held rows matched by their keys' digest, ${report.ms} ms`)
      }
      break
    }
    case "restore": {
      const [harness, nativeId] = need(2, "restore <harness> <native id> --home <dir> [--root <name>=<dir>]… [--dry-run] [--fork]")
      const report = await store.restore({ harness, nativeId, home, roots, dryRun, ...forking && { fork: storeReader(harness, home).fork } })
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
        console.log(report.written ? `Restored under ${home}` : dryRun ? "Dry run: nothing written" : report.diverged.length ? "Nothing written" : "Already there: nothing to write")
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
      console.error("Commands: sessions, captures, units, versions, cat, capture, streams, restore, stats, verify (see the top of scripts/records.ts)")
      process.exitCode = 2
  }
} finally {
  await store.close()
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
