import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { SessionCatalog } from "../dist/catalog.js"
import { CursorProvider } from "../dist/providers/cursor.js"

// A writer that holds a store locks read-only readers out. Cursor's SDK
// reopens its stores between writes, and every reset locked the catalog's
// peek out for a few milliseconds; read as "no session", each one flipped a
// live row to its archived copy and back.
const meta = (name) =>
  JSON.stringify({ agentId: "busy-agent", name, latestRootBlobId: "root" })

const home = await mkdtemp(join(tmpdir(), "mako-cursor-busy-"))
try {
  const directory = join(home, ".cursor", "acp-sessions", "busy-agent")
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const setup = new DatabaseSync(path)
  setup.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"
  )
  setup.prepare("INSERT INTO meta VALUES ('0', ?)").run(meta("Before"))
  setup.close()

  const provider = new CursorProvider(home, {})
  const catalog = new SessionCatalog([provider])
  const events = []
  catalog.onEvent((event) => events.push(event))
  assert.deepEqual((await catalog.scan()).map((ref) => ref.title), ["Before"])

  // A lock released within the busy timeout is waited out.
  const brief = new Worker(
    `const { DatabaseSync } = require("node:sqlite")
    const { parentPort, workerData } = require("node:worker_threads")
    const db = new DatabaseSync(workerData.path)
    db.exec("PRAGMA locking_mode=EXCLUSIVE")
    db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(workerData.value)
    parentPort.postMessage("locked")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
    db.close()`,
    { eval: true, workerData: { path, value: meta("Brief") } }
  )
  const exited = new Promise((resolve) => brief.once("exit", resolve))
  await new Promise((resolve) => brief.once("message", resolve))
  const [briefFile] = await provider.discover()
  assert.equal((await provider.peek(briefFile)).title, "Brief", "a brief lock is waited out")
  await exited
  await catalog.scan({ emitChanges: true })
  events.length = 0

  // A lock held past the timeout is unreadable, never "no session".
  const writer = new DatabaseSync(path)
  writer.exec("PRAGMA locking_mode=EXCLUSIVE")
  writer.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(meta("After"))
  const [held] = await provider.discover()
  await assert.rejects(provider.peek(held), { name: "SessionUnreadable" })
  await catalog.scan({ emitChanges: true })
  await catalog.reconcileActive()
  assert.deepEqual(events, [], "a held store announces nothing")
  assert.deepEqual(catalog.list().map((ref) => ref.title), ["Brief"], "the row keeps what it knew")

  // Released, the same change is read: the busy peek committed no stamp.
  writer.close()
  await catalog.scan({ emitChanges: true })
  assert.deepEqual(
    events.map((event) => [event.type, event.ref?.title]),
    [["updated", "After"]]
  )
  await catalog.stop()
  console.log("cursor-busy: ok")
} finally {
  await rm(home, { recursive: true, force: true })
}
