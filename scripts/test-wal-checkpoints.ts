import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { WalPrimer, CHECKPOINT_WAL_LIMIT, type WalCheckpoint } from "@mako/host/conversations/wal-primer"
import { auditSnapshot } from "./performance-audit-fixtures.ts"

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
