import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { recordChunks as bundleChunks, RecordBundleSchema } from "@mako/protocol/records"

/**
 * A session's records cross between stores, as they go from a machine to the cloud and back to a laptop: a store
 * exports what another lacks, the other takes it, chunk by checked chunk, and a restore there writes the session
 * exactly as it was captured. What arrives is checked, never taken on its sender's word.
 */

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-record-crossing-"))
/** What one store's `exportSession` and `readChunk` hand another, as the wire would: parsed, and the chunks fetched. */
const cross = async (from, to, harness, nativeId, tamper) => {
  const bundle = RecordBundleSchema.parse(JSON.parse(JSON.stringify(from.exportSession(harness, nativeId, to.holdings(harness, nativeId)))))
  const fetched = []
  const report = await to.importSession(bundle, async function* (hashes) {
    fetched.push(...hashes)
    for (const hash of hashes) {
      const chunk = await from.readChunk(hash)
      yield { hash, chunk: tamper ? tamper(hash, chunk) : chunk }
    }
  })
  return { bundle, report, fetched }
}
try {
  // A machine's session: an append-only transcript and a row in its harness's database.
  const machine = join(root, "machine")
  const transcript = join(machine, "sessions", "s1.jsonl")
  await mkdir(join(machine, "sessions"), { recursive: true })
  await writeFile(transcript, `${JSON.stringify({ n: 1, text: "x".repeat(40_000) })}\n`)
  const database = join(machine, "state.sqlite")
  const db = new DatabaseSync(database)
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, rollout TEXT)")
  db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("s1", "First", transcript)
  db.close()
  const records = { roots: [{ name: "synthetic", path: machine }], files: [transcript], databases: [{ path: database, tables: [{ table: "threads", where: "id = ?", params: ["s1"], paths: ["rollout"] }] }] }
  const a = new RecordStore(join(root, "a"), stores)
  await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })

  // To the cloud: everything, since it holds nothing.
  const b = new RecordStore(join(root, "b"), stores)
  const first = await cross(a, b, "synthetic", "s1")
  assert.ok(first.report.versions >= 3 && first.report.chunks === first.fetched.length, JSON.stringify(first.report))
  assert.deepEqual(b.holdings("synthetic", "s1"), a.holdings("synthetic", "s1"), "it holds what the machine holds")

  // The machine goes on: only what's new crosses, and only the chunks the cloud lacks.
  await appendFile(transcript, `${JSON.stringify({ n: 2, text: "y".repeat(100) })}\n`)
  await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
  const second = await cross(a, b, "synthetic", "s1")
  assert.equal(second.report.versions, 1, "one appended version")
  assert.ok(second.fetched.length >= 1 && second.fetched.length < first.fetched.length, `only the new chunks: ${second.fetched.length}`)
  assert.deepEqual(b.exportSession("synthetic", "s1", b.holdings("synthetic", "s1")).units, [], "nothing more to send")

  // From the cloud to a laptop, in one go, and restored there natively: the same bytes, the row's path moved.
  const c = new RecordStore(join(root, "c"), stores)
  await cross(b, c, "synthetic", "s1")
  const laptop = join(root, "laptop")
  const restored = await c.restore({ harness: "synthetic", nativeId: "s1", home: laptop })
  assert.ok(restored.written && !restored.diverged.length, JSON.stringify(restored))
  assert.equal(await readFile(join(laptop, "sessions", "s1.jsonl"), "utf8"), await readFile(transcript, "utf8"), "the transcript, byte for byte")
  const back = new DatabaseSync(join(laptop, "state.sqlite"))
  assert.deepEqual({ ...back.prepare("SELECT * FROM threads").get() }, { id: "s1", title: "First", rollout: join(laptop, "sessions", "s1.jsonl") }, "the row, its path moved into the laptop's home")
  back.close()

  // A chunk that isn't what its hash names is refused, and nothing of the import is kept.
  const d = new RecordStore(join(root, "d"), stores)
  await assert.rejects(cross(a, d, "synthetic", "s1", (hash, chunk) => ({ ...chunk, body: Buffer.from(chunk.body).fill(7, 0, 1) })), /isn't the chunk its hash names|unknown codec/)
  assert.deepEqual(d.holdings("synthetic", "s1"), {}, "a refused import keeps nothing")
  // One that never comes is refused too.
  const bundle = a.exportSession("synthetic", "s1")
  await assert.rejects(d.importSession(bundle, async function* () {}), /chunks of synthetic session s1 didn't come/)

  // A session that went on in two places is never stitched together.
  await appendFile(join(laptop, "sessions", "s1.jsonl"), `${JSON.stringify({ n: 3, text: "laptop" })}\n`)
  await c.capture({ harness: "synthetic", nativeId: "s1", home: laptop, records: { ...records, roots: [{ name: "synthetic", path: laptop }], files: [join(laptop, "sessions", "s1.jsonl")], databases: [] } })
  await appendFile(transcript, `${JSON.stringify({ n: 3, text: "machine" })}\n`)
  await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
  const ahead = a.exportSession("synthetic", "s1", { ...c.holdings("synthetic", "s1"), [Object.keys(c.holdings("synthetic", "s1")).find((key) => key.endsWith("s1.jsonl"))]: 0 })
  await assert.rejects(c.importSession(ahead, async function* (hashes) { for (const hash of hashes) yield { hash, chunk: await a.readChunk(hash) } }), /went on in two places/)
  // And a version past a gap is refused: the ones between are needed first.
  const gap = a.exportSession("synthetic", "s1")
  const skipped = { ...gap, units: gap.units.map((unit) => ({ ...unit, versions: unit.versions.slice(1) })).filter((unit) => unit.versions.length) }
  const e = new RecordStore(join(root, "e"), stores)
  await assert.rejects(e.importSession(skipped, async function* () {}), /skip from version/)
  assert.equal(bundleChunks(gap.units.flatMap((unit) => unit.versions)).length, new Set(bundleChunks(gap.units.flatMap((unit) => unit.versions))).size)

  // A remote's cursors: what a push sends is only what the remote isn't known to hold, and a pull takes up where it left off.
  {
    const remote = "https://gateway.test/threads/t-1"
    const f = new RecordStore(join(root, "f"), stores)
    const g = new RecordStore(join(root, "g"), stores)
    const everything = a.exportFor(remote, "synthetic", "s1").bundle
    assert.deepEqual(everything.units, a.exportSession("synthetic", "s1").units, "a remote nothing is known of gets everything")
    await f.importSession(everything, async function* (hashes) { for (const hash of hashes) yield { hash, chunk: await a.readChunk(hash) } })
    await a.remoteHolds(remote, "synthetic", "s1", everything)
    assert.deepEqual(a.exportFor(remote, "synthetic", "s1").bundle.units, [], "once it took a bundle, nothing of it is sent again")
    await appendFile(transcript, `${JSON.stringify({ n: 4, text: "more" })}\n`)
    await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
    const more = a.exportFor(remote, "synthetic", "s1").bundle
    assert.equal(more.units.length, 1, "only the unit that moved")
    assert.equal(more.units[0].versions.length, 1, "only its new version")
    // A remote that lost what it was known to hold refuses the push for a gap; its own holdings replace what's known.
    await a.remoteHolds(remote, "synthetic", "s1", { holdings: { ...a.holdings("synthetic", "s1"), [more.units[0].key]: 0 } })
    assert.deepEqual(a.exportFor(remote, "synthetic", "s1").bundle.units.map((unit) => unit.versions.map((version) => version.seq)), [[1, 2, 3]], "after its holdings, from just past them")

    // Pulled through the remote's own number, kept with the versions in one commit.
    assert.equal(g.pulledThrough(remote, "synthetic", "s1"), 0)
    await g.importSession(everything, async function* (hashes) { for (const hash of hashes) yield { hash, chunk: await a.readChunk(hash) } }, { remote, through: 7 })
    assert.equal(g.pulledThrough(remote, "synthetic", "s1"), 7)
    assert.deepEqual(g.exportFor(remote, "synthetic", "s1").bundle.units, [], "what was pulled from a remote is never pushed back to it")
    // A pull that's refused keeps the cursor where it was.
    const h = new RecordStore(join(root, "h"), stores)
    await assert.rejects(h.importSession(skipped, async function* () {}, { remote, through: 9 }), /skip from version/)
    assert.equal(h.pulledThrough(remote, "synthetic", "s1"), 0)
    // A push's export a batch at a time, by a cursor over the units, a unit cut short taken up past what was sent.
    const fresh = "https://gateway.test/threads/t-2"
    const whole = a.exportFor(fresh, "synthetic", "s1").bundle
    const seen = []
    let cursor
    for (let batches = 0; batches < 50; batches++) {
      const page = a.exportFor(fresh, "synthetic", "s1", { limit: 2, ...(cursor === undefined ? {} : { cursor }) })
      assert.ok(page.bundle.units.flatMap((unit) => unit.versions).length <= 2, "no more than the limit")
      if (!page.bundle.units.length) break
      for (const unit of page.bundle.units) seen.push(...unit.versions.map((version) => `${unit.key}@${version.seq}`))
      await a.remoteHolds(fresh, "synthetic", "s1", page.bundle)
      if (page.cursor === null) break
      cursor = page.cursor
    }
    assert.deepEqual(seen, whole.units.flatMap((unit) => unit.versions.map((version) => `${unit.key}@${version.seq}`)), "every version once, in order")
    assert.deepEqual(a.exportFor(fresh, "synthetic", "s1").bundle.units, [])
    for (const store of [f, g, h]) store.close()
  }
  for (const store of [a, b, c, d, e]) store.close()
  console.log("PASS: a session crosses between stores as records: only what's new, chunks checked against their hashes, never stitched across a divergence or a gap, and restored natively byte for byte")
} finally {
  await rm(root, { recursive: true, force: true })
}
