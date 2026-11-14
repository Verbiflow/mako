import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * A repack compacts a pack below the newest once a fifth of it is dead,
 * and skips grouping and compacting while nothing they decided on has
 * changed: no version, no drop, no session gone quiet, no pack added.
 */

const stores = new NativeStores(true)
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const lines = (count) => Array.from({ length: count }, () => `${JSON.stringify({ type: "assistant", text: randomBytes(48).toString("base64"), pad: "x".repeat(200) })}\n`).join("")

async function stored(store, key) {
  const parts = []
  for await (const part of store.content("fixture", key)) parts.push(part)
  return Buffer.concat(parts)
}

const packNames = async (folder) => (await readdir(join(folder, "packs"))).filter((name) => name.endsWith(".pack")).sort()
/** Capture moving on to a new pack, as it does once the newest fills: the next pack, empty, while the store is closed. */
async function nextPack(folder) {
  const newest = Number((await packNames(folder)).at(-1).slice(0, 8))
  await writeFile(join(folder, "packs", `${String(newest + 1).padStart(8, "0")}.pack`), "")
}

const root = await mkdtemp(join(tmpdir(), "mako-record-settled-"))
try {
  const home = join(root, "home")
  await mkdir(home, { recursive: true })
  const path = (id) => join(home, `${id}.jsonl`)
  const capture = (store, id) => store.capture({ harness: "fixture", nativeId: id, home, records: { roots: [{ name: "fixture", path: home }], files: [path(id)], databases: [] } })

  // A pack below the newest, three tenths of it deleted: compacted, the rest read back whole.
  {
    const folder = join(root, "compact")
    const quietMs = 3_600_000
    let store = new RecordStore(folder, stores)
    await writeFile(path("kept"), lines(2100))
    await writeFile(path("deleted"), lines(900))
    await capture(store, "kept")
    await capture(store, "deleted")
    const key = store.units("fixture", "kept")[0].key
    await store.close()
    await nextPack(folder)
    store = new RecordStore(folder, stores)
    await store.forget("fixture", "deleted")
    const report = await store.repack({ quietMs })
    assert.ok(report.dropped > 0, "the deleted session's chunks are dropped")
    assert.ok(report.copied > 0, `the pack, about seven tenths live, is compacted (${report.packBytesBefore} → ${report.packBytesAfter} bytes)`)
    assert.ok(report.packsRemoved >= 1, "the pack compacted out of is removed")
    assert.ok(report.packBytesAfter < report.packBytesBefore * 0.8, `its dead space comes back (${report.packBytesBefore} → ${report.packBytesAfter} bytes)`)
    assert.equal(sha(await stored(store, key)), sha(await readFile(path("kept"))), "what was kept reads back whole")
    assert.deepEqual(await store.verify(), [])

    // The repack after one that copied judges the packs again; then nothing has changed.
    assert.equal((await store.repack({ quietMs })).skipped?.compact, false, "packs a repack copied into are judged again")
    const settled = await store.repack({ quietMs })
    assert.deepEqual(settled.skipped, { group: true, compact: true }, "nothing changed: neither step reads the index")
    assert.equal(settled.copied, 0)
    await store.close()

    // A pack added below the newest is judged.
    await nextPack(folder)
    store = new RecordStore(folder, stores)
    assert.equal((await store.repack({ quietMs })).skipped?.compact, false, "a pack capture moved on from is judged")
    // So is every pack once something is dropped.
    await writeFile(path("brief"), lines(50))
    await capture(store, "brief")
    await store.forget("fixture", "brief")
    const afterDrop = await store.repack({ quietMs })
    assert.ok(afterDrop.dropped > 0)
    assert.equal(afterDrop.skipped?.compact, false, "a drop has every pack judged again")
    assert.equal(afterDrop.skipped?.group, false, "and every session")
    // Other options are other decisions.
    assert.deepEqual((await store.repack({ quietMs, liveRatio: 0.3 })).skipped, { group: false, compact: false }, "a repack with other options decides again")
    await store.close()
    console.log(`  compaction at seven tenths live: ${report.copied} chunks copied, packs ${report.packBytesBefore} → ${report.packBytesAfter} bytes`)
  }

  // A session busy at one repack is grouped by the first after it goes quiet; meanwhile grouping is skipped.
  {
    const folder = join(root, "quiet")
    const quietMs = 1500
    const store = new RecordStore(folder, stores)
    await writeFile(path("one"), "")
    await writeFile(path("two"), "")
    for (let round = 0; round < 6; round++)
      for (const id of ["one", "two"]) {
        await writeFile(path(id), lines(250), { flag: "a" })
        await capture(store, id)
      }
    const busy = await store.repack({ quietMs })
    assert.equal(busy.skipped?.group, false)
    assert.equal(busy.grouped + busy.alreadyGrouped, 0, "busy sessions wait")
    const waiting = await store.repack({ quietMs })
    assert.equal(waiting.skipped?.group, true, "nothing changed and nothing has gone quiet: grouping is skipped")
    await sleep(quietMs + 100)
    const quiet = await store.repack({ quietMs })
    assert.equal(quiet.skipped?.group, false, "once a session goes quiet, grouping runs")
    assert.equal(quiet.grouped + quiet.alreadyGrouped, 2, "and takes both")
    assert.equal((await store.repack({ quietMs })).skipped?.group, true, "then nothing changed again")
    // A new version is a change.
    await writeFile(path("one"), lines(10), { flag: "a" })
    await capture(store, "one")
    assert.equal((await store.repack({ quietMs })).skipped?.group, false, "a new version has grouping look again")
    // The backfill's pass lays out at most every `layoutEveryMs`: a new version waits for the next layout, a drop doesn't.
    const layoutEveryMs = 60_000
    assert.deepEqual((await store.repack({ quietMs, layoutEveryMs })).skipped, { group: true, compact: true }, "laid out by the last repack: nothing new to judge")
    await writeFile(path("two"), lines(10), { flag: "a" })
    await capture(store, "two")
    assert.deepEqual((await store.repack({ quietMs, layoutEveryMs })).skipped, { group: true, compact: true }, "laid out lately: a new version waits")
    assert.equal((await store.repack({ quietMs })).skipped?.group, false, "a repack asked for now looks at it")
    await writeFile(path("three"), lines(10))
    await capture(store, "three")
    await store.forget("fixture", "three")
    assert.deepEqual((await store.repack({ quietMs, layoutEveryMs })).skipped, { group: false, compact: false }, "a drop lays out and compacts however lately")
    assert.deepEqual(await store.verify(), [])
    await store.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("record-repack-settled: ok")
