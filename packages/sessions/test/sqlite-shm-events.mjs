import assert from "node:assert/strict"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCatalog } from "../dist/catalog.js"

// Reading a SQLite store in WAL mode writes its -shm file, so a catalog
// that took -shm writes for changes peeked every store it read, forever.
const root = await mkdtemp(join(tmpdir(), "mako-shm-events-"))
// File events can arrive seconds late on a busy Mac, but in order: once a
// marker written after a change is seen, the change was delivered too.
const seen = new Set()
let markers = 0
const drained = async () => {
  const marker = `marker-${++markers}`
  await writeFile(join(root, marker), "")
  for (let waited = 0; !seen.has(marker); waited += 50) {
    assert.ok(waited < 60_000, `file events arrive (${marker})`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
try {
  const store = join(root, "store.db")
  await writeFile(store, "")
  let peeks = 0
  const stamp = async () => {
    const info = await stat(store)
    const wal = await stat(`${store}-wal`).catch(() => null)
    return { path: store, bytes: info.size, mtimeMs: info.mtimeMs, revision: String(wal?.mtimeMs ?? "missing") }
  }
  let discoveries = 0
  // One database for every session, like OpenCode and Devin: any write
  // under the root re-runs discovery and drops the provider's cached reads.
  const provider = {
    harness: "cursor",
    displayName: "Fixture",
    roots: () => [root],
    rescanRoot: () => true,
    rescanDebounceMs: 50,
    // Like OpenCode and Devin: only the database and its sidecars count.
    watchTarget(path) {
      seen.add(path.slice(root.length + 1))
      return path.startsWith(store) ? path : null
    },
    async discover() {
      discoveries++
      return [await stamp()]
    },
    stat: stamp,
    async peek(file) {
      peeks++
      await writeFile(`${store}-shm`, String(peeks))
      return { harness: "cursor", nativeId: "fixture", path: file.path, title: "Fixture", updatedAt: new Date(file.mtimeMs).toISOString() }
    },
    async read() {
      return null
    },
  }
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  catalog.startWatching()
  await drained()
  // A backlogged fseventsd can deliver the store's creation, written before
  // watching began, after it; that event's own rescan belongs to the baseline.
  if (seen.has("store.db"))
    for (let waited = 0; discoveries < 2; waited += 50) {
      assert.ok(waited < 60_000, "the store's late creation event is rescanned")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  const afterScan = peeks
  const scanned = discoveries
  assert.equal(afterScan, 1, "the scan peeks once")

  await writeFile(`${store}-shm`, "reader")
  await drained()
  assert.equal(seen.has("store.db-shm"), false, "-shm events never reach the provider")
  assert.equal(discoveries, scanned, "a -shm write, a reader's or the catalog's own, re-runs no discovery")
  assert.equal(peeks, afterScan)

  await writeFile(`${store}-wal`, "commit")
  await drained()
  for (let waited = 0; peeks === afterScan && waited < 5_000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(discoveries > scanned, "a -wal write re-runs discovery")
  assert.equal(peeks, afterScan + 1, "and refreshes the changed session")
  const settled = discoveries
  await drained()
  assert.equal(discoveries, settled, "the peek's own -shm write does not start another")
  await catalog.stop()
  console.log("SQLite -shm writes: ignored by the watcher, so a read never re-triggers itself; -wal writes still refresh")
} finally {
  await rm(root, { recursive: true, force: true })
}
