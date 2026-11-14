import assert from "node:assert/strict"
import { z } from "zod"
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { LiveRecords } from "@mako/host/conversations/live-records"
import { JournalReclaims } from "@mako/host/conversations/journal-reclaim"
import { JournalReaders } from "@mako/host/conversations/journal-readers"
import { WalPrimer, CHECKPOINT_WAL_LIMIT, type WalCheckpoint } from "@mako/host/conversations/wal-primer"
import { auditSnapshot } from "./performance-audit-fixtures.ts"

const ReleaseMessageSchema = z.object({ kind: z.literal("release") })
const realTimeout = setTimeout
async function until(check: () => boolean): Promise<void> {
  const end = performance.now() + 10_000
  while (!check()) {
    assert.ok(performance.now() < end, "checkpoint ownership reached its boundary")
    await new Promise(resolve => realTimeout(resolve, 10))
  }
}
function opened(primer: WalPrimer) {
  const root = mkdtempSync(join(tmpdir(), "mwc-test-"))
  let snapshot = auditSnapshot(0)
  const journal = new LiveJournal(root, snapshot.session.id)
  journal.commit(snapshot)
  // Per-connection policy cannot be observed through a different SQLite connection.
  const db = journal["db"]
  const policy = () => Number(db.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint)
  journal.checkpointWith(primer)
  const commit = (bytes = 4096) => {
    const previous = snapshot
    const next = { ...snapshot, revision: snapshot.revision + 1, blocks: [...snapshot.blocks, { type: "tool" as const, id: `call-${snapshot.revision}`, title: "Edit", toolKind: "edit" as const, status: "completed" as const, output: "x".repeat(bytes) }] }
    journal.commit(next, previous)
    snapshot = next
  }
  return { root, journal, db, policy, commit, snapshot: () => snapshot }
}

/** Hold the actual release message: the real worker keeps its SQLite connection until delivered. */
function heldRelease(primer: WalPrimer) {
  const thread = primer["generation"]!.thread
  const original = thread.postMessage
  let pending: Parameters<typeof original> | undefined
  thread.postMessage = (...args) => {
    const message: unknown = args[0]
    if (ReleaseMessageSchema.safeParse(message).success) {
      assert.equal(pending, undefined, "one old connection is held")
      pending = args
    } else original.apply(thread, args)
  }
  return {
    held: () => pending !== undefined,
    deliver() {
      thread.postMessage = original
      if (pending) {
        const args = pending
        pending = undefined
        original.apply(thread, args)
      }
    },
  }
}

/** A genuinely mostly-free SQLite file makes the old close eligible for compaction. */
function freePages(journal: LiveJournal): void {
  journal["db"].exec("CREATE TABLE release_fixture(value BLOB); INSERT INTO release_fixture VALUES (zeroblob(16777216)); DELETE FROM release_fixture")
  assert.equal(journal["mostlyFree"](), true)
}

test("unload and immediate reopen cancel old tidy while a zero-paged checkpoint release is held", async () => {
  const root = mkdtempSync(join(tmpdir(), "mwc-reopen-"))
  const snapshot = auditSnapshot(0)
  const seed = new LiveJournal(root, snapshot.session.id)
  seed.commit(snapshot)
  seed.close()
  const compacted: string[] = []
  const records = new LiveRecords({ root, appPath: root, driver: () => undefined, history: async () => null, emit() {} }, {
    busy: () => false, flush() {}, storageFailed() { assert.fail("fixture storage failed") }, loaded() {}, compact: path => { compacted.push(path) },
  })
  records.open()
  const old = records.load(snapshot.session.id)!
  const primer = records["primer"]
  let release: ReturnType<typeof heldRelease> | undefined
  try {
    await until(() => old.journal["checkpoints"]?.active() === true)
    assert.equal(old.journal.pagedCount(), 0)
    freePages(old.journal)
    release = heldRelease(primer)
    assert.equal(records["unload"](old), true)
    assert.equal(release.held(), true, "the old native connection is still open")
    const reopened = records.load(snapshot.session.id)!
    assert.notEqual(reopened.journal, old.journal)
    release.deliver()
    await old.journal.released()
    assert.deepEqual(compacted, [], "the old close must not compact a journal reopened while it waited")
    assert.equal(reopened.journal.read()?.session.id, snapshot.session.id)
  } finally {
    release?.deliver()
    await records.stop()
    for (const resident of records.values()) { resident.journal.close(); await resident.journal.released() }
    await old.journal.released()
    await records.stopCheckpoints()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a different owner opening the same file fences a delayed checkpoint tidy", async () => {
  const primer = new WalPrimer(), item = opened(primer)
  const compacted: string[] = []
  let release: ReturnType<typeof heldRelease> | undefined
  let reopened: LiveJournal | undefined
  try {
    await until(() => item.policy() === 0)
    freePages(item.journal)
    release = heldRelease(primer)
    item.journal.close(path => { compacted.push(path) })
    assert.equal(release.held(), true)
    reopened = new LiveJournal(item.root, item.snapshot().session.id)
    const previous = reopened.read()!
    reopened.commit({ ...previous, revision: previous.revision + 1, blocks: [{ type: "text", text: "new owner" }] }, previous)
    release.deliver()
    await item.journal.released()
    assert.deepEqual(compacted, [], "old tidy cannot touch another owner's reopened file")
    assert.deepEqual(reopened.read()?.blocks, [{ type: "text", text: "new owner" }])
  } finally {
    release?.deliver()
    reopened?.close()
    await reopened?.released()
    item.journal.close()
    await item.journal.released()
    await primer.stop()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("an abandoned close joins its checkpoint connection without scheduling a new compaction", async () => {
  const primer = new WalPrimer(), item = opened(primer)
  const compacted: string[] = []
  let release: ReturnType<typeof heldRelease> | undefined
  try {
    await until(() => item.policy() === 0)
    freePages(item.journal)
    release = heldRelease(primer)
    const closed = item.journal.close(path => { compacted.push(path) }, true)
    assert.ok(closed instanceof Promise, "close exposes the actual release completion")
    assert.equal(release.held(), true)
    release.deliver()
    await closed
    assert.deepEqual(compacted, [], "shutdown leaves compaction for a later owner")
    assert.equal(existsSync(item.journal.file + "-wal"), false)
  } finally {
    release?.deliver()
    await item.journal.close()
    await primer.stop()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("close joins the compaction worker's termination promise before releasing the root", async context => {
  const root = mkdtempSync(join(tmpdir(), "mwc-compact-join-"))
  const journal = new LiveJournal(root, auditSnapshot(0).session.id)
  journal.commit(auditSnapshot(0))
  freePages(journal)
  const reclaims = new JournalReclaims()
  let deliver!: () => void
  const gate = new Promise<void>(resolve => { deliver = resolve })
  const terminate = Worker.prototype.terminate
  let terminating = false
  context.mock.method(Worker.prototype, "terminate", function (this: Worker) {
    const ended = terminate.call(this)
    terminating = true
    return ended.then(async code => { await gate; return code })
  })
  let closed: Promise<void> | undefined
  try {
    closed = journal.close(async path => {
      const result = await reclaims.reclaim(path)
      assert.equal("error" in result, false, "the actual SQLite compaction completed")
    })
    let done = false
    void closed.then(() => { done = true }, () => {})
    await until(() => terminating)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(done, false, "a reply alone is not the worker's release")
    deliver()
    await closed
    assert.equal(done, true)
  } finally {
    deliver()
    await Promise.allSettled([closed, journal.close()])
    rmSync(root, { recursive: true, force: true })
  }
})

test("a compaction queued before reopen cannot delete the new owner's staged history", async () => {
  const root = mkdtempSync(join(tmpdir(), "mwc-queued-tidy-"))
  const snapshot = auditSnapshot(0)
  const journal = new LiveJournal(root, snapshot.session.id)
  journal.commit(snapshot)
  freePages(journal)
  const reclaims = new JournalReclaims()
  let deliver!: () => void
  reclaims["queue"] = new Promise<void>(resolve => { deliver = resolve })
  const closed = journal.close(path => reclaims.reclaim(path))
  let reopened: LiveJournal | undefined
  try {
    reopened = new LiveJournal(root, snapshot.session.id)
    reopened["db"].prepare("INSERT INTO base_entries(id,value) VALUES(1,?)").run(JSON.stringify({ type: "text", text: "new staged history" }))
    deliver()
    await closed
    assert.equal(reopened["db"].prepare("SELECT count(*) AS n FROM base_entries").get()?.n, 1,
      "a queued old compaction must not discard history staged after a new open")
  } finally {
    deliver()
    await Promise.allSettled([closed, reopened?.close(undefined, true)])
    rmSync(root, { recursive: true, force: true })
  }
})

test("stopping cancels queued compaction and joins it without starting another worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "mwc-stop-queued-"))
  const journal = new LiveJournal(root, auditSnapshot(0).session.id)
  journal.commit(auditSnapshot(0))
  freePages(journal)
  const reclaims = new JournalReclaims()
  let deliver!: () => void
  reclaims["queue"] = new Promise<void>(resolve => { deliver = resolve })
  let result: Awaited<ReturnType<JournalReclaims["reclaim"]>> | undefined
  const closed = journal.close(async path => { result = await reclaims.reclaim(path) })
  const stopped = reclaims.stop()
  try {
    deliver()
    await Promise.all([closed, stopped])
    assert.deepEqual(result, { skipped: true })
    assert.equal(reclaims["pending"].size, 0)
    assert.deepEqual(await reclaims.reclaim(journal.file), { skipped: true }, "a stopped owner never queues more work")
  } finally {
    deliver()
    await Promise.allSettled([closed, stopped])
    rmSync(root, { recursive: true, force: true })
  }
})

test("the actual compaction worker observes cancellation without deleting staged rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "mwc-native-cancel-"))
  const journal = new LiveJournal(root, auditSnapshot(0).session.id)
  journal.commit(auditSnapshot(0))
  await journal.close()
  const db = new DatabaseSync(journal.file)
  db.prepare("INSERT INTO base_entries(id,value) VALUES(1,?)").run(JSON.stringify({ type: "text", text: "new staged history" }))
  const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  Atomics.store(new Int32Array(cancellation), 0, 1)
  const worker = new Worker(new URL(import.meta.resolve("@mako/host/conversations/journal-reclaim-worker")), {
    workerData: { path: journal.file, cancellation }, resourceLimits: { maxOldGenerationSizeMb: 64 },
  })
  const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()))
  try {
    const [answer] = await once(worker, "message")
    assert.deepEqual(answer, { skipped: true })
    await exited
    assert.equal(db.prepare("SELECT count(*) AS n FROM base_entries").get()?.n, 1)
  } finally {
    await worker.terminate()
    await exited
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

const readerEntry = new URL("data:text/javascript," + encodeURIComponent("import{parentPort}from'node:worker_threads';parentPort.on('message',m=>parentPort.postMessage({id:m.id,rows:null}))"))

test("journal reader stop calls share the actual termination completion", async context => {
  const readers = new JournalReaders(readerEntry)
  await readers.read("/unused-lifetime-fixture", false)
  const thread = readers["readers"][0]!.worker
  const terminate = thread.terminate.bind(thread)
  let deliver!: () => void
  const gate = new Promise<void>(resolve => { deliver = resolve })
  context.mock.method(thread, "terminate", () => terminate().then(async code => { await gate; return code }))
  const closed = readers.stop()
  try {
    assert.equal(readers.stop(), closed, "a second stop cannot return before the first termination")
    let done = false
    void closed.then(() => { done = true }, () => {})
    await until(() => thread.threadId === -1)
    assert.equal(done, false)
    deliver()
    await closed
  } finally {
    deliver()
    await closed
  }
})

test("idle journal reader termination is still joined by stop", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const readers = new JournalReaders(readerEntry)
  let deliver!: () => void
  const gate = new Promise<void>(resolve => { deliver = resolve })
  let closed: Promise<void> | undefined
  try {
    await readers.read("/unused-lifetime-fixture", false)
    const thread = readers["readers"][0]!.worker
    const terminate = thread.terminate.bind(thread)
    context.mock.method(thread, "terminate", () => terminate().then(async code => { await gate; return code }))
    context.mock.timers.tick(60_000)
    closed = readers.stop()
    let done = false
    void closed.then(() => { done = true }, () => {})
    await until(() => thread.threadId === -1)
    assert.equal(done, false, "removing the idle reader from the pool is not its termination")
    deliver()
    await closed
  } finally {
    deliver()
    await closed
    await readers.stop()
    context.mock.timers.reset()
  }
})

test("older SQLite or an unavailable version keeps foreground checkpoint ownership", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "sqlite")
  assert.ok(descriptor?.configurable, "the isolated test can restore the runtime's version metadata")
  try {
    for (const version of ["3.50.4", "3.9.2", "2.99.0", undefined, "unknown", "3.51.bad"]) {
      // The worker uses this process's own SQLite build. Override only its reported capability, never the database.
      Object.defineProperty(process.versions, "sqlite", { ...descriptor, value: version })
      const primer = new WalPrimer(), item = opened(primer)
      try {
        assert.equal(primer["generation"], undefined, `${version}: no unsupported counter owner is started`)
        assert.equal(item.policy(), 1000)
        item.commit()
        assert.deepEqual(item.journal.read()?.blocks, item.snapshot().blocks)
      } finally {
        item.journal.close()
        await item.journal.released()
        await primer.stop()
        rmSync(item.root, { recursive: true, force: true })
      }
    }
  } finally { Object.defineProperty(process.versions, "sqlite", descriptor) }
})

test("only acknowledged checkpoint ownership disables the host, and PASSIVE runs off its thread", async () => {
  const primer = new WalPrimer(), item = opened(primer)
  try {
    assert.equal(item.policy(), 1000, "opening alone is not checkpoint ownership")
    await until(() => item.policy() === 0)
    assert.equal(item.db.prepare("PRAGMA wal_checkpoint(NOOP)").get()?.checkpointed, 0)
    for (let i = 0; i < 180; i++) {
      item.commit()
      if (i % 8 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    await until(() => Number(item.db.prepare("PRAGMA wal_checkpoint(NOOP)").get()?.checkpointed) > 0)
    assert.equal(item.policy(), 0)
    assert.ok(statSync(item.journal.file + "-wal").size < CHECKPOINT_WAL_LIMIT)
    assert.deepEqual(item.journal.read()?.blocks, item.snapshot().blocks)
    item.journal.close()
    await item.journal.released()
    assert.equal(existsSync(item.journal.file + "-wal"), false, "the worker's last connection closed before file reclamation")
  } finally {
    item.journal.close()
    await item.journal.released()
    await primer.stop()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("worker death restores foreground before further writes, including staging's policy", async () => {
  const primer = new WalPrimer(), item = opened(primer)
  try {
    await until(() => item.policy() === 0)
    // This setter is what stageBase/stopStaging use; exercise its foreground target independently of history content.
    item.journal["checkpointAt"](256)
    assert.equal(item.policy(), 0)
    await primer["generation"]!.thread.terminate()
    await until(() => item.policy() === 256)
    item.commit()
    item.journal["checkpointAt"](undefined)
    assert.equal(item.policy(), 1000)
    item.commit()
    assert.deepEqual(item.journal.read()?.blocks, item.snapshot().blocks)
  } finally {
    item.journal.close()
    await item.journal.released()
    await primer.stop()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("an unresponsive acknowledged worker loses ownership at its actual request deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const primer = new WalPrimer({ requestMs: 5000, source: `const{parentPort}=require('node:worker_threads');parentPort.on('message',m=>{if(m.kind==='open')parentPort.postMessage({id:m.id,kind:m.kind,ok:true})})` })
  const item = opened(primer)
  try {
    await until(() => item.policy() === 0)
    context.mock.timers.tick(5000)
    await until(() => item.policy() === 1000)
    item.commit()
    assert.deepEqual(item.journal.read()?.blocks, item.snapshot().blocks)
  } finally {
    item.journal.close()
    await item.journal.released()
    await primer.stop()
    context.mock.timers.reset()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("a byte guard exits background mode while a reader pins the WAL, without dropping data", async () => {
  const primer = new WalPrimer(), item = opened(primer)
  const reader = new DatabaseSync(item.journal.file, { readOnly: true })
  try {
    await until(() => item.policy() === 0)
    reader.exec("BEGIN")
    reader.prepare("SELECT revision FROM progress").get()
    for (let i = 0; i < 128 && item.policy() === 0; i++) item.commit(64 * 1024)
    assert.equal(item.policy(), 1000, "foreground fallback is synchronous with the guard")
    assert.ok(statSync(item.journal.file + "-wal").size >= CHECKPOINT_WAL_LIMIT)
    item.commit()
    assert.deepEqual(item.journal.read()?.blocks, item.snapshot().blocks)
    reader.exec("COMMIT")
  } finally {
    reader.close()
    item.journal.close()
    await item.journal.released()
    await primer.stop()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("a failed policy restoration blocks a write until foreground policy can be restored", async () => {
  const primer = new WalPrimer(), item = opened(primer)
  const original = item.db.exec.bind(item.db)
  let fail = true
  try {
    await until(() => item.policy() === 0)
    item.db.exec = sql => {
      if (fail && sql === "PRAGMA wal_autocheckpoint=1000") throw new Error("test restore failure")
      return original(sql)
    }
    await primer.stop()
    assert.equal(item.policy(), 0, "the injected setter failed")
    const revision = item.journal.read()?.revision
    assert.throws(() => item.commit(), /test restore failure/)
    assert.equal(item.journal.read()?.revision, revision, "no transaction began under unknown checkpoint ownership")
    fail = false
    item.commit()
    assert.equal(item.policy(), 1000)
  } finally {
    item.db.exec = original
    item.journal.close()
    await item.journal.released()
    await primer.stop()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("unacknowledged and malformed ownership leave foreground checkpoints enabled", async () => {
  for (const source of [
    `const{parentPort}=require('node:worker_threads');parentPort.on('message',m=>parentPort.postMessage({id:m.id,kind:m.kind,ok:false}))`,
    `const{parentPort}=require('node:worker_threads');parentPort.on('message',m=>parentPort.postMessage({id:m.id,kind:'check',ok:true,bytes:'bad'}))`,
  ]) {
    const primer = new WalPrimer({ source }), item = opened(primer)
    try {
      assert.equal(item.policy(), 1000)
      await once(primer["generation"]!.thread, "message")
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(item.policy(), 1000)
      // Explicit stop also joins the malformed worker without waiting for a real deadline.
      await primer["generation"]?.thread.terminate()
      await primer.stop()
      item.commit()
    } finally {
      item.journal.close()
      await item.journal.released()
      await primer.stop()
      rmSync(item.root, { recursive: true, force: true })
    }
  }
})


test("checkpoint connections are bounded and every accepted handle closes on stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "mwc-capacity-"))
  const primer = new WalPrimer()
  const databases: DatabaseSync[] = []
  const leases: WalCheckpoint[] = []
  try {
    for (let i = 0; i < 32; i++) {
      const path = join(root, `${i}.sqlite`)
      const db = new DatabaseSync(path)
      databases.push(db)
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE work(id INTEGER PRIMARY KEY)")
      const lease = primer.watch(path, () => {})
      assert.ok(lease)
      leases.push(lease)
    }
    assert.equal(primer.watch(join(root, "overflow.sqlite"), () => {}), undefined)
    await until(() => leases.every(lease => lease.active()))
    await primer.stop()
    assert.ok(leases.every(lease => !lease.active()))
    await Promise.all(leases.map(lease => lease.close()))
  } finally {
    await primer.stop()
    for (const db of databases) db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("an old generation's reply cannot adopt a new generation's pending lease", async () => {
  const primer = new WalPrimer({ source: `require('node:worker_threads').parentPort.on('message',()=>{})` })
  try {
    const first = primer.watch("/unused-first", () => {})!
    const old = primer["generation"]!
    await old.thread.terminate()
    await until(() => primer["generation"] === undefined)
    const second = primer.watch("/unused-second", () => {})!
    const pending = [...primer["waiting"].keys()][0]!
    old.thread.emit("message", { id: pending, kind: "open", ok: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(first.active(), false)
    assert.equal(second.active(), false, "a stale sender cannot acknowledge the replacement's ownership")
    await primer["generation"]!.thread.terminate()
    await first.close()
    await second.close()
  } finally { await primer.stop() }
})
