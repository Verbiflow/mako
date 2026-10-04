import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { readLegacyStoreSnapshot } from "../electron/providers/cursor/legacy-store.ts"
import { copyLegacyStore, importedAgentDocument } from "../electron/providers/cursor/sdk/import.ts"
import { CURSOR_SDK_IMPORT_METADATA_KEY } from "@mako/sessions"

const root = mkdtempSync(join(tmpdir(), "mako-cursor-revision-"))
const path = join(root, "source.db")
const nativeId = "concurrent-native-writer"
const control = new Int32Array(new SharedArrayBuffer(4))
const soakMs = Number(process.env.MAKO_CURSOR_REVISION_SOAK_MS ?? 0)
assert.ok(Number.isFinite(soakMs) && soakMs >= 0 && soakMs <= 120000)
let worker: Worker | undefined
try {
  const database = new DatabaseSync(path)
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  database.prepare("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId: nativeId, latestRootBlobId: "root-0" }))
  database.close()
  worker = new Worker(new URL("./fixtures/cursor-revision-writer.mjs", import.meta.url), { workerData: { path, nativeId, control: control.buffer } })
  const ready = new Promise<void>((resolve, reject) => { worker!.once("message", () => resolve()); worker!.once("error", reject) })
  const exited = new Promise<void>((resolve, reject) => { worker!.once("exit", code => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}`))); worker!.once("error", reject) })
  // Observe a writer failure even if a synchronous assertion stops the reader.
  void exited.catch(() => undefined)
  await ready
  Atomics.store(control, 0, 1)
  Atomics.notify(control, 0)
  const timings: number[] = []
  const cpu = process.cpuUsage()
  const start = performance.now()
  const rssStart = process.memoryUsage().rss
  let peakRss = rssStart
  let lastRevision = ""
  let copies = 0
  const verify = (snapshot: ReturnType<typeof readLegacyStoreSnapshot>) => {
    const number = Number(snapshot.meta.latestRootBlobId.slice("root-".length))
    const oracle = createHash("sha256").update(JSON.stringify([nativeId, `root-${number}`, number])).digest("hex")
    assert.equal(snapshot.revision, oracle, "the head and blob count must describe one committed transaction")
    lastRevision = snapshot.meta.latestRootBlobId
  }
  for (let index = 0; (index < 10000 || performance.now() - start < soakMs); index++) {
    const before = performance.now()
    verify(readLegacyStoreSnapshot(path, nativeId))
    timings.push(performance.now() - before)
    if (index % 1000 === 0) {
      copies++
      const stateRoot = join(root, `import-${index}`)
      mkdirSync(stateRoot)
      const copied = copyLegacyStore(path, stateRoot, nativeId)
      const snapshot = readLegacyStoreSnapshot(copied, nativeId)
      verify(snapshot)
      const document = importedAgentDocument({ agentId: nativeId, source: { path, identity: nativeId }, snapshot, now: 0 })
      assert.equal(document.latestRootBlobId, snapshot.meta.latestRootBlobId)
      assert.equal(document.sdkMetadata[CURSOR_SDK_IMPORT_METADATA_KEY].revision, snapshot.revision)
    }
    if (index % 100 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  Atomics.store(control, 0, 2)
  Atomics.notify(control, 0)
  await exited
  assert.notEqual(lastRevision, "root-0", "the independent writer must advance while snapshots are observed")
  timings.sort((a, b) => a - b)
  console.log(JSON.stringify({ scope: "Native-format SQLite snapshots and copies with an independent writer; not native CLI/installed acceptance", reads: timings.length, copies, elapsedMs: performance.now() - start, p50Ms: timings[Math.floor(timings.length * .5)], p95Ms: timings[Math.floor(timings.length * .95)], p99Ms: timings[Math.floor(timings.length * .99)], cpuMicros: process.cpuUsage(cpu), rssStart, peakRss, rssEnd: process.memoryUsage().rss, lastRevision }))
} finally {
  Atomics.store(control, 0, 2)
  Atomics.notify(control, 0)
  await worker?.terminate()
  rmSync(root, { recursive: true, force: true })
}
