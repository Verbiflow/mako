/**
 * Mako's log on real conversations: clones a data root's journals (APFS
 * copy-on-write, so the originals are never opened), then for each one
 * measures the first open, which takes the journal's facts into the log,
 * a reopen, which folds the log and finds nothing to add, and the commits a
 * running turn makes. Checks that every log folds to its journal's rows.
 *
 *   npm run bench:mako-log -- <conversations folder> [--json]
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { foldMakoLog, makoFacts, makoLogDifference } from "@mako/host/conversations/mako-log"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"

const [source] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const json = process.argv.includes("--json")
if (!source) throw new Error("Usage: bench-mako-log <conversations folder> [--json]")

const root = await mkdtemp(join(tmpdir(), "mako-log-bench-"))
const clone = join(root, "conversations")
execFileSync("cp", ["-cR", source, clone])

interface Row {
  id: string
  requests: number
  events: number
  logBytes: number
  factBytes: number
  firstOpen: number
  reopen: number
  fold: number
  compare: number
  flush: number
  requestCommit: number
  requestDiff: number
  largestRequest: number
}

const time = <Value>(work: () => Value): [Value, number] => {
  const started = performance.now()
  const value = work()
  return [value, performance.now() - started]
}

const rows: Row[] = []
let unreadable = 0
try {
  const ids = (await readdir(clone)).filter((name) => name.endsWith(".sqlite")).map((name) => name.slice(0, -".sqlite".length))
  for (const id of ids) {
    let journal = new LiveJournal(clone, id)
    let snapshot: LiveSnapshot | null
    let firstOpen: number
    try {
      ;[snapshot, firstOpen] = time(() => journal.read())
    } catch {
      unreadable++
      journal.close()
      continue
    }
    if (!snapshot) {
      journal.close()
      continue
    }
    journal.close()
    journal = new LiveJournal(clone, id)
    const events = journal.makoLog().length
    const [reopened, reopen] = time(() => journal.read()!)
    const log = journal.makoLog()
    assert.equal(log.length, events, `${id}: a reopen added to the log`)
    assert.equal(makoLogDifference(log, makoFacts(reopened)), undefined, `${id}: the log does not fold to the rows`)
    const [, fold] = time(() => foldMakoLog(log))
    const state = foldMakoLog(log)
    const [, compare] = time(() => state.advance(makoFacts(reopened)))

    const grown: LiveSnapshot = { ...reopened, revision: reopened.revision + 1, blocks: [...reopened.blocks, { type: "text", id: "bench-text", text: "more" }] }
    const [, flush] = time(() => journal.commit(grown, reopened))
    const last = grown.requests.at(-1)
    const settled: LiveSnapshot = last
      ? { ...grown, revision: grown.revision + 1, requests: [...grown.requests.slice(0, -1), { ...last, error: "bench" }] }
      : { ...grown, revision: grown.revision + 1, requests: [{ id: crypto.randomUUID(), text: "bench", attachments: [], status: "queued" }] }
    const [, requestDiff] = time(() => state.advance(makoFacts(settled)))
    const [, requestCommit] = time(() => journal.commit(settled, grown))
    journal.close()

    const db = new DatabaseSync(join(clone, `${id}.sqlite`), { readOnly: true })
    try {
      const logged = db.prepare("SELECT coalesce(sum(length(value)), 0) AS bytes FROM log WHERE origin = 'journal'").get()
      const facts = JSON.stringify(makoFacts(reopened)).length
      rows.push({
        id, requests: reopened.requests.length, events, logBytes: Number(logged?.bytes ?? 0), factBytes: facts,
        firstOpen, reopen, fold, compare, flush, requestCommit, requestDiff,
        largestRequest: Math.max(0, ...reopened.requests.map((request) => JSON.stringify(request).length)),
      })
    } finally {
      db.close()
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const sum = (pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0)
const quantile = (pick: (row: Row) => number, q: number) => {
  const sorted = rows.map(pick).sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}
const ms = (value: number) => `${value.toFixed(value < 10 ? 2 : 0)} ms`
const mib = (value: number) => `${(value / 1048576).toFixed(2)} MiB`
const spread = (label: string, pick: (row: Row) => number) =>
  `${label.padEnd(34)} total ${ms(sum(pick)).padStart(10)}  p50 ${ms(quantile(pick, 0.5)).padStart(9)}  p95 ${ms(quantile(pick, 0.95)).padStart(9)}  max ${ms(quantile(pick, 1)).padStart(9)}`

const result = {
  journals: rows.length,
  unreadable,
  requests: sum((row) => row.requests),
  events: sum((row) => row.events),
  logBytes: sum((row) => row.logBytes),
  factBytes: sum((row) => row.factBytes),
  rows,
}
if (json) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`${rows.length} journals (${unreadable} this build can't read), ${result.requests} requests, ${result.events} events imported, every log folds to its rows`)
  console.log(`log ${mib(result.logBytes)} for ${mib(result.factBytes)} of facts`)
  console.log(spread("first open (imports the log)", (row) => row.firstOpen))
  console.log(spread("reopen (fold, compare, 0 events)", (row) => row.reopen))
  console.log(spread("  of it, fold", (row) => row.fold))
  console.log(spread("  of it, compare to the rows", (row) => row.compare))
  console.log(spread("flush with no fact changed", (row) => row.flush))
  console.log(spread("commit with a request changed", (row) => row.requestCommit))
  console.log(spread("  of it, the log's diff", (row) => row.requestDiff))
  const slowest = [...rows].sort((left, right) => right.requestCommit - left.requestCommit).slice(0, 3)
  for (const row of slowest) console.log(`  slowest ${row.id}: ${ms(row.requestCommit)}, diff ${ms(row.requestDiff)}, ${row.requests} requests, largest ${mib(row.largestRequest)}`)
}
