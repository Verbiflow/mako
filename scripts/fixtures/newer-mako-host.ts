import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { declareStoreFormat, guardStoreWrites, writeStoreFormat, type SharedWrites } from "@mako/sessions/store-format"
import { SESSION_MEMORY_SCHEMA, SESSION_MEMORY_SHARED, SessionMemory } from "@mako/host/threads/session-memory"
import { THREAD_STORE_SCHEMA, ThreadStore } from "@mako/host/threads/store"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"

/**
 * A newer Mako's host, in its own process, on the stores a running host of
 * this build has open (`scripts/test-store-formats-hosts.ts`). It plays the
 * build through the stores' own `format` option and its migration: the
 * Thread store and session ledger raised to the next format, a column and a
 * table this build doesn't know, and every table guarded.
 *
 *   tsx scripts/fixtures/newer-mako-host.ts migrate <threads> <ledger> <thread id>
 *   tsx scripts/fixtures/newer-mako-host.ts migrate-records <records.sqlite> <unread.sqlite> <outputs.sqlite>
 *   tsx scripts/fixtures/newer-mako-host.ts read <threads> <ledger>
 *   tsx scripts/fixtures/newer-mako-host.ts held <now> <ledger> <provider> <native id>
 *
 * `migrate-records` plays the newer build's catalog worker raising the
 * record store, the unread index and the kept outputs (each `meta`).
 *
 * Prints one JSON line of what it read.
 */

const [command, threadsPath = "", ledgerPath = "", threadId = ""] = process.argv.slice(2)
const THREADS = { writableBy: THREAD_STORE_SCHEMA + 1, readableBy: THREAD_STORE_SCHEMA }
const LEDGER = { writableBy: SESSION_MEMORY_SCHEMA + 1, readableBy: SESSION_MEMORY_SCHEMA }
const host = { pid: process.pid, startedAt: Date.now(), label: "Mako 0.163.0" }
const realPath = (path: string) => path

/** What the newer build's migration adds beside raising the numbers. */
function migrate(file: string, writableBy: number, column: { table: string; name: string }, guarded: string[], shared: SharedWrites = {}): void {
  const db = new DatabaseSync(file, { timeout: 5_000 })
  try {
    declareStoreFormat(db, writableBy)
    db.exec("BEGIN IMMEDIATE")
    db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} TEXT`)
    db.prepare(`UPDATE ${column.table} SET ${column.name} = 'newer'`).run()
    db.exec("CREATE TABLE added_by_a_newer_mako (id INTEGER PRIMARY KEY, note TEXT NOT NULL)")
    db.prepare("INSERT INTO added_by_a_newer_mako (note) VALUES ('kept for the newer build')").run()
    guardStoreWrites(db, guarded, writableBy, shared)
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

function column(file: string, sql: string): unknown[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).all().map((row) => Object.values(row)[0])
  } finally {
    db.close()
  }
}

if (command === "migrate") {
  const threads = new ThreadStore(threadsPath, { realPath, format: THREADS, writer: "0.163.0" })
  threads.renameThread({ operationId: crypto.randomUUID(), thread: ThreadIdSchema.parse(threadId), title: "Named by Mako 0.163.0", actor: threads.person() })
  threads.close()
  migrate(threadsPath, THREADS.writableBy, { table: "threads", name: "color" }, ["threads", "sessions", "memberships", "journals", "locators", "sources", "native_claims", "operations", "executions"])
  const ledger = new SessionMemory(ledgerPath, host, { format: LEDGER, writer: "0.163.0" })
  ledger.close()
  // What every ledger format keeps for older builds: their holds stay alive and releasable.
  migrate(ledgerPath, LEDGER.writableBy, { table: "memory", name: "source" }, ["memory", "holds", "conversation_bindings", "conversation_journals", "runtime_hosts"], SESSION_MEMORY_SHARED)
  console.log(JSON.stringify({ migrated: true }))
} else if (command === "migrate-records") {
  const [records = "", unread = "", outputs = ""] = [threadsPath, ledgerPath, threadId]
  for (const [file, guarded] of [[records, ["sessions", "units", "versions", "chunks", "captures"]], [unread, ["unread"]], [outputs, ["outputs"]]] as const) {
    const db = new DatabaseSync(file, { timeout: 5_000 })
    try {
      const writableBy = Number(z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).value) + 1
      declareStoreFormat(db, writableBy)
      db.exec("BEGIN IMMEDIATE")
      writeStoreFormat(db, "meta", { writableBy, readableBy: writableBy - 1 }, "0.163.0")
      db.exec("CREATE TABLE added_by_a_newer_mako (id INTEGER PRIMARY KEY, note TEXT NOT NULL)")
      guardStoreWrites(db, guarded, writableBy)
      db.exec("COMMIT")
    } finally {
      db.close()
    }
  }
  console.log(JSON.stringify({ migrated: true }))
} else if (command === "held") {
  // The newer host at an injected time, whose probe can't confirm another host is alive: only a fresh heartbeat keeps a hold from being cleared.
  const at = Number(threadsPath)
  const provider = threadId
  const nativeId = process.argv[6] ?? ""
  const ledger = new SessionMemory(ledgerPath, host, { format: LEDGER, now: () => at, identityCurrent: async () => false })
  await ledger.reconcileHolds()
  console.log(JSON.stringify({ heldBy: ledger.heldBy(provider, nativeId)?.hostLabel ?? null }))
  ledger.close()
} else if (command === "read") {
  const threads = new ThreadStore(threadsPath, { realPath, format: THREADS })
  const ledger = new SessionMemory(ledgerPath, host, { format: LEDGER })
  console.log(JSON.stringify({
    writable: threads.writable,
    groups: threads.groups(),
    titles: threads.titles(),
    sessions: column(threadsPath, "SELECT id FROM sessions WHERE merged_into IS NULL ORDER BY id"),
    colors: column(threadsPath, "SELECT DISTINCT color FROM threads"),
    added: column(threadsPath, "SELECT note FROM added_by_a_newer_mako"),
    ledger: ledger.standing().access,
    remembered: ledger.recall("cursor", "agent-a"),
    sources: column(ledgerPath, "SELECT DISTINCT source FROM memory"),
  }))
  threads.close()
  ledger.close()
} else {
  throw new Error(`Unknown command ${command}`)
}
