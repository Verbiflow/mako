import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCatalog } from "../dist/catalog.js"

// A root that also holds a harness's logs isn't watched; its database is
// polled instead, so log churn costs nothing and a commit still refreshes.
const root = await mkdtemp(join(tmpdir(), "mako-poll-files-"))
const wait = async (done, message) => {
  for (let waited = 0; !done(); waited += 50) {
    assert.ok(waited < 10_000, message)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
try {
  const store = join(root, "store.db")
  const logs = join(root, "log")
  await mkdir(logs)
  await writeFile(store, "")
  let discoveries = 0
  const heard = []
  const stamp = async () => {
    const info = await stat(store)
    return { path: store, bytes: info.size, mtimeMs: info.mtimeMs }
  }
  const provider = {
    harness: "opencode",
    displayName: "Fixture",
    roots: () => [root],
    watchRoots: () => [],
    pollFiles: () => [store, `${store}-wal`],
    rescanRoot: () => true,
    rescanDebounceMs: 20,
    watchTarget(path) {
      heard.push(path.slice(root.length + 1))
      return path.startsWith(store) ? path : null
    },
    async discover() {
      discoveries++
      return [await stamp()]
    },
    stat: stamp,
    async peek(file) {
      return { harness: "opencode", nativeId: "fixture", path: file.path, title: "Fixture", updatedAt: new Date(file.mtimeMs).toISOString() }
    },
    async read() {
      return null
    },
  }
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  catalog.startWatching()
  assert.equal(catalog.metrics.watchers, 0, "the root isn't watched")
  const scanned = discoveries

  for (let index = 0; index < 50; index++) await writeFile(join(logs, `run-${index}.log`), String(index))
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.equal(discoveries, scanned, "log writes re-run no discovery")
  assert.deepEqual(heard, [], "and never reach the provider")

  await new Promise((resolve) => setTimeout(resolve, 1_100))
  await writeFile(`${store}-wal`, "commit")
  await wait(() => discoveries > scanned, "a write to the polled WAL re-runs discovery")
  assert.deepEqual(heard, ["store.db-wal"])
  await catalog.stop()
  console.log("polled stores: log churn under an unwatched root is never heard; a database write still refreshes within a second")
} finally {
  await rm(root, { recursive: true, force: true })
}
