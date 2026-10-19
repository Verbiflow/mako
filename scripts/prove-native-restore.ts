import { createHash } from "node:crypto"
import { mkdir, readFile, rm, stat, truncate } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { SessionRecords } from "../packages/sessions/src/harness-records.ts"
import { placeIn } from "../packages/sessions/src/record-roots.ts"
import { RecordStore, taggedRow, type RestoreReport } from "../packages/sessions/src/record-store.ts"
import { storeReader } from "./decode-compare.ts"
import { HARNESSES, harnessNamed, nativePath as findSession, removeSession, type Harness } from "./native-harnesses.ts"
import { scratchHarnessHome } from "./scratch-harness-home.ts"

/**
 * The record store against the harnesses themselves, in a scratch home
 * signed in as this machine's person (`scratch-harness-home.ts`): their own
 * homes and sessions are never read or written. For each harness: a real
 * session plants a codeword, a resume plants a second, and each turn is
 * captured. The session is deleted from the harness's store, restored from
 * Mako's, and resumed natively, which must recall both. Where a session is
 * an append-only file, its transcript is cut back to the first version and
 * restored by appending, then cut back and continued with another turn,
 * which a restore without a fork rule must leave untouched.
 *
 * Then, on every harness, the session goes on without Mako (a third
 * codeword, never captured) and is restored with the harness's fork rule:
 * the destination's copy must stay byte- and row-identical, a new session
 * must exist, a second restore must find it and write nothing, and the
 * harness must resume the fork natively and recall the arriving turns'
 * codewords but not the third.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/prove-native-restore.ts [--store <dir>] [harness…]
 *
 * It runs model turns on each harness's own account. The scratch home, its
 * sessions and its copied credentials are removed afterwards.
 */

const args = process.argv.slice(2)
const storeAt = args.indexOf("--store")
const data = process.env["MAKO_THREAD_DATA_DIR"] ?? "/tmp"
const folder = storeAt >= 0 ? args.splice(storeAt, 2)[1]! : join(data, "native-restore-proof")
const chosen = args.length ? args : Object.keys(HARNESSES)
const scratchRoot = join(data, "native-restore-proof-home")
await rm(scratchRoot, { recursive: true, force: true })
const cwds = new Map(chosen.map((harness) => [harness, join(scratchRoot, "work", harness)]))
const scratch = await scratchHarnessHome(scratchRoot, [...cwds.values()])
if (scratch.expiresInHours < 0.5) throw new Error(`A credential the scratch home holds expires in ${(scratch.expiresInHours * 60).toFixed(0)} minutes; sign the harness in again first`)
const { home, env } = scratch
const nativeStores = new NativeStores(false)
const store = new RecordStore(folder, nativeStores)
const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")

const nativePath = (harness: string, id: string) => findSession(harness, id, home)

const roots = new Map<string, string>()

async function capture(harness: string, id: string, path: string) {
  const records = await storeReader(harness, home).records(path)
  if (!records) throw new Error(`${harness} keeps no records at ${path}`)
  for (const root of records.roots) roots.set(root.name, root.path)
  return store.capture({ harness, nativeId: id, home, records })
}

/** The session's main transcript: the append-only file its path names, or under it. */
function transcriptUnit(harness: string, id: string): { key: string; path: string } | null {
  const unit = store.units(harness, id).find((candidate) => candidate.role === "file" && candidate.path && candidate.key.includes(id) && /\.(?:jsonl|ndjson)$/.test(candidate.key) && !candidate.key.includes("/subagents/"))
    ?? store.units(harness, id).find((candidate) => candidate.role === "file" && candidate.path?.endsWith("updates.jsonl"))
  return unit?.path ? { key: unit.key, path: placeIn(roots, unit.path.replace(/\.zst$/, "")) } : null
}

/** Every file and owned row of a session, hashed: what a restore onto it must leave as it is. */
async function fingerprint(records: SessionRecords): Promise<string> {
  const hash = createHash("sha256")
  for (const file of [...records.files].sort()) hash.update(file).update(await readFile(file).catch(() => Buffer.from("missing")))
  for (const database of records.databases) {
    const db = new DatabaseSync(database.path, { readOnly: true })
    try {
      for (const table of database.tables) {
        const statement = db.prepare(`SELECT * FROM "${table.table}"${table.where ? ` WHERE ${table.where}` : ""} ORDER BY 1`)
        statement.setReadBigInts(true)
        for (const row of statement.iterate(...(table.params ?? []))) hash.update(table.table).update(JSON.stringify(taggedRow({ ...row })))
      }
    } finally {
      db.close()
    }
  }
  return hash.digest("hex")
}

const written = (report: RestoreReport) => `${report.actions.filter((action) => action.action !== "skip").length} files and ${report.rows.reduce((total, rows) => total + rows.insert + rows.replace + rows.delete, 0)} rows`
const forkWritten = (report: RestoreReport) => report.fork ? `${report.fork.actions.filter((action) => action.action !== "skip").length} files and ${report.fork.rows.reduce((total, rows) => total + rows.insert, 0)} rows` : "nothing"

async function prove(harness: string, spec: Harness): Promise<string[]> {
  const steps: string[] = []
  const note = (ok: boolean, what: string) => steps.push(`${ok ? "PASS" : "FAIL"} ${what}`)
  const cwd = cwds.get(harness)!
  await rm(cwd, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  const word = (label: string) => `${label}-${harness.toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const first = word("ALPHA")
  const second = word("BRAVO")
  const third = word("CHARLIE")
  const ask = "What codewords have I asked you to remember in this conversation? Reply with just the codewords, comma-separated. Don't run any tools."
  const reader = storeReader(harness, home)
  let id = ""
  let path = ""
  let forkId = ""
  try {
    ;({ id } = await spec.start(cwd, `Remember this codeword for later: ${first}. Reply with just OK. Don't run any tools.`, env))
    path = await nativePath(harness, id)
    const v1 = await capture(harness, id, path)
    note(v1.versions.length > 0, `first turn captured: ${v1.versions.length} versions, ${v1.newChunks} chunks, ${v1.ms} ms`)
    const transcript = spec.appends ? transcriptUnit(harness, id) : null
    const firstSize = transcript ? (await stat(transcript.path)).size : 0

    await spec.resume(cwd, id, `Also remember this second codeword: ${second}. Reply with just OK. Don't run any tools.`, env)
    const v2 = await capture(harness, id, await nativePath(harness, id))
    const kinds = [...new Set(v2.versions.map((version) => version.kind))].join(", ")
    note(v2.versions.length > 0 && (!spec.appends || v2.versions.some((version) => version.kind === "append" && version.unit === transcript?.key)), `second turn captured as ${v2.versions.length} versions (${kinds})`)

    const removed = await reader.remove?.(path)
    if (!removed) await rm(harness === "cursor" ? dirname(path) : path, { recursive: true, force: true })
    const gone = !(await reader.discover()).some((file) => file.path.includes(id))
    note(gone, "deleted from the harness's own store")
    const restored = await store.restore({ harness, nativeId: id, home })
    note(restored.written && !restored.diverged.length, `restored whole: ${written(restored)} written${restored.diverged.length ? `, diverged at ${restored.diverged[0]!.unit}: ${restored.diverged[0]!.reason}` : ""}`)
    const recalled = await spec.resume(cwd, id, ask, env)
    note(recalled.includes(first) && recalled.includes(second), `native resume after restore recalls both codewords: ${JSON.stringify(recalled.trim().slice(0, 120))}`)

    if (spec.appends && transcript) {
      await capture(harness, id, await nativePath(harness, id))
      await truncate(transcript.path, firstSize)
      const onto = await store.restore({ harness, nativeId: id, home })
      note(onto.actions.some((action) => action.action === "append" && action.unit === transcript.key) && !onto.diverged.length, `a copy cut back to the first turn is restored by appending (${[...new Set(onto.actions.map((action) => action.action))].join(", ")})`)
      const again = await spec.resume(cwd, id, ask, env)
      note(again.includes(first) && again.includes(second), `native resume after the append recalls both: ${JSON.stringify(again.trim().slice(0, 120))}`)

      await capture(harness, id, await nativePath(harness, id))
      await truncate(transcript.path, firstSize)
      await spec.resume(cwd, id, `Remember this codeword instead: ${third}. Reply with just OK. Don't run any tools.`, env)
      const before = await sha(transcript.path)
      const diverged = await store.restore({ harness, nativeId: id, home })
      const after = await sha(transcript.path)
      note(!diverged.written && diverged.diverged.some((entry) => entry.unit === transcript.key) && before === after, `without a fork rule, a copy that went on without Mako is left untouched (${diverged.diverged.length} units diverged)`)
    } else {
      // The arriving version holds both codewords and the recall; then the session goes on here, uncaptured.
      await capture(harness, id, await nativePath(harness, id))
      await spec.resume(cwd, id, `Remember this codeword instead: ${third}. Reply with just OK. Don't run any tools.`, env)
    }

    const localPath = await nativePath(harness, id)
    const localRecords = await reader.records(localPath)
    if (!localRecords) throw new Error(`${harness} keeps no records at ${localPath}`)
    const before = await fingerprint(localRecords)
    const started = performance.now()
    const forked = await store.restore({ harness, nativeId: id, home, destination: localRecords, fork: reader.fork })
    const forkMs = performance.now() - started
    forkId = forked.fork?.nativeId ?? ""
    // A file by its name and the bytes it shares; rows by their table and how many went on here.
    const tables = new Map<string, number>()
    const files: string[] = []
    for (const unit of forked.fork?.from ?? []) {
      const [name = "", kind, table = ""] = unit.unit.split("\t")
      if (kind === "row") tables.set(table, (tables.get(table) ?? 0) + 1)
      else files.push(`${name.split("/").at(-1)} (${unit.shared} bytes)`)
    }
    const shared = [...files, ...[...tables].map(([table, rows]) => `${rows} ${table} rows`)].join(", ")
    note(Boolean(forked.fork?.written) && !forked.diverged.length && await fingerprint(localRecords) === before,
      `a copy that went on without Mako is left byte- and row-identical, and the arriving version is fork ${forkId || "none"}: ${forkWritten(forked)} in ${forkMs.toFixed(0)} ms, from ${shared || "nothing"}${forked.diverged.length ? `; diverged at ${forked.diverged[0]!.unit}: ${forked.diverged[0]!.reason}` : ""}`)
    const listed = forkId ? await nativePath(harness, forkId).catch(() => null) : null
    note(Boolean(listed), `${harness} lists the fork as a session of its own`)
    const again = await store.restore({ harness, nativeId: id, home, destination: localRecords, fork: reader.fork })
    note(!again.written && again.fork?.nativeId === forkId && !again.fork.written && !again.fork.diverged.length, `a second restore finds the fork and writes nothing (${forkWritten(again)})`)
    if (forkId) {
      const fromFork = await spec.resume(cwd, forkId, ask, env)
      note(fromFork.includes(first) && fromFork.includes(second) && !fromFork.includes(third), `native resume of the fork recalls the arriving codewords and not the destination's own: ${JSON.stringify(fromFork.trim().slice(0, 120))}`)
      note(await fingerprint(localRecords) === before, "resuming the fork leaves the destination's copy as it was")
    }
  } catch (error) {
    note(false, error instanceof Error ? error.message : String(error))
  } finally {
    if (forkId) await removeSession(harness, forkId, home)
    if (id) await removeSession(harness, id, home)
    await rm(cwd, { recursive: true, force: true })
  }
  return steps.map((step) => `${harness.padEnd(8)} ${step}`)
}

try {
  const results = await Promise.all(chosen.map((harness) => prove(harness, harnessNamed(harness))))
  const lines = results.flat()
  console.log(lines.join("\n"))
  if (lines.some((line) => line.includes(" FAIL "))) process.exitCode = 1
} finally {
  await store.close()
  await rm(scratchRoot, { recursive: true, force: true })
}
