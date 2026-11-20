import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { planRecordImport } from "@mako/protocol/records"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { LASTING_MS, SLEPT_MS, ScopedUploads } from "../dist/scoped-uploads.js"

/**
 * A push that got no answer goes again soon, whatever its Session's tier, and at once when the account answers again
 * or the Mac wakes; the account not answering is said once for the account, only while it doesn't, since this time.
 * On 2026-11-19 a Mac woke from a 14-minute sleep, a large day-tier Claude Session's push met "fetch failed", and the
 * rail said "1 Session not synced · Mako can't reach the account · since 2:11 PM" in red until long after the account
 * answered again.
 */

/** The gateway's records routes in memory; while `down`, every call gets no answer, as fetch says it with no network. */
class Remote {
  constructor(id) {
    Object.assign(this, { id, chunks: new Map(), units: new Map(), down: false, pushes: [] })
  }
  #answer() {
    if (this.down) throw new TypeError("fetch failed")
  }
  async missing(hashes) {
    this.#answer()
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack) {
    this.#answer()
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    return { taken: pack.length }
  }
  async pushWith(bundle, pack) {
    this.pushes.push({ nativeId: bundle.nativeId, down: this.down })
    this.#answer()
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    return this.push(bundle)
  }
  async push(bundle) {
    this.#answer()
    const plan = planRecordImport(bundle, (key) => {
      const held = this.units.get(`${bundle.nativeId}\n${key}`)
      return held && { head: held.length - 1, version: (seq) => held[seq] }
    })
    for (const { unit, version } of plan.taking) this.units.set(`${bundle.nativeId}\n${unit.key}`, [...(this.units.get(`${bundle.nativeId}\n${unit.key}`) ?? []), version])
    return { ok: true, versions: plan.taking.length, held: plan.held, through: 0 }
  }
  async holdings() {
    this.#answer()
    return { holdings: {}, next: null }
  }
  async sessions() {
    this.#answer()
    return []
  }
}

/** Sessions on a fake clock, each in its tier, looked at every 5 s as the catalog does. */
async function sessions(root, tiers) {
  const home = join(root, "home")
  await mkdir(join(home, "sessions"), { recursive: true })
  const store = new RecordStore(join(root, "store"), new NativeStores(false))
  let now = 1_800_000_000_000
  const remote = new Remote("gateway/o-retry")
  const uploads = new ScopedUploads(store, remote, () => {}, { now: () => now })
  let line = 0
  const capture = async (nativeId) => {
    const file = join(home, "sessions", `${nativeId}.jsonl`)
    await appendFile(file, `${JSON.stringify({ n: line++, text: `turn ${line} `.repeat(40) })}\n`)
    await store.capture({ harness: "synthetic", nativeId, home, records: { roots: [{ name: "synthetic", path: home }], files: [file], databases: [] } })
  }
  const scope = { sessions: Object.entries(tiers).map(([nativeId, tier]) => ({ harness: "synthetic", nativeId, path: join(home, "sessions", `${nativeId}.jsonl`), thread: `t-${nativeId}`, busy: tier === "now", tier })), paused: false }
  /** `ms` on the clock with a look every 5 s, as the catalog's process looks while it's awake. */
  const pass = async (ms) => {
    for (let at = 0; at < ms; at += 5_000) {
      now += Math.min(5_000, ms - at)
      uploads.look()
      await uploads.settled()
    }
  }
  /** The Mac asleep for `ms`: no look, then one at the wake. */
  const sleep = async (ms) => {
    now += ms
    uploads.look()
    await uploads.settled()
  }
  const pushesOf = (nativeId) => remote.pushes.filter((push) => push.nativeId === nativeId)
  return { store, remote, uploads, capture, scope, pass, sleep, pushesOf, clock: () => now, close: async () => (uploads.stop(), await store.close()) }
}

test("a day-tier Session whose push meets a network error goes again within seconds and goes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-sync-retry-day-"))
  try {
    const at = await sessions(root, { large: "day" })
    await at.capture("large")
    at.remote.down = true
    at.uploads.scope(at.scope)
    await at.uploads.settled()
    assert.equal(at.pushesOf("large").length, 1)
    assert.equal(at.uploads.inCloud("synthetic", "large"), false)
    at.remote.down = false
    await at.pass(5_000)
    assert.equal(at.pushesOf("large").length, 2, "tried again within seconds, not at its tier's next turn")
    assert.equal(at.uploads.inCloud("synthetic", "large"), true)
    const status = at.uploads.status()
    assert.deepEqual([status.failures, status.retrying, status.unreachable], [[], undefined, undefined], "and nothing said of it at any point")
    await at.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("after a long outage, the account answering anything sends a parked push at once, its wait built up while it was gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-sync-retry-outage-"))
  try {
    const at = await sessions(root, { large: "day", live: "now" })
    await at.capture("large")
    await at.capture("live")
    at.remote.down = true
    at.uploads.scope(at.scope)
    await at.uploads.settled()
    // An hour with no network: each tries again, waiting longer each time, two minutes at most.
    await at.pass(60 * 60_000)
    assert.ok(at.pushesOf("large").length >= 25, `tried again through the hour, at least every two minutes: ${at.pushesOf("large").length} tries`)
    // The network comes back, and the Session at work captures and goes within seconds: the parked one goes with it,
    // not when its own wait ends minutes on.
    at.remote.down = false
    await at.capture("live")
    await at.pass(15_000)
    assert.equal(at.uploads.inCloud("synthetic", "live"), true)
    assert.equal(at.uploads.inCloud("synthetic", "large"), true, "the parked one went as soon as the account answered")
    await at.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a request the account answers clears its not answering at once; until then it's said once, for the account, never as a Session's", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-sync-retry-status-"))
  try {
    const at = await sessions(root, { live: "now", large: "day" })
    await at.capture("large")
    await at.capture("live")
    at.remote.down = true
    const downAt = at.clock()
    at.uploads.scope(at.scope)
    await at.uploads.settled()
    await at.pass(LASTING_MS - 10_000)
    assert.equal(at.uploads.status().unreachable, undefined, "not said before it has lasted")
    await at.pass(20_000)
    const status = at.uploads.status()
    assert.deepEqual(status.failures, [], "no Session is said not synced for the account not answering")
    assert.equal(status.retrying, 2, "both wait, retrying")
    assert.equal(status.unreachable?.since, downAt, "said since the first request it didn't answer")
    // The network is back and the Session at work captures: its push is the first request answered, within seconds,
    // and the status reads it at once.
    at.remote.down = false
    await at.capture("live")
    let waited = 0
    while (at.uploads.status().answeredAt === undefined && waited < 30_000) {
      await at.pass(5_000)
      waited += 5_000
    }
    const healed = at.uploads.status()
    assert.ok(waited <= 15_000, `the Session at work went ${waited / 1_000} s after the network came back`)
    assert.equal(healed.unreachable, undefined, "the first answer clears it")
    assert.deepEqual([at.uploads.inCloud("synthetic", "live"), at.uploads.inCloud("synthetic", "large")], [true, true], "and the parked one went with it")
    await at.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a sleep doesn't leave a Session parked: the push after the wake waits seconds, and the episode begins at the wake", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-sync-retry-sleep-"))
  try {
    const at = await sessions(root, { large: "day" })
    await at.capture("large")
    at.remote.down = true
    at.uploads.scope(at.scope)
    await at.uploads.settled()
    // Ten minutes with no network before the Mac sleeps: its wait has grown to the most.
    await at.pass(10 * 60_000)
    assert.ok(at.uploads.status().unreachable, "said before the sleep")
    // Asleep fourteen minutes; at the wake the network isn't back yet, as on 2026-11-19, so the first try fails.
    const before = at.pushesOf("large").length
    await at.sleep(14 * 60_000)
    assert.ok(SLEPT_MS < 14 * 60_000)
    assert.equal(at.pushesOf("large").length, before + 1, "tried at the wake")
    assert.equal(at.uploads.status().unreachable, undefined, "the episode before the sleep isn't this one")
    // The network is back seconds later: the Session goes within seconds, not when a wait built before the sleep ends.
    await at.pass(5_000)
    at.remote.down = false
    await at.pass(15_000)
    assert.equal(at.uploads.inCloud("synthetic", "large"), true, "went within seconds of the network coming back")
    await at.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
