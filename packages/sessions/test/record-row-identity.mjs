import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { RecordBundleSchema } from "@mako/protocol/records"
import { emitDevinSession } from "../dist/emit.js"
import { entriesFromMessages } from "../dist/entry-sink.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * A row is named by what its table says names it, never by the database's own counter (`keyColumns`). Devin CLI keeps
 * every session in one `sessions.db`, numbering `message_nodes.row_id` for all of them, and says a node is
 * `UNIQUE(session_id, node_id)`. A session that went to a machine and back once met another session's rows under its
 * numbers: Mako's store named both by `row_id`, so one session's row became a version of the other's, and a restore
 * replaced the other's row with it. Now each session's rows are its own in Mako's store, a restore finds a row by its
 * name, updates one there in place, and gives a new one its number only where no other row has it.
 */
const RECORDED = join(import.meta.dirname, "fixtures", "child-transcripts", "devin", "home", ".local", "share", "devin", "cli", "sessions.db")
const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-record-row-identity-"))
const storeOf = (home) => join(home, ".local", "share", "devin", "cli", "sessions.db")

/** Devin's store as a first run makes it: the schema, no sessions. `unique: false` leaves out what names a node, as a store an earlier Mako named rows in by `row_id` is read. */
async function devinStore(home, { unique = true } = {}) {
  await mkdir(join(home, ".local", "share", "devin", "cli"), { recursive: true })
  await mkdir(join(home, "project"), { recursive: true })
  const recorded = new DatabaseSync(RECORDED, { readOnly: true })
  const made = new DatabaseSync(storeOf(home))
  for (const { sql } of recorded.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())
    made.exec(unique ? sql : sql.replace(/,\s*UNIQUE\(session_id, node_id\)/, ""))
  const migration = made.prepare("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?, ?, ?, ?)")
  for (const row of recorded.prepare("SELECT version, name, applied_on, checksum FROM refinery_schema_history ORDER BY version").all()) migration.run(row.version, row.name, row.applied_on, row.checksum)
  recorded.close()
  made.close()
}

const said = (home, words) => ({
  ref: { harness: "codex", nativeId: words, path: `/tmp/${words}.jsonl`, cwd: join(home, "project"), title: words, startedAt: "2026-10-24T10:00:00.000Z", updatedAt: "2026-10-24T10:05:00.000Z" },
  entries: entriesFromMessages([
    { kind: "user", at: "2026-10-24T10:00:00.000Z", text: `Remember: ${words}.` },
    { kind: "assistant", at: "2026-10-24T10:00:10.000Z", blocks: [{ type: "text", text: `Noted ${words}.` }] },
  ]),
})
const emit = async (home, words) => (await emitDevinSession(stores, said(home, words), { cwd: join(home, "project"), home })).sessionId
const nodes = (home, session) => {
  const db = new DatabaseSync(storeOf(home), { readOnly: true })
  try {
    return db.prepare("SELECT row_id, node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY node_id").all(session)
  } finally {
    db.close()
  }
}
/** A message Devin adds to `session` on its own, numbered by its store. */
const append = (home, session, text) => {
  const db = new DatabaseSync(storeOf(home))
  try {
    const last = db.prepare("SELECT max(node_id) AS node FROM message_nodes WHERE session_id = ?").get(session).node
    const template = JSON.parse(db.prepare("SELECT chat_message FROM message_nodes WHERE session_id = ? AND node_id = ?").get(session, last).chat_message)
    const message = JSON.stringify({ ...template, message_id: `${session}-${last + 1}`, role: "user", content: text })
    db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)").run(session, last + 1, last, message, Date.now())
    db.prepare("UPDATE sessions SET main_chain_id = ?, last_activity_at = ? WHERE id = ?").run(last + 1, Date.now(), session)
  } finally {
    db.close()
  }
}
async function capture(store, home, session) {
  await store.capture({ harness: "devin", nativeId: session, home, records: await new DevinCliProvider(stores, home).records(`${storeOf(home)}#${session}`) })
}
async function cross(from, to, session) {
  const bundle = RecordBundleSchema.parse(JSON.parse(JSON.stringify(from.exportSession("devin", session, to.holdings("devin", session)))))
  await to.importSession(bundle, async function* (hashes) {
    for (const hash of hashes) yield { hash, chunk: await from.readChunk(hash) }
  })
}
const rowKeys = (store, session) => store.units("devin", session).map((unit) => unit.key).filter((key) => key.includes("\tmessage_nodes\t"))

try {
  // Each home's Devin numbers its own rows: the machine's other session holds the numbers the device's session has.
  const device = join(root, "device"), machine = join(root, "machine")
  await devinStore(device)
  await devinStore(machine)
  const moving = await emit(device, "lyrebird-kingfisher-42")
  const resident = await emit(machine, "the machine's own session")
  const before = nodes(machine, resident)
  assert.deepEqual(nodes(device, moving).map((row) => row.row_id), before.map((row) => row.row_id), "the two sessions share numbers")
  const [laptop, cloud, there] = ["laptop", "cloud", "there"].map((name) => new RecordStore(join(root, `${name}-records`), stores))
  try {
    await capture(laptop, device, moving)
    await capture(there, machine, resident)
    assert.ok(rowKeys(laptop, moving).every((key) => key.includes('"session_id"') && !key.includes('"row_id"')), "rows are named by session and node, not by row_id")

    await cross(laptop, cloud, moving)
    await cross(cloud, there, moving)
    assert.equal((await there.restore({ harness: "devin", nativeId: moving, home: machine })).written, true)
    assert.deepEqual(nodes(machine, resident), before, "the machine's own session is untouched")
    assert.deepEqual(nodes(machine, moving).map((row) => row.chat_message), nodes(device, moving).map((row) => row.chat_message), "the moved session holds its messages")
    assert.ok(nodes(machine, moving).every((row) => !before.some((other) => other.row_id === row.row_id)), "under numbers no other row has")

    // On the machine the session goes on, numbered by the machine's store; meanwhile the device's Devin gives the same
    // numbers to a session of its own.
    append(machine, moving, "said on the machine")
    await capture(there, machine, moving)
    const added = nodes(machine, moving).at(-1)
    const locals = []
    for (let tries = 0; !locals.some((session) => nodes(device, session).some((row) => row.row_id === added.row_id)); tries++) {
      assert.ok(tries < 10, "the device's Devin reaches the number the machine gave the new message")
      locals.push(await emit(device, `said here meanwhile ${tries}`))
    }
    const local = locals.at(-1)
    const localBefore = nodes(device, local)
    await cross(there, cloud, moving)
    await cross(cloud, laptop, moving)
    const back = await laptop.restore({ harness: "devin", nativeId: moving, home: device })
    assert.equal(back.written, true, JSON.stringify(back.diverged))
    assert.deepEqual(nodes(device, local), localBefore, "the device's other session is untouched")
    const home = nodes(device, moving)
    assert.deepEqual(home.map((row) => row.node_id), [...new Set(home.map((row) => row.node_id))], "each node once")
    assert.match(home.at(-1).chat_message, /said on the machine/, "the machine's message comes back")
    const read = await new DevinCliProvider(stores, device).read(`${storeOf(device)}#${moving}`)
    assert.ok(JSON.stringify(read.entries).includes("said on the machine"), "Devin's own reader reads it")
  } finally {
    await Promise.all([laptop.close(), cloud.close(), there.close()])
  }

  // A store an earlier Mako named a session's rows in by `row_id`: its next capture lets go of those and names the
  // rows by node, with nothing new to store, and the session restores as it was.
  const earlier = join(root, "earlier")
  await devinStore(earlier, { unique: false })
  const old = await emit(earlier, "captured by an earlier Mako")
  const store = new RecordStore(join(root, "earlier-records"), stores)
  try {
    await capture(store, earlier, old)
    assert.ok(rowKeys(store, old).length && rowKeys(store, old).every((key) => key.includes('{"row_id"')), "without a node's name, rows are named by row_id")
    const db = new DatabaseSync(storeOf(earlier))
    db.exec("CREATE UNIQUE INDEX node_names ON message_nodes (session_id, node_id)")
    db.close()
    await capture(store, earlier, old)
    assert.ok(rowKeys(store, old).every((key) => key.includes('"session_id"') && !key.includes('"row_id"')), "taken again, by node")
    const fresh = join(root, "fresh")
    await devinStore(fresh)
    assert.equal((await store.restore({ harness: "devin", nativeId: old, home: fresh })).written, true)
    assert.deepEqual(nodes(fresh, old).map((row) => [row.row_id, row.chat_message]), nodes(earlier, old).map((row) => [row.row_id, row.chat_message]), "restored whole, each row under its own number where it's free")
  } finally {
    await store.close()
  }
  console.log("PASS: Devin's rows are named by session and node: a session moved among another's rows that share its numbers leaves them untouched both ways, and rows an earlier Mako named by row_id are named again by node")
} finally {
  await rm(root, { recursive: true, force: true })
}
