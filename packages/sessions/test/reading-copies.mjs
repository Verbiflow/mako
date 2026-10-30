import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { planRecordImport, RecordConflictError } from "@mako/protocol/records"
import { copyFile, CopyHeaderSchema, ReadingCopies, ReceivedCopies } from "../dist/reading-copies.js"

/**
 * A device's reading copies: each Session in scope written as Mako draws it (a header line, then an entry a line) when
 * it changed and its turn came, the ones at work first and more often, captured and pushed so only what changed goes
 * up; waiting on a low battery but for Sessions at work; and after a restart, nothing copied again that hasn't changed.
 */

/** The gateway's records routes in memory: chunks kept once by hash, versions taken by the protocol's rule. */
class MemoryRemote {
  constructor(id) {
    Object.assign(this, { id, chunks: new Map(), units: new Map(), versions: [], bytes: 0, pushed: [] })
  }
  async missing(hashes) {
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack) {
    for (const chunk of pack) this.#keep(chunk)
    return { taken: pack.length }
  }
  async readChunks(hashes) {
    return hashes.flatMap((hash) => this.chunks.get(hash) ?? [])
  }
  async push(bundle) {
    return this.#take(bundle)
  }
  async pushWith(bundle, pack) {
    for (const chunk of pack) this.#keep(chunk)
    return this.#take(bundle)
  }
  async holdings() {
    return { holdings: {}, next: null }
  }
  async pull(harness, nativeId, after) {
    const mine = this.versions.filter((entry) => entry.harness === harness && entry.nativeId === nativeId)
    if (!mine.length) return null
    const page = mine.filter((entry) => entry.n > after)
    const units = new Map()
    for (const entry of page) {
      if (!units.has(entry.unit.key)) units.set(entry.unit.key, { ...entry.unit, versions: [] })
      units.get(entry.unit.key).versions.push(entry.version)
    }
    return { bundle: { harness, nativeId, layout: this.layout, marks: {}, units: [...units.values()] }, through: page.at(-1)?.n ?? after, more: false }
  }
  async sessions() {
    const sessions = new Map()
    for (const [key, versions] of this.units) {
      const [harness, nativeId] = key.split("\n")
      const session = sessions.get(`${harness}\n${nativeId}`) ?? { harness, nativeId, units: 0, versions: 0, through: 0 }
      session.units += 1
      session.versions += versions.length
      sessions.set(`${harness}\n${nativeId}`, session)
    }
    return [...sessions.values()]
  }
  #keep(chunk) {
    if (this.chunks.has(chunk.hash)) return
    this.chunks.set(chunk.hash, chunk)
    this.bytes += chunk.body.length
  }
  #take(bundle) {
    const key = (unit) => `${bundle.harness}\n${bundle.nativeId}\n${unit}`
    try {
      const plan = planRecordImport(bundle, (unit) => {
        const held = this.units.get(key(unit))
        return held && { head: held.length - 1, version: (seq) => held[seq] }
      })
      this.layout ??= bundle.layout
      for (const { unit, version } of plan.taking) {
        const held = this.units.get(key(unit.key)) ?? []
        held.push({ kind: version.kind, chunks: version.chunks })
        this.units.set(key(unit.key), held)
        this.versions.push({ n: this.versions.length + 1, harness: bundle.harness, nativeId: bundle.nativeId, unit: { ...unit, versions: [] }, version })
      }
      if (plan.taking.length) this.pushed.push(bundle.nativeId)
      return { ok: true, versions: plan.taking.length, held: plan.held, through: 0 }
    } catch (error) {
      if (!(error instanceof RecordConflictError)) throw error
      return { ok: false, conflict: error.conflict, key: error.key, seq: error.seq, head: error.head, message: error.message }
    }
  }
}

/** A Session's view as the catalog serves it: entries by index, the decoder build that drew them. */
function sessionView(nativeId, entries) {
  return {
    view: { total: entries.length, translator: "t-1", json: async (start, end) => entries.slice(start, end).map((entry) => Buffer.from(JSON.stringify(entry))) },
    ref: { harness: "claude", nativeId, path: `/rail/${nativeId}.jsonl`, title: `Session ${nativeId}`, cwd: "/Users/ana/api" },
  }
}
/** An answer of its own, about 4 KB that doesn't compress to nothing, as a real one doesn't. */
const turn = (n) => ({ id: `e-${n}`, type: "text", text: Array.from({ length: 64 }, (_, part) => createHash("sha256").update(`${n}:${part}`).digest("hex")).join(" ") })

test("reading copies go up as Mako draws each Session, the ones at work first and more often, only what changed, and nothing again after a restart", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mako-reading-copies-"))
  try {
    const sessions = { busy: Array.from({ length: 40 }, (_, n) => turn(n)), rest: [turn(100), turn(101)] }
    const stamps = { busy: "n:1", rest: "n:1" }
    const drawn = []
    const views = {
      view: async (path) => {
        const name = path.includes("busy") ? "busy" : "rest"
        drawn.push(name)
        return sessionView(name, sessions[name])
      },
      stamp: (path) => stamps[path.includes("busy") ? "busy" : "rest"],
      translator: () => "t-1",
    }
    let now = 1_000_000
    const remote = new MemoryRemote("gateway/d-1")
    const open = () => new ReadingCopies(folder, views, () => {}, { now: () => now, remote: () => remote })
    const scope = (paused = false) => ({
      sessions: [
        { harness: "claude", nativeId: "busy", path: "/rail/busy.jsonl", thread: "t-busy", busy: true, tier: "now" },
        { harness: "claude", nativeId: "rest", path: "/rail/rest.jsonl", thread: "t-rest", busy: false, tier: "week" },
      ],
      paused,
    })
    const link = { id: "d-1", base: "https://cloud.test/v1/devices/d-1/records", authorization: "Bearer a" }

    const copies = open()
    copies.scope(scope())
    copies.link(link)
    await copies.settled()
    assert.deepEqual(remote.pushed, ["busy", "rest"], "the one at work first")
    assert.deepEqual(scope().sessions.map((session) => copies.readable(session)), [true, true], "both readable in the account")
    const lines = (await readFile(copyFile(folder, "claude", "busy"), "utf8")).trimEnd().split("\n")
    const header = CopyHeaderSchema.parse(JSON.parse(lines[0]))
    assert.deepEqual([header.nativeId, header.total, header.title, header.translator], ["busy", 40, "Session busy", "t-1"])
    assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line).id), sessions.busy.map((entry) => entry.id), "then an entry a line, in order")
    const chunksBefore = remote.chunks.size

    // A turn at work: copied again once a second has gone, and only its new chunks go up.
    sessions.busy.push(turn(40))
    stamps.busy = "n:2"
    now += 999
    copies.scope(scope())
    await copies.settled()
    assert.equal(remote.pushed.length, 2, "not within a second of the last")
    assert.deepEqual([copies.readable(scope().sessions[0]), copies.current(scope().sessions[0])], [false, false], "changed since its copy: not readable as it is, until its turn")
    now += 1
    copies.scope(scope())
    await copies.settled()
    assert.deepEqual(remote.pushed.slice(2), ["busy"])
    assert.ok(remote.chunks.size - chunksBefore <= 3, `a turn sends the chunks that changed (its header's, its end's): ${remote.chunks.size - chunksBefore} of ${chunksBefore}`)

    // At rest it waits a minute; on a low battery it waits until there's more, while a Session at work still goes.
    sessions.rest.push(turn(102))
    stamps.rest = "n:2"
    sessions.busy.push(turn(41))
    stamps.busy = "n:3"
    now += 10_000
    copies.scope(scope(true))
    await copies.settled()
    assert.deepEqual(remote.pushed.slice(3), ["busy"], "waiting: only the one at work")
    now += 60_000
    copies.scope(scope(false))
    await copies.settled()
    assert.deepEqual(remote.pushed.slice(4), ["rest"])
    copies.stop()

    // A restart: what was copied is read from the copies themselves, and nothing unchanged is drawn or sent again.
    const before = drawn.length
    const again = open()
    again.scope(scope())
    again.link(link)
    await again.settled()
    assert.equal(drawn.length, before, "nothing drawn again")
    assert.equal(remote.pushed.length, 5, "nothing sent again")
    again.stop()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("a capture is looked at alone and at once; captures while a look is under way are one look after it, never a look over the whole scope; and a copy waits by its size whatever its tier", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mako-reading-copies-captured-"))
  try {
    const names = ["a", "b", "c"]
    const sessions = Object.fromEntries(names.map((name) => [name, [turn(`${name}-1`)]]))
    const stamps = Object.fromEntries(names.map((name) => [name, "n:1"]))
    const drawn = []
    let drawing = 0
    let mostAtOnce = 0
    let hold
    const views = {
      view: async (path) => {
        const name = path.slice("/rail/".length, -".jsonl".length)
        drawing += 1
        mostAtOnce = Math.max(mostAtOnce, drawing)
        drawn.push(name)
        if (hold) await hold.promise
        drawing -= 1
        return sessionView(name, sessions[name])
      },
      stamp: (path) => stamps[path.slice("/rail/".length, -".jsonl".length)],
      translator: () => "t-1",
    }
    let now = 3_000_000
    const remote = new MemoryRemote("gateway/d-1")
    const copies = new ReadingCopies(folder, views, () => {}, { now: () => now, remote: () => remote })
    const scope = { sessions: names.map((name) => ({ harness: "claude", nativeId: name, path: `/rail/${name}.jsonl`, thread: `t-${name}`, busy: true, tier: "now" })), paused: false }
    copies.scope(scope)
    copies.link({ id: "d-1", base: "https://cloud.test/v1/devices/d-1/records", authorization: "Bearer a" })
    await copies.settled()
    assert.deepEqual(drawn.splice(0), ["a", "b", "c"])

    // Each changed; "a" is captured, and its look is held while "b" is captured three times and a Session out of scope once.
    now += 3_000
    for (const name of names) {
      sessions[name].push(turn(`${name}-2`))
      stamps[name] = "n:2"
    }
    hold = Promise.withResolvers()
    copies.changed("claude", "a")
    for (let waited = 0; drawn.length === 0 && waited < 200; waited++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(drawn, ["a"], "a capture is looked at alone, at once")
    for (let n = 0; n < 3; n++) copies.changed("claude", "b")
    copies.changed("claude", "not-in-scope")
    copies.changed("codex", "a")
    assert.deepEqual(drawn, ["a"], "nothing more while that look runs")
    hold.resolve()
    hold = undefined
    await copies.settled()
    assert.deepEqual(drawn.splice(0), ["a", "b"], "then the captured one, once; the uncaptured \"c\" waits for the look over the scope")
    assert.equal(mostAtOnce, 1, "one look at a time")

    // A large copy waits by its size at rest too: one of 800 MiB waits 80 s since it went, not the minute a small one
    // at rest does. Read after a restart from the copy itself, as its size on disk.
    copies.stop()
    const file = copyFile(folder, "claude", "c")
    const header = CopyHeaderSchema.parse(JSON.parse((await readFile(file, "utf8")).split("\n")[0]))
    await truncate(file, 800 * 1024 * 1024)
    const atRest = { sessions: [{ harness: "claude", nativeId: "c", path: "/rail/c.jsonl", thread: "t-c", busy: false, tier: "week" }], paused: false }
    const later = new ReadingCopies(folder, views, () => {}, { now: () => now, remote: () => remote })
    now = header.at + 61_000
    later.scope(atRest)
    later.link({ id: "d-1", base: "https://cloud.test/v1/devices/d-1/records", authorization: "Bearer a" })
    await later.settled()
    assert.deepEqual(drawn, [], "a minute isn't enough for a copy this size")
    now = header.at + 80_001
    later.scope({ ...atRest })
    await later.settled()
    assert.deepEqual(drawn.splice(0), ["c"], "its size's wait is")
    later.stop()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("a Session changed before its turn goes when its turn comes, unasked; a large copy is written a slice at a time, and one whose view closed under it waits for the next look", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mako-reading-copies-turn-"))
  try {
    const entries = Array.from({ length: 600 }, (_, n) => turn(n))
    let stamp = "n:1"
    let closeAfter = Infinity
    let slices = 0
    const views = {
      view: async () => ({
        view: {
          total: entries.length,
          translator: "t-1",
          json: async (start, end) => {
            if (slices++ >= closeAfter) throw new Error("database is not open")
            return entries.slice(start, end).map((entry) => Buffer.from(JSON.stringify(entry)))
          },
        },
        ref: { harness: "claude", nativeId: "big", path: "/rail/big.jsonl", title: "Big" },
      }),
      stamp: () => stamp,
      translator: () => "t-1",
    }
    let now = 5_000_000
    const remote = new MemoryRemote("gateway/d-1")
    const logged = []
    const copies = new ReadingCopies(folder, views, (level, message) => logged.push(message), { now: () => now, remote: () => remote })
    const scope = { sessions: [{ harness: "claude", nativeId: "big", path: "/rail/big.jsonl", thread: "t-big", busy: true, tier: "now" }], paused: false }
    copies.scope(scope)
    copies.link({ id: "d-1", base: "https://cloud.test/v1/devices/d-1/records", authorization: "Bearer a" })
    await copies.settled()
    assert.deepEqual(remote.pushed, ["big"])
    assert.ok(slices >= 9, `written a slice at a time: ${slices} slices of 600 entries`)

    // A turn lands half a second after the copy: it isn't copied then, and goes once its second has come, with
    // nothing else asking.
    entries.push(turn(600))
    stamp = "n:2"
    now += 500
    copies.changed("claude", "big")
    await copies.settled()
    assert.deepEqual(remote.pushed, ["big"], "not before its turn")
    now += 500
    for (let waited = 0; remote.pushed.length < 2 && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 10))
    await copies.settled()
    assert.deepEqual(remote.pushed, ["big", "big"], "once its turn came, unasked")

    // The view is written again under a copy: that copy is left, its file untouched, and the next look writes it.
    entries.push(turn(601))
    stamp = "n:3"
    now += 2_000
    slices = 0
    closeAfter = 1
    copies.changed("claude", "big")
    await copies.settled()
    assert.deepEqual(remote.pushed, ["big", "big"], "nothing went from a copy cut short")
    assert.ok(logged.includes("a copy was left for the next look"))
    const kept = (await readFile(copyFile(folder, "claude", "big"), "utf8")).trimEnd().split("\n")
    assert.equal(kept.length, 1 + 601, "the last whole copy stands")
    closeAfter = Infinity
    copies.changed("claude", "big")
    await copies.settled()
    assert.deepEqual(remote.pushed, ["big", "big", "big"])
    copies.stop()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("another device reads a copy as it stands: the newest version, a page at a time, read again once it's had a while, and nothing for a Session with none", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mako-received-copies-"))
  try {
    const entries = Array.from({ length: 250 }, (_, n) => turn(n))
    let stamp = "n:1"
    const views = { view: async () => sessionView("s-1", entries), stamp: () => stamp, translator: () => "t-1" }
    let ownerNow = 2_000_000
    let now = 2_000_000
    const remote = new MemoryRemote("gateway/d-studio")
    const owner = new ReadingCopies(join(folder, "studio"), views, () => {}, { now: () => ownerNow, remote: () => remote })
    const scope = { sessions: [{ harness: "claude", nativeId: "s-1", path: "/rail/s-1.jsonl", thread: "t-1", busy: true, tier: "now" }], paused: false }
    const link = { id: "https://cloud.test/v1/devices/studio/records", base: "https://cloud.test/v1/devices/studio/records", authorization: "Bearer b" }
    owner.scope(scope)
    owner.link(link)
    await owner.settled()

    let pulls = 0
    const counted = new Proxy(remote, { get: (target, name) => (name === "pull" ? (...args) => (pulls++, target.pull(...args)) : typeof target[name] === "function" ? target[name].bind(target) : target[name]) })
    const reader = new ReceivedCopies(join(folder, "laptop"), { now: () => now, remote: () => counted })
    const newest = await reader.page(link, "claude", "s-1", undefined, 100)
    assert.deepEqual([newest.start, newest.total, newest.entries.length, newest.header.title], [150, 250, 100, "Session s-1"])
    assert.deepEqual(newest.entries.map((entry) => entry.id), entries.slice(150).map((entry) => entry.id), "the newest page, whole entries in order")
    const earlier = await reader.page(link, "claude", "s-1", newest.start, 100)
    assert.deepEqual([earlier.start, earlier.entries[0].id], [50, "e-50"], "then the page before it")
    assert.equal(pulls, 1, "paging back reads it once")
    assert.equal((await reader.entry(link, "claude", "s-1", "e-7"))?.id, "e-7")

    // The owner's next turn: read once the last read has had 10 s.
    entries.push(turn(250))
    stamp = "n:2"
    ownerNow += 10_000
    owner.scope(scope)
    await owner.settled()
    assert.deepEqual(remote.versions.map((each) => each.version.kind), ["replace", "replace"], "a copy is taken whole each time, never as an append")
    now += 9_000
    assert.equal((await reader.page(link, "claude", "s-1", undefined, 10)).total, 250, "within 10 s of the last read: as it was")
    now += 1_000
    assert.equal((await reader.page(link, "claude", "s-1", undefined, 10)).total, 251, "then the newest")
    assert.equal(await reader.page(link, "claude", "nobody", undefined, 10), null)
    owner.stop()
    reader.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
