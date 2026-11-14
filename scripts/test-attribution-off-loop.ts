import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
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
    reader.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

