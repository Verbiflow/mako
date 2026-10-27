import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { encodeChunkPack } from "@mako/protocol/records"
import { SessionCatalog } from "../dist/catalog.js"
import { emitDevinSession } from "../dist/emit.js"
import { entriesFromMessages } from "../dist/entry-sink.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { SAVED_HISTORY_READERS } from "../dist/readers.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * A Devin session written in the cloud by a newer Devin than this Mac's, coming back (`SessionCatalog.receiveRecords`).
 * Devin 3000.11.205 migrates its store past 3000.10.23's: `tool_call_state` gains `source_node_ids`, and every row of
 * it carries the column. Devin's ACP handshake names no build (`agentInfo.version` is `0.0.0-dev` in both), so every
 * Devin session Mako captured before it asked the executable instead was stamped as written by `0.0.0-dev`, which
 * ordered below every real build and let the newer session through the version gate; the write then failed on the
 * missing column, and the person read SQLite's words. Each is refused before anything is written, as `outdated`:
 * - a writer that names no build is no writer, so nothing shows 3000.10.23 reads it;
 * - a writer the launch read off the executable (3000.11.205) is newer than the install;
 * - an install whose version can't be read blocks nothing by version, so the store's own schema refuses it: this
 *   Mac's `tool_call_state` has no `source_node_ids`, which the records hold.
 */
const RECORDED = join(import.meta.dirname, "fixtures", "child-transcripts", "devin", "home", ".local", "share", "devin", "cli", "sessions.db")
const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-receive-devin-newer-"))
const storeOf = (home) => join(home, ".local", "share", "devin", "cli", "sessions.db")
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex")

const thread = (cwd, title) => ({
  ref: { harness: "codex", nativeId: title, path: `/tmp/${title}.jsonl`, cwd, title, startedAt: "2026-10-27T07:32:00.000Z", updatedAt: "2026-10-27T07:32:40.000Z" },
  entries: entriesFromMessages([
    { kind: "user", at: "2026-10-27T07:32:00.000Z", text: "Create move-proof.txt." },
    { kind: "assistant", at: "2026-10-27T07:32:10.000Z", blocks: [{ type: "text", text: "Created." }] },
  ]),
})

// The machine: 3000.10.23's store (the recorded one), its sessions, then migrated the way 3000.11.205 does on its first run.
const machineHome = join(root, "machine-home")
await mkdir(join(machineHome, "project"), { recursive: true })
await mkdir(join(machineHome, ".local", "share", "devin", "cli"), { recursive: true })
await copyFile(RECORDED, storeOf(machineHome))
const emitted = []
for (const title of ["ran-before", "ran-after"]) emitted.push((await emitDevinSession(stores, thread(join(machineHome, "project"), title), { cwd: join(machineHome, "project"), home: machineHome })).sessionId)
const migrated = new DatabaseSync(storeOf(machineHome))
migrated.exec("ALTER TABLE tool_call_state ADD COLUMN source_node_ids TEXT")
migrated.exec("CREATE TABLE live_row_times (session_id TEXT NOT NULL, row_key TEXT NOT NULL, started_at TEXT NOT NULL, PRIMARY KEY (session_id, row_key))")
const migration = migrated.prepare("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?, ?, ?, ?)")
migration.run(18, "tool_call_state_source_nodes", "2026-10-27T07:20:00.000001Z", "14244171890362117183")
migration.run(19, "add_message_search", "2026-10-27T07:20:00.000002Z", "6147380107132451368")
migration.run(20, "live_row_times", "2026-10-27T07:20:00.000003Z", "5168998490651718395")
for (const id of emitted)
  migrated.prepare("INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json, tool_call_update_json, source_node_ids) VALUES (?, ?, ?, ?, ?)")
    .run(id, "call_1", JSON.stringify({ toolCallId: "call_1", title: "write move-proof.txt" }), JSON.stringify({ toolCallId: "call_1", status: "completed" }), JSON.stringify([7]))
migrated.close()
const machine = new RecordStore(join(root, "machine-records"), stores)
const machineDevin = new DevinCliProvider(stores, machineHome)
// `ran-before`: as every Devin session was stamped while Mako took the handshake's word; `ran-after`: as the launch reads it off the executable.
const [before, after] = emitted
await machine.capture({ harness: "devin", nativeId: before, home: machineHome, records: await machineDevin.records(`${storeOf(machineHome)}#${before}`), observed: "0.0.0-dev" })
await machine.capture({ harness: "devin", nativeId: after, home: machineHome, records: await machineDevin.records(`${storeOf(machineHome)}#${after}`), observed: "3000.11.205" })

// The cloud's records routes a receive reads, served from the machine's store.
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://cloud")
  if (url.pathname.endsWith("/sessions/pull")) {
    const bundle = Number(url.searchParams.get("after") ?? 0) > 0 ? null : machine.exportSession(url.searchParams.get("harness"), url.searchParams.get("nativeId"))
    if (!bundle) return void response.writeHead(404, { "content-type": "application/json" }).end("{}")
    return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bundle, through: 1, more: false }))
  }
  if (url.pathname.endsWith("/chunks/read")) {
    let body = ""
    for await (const part of request) body += part
    const pack = []
    for (const hash of JSON.parse(body).hashes) {
      const chunk = await machine.readChunk(hash)
      if (chunk) pack.push({ hash, codec: chunk.codec, size: chunk.size, body: chunk.body })
    }
    return void response.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(encodeChunkPack(pack)))
  }
  response.writeHead(404, { "content-type": "application/json" }).end("{}")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/v1/threads/t-1/records`
const link = { id: base, base, authorization: "Bearer test" }

// This Mac: 3000.10.23's store with a session of its own, which Mako captured, so its record store keeps this Mac's
// schema of Devin's store as its own (a receive never takes another store's over it).
const macHome = join(root, "mac-home")
await mkdir(join(macHome, "project"), { recursive: true })
await mkdir(join(macHome, ".local", "share", "devin", "cli"), { recursive: true })
await copyFile(RECORDED, storeOf(macHome))
const { sessionId: own } = await emitDevinSession(stores, thread(join(macHome, "project"), "own"), { cwd: join(macHome, "project"), home: macHome })
const macOwn = new RecordStore(join(root, "mac-records"), stores)
await macOwn.capture({ harness: "devin", nativeId: own, home: macHome, records: await new DevinCliProvider(stores, macHome).records(`${storeOf(macHome)}#${own}`), observed: "3000.10.23" })
assert.ok(macOwn.writers("devin", own), "this Mac's own Devin session is captured")
await macOwn.close()
const place = { home: macHome, userRoot: join(macHome, ".mako"), kept: join(macHome, ".mako", "outputs.sqlite") }
const readers = SAVED_HISTORY_READERS.map((reader) => reader(stores, place))
const mac = new SessionCatalog(readers, { recordsPath: join(root, "mac-records"), recordsHome: macHome, readBack: { readers: SAVED_HISTORY_READERS, stores } })
try {
  const untouched = await digest(storeOf(macHome))
  const receive = (nativeId, installed) => mac.receiveRecords(link, [{ harness: "devin", nativeId, holdings: machine.holdings("devin", nativeId) }], { devin: installed })
  const nothingWritten = (why) => {
    const there = new DatabaseSync(storeOf(macHome), { readOnly: true })
    try {
      assert.deepEqual(there.prepare("SELECT id FROM sessions WHERE id IN (?, ?)").all(before, after), [], `${why}: no session of the cloud's is in this Mac's Devin store`)
      assert.deepEqual(there.prepare("SELECT tool_call_id FROM tool_call_state WHERE session_id IN (?, ?)").all(before, after), [], `${why}: nor any of its rows`)
    } finally {
      there.close()
    }
  }

  const unnamed = await receive(before, { version: "3000.10.23" })
  assert.equal(unnamed.length, 1)
  assert.equal(unnamed[0].restored.kind, "outdated", `a writer that names no build shows nothing about it: ${JSON.stringify(unnamed[0].restored)}`)
  assert.equal(unnamed[0].restored.installed, "3000.10.23")
  assert.equal(unnamed[0].restored.wrote, undefined, "0.0.0-dev is never named as the writer")
  nothingWritten("a writer that names no build")

  const newer = await receive(after, { version: "3000.10.23" })
  assert.equal(newer[0].restored.kind, "outdated", JSON.stringify(newer[0].restored))
  assert.deepEqual(newer[0].restored.wrote, { version: "3000.11.205", source: "observed" })
  nothingWritten("a newer writer")

  const unread = await receive(before, null)
  assert.equal(unread[0].restored.kind, "outdated", `an install whose version can't be read: the store's schema refuses it: ${JSON.stringify(unread[0].restored)}`)
  assert.deepEqual(unread[0].restored.lacks, ["tool_call_state.source_node_ids"])
  nothingWritten("a store without the records' columns")
  assert.equal(await digest(storeOf(macHome)), untouched, "this Mac's Devin store is byte for byte as it was")
  console.log("PASS: a Devin session a newer Devin wrote is refused as outdated before anything is written: a writer that names no build, a newer writer, and a store without the records' columns")
} finally {
  await mac.stop()
  await machine.close()
  server.close()
  await rm(root, { recursive: true, force: true })
}
