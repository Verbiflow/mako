import { mkdtemp, readdir, rm } from "node:fs/promises"
import { DatabaseSync, backup } from "node:sqlite"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { LiveJournal, readBase } from "@mako/host/conversations/live-journal"
import { mergedBase } from "@mako/host/conversations/stream-merging"

/**
 * Runs the merge every reading of a live conversation runs (`mergedBase`)
 * on copies of this Mac's live journals, and reports by harness what it
 * costs and where the stream and the record disagree:
 *
 *   npm run check:journal-merge -- [conversations folder]
 *
 * The folder defaults to Mako's own. Each journal is copied by SQLite's
 * backup, which reads it as one transaction while Mako may be writing, and
 * the copy is read and dropped; the originals are opened read-only. It
 * prints counts and types, never content. Exits 1 when merging a merged
 * base changes it, or a merge changes what the record counts.
 */

const Session = z.object({ harness: z.string(), executionContext: z.object({ runtime: z.object({ version: z.string().optional() }).passthrough().optional() }).passthrough().optional() }).passthrough()
const Row = z.object({ value: z.string() })

const folder = process.argv[2] ?? join(homedir(), "Library", "Application Support", "mako", "conversations")
const ids = (await readdir(folder)).filter((name) => /^[0-9a-f-]{36}\.sqlite$/.test(name)).map((name) => name.slice(0, -".sqlite".length))
const scratch = await mkdtemp(join(tmpdir(), "mako-merge-journals-"))

interface Tally {
  journals: number
  merged: number
  record: number
  stream: number
  supplied: number
  unaligned: number
  ms: number
  slowest: number
  mismatches: Map<string, number>
  versions: Set<string>
}
const tallies = new Map<string, Tally>()
const failures: string[] = []
let unread = 0

try {
  for (const id of ids) {
    const source = new DatabaseSync(join(folder, `${id}.sqlite`), { readOnly: true })
    try {
      await backup(source, join(scratch, `${id}.sqlite`))
    } catch {
      unread++
      continue
    } finally {
      source.close()
    }
    const journal = new LiveJournal(scratch, id)
    const snapshot = (() => {
      try {
        return journal.read()
      } catch {
        return null
      }
    })()
    const copy = new DatabaseSync(join(scratch, `${id}.sqlite`), { readOnly: true })
    const row = Row.safeParse(copy.prepare("SELECT value FROM base WHERE id=1").get())
    copy.close()
    journal.close()
    await rm(join(scratch, `${id}.sqlite`), { force: true })
    await rm(join(scratch, `${id}.sqlite-wal`), { force: true })
    await rm(join(scratch, `${id}.sqlite-shm`), { force: true })
    if (!snapshot) {
      unread++
      continue
    }
    const session = Session.safeParse(snapshot.session)
    const stored = row.success ? readBase(row.data.value) : null
    // The record's harness, whose declarations the merge reads; a session can run one harness's agent through another's.
    const harness = stored?.base.ref.harness ?? session.data?.harness ?? "unknown"
    const tally = tallies.get(harness) ?? { journals: 0, merged: 0, record: 0, stream: 0, supplied: 0, unaligned: 0, ms: 0, slowest: 0, mismatches: new Map(), versions: new Set() }
    tallies.set(harness, tally)
    tally.journals++
    const version = session.data?.harness === harness ? session.data.executionContext?.runtime?.version : undefined
    if (version) tally.versions.add(version)
    const covered = snapshot.baseCoveredBlocks ?? 0
    if (!stored || covered <= 0 || snapshot.baseLiveStart === undefined) continue
    const started = performance.now()
    const { base, merge } = mergedBase(stored.base, snapshot.blocks, covered, snapshot.baseLiveStart)
    const ms = performance.now() - started
    if (!merge) continue
    tally.merged++
    tally.record += stored.base.entries.length - (snapshot.baseLiveStart - stored.base.start)
    tally.stream += covered
    tally.supplied += merge.supplied
    tally.ms += ms
    tally.slowest = Math.max(tally.slowest, ms)
    if (merge.unaligned) tally.unaligned++
    for (const mismatch of merge.mismatches) {
      const key = `${mismatch.kind} ${mismatch.type}`
      tally.mismatches.set(key, (tally.mismatches.get(key) ?? 0) + 1)
    }
    const again = mergedBase(base, snapshot.blocks, covered, snapshot.baseLiveStart).base
    if (JSON.stringify(again.entries) !== JSON.stringify(base.entries)) failures.push(`${harness} ${id}: merging the merged base changed it`)
    if (base.total !== stored.base.total) failures.push(`${harness} ${id}: the merge changed the record's count`)
    if (JSON.stringify(snapshot.base?.entries) !== JSON.stringify(base.entries)) failures.push(`${harness} ${id}: the journal's own reading merged differently`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

const rows = [...tallies].sort(([a], [b]) => a.localeCompare(b))
console.log(`${ids.length} journals in ${folder}${unread ? `, ${unread} unreadable` : ""}\n`)
console.log(["harness", "journals", "merged", "record entries", "stream entries", "supplied", "unaligned", "per entry", "slowest"].join("\t"))
for (const [harness, tally] of rows) {
  const entries = tally.record + tally.stream
  console.log([harness, tally.journals, tally.merged, tally.record, tally.stream, tally.supplied, tally.unaligned, entries ? `${((tally.ms * 1000) / entries).toFixed(2)} µs` : "-", `${tally.slowest.toFixed(2)} ms`].join("\t"))
}
for (const [harness, tally] of rows) {
  if (!tally.mismatches.size) continue
  const kinds = [...tally.mismatches].sort((a, b) => b[1] - a[1])
  console.log(`\n${harness}${tally.versions.size ? ` (${[...tally.versions].sort().join(", ")})` : ""}: ${kinds.reduce((sum, [, count]) => sum + count, 0)} mismatches`)
  for (const [key, count] of kinds) console.log(`  ${String(count).padStart(5)}  ${key}`)
}
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length) process.exit(1)
console.log(`\nPASS: every merged base merges to itself, keeps the record's count, and reads as the journal reads it`)
