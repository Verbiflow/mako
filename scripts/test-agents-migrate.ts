import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { followHostLog, type HostLogLine } from "@mako/host/base/host-log"
import { listedAsThread } from "@mako/host/contracts/thread-list"
import { ThreadStore, THREAD_STORE_MIGRATION, THREAD_STORE_SCHEMA } from "@mako/host/threads/store"

/**
 * Migration 6 on #286's rows (`npm run test:agents-migrate`): a store as a
 * migration-5 build left it, with a started, a discovered and a linked
 * background agent, ended, running and never matched to a Session, opened by
 * this build twice. Each matched row becomes its Session's Thread's edge
 * under its parent's Thread; an ended one's end is its last report, already
 * heard; a stopped one closes its edge; a running one is still followed; the
 * one with no Session goes; the table goes; the second open moves nothing.
 * Then a format-1 build opens the store and reads it without writing.
 */
const root = mkdtempSync(join(tmpdir(), "mako-agents-migrate-"))
const path = join(root, "threads.sqlite")
const NOW = 1_800_000_000_000
const actor = { kind: "service", name: "workspace" } as const

/** Migration 5's table, as #286 made it. */
const BACKGROUND_AGENT_TABLE = `
CREATE TABLE background_agents (
  id TEXT PRIMARY KEY, parent_session TEXT NOT NULL REFERENCES sessions(id), harness TEXT NOT NULL, native_id TEXT,
  record TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE UNIQUE INDEX background_agents_native ON background_agents(harness, native_id) WHERE native_id IS NOT NULL;
CREATE INDEX background_agents_parent ON background_agents(parent_session, started_at);`

/** A row of #286's table, as its record kept it. */
interface LegacyRow {
  id: string
  parent: string
  harness: string
  nativeId?: string
  title: string
  detail?: string
  origin: string
  device: string
  process?: { pid: number; startedAt?: number }
  runDir?: string
  startedAt: number
  ended?: { at: number; kind: string; detail?: string }
}

function setUp() {
  const store = new ThreadStore(path, { now: () => NOW })
  const parent = store.registerJournal({ conversationId: randomUUID(), createdAt: NOW, harness: "codex", bindings: [] }, actor)
  const device = store.deviceId
  // The catalog placed two of the helpers' Sessions before #286 hid them; the others it never placed.
  const placed = (nativeId: string) => store.place({ harness: "claude", nativeId, path: `/claude/${nativeId}.jsonl` }, actor)
  const startedPlacement = placed("started-native")
  const discoveredPlacement = placed("discovered-native")
  store.close()

  const base = { parent: parent.session, harness: "claude", device, startedAt: NOW - 3_600_000 }
  const rows: LegacyRow[] = [
    { ...base, id: "started", origin: "started", nativeId: "started-native", title: "Review the sidebar", detail: "Review the sidebar's filter", runDir: join(root, "runs", "started"), process: { pid: 999_991, startedAt: NOW - 3_600_000 }, ended: { at: NOW - 60_000, kind: "done", detail: "The filter is fixed." } },
    { ...base, id: "discovered", origin: "discovered", nativeId: "discovered-native", title: "Bench the follow", process: { pid: 999_992 } },
    { ...base, id: "linked", origin: "linked", nativeId: "linked-native", title: "Review the sidebar", ended: { at: NOW - 30_000, kind: "stopped" } },
    { ...base, id: "failed", origin: "started", nativeId: "failed-native", harness: "cursor", title: "Record the footer", ended: { at: NOW - 20_000, kind: "failed", detail: "It exited with code 1." } },
    { ...base, id: "never-matched", origin: "started", title: "Never found its Session" },
    { ...base, id: "orphan", origin: "linked", nativeId: "orphan-native", parent: randomUUID(), title: "Parent gone" },
  ]
  // As a migration-5 build left it: format 1, no migration 6, no edge tables, and #286's table.
  const db = new DatabaseSync(path)
  db.exec(`DROP TABLE thread_parents; DROP TABLE thread_reports; DROP TABLE agent_spawns;
    DELETE FROM store_migrations WHERE version = ${THREAD_STORE_MIGRATION};
    UPDATE store_meta SET value = '1' WHERE key IN ('schema', 'reads');
    PRAGMA foreign_keys = OFF;`)
  db.exec(BACKGROUND_AGENT_TABLE)
  const insert = db.prepare("INSERT INTO background_agents (id, parent_session, harness, native_id, record, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
  for (const row of rows) insert.run(row.id, row.parent, row.harness, row.nativeId ?? null, JSON.stringify(row), row.startedAt, row.ended?.at ?? null)
  db.close()
  return { parent, startedPlacement, discoveredPlacement }
}

const lines: HostLogLine[] = []
const stopFollowing = followHostLog((line) => {
  if (line.scope === "agents") lines.push(line)
})
try {
  const { parent, startedPlacement, discoveredPlacement } = setUp()
  const store = new ThreadStore(path, { now: () => NOW })
  const migrated = lines.filter((line) => line.message === "migrated background agents")
  assert.equal(migrated.length, 1, "one line says what moved")
  assert.deepEqual(migrated[0]!.fields, { edges: 4, ended: 3, running: 1, dropped: 2 })

  const edges = store.edges()
  assert.equal(edges.all.length, 4)
  const started = edges.byOp("migrated:started")!
  assert.equal(started.child, startedPlacement.thread, "a placed helper's own Thread becomes the child")
  assert.equal(started.parent, parent.thread)
  assert.equal(started.parentSession, parent.session)
  assert.deepEqual(started.startedBy, { kind: "agent", session: parent.session })
  assert.equal(started.origin, "started")
  assert.equal(started.asked.brief.objective, "Review the sidebar's filter")
  assert.equal(started.run?.runDir, join(root, "runs", "started"), "its run folder stays, for its exit file")
  assert.equal(started.closedAt, undefined)
  const told = store.reportsOf(started.child, 0)
  assert.deepEqual(told.map((report) => [report.id, report.status, report.summary, report.implicit]), [[`report:${started.child}:migrated`, "done", "The filter is fixed.", true]], "an ended run's end is its last report")
  assert.equal(store.undeliveredReports().length, 0, "already heard: no lead wakes for history")

  const discovered = edges.byOp("migrated:discovered")!
  assert.equal(discovered.child, discoveredPlacement.thread)
  assert.equal(discovered.origin, "discovered")
  assert.equal(discovered.run?.ended, undefined, "a running one stays followed")
  assert.equal(discovered.run?.process?.pid, 999_992)
  assert.equal(edges.byRun("claude", "discovered-native")?.child, discovered.child)

  const linked = edges.byOp("migrated:linked")!
  assert.ok(linked.closedAt, "a stopped one's delegation is closed")
  assert.equal(store.reportsOf(linked.child, 0).length, 0, "a stopped one says nothing more")
  assert.notEqual(linked.name, started.name, "two children of one parent never share a name")
  assert.ok(store.thread(linked.child), "an unplaced helper's Session gets a Thread of its own")
  assert.equal(store.place({ harness: "claude", nativeId: "linked-native", path: "/claude/linked-native.jsonl" }, actor).thread, linked.child, "found by its harness Session")

  const failed = edges.byOp("migrated:failed")!
  assert.equal(store.reportsOf(failed.child, 0)[0]?.status, "failed")
  assert.equal(edges.byOp("migrated:never-matched"), undefined, "a row #286 never matched to a Session goes")
  assert.equal(edges.byOp("migrated:orphan"), undefined, "and one whose parent Session is gone")
  assert.equal(listedAsThread({ parent: { thread: started.parent, session: started.parentSession } }), false)
  const table = new DatabaseSync(path, { readOnly: true })
  assert.equal(table.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = 'background_agents'").get(), undefined, "the old table goes")
  assert.deepEqual({ ...table.prepare("SELECT value FROM store_meta WHERE key = 'schema'").get() }, { value: String(THREAD_STORE_SCHEMA) }, "the store is format 2 once migrated")
  table.close()
  store.close()

  lines.length = 0
  const again = new ThreadStore(path, { now: () => NOW })
  assert.equal(lines.filter((line) => line.message === "migrated background agents").length, 0, "a second open moves nothing")
  assert.equal(again.edges().all.length, 4)
  again.close()

  const older = new ThreadStore(path, { now: () => NOW, format: { writableBy: 1, readableBy: 1 } })
  assert.equal(older.writable, false, "a format-1 build reads the migrated store and changes nothing in it")
  assert.equal(older.edges().all.length, 4)
  older.close()
  console.log("agents migrate: ok")
} finally {
  stopFollowing()
  rmSync(root, { recursive: true, force: true })
}
