import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import { NativeStores } from "../packages/sessions/src/read-only-sqlite.ts"
import { orphanReport } from "../packages/sessions/src/record-orphans.ts"
import { RecordStore } from "../packages/sessions/src/record-store.ts"

/**
 * What finding and dropping chunks no version names costs on a large store:
 * a copy of one (a `bench:backfill -- --keep` store), then orphans of every
 * kind put into it: a capture of a large file killed (SIGKILL, in a process
 * of its own, built `@mako/sessions`) after its slices committed and before
 * its version did; some of those chunks stripped of their intent, as an
 * older build leaves them; and a tenth of the sessions deleted.
 *
 *   npm run bench:orphans -- --store <records folder> [--mib 160] [--json]
 *
 * Measures the readout (`records.ts orphans`), a sweep of the store as it
 * was, the repack that drops what the kill and the deletes left (the read
 * of every version without the lock, and the turn it holds to judge and
 * drop), the sweep that drops what waited out its grace, and a repack with
 * nothing to look for. The store given is only read; the copy goes under
 * `$MAKO_THREAD_DATA_DIR` (or ~/.mako/tmp) and is removed unless `--keep`.
 */

const { values: options } = parseArgs({ options: { store: { type: "string" }, mib: { type: "string", default: "160" }, json: { type: "boolean", default: false }, keep: { type: "boolean", default: false } } })
if (!options.store) throw new Error("--store <records folder>: a store to copy, as `npm run bench:backfill -- --keep` leaves one")
const say = (text: string) => { if (!options.json) console.log(text) }
const base = process.env.MAKO_THREAD_DATA_DIR ?? join(homedir(), ".mako", "tmp")
const scratch = join(base, `bench-orphans-${Date.now()}`)
const folder = join(scratch, "records")
const home = join(scratch, "home")
mkdirSync(home, { recursive: true })
// A clone where the filesystem can (APFS), a copy otherwise.
execFileSync("cp", [...(process.platform === "darwin" ? ["-c"] : []), "-R", resolve(options.store), folder])
const stores = new NativeStores(true)
const ms = (value: number) => Math.round(value)

try {
  const clean = await orphanReport(folder)
  say(`The store: ${clean.chunks} chunks, ${clean.unnamed} unnamed; read for the readout in ${clean.ms} ms`)
  let store = new RecordStore(folder, stores)
  const sweptClean = await store.repack({ quietMs: 3_600_000, sweep: true })
  await store.close()
  say(`A sweep of it as it was: versions read in ${sweptClean.orphans.scanMs} ms, the turn held ${sweptClean.orphans.turnMs} ms to judge (${sweptClean.longestTurnMs} ms at most for any step), ${sweptClean.ms} ms in all`)

  // A capture killed after its slices committed and before its version did.
  const lines: string[] = []
  for (let bytes = 0; bytes < Number(options.mib) * 1024 * 1024;) {
    const line = `${JSON.stringify({ type: "assistant", text: randomBytes(96).toString("base64"), pad: "x".repeat(120) })}\n`
    lines.push(line)
    bytes += line.length
  }
  writeFileSync(join(home, "killed.jsonl"), lines.join(""))
  const child = spawn(process.execPath, [join("packages", "sessions", "test", "record-orphans-child.mjs"), "capture", folder, home, "killed", "versioned", "--kill"], { stdio: ["pipe", "pipe", "inherit"] })
  let out = ""
  child.stdout.setEncoding("utf8")
  await new Promise<void>((done, fail) => {
    child.stdout.on("data", (text: string) => {
      out += text
      if (/^at versioned$/m.test(out)) done()
    })
    child.once("exit", (code) => fail(new Error(`the capture exited (${code}) before its version: ${out}`)))
  })
  const exited = once(child, "exit")
  child.kill("SIGKILL")
  await exited
  // A third of what it left as an older build leaves it: no intent.
  const db = new DatabaseSync(join(folder, "records.sqlite"))
  const untagged = Number(db.prepare("UPDATE chunks SET intent = NULL WHERE intent IS NOT NULL AND substr(hash, 1, 1) < x'55'").run().changes)
  db.close()
  // A tenth of the sessions deleted.
  store = new RecordStore(folder, stores)
  const sessions = store.sessions().filter((_, index) => index % 10 === 9)
  const forgetting = performance.now()
  for (const session of sessions) await store.forget(session.harness, session.nativeId)
  const forgetMs = performance.now() - forgetting
  await store.close()

  const injected = await orphanReport(folder)
  say(`Injected: a capture of ${options.mib} MiB killed at its version, ${untagged} of its chunks stripped of their intent, ${sessions.length} sessions deleted (${ms(forgetMs)} ms)`)
  say(`The readout: ${injected.unnamed} unnamed (${Object.entries(injected.verdicts).filter(([, counted]) => counted.chunks).map(([verdict, counted]) => `${verdict} ${counted.chunks}, ${(counted.bytes / 1024 / 1024).toFixed(1)} MiB`).join("; ")}) in ${injected.ms} ms`)

  store = new RecordStore(folder, stores)
  const dropping = await store.repack({ quietMs: 3_600_000 })
  const o = dropping.orphans
  say(`The repack: versions read in ${o.scanMs} ms without the lock; dropped ${o.forgotten} forgotten and ${o.abandoned} abandoned (${(dropping.droppedBytes / 1024 / 1024).toFixed(1)} MiB, ${(dropping.scrubbedBytes / 1024 / 1024).toFixed(1)} MiB zeroed in place), ${o.waiting} waiting; the turn held ${o.turnMs} ms to judge and drop (${dropping.longestTurnMs} ms at most for any step); ${dropping.ms} ms in all, packs ${(dropping.packBytesBefore / 1024 / 1024).toFixed(1)} → ${(dropping.packBytesAfter / 1024 / 1024).toFixed(1)} MiB`)
  const graced = await store.repack({ quietMs: 3_600_000, sweep: true, graceMs: 0 })
  say(`Past the grace: ${graced.orphans.swept} dropped; versions read in ${graced.orphans.scanMs} ms, the turn held ${graced.orphans.turnMs} ms, ${graced.ms} ms in all`)
  const idle = await store.repack({ quietMs: 3_600_000 })
  say(`Nothing to look for: ${idle.orphans.scanned ? "scanned" : "no scan"}, ${idle.ms} ms`)
  await store.close()
  const after = await orphanReport(folder)
  if (after.unnamed) throw new Error(`${after.unnamed} unnamed chunks are left`)
  if (options.json) console.log(JSON.stringify({ chunks: clean.chunks, readout: { clean: clean.ms, injected: injected.ms }, sweepClean: { scanMs: sweptClean.orphans.scanMs, turnMs: sweptClean.orphans.turnMs, ms: sweptClean.ms }, injected: { unnamed: injected.unnamed, verdicts: injected.verdicts, untagged, forgotten: sessions.length }, drop: { ...o, droppedBytes: dropping.droppedBytes, scrubbedBytes: dropping.scrubbedBytes, longestTurnMs: dropping.longestTurnMs, ms: dropping.ms }, graced: { swept: graced.orphans.swept, scanMs: graced.orphans.scanMs, turnMs: graced.orphans.turnMs, ms: graced.ms }, idleMs: idle.ms }, null, 2))
} finally {
  if (options.keep) say(`Kept: ${folder}`)
  else rmSync(scratch, { recursive: true, force: true })
}
