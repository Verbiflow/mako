import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { planRecordImport } from "@mako/protocol/records"
import { GatewayHttpError } from "@mako/protocol/gateway-http"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { RecordChunksRefusedError, RecordSync } from "../dist/record-sync.js"
import { LASTING_MS, ScopedUploads } from "../dist/scoped-uploads.js"

/**
 * A chunk the account refuses keeps only what needs it from the account, and says which it is. 2026-10-28 to 30, the
 * gateway's decoder failed on every chunk of exactly 40,960 bytes; each push of a Session naming one was refused
 * whole, and two Sessions' 202,198 and 342,965 other chunks stayed off the account for a day and a half, the failure
 * saying only "The pack was refused".
 */

/** The gateway's records routes in memory, refusing, as it did, any pack or push carrying a chunk of `refuses` bytes. */
class RefusingRemote {
  constructor(id, refuses) {
    Object.assign(this, { id, refuses, chunks: new Map(), units: new Map(), packs: 0, refusedPacks: 0 })
  }
  async missing(hashes) {
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  #check(pack) {
    if (pack.some((chunk) => chunk.size === this.refuses)) {
      this.refusedPacks += 1
      throw new GatewayHttpError(400, "The pack was refused", { method: "PUT", path: "/chunks", tries: 1, correlationId: `c-${this.refusedPacks}` })
    }
  }
  async putChunks(pack) {
    this.packs += 1
    this.#check(pack)
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    return { taken: pack.length }
  }
  async pushWith(bundle, pack) {
    this.#check(pack)
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    const missing = bundle.units.flatMap((unit) => unit.versions).flatMap((version) => version.chunks.match(/.{64}/g) ?? []).filter((hash) => !this.chunks.has(hash))
    if (missing.length) return { missing }
    return this.push(bundle)
  }
  async push(bundle) {
    for (const version of bundle.units.flatMap((unit) => unit.versions))
      for (const hash of version.chunks.match(/.{64}/g) ?? []) assert.ok(this.chunks.has(hash), "a version goes only once every chunk it names is there")
    const plan = planRecordImport(bundle, (key) => {
      const held = this.units.get(key)
      return held && { head: held.length - 1, version: (seq) => held[seq] }
    })
    for (const { unit, version } of plan.taking) this.units.set(unit.key, [...(this.units.get(unit.key) ?? []), version])
    return { ok: true, versions: plan.taking.length, held: plan.held, through: 0 }
  }
  async holdings() {
    return { holdings: Object.fromEntries([...this.units].map(([key, versions]) => [key, versions.length - 1])), next: null }
  }
  async readChunks() {
    return []
  }
  async pull() {
    return null
  }
  async sessions() {
    return [{ harness: "synthetic", nativeId: "s1", units: this.units.size, versions: [...this.units.values()].reduce((total, versions) => total + versions.length, 0), through: 0 }]
  }
}

const randomText = (seed, bytes) => {
  let text = ""
  for (let n = 0; text.length < bytes; n++) text += createHash("sha256").update(`${seed}:${n}`).digest("hex")
  return text.slice(0, bytes)
}

test("a chunk of exactly 40,960 bytes the account refuses holds back only its unit's versions from it on; every other chunk and unit goes, the failure names it, and it goes once the account takes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-refused-chunks-"))
  try {
    const home = join(root, "home")
    await mkdir(join(home, "sessions"), { recursive: true })
    const files = { a: join(home, "sessions", "a.jsonl"), b: join(home, "sessions", "b.jsonl"), c: join(home, "sessions", "c.jsonl") }
    await writeFile(files.a, `${randomText("a", 300_000)}\n`)
    await writeFile(files.b, `${randomText("b0", 20_000)}\n`)
    await writeFile(files.c, `${randomText("c", 200_000)}\n`)
    const records = { roots: [{ name: "synthetic", path: home }], files: Object.values(files), databases: [] }
    const store = new RecordStore(join(root, "store"), new NativeStores(false))
    const capture = () => store.capture({ harness: "synthetic", nativeId: "s1", home, records })
    await capture()
    // b's second version is one chunk of exactly 40,960 bytes, as on the Mac whose two Sessions stayed off the account;
    // its third goes on after it.
    await appendFile(files.b, "x".repeat(40_960))
    await capture()
    await appendFile(files.b, `${randomText("b2", 5_000)}\n`)
    await appendFile(files.a, `${randomText("a1", 50_000)}\n`)
    await capture()

    const remote = new RefusingRemote("gateway/o-1", 40_960)
    const sync = new RecordSync(store, remote)
    const refusal = await sync.push("synthetic", "s1").then(() => null, (error) => error)
    assert.ok(refusal instanceof RecordChunksRefusedError, `refused by name: ${refusal}`)
    assert.ok(refusal instanceof GatewayHttpError && refusal.status === 400, "a refusal, paced as one")
    assert.equal(refusal.chunks.length, 1)
    assert.equal(refusal.chunks[0].size, 40_960)
    assert.match(refusal.message, /The account refused one chunk of this Session \([0-9a-f]{12}, 40,960 bytes\) and took the rest: The pack was refused/)
    assert.match(refusal.described, /PUT \/chunks answered 400/, "with the call the gateway refused")

    const held = (key) => (remote.units.get(key)?.length ?? 0) - 1
    const heads = store.holdings("synthetic", "s1")
    const key = (name) => Object.keys(heads).find((each) => each.endsWith(name))
    assert.equal(held(key("a.jsonl")), heads[key("a.jsonl")], "a unit with no refused chunk went whole")
    assert.equal(held(key("c.jsonl")), heads[key("c.jsonl")])
    assert.equal(held(key("b.jsonl")), 0, "the refused chunk's unit went up to the version before it")
    const refusedHash = refusal.chunks[0].hash
    assert.ok(!remote.chunks.has(refusedHash))
    const named = new Set(store.exportFor("other", "synthetic", "s1").bundle.units.flatMap((unit) => unit.versions).flatMap((version) => version.chunks.match(/.{64}/g)))
    assert.deepEqual([...named].filter((hash) => !remote.chunks.has(hash)), [refusedHash], "every other chunk the session names is in the account")

    // Tried again while still refused: the chunk alone, not every pack again.
    const packsBefore = remote.packs
    await assert.rejects(sync.push("synthetic", "s1"), RecordChunksRefusedError)
    assert.equal(remote.packs - packsBefore, 1, "one pack: the refused chunk, alone")

    // The account takes it now: it goes, and b goes on from it.
    remote.refuses = -1
    const report = await sync.push("synthetic", "s1")
    assert.equal(held(key("b.jsonl")), heads[key("b.jsonl")], "b whole")
    assert.ok(remote.chunks.has(refusedHash))
    assert.ok(report.versions >= 2)
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a device's uploads say which chunk the account refused, and don't count the Session in the cloud meanwhile", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-refused-scoped-"))
  try {
    const home = join(root, "home")
    await mkdir(join(home, "sessions"), { recursive: true })
    const file = join(home, "sessions", "b.bin")
    await writeFile(file, "x".repeat(40_960))
    const records = { roots: [{ name: "synthetic", path: home }], files: [file], databases: [] }
    const store = new RecordStore(join(root, "store"), new NativeStores(false))
    await store.capture({ harness: "synthetic", nativeId: "s1", home, records })
    let now = 1_000_000
    const remote = new RefusingRemote("gateway/o-2", 40_960)
    const uploads = new ScopedUploads(store, remote, () => {}, { now: () => now })
    uploads.scope({ sessions: [{ harness: "synthetic", nativeId: "s1", path: file, thread: "t-1", busy: true, tier: "now" }], paused: false })
    await uploads.settled()
    assert.equal(uploads.status().failures.length, 0, "not said while it may heal at its next try")
    // Its retries go on refused past the time a failure lasts: said, with the chunk.
    now += LASTING_MS
    uploads.look()
    await uploads.settled()
    const [failure] = uploads.status().failures
    assert.match(failure.message, /refused one chunk of this Session \([0-9a-f]{12}, 40,960 bytes\)/)
    assert.equal(failure.kind, "refused")
    assert.equal(uploads.inCloud("synthetic", "s1"), false, "not in the cloud while it waits")
    uploads.stop()
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
