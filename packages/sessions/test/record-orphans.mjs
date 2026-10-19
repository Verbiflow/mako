import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { once } from "node:events"
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { orphanReport } from "../dist/record-orphans.js"
import { RecordStore } from "../dist/record-store.js"
import { writeStoreFormat } from "../dist/store-format.js"

/**
 * Chunks no version names: a capture killed (SIGKILL, in a process of its
 * own) at each step of its writes leaves exactly the chunks the repack then
 * drops, and nothing else goes; a capture running in another process keeps
 * its chunks through a repack and finishes without starting over; a capture
 * that fails, or a store closed under one, ends its intent; a repack killed
 * at its own steps loses nothing; chunks no intent explains (an older
 * build's) wait out the grace; what's left restores byte for byte; and a
 * store in a newer format is read, never written.
 */

const stores = new NativeStores(true)
const child = new URL("./record-orphans-child.mjs", import.meta.url).pathname
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
// Text that chunks and compresses like a transcript, unique per call.
const lines = (count) => Array.from({ length: count }, () => `${JSON.stringify({ type: "assistant", text: randomBytes(48).toString("base64"), pad: "x".repeat(200) })}\n`).join("")
const records = (home, id) => ({ roots: [{ name: "fixture", path: home }], files: [join(home, `${id}.jsonl`)], databases: [] })
const capture = (store, home, id) => store.capture({ harness: "fixture", nativeId: id, home, records: records(home, id) })

async function stored(store, id) {
  const parts = []
  for (const unit of store.units("fixture", id)) for await (const part of store.content("fixture", unit.key)) parts.push(part)
  return Buffer.concat(parts)
}

/** Every chunk no version names, read straight from the index: the test's own count, not the store's. */
function unnamedOf(folder) {
  const db = new DatabaseSync(join(folder, "records.sqlite"), { readOnly: true })
  try {
    const named = new Set()
    for (const row of db.prepare("SELECT chunks FROM versions").iterate())
      for (let at = 0; at < row.chunks.length; at += 32) named.add(Buffer.from(row.chunks.subarray(at, at + 32)).toString("hex"))
    return db.prepare("SELECT hash, pack, offset, stored FROM chunks").all().filter((row) => !named.has(Buffer.from(row.hash).toString("hex")))
  } finally {
    db.close()
  }
}

/** The newest pack's size, and where its last indexed entry ends. */
async function newestPack(folder) {
  const names = (await readdir(join(folder, "packs"))).filter((name) => /^\d{8}\.pack$/.test(name)).sort()
  const pack = Number(names.at(-1).slice(0, 8))
  const db = new DatabaseSync(join(folder, "records.sqlite"), { readOnly: true })
  try {
    const end = db.prepare("SELECT coalesce(max(offset + stored), 0) AS n FROM chunks WHERE pack = ?").get(pack).n
    return { pack, path: join(folder, "packs", names.at(-1)), size: (await stat(join(folder, "packs", names.at(-1)))).size, end }
  } finally {
    db.close()
  }
}

function intentsOf(folder) {
  const db = new DatabaseSync(join(folder, "records.sqlite"), { readOnly: true })
  try {
    return db.prepare("SELECT * FROM intents").all()
  } finally {
    db.close()
  }
}

/** Runs the child until it reports `at <step>`; returns it there, still running. */
async function childAt(args) {
  const running = spawn(process.execPath, [child, ...args], { stdio: ["pipe", "pipe", "inherit"] })
  let out = ""
  running.stdout.setEncoding("utf8")
  const reached = new Promise((resolve, reject) => {
    running.stdout.on("data", (text) => {
      out += text
      const at = /^at (\w+)$/m.exec(out)
      if (at) resolve(at[1])
    })
    running.once("exit", (code) => reject(new Error(`the child exited (${code}) before its step: ${out}`)))
  })
  await reached
  return { process: running, output: () => out }
}

async function kill(running) {
  const exited = once(running.process, "exit")
  running.process.kill("SIGKILL")
  const [code, signal] = await exited
  assert.equal(signal, "SIGKILL", `killed, not exited (${code})`)
}

/** Whether the entry at `place` in its pack is a dead header and zeros, or its pack is gone. */
async function scrubbed(folder, place) {
  const bytes = await readFile(join(folder, "packs", `${String(place.pack).padStart(8, "0")}.pack`)).catch(() => null)
  // Its pack is gone, or the newest pack's tail it lay in was trimmed.
  if (!bytes || bytes.length < place.offset + place.stored) return true
  const entry = bytes.subarray(place.offset - 45, place.offset + place.stored)
  return entry.readUInt32LE(0) === 0x44414544 && entry.subarray(4, 4 + 32).every((byte) => byte === 0) && entry.subarray(45).every((byte) => byte === 0)
}

const root = await mkdtemp(join(tmpdir(), "mako-record-orphans-"))
const measured = []
try {
  const home = join(root, "home")
  await mkdir(home, { recursive: true })
  // Two sessions written a turn at a time, as live capture takes them; then a third, large, that a capture is killed in.
  const base = join(root, "base")
  {
    const store = new RecordStore(base, stores)
    for (const id of ["alpha", "beta"]) await writeFile(join(home, `${id}.jsonl`), "")
    for (let round = 0; round < 6; round++)
      for (const id of ["alpha", "beta"]) {
        await appendFile(join(home, `${id}.jsonl`), lines(200))
        await capture(store, home, id)
      }
    await store.close()
  }
  await writeFile(join(home, "large.jsonl"), lines(12_000))
  const expected = Object.fromEntries(await Promise.all(["alpha", "beta", "large"].map(async (id) => [id, sha(await readFile(join(home, `${id}.jsonl`)))])))
  assert.deepEqual(unnamedOf(base), [], "a store whose captures all finished has no unnamed chunk")

  async function holdsAll(folder, what, ids = ["alpha", "beta"]) {
    const store = new RecordStore(folder, stores)
    try {
      for (const id of ids) assert.equal(sha(await stored(store, id)), expected[id], `${what}: ${id} reads back whole`)
      assert.deepEqual(await store.verify(), [], `${what}: every chunk reads back with its hash`)
      // Restored into a home of its own, byte for byte.
      const elsewhere = await mkdtemp(join(root, "restored-"))
      for (const id of ids) {
        const report = await store.restore({ harness: "fixture", nativeId: id, home: elsewhere })
        assert.ok(report.written && !report.diverged.length, `${what}: ${id} restores (${JSON.stringify(report.diverged)})`)
        assert.equal(sha(await readFile(join(elsewhere, `${id}.jsonl`))), expected[id], `${what}: ${id} restores byte for byte`)
      }
    } finally {
      await store.close()
    }
  }

  // A capture killed at each step of its writes.
  for (const step of ["written", "synced", "sliced", "versioned", "stamped", "committed"]) {
    const folder = join(root, `killed-${step}`)
    await cp(base, folder, { recursive: true })
    const before = (await stat(join(folder, "packs", "00000000.pack"))).size
    const running = await childAt(["capture", folder, home, "large", step, "--kill"])
    const pid = running.process.pid
    await kill(running)
    const left = unnamedOf(folder)
    const intents = intentsOf(folder)
    // Before the first commit nothing is indexed; from the first slice until the stamp's commit, what it stored waits under its open intent.
    const committed = ["sliced", "versioned", "stamped"].includes(step)
    if (committed) {
      assert.ok(left.length > 0, `killed at ${step}: chunks were committed that no version names`)
      assert.equal(intents.length, 1, `killed at ${step}: its intent is left open`)
      assert.equal(intents[0].pid, pid)
      assert.equal(intents[0].ended, null)
    } else {
      assert.deepEqual(left, [], `killed at ${step}: no unnamed chunk is indexed`)
      assert.deepEqual(intents, [], `killed at ${step}: no intent is left`)
    }
    const grown = (await stat(join(folder, "packs", "00000000.pack"))).size
    if (step === "synced") assert.ok(grown > before, "killed at synced: the bytes are in the pack, the index never named them")
    if (step === "synced") assert.equal((await orphanReport(folder)).tail.size - (await orphanReport(folder)).tail.end, grown - before, "the readout shows the tail")
    // What the readout says, read only, before anything drops.
    const look = await orphanReport(folder, { list: 1000 })
    assert.equal(look.unnamed, left.length)
    assert.equal(look.verdicts.abandoned.chunks, left.length, `killed at ${step}: each unnamed chunk is the killed capture's, droppable`)
    if (committed) assert.match(look.intents[0].standing.reason, /lock is free|has exited/, look.intents[0].standing.reason)
    const store = new RecordStore(folder, stores)
    const report = await store.repack({ quietMs: 3_600_000 })
    await store.close()
    assert.equal(report.orphans.abandoned, left.length, `killed at ${step}: the repack drops exactly what it left`)
    assert.equal(report.dropped, left.length, `killed at ${step}: and nothing else`)
    assert.equal(report.orphans.intentsCleared, committed ? 1 : 0)
    // The newest pack ends at its last indexed entry: what a write cut short before its commit left is trimmed.
    const trimmed = await newestPack(folder)
    assert.equal(trimmed.size, trimmed.end, `killed at ${step}: the newest pack ends at its last indexed entry`)
    assert.equal(report.trim.bytes, grown - trimmed.size, `killed at ${step}: the repack reports the tail it trimmed`)
    if (step === "synced") assert.equal(trimmed.size, before, "killed at synced: trimmed back to where the store ended")
    assert.deepEqual(unnamedOf(folder), [], `killed at ${step}: no unnamed chunk is left`)
    assert.deepEqual(intentsOf(folder), [], `killed at ${step}: no intent is left`)
    for (const place of left) assert.ok(await scrubbed(folder, place), `killed at ${step}: a dropped chunk's bytes are zeros where they lay`)
    await holdsAll(folder, `killed at ${step}`)
    // Taken again, the session it was capturing is whole.
    const again = new RecordStore(folder, stores)
    await capture(again, home, "large")
    assert.equal(sha(await stored(again, "large")), expected.large, `killed at ${step}: taken again, it reads back whole`)
    await again.close()
    const second = new RecordStore(folder, stores)
    assert.equal((await second.repack({ quietMs: 3_600_000, sweep: true })).dropped, 0, `killed at ${step}: a second repack drops nothing`)
    await second.close()
    measured.push(`${step}: ${left.length} left, dropped in ${report.ms} ms`)
  }

  // A capture in another process, paused with chunks committed and unnamed, while a repack sweeps with no grace: it keeps every one, and finishes without starting over.
  {
    const folder = join(root, "running")
    await cp(base, folder, { recursive: true })
    const running = await childAt(["capture", folder, home, "large", "sliced", "--pause"])
    const left = unnamedOf(folder)
    assert.ok(left.length > 0)
    // A tail as a write cut short leaves one, at the newest pack's end.
    const { path: newest } = await newestPack(folder)
    await appendFile(newest, randomBytes(70_000))
    const look = await orphanReport(folder)
    assert.equal(look.verdicts.running.chunks, left.length, "the readout says a capture may still name them")
    assert.match(look.tail.blocked ?? "", /running/, "and that the tail waits for it")
    assert.equal(look.intents[0].standing.state, "running", look.intents[0].standing.reason)
    const store = new RecordStore(folder, stores)
    // Nothing laid out (no session is quiet for an hour), so the newest pack stays the newest.
    const report = await store.repack({ quietMs: 3_600_000, sweep: true, graceMs: 0 })
    assert.equal(report.dropped, 0, "the repack takes none of a running capture's chunks")
    assert.equal(report.orphans.running, left.length)
    assert.equal(report.trim.bytes, 0, "nothing is trimmed while a capture runs in another process")
    assert.match(report.trim.skipped ?? "", /running/)
    const kept = await newestPack(folder)
    assert.equal(kept.size - kept.end, 70_000, "the tail is all still there")
    assert.equal(unnamedOf(folder).length, left.length, "they're all still indexed")
    const done = once(running.process, "exit")
    running.process.stdin.write("go\n")
    const [code] = await done
    assert.equal(code, 0, running.output())
    assert.match(running.output(), /^done /m, "the capture finished, without starting over")
    assert.equal(sha(await stored(store, "large")), expected.large, "and reads back whole")
    assert.deepEqual(intentsOf(folder), [], "its intent went with its stamp")
    assert.deepEqual(unnamedOf(folder), [])
    const after = await store.repack({ quietMs: 3_600_000 })
    assert.equal(after.trim.skipped, null, "once it's done, nothing holds the trim")
    const ended = await newestPack(folder)
    assert.equal(ended.size, ended.end)
    await store.close()
    await holdsAll(folder, "after a repack beside a running capture", ["alpha", "beta", "large"])
  }

  // A capture that fails in this process ends its intent: what it stored goes at the next repack; one cut short by a close too.
  for (const how of ["fails", "closed"]) {
    const folder = join(root, `ended-${how}`)
    await cp(base, folder, { recursive: true })
    let store
    let written = 0
    let closing = null
    store = new RecordStore(folder, stores, {
      step: async (step) => {
        if (step === "written" && ++written % 40 === 0) void store.restamp("fixture", "nobody", "a", "b")
        if (step !== "sliced") return
        if (how === "fails") throw new Error("the harness's file went away")
        closing ??= store.close()
      },
    })
    await assert.rejects(capture(store, home, "large"), how === "fails" ? /went away/ : /closed during a capture/)
    if (how === "fails") await store.close()
    else await closing
    const [intent] = intentsOf(folder)
    assert.ok(intent?.ended, `a capture that ${how === "fails" ? "failed" : "was closed"} marks its intent ended`)
    const left = unnamedOf(folder).length
    assert.ok(left > 0)
    const look = await orphanReport(folder)
    assert.equal(look.intents[0].standing.state, "failed")
    const repacking = new RecordStore(folder, stores)
    const report = await repacking.repack({ quietMs: 3_600_000 })
    await repacking.close()
    assert.equal(report.orphans.abandoned, left, `${how}: its chunks are dropped`)
    await holdsAll(folder, `after a capture that ${how}`)
  }

  // A capture that found a killed capture's chunk held claims it: the repack that read the versions before it named the chunk leaves it.
  {
    const folder = join(root, "claimed")
    await cp(base, folder, { recursive: true })
    await kill(await childAt(["capture", folder, home, "large", "versioned", "--kill"]))
    const left = unnamedOf(folder).length
    const store = new RecordStore(folder, stores)
    await capture(store, home, "large")
    assert.deepEqual(unnamedOf(folder), [], "taken again, every chunk the killed capture stored is named")
    const report = await store.repack({ quietMs: 3_600_000 })
    assert.equal(report.dropped, 0, `the ${left} adopted chunks stay`)
    assert.deepEqual(intentsOf(folder), [], "the dead intent is cleared")
    assert.equal(sha(await stored(store, "large")), expected.large)
    await store.close()
  }

  // A repack killed at each of its steps (in a process of its own): nothing is lost, and the next one finishes the job.
  for (const step of ["dropped", "copied", "placed", "switched"]) {
    const folder = join(root, `repack-${step}`)
    await cp(base, folder, { recursive: true })
    await kill(await childAt(["capture", folder, home, "large", "versioned", "--kill"]))
    const left = unnamedOf(folder)
    await kill(await childAt(["repack", folder, step]))
    await holdsAll(folder, `after a repack killed at ${step}`)
    const store = new RecordStore(folder, stores)
    const report = await store.repack({ quietMs: 0 })
    await store.close()
    if (step !== "dropped") assert.equal(report.dropped, 0, `killed at ${step}: the drop had committed`)
    assert.deepEqual(unnamedOf(folder), [], `after a repack killed at ${step}: the next leaves no unnamed chunk`)
    assert.deepEqual((await readdir(join(folder, "packs"))).filter((name) => name.endsWith(".tmp")), [], `after a repack killed at ${step}: no temporary copy is left`)
    for (const place of left) assert.ok(await scrubbed(folder, place), `after a repack killed at ${step}: the dropped bytes are zeros or their pack is gone`)
    await holdsAll(folder, `after the repack that followed one killed at ${step}`)
  }

  // A repack killed mid-trim (its length recorded, the pack not yet cut): the pack reads whole, and the next one finishes.
  {
    const folder = join(root, "trim-killed")
    await cp(base, folder, { recursive: true })
    const before = await newestPack(folder)
    await kill(await childAt(["capture", folder, home, "large", "synced", "--kill"]))
    const grown = await newestPack(folder)
    assert.ok(grown.size > grown.end)
    await kill(await childAt(["repack", folder, "trimming", "60"]))
    assert.deepEqual(JSON.parse(await readFile(join(folder, "trim.json"), "utf8")).length, before.end, "the intended length was recorded first")
    assert.equal((await orphanReport(folder)).pendingTrim?.length, before.end, "the readout shows the trim cut short")
    await holdsAll(folder, "after a repack killed mid-trim")
    const store = new RecordStore(folder, stores)
    const report = await store.repack({ quietMs: 3_600_000 })
    await store.close()
    assert.equal(report.trim.resumed, true)
    assert.equal(report.trim.bytes, grown.size - before.end, "the next repack trims the tail")
    assert.equal((await newestPack(folder)).size, before.end)
    await assert.rejects(stat(join(folder, "trim.json")), { code: "ENOENT" }, "and removes the record")
    await holdsAll(folder, "after the repack that finished a trim")
  }

  // An intent from another namespace, which this process can't judge: its tail is never trimmed.
  {
    const folder = join(root, "trim-unknown")
    await cp(base, folder, { recursive: true })
    const { path: newest } = await newestPack(folder)
    await appendFile(newest, randomBytes(4096))
    const db = new DatabaseSync(join(folder, "records.sqlite"))
    db.prepare("INSERT INTO intents (owner, scope, pid, start, locked, session, began) VALUES ('elsewhere', 'another-container', 1, NULL, 1, 'fixture other', ?)").run(Date.now())
    db.close()
    const store = new RecordStore(folder, stores)
    const report = await store.repack({ quietMs: 3_600_000 })
    await store.close()
    assert.equal(report.trim.bytes, 0)
    assert.match(report.trim.skipped ?? "", /not provably over/, report.trim.skipped)
    assert.equal((await newestPack(folder)).size - (await newestPack(folder)).end, 4096, "an unknown intent keeps the tail")
  }

  // Chunks no intent explains (an older build's capture cut short) wait out the grace, then go; a capture that claims one first keeps it.
  {
    const folder = join(root, "older")
    await cp(base, folder, { recursive: true })
    await kill(await childAt(["capture", folder, home, "large", "versioned", "--kill"]))
    const left = unnamedOf(folder)
    {
      // As an older build leaves them: no intent at all.
      const db = new DatabaseSync(join(folder, "records.sqlite"))
      db.exec("UPDATE chunks SET intent = NULL; DELETE FROM intents")
      db.close()
    }
    const store = new RecordStore(folder, stores)
    const first = await store.repack({ quietMs: 3_600_000, sweep: true, graceMs: 60_000 })
    assert.equal(first.dropped, 0, "found unnamed, nothing drops yet")
    assert.equal(first.orphans.waiting, left.length)
    const look = await orphanReport(folder)
    assert.equal(look.verdicts.waiting.chunks, left.length, "the readout says they're waiting out the grace")
    const second = await store.repack({ quietMs: 3_600_000, sweep: true, graceMs: 0 })
    assert.equal(second.orphans.swept, left.length, "past the grace, they go")
    assert.deepEqual(unnamedOf(folder), [])
    await store.close()
    await holdsAll(folder, "after a sweep")
  }

  // A store a newer Mako raised: the readout reads it and writes nothing; capture and repack refuse.
  {
    const folder = join(root, "newer")
    await cp(base, folder, { recursive: true })
    await kill(await childAt(["capture", folder, home, "large", "versioned", "--kill"]))
    const db = new DatabaseSync(join(folder, "records.sqlite"))
    writeStoreFormat(db, "meta", { writableBy: 99, readableBy: 2 }, "99.0.0")
    db.close()
    const left = unnamedOf(folder).length
    // Every file but SQLite's shared memory, which each reader of a WAL database writes.
    const files = async () => Object.fromEntries(await Promise.all((await readdir(folder, { recursive: true })).filter((name) => !name.endsWith("-shm")).map(async (name) => [name, sha(await readFile(join(folder, name)).catch(() => Buffer.alloc(0)))])))
    const was = await files()
    const look = await orphanReport(folder)
    assert.equal(look.unnamed, left, "the readout reads a newer format's store")
    assert.deepEqual(await files(), was, "and writes nothing to it")
    const store = new RecordStore(folder, stores)
    assert.equal(store.access, "read")
    await assert.rejects(async () => store.repack(), /newer Mako.s format/)
    await assert.rejects(async () => capture(store, home, "large"), /newer Mako's format/)
    await store.close()
    assert.equal(unnamedOf(folder).length, left, "nothing was dropped from it")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
for (const line of measured) console.log(`  killed at ${line}`)
console.log("record-orphans: ok")
