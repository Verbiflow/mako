import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { declareStoreFormat, guardStoreWrites, NewerStoreError, NewerStoreReadOnlyError } from "@mako/sessions/store-format"
import { ReadOnlyStoreError } from "@mako/sessions/read-only-sqlite"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { HostJobs } from "@mako/host/base/host-jobs"
import { observeProcessIdentity } from "@mako/host/base/process-liveness"
import { LiveThreads } from "@mako/host/conversations/live-threads"
import { AccountHolds } from "@mako/host/harnesses/account-holds"
import { AccountRoot } from "@mako/host/harnesses/accounts-common"
import { ProviderProfileCache } from "@mako/host/harnesses/provider-profile-cache"
import { followOtherHosts } from "@mako/host/threads/groups-follow"
import { SESSION_MEMORY_SCHEMA, SessionHeldError, SessionMemory } from "@mako/host/threads/session-memory"
import { storeFormats } from "@mako/host/threads/store-formats"
import { openThreadStore, THREAD_STORE_SCHEMA, ThreadStore, ThreadStoreVersionError, type JournalFacts, type SourceRef } from "@mako/host/threads/store"

/**
 * The Thread store, the session ledger and the small files every Mako on
 * this Mac shares, opened by this build after a newer Mako changed them.
 * A newer Mako is played by the stores' own `format` option: it raises
 * `writableBy`, stamps its version, adds a column, a table and rows this
 * build doesn't know, and guards its tables, as a build that raises the
 * number does. This build reads everything it knows, declines every write
 * with the calm line, loses nothing, and the newer build reads back all of
 * it; a store past what this build reads is refused with the Mako that
 * reads it named.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-store-formats-")))
process.env.HOME = join(root, "home")
const NEWER = { writableBy: THREAD_STORE_SCHEMA + 1, readableBy: THREAD_STORE_SCHEMA }
const realPath = (path: string) => path
let clock = 1_000
const now = () => clock++
const catalog = { kind: "service", name: "catalog" } as const
const migration = { kind: "service", name: "migration" } as const
const ref = (name: string): SourceRef => ({ harness: "codex", nativeId: name, path: `/sessions/${name}.jsonl` })
const journal = (harness: string, nativeId: string): JournalFacts => ({
  conversationId: randomUUID(), createdAt: clock++, harness, bindings: [{ provider: harness, nativeId, path: `/sessions/${nativeId}.jsonl` }],
})

/** What `work` threw; it must throw an Error. */
function thrown(work: () => void): Error {
  try {
    work()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  assert.fail("expected it to throw")
}

/** Every table's rows, as text: what "nothing was written" compares. */
function dump(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name))
    return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]))
  } finally {
    db.close()
  }
}

/** What a newer Mako's own migration adds: a column and a table this build doesn't know, and guards on the tables it writes. */
function newerMigration(file: string, column: { table: string; name: string; value: string }, guarded: string[], writableBy = NEWER.writableBy): void {
  const db = new DatabaseSync(file)
  try {
    declareStoreFormat(db, writableBy)
    db.exec("BEGIN IMMEDIATE")
    db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} TEXT`)
    db.prepare(`UPDATE ${column.table} SET ${column.name} = ?`).run(column.value)
    db.exec("CREATE TABLE added_by_a_newer_mako (id INTEGER PRIMARY KEY, note TEXT NOT NULL)")
    db.prepare("INSERT INTO added_by_a_newer_mako (note) VALUES ('kept for the newer build')").run()
    guardStoreWrites(db, guarded, writableBy)
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

/** Raise only `reads`, as a build whose change an older reader would misread does, stamping its version. */
function raiseReads(file: string, readableBy: number, writer: string): void {
  const db = new DatabaseSync(file)
  try {
    db.prepare("UPDATE store_meta SET value = ? WHERE key = 'reads'").run(String(readableBy))
    db.prepare("INSERT INTO store_meta (key, value) VALUES ('reads_by', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(writer)
    db.prepare("UPDATE store_meta SET value = ? WHERE key = 'schema'").run(String(readableBy))
  } finally {
    db.close()
  }
}

const THREAD_TABLES = ["threads", "sessions", "memberships", "journals", "locators", "sources", "native_claims", "operations", "executions"]
const DECLINED_THREADS = "A newer Mako (0.163.0) updated your Threads; this one can show them but not change them. Update Mako to edit."

function threadStoreInANewerFormat(): void {
  const path = join(root, "threads.sqlite")
  const current = new ThreadStore(path, { now, realPath, writer: "0.161.2" })
  const started = current.registerJournal(journal("claude", "claude-1"), migration)
  const tab = current.createSession({ operationId: randomUUID(), thread: started.thread, actor: current.person() })
  const imported = current.place(ref("codex-1"), catalog)
  current.renameThread({ operationId: randomUUID(), thread: started.thread, title: "Fix the login redirect", actor: current.person() })
  const groups = current.groups()
  const titles = current.titles()
  current.close()

  const newer = new ThreadStore(path, { now, realPath, format: NEWER, writer: "0.163.0" })
  assert.equal(newer.writable, true, "the newer build writes its own format")
  newer.close()
  newerMigration(path, { table: "threads", name: "color", value: "teal" }, THREAD_TABLES)
  const before = dump(path)

  const older = new ThreadStore(path, { now, realPath })
  assert.equal(older.writable, false, "this build only reads a newer Mako's store")
  assert.deepEqual(older.standing(), { access: "read", build: THREAD_STORE_SCHEMA, format: { writableBy: 2, readableBy: 1, writtenBy: "0.163.0", readableFrom: "0.161.2" } })
  assert.deepEqual(older.groups(), groups, "every Thread and its Sessions read as before")
  assert.deepEqual(older.titles(), titles, "and their names")
  assert.equal(older.sessionPlacement(tab.session)?.thread, started.thread, "a + tab's Session is where it was")
  assert.equal(older.placeMany([ref("codex-1")], catalog).get(ref("codex-1").path)?.session, imported.session, "a catalog row is placed from what the store recorded")
  assert.equal(older.placeMany([ref("codex-new")], catalog).size, 0, "a row nobody placed is served without a Thread, not an error")
  const rename = thrown(() => older.renameThread({ operationId: randomUUID(), thread: started.thread, title: "Renamed", actor: older.person() }))
  assert.ok(rename instanceof NewerStoreReadOnlyError && rename instanceof ReadOnlyStoreError, "a rename is declined as a read-only store's write is")
  assert.equal(rename.message, DECLINED_THREADS, "with the calm line")
  assert.throws(() => older.registerJournal(journal("codex", "codex-2"), migration), NewerStoreReadOnlyError, "a new journal isn't registered")
  assert.throws(() => older.createSession({ operationId: randomUUID(), thread: started.thread, actor: older.person() }), NewerStoreReadOnlyError)

  // The conversation host on such a store: its journals wait for a build that can write it, and nothing it does fails.
  const emitted: HostEvent[] = []
  const live = new LiveThreads({ threads: older, emit: (event) => emitted.push(event) })
  live.registerJournals([journal("grok", "grok-1"), journal("devin", "devin-1")])
  assert.deepEqual(live.placement("missing"), {}, "a journal it couldn't register is served without a Thread")
  older.close()
  assert.equal(dump(path), before, "nothing in the store changed: its column, table and rows are as the newer build left them")

  // The newer build reads back everything, its own additions included, and goes on writing.
  const back = new ThreadStore(path, { now, realPath, format: NEWER })
  assert.deepEqual(back.groups(), groups)
  back.renameThread({ operationId: randomUUID(), thread: started.thread, title: "Renamed by the newer build", actor: back.person() })
  back.close()
  const raw = new DatabaseSync(path, { readOnly: true })
  assert.deepEqual(raw.prepare("SELECT DISTINCT color FROM threads").all().map((row) => row.color), ["teal"], "the newer build's column kept its values")
  assert.equal(raw.prepare("SELECT count(*) AS n FROM added_by_a_newer_mako").get()?.n, 1, "and its table its rows")
  raw.close()

  // Past `reads`: refused, the Mako that reads it named, and left as it is.
  raiseReads(path, 3, "0.170.0")
  const refused = readFileSync(path)
  const past = thrown(() => new ThreadStore(path, { now, realPath }))
  assert.ok(past instanceof ThreadStoreVersionError && past instanceof NewerStoreError)
  assert.ok(past.message.startsWith("The Thread store needs Mako 0.170.0 or later to read"), past.message)
  assert.throws(() => new ThreadStore(path, { now, realPath, readOnly: true }), ThreadStoreVersionError, "a fixture desk's reader too")
  const opened = openThreadStore(path, { now, realPath })
  assert.equal(opened.store, null)
  assert.ok(opened.problem?.startsWith("Threads are off: The Thread store needs Mako 0.170.0 or later to read"), opened.problem)
  assert.deepEqual(readFileSync(path), refused, "a refused store is not written")
  console.log("PASS: a newer Mako's Thread store is read, every change declined with the line, nothing lost; past reads, refused by version")
}

async function threadStoreRaisedWhileOpen(): Promise<void> {
  const path = join(root, "threads-raised.sqlite")
  const open = new ThreadStore(path, { now, realPath })
  const placed = open.registerJournal(journal("codex", "codex-1"), migration)
  const jobs = new HostJobs()
  const subscribed = jobs.demand("a client is subscribed")
  subscribed.set(true)
  let told = 0
  const stop = followOtherHosts(open, () => {}, { jobs, subscribed, everyMs: 20, formats: { key: () => JSON.stringify(open.standing()), changed: () => told++ } })

  // A development build starts beside the running app and migrates the store.
  const newer = new ThreadStore(path, { now, realPath, format: NEWER, writer: "0.0.1+development" })
  newer.renameThread({ operationId: randomUUID(), thread: placed.thread, title: "Named by the development build", actor: newer.person() })
  newer.close()
  newerMigration(path, { table: "threads", name: "color", value: "teal" }, THREAD_TABLES)
  // A deadline, not a count of tries: beside a whole suite a tick can come late.
  for (const deadline = Date.now() + 30_000; !told && Date.now() < deadline;) await delay(20)
  stop()
  jobs.stop()
  assert.equal(told, 1, "the running host's windows hear of it once")
  assert.equal(open.standing().access, "read", "the running host now only reads the store")
  const late = thrown(() => open.renameThread({ operationId: randomUUID(), thread: placed.thread, title: "Late", actor: open.person() }))
  assert.ok(late instanceof NewerStoreReadOnlyError)
  assert.ok(late.message.startsWith("A development build of Mako (0.0.1) updated your Threads; this one can show them but not change them."), late.message)
  assert.equal(open.sessionPlacement(placed.session)?.thread, placed.thread, "the running host still places its Sessions")
  assert.equal(open.titleEntry(placed.thread)?.title, "Named by the development build", "and reads what the newer build wrote")
  open.close()

  // A build from before this rule, which declares no format, is stopped by the newer build's guards inside SQLite.
  const ancient = new DatabaseSync(path)
  assert.throws(() => ancient.prepare("UPDATE threads SET title = 'overwritten'").run(), /no such function: mako_store_format/)
  ancient.close()
  console.log("PASS: a store a newer Mako raises under a running host turns read-only there, and its windows are told")
}

function sessionLedgerInANewerFormat(): void {
  const path = join(root, "session-memory.sqlite")
  const hostA = { pid: 424_242, startedAt: 1, label: "the installed Mako app" }
  const alive = () => true
  const current = new SessionMemory(path, hostA, { alive, writer: "0.161.2" })
  current.remember("codex", "codex-1", { settings: { model: "gpt-5.3-codex" }, modeId: "access:auto" }, 100)
  current.hold("codex", "codex-held", "conversation-a")
  current.close()

  const newer = new SessionMemory(path, { pid: process.pid, startedAt: 2, label: "Mako (dev)" }, { alive, format: NEWER, writer: "0.163.0" })
  assert.equal(newer.standing().access, "write")
  newer.close()
  newerMigration(path, { table: "memory", name: "source", value: "observed" }, ["memory", "holds", "conversation_bindings", "conversation_journals", "runtime_hosts"])
  const before = dump(path)

  const older = new SessionMemory(path, { pid: process.pid, startedAt: 3, label: "an older Mako" }, { alive })
  assert.deepEqual(older.standing(), { access: "read", build: SESSION_MEMORY_SCHEMA, format: { writableBy: 2, readableBy: 1, writtenBy: "0.163.0", readableFrom: "0.161.2" } })
  assert.deepEqual(older.recall("codex", "codex-1"), { settings: { model: "gpt-5.3-codex" }, modeId: "access:auto", updatedAt: 100 }, "what a session ran under is read")
  const annotated = older.annotate({ harness: "codex", nativeId: "codex-1", path: "/sessions/codex-1.jsonl", title: "One", revision: "r" })
  assert.equal(annotated.accessMode, "access:auto", "and overlays the rail's rows")
  older.remember("codex", "codex-1", { modeId: "access:full" })
  assert.equal(older.backfill("codex", "codex-2", { modeId: "access:ask" }, 50), false, "a journal's facts wait in the journal")
  older.rememberBindings("conversation-c", [{ provider: "codex", nativeId: "codex-1" }], 200)
  older.rememberJournal("conversation-c", "/tmp/older.sock")
  assert.equal(older.rememberRoute({ conversationId: "conversation-c", provider: "codex", nativeId: "codex-1", socket: "/tmp/older.sock" }, { hostLabel: "x", hostPid: 1, conversationId: "c", since: 0 }), false)
  assert.throws(() => older.hold("codex", "codex-held", "conversation-c"), SessionHeldError, "another host's hold still refuses by name")
  const hold = thrown(() => older.hold("codex", "codex-free", "conversation-c"))
  assert.ok(hold instanceof NewerStoreReadOnlyError, "continuing a session it would have to hold is declined")
  assert.equal(hold.message, "A newer Mako (0.163.0) updated how Mako keeps track of sessions; this one can show this session but can't resume it.")
  older.release("codex", "codex-free", "conversation-c")
  older.releaseAll()
  older.close()
  assert.equal(dump(path), before, "nothing in the ledger changed")

  const back = new SessionMemory(path, { pid: process.pid, startedAt: 4, label: "Mako (dev)" }, { alive, format: NEWER })
  assert.equal(back.recall("codex", "codex-1")?.modeId, "access:auto", "the newer build reads its ledger back")
  back.close()
  const raw = new DatabaseSync(path, { readOnly: true })
  assert.equal(raw.prepare("SELECT source FROM memory WHERE native_id = 'codex-1'").get()?.source, "observed", "with its column's values")
  raw.close()

  raiseReads(path, 3, "0.170.0")
  const refused = thrown(() => new SessionMemory(path, hostA, { alive }))
  assert.ok(refused instanceof NewerStoreError && refused.message.startsWith("Mako's session ledger needs Mako 0.170.0 or later to read"), refused.message)

  // At this build's own format, a fact not given keeps what a newer Mako wrote into the settings beside it.
  const own = join(root, "session-memory-own.sqlite")
  const ledger = new SessionMemory(own, hostA, { alive })
  ledger.remember("codex", "codex-1", { settings: { model: "gpt-5.3-codex" } }, 100)
  ledger.close()
  const db = new DatabaseSync(own)
  db.prepare("UPDATE memory SET settings = ? WHERE native_id = 'codex-1'").run(JSON.stringify({ model: "gpt-5.3-codex", verbosityNewer: "low" }))
  db.close()
  const again = new SessionMemory(own, hostA, { alive })
  again.remember("codex", "codex-1", { modeId: "access:ask" }, 200)
  again.close()
  const kept = new DatabaseSync(own, { readOnly: true })
  assert.equal(kept.prepare("SELECT settings FROM memory WHERE native_id = 'codex-1'").get()?.settings, JSON.stringify({ model: "gpt-5.3-codex", verbosityNewer: "low" }), "a mode change leaves the settings' text as it was")
  kept.close()
  console.log("PASS: a newer Mako's session ledger is read, holds declined by name, facts left in the journals, nothing lost; past reads, refused by version")
}

function diagnosticsReport(): void {
  const threadsPath = join(root, "report-threads.sqlite")
  const memoryPath = join(root, "report-memory.sqlite")
  new ThreadStore(threadsPath, { now, realPath, format: NEWER, writer: "0.163.0" }).close()
  const threads = new ThreadStore(threadsPath, { now, realPath })
  const memory = new SessionMemory(memoryPath, { pid: process.pid, startedAt: 5, label: "this" }, { alive: () => true })
  const mako = join(root, "home", ".mako")
  const report = storeFormats({ threads, threadsPath, memory, memoryPath, records: join(mako, "records"), views: join(mako, "views"), archive: join(mako, "archive") })
  assert.deepEqual(report.stores.map((row) => [row.store, row.access]), [["threads", "read"], ["session-memory", "write"], ["records", "write"], ["unread", "write"], ["outputs", "write"], ["archive", "write"]])
  assert.deepEqual(report.stores[0], { store: "threads", access: "read", build: 1, writableBy: 2, readableBy: 1, writtenBy: "0.163.0", readableFrom: "0.163.0" })
  threads.close()
  memory.close()
  raiseReads(threadsPath, 3, "0.170.0")
  const refused = storeFormats({ threads: null, threadsPath, memory: null, memoryPath, records: join(mako, "records"), views: join(mako, "views"), archive: join(mako, "archive") })
  assert.deepEqual(refused.stores[0], { store: "threads", access: "refused", build: 1, writableBy: 3, readableBy: 3, writtenBy: "0.163.0", readableFrom: "0.170.0" }, "a store this host couldn't open is read from its file")
  console.log("PASS: Diagnostics' report of every shared store")
}

async function sharedFiles(): Promise<void> {
  // A newer Mako's profile cache is left to it; this host caches in memory.
  const cachePath = join(root, "provider-profiles.json")
  const newerCache = JSON.stringify({ version: 4, reads: 4, entries: {}, snapshots: {}, profiles: "a newer shape" })
  writeFileSync(cachePath, newerCache)
  const cache = new ProviderProfileCache(cachePath)
  const profile = { id: "codex", label: "Codex", available: true, transport: "app-server" as const, models: [] }
  await cache.put("codex:/tmp", profile)
  assert.deepEqual(await cache.get("codex:/tmp"), profile, "this host still caches")
  assert.equal(readFileSync(cachePath, "utf8"), newerCache, "and leaves the file to the newer Mako")

  // A newer Mako's lease this build can't read the accounts of holds them, so removal waits.
  const holds = join(root, "home", ".mako", "accounts", "holds")
  mkdirSync(holds, { recursive: true })
  const { startedAt } = await observeProcessIdentity(process.ppid, AbortSignal.timeout(2_000))
  writeFileSync(join(holds, `${process.ppid}.json`), JSON.stringify({ version: 2, pid: process.ppid, startedAt, held: [{ account: "claude/work" }] }))
  assert.equal(await new AccountHolds(new AccountRoot(join(root, "home", ".mako"))).heldElsewhere("claude", "work"), true, "a live host's newer lease counts as holding the account")
  writeFileSync(join(holds, `${process.ppid}.json`), JSON.stringify({ version: 2, pid: process.ppid, startedAt, accounts: ["claude/other"] }))
  assert.equal(await new AccountHolds(new AccountRoot(join(root, "home", ".mako"))).heldElsewhere("claude", "work"), false, "one whose accounts it reads is read as they say")
  console.log("PASS: shared files a newer Mako wrote are left to it, and its leases hold")
}

try {
  threadStoreInANewerFormat()
  await threadStoreRaisedWhileOpen()
  sessionLedgerInANewerFormat()
  diagnosticsReport()
  await sharedFiles()
} finally {
  rmSync(root, { recursive: true, force: true })
}
