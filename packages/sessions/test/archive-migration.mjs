import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { SessionArchive, archiveMigrationStatus } from "../dist/archive.js"
import { ArchiveMigration } from "../dist/archive-migration.js"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { keepCopies, keepLegacyCopy } from "./fixtures/archive-copies.mjs"

/**
 * The archive's migration: an archive whose copies are in each state —
 * sessions their harness still has, one it deleted that the record store
 * holds, ones nothing else holds, a child agent's, a legacy folder, one
 * the store hasn't taken, one this build can't read — migrated in the
 * catalog's backfill pass. Rows go only once what replaces them reads back;
 * what's left is listed as Mako's copy and reads as before; a second pass
 * changes nothing; a crash mid-pass loses nothing and the next pass
 * finishes; the space comes back.
 */

const nativeStores = new NativeStores(false)
const crashChild = fileURLToPath(new URL("./fixtures/archive-migration-crash.mjs", import.meta.url))

async function until(check, what, ms = 20_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

const line = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
const message = (role, text) => line("response_item", { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] })

/** A Codex rollout, dated `minute` minutes into the day, with one exchange. */
async function rollout(home, index, minute = index) {
  const dated = join(home, ".codex", "sessions", "2026", "10", "14")
  await mkdir(dated, { recursive: true })
  const id = `01a0e74f-b716-77a2-8b46-${String(index).padStart(12, "0")}`
  const path = join(dated, `rollout-2026-10-14T02-${String(10 + minute).padStart(2, "0")}-00-${id}.jsonl`)
  await writeFile(path, line("session_meta", { id, cwd: home }) + message("user", `Task ${index}`) + message("assistant", `Done ${index}.`))
  const at = new Date(Date.UTC(2026, 9, 14, 2, minute))
  await utimes(path, at, at)
  return { id, path, at: at.toISOString() }
}

/** Mako's copy of a session, as the archive kept it. */
const copy = (thread, text = `Mako's copy of ${thread.id}`, extra = {}) => ({
  ref: { harness: "codex", nativeId: thread.id, path: thread.path, cwd: "/work", title: `Copy ${thread.id.slice(-4)}`, updatedAt: thread.at, ...extra },
  entries: [{ type: "user", id: "u1", text }, { type: "text", id: "t1", text: "kept answer" }],
})

/** The catalog worker's catalog over `home`: Codex's reader, with `picky` paths it can't capture or read. */
function catalogOf(home, { archivePath, recordsPath, log, picky = {} }) {
  class Picky extends CodexProvider {
    async records(path) {
      return path === picky.unrecorded ? null : super.records(path)
    }
    async read(path) {
      if (path === picky.unreadable) throw new Error("this build can't read it")
      return super.read(path)
    }
  }
  return new SessionCatalog([new Picky(nativeStores, home)], {
    archivePath, recordsPath, recordsHome: home, backfill: true, log,
    readBack: { readers: [(stores, place) => new CodexProvider(stores, place?.home ?? home)], stores: nativeStores },
  })
}

async function pass(catalog) {
  await catalog.scan()
  catalog.startWatching()
  await until(() => catalog.backfillProgress?.endedAt, "a backfill pass")
  return catalog.backfillProgress
}

const home = await mkdtemp(join(tmpdir(), "mako-archive-migration-"))
const measured = []
try {
  const archivePath = join(home, "mako-archive")
  const recordsPath = join(home, "mako-records")
  const logs = []
  const log = (text, fields) => logs.push({ text, fields })

  // The harness's sessions; the record store takes them in a first pass, before any archive exists.
  const deleted = await rollout(home, 0)
  const live = [await rollout(home, 1), await rollout(home, 2), await rollout(home, 3)]
  const first = catalogOf(home, { recordsPath, log })
  await pass(first)
  await first.stop()
  // Then the harness deletes one; and two more appear that the store doesn't take: one it can't capture, one this build can't read.
  await rm(deleted.path)
  const unrecorded = await rollout(home, 4)
  const unreadable = await rollout(home, 5)

  // An archive from before: copies of every one of those, of a session nothing else holds, of a child agent, and two legacy folders.
  const gone = { id: "gone-0000", path: join(home, ".codex", "sessions", "2026", "10", "13", "rollout-gone.jsonl"), at: "2026-10-13T00:00:00.000Z" }
  const goneLegacy = { id: "gone-legacy", path: join(home, ".codex", "sessions", "2026", "10", "12", "rollout-legacy.jsonl"), at: "2026-10-12T00:00:00.000Z" }
  const child = { id: "child-0001", path: join(home, ".codex", "sessions", "child.jsonl"), at: "2026-10-14T02:13:30.000Z" }
  await keepCopies(archivePath, [
    copy(deleted), ...live.map((thread) => copy(thread)), copy(unrecorded), copy(unreadable), copy(gone, "only Mako has this"),
    copy(child, "a child's work", { childOf: { nativeId: live[2].id, path: live[2].path, ended: true } }),
  ])
  const legacyFolder = await keepLegacyCopy(archivePath, copy(goneLegacy, "the oldest copy"))
  const duplicateFolder = await keepLegacyCopy(archivePath, copy(live[0], "an older copy of a row"))
  const before = await stat(join(archivePath, "archive.sqlite"))

  // Nothing captures copies any more: a catalog with an archive leaves it as it was until its pass.
  const catalog = catalogOf(home, { archivePath, recordsPath, log, picky: { unrecorded: unrecorded.path, unreadable: unreadable.path } })
  const started = performance.now()
  const progress = await pass(catalog)
  measured.push(`a pass migrating 9 copies: ${Math.round(performance.now() - started)} ms`)
  const report = progress.archive
  assert.ok(report, "the pass ran the migration")
  assert.deepEqual(
    { viaHarness: report.viaHarness, viaRecords: report.viaRecords, copies: report.copies, newCopies: report.newCopies, pending: report.pending, children: report.children, failed: report.failed, legacyFolded: report.legacyFolded, legacyRemoved: report.legacyRemoved },
    { viaHarness: 3, viaRecords: 1, copies: 2, newCopies: 2, pending: 1, children: 1, failed: 1, legacyFolded: 1, legacyRemoved: 1 },
    "each copy in the state its session is in"
  )
  assert.match(report.firstFailure, /doesn't read it from its harness's records/)
  assert.deepEqual(report.left, { rows: 5, copies: 2, pending: 3, migrated: 4 }, "what's left: two copies, a child, one to take, one to read")
  assert.ok(logs.some((entry) => entry.text === "Session archive migration" && entry.fields.viaHarness === 3 && entry.fields.copiesLeft === 2), "the pass logs its counts")
  assert.ok(logs.some((entry) => entry.text === "Session records backfill done" && entry.fields.archiveMigrated === 4), "and the backfill's line carries them")
  assert.equal(existsSync(legacyFolder), false, "a legacy folder is folded into the database")
  assert.equal(existsSync(duplicateFolder), false, "and one a row already holds is removed")
  assert.ok(before.size > 0)

  // Older builds see each dropped row deleted, so none captures it again.
  const look = new DatabaseSync(join(archivePath, "archive.sqlite"), { readOnly: true })
  const captures = Object.fromEntries(look.prepare("SELECT path, deleted FROM archive_captures").all().map((row) => [row.path, row.deleted]))
  for (const thread of [deleted, ...live]) assert.equal(captures[thread.path], 1, `${thread.id}'s row is marked deleted for older builds`)
  assert.deepEqual(look.prepare("SELECT path FROM sessions ORDER BY path").all().map((row) => row.path).sort(), [gone.path, goneLegacy.path, child.path, unrecorded.path, unreadable.path].sort())
  assert.deepEqual(look.prepare("SELECT via, count(*) AS n FROM archive_migration WHERE state = 'migrated' GROUP BY via ORDER BY via").all().map((row) => [row.via, row.n]), [["harness", 3], ["records", 1]])
  look.close()

  // The rail: the deleted session from its records, the two copies marked as Mako's copy only, the rest from their harness.
  const rail = new Map(catalog.list().map((ref) => [ref.nativeId, ref]))
  assert.equal(rail.get(deleted.id)?.archived, true, "the deleted session stays in the rail")
  assert.equal(rail.get(deleted.id)?.copyOnly, undefined, "read from its records, not a copy")
  for (const kept of [gone, goneLegacy]) {
    assert.equal(rail.get(kept.id)?.copyOnly, true, `${kept.id} is marked as Mako's copy only`)
    assert.equal(rail.get(kept.id)?.archived, true)
  }
  for (const thread of [...live, unrecorded, unreadable]) assert.equal(rail.get(thread.id)?.archived, undefined, `${thread.id} is its harness's`)
  assert.equal(rail.has(child.id), false, "a child is never a row")
  assert.equal((await catalog.children(live[2].path))?.children.some((entry) => entry.nativeId === child.id), true, "the child's copy is still listed under its parent")

  // Each reads as before: the deleted one from its records, the copies as kept, paged and whole.
  const restored = await catalog.open(deleted.path)
  assert.ok(restored.entries.some((entry) => entry.type === "user" && entry.text === "Task 0"), "the deleted session reads back from its records")
  assert.equal(restored.ref.copyOnly, undefined)
  const goneStarted = performance.now()
  const page = await catalog.page(gone.path, undefined, 1)
  measured.push(`a kept copy's first page: ${(performance.now() - goneStarted).toFixed(1)} ms`)
  assert.equal(page.ref.copyOnly, true, "a copy's page says it's Mako's copy only")
  assert.equal(page.total, 2)
  assert.deepEqual((await catalog.page(gone.path, 1, 1)).entries.map((entry) => entry.text), ["only Mako has this"], "and pages as before")
  assert.equal((await catalog.open(goneLegacy.path)).entries[0].text, "the oldest copy", "the folded legacy copy reads from the database")
  assert.equal((await catalog.original(gone.path, "u1"))?.kept, false, "a copy has no original")
  const removed = []
  const unsubscribe = catalog.onEvent((event) => removed.push(event))
  await catalog.stop()
  unsubscribe()

  // A second pass changes nothing.
  const again = catalogOf(home, { archivePath, recordsPath, log, picky: { unrecorded: unrecorded.path, unreadable: unreadable.path } })
  const second = (await pass(again)).archive
  assert.deepEqual([second.migrated, second.newCopies, second.copies, second.pending, second.failed, second.legacyFolded], [0, 0, 2, 1, 1, 0], "a second pass drops nothing and notes nothing new")
  assert.equal(second.reclaim, undefined, "and reclaims nothing")
  assert.deepEqual(second.left, report.left)

  // The harness deletes another session after the records were taken: it stays in the rail, from its records, with no archive row.
  const events = []
  again.onEvent((event) => events.push(event))
  await rm(live[0].path)
  await again.scan({ emitChanges: true })
  const later = again.list().find((ref) => ref.nativeId === live[0].id)
  assert.equal(later?.archived, true, "a session its harness deletes later stays in the rail")
  assert.equal(later?.copyOnly, undefined, "from its records")
  assert.deepEqual(events.filter((event) => event.path === live[0].path || event.ref?.path === live[0].path).map((event) => event.type), ["updated"], "announced as kept, not removed")
  assert.ok((await again.open(live[0].path)).entries.some((entry) => entry.text === "Task 1"))
  await again.stop()

  // The status a doctor reads, without writing.
  const status = archiveMigrationStatus(archivePath)
  assert.deepEqual([status.rows, status.copies, status.pending, status.migrated], [5, 2, 3, 4])

  // A read-only catalog migrates nothing.
  const readOnly = new SessionCatalog([new CodexProvider(new NativeStores(true), home)], { archivePath, recordsPath: join(home, "ro"), readOnly: true, backfill: true })
  await readOnly.scan()
  readOnly.startWatching()
  await readOnly.stop()
  assert.equal(readOnly.backfillProgress, null)
  assert.deepEqual(archiveMigrationStatus(archivePath).rows, 5)
  const store = new RecordStore(recordsPath, nativeStores)
  assert.ok(store.listing("codex", deleted.id), "the deleted session's row is kept with its records")
  await store.close()
} finally {
  await rm(home, { recursive: true, force: true })
}

// A crash mid-pass: the process dies right after its first row goes. Nothing else is lost, the database is whole, and the next pass finishes.
{
  const root = await mkdtemp(join(tmpdir(), "mako-archive-crash-"))
  try {
    const threads = Array.from({ length: 40 }, (_, index) => ({
      ref: { harness: "codex", nativeId: `s${index}`, path: `/sessions/s${index}.jsonl`, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() },
      entries: [{ type: "user", id: "u1", text: `prompt ${index}` }, { type: "text", id: "t1", text: "x".repeat(200_000) }],
    }))
    await keepCopies(root, threads)
    const sizeBefore = (await stat(join(root, "archive.sqlite"))).size
    const crashed = await new Promise((resolve) => fork(crashChild, [root, "drop"], { stdio: "inherit" }).once("exit", (code, signal) => resolve(signal)))
    assert.equal(crashed, "SIGKILL", "the process died mid-pass")
    const after = new DatabaseSync(join(root, "archive.sqlite"))
    assert.equal(after.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "the database is whole after the crash")
    assert.equal(after.prepare("SELECT count(*) AS n FROM sessions").get().n, 39, "exactly the row it dropped is gone")
    assert.equal(after.prepare("SELECT count(*) AS n FROM archive_migration WHERE state = 'migrated'").get().n, 1, "with its note, in the same transaction")
    after.close()

    // The next pass, here: every session is held, so every row goes, and the space comes back in a thread of its own.
    const archive = new SessionArchive(root)
    const migration = new ArchiveMigration(archive, heldEverywhere(threads))
    const report = await migration.pass({ stopped: () => false, yieldToPerson: async () => {}, reclaimMinBytes: 0 })
    assert.equal(report.migrated, 39)
    assert.deepEqual(report.left, { rows: 0, copies: 0, pending: 0, migrated: 40 })
    assert.equal(report.reclaim?.ran, true)
    assert.ok(report.reclaim.bytesAfter < sizeBefore / 10, `the file shrank: ${sizeBefore} → ${report.reclaim.bytesAfter} bytes`)
    measured.push(`reclaiming 40 dropped rows (${(sizeBefore / 1024 ** 2).toFixed(1)} MiB): ${Math.round(report.reclaim.ms)} ms in a thread of its own`)
    const again = await migration.pass({ stopped: () => false, yieldToPerson: async () => {} })
    assert.deepEqual([again.rows, again.migrated, again.reclaim], [0, 0, undefined], "and the pass after does nothing")
    await archive.stop()
    const vacuumed = new DatabaseSync(join(root, "archive.sqlite"), { readOnly: true })
    assert.equal(vacuumed.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
    assert.equal(vacuumed.prepare("PRAGMA freelist_count").get().freelist_count, 0, "every free page given back")
    vacuumed.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// A crash while the space is reclaimed: the rewrite is one transaction, so the database is as it was or as it would be.
{
  const root = await mkdtemp(join(tmpdir(), "mako-archive-vacuum-crash-"))
  try {
    const threads = Array.from({ length: 120 }, (_, index) => ({
      ref: { harness: "codex", nativeId: `v${index}`, path: `/sessions/v${index}.jsonl`, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() },
      entries: [{ type: "user", id: "u1", text: `prompt ${index}` }, { type: "text", id: "t1", text: `${index}`.repeat(100_000) }],
    }))
    await keepCopies(root, threads)
    // Half the rows go, as a migration would drop them, and the process dies while the file is rewritten.
    const archive = new SessionArchive(root)
    await archive.load()
    for (const thread of threads.slice(0, 60)) await archive.drop(thread.ref.path, "harness")
    await archive.stop()
    const signal = await new Promise((resolve) => fork(crashChild, [root, "vacuum"], { stdio: "inherit" }).once("exit", (code, signal) => resolve(signal ?? code)))
    assert.equal(signal, "SIGKILL")
    const after = new DatabaseSync(join(root, "archive.sqlite"), { readOnly: true })
    assert.equal(after.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "the database is whole after a crash mid-rewrite")
    assert.equal(after.prepare("SELECT count(*) AS n FROM sessions").get().n, 60, "with every kept row")
    assert.equal(after.prepare("SELECT entries FROM sessions WHERE path = '/sessions/v119.jsonl'").get().entries.length > 100_000, true)
    after.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// A harness whose discovery just failed lists none of its sessions: its rows wait, neither dropped nor taken for copies.
{
  const root = await mkdtemp(join(tmpdir(), "mako-archive-undiscovered-"))
  try {
    const threads = ["a", "b"].map((id) => ({ ref: { harness: "codex", nativeId: id, path: `/sessions/${id}.jsonl`, updatedAt: "2026-10-01T00:00:00.000Z" }, entries: [{ type: "user", id: "u1", text: id }] }))
    await keepCopies(root, threads)
    const archive = new SessionArchive(root)
    let discovered = false
    const source = { ...heldEverywhere([]), discovered: () => discovered, captured: () => false }
    const waiting = await new ArchiveMigration(archive, source).pass({ stopped: () => false, yieldToPerson: async () => {} })
    assert.deepEqual([waiting.pending, waiting.copies, waiting.migrated], [2, 0, 0], "an undiscovered harness's rows wait")
    discovered = true
    const found = await new ArchiveMigration(archive, source).pass({ stopped: () => false, yieldToPerson: async () => {} })
    assert.deepEqual([found.pending, found.copies, found.newCopies], [0, 2, 2], "and are found to be copies once it lists again")
    await archive.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// No copies, no archive: a catalog with an archive path and nothing kept there creates nothing.
{
  const root = await mkdtemp(join(tmpdir(), "mako-archive-none-"))
  try {
    const archive = new SessionArchive(join(root, "archive"))
    await archive.load()
    assert.deepEqual(archive.counts(), { rows: 0, migrated: 0, copies: 0, pending: 0 })
    await archive.stop()
    assert.deepEqual(await readdir(root), [], "nothing is created")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** A source where every session is still its harness's, held by the store, and reads. */
function heldEverywhere(threads) {
  return {
    live: () => threads.map((thread) => thread.ref),
    discovered: () => true,
    captured: () => true,
    decodesNative: async () => 2,
    decodesRecords: async () => null,
    keepListing: async () => true,
  }
}

console.log(`archive migration: copies in every state migrate or stay, read as before, idempotent, crash-safe; ${measured.join("; ")}`)
