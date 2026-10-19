import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { KeptOutputs, keptOutputsStanding } from "../dist/kept-outputs.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore, recordStoreStanding } from "../dist/record-store.js"
import { archiveStanding } from "../dist/archive.js"
import { ViewCache } from "../dist/view-cache.js"
import {
  declareStoreFormat,
  guardRefused,
  guardStoreWrites,
  jsonStoreAccess,
  makoNeeded,
  newerMako,
  NewerStoreError,
  NewerStoreReadOnlyError,
  readStoreFormat,
  storeAccess,
  storeWriter,
  unknownFields,
  writeStoreFormat,
} from "../dist/store-format.js"

/**
 * Every store `@mako/sessions` keeps under `~/.mako` that several builds
 * share, opened by this build after a newer Mako changed it: what it reads,
 * what it declines, that nothing a newer Mako wrote is lost, and that one
 * whose `reads` is past this build is left as it is with the Mako that reads
 * it named. A newer Mako is played by raising the numbers, adding a column,
 * a table and rows this build doesn't know, and guarding the tables, as a
 * build that raises `writableBy` does.
 */

const nativeStores = new NativeStores(false)
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const root = await mkdtemp(join(tmpdir(), "mako-store-formats-"))

/** Every table's rows, in order, as text: what "nothing was written" compares. */
function dump(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name)
    return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]), (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : typeof value === "bigint" ? String(value) : value))
  } finally {
    db.close()
  }
}

/** What a newer Mako's migration does to a store: its numbers raised and stamped, a column, a table and rows this build doesn't know, and its tables guarded. */
function raise(file, table, { writableBy, readableBy, writer = "0.163.0", column, guarded = [] }) {
  const db = new DatabaseSync(file)
  try {
    declareStoreFormat(db, writableBy)
    db.exec("BEGIN IMMEDIATE")
    writeStoreFormat(db, table, { writableBy, readableBy }, writer)
    if (column) {
      db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} TEXT`)
      db.prepare(`UPDATE ${column.table} SET ${column.name} = ?`).run(column.value)
    }
    db.exec("CREATE TABLE IF NOT EXISTS added_by_a_newer_mako (id INTEGER PRIMARY KEY, note TEXT NOT NULL)")
    db.prepare("INSERT INTO added_by_a_newer_mako (note) VALUES (?)").run("kept for the newer build")
    guardStoreWrites(db, guarded, writableBy)
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

try {
  // The rule itself.
  assert.equal(storeAccess(undefined, 1), "write", "a store with no numbers is this build's to write")
  assert.equal(storeAccess({ writableBy: 1, readableBy: 1 }, 1), "write")
  assert.equal(storeAccess({ writableBy: 1, readableBy: 1 }, 2), "write", "an older format is this build's to migrate")
  assert.equal(storeAccess({ writableBy: 3, readableBy: 2 }, 2), "read", "between the two numbers, read only")
  assert.equal(storeAccess({ writableBy: 3, readableBy: 3 }, 2), "refused", "below readableBy, left alone")
  assert.equal(storeWriter({ version: "0.163.0", development: false }), "0.163.0")
  assert.equal(storeWriter({ version: "0.0.1", development: true }), "0.0.1+development")
  assert.equal(newerMako("0.163.0"), "a newer Mako (0.163.0)")
  assert.equal(newerMako("0.0.1+development"), "a development build of Mako (0.0.1)")
  assert.equal(newerMako(undefined), "a newer Mako")
  assert.equal(makoNeeded("0.170.0"), "Mako 0.170.0 or later")
  assert.equal(jsonStoreAccess({ version: 2 }, 2), "write")
  assert.equal(jsonStoreAccess({ version: 3, reads: 2 }, 2), "read")
  assert.equal(jsonStoreAccess({ version: 3 }, 2), "refused", "a JSON file that names no reads is read by its own format only")
  assert.equal(jsonStoreAccess({ worktrees: {} }, 1), "write", "a file with no version is this build's")
  assert.deepEqual(unknownFields({ a: 1, b: 2, c: 3 }, ["a"]), { b: 2, c: 3 })
  assert.equal(new NewerStoreError("the record store", { writableBy: 4, readableBy: 3, readableFrom: "0.170.0" }, 2).message,
    "The record store needs Mako 0.170.0 or later to read (its format 4, read from format 3; this build knows 2). It's kept as it is.")
  const declined = new NewerStoreReadOnlyError("your Threads", { writableBy: 2, readableBy: 1, writtenBy: "0.163.0" }, "can show them but not change them. Update Mako to edit")
  assert.equal(declined.message, "A newer Mako (0.163.0) updated your Threads; this one can show them but not change them. Update Mako to edit.")
  assert.equal(declined.name, "NewerStoreReadOnlyError")

  // Stamps: a raised number names the build that raised it, and one that stays keeps its stamp.
  {
    const db = new DatabaseSync(":memory:")
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    writeStoreFormat(db, "meta", { writableBy: 1, readableBy: 1 }, "0.150.0")
    writeStoreFormat(db, "meta", { writableBy: 2, readableBy: 1 }, "0.163.0")
    assert.deepEqual(readStoreFormat(db, "meta"), { writableBy: 2, readableBy: 1, writtenBy: "0.163.0", readableFrom: "0.150.0" })
    db.prepare("UPDATE meta SET value = 'two' WHERE key = 'reads'").run()
    assert.equal(readStoreFormat(db, "meta")?.readableBy, Number.MAX_SAFE_INTEGER, "a number this build can't read counts as newer than any it knows")
    db.close()
  }

  // Guards: a newer build's triggers stop an older build's writes in SQLite itself, whether it declared its format or predates the rule.
  {
    const file = join(root, "guarded.sqlite")
    const db = new DatabaseSync(file)
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE rows (id INTEGER PRIMARY KEY, text TEXT)")
    db.prepare("INSERT INTO rows (text) VALUES ('before')").run()
    db.close()
    raise(file, "meta", { writableBy: 2, readableBy: 1, guarded: ["rows"] })
    const older = new DatabaseSync(file)
    declareStoreFormat(older, 1)
    assert.throws(() => older.prepare("INSERT INTO rows (text) VALUES ('older')").run(), (error) => error instanceof Error && guardRefused(error), "a build that declared an older format is stopped")
    assert.throws(() => older.prepare("UPDATE rows SET text = 'older'").run(), (error) => error instanceof Error && guardRefused(error))
    assert.equal(older.prepare("SELECT count(*) AS n FROM rows").get().n, 1, "reads go on")
    older.close()
    const ancient = new DatabaseSync(file)
    assert.throws(() => ancient.prepare("DELETE FROM rows").run(), (error) => error instanceof Error && guardRefused(error), "a build from before the rule, which declares nothing, is stopped too")
    ancient.close()
    const newer = new DatabaseSync(file)
    declareStoreFormat(newer, 2)
    newer.prepare("INSERT INTO rows (text) VALUES ('newer')").run()
    assert.equal(newer.prepare("SELECT count(*) AS n FROM rows").get().n, 2, "the build that raised it writes")
    newer.close()
    console.log("PASS: the rule, its words, its stamps and its guards")
  }

  // The record store: a session captured by this build, then a newer Mako's format.
  const home = join(root, "home")
  const recordsPath = join(home, ".mako", "records")
  const id = "01a0e74f-b716-77a2-8b46-71174540cd99"
  const dated = join(home, ".codex", "sessions", "2026", "10", "17")
  const live = join(dated, `rollout-2026-10-17T02-19-16-${id}.jsonl`)
  await mkdir(dated, { recursive: true })
  const line = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
  const message = (role, text) => line("response_item", { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] })
  await writeFile(live, line("session_meta", { id, cwd: home }) + message("user", "Keep the newer layout"))
  {
    const state = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)")
    state.prepare("INSERT INTO threads VALUES (?, NULL, 'Keep the newer layout', ?, ?, 'user', ?)").run(id, home, Date.now(), live)
    state.close()
  }
  const catalog = new SessionCatalog([new CodexProvider(nativeStores, home)], { recordsPath, recordsHome: home, writer: "0.161.2" })
  await catalog.scan()
  await delay(300)
  await appendFile(live, message("assistant", "Read and restored, never written."))
  await catalog.scan({ emitChanges: true })
  const look = new RecordStore(recordsPath, nativeStores)
  for (const end = Date.now() + 10_000; !look.sessions().length && Date.now() < end;) await delay(20)
  assert.equal(look.sessions().length, 1, "this build captured the session")
  const [unit] = look.units("codex", id).filter((candidate) => candidate.role === "file" && candidate.key.endsWith(".jsonl"))
  const captured = look.versions("codex", unit.key).length
  const atCapture = await readFile(live)
  assert.equal(look.access, "write")
  // A newer Mako raises the store while this build's catalog runs: from its next look on, capture stops, said once.
  const recordsFile = join(recordsPath, "records.sqlite")
  raise(recordsFile, "meta", { writableBy: 3, readableBy: 2, column: { table: "sessions", name: "labels", value: "newer" }, guarded: ["sessions", "units", "versions", "chunks"] })
  const before = dump(recordsFile)
  assert.equal(look.access, "read", "an open store turns read-only once another build raised it")
  const warned = []
  const warn = console.warn
  console.warn = (...args) => warned.push(args.join(" "))
  try {
    for (const text of ["One more write.", "And another."]) {
      await appendFile(live, message("assistant", text))
      await catalog.scan({ emitChanges: true })
      await delay(400)
    }
  } finally {
    console.warn = warn
  }
  assert.equal(look.versions("codex", unit.key).length, captured, "nothing more is captured")
  assert.equal(warned.filter((line) => line.startsWith("Session records read only")).length, 1, `and it's said once: ${JSON.stringify(warned)}`)
  assert.ok(!warned.some((line) => /failed|Error/.test(line)), "with no failed writes logged")
  await look.close()
  await catalog.stop()
  assert.equal(dump(recordsFile), before, "the running catalog wrote nothing after the raise")
  {
    const store = new RecordStore(recordsPath, nativeStores)
    assert.equal(store.access, "read", "this build reads a newer Mako's record store")
    assert.deepEqual(store.sessions().map((session) => session.nativeId), [id], "and lists what it holds")
    const parts = []
    for await (const part of store.content("codex", unit.key)) parts.push(part)
    assert.equal(sha(Buffer.concat(parts)), sha(atCapture), "a session's bytes read back whole")
    const elsewhere = join(root, "restored-home")
    const restored = await store.restore({ harness: "codex", nativeId: id, home: elsewhere })
    assert.ok(restored.written, "and restores the session into another home")
    const back = (await readdir(join(elsewhere, ".codex", "sessions", "2026", "10", "17"))).map((name) => join(elsewhere, ".codex", "sessions", "2026", "10", "17", name))
    assert.equal(sha(await readFile(back[0])), sha(atCapture), "whole")
    assert.throws(() => store.capture({ harness: "codex", nativeId: id }), /newer Mako's format/, "and it captures nothing")
    await store.close()
    assert.deepEqual(recordStoreStanding(recordsPath), { access: "read", build: 2, format: { writableBy: 3, readableBy: 2, writtenBy: "0.163.0", readableFrom: "0.161.2" } }, "the catalog stamped the store it made with its build")
  }
  assert.equal(dump(recordsFile), before, "nothing in the store changed: its column, table and rows are as the newer build left them")
  raise(recordsFile, "meta", { writableBy: 4, readableBy: 3, writer: "0.170.0" })
  const refused = dump(recordsFile)
  assert.throws(() => new RecordStore(recordsPath, nativeStores), (error) => error instanceof NewerStoreError && /needs Mako 0\.170\.0 or later to read/.test(error.message), "past reads, it's refused with the Mako that reads it named")
  assert.equal(recordStoreStanding(recordsPath).access, "refused")
  assert.equal(dump(recordsFile), refused, "and left as it is")
  console.log("PASS: the record store is read and restored from in a newer format, and refused past it with the version named")

  // Kept outputs: copies are read, none is kept, the newer layout stays.
  {
    const file = join(root, "archive", "outputs.sqlite")
    const outputs = new KeptOutputs(file)
    outputs.keep({ harness: "claude", session: "s", task: "t1" }, { output: "done\n", exitCode: 0 })
    outputs.close()
    raise(file, "meta", { writableBy: 2, readableBy: 1, column: { table: "outputs", name: "origin", value: "newer" }, guarded: ["outputs"] })
    const kept = dump(file)
    const older = new KeptOutputs(file)
    assert.deepEqual(older.read({ harness: "claude", session: "s", task: "t1" }), { output: "done\n", exitCode: 0 }, "a copy reads back")
    older.keep({ harness: "claude", session: "s", task: "t2" }, { output: "more\n", exitCode: 0 })
    older.close()
    assert.equal(dump(file), kept, "and nothing is kept into a newer layout")
    // Raised under copies this build keeps open: it stops keeping from the next copy.
    const runningFile = join(root, "archive-running", "outputs.sqlite")
    const running = new KeptOutputs(runningFile)
    running.keep({ harness: "claude", session: "s", task: "t1" }, { output: "one\n", exitCode: 0 })
    raise(runningFile, "meta", { writableBy: 2, readableBy: 1, guarded: ["outputs"] })
    const raisedOutputs = dump(runningFile)
    running.keep({ harness: "claude", session: "s", task: "t2" }, { output: "two\n", exitCode: 0 })
    assert.deepEqual(running.read({ harness: "claude", session: "s", task: "t1" }), { output: "one\n", exitCode: 0 }, "what it kept still reads")
    running.close()
    assert.equal(dump(runningFile), raisedOutputs, "copies raised while open are kept no more")
    assert.equal(keptOutputsStanding(file).access, "read")
    raise(file, "meta", { writableBy: 3, readableBy: 3, writer: "0.170.0" })
    const past = new KeptOutputs(file)
    assert.equal(past.read({ harness: "claude", session: "s", task: "t1" }), undefined, "past reads, the body goes to its file as before there were copies")
    past.close()
    assert.equal(keptOutputsStanding(file).access, "refused")
    console.log("PASS: kept outputs are read in a newer format and never written")
  }

  // Views: a newer Mako's view is neither removed nor written over; this build decodes into memory.
  {
    const folder = join(root, "views-newer")
    const views = new ViewCache(folder, () => "build-1")
    const ref = { harness: "codex", nativeId: "v", path: "/s/v.jsonl", title: "V", revision: "r" }
    const thread = { ref, entries: [{ type: "user", text: "hello" }, { type: "text", text: "hi" }] }
    await views.write(ref.path, { bytes: 10, mtimeMs: 1 }, thread, 50)
    await views.settled()
    const [file] = (await readdir(folder)).filter((name) => name.endsWith(".view.db"))
    const path = join(folder, file)
    const db = new DatabaseSync(path)
    const meta = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'view'").get().value)
    db.prepare("UPDATE meta SET value = ? WHERE key = 'view'").run(JSON.stringify({ ...meta, format: 3, shape: "a newer Mako's" }))
    db.close()
    const kept = await readFile(path)
    const older = new ViewCache(folder, () => "build-1")
    assert.equal(await older.view(ref.path, { bytes: 10, mtimeMs: 1 }), null, "a newer view isn't read as this build's")
    assert.deepEqual(await readFile(path), kept, "nor removed")
    await older.write(ref.path, { bytes: 10, mtimeMs: 1 }, thread, 50)
    await older.settled()
    assert.deepEqual(await readFile(path), kept, "nor written over: this build keeps its own in memory")
    assert.ok(await older.view(ref.path, { bytes: 10, mtimeMs: 1 }), "which it reads from")
    older.close()
    views.close()
    console.log("PASS: a newer Mako's views are left on disk")
  }

  // The archive's standing, from its `user_version`.
  {
    const archive = join(root, "archive-standing")
    await mkdir(archive, { recursive: true })
    assert.equal(archiveStanding(archive).access, "write", "no archive is nothing to say")
    const db = new DatabaseSync(join(archive, "archive.sqlite"))
    db.exec("CREATE TABLE sessions (path TEXT PRIMARY KEY, ref TEXT NOT NULL, entries TEXT NOT NULL, revision TEXT NOT NULL); CREATE TABLE archive_captures (path TEXT PRIMARY KEY, token TEXT NOT NULL, deleted INTEGER NOT NULL); PRAGMA user_version = 2")
    db.close()
    assert.equal(archiveStanding(archive).access, "read", "a newer archive that keeps what this build reads is read")
    console.log("PASS: the archive's standing")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
