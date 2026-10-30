import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { constants, createZstdCompress, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { planRecordImport, RecordConflictError } from "@mako/protocol/records"
import { MemoryGuard } from "../dist/memory-guard.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { RecordSync } from "../dist/record-sync.js"
import { UploadBudget } from "../dist/upload-budget.js"
import { ZstdFrameError, ZstdFrames, frameHeader, frameLength } from "../dist/zstd-frames.js"

/**
 * What keeps the sync daemon's memory down through a large catch-up, and why it never loses or doubles an upload:
 * one zstd context each way instead of one a chunk; one byte budget for every pack in flight; a guard that sheds
 * uploads before it retires; and a push cut off mid-upload (a retired or killed daemon) that the next one finishes
 * with every version in the account once.
 */

const MiB = 1024 * 1024
const tick = () => new Promise((resolve) => setImmediate(resolve))

// zstd frames through one context each way: each frame whole, read alone by any decoder, its size in its header.
{
  const frames = new ZstdFrames()
  const inputs = Array.from({ length: 300 }, (_, n) => Buffer.from(randomBytes(200 + n * 97).toString("base64").repeat(1 + (n % 3))))
  const made = await Promise.all(inputs.map((input) => frames.compress(input)))
  for (const [n, frame] of made.entries()) {
    assert.deepEqual(zstdDecompressSync(frame), inputs[n], "each frame decodes alone, in the order asked")
    assert.ok((frame[4] & 0xc0) !== 0 || (frame[4] & 0x20) !== 0, "each frame names its content size")
    assert.ok(frame.length < inputs[n].length, "and is compressed")
    assert.ok(frame.buffer.byteLength <= Math.max(frame.length, Buffer.poolSize), "in a buffer of its own size (or the shared pool's), not a view of zlib's output buffer")
  }
  const back = await Promise.all(made.map((frame) => frames.decompress(frame)))
  for (const [n, bytes] of back.entries()) assert.deepEqual(bytes, inputs[n])
  const outside = zstdCompressSync(Buffer.from("written by another encoder"))
  assert.equal((await frames.decompress(outside)).toString(), "written by another encoder")
  frames.close()
}

// A frame that isn't one whole frame rejects its call, never gives what it holds as the frame's bytes, and leaves no
// context mid-frame: the call after it reads as if it never came.
{
  const frames = new ZstdFrames()
  const input = Buffer.from(randomBytes(9_000).toString("base64"))
  const frame = await frames.compress(input)
  const header = frameHeader(frame)
  assert.equal(header.kind, "sized", "a frame made here names its content size")
  assert.equal(header.size, input.length)
  const flipped = Buffer.from(frame)
  for (let at = 20; at < flipped.length - 8; at += 97) flipped[at] ^= 0xff
  const unsized = await new Promise((resolve) => {
    // A frame whose header names no size: what a stream encoder writes when it's fed before it's ended.
    const stream = createZstdCompress()
    const parts = []
    stream.on("data", (part) => parts.push(part))
    stream.write(input.subarray(0, 4_000))
    stream.write(input.subarray(4_000))
    stream.flush(constants.ZSTD_e_end, () => {
      resolve(Buffer.concat(parts))
      stream.destroy()
    })
  })
  assert.equal(frameHeader(unsized).kind, "no size")
  assert.equal(frameLength(unsized), unsized.length, "a frame's length read from its blocks")
  assert.equal(frameLength(frame), frame.length)
  for (const made of [frame, unsized]) for (let cut = 1; cut < made.length; cut += 7) assert.notEqual(frameLength(made.subarray(0, cut)), cut, "no cut frame reads as whole")
  const bad = {
    "not a frame": Buffer.from("not a zstd frame at all"),
    "too short for a header": frame.subarray(0, 4),
    "cut short": frame.subarray(0, frame.length - 3),
    "cut to its header": frame.subarray(0, 9),
    "two frames": Buffer.concat([frame, frame]),
    "with bytes after it": Buffer.concat([frame, Buffer.from([1, 2, 3])]),
    "corrupt": flipped,
    "cut short, naming no size": unsized.subarray(0, unsized.length - 3),
  }
  for (const [what, bytes] of Object.entries(bad)) {
    await assert.rejects(frames.decompress(bytes), `a frame ${what} rejects its call`)
    assert.deepEqual(await frames.decompress(frame), input, `and the call after a frame ${what} reads whole`)
  }
  assert.deepEqual(await frames.decompress(unsized), input, "a whole frame naming no size reads")
  // Frames asked for together: the bad one rejects alone, those around it read.
  const together = await Promise.allSettled([frames.decompress(frame), frames.decompress(bad["cut short"]), frames.decompress(frame)])
  assert.deepEqual(together.map((each) => each.status), ["fulfilled", "rejected", "fulfilled"])
  assert.deepEqual(together[2].value, input)
  const pending = frames.decompress(frame)
  frames.close()
  await pending.then((bytes) => assert.deepEqual(bytes, input), (error) => assert.ok(error instanceof ZstdFrameError, "a frame under way when its context closes rejects, never hangs"))
  frames.close()
  assert.deepEqual(await frames.decompress(await frames.compress(Buffer.from("after close"))), Buffer.from("after close"), "a closed context opens again when asked")
  frames.close()
}

// The budget: packs wait for room in turn; a shed budget lets in nothing new, and those in flight finish.
{
  const budget = new UploadBudget(10, 4)
  const first = await budget.take(4)
  const second = await budget.take(4)
  let third
  const waiting = budget.take(4).then((held) => (third = held))
  await tick()
  assert.equal(third, undefined, "past the budget a pack waits")
  assert.equal(budget.held, 8)
  first.trim(3)
  await tick()
  assert.equal(third, undefined, "until enough is given back")
  second.release()
  await waiting
  assert.equal(budget.held, 7, "a pack trimmed to what it came to holds only that")
  budget.shed(true)
  let late
  const shedWait = budget.take(1).then((held) => (late = held))
  let turn
  const turnWait = budget.take(3, { turn: true }).then((held) => (turn = held))
  first.release()
  third.release()
  await tick()
  assert.equal(late, undefined, "while it sheds nothing new starts, though there's room")
  assert.equal(turn, undefined, "a turn's push waits too")
  assert.equal(budget.held, 0, "and those in flight give their bytes back")
  let resumed = 0
  budget.onResumed(() => (resumed += 1))
  budget.shed(false)
  await Promise.all([shedWait, turnWait])
  assert.equal(resumed, 1)
  assert.equal(budget.held, 4)
  const packs = [await budget.take(4), await budget.take(2)]
  assert.equal(budget.held, 10)
  const quick = await budget.take(3, { turn: true })
  assert.equal(budget.held, 13, "a turn's push never waits behind packs for room")
  for (const held of [late, turn, quick, ...packs]) held.release()
  assert.equal(budget.held, 0)
}

// The guard: over a limit after a collection it sheds; it retires only once over for three samples with uploads drained.
{
  const budget = new UploadBudget(8 * MiB)
  const lines = []
  let memory = { rss: 300 * MiB, heapUsed: 60 * MiB, external: 40 * MiB }
  let collected = 0
  let now = 0
  const guard = new MemoryGuard(budget, (level, message, fields) => lines.push({ level, message, fields }), {
    limits: { heldBytes: 200 * MiB, rssBytes: 600 * MiB },
    read: () => memory,
    collect: () => {
      collected += 1
      if (memory.garbage) memory = { ...memory, external: memory.external - memory.garbage, garbage: 0 }
    },
    now: () => now,
  })
  assert.equal(guard.sample(), undefined)
  assert.equal(collected, 0, "under its limits nothing is collected")
  const inFlight = await budget.take(MiB)
  memory = { rss: 450 * MiB, heapUsed: 60 * MiB, external: 300 * MiB, garbage: 250 * MiB }
  assert.equal(guard.sample(), undefined)
  assert.equal(collected, 1)
  assert.equal(guard.shedding, false, "buffers a collection frees aren't load")
  now += 5_000
  memory = { rss: 650 * MiB, heapUsed: 60 * MiB, external: 50 * MiB }
  assert.equal(guard.sample(), undefined)
  assert.equal(guard.shedding, true, "resident memory over its backstop after a collection sheds")
  assert.equal(budget.shedding, true)
  assert.match(lines.at(-1).message, /new uploads wait/)
  for (let sample = 0; sample < 5; sample++) {
    now += 5_000
    assert.equal(guard.sample(), undefined, "an upload in flight is never cut off by the guard")
  }
  inFlight.release()
  now += 5_000
  const retired = guard.sample()
  assert.ok(retired, "over its limits with uploads drained, it retires")
  assert.equal(retired.heldLimitMb, 200)
  assert.equal(collected, 2, "collecting at most every 30 s")

  const recovering = new MemoryGuard(budget, () => {}, { limits: { heldBytes: 200 * MiB, rssBytes: 600 * MiB }, read: () => memory, collect: () => {}, now: () => now })
  memory = { rss: 400 * MiB, heapUsed: 100 * MiB, external: 150 * MiB }
  recovering.sample()
  assert.equal(recovering.shedding, true)
  memory = { rss: 400 * MiB, heapUsed: 90 * MiB, external: 70 * MiB }
  now += 5_000
  recovering.sample()
  assert.equal(recovering.shedding, true, "between the limit and three quarters of it, still shed")
  memory = { rss: 400 * MiB, heapUsed: 60 * MiB, external: 50 * MiB }
  now += 5_000
  assert.equal(recovering.sample(), undefined)
  assert.equal(recovering.shedding, false, "under three quarters, uploads go on")
  assert.equal(budget.shedding, false)
}

/** The gateway's records routes in memory, by the protocol's rules, counting what's in flight and versions sent twice. */
class Remote {
  chunks = new Map()
  units = new Map()
  versions = 0
  twice = 0
  inFlight = 0
  mostInFlight = 0
  puts = 0
  /** Calls after which every upload hangs, as a daemon retired or killed mid-upload never hears back. */
  hangAfterPuts = Infinity
  constructor(id) {
    this.id = id
  }
  async missing(hashes) {
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack) {
    const bytes = pack.reduce((total, chunk) => total + chunk.body.length, 0)
    this.inFlight += bytes
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight)
    try {
      this.puts += 1
      if (this.puts > this.hangAfterPuts) await new Promise(() => {})
      await new Promise((resolve) => setTimeout(resolve, 2))
      for (const chunk of pack) {
        const plain = chunk.codec === 1 ? zstdDecompressSync(chunk.body) : Buffer.from(chunk.body)
        assert.equal(createHash("sha256").update(plain).digest("hex"), chunk.hash)
        this.chunks.set(chunk.hash, { ...chunk, body: Uint8Array.from(chunk.body) })
      }
      return { taken: pack.length }
    } finally {
      this.inFlight -= bytes
    }
  }
  async pushWith(bundle, pack) {
    if (this.puts >= this.hangAfterPuts) await new Promise(() => {})
    const named = new Set(bundle.units.flatMap((unit) => unit.versions).flatMap((version) => version.chunks.match(/.{64}/g) ?? []))
    for (const chunk of pack) if (named.has(chunk.hash)) this.chunks.set(chunk.hash, { ...chunk, body: Uint8Array.from(chunk.body) })
    const missing = [...named].filter((hash) => !this.chunks.has(hash))
    return missing.length ? { missing } : this.push(bundle)
  }
  async push(bundle) {
    for (const version of bundle.units.flatMap((unit) => unit.versions))
      for (let at = 0; at < version.chunks.length; at += 64) assert.ok(this.chunks.has(version.chunks.slice(at, at + 64)), "every chunk a push names came first")
    let plan
    try {
      plan = planRecordImport(bundle, (key) => {
        const unit = this.units.get(key)
        return unit && { head: unit.length - 1, version: (seq) => unit[seq] }
      })
    } catch (error) {
      if (!(error instanceof RecordConflictError)) throw error
      return { ok: false, conflict: error.conflict, key: error.key, seq: error.seq, head: error.head, message: error.message }
    }
    for (const { unit, version } of plan.taking) {
      const held = this.units.get(unit.key) ?? []
      if (held[version.seq]) this.twice += 1
      held[version.seq] = version
      this.units.set(unit.key, held)
      this.versions += 1
    }
    return { ok: true, versions: plan.taking.length, held: plan.held, through: this.versions }
  }
  async holdings() {
    return { holdings: Object.fromEntries([...this.units].map(([key, versions]) => [key, versions.length - 1])), next: null }
  }
  async sessions() {
    return []
  }
}

const root = await mkdtemp(join(tmpdir(), "mako-upload-memory-"))
const stores = new NativeStores(false)
try {
  // A session of 48 files of 1 MiB that don't compress away, as a long Session's tool output doesn't: 48 MiB of chunks.
  const machine = join(root, "machine")
  await mkdir(join(machine, "sessions"), { recursive: true })
  const files = []
  for (let n = 0; n < 48; n++) {
    const file = join(machine, "sessions", `part-${n}.jsonl`)
    await writeFile(file, `${JSON.stringify({ n, text: randomBytes(768 * 1024).toString("base64") })}\n`)
    files.push(file)
  }
  const records = { roots: [{ name: "synthetic", path: machine }], files, databases: [] }
  const folder = join(root, "store")
  const first = new RecordStore(folder, stores)
  await first.capture({ harness: "synthetic", nativeId: "s1", home: machine, records })
  const versions = first.exportFor("gateway/never", "synthetic", "s1", { limit: 10_000 }).bundle.units.reduce((total, unit) => total + unit.versions.length, 0)

  // Packs in flight stay within the budget the process's syncs share, however many go at once.
  const budget = new UploadBudget(8 * MiB)
  const bounded = new Remote("gateway/bounded")
  await Promise.all([new RecordSync(first, bounded, { budget }).push("synthetic", "s1"), new RecordSync(first, bounded, { budget, uploads: 8 }).push("synthetic", "s1")])
  assert.ok(bounded.mostInFlight <= 8 * MiB, `in flight at most the budget (${bounded.mostInFlight} bytes)`)
  assert.ok(bounded.mostInFlight > 2 * MiB, "and packs still go several at once")
  assert.equal(budget.held, 0, "every reservation given back")

  // A daemon retired mid-upload: its packs in flight never answered and it never pushed the versions. The next daemon,
  // on the same store, sends what the account lacks and the versions once each: nothing lost, nothing taken twice.
  const remote = new Remote("gateway/cut")
  remote.hangAfterPuts = 3
  void new RecordSync(first, remote, { budget: new UploadBudget(8 * MiB) }).push("synthetic", "s1")
  for (let waited = 0; remote.puts <= remote.hangAfterPuts && waited < 500; waited++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(remote.chunks.size > 0 && remote.versions === 0, "cut off with some chunks in the account and no version")
  const went = remote.chunks.size
  await first.close()
  remote.hangAfterPuts = Infinity
  const next = new RecordStore(folder, stores)
  const report = await new RecordSync(next, remote).push("synthetic", "s1")
  assert.ok(report.chunks <= remote.chunks.size - went + 1, "the next daemon sends only the chunks the account lacked")
  assert.equal(remote.versions, versions, "every version is in the account")
  assert.equal(remote.twice, 0, "and none twice")
  assert.equal((await new RecordSync(next, remote).push("synthetic", "s1")).versions, 0, "a push after sends nothing")

  // Cut off once the versions went but before this side noted it: the push goes again and the account takes nothing twice.
  const noted = new Remote("gateway/noted")
  const pushing = new RecordSync(next, noted)
  const realPush = noted.push.bind(noted)
  let afterPush
  noted.push = async (bundle) => {
    const answer = await realPush(bundle)
    await new Promise((resolve) => (afterPush = resolve))
    return answer
  }
  void pushing.push("synthetic", "s1")
  for (let waited = 0; !afterPush && waited < 500; waited++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(noted.versions, versions, "the account took every version")
  await next.close()
  noted.push = realPush
  const again = new RecordStore(folder, stores)
  const resent = await new RecordSync(again, noted).push("synthetic", "s1")
  assert.equal(noted.twice, 0, "sent again, nothing is taken twice")
  assert.equal(noted.versions, versions)
  assert.equal(resent.held, versions, "the account says it already held them")
  await again.close()
  console.log("upload-memory: ok")
} finally {
  await rm(root, { recursive: true, force: true })
}
