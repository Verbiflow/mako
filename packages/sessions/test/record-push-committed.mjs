import assert from "node:assert/strict"
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { RecordSync, RecordSyncConflictError } from "../dist/record-sync.js"
import { currentVersions } from "@mako/protocol/records"
import { zstdDecompressSync } from "node:zlib"
import { MemoryRemote } from "./memory-remote.mjs"
import { pruneStreams } from "../dist/record-stream-prune.js"

/**
 * A push sends only versions its store has made its own: committed, and on disk. A version still in a capture's
 * transaction can roll back (the capture fails, or the store closes under it), and one committed but only in the
 * page cache goes with a forced restart; either way the account would hold a version this store then numbers again
 * with other bytes, and every later push of the session is refused as having gone on in two places. On 2026-11-18 a
 * forced restart of the Mac lost three such versions after the sync daemon had sent them: two Sessions never synced
 * again.
 */

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-record-push-committed-"))
try {
  const home = join(root, "home")
  const transcript = join(home, "sessions", "s1.jsonl")
  await mkdir(join(home, "sessions"), { recursive: true })
  await writeFile(transcript, `${JSON.stringify({ n: 0, text: "first turn ".repeat(400) })}\n`)
  const records = { roots: [{ name: "synthetic", path: home }], files: [transcript], databases: [] }

  // A capture held at its last step before it commits, its new version written in its transaction.
  let held = null
  const store = new RecordStore(join(root, "store"), stores, {
    step: (step) => {
      if (step !== "stamped" || held === null) return
      const reached = held
      held = null
      return new Promise((resolve, reject) => reached({ resolve, reject }))
    },
  })
  const capture = () => store.capture({ harness: "synthetic", nativeId: "s1", home, records })
  await capture()
  const remote = new MemoryRemote("account/device-records")
  const sync = new RecordSync(store, remote)
  await sync.push("synthetic", "s1")
  const [key] = store.units("synthetic", "s1").map((unit) => unit.key)
  assert.equal(remote.units.get(`synthetic\ns1\n${key}`)?.length, 1, "the first capture went up")

  // A turn appends; its capture is under way when a push asks for what's new, and the capture then fails.
  await appendFile(transcript, `${JSON.stringify({ n: 1, text: "a turn cut short ".repeat(50) })}\n`)
  const atStep = new Promise((resolve) => { held = resolve })
  const failing = capture()
  const paused = await atStep
  const pushing = sync.push("synthetic", "s1")
  // The push reads its batch before its first await: what it would send is settled by now.
  await new Promise((resolve) => setImmediate(resolve))
  paused.reject(new Error("the capture failed before it committed"))
  await assert.rejects(failing, /failed before it committed/)
  const during = await pushing
  assert.equal(during.versions, 0, "a version its capture hasn't committed never goes up")

  // The turn goes on; the next capture numbers its version where the failed one would have been.
  await appendFile(transcript, `${JSON.stringify({ n: 2, text: "the turn, finished ".repeat(60) })}\n`)
  await capture()
  await sync.push("synthetic", "s1")
  const kept = (bundle) => bundle.units.find((unit) => unit.key === key).versions.map((version) => [version.kind, version.chunks])
  const account = (remote.units.get(`synthetic\ns1\n${key}`) ?? []).map((version) => [version.kind, version.chunks])
  assert.deepEqual(account, kept(store.exportSession("synthetic", "s1")), "the account holds this store's versions, each as this store holds it")

  // What a push read is on disk before the account holds it: a forced restart never takes back a version sent.
  let synced = 0
  const durable = store.durable.bind(store)
  store.durable = async () => {
    await durable()
    synced += 1
  }
  const pushWith = remote.pushWith.bind(remote)
  let sentAfter = null
  remote.pushWith = async (bundle, pack) => {
    sentAfter = synced
    return pushWith(bundle, pack)
  }
  await appendFile(transcript, `${JSON.stringify({ n: 3, text: "another turn ".repeat(40) })}\n`)
  await capture()
  await sync.push("synthetic", "s1")
  assert.equal(sentAfter, 1, "the push synced the store between reading its batch and sending it")
  await store.close()

  // A store that lost versions it had sent: on 2026-11-18 a forced restart took back the newest commits of three
  // units after the sync daemon pushed them; the device's own records in the account kept them, the store numbered its
  // next captures in their place, and every push after was refused. Only this device writes there, so the unit goes on
  // from what this store holds, at once and with nothing lost; a remote others write still refuses it.
  {
    const lost = join(root, "lost")
    await mkdir(join(lost, "sessions"), { recursive: true })
    const file = join(lost, "sessions", "s2.jsonl")
    await writeFile(file, `${JSON.stringify({ n: 0, text: "the start ".repeat(300) })}\n`)
    const records2 = { roots: [{ name: "synthetic", path: lost }], files: [file], databases: [] }
    const take = (at) => at.capture({ harness: "synthetic", nativeId: "s2", home: lost, records: records2 })
    let device = new RecordStore(join(lost, "store"), stores)
    await take(device)
    const own = new MemoryRemote("account/devices/d1/originals")
    own.answersHead = true
    const others = new MemoryRemote("account/threads/t1/records")
    await new RecordSync(device, own, { soleWriter: true }).push("synthetic", "s2")
    await new RecordSync(device, others).push("synthetic", "s2")
    await device.close()
    // What the disk kept: the store as of here. The next capture is sent, then taken back with the page cache.
    await cp(join(lost, "store"), join(lost, "kept"), { recursive: true })
    device = new RecordStore(join(lost, "store"), stores)
    await appendFile(file, `${JSON.stringify({ n: 1, text: "written as the Mac hung ".repeat(30) })}\n`)
    await take(device)
    await new RecordSync(device, own, { soleWriter: true }).push("synthetic", "s2")
    await new RecordSync(device, others).push("synthetic", "s2")
    await device.close()
    await rm(join(lost, "store"), { recursive: true })
    await cp(join(lost, "kept"), join(lost, "store"), { recursive: true })
    // After the restart the harness's file holds what it kept, and goes on: the store numbers it where it lost one.
    await writeFile(file, `${JSON.stringify({ n: 0, text: "the start ".repeat(300) })}\n${JSON.stringify({ n: 1, text: "the turn, again ".repeat(25) })}\n`)
    device = new RecordStore(join(lost, "store"), stores)
    await take(device)
    const [unit] = device.units("synthetic", "s2")
    const logged = []
    const sync = new RecordSync(device, own, { soleWriter: true, log: (level, message, fields) => logged.push({ level, message, fields }) })
    const report = await sync.push("synthetic", "s2")
    assert.ok(report.versions >= 1, JSON.stringify(report))
    assert.equal(logged.length, 1, "taking the unit anew is logged once")
    assert.match(String(logged[0].fields.sides), /version 1 here: append \d+ bytes, chunks [0-9a-f]{12}; in the remote: append \d+ bytes, chunks [0-9a-f]{12}/, "both sides of where it parted")
    const bytesOf = (remote) => {
      const held = remote.versions.filter((entry) => entry.nativeId === "s2" && entry.unit.key === unit.key).map((entry) => entry.version)
      return Buffer.concat(currentVersions(held).flatMap((version) => version.chunks.match(/.{64}/g) ?? []).map((hash) => {
        const chunk = remote.chunks.get(hash)
        return chunk.codec === 1 ? zstdDecompressSync(chunk.body) : Buffer.from(chunk.body)
      }))
    }
    assert.deepEqual(bytesOf(own), await readFile(file), "the account's copy is the file as it is, byte for byte")
    // And it goes on from there: the next capture is the next version, with nothing refused.
    await appendFile(file, `${JSON.stringify({ n: 2, text: "and on ".repeat(20) })}\n`)
    await take(device)
    const next = await sync.push("synthetic", "s2")
    assert.equal(next.versions, 1)
    assert.deepEqual(bytesOf(own), await readFile(file))
    assert.equal((await new RecordSync(device, own, { soleWriter: true }).push("synthetic", "s2")).versions, 0, "nothing more to send")
    // A reopened store keeps how the account numbers the unit.
    await device.close()
    device = new RecordStore(join(lost, "store"), stores)
    await appendFile(file, `${JSON.stringify({ n: 3, text: "after a restart ".repeat(20) })}\n`)
    await take(device)
    assert.equal((await new RecordSync(device, own, { soleWriter: true }).push("synthetic", "s2")).versions, 1)
    assert.deepEqual(bytesOf(own), await readFile(file))
    // A Thread's records, which another store may write, still refuse it, and say where the two lines part.
    await assert.rejects(new RecordSync(device, others).push("synthetic", "s2"), (error) => error instanceof RecordSyncConflictError && /went on in two places: version 1 differs \(version 1 here: append/.test(error.message))
    await device.close()
  }

  // The store's own upkeep makes no version another store would be sent: a repack, a stream prune and the restamp it
  // makes, an update's migrations as the store reopens, a capture of a session that hasn't changed. Each would
  // otherwise number a version the account never needed, and a lost one went on in two places.
  {
    const upkeep = join(root, "upkeep")
    await mkdir(join(upkeep, "sessions"), { recursive: true })
    await mkdir(join(upkeep, "streams"), { recursive: true })
    const file = join(upkeep, "sessions", "s3.jsonl")
    await writeFile(file, `${JSON.stringify({ n: 0, text: "kept as it is ".repeat(400) })}\n`)
    const records3 = { roots: [{ name: "synthetic", path: upkeep }], files: [file], databases: [] }
    let kept = new RecordStore(join(upkeep, "store"), stores)
    const take = () => kept.capture({ harness: "synthetic", nativeId: "s3", home: upkeep, records: records3, stamp: "stamp-1" })
    await take()
    const account = new MemoryRemote("account/devices/d1/records")
    await new RecordSync(kept, account, { soleWriter: true }).push("synthetic", "s3")
    const nothingToSend = async (after) => {
      const page = kept.exportFor(account.id, "synthetic", "s3")
      assert.deepEqual(page?.bundle.units, [], `${after}: nothing to send`)
      assert.equal((await new RecordSync(kept, account, { soleWriter: true }).push("synthetic", "s3")).versions, 0, `${after}: nothing sent`)
    }
    await kept.repack({ quietMs: 0 })
    await nothingToSend("a repack")
    await pruneStreams(kept, join(upkeep, "streams"))
    assert.equal(await kept.restamp("synthetic", "s3", "stamp-1", "stamp-2"), true)
    await nothingToSend("a prune and its restamp")
    await kept.close()
    kept = new RecordStore(join(upkeep, "store"), stores)
    await nothingToSend("migrations as the store reopens")
    await take()
    await nothingToSend("a capture of a session unchanged")
    await kept.close()
  }
  console.log("PASS: a push sends only versions its store committed to disk; a unit the device's own records hold a lost line of goes on from this store's content; upkeep sends nothing")
} finally {
  await rm(root, { recursive: true, force: true })
}
