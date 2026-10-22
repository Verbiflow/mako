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

  // Into a home whose harness made its own database first, as a cloud machine's does as it starts: the tables it
  // holds are the same objects in other text (one a migration altered, as SQLite rewrites `ALTER TABLE`), and stay
  // as they are; the session's rows land in them.
  {
    const migrated = join(root, "migrated")
    await mkdir(migrated, { recursive: true })
    const source = new DatabaseSync(join(migrated, "store.db"))
    source.exec("CREATE TABLE project (id TEXT PRIMARY KEY)")
    source.exec("ALTER TABLE project ADD COLUMN name TEXT")
    source.exec("CREATE INDEX \"project name\" ON project(name)")
    source.exec("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT)")
    source.prepare("INSERT INTO project VALUES (?, ?)").run("p1", "mako")
    source.prepare("INSERT INTO session VALUES (?, ?)").run("s2", "p1")
    source.close()
    const own = { roots: [{ name: "synthetic", path: migrated }], files: [], databases: [{ path: join(migrated, "store.db"), tables: [{ table: "session", where: "id = ?", params: ["s2"] }, { table: "project", where: "id = ?", params: ["p1"] }] }] }
    const m = new RecordStore(join(root, "m"), stores)
    await m.capture({ harness: "synthetic", nativeId: "s2", home: migrated, records: own })
    const started = join(root, "started")
    await mkdir(started, { recursive: true })
    const made = new DatabaseSync(join(started, "store.db"))
    made.exec("CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT)")
    made.exec("CREATE INDEX [project name] ON project (name)")
    made.exec("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT)")
    const schema = () => made.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map((row) => ({ ...row }))
    const before = schema()
    const taken = await m.restore({ harness: "synthetic", nativeId: "s2", home: started })
    assert.ok(taken.written, JSON.stringify(taken))
    assert.deepEqual(schema(), before, "its own schema stands")
    assert.deepEqual({ ...made.prepare("SELECT * FROM project").get() }, { id: "p1", name: "mako" })
    assert.deepEqual({ ...made.prepare("SELECT * FROM session").get() }, { id: "s2", project_id: "p1" })
    made.close()
    m.close()
  }

  // There and back: a laptop's session goes to a machine, which writes its row naming its own home, and comes back
  // through a store that keeps the laptop's layout (as the cloud keeps a session's first). The row lands on the laptop
  // naming the laptop's file: a path is known by its root's place under whichever home wrote it.
  {
    const laptopHome = join(root, "round", "Users", "ada")
    const machineHome = join(root, "round", "home", "node")
    const rowsAt = (home) => ({ db: join(home, ".synthetic", "state.sqlite"), file: join(home, ".synthetic", "sessions", "s3.jsonl") })
    for (const home of [laptopHome, machineHome]) await mkdir(join(home, ".synthetic", "sessions"), { recursive: true })
    const at = rowsAt(laptopHome)
    await writeFile(at.file, `${JSON.stringify({ n: 1 })}\n`)
    const made = new DatabaseSync(at.db)
    made.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, rollout TEXT)")
    made.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("s3", "On the laptop", at.file)
    made.close()
    const recordsAt = (home) => ({ roots: [{ name: "synthetic", path: join(home, ".synthetic") }], files: [rowsAt(home).file], databases: [{ path: rowsAt(home).db, tables: [{ table: "threads", where: "id = ?", params: ["s3"], paths: ["rollout"] }] }] })
    const laptop = new RecordStore(join(root, "round-laptop"), stores)
    const cloud = new RecordStore(join(root, "round-cloud"), stores)
    const machine = new RecordStore(join(root, "round-machine"), stores)
    await laptop.capture({ harness: "synthetic", nativeId: "s3", home: laptopHome, records: recordsAt(laptopHome) })
    await cross(laptop, cloud, "synthetic", "s3")
    await cross(cloud, machine, "synthetic", "s3")
    assert.ok((await machine.restore({ harness: "synthetic", nativeId: "s3", home: machineHome })).written)
    const there = new DatabaseSync(rowsAt(machineHome).db)
    assert.equal(there.prepare("SELECT rollout FROM threads").get().rollout, rowsAt(machineHome).file, "on the machine, the machine's file")
    // The machine goes on: its turn appended, its row retitled, captured under its own home.
    there.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Went on in the cloud", "s3")
    there.close()
    await appendFile(rowsAt(machineHome).file, `${JSON.stringify({ n: 2 })}\n`)
    await machine.capture({ harness: "synthetic", nativeId: "s3", home: machineHome, records: recordsAt(machineHome) })
    await cross(machine, cloud, "synthetic", "s3")
    await cross(cloud, laptop, "synthetic", "s3")
    const back = await laptop.restore({ harness: "synthetic", nativeId: "s3", home: laptopHome })
    assert.ok(back.written && !back.diverged.length, JSON.stringify(back))
    const home = new DatabaseSync(at.db)
    assert.deepEqual({ ...home.prepare("SELECT * FROM threads").get() }, { id: "s3", title: "Went on in the cloud", rollout: at.file }, "back on the laptop, naming the laptop's file")
    home.close()
    assert.equal(await readFile(at.file, "utf8"), `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`, "with the machine's turn")
    for (const store of [laptop, cloud, machine]) store.close()
  }

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
