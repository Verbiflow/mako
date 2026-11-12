import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { JournalStore } from "@mako/host/attribution/journal-store"

/**
 * A record of changes shaped like the person's on 2026-11-12, made up, never copied: 1.7 GB holding 203 roots,
 * 1,016,086 stat rows, 177,459 entries, 175,857 calls, turns and background work over 29 days (a call's effects
 * about 324 characters of JSON), 646,804 footprint rows, 89,441 commits' authors (about 1.7 KB each) and 31,951
 * stored contents (432 MB). `megabytes` scales every count alike. The roots are folders nobody tracks now
 * (`active` 0), as most of the person's were; the bench's own checkouts are tracked live beside them.
 */
export const PERSON_JOURNAL = {
  megabytes: 1_708,
  roots: 203,
  stats: 1_016_086,
  entries: 177_459,
  activity: 175_857,
  footprint: 646_804,
  footprintTurns: 5_859,
  commits: 89_441,
  blobs: 31_951,
  blobBytes: 432 * 1024 * 1024,
  days: 29,
}

/** The journal made: where, its size, and how long making it took. */
export interface SyntheticJournal {
  file: string
  bytes: number
  ms: number
}

export function makeSyntheticJournal(file: string, options: { megabytes?: number; now?: number; log?: (line: string) => void } = {}): SyntheticJournal {
  const started = performance.now()
  const scale = (options.megabytes ?? PERSON_JOURNAL.megabytes) / PERSON_JOURNAL.megabytes
  const count = (n: number) => Math.max(1, Math.round(n * scale))
  const now = options.now ?? Date.now()
  const span = PERSON_JOURNAL.days * 86_400_000
  const log = options.log ?? (() => undefined)
  mkdirSync(dirname(file), { recursive: true })
  // The schema and its format marks as this build writes them.
  JournalStore.open(file, { device: "synthetic" }).close()
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;")
  const inBatches = (total: number, label: string, insert: (index: number) => void) => {
    const batch = 20_000
    for (let first = 0; first < total; first += batch) {
      db.exec("BEGIN")
      for (let index = first; index < Math.min(total, first + batch); index++) insert(index)
      db.exec("COMMIT")
    }
    log(`${label}: ${total}`)
  }
  const threads = Array.from({ length: 153 }, () => randomUUID())
  const sessions = threads.map(() => randomUUID())
  const roots = Array.from({ length: count(PERSON_JOURNAL.roots) }, (_, index) => ({ id: `r-synthetic-${index}`, path: `/synthetic/checkouts/w${index}` }))
  const at = (index: number, total: number) => now - span + Math.floor((index / total) * span)

  const root = db.prepare("INSERT INTO roots (id, path, kind, carry, repository, head, mark, seen_at, tracked_at, active) VALUES (?, ?, 'workspace', NULL, 1, ?, NULL, ?, ?, 0)")
  inBatches(roots.length, "roots", (index) => {
    const seen = at(index, roots.length)
    root.run(roots[index]!.id, roots[index]!.path, randomBytes(20).toString("hex"), seen, seen)
  })
  const stat = db.prepare("INSERT INTO stats (root, path, dev, ino, size, mode, mtime_ns, ctime_ns, ref, checked_ns) VALUES (?, ?, 1, ?, ?, 33188, ?, ?, NULL, ?)")
  const statRows = count(PERSON_JOURNAL.stats)
  inBatches(statRows, "stats", (index) => {
    const ns = BigInt(at(index, statRows)) * 1_000_000n
    stat.run(roots[index % roots.length]!.id, `packages/host/src/module-${Math.floor(index / roots.length)}/file-${index}.ts`, index, 1_000 + (index % 5_000), ns, ns, ns)
  })
  const blob = db.prepare("INSERT INTO blobs (ref, size, at, data) VALUES (?, ?, ?, ?)")
  const blobRows = count(PERSON_JOURNAL.blobs)
  const blobSize = Math.round(PERSON_JOURNAL.blobBytes / PERSON_JOURNAL.blobs)
  const refs: string[] = []
  inBatches(blobRows, "blobs", (index) => {
    const ref = randomBytes(32).toString("hex")
    refs.push(ref)
    blob.run(ref, blobSize, at(index, blobRows), randomBytes(blobSize))
  })
  const effects = (index: number) => JSON.stringify([{ kind: "command", command: `rg --files -g AGENTS.md -g '!node_modules' . /synthetic/home 2>/dev/null | head -${index % 90}`, cwd: `/synthetic/checkouts/w${index % roots.length}`, exitCode: 0 }, { kind: "modify", path: `/synthetic/checkouts/w${index % roots.length}/src/file-${index}.ts` }])
  const activity = db.prepare("INSERT INTO activity (session, kind, id, thread, turn, checkout, cwd, label, named, record, started_at, ended_at, effects, status, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)")
  const activityRows = count(PERSON_JOURNAL.activity)
  inBatches(activityRows, "activity", (index) => {
    const which = index % threads.length
    const kind = index % 27 === 0 ? "turn" : index % 68 === 1 ? "background" : "call"
    const started = at(index, activityRows)
    const checkout = `/synthetic/checkouts/w${which % roots.length}`
    activity.run(sessions[which]!, kind, `${kind}-${index}`, threads[which]!, `turn-${Math.floor(index / 27)}`, checkout, checkout, kind === "call" ? "Bash" : null,
      kind === "call" ? JSON.stringify([`${checkout}/src/file-${index}.ts`]) : "[]", started, started + 1_000 + (index % 60_000), kind === "call" ? effects(index) : null, kind === "call" ? "completed" : null)
  })
  const entry = db.prepare(`INSERT INTO entries (at, changed_at, root, path, kind, from_path, before, after, size, text, added, removed, stored, observed, gap, restores,
    certainty, thread, session, author, settled, map, turn, git) VALUES (?, ?, ?, ?, 'modify', NULL, ?, ?, 2048, 1, 3, 1, 1, 'event', NULL, NULL, 'window', ?, ?, ?, 1, ?, ?, NULL)`)
  const entryRows = count(PERSON_JOURNAL.entries)
  const author = (which: number) => JSON.stringify({ certainty: "window", author: { thread: threads[which], session: sessions[which] }, candidates: [], reason: "only-writer-in-window", padding: "x".repeat(120) })
  inBatches(entryRows, "entries", (index) => {
    const which = index % threads.length
    const when = at(index, entryRows)
    entry.run(when, when, roots[index % roots.length]!.id, `packages/host/src/module-${index % 400}/file-${index}.ts`, refs[index % refs.length]!, refs[(index + 1) % refs.length]!,
      threads[which]!, sessions[which]!, author(which), randomBytes(176), `turn-${Math.floor(index / 27)}`)
  })
  const footprint = db.prepare("INSERT INTO footprint (thread, session, turn, path, access, evidence, at, size, ref, secret, basis) VALUES (?, ?, ?, ?, 'read', 'events', ?, 512, NULL, 0, 'tracked')")
  const footprintRows = count(PERSON_JOURNAL.footprint)
  inBatches(footprintRows, "footprint", (index) => {
    const which = index % threads.length
    footprint.run(threads[which]!, sessions[which]!, `turn-${Math.floor(index / 110)}`, `/synthetic/home/.cache/tool-${index % 3_000}/file-${index}.json`, at(index, footprintRows))
  })
  const commit = db.prepare("INSERT INTO commits (root, oid, path, at, authors, ref) VALUES (?, ?, ?, ?, ?, ?)")
  const commitRows = count(PERSON_JOURNAL.commits)
  inBatches(commitRows, "commits", (index) => {
    commit.run(roots[index % roots.length]!.id, randomBytes(20).toString("hex"), `packages/host/src/module-${index % 400}/file-${index}.ts`, at(index, commitRows), randomBytes(1_664), refs[index % refs.length]!)
  })
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  const bytes = statSync(file).size
  return { file, bytes, ms: Math.round(performance.now() - started) }
}
