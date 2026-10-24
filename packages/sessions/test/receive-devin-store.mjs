import assert from "node:assert/strict"
import { createServer } from "node:http"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
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
 * A Devin CLI session received into a machine whose Devin made its own store (`SessionCatalog.receiveRecords`), as a
 * move's machine does: every Devin store holds the migrations its first run applied, each stamped with when
 * (`refinery_schema_history.applied_on`), so the two stores' migration rows differ. They describe the store, not the
 * session (`devinFork.storeTable`), and stay as the machine has them. The receive goes through Devin CLI's reader, the
 * one whose folder the session's records are placed in, though Devin.app's reader comes first among the readers Mako
 * ships; through Devin.app's, which knows no such rows, every migration row diverged and the move was refused.
 */
const RECORDED = join(import.meta.dirname, "fixtures", "child-transcripts", "devin", "home", ".local", "share", "devin", "cli", "sessions.db")
const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-receive-devin-store-"))
const storeOf = (home) => join(home, ".local", "share", "devin", "cli", "sessions.db")

/** Devin's store as its first run makes it: its schema, and every migration stamped when it was applied. */
async function devinStore(home, appliedOn) {
  await mkdir(join(home, ".local", "share", "devin", "cli"), { recursive: true })
  const recorded = new DatabaseSync(RECORDED, { readOnly: true })
  const made = new DatabaseSync(storeOf(home))
  for (const { sql } of recorded.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) made.exec(sql)
  const migration = made.prepare("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?, ?, ?, ?)")
  for (const row of recorded.prepare("SELECT version, name, checksum FROM refinery_schema_history ORDER BY version").all()) migration.run(row.version, row.name, appliedOn, row.checksum)
  recorded.close()
  made.close()
}

const thread = (cwd) => ({
  ref: { harness: "codex", nativeId: "devin-move", path: "/tmp/devin-move.jsonl", cwd, title: "Moving", startedAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:05:00.000Z" },
  entries: entriesFromMessages([
    { kind: "user", at: "2026-10-21T10:00:00.000Z", text: "Remember: the deploy key is lyrebird-kingfisher-42." },
    { kind: "assistant", at: "2026-10-21T10:00:10.000Z", blocks: [{ type: "text", text: "Noted." }] },
  ]),
})

// The device: the Devin store a real install kept (its own migration stamps, earlier sessions), a session added, captured.
const deviceHome = join(root, "device-home")
await mkdir(join(deviceHome, "project"), { recursive: true })
await mkdir(join(deviceHome, ".local", "share", "devin", "cli"), { recursive: true })
await copyFile(RECORDED, storeOf(deviceHome))
const { sessionId: nativeId } = await emitDevinSession(stores, thread(join(deviceHome, "project")), { cwd: join(deviceHome, "project"), home: deviceHome })
const device = new RecordStore(join(root, "device-records"), stores)
const deviceDevin = new DevinCliProvider(stores, deviceHome)
await device.capture({ harness: "devin", nativeId, home: deviceHome, records: await deviceDevin.records(`${storeOf(deviceHome)}#${nativeId}`) })

// The cloud's records routes a receive reads, served from the device's store.
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://cloud")
  if (url.pathname.endsWith("/sessions/pull")) {
    const bundle = Number(url.searchParams.get("after") ?? 0) > 0 ? null : device.exportSession(url.searchParams.get("harness"), url.searchParams.get("nativeId"))
    if (!bundle) return void response.writeHead(404, { "content-type": "application/json" }).end("{}")
    return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bundle, through: 1, more: false }))
  }
  if (url.pathname.endsWith("/chunks/read")) {
    let body = ""
    for await (const part of request) body += part
    const pack = []
    for (const hash of JSON.parse(body).hashes) {
      const chunk = await device.readChunk(hash)
      if (chunk) pack.push({ hash, codec: chunk.codec, size: chunk.size, body: chunk.body })
    }
    return void response.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(encodeChunkPack(pack)))
  }
  response.writeHead(404, { "content-type": "application/json" }).end("{}")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/v1/threads/t-1/records`
const link = { id: base, base, authorization: "Bearer test" }

// The machine: Devin ran there once, so its store is its own, with a session of its own.
const machineHome = join(root, "machine-home")
const machineApplied = "2026-10-23T09:00:00.000001Z"
await devinStore(machineHome, machineApplied)
await mkdir(join(machineHome, "image"), { recursive: true })
await emitDevinSession(stores, { ...thread(join(machineHome, "image")), ref: { ...thread(join(machineHome, "image")).ref, title: "Image" } }, { cwd: join(machineHome, "image"), home: machineHome })
const place = { home: machineHome, kept: join(machineHome, ".mako", "outputs.sqlite") }
const readers = SAVED_HISTORY_READERS.map((reader) => reader(stores, place))
assert.equal(readers.find((each) => each.harness === "devin")?.fork, undefined, "Devin.app's reader, which has no fork rule, comes first")
const machine = new SessionCatalog(readers, { recordsPath: join(root, "machine-records"), recordsHome: machineHome, readBack: { readers: SAVED_HISTORY_READERS, stores } })
try {
  const received = await machine.receiveRecords(link, [{ harness: "devin", nativeId, holdings: device.holdings("devin", nativeId) }], {})
  assert.deepEqual(received.map((each) => each.restored.kind), ["restored"], JSON.stringify(received))
  assert.equal(received[0].restored.path, `${storeOf(machineHome)}#${nativeId}`, "the same session, where Devin CLI keeps it")
  const there = new DatabaseSync(storeOf(machineHome), { readOnly: true })
  try {
    assert.ok(there.prepare("SELECT 1 FROM sessions WHERE id = ?").get(nativeId), "the session is in the machine's Devin store")
    assert.deepEqual(there.prepare("SELECT DISTINCT applied_on FROM refinery_schema_history").all().map((row) => row.applied_on), [machineApplied], "the migration list stays the machine's")
  } finally {
    there.close()
  }
  console.log("PASS: a Devin session received into a machine whose Devin made its own store restores in place, the store's migration list kept")
} finally {
  await machine.stop()
  await device.close()
  server.close()
  await rm(root, { recursive: true, force: true })
}
