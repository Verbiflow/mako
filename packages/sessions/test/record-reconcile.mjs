import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { planRecordImport } from "@mako/protocol/records"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { ScopedUploads } from "../dist/scoped-uploads.js"

/**
 * What the account holds is set against what the Mac believes it holds, and what it lost goes again. Before, the
 * Mac's mark of a whole push was the only word: an account that lost records stayed short of them for good, and the
 * Mac counted the Session in the cloud.
 */

class MemoryRemote {
  constructor(id) {
    Object.assign(this, { id, chunks: new Map(), units: new Map(), pushes: 0, listed: 0 })
  }
  async missing(hashes) {
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack) {
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    return { taken: pack.length }
  }
  async pushWith(bundle, pack) {
    for (const chunk of pack) this.chunks.set(chunk.hash, chunk)
    return this.push(bundle)
  }
  #key(bundle, unit) {
    return `${bundle.harness}\n${bundle.nativeId}\n${unit}`
  }
  async push(bundle) {
    this.pushes += 1
    const plan = planRecordImport(bundle, (unit) => {
      const held = this.units.get(this.#key(bundle, unit))
      return held && { head: held.length - 1, version: (seq) => held[seq] }
    })
    for (const { unit, version } of plan.taking) this.units.set(this.#key(bundle, unit.key), [...(this.units.get(this.#key(bundle, unit.key)) ?? []), version])
    return { ok: true, versions: plan.taking.length, held: plan.held, through: 0 }
  }
  async holdings(harness, nativeId) {
    const holdings = {}
    for (const [key, versions] of this.units) if (key.startsWith(`${harness}\n${nativeId}\n`)) holdings[key.split("\n")[2]] = versions.length - 1
    return { holdings, next: null }
  }
  async sessions() {
    this.listed += 1
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
  async readChunks() {
    return []
  }
  async pull() {
    return null
  }
}

const line = (n) => `${JSON.stringify({ n, text: createHash("sha256").update(String(n)).digest("hex").repeat(40) })}\n`

test("an account that lost a Session's records is caught up at the next comparison; one that holds them all is sent nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mako-reconcile-"))
  try {
    const home = join(root, "home")
    await mkdir(join(home, "sessions"), { recursive: true })
    const files = { s1: join(home, "sessions", "s1.jsonl"), s2: join(home, "sessions", "s2.jsonl") }
    const store = new RecordStore(join(root, "store"), new NativeStores(false))
    const capture = async (name, n) => {
      await appendFile(files[name], line(n))
      await store.capture({ harness: "synthetic", nativeId: name, home, records: { roots: [{ name: "synthetic", path: home }], files: [files[name]], databases: [] } })
    }
    for (let n = 0; n < 3; n++) for (const name of ["s1", "s2"]) await capture(name, n * 10 + (name === "s1" ? 1 : 2))
    let now = 1_800_000_000_000
    const remote = new MemoryRemote("gateway/o-1")
    const lines = []
    const scope = { sessions: ["s1", "s2"].map((name) => ({ harness: "synthetic", nativeId: name, path: files[name], thread: `t-${name}`, busy: false, tier: "day" })), paused: false }
    const uploads = new ScopedUploads(store, remote, (level, message, fields) => lines.push({ message, ...fields }), { now: () => now })
    uploads.scope(scope)
    await uploads.reconciled()
    await uploads.settled()
    assert.deepEqual([uploads.inCloud("synthetic", "s1"), uploads.inCloud("synthetic", "s2")], [true, true])
    assert.equal(remote.listed, 1, "compared once, as the link was given")
    const pushes = remote.pushes

    // The account loses s1's records (restored from before them, say). Nothing on the Mac changed: before, nothing
    // went again, and s1 stayed counted in the cloud.
    for (const key of [...remote.units.keys()]) if (key.includes("\ns1\n")) remote.units.delete(key)
    uploads.look()
    await uploads.reconciled()
    assert.equal(remote.listed, 1, "not compared again within the half hour")
    now += 30 * 60_000
    uploads.look()
    await uploads.reconciled()
    assert.equal(remote.listed, 2)
    assert.deepEqual([uploads.inCloud("synthetic", "s1"), uploads.inCloud("synthetic", "s2")], [true, true], "back in the cloud")
    const held = await remote.holdings("synthetic", "s1")
    assert.deepEqual(held.holdings, store.holdings("synthetic", "s1"), "every version of s1 again")
    assert.equal(remote.pushes - pushes, 1, "one push, s1's; s2, which the account holds whole, isn't sent")
    assert.deepEqual(lines.filter((entry) => entry.message.startsWith("the account held less")).map((entry) => [entry.nativeId, entry.held]), [["s1", 0]])

    // Held whole: the next comparison sends nothing.
    now += 30 * 60_000
    uploads.look()
    await uploads.reconciled()
    assert.equal(remote.pushes - pushes, 1)
    uploads.stop()
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
