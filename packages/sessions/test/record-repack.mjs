import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * A repack drops what a forgotten session left that nothing else names,
 * lays scattered quiet sessions out together, compacts and removes packs,
 * and holds every session's bytes through a crash at each of its steps and
 * through a capture that races its drop.
 */

const stores = new NativeStores(true)
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
// Text that chunks and compresses like a transcript, unique per call.
const lines = (count) => Array.from({ length: count }, () => `${JSON.stringify({ type: "assistant", text: randomBytes(48).toString("base64"), pad: "x".repeat(200) })}\n`).join("")

async function stored(store, key) {
  const parts = []
  for await (const part of store.content("fixture", key)) parts.push(part)
  return Buffer.concat(parts)
}

const root = await mkdtemp(join(tmpdir(), "mako-record-repack-"))
try {
  const home = join(root, "home")
  await mkdir(home, { recursive: true })
  const sessions = ["alpha", "beta", "gamma", "doomed"]
  const files = Object.fromEntries(sessions.map((id) => [id, join(home, `${id}.jsonl`)]))
  const capture = (store, id) => store.capture({ harness: "fixture", nativeId: id, home, records: { roots: [{ name: "fixture", path: home }], files: [files[id]], databases: [] } })
  const folder = join(root, "store")
  const store = new RecordStore(folder, stores)
  // Live sessions written a turn at a time, side by side: each one's chunks end up between the others'.
  for (const id of sessions) await writeFile(files[id], "")
  for (let round = 0; round < 12; round++)
    for (const id of sessions) {
      await appendFile(files[id], lines(250))
      await capture(store, id)
    }
  // `beta` shares its first turns with `doomed`, as a fork does.
  const shared = await readFile(files.doomed)
  await writeFile(files.beta, Buffer.concat([shared.subarray(0, 200_000), await readFile(files.beta)]))
  await capture(store, "beta")
  const expected = Object.fromEntries(["alpha", "beta", "gamma"].map((id) => [id, null]))
  for (const id of Object.keys(expected)) expected[id] = sha(await readFile(files[id]))
  // Where the chunks only `doomed` names lie, to find them overwritten once it's deleted.
  const { DatabaseSync } = await import("node:sqlite")
  const index = new DatabaseSync(join(folder, "records.sqlite"), { readOnly: true })
  const namedBy = (id) => {
    const hashes = new Set()
    for (const row of index.prepare("SELECT v.chunks FROM sessions s JOIN session_units su ON su.session = s.id JOIN versions v ON v.unit = su.unit WHERE s.native_id = ?").iterate(id))
      for (let at = 0; at < row.chunks.length; at += 32) hashes.add(Buffer.from(row.chunks.subarray(at, at + 32)).toString("hex"))
    return hashes
  }
  const others = new Set(["alpha", "beta", "gamma"].flatMap((id) => [...namedBy(id)]))
  const doomedOnly = [...namedBy("doomed")].filter((hash) => !others.has(hash)).map((hash) => index.prepare("SELECT pack, offset, stored FROM chunks WHERE hash = ?").get(Buffer.from(hash, "hex")))
  index.close()
  assert.ok(doomedOnly.length > 0)
  const forgotten = await store.forget("fixture", "doomed")
  assert.ok(forgotten.versions > 0)
  await store.close()

  // Each session's unit, read once.
  const keys = {}
  {
    const opened = new RecordStore(folder, stores)
    for (const id of Object.keys(expected)) keys[id] = opened.units("fixture", id)[0].key
    await opened.close()
  }
  async function holdsAll(at, what) {
    const opened = new RecordStore(at, stores)
    try {
      for (const [id, digest] of Object.entries(expected)) assert.equal(sha(await stored(opened, keys[id])), digest, `${what}: ${id} reads back whole`)
      assert.deepEqual(await opened.verify(), [], `${what}: every chunk reads back with its hash`)
    } finally {
      await opened.close()
    }
  }
  // A crash at each step: the store still reads, and the next repack finishes the job.
  for (const crashAt of ["copied", "placed", "switched"]) {
    const at = join(root, `crash-${crashAt}`)
    await cp(folder, at, { recursive: true })
    const crashing = new RecordStore(at, stores)
    await assert.rejects(crashing.repack({ quietMs: 0, step: (step) => { if (step === crashAt) throw new Error(`crash at ${step}`) } }), new RegExp(`crash at ${crashAt}`))
    await crashing.close()
    await holdsAll(at, `after a crash at ${crashAt}`)
    const again = new RecordStore(at, stores)
    const report = await again.repack({ quietMs: 0 })
    await again.close()
    await holdsAll(at, `after the repack that followed a crash at ${crashAt}`)
    const names = await readdir(join(at, "packs"))
    assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), [], `after a crash at ${crashAt}: no temporary copy is left`)
    if (crashAt === "copied") assert.ok(report.leftovers >= 1, "the copy a crash left is removed")
  }

  // The repack itself, measured.
  const before = (await readdir(join(folder, "packs"))).length
  const repacking = new RecordStore(folder, stores)
  const report = await repacking.repack({ quietMs: 0 })
  assert.ok(report.ran)
  assert.ok(report.dropped > 0, "the forgotten session's own chunks are dropped")
  assert.ok(report.grouped >= 3, `scattered sessions are laid out together (${report.grouped})`)
  assert.ok(report.packBytesAfter <= report.packBytesBefore, `packs don't grow (${report.packBytesBefore} → ${report.packBytesAfter} bytes)`)
  assert.equal((await repacking.repack({ quietMs: 0 })).copied, 0, "a second repack has nothing to move")
  // What the person deleted is gone from the disk, not only the index: each entry only it named is zeros where it lay, or its pack is gone.
  for (const place of doomedOnly) {
    const path = join(folder, "packs", `${String(place.pack).padStart(8, "0")}.pack`)
    const bytes = await readFile(path).catch(() => null)
    if (!bytes) continue
    const entry = bytes.subarray(place.offset - 45, place.offset + place.stored)
    assert.equal(entry.readUInt32LE(0), 0x44414544, "a deleted entry is marked dead")
    assert.ok(entry.subarray(4, 9 + 32).every((byte) => byte === 0) && entry.subarray(45).every((byte) => byte === 0), "its hash and bytes are zeros")
  }
  assert.ok(report.scrubbedBytes > 0)
  await repacking.close()
  await holdsAll(folder, "after the repack")
  console.log(`  repack: ${report.dropped} chunks dropped (${report.droppedBytes} bytes, ${report.scrubbedBytes} scrubbed in place), ${report.grouped} sessions grouped, ${report.copied} chunks copied, packs ${before} → ${(await readdir(join(folder, "packs"))).length} files, ${report.packBytesBefore} → ${report.packBytesAfter} bytes, ${report.ms} ms, the longest turn held ${report.longestTurnMs} ms`)

  // A capture that found a candidate held, then let the repack's drop in between its slices, starts over and stores it again.
  {
    const racing = new RecordStore(folder, stores)
    await writeFile(files.doomed, shared)
    await capture(racing, "doomed")
    await racing.forget("fixture", "doomed")
    // The same opening turns, then a long new tail: the capture slices after each new chunk, and the repack waits there.
    await writeFile(files.doomed, Buffer.concat([shared, Buffer.from(lines(40_000))]))
    const taking = capture(racing, "doomed")
    const dropping = racing.repack({ quietMs: 3_600_000 })
    const [took, dropped] = await Promise.allSettled([taking, dropping])
    assert.equal(dropped.status, "fulfilled")
    assert.ok(dropped.value.dropped > 0, "the drop ran while the capture was under way")
    if (took.status === "rejected") assert.match(String(took.reason), /repack dropped chunks/, "the capture that spanned the drop started over")
    await capture(racing, "doomed")
    assert.equal(sha(await stored(racing, racing.units("fixture", "doomed")[0].key)), sha(await readFile(files.doomed)), "taken again, it reads back whole")
    assert.deepEqual(await racing.verify(), [])
    console.log(`  a capture racing the drop: ${took.status === "rejected" ? "started over, then held whole" : "finished before the drop, held whole"}`)
    await racing.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("record-repack: ok")
