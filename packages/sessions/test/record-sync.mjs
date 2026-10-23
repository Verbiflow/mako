import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zstdDecompressSync } from "node:zlib"
import { RecordConflictError, planRecordImport } from "@mako/protocol/records"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { RECORDS_LINK_REFUSED, RecordPushes, RecordSync, RecordSyncConflictError, RecordsLinkRefusedError, linkRefused, splitBundle, withFreshLink } from "../dist/record-sync.js"

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
  // Taken from the remote, never this store's own capture: a receiver asks what it holds against what was sent, as a
  // move's machine does (`SessionCatalog.receiveRecords`), never whether it captured the session. Asking that once
  // refused every move on its first live run.
  assert.equal(laptopStore.captured("synthetic", "s1"), false, "an imported session isn't a capture here")
  assert.deepEqual(laptopStore.holdings("synthetic", "s1"), a.holdings("synthetic", "s1"), "it holds every unit at the sender's head")
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

  // A push whose link's credential lapsed (a short-lived token, a long push) goes on under a fresh link: nothing is sent
  // twice, and nothing else is retried.
  {
    const lapsing = new MemoryRemote("gateway/t-lapse", { pageVersions: 1 })
    let refusals = 1
    const links = []
    const remoteFor = (link) => ({
      ...Object.fromEntries(["missing", "putChunks", "readChunks", "push", "holdings", "pull", "sessions"].map((name) => [name, (...args) => lapsing[name](...args)])),
      id: lapsing.id,
      pushWith: async (...args) => {
        if (link.authorization === "Bearer first" && refusals-- > 0) throw new RecordsLinkRefusedError("The connection token has expired")
        return lapsing.pushWith(...args)
      },
    })
    const sent = await withFreshLink(() => {
      const link = { id: lapsing.id, base: "https://gateway.test/v1/threads/t-lapse/records", authorization: links.length ? "Bearer fresh" : "Bearer first" }
      links.push(link.authorization)
      return link
    }, (link) => new RecordSync(a, remoteFor(link)).push("synthetic", "s1"))
    assert.deepEqual(links, ["Bearer first", "Bearer fresh"], "one fresh link, after the refusal")
    assert.ok(sent.versions > 0)
    assert.deepEqual(lapsing.versions.map((entry) => `${entry.key}@${entry.version.seq}`), [...new Set(lapsing.versions.map((entry) => `${entry.key}@${entry.version.seq}`))], "nothing sent twice")
    assert.equal(lapsing.versions.length, a.exportSession("synthetic", "s1").units.flatMap((unit) => unit.versions).length, "every version, once")
    await assert.rejects(withFreshLink(() => ({ id: "x", base: "https://gateway.test", authorization: "Bearer x" }), async () => { throw new Error("the connection dropped") }), /connection dropped/, "only a refused credential is tried again")
    assert.ok(linkRefused(new Error(`${RECORDS_LINK_REFUSED}: across a catalog's process`)), "read by its message, as it crosses a process")
  }

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
  // A unit two sessions share (OpenCode's project row, a database's schema), pushed with each: the remote keeps units
  // per session, so the second session's push carries the shared unit too, rather than counting on the first's.
  {
    const home = join(root, "sharing")
    const shared = join(home, "sessions", "project.json")
    const own = (name) => join(home, "sessions", `${name}.jsonl`)
    await mkdir(join(home, "sessions"), { recursive: true })
    await writeFile(shared, "{\"project\":1}\n")
    for (const name of ["s1", "s2"]) await writeFile(own(name), line(name === "s1" ? 1 : 2, 4))
    const store = new RecordStore(join(root, "sharing-store"), stores)
    const recordsOf = (name) => ({ roots: [{ name: "synthetic", path: home }], files: [own(name), shared], databases: [] })
    for (const name of ["s1", "s2"]) await store.capture({ harness: "synthetic", nativeId: name, home, records: recordsOf(name) })
    const perSession = new MemoryRemote("gateway/t-shared")
    const sync = new RecordSync(store, perSession)
    for (const name of ["s1", "s2"]) await sync.push("synthetic", name)
    for (const name of ["s1", "s2"])
      assert.deepEqual((await perSession.holdings("synthetic", name)).holdings, store.holdings("synthetic", name), `${name}: the remote holds every unit of it, the shared one too`)

    // Two sessions pulled at once: each reads its chunks before it takes the store's turn, so neither waits on the
    // other's network. With the reads inside the turn, the second never asked until the first's read came back, and a
    // way back pulled its sessions one after another (three in 1.4 s on production, 2026-10-23).
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let bothReading
    const reading = new Promise((resolve) => { bothReading = resolve })
    const asked = new Set()
    const read = perSession.readChunks.bind(perSession)
    perSession.readChunks = async (hashes) => {
      asked.add(hashes.join(""))
      if (asked.size >= 2) bothReading()
      await gate
      return read(hashes)
    }
    const fresh = new RecordStore(join(root, "fresh-store"), stores)
    const pulls = Promise.all(["s1", "s2"].map((name) => new RecordSync(fresh, perSession).pull("synthetic", name)))
    let timer
    await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the second pull waited for the first's turn of the store to read")), 5_000) })])
    clearTimeout(timer)
    release()
    const reports = await pulls
    for (const [at, name] of ["s1", "s2"].entries()) {
      assert.deepEqual(fresh.holdings("synthetic", name), store.holdings("synthetic", name), `${name}: pulled whole`)
      assert.ok(reports[at].calls?.read?.count >= 1 && reports[at].calls?.pull?.count >= 1, `${name}: its calls are timed: ${JSON.stringify(reports[at].calls)}`)
    }
    fresh.close()
  }
  console.log("PASS: a store keeps in step with a remote: only what's new each way, a lost remote caught up, a cut push sent again, two lines of one session refused both ways, a unit two sessions share sent with each")
} finally {
  await rm(root, { recursive: true, force: true })
}
