import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { STREAMS_ROOT, streamPath, streamsRoot, withStreams } from "../dist/record-streams.js"
import { newestWriter } from "../dist/record-writers.js"

/**
 * The restore gate on the two harnesses whose older and newer builds can't
 * both be installed here, from recorded stores: Devin's CLI ships inside
 * Devin.app, and Mako's Cursor sessions run the SDK Mako bundles. Neither's
 * records state a version: Devin's rows take the version installed as a write
 * lands (`observedInstall`), Cursor's the version its launch's stream line
 * says the SDK reported. Either way the restore refuses an older install and
 * writes into the same version or a newer one.
 */

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-restore-gate-fixtures-"))
try {
  // Devin CLI: a session's rows in the shared database.
  {
    const home = join(root, "devin-home")
    const dir = join(home, ".local", "share", "devin", "cli")
    await mkdir(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, "sessions.db"))
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, hidden INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, working_directory TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, main_chain_id INTEGER);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL);`)
    db.prepare("INSERT INTO sessions VALUES ('devin-1', 0, 2, '/work', 'swe-1', 'Remember HERON', 1, 2)").run()
    db.prepare("INSERT INTO message_nodes VALUES (1, 'devin-1', 1, NULL, ?, 1)").run(JSON.stringify({ role: "user", content: "Remember HERON." }))
    db.prepare("INSERT INTO message_nodes VALUES (2, 'devin-1', 2, 1, ?, 2)").run(JSON.stringify({ role: "assistant", content: "OK" }))
    db.close()
    const provider = new DevinCliProvider(stores, home)
    const path = `${join(dir, "sessions.db")}#devin-1`
    const records = await provider.records(path)
    assert.equal(records.writer?.installed, true, "Devin's records state no version: what's installed as a write lands wrote it")
    const store = new RecordStore(join(root, "devin-records"), stores)
    const report = await store.capture({ harness: "devin", nativeId: "devin-1", home, records, observed: "3000.10.40" })
    assert.deepEqual(report.writers, { record: [], observed: ["3000.10.40"] })
    assert.deepEqual(newestWriter(store.writers("devin", "devin-1")), { version: "3000.10.40", source: "observed" })
    const elsewhere = join(root, "devin-elsewhere")
    const refused = await store.restore({ harness: "devin", nativeId: "devin-1", home: elsewhere, installed: "3000.10.23" })
    assert.deepEqual(refused.outdated, { wrote: { version: "3000.10.40", source: "observed" }, installed: "3000.10.23" })
    assert.equal(existsSync(join(elsewhere, ".local", "share", "devin", "cli", "sessions.db")), false, "nothing written into an older Devin's store")
    const written = await store.restore({ harness: "devin", nativeId: "devin-1", home: elsewhere, installed: "3000.10.40" })
    assert.equal(written.written, true)
    const back = new DatabaseSync(join(elsewhere, ".local", "share", "devin", "cli", "sessions.db"), { readOnly: true })
    assert.equal(back.prepare("SELECT count(*) AS n FROM message_nodes WHERE session_id = 'devin-1'").get().n, 2, "the same version writes the rows back")
    back.close()
    await store.close()
    console.log("PASS: Devin's rows take the installed version observed as they land, and restore only into it or a newer one")
  }

  // Cursor: an SDK agent's store, and the stream of the launch Mako ran it in.
  {
    const home = join(root, "cursor-home")
    const id = "44444444-4444-4444-8444-444444444444"
    const folder = join(home, ".cursor", "acp-sessions", id)
    await mkdir(folder, { recursive: true })
    const path = join(folder, "store.db")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    const hash = Buffer.alloc(32, 1)
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(hash.toString("hex"), Buffer.from(JSON.stringify({ role: "user", content: [{ type: "text", text: "<user_query>Remember HERON</user_query>" }] })))
    db.prepare("INSERT INTO blobs VALUES ('latest', ?)").run(Buffer.concat([Buffer.from([10, 32]), hash]))
    db.prepare("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId: id, latestRootBlobId: "latest" }))
    db.close()
    await writeFile(join(folder, "meta.json"), JSON.stringify({ cwd: home, updatedAtMs: 1_000 }))
    const recordsPath = join(root, "cursor-records")
    const streams = streamsRoot(recordsPath)
    const stream = streamPath(streams, "cursor", "2026-10-17T09-00-00-000Z-c.jsonl", id)
    await mkdir(join(streams, "cursor"), { recursive: true })
    await writeFile(stream, `{"capture":1,"harness":"cursor","session":{}}\n{"at":"2026-10-17T09:00:00.100Z","runtime":"1.0.40","via":"SDK child hello.sdkVersion"}\n{"at":"2026-10-17T09:00:00.200Z","message":{"type":"status"}}\n`)
    const provider = new CursorProvider(stores, home, {})
    const own = await provider.records(path)
    assert.equal(own.writer, undefined, "Cursor's records state no version, and `cursor-agent`'s isn't the SDK's")
    const store = new RecordStore(recordsPath, stores)
    const report = await store.capture({ harness: "cursor", nativeId: id, home, records: withStreams(own, streams, [stream]) })
    assert.deepEqual(report.writers, { record: [], observed: ["1.0.40"] }, "the launch's stream names the SDK that ran it")
    await rm(folder, { recursive: true, force: true })
    const roots = [{ name: STREAMS_ROOT, path: streams }]
    const refused = await store.restore({ harness: "cursor", nativeId: id, home, roots, installed: "1.0.31" })
    assert.equal(refused.outdated?.wrote.version, "1.0.40")
    assert.equal(existsSync(path), false, "nothing written for Mako's older SDK")
    const written = await store.restore({ harness: "cursor", nativeId: id, home, roots, installed: "1.0.40" })
    assert.equal(written.written, true)
    assert.ok(existsSync(path), "a Mako with that SDK gets the store back")
    await store.close()
    console.log("PASS: Cursor's store takes the SDK version its launch's stream reported, and restores only into it or a newer one")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
