import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { CursorProvider } from "../dist/providers/cursor.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { ViewCache } from "../dist/view-cache.js"
import { largeCursorChat } from "./large-cursor-chat.mjs"

// The sync daemon answers the host on one loop: a read whole, a follow, a
// view written or a write to the record store that held it for the size of a
// Session kept the host's pings and status reads waiting, past their timeouts
// on a large one. Each is timed here on a Cursor chat of 25MB, as a headless
// agent writes one: one exchange holding the whole conversation.
const HOLD_MS = 50

/** The longest the loop went without a turn while `work` ran. */
async function longestHold(work) {
  let longest = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 1)
  try {
    const result = await work()
    return { result, ms: Math.max(longest, performance.now() - last) }
  } finally {
    clearInterval(timer)
  }
}

const measured = []
function held(what, ms) {
  measured.push(`${what}: ${Math.round(ms)} ms`)
  assert.ok(ms <= HOLD_MS, `${what} held the loop ${Math.round(ms)} ms (at most ${HOLD_MS})`)
}

const home = await mkdtemp(join(tmpdir(), "mako-loop-holds-"))
try {
  const { rows, agentId } = largeCursorChat()
  const folder = join(home, ".cursor", "chats", "c".repeat(32), agentId)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, "store.db")
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const insert = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)")
  const pointAt = db.prepare("INSERT INTO meta VALUES ('0', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
  const roots = rows.flatMap((row, index) => (row.root ? [index] : []))
  /** The chat's rows through its `step`th root, as the agent wrote them. */
  const writeThrough = (step) => {
    db.exec("BEGIN")
    for (const row of rows.slice(0, roots[step] + 1)) insert.run(row.id, row.data)
    pointAt.run(Buffer.from(JSON.stringify({ agentId, latestRootBlobId: rows[roots[step]].id, name: "A long chat", mode: "default" })).toString("hex"))
    db.exec("COMMIT")
  }
  writeThrough(roots.length - 2)
  writeFileSync(join(folder, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.now(), hasConversation: true, updatedAtMs: Date.now(), cwd: home }))

  const stores = new NativeStores(false)
  const provider = new CursorProvider(stores, home)
  const read = await longestHold(() => provider.read(path))
  assert.ok(read.result && read.result.entries.length > 100, "the chat reads whole")
  held("a read whole", read.ms)

  const follower = provider.createFollower(path, 0)
  await follower.next()
  writeThrough(roots.length - 1)
  const moved = await longestHold(() => follower.next())
  assert.equal(moved.result.replace, true)
  assert.ok(moved.result.entries.length < 10, `a step replaces what moved (${moved.result.entries.length} entries), not its exchange`)
  held("a follow through one more step", moved.ms)

  const views = new ViewCache(join(home, "views"), () => "loop-holds")
  const wrote = await longestHold(() => views.write(path, { bytes: 1, mtimeMs: 1 }, read.result, 100))
  held("its view written", wrote.ms)
  views.close()

  // A backfill pass's process holds the record store's write lock until its next commit.
  const records = join(home, "records")
  const store = new RecordStore(records, stores)
  const ref = { harness: "cursor", nativeId: agentId }
  const captured = await longestHold(async () => store.capture({ ...ref, home, path, records: await provider.records(path) }))
  assert.ok(captured.result.taken > rows.length / 2, `the chat's rows are captured (${captured.result.taken})`)
  held("a capture of the whole chat", captured.ms)
  const holder = new Worker(
    `const { DatabaseSync } = require("node:sqlite")
    const { parentPort, workerData } = require("node:worker_threads")
    const db = new DatabaseSync(workerData)
    db.exec("BEGIN IMMEDIATE")
    parentPort.postMessage("locked")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
    db.exec("COMMIT")
    db.close()`,
    { eval: true, workerData: join(records, "records.sqlite") }
  )
  const released = new Promise((resolve) => holder.once("exit", resolve))
  await new Promise((resolve) => holder.once("message", resolve))
  const pushed = await longestHold(() => store.notePushed("account", ref.harness, ref.nativeId, 1, Date.now()))
  await released
  assert.equal(store.pushed("account").get(`${ref.harness}\n${ref.nativeId}`)?.capture, 1, "the write waited for the lock, then went in")
  held("a write the store's lock kept waiting", pushed.ms)
  await store.close()
  db.close()
  console.log(`loop holds ok: ${measured.join("; ")}`)
} finally {
  await rm(home, { recursive: true, force: true })
}
