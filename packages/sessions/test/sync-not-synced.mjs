import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { GatewayHttpError } from "@mako/protocol/gateway-http"
import { planRecordImport } from "@mako/protocol/records"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { LASTING_MS, ScopedUploads } from "../dist/scoped-uploads.js"

/**
 * A Session is said not synced only once that lasts, and stays said until it goes: the rail's line, Settings and
 * Diagnostics read it from here. On 2026-10-31 one refused push of a live Session, healed by its next try 2 s later,
 * kept its failure; at each capture after (every few seconds) the Session was behind for a moment and the failure,
 * by then minutes old, was said again, so the rail's "1 Session not synced" came and went for the rest of the day.
 */

/** The gateway's records routes in memory; `failing` makes each push fail with the error it gives. */
class Remote {
  constructor(id) {
    Object.assign(this, { id, chunks: new Map(), units: new Map(), failing: null, pushes: 0 })
  }
  async missing(hashes) {
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack) {
    if (this.failing) throw this.failing()
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    return { taken: pack.length }
  }
  async pushWith(bundle, pack) {
    this.pushes += 1
    if (this.failing) throw this.failing()
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    return this.push(bundle)
  }
  async push(bundle) {
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
  async sessions() {
    return []
  }
}

const refused = (n) => () => new GatewayHttpError(400, "The pack was refused", { method: "PUT", path: "/chunks", tries: 1, correlationId: `c-${n}` }, "The chunk 9032b81c isn't the chunk its hash names")
const unanswered = () => new GatewayHttpError(503, "Something went wrong", { method: "POST", path: "/sessions/with-chunks", tries: 4, correlationId: "c-503" })

/** A live Session on a fake clock: a capture every 5 s, looked at as the catalog looks, and the status read each second. */
async function liveSession(root) {
  const home = join(root, "home")
  const file = join(home, "sessions", "live.jsonl")
  await mkdir(join(home, "sessions"), { recursive: true })
  const store = new RecordStore(join(root, "store"), new NativeStores(false))
  let now = 1_800_000_000_000
  let line = 0
  const remote = new Remote("gateway/o-live")
  const uploads = new ScopedUploads(store, remote, () => {}, { now: () => now })
  const capture = async () => {
    await appendFile(file, `${JSON.stringify({ n: line++, text: `turn ${line} `.repeat(40) })}\n`)
    await store.capture({ harness: "synthetic", nativeId: "live", home, records: { roots: [{ name: "synthetic", path: home }], files: [file], databases: [] } })
  }
  await capture()
  uploads.scope({ sessions: [{ harness: "synthetic", nativeId: "live", path: file, thread: "t-live", busy: true, tier: "now" }], paused: false })
  await uploads.settled()
  /** Each second of `seconds`: a capture every fifth, its push, and whether the status says the Session isn't synced. */
  const run = async (seconds) => {
    const said = []
    for (let second = 1; second <= seconds; second++) {
      now += 1_000
      if (second % 5 === 0) await capture()
      uploads.look()
      // Read while the push is in flight, as the host reads every 5 s whatever is under way, and again once it settles.
      said.push(uploads.status().failures.length > 0)
      await uploads.settled()
      said.push(uploads.status().failures.length > 0)
    }
    return said
  }
  return { store, remote, uploads, run, close: async () => (uploads.stop(), await store.close()) }
}

/** How many times `said` changes from not said to said. */
const shown = (said) => said.filter((value, at) => value && !said[at - 1]).length

test("a refusal the next try heals is never said, and isn't said again at the Session's next captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-not-synced-transient-"))
  try {
    const live = await liveSession(root)
    // One refused push, as the stale chunks were, then the account takes the next.
    live.remote.failing = refused(1)
    await live.run(5)
    live.remote.failing = null
    const said = [...(await live.run(5)), ...(await live.run(10 * 60))]
    assert.equal(shown(said), 0, "never said: not while it retried, nor at any capture after it went")
    assert.equal(live.uploads.status().retrying, undefined, "and nothing is retrying once it went")
    assert.equal(live.uploads.inCloud("synthetic", "live"), true)
    await live.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failure that lasts is said once, stays through each try and change of words, and goes only once the Session goes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-not-synced-lasting-"))
  try {
    const live = await liveSession(root)
    let n = 0
    live.remote.failing = () => refused(++n)()
    const early = await live.run(LASTING_MS / 1_000 - 5)
    assert.equal(shown(early), 0, "not said before it has lasted")
    assert.ok(live.uploads.status().retrying >= 1, "retrying meanwhile, for Diagnostics")
    const refusedFor = await live.run(5 * 60)
    // Its words change (the account stops answering), and it keeps failing: still the one failure, said since it began.
    live.remote.failing = unanswered
    const unansweredFor = await live.run(5 * 60)
    const failing = [...refusedFor, ...unansweredFor]
    assert.equal(shown(failing), 1, "said once")
    assert.ok(failing.slice(failing.indexOf(true)).every(Boolean), "and never unsaid while it fails, in flight or not")
    const [failure] = live.uploads.status().failures
    assert.deepEqual([failure.nativeId, failure.kind, failure.since, failure.correlationId], ["live", "unreachable", 1_800_000_005_000, "c-503"], "its newest words, since its first failure (the first capture's push)")
    // The account takes it: unsaid at once, and not said again as the Session goes on.
    live.remote.failing = null
    // It's said until its next try goes (a failure that kept failing waits up to five minutes), then never again.
    const healed = await live.run(10 * 60)
    const until = healed.indexOf(false)
    assert.ok(until >= 0 && until <= 2 * 5 * 60, `unsaid by its next try, ${until / 2} s after the account healed`)
    assert.ok(healed.slice(0, until).every(Boolean) && !healed.slice(until).some(Boolean), "said until it went, and not again at its next captures")
    assert.equal(live.uploads.inCloud("synthetic", "live"), true)
    await live.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a refusal is said as one, with the account's reason one disclosure away", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-not-synced-words-"))
  try {
    const live = await liveSession(root)
    live.remote.failing = refused(7)
    await live.run(LASTING_MS / 1_000 + 30)
    const [failure] = live.uploads.status().failures
    assert.equal(failure.kind, "refused")
    assert.match(failure.message, /^The account refused \d+ chunks of this Session \([0-9a-f]{12}, [\d,]+ bytes, and \d+ more\) and took the rest: The pack was refused: The chunk 9032b81c isn't the chunk its hash names \(PUT \/chunks answered 400, correlation c-7\)$/)
    await live.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
