import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import type { TrackerPorts } from "@mako/protocol"
import { inSlices } from "@mako/sessions/slices"
import type { JournalStore } from "@mako/host/attribution/journal-store"
import { hunks, storedView, threadSummary, turnChanges } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { turnWriters } from "@mako/host/attribution/turn-lines"

/*
 * Retention proved on a copy of a real journal (`node --import tsx scripts/prove-attribution-retention.ts --journal
 * <copy>/journal.sqlite`). Never the journal a host uses: a path under a `.mako` folder is refused, and this writes.
 * It opens the copy as its owner with a tracker that watches nothing (every root stays asleep, as after a host's
 * start), records what must survive (every uncommitted file's writers as the readers resolve them, the newest
 * Threads' counts and line writers, which roots are idle), prunes to the end, and records it again. Any difference
 * is printed and fails the run. It ends with the sizes before and after, a `VACUUM`, and SQLite's own checks.
 */
const { values } = parseArgs({ options: { journal: { type: "string" }, threads: { type: "string", default: "30" }, turns: { type: "string", default: "5" } } })
if (!values.journal) throw new Error("Give --journal <a copy's journal.sqlite>.")
const journal = resolve(values.journal)
for (const path of [journal, existsSync(journal) ? realpathSync(journal) : journal])
  if (path.split(sep).includes(".mako")) throw new Error("That is under a .mako folder: this proof only ever runs on a copy elsewhere.")
if (!journal.endsWith(`${sep}journal.sqlite`)) throw new Error("The copy must be named journal.sqlite, in a folder of its own.")

const DAY = 86_400_000
const now = Date.now()
const retainAfter = now - 14 * DAY
const hashed = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)
const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`
const size = (path: string) => (existsSync(path) ? statSync(path).size : 0)

const TABLES = ["entries", "entry_candidates", "activity", "activity_changes", "turn_changes", "footprint", "footprint_turns", "commits", "gaps", "stats", "files", "blobs", "roots", "choices", "carried", "carried_activity", "carried_paths", "moves"]
/** Rows of each table and the bytes of it and its indexes, as SQLite's own page accounting has them. */
function sizes(db: DatabaseSync): Map<string, { rows: number; bytes: number }> {
  const owner = new Map(db.prepare("SELECT name, tbl_name FROM sqlite_master").all().map((row) => [String(row.name), String(row.tbl_name)]))
  const bytes = new Map<string, number>()
  for (const row of db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name").all()) {
    const table = owner.get(String(row.name)) ?? String(row.name)
    bytes.set(table, (bytes.get(table) ?? 0) + Number(row.bytes))
  }
  return new Map(TABLES.filter((table) => owner.has(table)).map((table) => [table, { rows: Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count), bytes: bytes.get(table) ?? 0 }]))
}

/** Everything that must read the same after pruning, each part as a digest by its file or Thread. */
async function truth(store: JournalStore, threads: readonly string[]) {
  const view = storedView(store)
  const files = new Map<string, string>()
  const byFile = new Map<string, unknown[]>()
  for (const hunk of hunks(view, "/")) byFile.set(`${hunk.root}\u0000${hunk.path}`, [...(byFile.get(`${hunk.root}\u0000${hunk.path}`) ?? []), hunk])
  let lines = 0
  let unnamed = 0
  for (const root of view.roots())
    for (const file of root.files.values()) {
      // Each line's writer as the journal has it, beside the hunks the readers make of them.
      const writers = file.map.map((run) => [run.ins, run.del, run.over].map((seq) => (seq > 0 ? (view.author(seq) ?? "missing") : seq)))
      for (const run of file.map) for (const seq of [run.ins, run.del, run.over]) if (seq > 0) (view.author(seq) ? lines++ : unnamed++)
      files.set(`${root.root.path}/${file.path}`, hashed(JSON.stringify([file.base, file.baseSeq, file.current, file.text, writers, byFile.get(`${root.root.id}\u0000${file.path}`) ?? []])))
    }
  const perThread = new Map<string, Map<string, string>>()
  const maybeOutside = new Map<string, number>()
  for (const thread of threads) {
    const summary = threadSummary(store, thread)
    maybeOutside.set(thread, summary.outside.maybe)
    const turns = store.activityOfThread(thread).filter((item) => item.kind === "turn").slice(-Number(values.turns))
    const parts = new Map([
      // Paths only a turn's timing tied to it go by design (weak footprint rows): told apart, not compared.
      ["summary", hashed(JSON.stringify({ ...summary, outside: { named: summary.outside.named } }))],
      ["counts", hashed(JSON.stringify(store.turnChangesOf(thread)))],
      ["calls", hashed(JSON.stringify(store.activityOfThread(thread).length))],
    ])
    for (const turn of turns) {
      const counted = turnChanges(view, thread, turn.id, "settled", 0)
      parts.set(`turn ${turn.id} count`, hashed(JSON.stringify(counted)))
      parts.set(`turn ${turn.id} writers`, hashed(JSON.stringify(counted.files.slice(0, 25).map((file) => [file.path, turnWriters(view, thread, turn.id, file) ?? "not kept"]))))
      await new Promise<void>((done) => setImmediate(done))
    }
    perThread.set(thread, parts)
  }
  const recency = await inSlices(store.recency(now, () => true))
  return {
    files, lines, unnamed, perThread, maybeOutside,
    recency: hashed(JSON.stringify([[...recency.changed].sort(), [...recency.worked].sort()])),
    roots: hashed(JSON.stringify(store.roots())),
  }
}

// --- Before anything is opened as an owner would.
const before = new DatabaseSync(journal)
before.exec("PRAGMA busy_timeout=5000")
assert.deepEqual(before.prepare("PRAGMA quick_check").all().map((row) => row.quick_check), ["ok"], "the copy must be whole before it is pruned")
const sizesBefore = sizes(before)
const bytesBefore = size(journal)
// What letting go of clean sleeping roots would take at each window: active roots with no uncommitted file, by when last seen.
const clean = before.prepare(`SELECT r.id, r.seen_at AS seen, (SELECT count(*) FROM stats s WHERE s.root = r.id) AS stats FROM roots r
  WHERE r.active = 1 AND NOT EXISTS (SELECT 1 FROM files f WHERE f.root = r.id)`).all().map((row) => ({ seen: Number(row.seen), stats: Number(row.stats) }))
const letGo = (days: number) => {
  const gone = clean.filter((root) => root.seen < now - days * DAY)
  return `${gone.length} roots, ${gone.reduce((sum, root) => sum + root.stats, 0).toLocaleString("en-US")} stat rows`
}
const activeRoots = Number(before.prepare("SELECT count(*) AS count FROM roots WHERE active = 1").get()?.count)
console.log(`letGoClean: of ${activeRoots} tracked roots, ${clean.length} hold nothing uncommitted; asleep past 7 days: ${letGo(7)}; past 14 days: ${letGo(14)}`)
before.close()

// --- The tracker as a host's writer opens it, with nothing to watch: every root is a folder that is there, and stays asleep.
const never = (what: string) => () => {
  throw new Error(`The proof must not ${what}.`)
}
const ports: TrackerPorts = {
  fs: { stat: async () => ({ kind: "directory", dev: 0, ino: 0, size: 0, mode: 0, mtimeNs: 0n, ctimeNs: 0n }), read: never("read a file"), walk: never("walk a root") },
  events: { watch: never("watch a root"), mark: async () => null, since: async () => null },
  clock: { now: () => now },
  storage: dirname(journal),
  device: "proof",
}
const tracker = await LaptopTracker.open(ports)
await tracker.settled()
const { store } = tracker
const states = [...tracker.rootStates().values()]
assert.ok(states.every(({ root }) => tracker.asleep(root.path)), "every root stays asleep")
console.log(`opened: ${states.length} roots, all asleep; ${states.reduce((sum, state) => sum + state.files.size, 0)} uncommitted files`)

// --- Which Threads are worked in, and by which rule: the store's own answer, and the rule read beside it.
const reader = new DatabaseSync(journal, { readOnly: true })
let started = performance.now()
const live = store.liveness(retainAfter)
let slowest = 0
for (let from = retainAfter; from <= now; from += DAY) {
  const began = performance.now()
  store.workEndedInside(live, from, from + DAY)
  slowest = Math.max(slowest, performance.now() - began)
}
console.log(`liveness read in ${(performance.now() - started).toFixed(1)} ms, its slowest day ${slowest.toFixed(1)} ms: ${live.known.size} Threads with work that began before the window and ended inside it`)
const early = new Set(live.known.keys())
const rule = (thread: string): string | undefined =>
  reader.prepare("SELECT 1 FROM activity WHERE thread=? AND started_at >= ? LIMIT 1").get(thread, retainAfter) ? "work began inside the window"
    : early.has(thread) ? "work that began before the window ended inside it"
      : reader.prepare("SELECT 1 FROM entries WHERE thread=? AND seq >= ? LIMIT 1").get(thread, live.horizon) ? "an entry journaled inside the window"
        : reader.prepare("SELECT 1 FROM activity WHERE ended_at IS NULL AND thread=? LIMIT 1").get(thread) ? "work still open"
          : reader.prepare("SELECT 1 FROM turn_changes WHERE thread=? AND at >= ? LIMIT 1").get(thread, retainAfter) ? "a turn counted inside the window" : undefined
const worked = new Map<string, string>()
const stopped: string[] = []
for (let thread = store.nextThread(""); thread !== undefined; thread = store.nextThread(thread)) {
  const why = rule(thread)
  assert.equal(store.threadLive(thread, live), why !== undefined, `the store and the rules read beside it disagree about ${thread}`)
  if (why) worked.set(thread, why)
  else stopped.push(thread)
}
const rowsOf = (thread: string) => Number(reader.prepare("SELECT (SELECT count(*) FROM activity WHERE thread=?1) + (SELECT count(*) FROM entries WHERE thread=?1) AS count").get(thread)?.count)
const largest = [...worked].map(([thread, why]) => ({ thread, why, rows: rowsOf(thread) })).sort((a, b) => b.rows - a.rows).slice(0, 10)
const byRule = new Map<string, number>()
for (const why of worked.values()) byRule.set(why, (byRule.get(why) ?? 0) + 1)
console.log(`Threads: ${worked.size} worked, ${stopped.length} stopped; worked by rule: ${[...byRule].map(([why, count]) => `${count} ${why}`).join("; ")}`)
for (const item of largest) console.log(`  kept ${item.thread}: ${item.rows.toLocaleString("en-US")} calls and entries, ${item.why}`)

const newest = reader.prepare("SELECT thread FROM activity GROUP BY thread ORDER BY max(started_at) DESC LIMIT ?").all(Number(values.threads)).map((row) => String(row.thread))
assert.ok(newest.every((thread) => worked.has(thread)), "the Threads with the newest work are worked Threads")
started = performance.now()
const truthBefore = await truth(store, newest)
console.log(`truth before: ${truthBefore.files.size} uncommitted files (${truthBefore.lines} line writers named, ${truthBefore.unnamed} naming no entry), ${newest.length} Threads, in ${Math.round(performance.now() - started)} ms`)

// --- Prune to the end: each sweep runs to its end in one pass here; a host takes 400 steps an hour.
const wal = `${journal}-wal`
let longest = 0
let transactions = 0
let peak = size(wal)
const transaction = store.transaction.bind(store)
store.transaction = (run) => {
  const began = performance.now()
  try {
    return transaction(run)
  } finally {
    longest = Math.max(longest, performance.now() - began)
    transactions++
    if (transactions % 50 === 0) peak = Math.max(peak, size(wal))
  }
}
// Each kind of step, timed whole (its reads and its transaction): how many, and the longest.
const steps = new Map<string, { count: number; longest: number }>()
const timed = <Args extends readonly (string | number | object | undefined)[], Result>(name: string, step: (...args: Args) => Result) => (...args: Args): Result => {
  const began = performance.now()
  try {
    return step(...args)
  } finally {
    const seen = steps.get(name) ?? { count: 0, longest: 0 }
    steps.set(name, { count: seen.count + 1, longest: Math.max(seen.longest, performance.now() - began) })
  }
}
store.pruneEntries = timed("entries", store.pruneEntries.bind(store))
store.pruneThread = timed("a Thread's records", store.pruneThread.bind(store))
store.pruneCommits = timed("commits", store.pruneCommits.bind(store))
store.pruneGaps = timed("gaps", store.pruneGaps.bind(store))
store.dropStrayStats = timed("stray stat rows", store.dropStrayStats.bind(store))
store.compactFootprintStep = timed("the footprint's rebuild", store.compactFootprintStep.bind(store))
store.nextThread = timed("finding the next Thread", store.nextThread.bind(store))
started = performance.now()
const passes: Awaited<ReturnType<LaptopTracker["prune"]>>[] = []
for (;;) {
  const pass = await tracker.prune(100_000_000)
  passes.push(pass)
  console.log(`pass ${passes.length}: ${JSON.stringify(pass)}`)
  if (Object.values(pass).every((count) => count === 0)) break
  if (passes.length > 20) throw new Error("Pruning does not come to an end.")
}
const pruneMs = performance.now() - started
peak = Math.max(peak, size(wal))
for (const [name, seen] of steps) console.log(`  steps of ${name}: ${seen.count}, the longest ${seen.longest.toFixed(1)} ms`)
console.log(`pruned in ${passes.length} passes, ${(pruneMs / 1000).toFixed(1)} s, ${transactions} transactions, the longest ${longest.toFixed(1)} ms; the write-ahead log peaked at ${mb(peak)}`)

// --- The same reading again.
started = performance.now()
const truthAfter = await truth(store, newest)
console.log(`truth after in ${Math.round(performance.now() - started)} ms`)
const differences: string[] = []
for (const [file, was] of truthBefore.files) if (truthAfter.files.get(file) !== was) differences.push(`uncommitted file ${file}`)
if (truthAfter.files.size !== truthBefore.files.size) differences.push(`uncommitted files: ${truthBefore.files.size} before, ${truthAfter.files.size} after`)
if (truthAfter.unnamed !== truthBefore.unnamed) differences.push(`lines naming no entry: ${truthBefore.unnamed} before, ${truthAfter.unnamed} after`)
for (const [thread, was] of truthBefore.perThread) for (const [part, value] of was) if (truthAfter.perThread.get(thread)?.get(part) !== value) differences.push(`Thread ${thread}: ${part}`)
if (truthAfter.recency !== truthBefore.recency) differences.push("recency")
if (truthAfter.roots !== truthBefore.roots) differences.push("roots")
const maybe = [...truthBefore.maybeOutside].filter(([thread, count]) => count !== truthAfter.maybeOutside.get(thread))
console.log(`by design: ${maybe.length} of the ${newest.length} Threads counted paths only timing tied to them (${maybe.reduce((sum, [, count]) => sum + count, 0)} in all); each now counts ${[...new Set(maybe.map(([thread]) => truthAfter.maybeOutside.get(thread)))].join(", ") || "as before"}`)
console.log(differences.length ? `DIFFERENCES (${differences.length}):\n  ${differences.slice(0, 200).join("\n  ")}` : "no difference: every uncommitted file, every worked Thread read, recency and the roots read the same")

// --- The footprint table without its second copy: rebuilt by the pass that swept every Thread.
const footprintRows = Number(reader.prepare("SELECT count(*) AS count FROM footprint").get()?.count)
console.log(`footprint: ${footprintRows.toLocaleString("en-US")} rows in the rebuilt table`)
assert.ok(store.footprintCompact(), "the footprint table is keyed by its primary key alone")
assert.equal(Number(reader.prepare("SELECT count(*) AS count FROM footprint WHERE evidence = 'weak'").get()?.count), 0)
assert.equal(Number(reader.prepare("SELECT count(*) AS count FROM sqlite_master WHERE tbl_name='footprint' AND type='index'").get()?.count), 0)
assert.equal(Number(reader.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='footprint_compact'").get()?.count), 0)
const sample = worked.keys().next().value
if (sample) assert.doesNotThrow(() => store.footprint("thread", sample))
reader.close()
await tracker.close()

// --- Sizes, SQLite's checks, and the file compacted.
const after = new DatabaseSync(journal)
after.exec("PRAGMA busy_timeout=5000")
const sizesAfter = sizes(after)
console.log("table: rows before -> after, bytes before -> after")
for (const [table, was] of sizesBefore) {
  const is = sizesAfter.get(table) ?? { rows: 0, bytes: 0 }
  console.log(`  ${table}: ${was.rows.toLocaleString("en-US")} -> ${is.rows.toLocaleString("en-US")}, ${mb(was.bytes)} -> ${mb(is.bytes)}`)
}
const integrity = after.prepare("PRAGMA integrity_check").all().map((row) => String(row.integrity_check))
const foreign = after.prepare("PRAGMA foreign_key_check").all()
console.log(`integrity_check: ${integrity.join(", ")}; foreign_key_check: ${foreign.length} rows`)
started = performance.now()
after.exec("PRAGMA wal_checkpoint(TRUNCATE)")
after.exec("VACUUM")
after.exec("PRAGMA wal_checkpoint(TRUNCATE)")
console.log(`file: ${mb(bytesBefore)} before, ${mb(size(journal))} after VACUUM, which took ${((performance.now() - started) / 1000).toFixed(1)} s`)
console.log(`integrity_check after VACUUM: ${after.prepare("PRAGMA integrity_check").all().map((row) => String(row.integrity_check)).join(", ")}`)
after.close()
console.log(`a worked Thread for an older build to read: ${newest[0]}`)
if (differences.length || integrity.join() !== "ok" || foreign.length) process.exitCode = 1
