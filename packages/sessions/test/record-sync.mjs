import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zstdDecompressSync } from "node:zlib"
import { RecordConflictError, planRecordImport } from "@mako/protocol/records"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { RecordPushes, RecordSync, RecordSyncConflictError, splitBundle } from "../dist/record-sync.js"

/**
 * A record store kept in step with a remote one, as a machine's and a laptop's are with the gateway's: pushes send
 * only what's new and only the chunks the remote lacks, pulls ask only past their cursor, a remote that lost what it
 * was known to hold is caught up from its own holdings, records that went on in two places are refused both ways,
 * and a push cut short sends again what it didn't finish.
 */

/** The gateway's records routes, in memory, by the same rules: chunks checked against their hashes, versions numbered. */
class MemoryRemote {
  constructor(id, { pageVersions = 1_000, readChunks = 1_000 } = {}) {
    Object.assign(this, { id, pageVersions, perRead: readChunks, chunks: new Map(), units: new Map(), versions: [], failPuts: 0, calls: { put: 0, push: 0, read: 0, pull: 0 } })
  }
  async missing(hashes) {
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack) {
    this.calls.put += 1
    if (this.failPuts > 0) {
      this.failPuts -= 1
      throw new Error("the connection dropped")
    }
    for (const chunk of pack) {
      const plain = chunk.codec === 1 ? zstdDecompressSync(chunk.body) : Buffer.from(chunk.body)
      assert.equal(createHash("sha256").update(plain).digest("hex"), chunk.hash, "only checked chunks are taken")
      this.chunks.set(chunk.hash, { ...chunk, body: Uint8Array.from(chunk.body) })
    }
    return { taken: pack.length }
  }
  async readChunks(hashes) {
    this.calls.read += 1
    return hashes.filter((hash) => this.chunks.has(hash)).slice(0, this.perRead).map((hash) => this.chunks.get(hash))
  }
  async pushWith(bundle, pack) {
    this.calls.pushWith = (this.calls.pushWith ?? 0) + 1
    const named = new Set(bundle.units.flatMap((unit) => unit.versions).flatMap((version) => version.chunks.match(/.{64}/g) ?? []))
    const carried = pack.filter((chunk) => named.has(chunk.hash) && !this.chunks.has(chunk.hash))
    if (carried.length) await this.putChunks(carried)
    const missing = [...named].filter((hash) => !this.chunks.has(hash))
    if (missing.length) return { missing }
    return this.push(bundle)
  }
  #key(bundle, key) {
    return `${bundle.harness}\n${bundle.nativeId}\n${key}`
  }
  async push(bundle) {
    this.calls.push += 1
    for (const version of bundle.units.flatMap((unit) => unit.versions))
      for (let at = 0; at < version.chunks.length; at += 64) assert.ok(this.chunks.has(version.chunks.slice(at, at + 64)), "every chunk a push names came first")
    let plan
    try {
      plan = planRecordImport(bundle, (key) => {
        const unit = this.units.get(this.#key(bundle, key))
        return unit && { head: unit.versions.length - 1, version: (seq) => unit.versions[seq] }
      })
    } catch (error) {
      if (!(error instanceof RecordConflictError)) throw error
      return { ok: false, conflict: error.conflict, key: error.key, seq: error.seq, head: error.head, message: error.message }
    }
    this.layout ??= bundle.layout
    this.marks = { ...bundle.marks, ...this.marks }
    for (const { unit, version } of plan.taking) {
      const key = this.#key(bundle, unit.key)
      if (!this.units.has(key)) this.units.set(key, { unit: { ...unit, versions: [] }, versions: [] })
      this.units.get(key).versions.push(version)
      this.versions.push({ n: this.versions.length + 1, harness: bundle.harness, nativeId: bundle.nativeId, key: unit.key, version })
    }
    return { ok: true, versions: plan.taking.length, held: plan.held, through: this.versions.length }
  }
  async holdings(harness, nativeId) {
    const holdings = {}
    for (const [key, unit] of this.units) if (key.startsWith(`${harness}\n${nativeId}\n`)) holdings[key.split("\n")[2]] = unit.versions.length - 1
    return { holdings, next: null }
  }
  async pull(harness, nativeId, after) {
    this.calls.pull += 1
    const mine = this.versions.filter((entry) => entry.harness === harness && entry.nativeId === nativeId)
    if (!mine.length) return null
    const page = mine.filter((entry) => entry.n > after).slice(0, this.pageVersions)
    const units = new Map()
    for (const entry of page) {
      const unit = this.units.get(this.#key({ harness, nativeId }, entry.key)).unit
      if (!units.has(entry.key)) units.set(entry.key, { ...unit, versions: [] })
      units.get(entry.key).versions.push(entry.version)
    }
    const through = page.at(-1)?.n ?? after
    return { bundle: { harness, nativeId, layout: this.layout, marks: this.marks, units: [...units.values()] }, through, more: mine.some((entry) => entry.n > through) }
  }
  async sessions() {
    return []
  }
}

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-record-sync-"))
try {
  const machine = join(root, "machine")
  const transcript = join(machine, "sessions", "s1.jsonl")
  await mkdir(join(machine, "sessions"), { recursive: true })
  const line = (n, size) => `${JSON.stringify({ n, text: createHash("sha256").update(String(n)).digest("hex").repeat(size) })}\n`
  await writeFile(transcript, Array.from({ length: 40 }, (_, n) => line(n, 60)).join(""))
  const records = { roots: [{ name: "synthetic", path: machine }], files: [transcript], databases: [] }
  const a = new RecordStore(join(root, "a"), stores)
  await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })

  // Up: everything once, then nothing, then only what's new.
  const remote = new MemoryRemote("gateway/t-1", { pageVersions: 1, readChunks: 2 })
  const up = new RecordSync(a, remote)
  const first = await up.push("synthetic", "s1")
  assert.ok(first.versions >= 1 && first.chunks >= 2, JSON.stringify(first))
  const { ms: _ms, ...idle } = await up.push("synthetic", "s1")
  assert.deepEqual(idle, { versions: 0, held: 0, chunks: 0, bytes: 0, requests: 0 }, "nothing new, nothing asked")
  await appendFile(transcript, line(100, 2))
  await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
  const second = await up.push("synthetic", "s1")
  assert.equal(second.versions, 1)
  assert.ok(second.chunks >= 1 && second.chunks < first.chunks, `only the new chunks: ${second.chunks} of ${first.chunks}`)
  assert.equal(second.requests, 1, "a turn's worth goes in one request, its chunks with it")

  // Down, to a laptop, a page at a time and in several asks for chunks, then restored natively.
  const laptopStore = new RecordStore(join(root, "laptop-store"), stores)
  const down = new RecordSync(laptopStore, remote)
  const pulled = await down.pull("synthetic", "s1")
  assert.equal(pulled.versions, first.versions + second.versions)
  assert.ok(remote.calls.pull >= 2 && remote.calls.read >= 2, JSON.stringify(remote.calls))
  const laptop = join(root, "laptop")
  assert.equal((await laptopStore.restore({ harness: "synthetic", nativeId: "s1", home: laptop })).written, true)
  assert.equal(await readFile(join(laptop, "sessions", "s1.jsonl"), "utf8"), await readFile(transcript, "utf8"), "byte for byte")
  assert.equal((await down.pull("synthetic", "s1")).versions, 0, "past its cursor, nothing")
  assert.equal((await down.push("synthetic", "s1")).versions, 0, "what came from the remote never goes back to it")

  // The remote lost what it held: the next push is refused for a gap, caught up from its holdings, and sent whole.
  const reset = new MemoryRemote("gateway/t-1")
  const again = new RecordSync(a, reset)
  await appendFile(transcript, line(101, 2))
  await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
  const recovered = await again.push("synthetic", "s1")
  assert.equal(recovered.versions, first.versions + second.versions + 1, "everything, after its holdings said it had nothing")
  assert.equal(reset.versions.length, recovered.versions)

  // A push cut short in its chunks sends again what it didn't finish; nothing counts as held until it's taken.
  const flaky = new MemoryRemote("gateway/t-2")
  flaky.failPuts = 1
  const cut = new RecordSync(a, flaky)
  await assert.rejects(cut.push("synthetic", "s1"), /connection dropped/)
  assert.equal(flaky.versions.length, 0)
  assert.ok((await cut.push("synthetic", "s1")).versions > 0, "sent whole the next time")

  // Records that went on in two places: the laptop's own line is refused going up, and the machine's coming down.
  await appendFile(join(laptop, "sessions", "s1.jsonl"), line(200, 2))
  await laptopStore.capture({ harness: "synthetic", nativeId: "s1", home: laptop, records: { roots: [{ name: "synthetic", path: laptop }], files: [join(laptop, "sessions", "s1.jsonl")], databases: [] } })
  await appendFile(transcript, line(102, 2))
  await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
  await up.push("synthetic", "s1")
  await assert.rejects(down.push("synthetic", "s1"), (error) => error instanceof RecordSyncConflictError && /went on in two places/.test(error.message))
  await assert.rejects(down.pull("synthetic", "s1"), (error) => error instanceof RecordSyncConflictError && error.harness === "synthetic")

  // Captures pushed as they land: one push at a time, a capture meanwhile pushed after; a failure tried again later.
  {
    const lines = []
    const live = new MemoryRemote("gateway/t-3")
    const pushes = new RecordPushes(a, live, (level, message, fields) => lines.push({ level, message, ...fields }))
    await pushes.catchUp([{ harness: "synthetic", nativeId: "s1" }])
    assert.equal(pushes.status().versions, live.versions.length)
    assert.ok(live.versions.length > 0, "what was captured before the remote was given")
    live.failPuts = 1
    await appendFile(transcript, line(300, 2))
    await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
    pushes.captured("synthetic", "s1")
    pushes.captured("synthetic", "s1")
    await pushes.settled()
    assert.equal(pushes.status().failures, 1)
    assert.ok(lines.some((entry) => entry.message === "records push failed" && entry.error === "the connection dropped"), JSON.stringify(lines))
    // The next capture tries at once, without waiting out the retry.
    await appendFile(transcript, line(301, 2))
    await a.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
    pushes.captured("synthetic", "s1")
    await pushes.settled()
    assert.deepEqual(live.versions.map((entry) => entry.version.seq).slice(-2), [live.versions.length - 2, live.versions.length - 1], "both new versions, in order")
    assert.equal(pushes.status().waiting, 0)
    pushes.stop()
  }

  // A long session's export is pushed in parts, each unit's versions in order.
  const parts = splitBundle({ harness: "x", nativeId: "y", layout: { home: "/", roots: {}, paths: {} }, marks: {}, units: [{ key: "k", role: "file", path: null, places: null, versions: Array.from({ length: 25_000 }, (_, seq) => ({ seq, kind: "append", at: 0, size: 1, digest: null, tail: null, chunks: "", detail: null, writer: null, writerSource: null })) }] })
  assert.deepEqual(parts.map((part) => part.units[0].versions.map((version) => version.seq).filter((_, at, all) => at === 0 || at === all.length - 1)), [[0, 9999], [10000, 19999], [20000, 24999]])

  for (const store of [a, laptopStore]) store.close()
  console.log("PASS: a store keeps in step with a remote: only what's new each way, a lost remote caught up, a cut push sent again, two lines of one session refused both ways")
} finally {
  await rm(root, { recursive: true, force: true })
}
