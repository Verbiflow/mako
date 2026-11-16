import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mock } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { CheckpointFingerprints, threadFingerprint } from "@mako/host/attribution/checkpoint-fingerprints"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import { HostJobs } from "@mako/host/base/host-jobs"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { openAttribution } from "@mako/host/attribution/index"
import { sharedJournalFolder } from "@mako/host/attribution/shared-journal"
import { partition, storedView, turnChanges } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { nodeFileSystem } from "@mako/host/attribution/ports"
import { contentRef } from "@mako/host/attribution/content"
import { collectPlanOffThread, JournalReader } from "@mako/host/attribution/journal-reader"
import { JournalStore, type StoredActivity } from "@mako/host/attribution/journal-store"

/*
 * The record of changes' reads that run off the host's thread say what they said on it (`npm run test:attribution`):
 * the hourly collection, read on a worker and dropped on the owner's connection, drops exactly what it dropped all at
 * once, and never what the owner wrote after the worker's reading began; the activity a gap's changes are attributed
 * from, read on the journal's reader, is what the owner's connection reads.
 */

const DAY = 86_400_000
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-off-loop-")))
const bytes = (text: string) => new TextEncoder().encode(text)

/** A journal holding content four ways: behind an old entry only, a young entry, an uncommitted file, and the stat cache. */
function journal(folder: string, now: number) {
  const store = JournalStore.open(join(folder, "journal.sqlite"), { device: "off-loop" })
  const old = now - 30 * DAY
  const content = (name: string) => {
    const data = bytes(`${name}\n`.repeat(50))
    const ref = contentRef(data)
    store.putBlob(ref, data, old)
    return ref
  }
  const refs = { oldOnly: [content("a"), content("b"), content("c")], young: content("young"), file: content("file"), stat: content("stat"), spare: content("spare") }
  const entry = (before: string | null, after: string | null, at: number, path: string) => ({
    at, changedAt: at, root: "r", path, kind: "modify" as const, before, after, text: true, added: 1, removed: 1, stored: true, observed: "event" as const,
    author: { certainty: "person" as const, via: "no-activity" as const }, settled: true,
  })
  store.transaction(() => {
    store.saveRoot({ id: "r", path: join(folder, "root"), kind: "workspace", repository: false, head: null, mark: null, seenAt: now, trackedAt: old, active: true })
    store.insertEntry(entry(refs.oldOnly[0]!, refs.oldOnly[1]!, old, "src/a.ts"))
    store.insertEntry(entry(refs.oldOnly[1]!, refs.oldOnly[2]!, old + 1, "src/a.ts"))
    store.insertEntry(entry(refs.spare, refs.young, now - DAY, "src/b.ts"))
    store.saveFile({ root: "r", path: "src/c.ts", base: refs.file, baseSeq: 0, current: refs.file, text: false, map: [] })
    store.saveStat("r", "src/d.ts", { dev: 1, ino: 1, size: 1, mode: 0o100644, mtimeNs: 1n, ctimeNs: 1n, ref: refs.stat, checkedNs: 1n })
  })
  return { store, refs }
}

test("collected off the host's thread, kept content goes exactly as collected at once", async () => {
  const now = Date.now()
  const here = scratch()
  const there = scratch()
  try {
    const a = journal(here, now)
    const b = journal(there, now)
    const atOnce = a.store.collect(now - 14 * DAY, 2 * 1024 ** 3)
    b.store.touching()
    const plan = await collectPlanOffThread(b.store.path, now - 14 * DAY, 2 * 1024 ** 3)
    const offThread = b.store.dropPlanned(plan.refs)
    b.store.dropOld(now - 14 * DAY)
    b.store.untouched()
    assert.deepEqual(offThread, atOnce)
    assert.equal(atOnce.dropped, 3, "only what an old entry alone names goes")
    for (const ref of [b.refs.young, b.refs.spare, b.refs.file, b.refs.stat]) assert.ok(b.store.hasBlob(ref), "what a young entry, a file or the stat cache names stays")
    for (const ref of b.refs.oldOnly) assert.ok(!b.store.hasBlob(ref))
    a.store.close()
    b.store.close()
  } finally {
    rmSync(here, { recursive: true, force: true })
    rmSync(there, { recursive: true, force: true })
  }
})

test("content the owner names again while the worker reads is never dropped", async () => {
  const now = Date.now()
  const folder = scratch()
  try {
    const { store, refs } = journal(folder, now)
    store.touching()
    const plan = await collectPlanOffThread(store.path, now - 14 * DAY, 2 * 1024 ** 3)
    assert.deepEqual(new Set(plan.refs.map((item) => item.ref)), new Set(refs.oldOnly))
    store.transaction(() => {
      store.insertEntry({ at: now, changedAt: now, root: "r", path: "src/e.ts", kind: "modify", before: null, after: refs.oldOnly[0]!, text: true, added: 1, removed: 0, stored: true, observed: "event",
        author: { certainty: "person", via: "no-activity" }, settled: true })
      store.saveStat("r", "src/f.ts", { dev: 1, ino: 2, size: 1, mode: 0o100644, mtimeNs: 1n, ctimeNs: 1n, ref: refs.oldOnly[1]!, checkedNs: 1n })
      store.putBlob(refs.oldOnly[2]!, bytes("c\n".repeat(50)), now)
    })
    const dropped = store.dropPlanned(plan.refs)
    store.untouched()
    assert.equal(dropped.dropped, 0)
    for (const ref of refs.oldOnly) assert.ok(store.hasBlob(ref))
    store.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("the activity a gap's changes are attributed from reads the same on the journal's reader", async () => {
  const now = Date.now()
  const folder = scratch()
  const reader = new JournalReader(join(folder, "journal.sqlite"))
  try {
    const store = JournalStore.open(join(folder, "journal.sqlite"), { device: "off-loop" })
    const call = (index: number, start: number, end: number | null): StoredActivity => ({
      kind: "call", id: `c${index}`, session: "s", thread: "t", turn: "turn", checkout: folder, cwd: folder, named: [`${folder}/f${index}`], start, end,
      effects: [{ kind: "modify", path: `${folder}/f${index}` }], status: "completed",
    })
    store.transaction(() => {
      store.saveActivity(call(1, now - 10 * DAY, now - 10 * DAY + 5))
      store.saveActivity(call(2, now - 3_000, now - 2_000))
      store.saveActivity(call(3, now - 60_000, null))
      store.saveActivity(call(4, now + 5_000, now + 6_000))
    })
    const from = now - 5_000
    const read = store.activityOfRows(await reader.activityOverlapping(from, now))
    const sort = (items: StoredActivity[]) => [...items].sort((x, y) => x.id.localeCompare(y.id))
    assert.deepEqual(sort(read), sort(store.activityBetween(from, now)))
    assert.deepEqual(read.map((item) => item.id).sort(), ["c2", "c3"])
    const blobs = await reader.blobs([contentRef(bytes("missing"))])
    assert.equal(blobs.size, 0, "content the journal doesn't hold is missing, not an error")
    store.close()
  } finally {
    await reader.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("a reader counts complete turns from new commits, without reading their bodies on its caller's thread", async () => {
  const folder = scratch()
  const { store, refs } = journal(folder, Date.now())
  const reader = new JournalReader(store.path)
  const before = JournalStore.prototype.blob
  const own = { certainty: "exact" as const, author: { thread: "t", session: "s", turn: "turn" }, effect: "modify" as const }
  const write = (after: string, at: number) => store.insertEntry({ at, changedAt: at, root: "r", path: "count.ts", kind: "modify", before: refs.oldOnly[0]!, after, text: true, stored: true, observed: "event", author: own, settled: true })
  try {
    const now = Date.now()
    write(refs.oldOnly[1]!, now)
    store.saveActivity({ kind: "turn", id: "turn", session: "s", thread: "t", turn: "turn", checkout: folder, named: [], start: now, end: now + 1 })
    const expected = turnChanges(storedView(store), "t", "turn", "settling", 0)
    JournalStore.prototype.blob = () => { throw new Error("a turn's body must not be read on the caller") }
    const counted = await reader.countTurn("t", "turn", "settling")
    assert.deepEqual({ ...counted, at: 0 }, expected)
    assert.equal(counted?.own.files, 1)
    JournalStore.prototype.blob = before
    write(refs.oldOnly[2]!, now + 1)
    const next = turnChanges(storedView(store), "t", "turn", "settled", 0)
    JournalStore.prototype.blob = () => { throw new Error("a fresh count must stay off the caller too") }
    const [a, b] = await Promise.all([reader.countTurn("t", "turn", "settled"), reader.countTurn("t", "turn", "settled")])
    assert.deepEqual({ ...a, at: 0 }, next)
    assert.deepEqual({ ...b, at: 0 }, next)
    assert.ok(a && counted && a.through > counted.through, "the worker reads the later commit rather than a cached view")
    const pending = reader.countTurn("t", "turn", "settled")
    const closing = reader.close()
    await assert.rejects(pending, /closed/, "a pending read rejects at retirement before its reply can publish")
    assert.equal(reader.close(), closing, "one completion joins the worker's exit")
    await closing
    await assert.rejects(reader.countTurn("t", "turn", "settled"), /closed/)
  } finally {
    JournalStore.prototype.blob = before
    await reader.close()
    store.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("the composed attribution owner counts off-thread and discards an in-flight count at close", async () => {
  const folder = scratch()
  const storage = sharedJournalFolder(folder)
  const { store, refs } = journal(storage, Date.now())
  mkdirSync(join(storage, "root"), { recursive: true })
  const now = Date.now()
  store.insertEntry({ at: now, changedAt: now, root: "r", path: "own.ts", kind: "modify", before: refs.oldOnly[0]!, after: refs.oldOnly[1]!, text: true, stored: true, observed: "event", author: { certainty: "exact", author: { thread: "t", session: "s", turn: "turn" }, effect: "modify" }, settled: true })
  store.saveActivity({ kind: "turn", id: "turn", session: "s", thread: "t", turn: "turn", checkout: storage, named: [], start: now, end: now + 1 })
  store.close()
  const owner = await openAttribution({ dataRoot: folder, userRoot: folder, label: "count-reader", git: new Git(), jobs: new HostJobs(), watch: () => ({ ready: Promise.resolve(), close() {} }), stores: () => [], placement: () => undefined, session: () => undefined })
  const before = JournalStore.prototype.blob
  let closed: Promise<void> | undefined
  try {
    assert.equal(owner.failure(), undefined, "the real writing owner must have opened before the read")
    await owner.settled()
    const source = JournalStore.open(join(storage, "journal.sqlite"), { device: "", readOnly: true })
    const expected = turnChanges(storedView(source), "t", "turn", "settled", 0)
    source.close()
    JournalStore.prototype.blob = () => { throw new Error("the composed owner read a body on the host thread") }
    const counted = await owner.countTurn("t", "turn", "settled")
    assert.deepEqual({ ...counted, at: 0 }, expected)
    const pending = owner.countTurn("t", "turn", "settled")
    closed = owner.close()
    assert.equal(owner.close(), closed, "repeated close joins the same release rather than returning early")
    assert.equal(await pending, undefined, "a count from the retired source cannot publish after close")
    await closed
    assert.equal(await owner.countTurn("t", "turn", "settled"), undefined)
  } finally {
    JournalStore.prototype.blob = before
    await (closed ?? owner.close())
    rmSync(folder, { recursive: true, force: true })
  }
})

test("a failed reader count rejects without a synchronous fallback, and releases before folder removal", async () => {
  const folder = scratch()
  const reader = new JournalReader(join(folder, "absent.sqlite"))
  try {
    await assert.rejects(reader.countTurn("t", "turn", "settled"))
  } finally {
    await reader.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("a repeated tracker close joins the release even after the tracker is marked closed", async () => {
  const folder = scratch()
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events: new FakeEventSource(), clock: new FakeClock(), storage: folder, device: "close-reader" })
  try {
    const closed = tracker.close()
    assert.equal(tracker.close(), closed)
    await closed
    assert.equal(tracker.close(), closed)
  } finally {
    await tracker.close()
    rmSync(folder, { recursive: true, force: true })
  }
})



test("checkpoint identities ignore activity and stats, follow partition inputs, and bound retained Threads", async () => {
  const folder = scratch()
  const { store, refs } = journal(folder, Date.now())
  const checkout = join(folder, "root")
  const root = store.roots()[0]!
  store.saveFile({ root: "r", path: "own.bin", base: null, baseSeq: 0, current: refs.young, text: false, map: [] })
  store.insertEntry({ at: 1, changedAt: 1, root: "r", path: "own.bin", kind: "create", before: null, after: refs.young, text: false, stored: true, observed: "event", author: { certainty: "exact", author: { thread: "t", session: "s", turn: "turn" }, effect: "create" }, settled: true })
  const cache = new CheckpointFingerprints(store)
  const reader = new JournalReader(store.path)
  let noScan: ReturnType<typeof mock.method> | undefined
  try {
    const expected = createHash("sha256").update(threadFingerprint(root.head, partition(storedView(store), checkout, "t"), checkout)).digest("hex")
    assert.equal(cache.read(checkout, "t"), expected)
    noScan = mock.method(store, "files", () => { throw new Error("unchanged checkpoint scanned its files") })
    assert.equal(cache.read(checkout, "t"), expected, "no file read or hash on a cache hit")
    const other = JournalStore.open(store.path, { device: "off-loop" })
    try {
      other.saveActivity({ session: "foreign", kind: "turn", id: "running", thread: "other", turn: "running", start: 2, end: null, named: [] })
      assert.equal(cache.read(checkout, "t"), expected, "another Thread's live activity causes no file read or text hash")
      store.saveRoot({ ...root, seenAt: root.seenAt + 1, mark: "observed" })
      store.saveStat("r", "src/d.ts", { dev: 1, ino: 1, size: 1, mode: 0o100644, mtimeNs: 2n, ctimeNs: 2n, ref: refs.stat, checkedNs: 2n })
      assert.equal(cache.read(checkout, "t"), expected, "observation bookkeeping does not hash unchanged content")
      other.saveRoot({ ...root, id: "other-root", path: join(folder, "other") })
      const foreign = contentRef(bytes("another checkout"))
      other.putBlob(foreign, bytes("another checkout"), 3)
      other.saveFile({ root: "other-root", path: "file", base: null, baseSeq: 0, current: foreign, text: false, map: [] })
      assert.equal(cache.read(checkout, "t"), expected, "another checkout's content changes do no text work here")
    } finally { other.close() }
    // Only the head changed: a revision must invalidate even when the Thread wrote no new file.
    store.saveRoot({ ...root, head: "new-head" })
    assert.throws(() => cache.read(checkout, "t"), /scanned its files/, "a changed input really revisits the partition")
    noScan.mock.restore()
    const changed = cache.read(checkout, "t")
    assert.notEqual(changed, expected)
    assert.equal(await reader.checkpointFingerprint(checkout, "t"), changed)
    // The main thread must not rebuild a partition or read a body when the worker answers.
    noScan = mock.method(JournalStore.prototype, "files", () => { throw new Error("checkpoint read files on the host") })
    assert.equal(await reader.checkpointFingerprint(checkout, "t"), changed)
    noScan.mock.restore()
    store.saveRoot(root)
    assert.equal(await reader.checkpointFingerprint(checkout, "t"), expected, "the worker sees another connection's commit")
    assert.notEqual(cache.read(checkout, "other"), expected, "one Thread never borrows another's identity")
    for (let n = 0; n < 129; n++) cache.read(checkout, `other-${n}`)
    noScan = mock.method(store, "files", () => { throw new Error("evicted checkpoint read again") })
    assert.throws(() => cache.read(checkout, "other"), /evicted checkpoint/, "at most 128 tokens remain")
  } finally {
    noScan?.mock.restore()
    await reader.close()
    store.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("checkpoint versions follow content and attribution across writers, survive rollback, and migrate old readers", () => {
  const folder = scratch()
  const { store, refs } = journal(folder, Date.now())
  const checkout = store.roots()[0]!.path
  const reader = JournalStore.open(store.path, { device: "reader", readOnly: true })
  try {
    const before = reader.checkpointVersion(checkout)
    assert.throws(() => store.transaction(() => { store.putBlob(contentRef(bytes("rolled back")), bytes("rolled back"), 1); throw new Error("rollback") }), /rollback/)
    assert.equal(reader.checkpointVersion(checkout), before, "a rolled-back content change is not a new input")
    store.saveFile({ root: "r", path: "new", base: null, baseSeq: 0, current: refs.young, text: false, map: [] })
    assert.notEqual(reader.checkpointVersion(checkout), before, "new file input invalidates a reader")
    const seq = store.insertEntry({ at: 3, changedAt: 3, root: "r", path: "f", kind: "create", before: null, after: refs.young, text: false, stored: true, observed: "event", author: { certainty: "person", via: "no-activity" }, settled: false })
    const inserted = reader.checkpointVersion(checkout)
    store.settle(seq)
    assert.equal(reader.checkpointVersion(checkout), inserted, "settlement alone does not change the partition")
    store.updateAuthor(seq, { certainty: "exact", author: { thread: "t", session: "s", turn: "turn" }, effect: "create" }, true)
    assert.notEqual(reader.checkpointVersion(checkout), inserted, "attribution can move lines between Threads")
    const attributed = reader.checkpointVersion(checkout)
    store.markGit(seq, true)
    assert.notEqual(reader.checkpointVersion(checkout), attributed, "Git provenance can remove a Thread's lines")
    const git = reader.checkpointVersion(checkout)
    store.deleteFile("r", "src/c.ts")
    assert.notEqual(reader.checkpointVersion(checkout), git, "removing a file changes the partition")
  } finally { reader.close(); store.close() }
  // A read-only reader can precede migration; installing the counter never leaves its old cache valid.
  const old = new DatabaseSync(join(folder, "journal.sqlite"))
  try {
    for (const row of old.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'checkpoint_%'").all())
      old.exec(`DROP TRIGGER ${String(row.name)}`)
    old.exec("DROP TABLE checkpoint_root_changes")
  } finally { old.close() }
  const legacy = JournalStore.open(join(folder, "journal.sqlite"), { device: "old-reader", readOnly: true })
  try {
    assert.ok(legacy.checkpointVersion(checkout).startsWith("legacy:"))
    const migrated = JournalStore.open(join(folder, "journal.sqlite"), { device: "new-owner" })
    try { assert.ok(!legacy.checkpointVersion(checkout).startsWith("legacy:"), "the already-open reader adopts the new persisted counter") }
    finally { migrated.close() }
  } finally { legacy.close(); rmSync(folder, { recursive: true, force: true }) }
})

test("checkpoint caches keep separate root versions and revisit a missing text body when it arrives", () => {
  const folder = scratch()
  const { store } = journal(folder, Date.now())
  const checkout = store.roots()[0]!.path
  const elsewhere = join(folder, "elsewhere")
  const cache = new CheckpointFingerprints(store)
  let noScan: ReturnType<typeof mock.method> | undefined
  try {
    store.saveRoot({ ...store.roots()[0]!, id: "elsewhere", path: elsewhere })
    const a = cache.read(checkout, "t"), b = cache.read(elsewhere, "t")
    noScan = mock.method(store, "files", () => { throw new Error("unchanged roots were scanned again") })
    assert.equal(cache.read(checkout, "t"), a)
    assert.equal(cache.read(elsewhere, "t"), b)
    noScan.mock.restore()
    const base = bytes("base\n"), current = bytes("new\n"), before = contentRef(base), after = contentRef(current)
    const seq = store.insertEntry({ at: 4, changedAt: 4, root: "r", path: "late", kind: "modify", before, after, text: true, stored: true, observed: "event", author: { certainty: "exact", author: { thread: "t", session: "s", turn: "turn" }, effect: "modify" }, settled: true })
    store.saveFile({ root: "r", path: "late", base: before, baseSeq: 0, current: after, text: true, map: [{ ins: 0, origin: 0, length: 1, del: seq, over: 0 }, { ins: seq, origin: 0, length: 1, del: 0, over: 0 }] })
    const incomplete = cache.read(checkout, "t"), version = store.checkpointVersion(checkout)
    store.putBlob(before, base, 4); store.putBlob(after, current, 4)
    assert.equal(store.checkpointVersion(checkout), version, "content arriving doesn't need a new file write")
    const complete = cache.read(checkout, "t")
    assert.notEqual(complete, incomplete, "an incomplete input was not cached as a complete checkpoint")
    noScan = mock.method(store, "files", () => { throw new Error("complete unchanged input scanned again") })
    assert.equal(cache.read(checkout, "t"), complete)
  } finally { noScan?.mock.restore(); store.close(); rmSync(folder, { recursive: true, force: true }) }
})
