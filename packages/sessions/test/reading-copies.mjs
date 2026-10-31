import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { versionChunks } from "@mako/protocol/records"
import { copyFile, CopyHeaderSchema, parseCopy, ReadingCopies, ReceivedCopies } from "../dist/reading-copies.js"
import { CopyReader, MemoryCopyStore } from "../dist/copy-reader.js"
import { ZstdFrames } from "../dist/zstd-frames.js"
import { MemoryRemote } from "./memory-remote.mjs"

/**
 * A device's reading copies: each Session in scope written as Mako draws it (a header line, then an entry a line) when
 * it changed and its turn came, the ones at work first and more often, captured and pushed so only what changed goes
 * up; waiting on a low battery but for Sessions at work; and after a restart, nothing copied again that hasn't changed.
 */

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

/** A remote counting what it's asked, and failing every call once it's `down` (the account out of reach). */
function watched(remote) {
  const asked = { head: 0, pull: 0, readChunks: 0, hashes: 0, down: false, corrupt: false }
  const proxy = new Proxy(remote, {
    get: (target, name) => {
      if (typeof target[name] !== "function") return target[name]
      return async (...args) => {
        if (asked.down) throw new Error("offline")
        if (name in asked) asked[name]++
        if (name === "readChunks") asked.hashes += args[0].length
        const answer = await target[name](...args)
        if (name === "readChunks" && asked.corrupt) return answer.map((chunk) => ({ ...chunk, codec: 0, body: Buffer.from("not this chunk") }))
        return answer
      }
    },
  })
  return { proxy, asked }
}

test("every device reads a copy the same way: its current versions at once, the newest page from a few chunks at the end, earlier pages and entries by ID as asked, and what it read kept for when the account's out of reach", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mako-copy-reader-"))
  const frames = new ZstdFrames()
  try {
    // About 4 MB of copy: far more chunks than its newest page needs.
    const entries = Array.from({ length: 1000 }, (_, n) => turn(n))
    let stamp = "n:1"
    let now = 3_000_000
    const remote = new MemoryRemote("gateway/d-studio")
    remote.answersHead = true
    const owner = new ReadingCopies(join(folder, "studio"), { view: async () => sessionView("s-1", entries), stamp: () => stamp, translator: () => "t-1" }, () => {}, { now: () => now, remote: () => remote })
    const scope = { sessions: [{ harness: "claude", nativeId: "s-1", path: "/rail/s-1.jsonl", thread: "t-1", busy: true, tier: "now" }], paused: false }
    owner.scope(scope)
    owner.link({ id: "d-studio", base: "https://cloud.test/v1/devices/d-studio/records", authorization: "Bearer b" })
    await owner.settled()
    const whole = parseCopy(await readFile(copyFile(join(folder, "studio"), "claude", "s-1"), "utf8"))

    const store = new MemoryCopyStore()
    const logged = []
    const { proxy, asked } = watched(remote)
    const reader = () => new CopyReader({ remote: () => proxy, store, decode: (frame) => frames.decompress(frame), now: () => now, log: (level, message, fields) => logged.push({ level, message, ...fields }) })
    const phone = reader()
    const copy = await phone.open("d-studio", "claude", "s-1")
    assert.ok(copy.chunkCount > 4 * copy.tailChunks - 1, `a copy of many chunks (${copy.chunkCount})`)
    const newest = await copy.page(undefined, 80)
    assert.deepEqual([newest.start, newest.total, newest.header.title], [920, 1000, "Session s-1"])
    assert.deepEqual(newest.entries, whole.entries.slice(920), "the newest page, as the whole copy has it")
    assert.deepEqual([asked.head, asked.pull], [1, 0], "its current versions in one answer, no versions pulled")
    assert.ok(asked.hashes <= copy.tailChunks + 1, `the newest page from its last chunks and its header's (${asked.hashes} of ${copy.chunkCount})`)
    assert.equal(copy.whole, false)

    // Once drawn, the rest filled in from the end back: paging back then reads nothing more.
    await copy.fill()
    assert.equal(copy.whole, true)
    const filled = asked.hashes
    let before = newest.start
    const paged = [...newest.entries]
    while (before > 0) {
      const page = await copy.page(before, 80)
      paged.unshift(...page.entries)
      before = page.start
    }
    assert.deepEqual(paged, whole.entries, "paging back reaches the first entry, every entry once and in order")
    assert.ok(filled <= copy.chunkCount, `every chunk asked once (${filled} of ${copy.chunkCount})`)
    assert.equal(asked.hashes, filled)
    assert.deepEqual(await copy.entry("e-3"), whole.entries[3])
    assert.equal(await copy.entry("e-nobody"), null)
    assert.deepEqual(phone.reads().at(-1), { ...phone.reads().at(-1), via: "head", size: copy.manifest.size }, "the read, said")

    // Within 10 s: the same copy, nothing asked; then its current versions again, the same chunks: nothing fetched.
    const hashes = asked.hashes
    assert.equal(await phone.open("d-studio", "claude", "s-1"), copy)
    now += 10_000
    assert.equal(await phone.open("d-studio", "claude", "s-1"), copy, "unchanged, the copy already held")
    assert.deepEqual([asked.head, asked.hashes], [2, hashes])

    // Its next turn: a new version, read from the chunks it doesn't have yet.
    entries.push(turn(1000))
    stamp = "n:2"
    now += 10_000
    owner.scope(scope)
    await owner.settled()
    const next = await phone.open("d-studio", "claude", "s-1")
    assert.notEqual(next, copy)
    assert.equal((await next.page(undefined, 1)).entries[0].id, "e-1000")
    assert.equal(copy.total, 1000, "the version paged through stays as it was")

    // The account out of reach: a reader that's never read it opens what this one kept, as it was last read.
    asked.down = true
    const offline = await reader().open("d-studio", "claude", "s-1")
    assert.equal((await offline.page(undefined, 1)).entries[0].id, "e-1000")
    assert.equal(offline.manifest.through, next.manifest.through)
    asked.down = false

    // A chunk that isn't what its hash says is refused, never kept or drawn.
    const untouched = new MemoryCopyStore()
    const fresh = new CopyReader({ remote: () => proxy, store: untouched, decode: (frame) => frames.decompress(frame), now: () => now })
    asked.corrupt = true
    await assert.rejects(fresh.open("d-studio", "claude", "s-1"), /isn't the one its hash names/)
    assert.deepEqual([(await untouched.manifests()).length, (await untouched.chunks(versionChunks(next.manifest))).size], [0, 0], "nothing of it kept")
    asked.corrupt = false
    assert.equal((await (await fresh.open("d-studio", "claude", "s-1")).page(undefined, 1)).entries[0].id, "e-1000", "and read again once the account answers right")
    assert.equal(await phone.open("d-studio", "claude", "nobody"), null, "a Session with no copy: none")
    owner.stop()
  } finally {
    frames.close()
    await rm(folder, { recursive: true, force: true })
  }
})

test("where a reader can say a copy changed, one it kept opens at once from its own storage, nothing asked first, and the account's newer one is said after", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mako-copy-reader-kept-"))
  const frames = new ZstdFrames()
  try {
    const entries = Array.from({ length: 200 }, (_, n) => turn(n))
    let stamp = "n:1"
    let now = 5_000_000
    const remote = new MemoryRemote("gateway/d-studio")
    remote.answersHead = true
    const owner = new ReadingCopies(join(folder, "studio"), { view: async () => sessionView("s-1", entries), stamp: () => stamp, translator: () => "t-1" }, () => {}, { now: () => now, remote: () => remote })
    const scope = { sessions: [{ harness: "claude", nativeId: "s-1", path: "/rail/s-1.jsonl", thread: "t-1", busy: true, tier: "now" }], paused: false }
    owner.scope(scope)
    owner.link({ id: "d-studio", base: "https://cloud.test/v1/devices/d-studio/records", authorization: "Bearer b" })
    await owner.settled()

    const store = new MemoryCopyStore()
    const { proxy, asked } = watched(remote)
    const changed = []
    const reader = () => new CopyReader({ remote: () => proxy, store, decode: (frame) => frames.decompress(frame), now: () => now, changed: (...named) => changed.push(named) })
    // Read once, and filled: what a page that opened it before keeps.
    await (await reader().open("d-studio", "claude", "s-1")).fill()
    entries.push(turn(200))
    stamp = "n:2"
    now += 10_000
    owner.scope(scope)
    await owner.settled()

    // The page again, the account's copy newer meanwhile: what it kept opens before the account is asked.
    let release
    asked.held = new Promise((resolve) => (release = resolve))
    const heads = asked.head
    const gate = new Proxy(proxy, { get: (target, name) => (name === "head" ? async (...args) => (await asked.held, target.head(...args)) : target[name]) })
    const gated = new CopyReader({ remote: () => gate, store, decode: (frame) => frames.decompress(frame), now: () => now, changed: (...named) => changed.push(named) })
    const opened = await gated.open("d-studio", "claude", "s-1")
    assert.equal((await opened.page(undefined, 1)).entries[0].id, "e-199", "the copy it kept, its newest page from storage")
    assert.equal(asked.head, heads, "nothing asked of the account before it opened")
    assert.equal(gated.reads().at(-1).via, "kept")
    release()
    for (let tries = 0; !changed.length && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(changed, [["d-studio", "claude", "s-1"]], "the account's newer copy is said once it's read")
    assert.equal((await (await gated.open("d-studio", "claude", "s-1")).page(undefined, 1)).entries[0].id, "e-200", "and read again, it's the newer one")
    // Unchanged in the account, nothing is said.
    const quiet = []
    const again = new CopyReader({ remote: () => proxy, store, decode: (frame) => frames.decompress(frame), now: () => now, changed: (...named) => quiet.push(named) })
    assert.equal((await (await again.open("d-studio", "claude", "s-1")).page(undefined, 1)).entries[0].id, "e-200")
    await again.open("d-studio", "claude", "s-1", { fresh: true })
    assert.deepEqual(quiet, [])
    // Without `changed` (a Mac's reader), the account is asked before it opens, as before.
    const before = asked.head
    await new CopyReader({ remote: () => proxy, store, decode: (frame) => frames.decompress(frame), now: () => now }).open("d-studio", "claude", "s-1")
    assert.equal(asked.head, before + 1)
    owner.stop()
  } finally {
    frames.close()
    await rm(folder, { recursive: true, force: true })
  }
})

test("from a gateway without the current versions at once, a copy is pulled, and read again from where it was pulled to", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mako-copy-reader-pull-"))
  const frames = new ZstdFrames()
  try {
    const entries = Array.from({ length: 30 }, (_, n) => turn(n))
    let stamp = "n:1"
    let now = 4_000_000
    const remote = new MemoryRemote("gateway/d-studio")
    const owner = new ReadingCopies(join(folder, "studio"), { view: async () => sessionView("s-1", entries), stamp: () => stamp, translator: () => "t-1" }, () => {}, { now: () => now, remote: () => remote })
    const scope = { sessions: [{ harness: "claude", nativeId: "s-1", path: "/rail/s-1.jsonl", thread: "t-1", busy: true, tier: "now" }], paused: false }
    owner.scope(scope)
    owner.link({ id: "d-studio", base: "https://cloud.test/v1/devices/d-studio/records", authorization: "Bearer b" })
    await owner.settled()
    const pulled = []
    const pulling = new Proxy(remote, { get: (target, name) => (name === "pull" ? (...args) => (pulled.push(args[2]), target.pull(...args)) : typeof target[name] === "function" ? target[name].bind(target) : target[name]) })
    const reader = new CopyReader({ remote: () => pulling, store: new MemoryCopyStore(), decode: (frame) => frames.decompress(frame), now: () => now })
    assert.equal((await (await reader.open("d-studio", "claude", "s-1")).page(undefined, 5)).total, 30)
    entries.push(turn(30))
    stamp = "n:2"
    now += 10_000
    owner.scope(scope)
    await owner.settled()
    assert.equal((await (await reader.open("d-studio", "claude", "s-1")).page(undefined, 5)).total, 31)
    assert.deepEqual(pulled, [0, 1], "the second read pulls only the versions after the first")
    assert.equal(reader.reads().at(-1).via, "pull")
    owner.stop()
  } finally {
    frames.close()
    await rm(folder, { recursive: true, force: true })
  }
})
