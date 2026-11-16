import assert from "node:assert/strict"
import { createHook } from "node:async_hooks"
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { emptyBroker, chooseGrant, type Grant, type Need } from "@mako/protocol/borrow"
import { atOnce } from "@mako/sessions/slices"
import { LocalBorrowing } from "@mako/host/base/local-borrowing"
import { BorrowingStore } from "@mako/host/base/borrowing-store"
import { compactGrants, type BorrowingState } from "@mako/host/base/borrowing-state"

const root = await mkdtemp(join(tmpdir(), "mako-borrowing-rows-"))
const clock = 1_800_000_000_000
const grant = (id: string, ref = "items"): Grant => ({ id, resource: { kind: "tree", ref }, scope: { level: "account", account: "local" }, source: { kind: "device", device: "mac" }, within: "source-device", mode: "copy", access: "read", lifetime: { until: "revoked" }, ask: "never", secret: false, grantedBy: { kind: "person", account: "local" }, grantedAt: clock - 1_000, version: 1 })
const need = (ref = "items/file", correlationId = "launch"): Need => ({ kind: "tree", ref, mode: "copy", for: { account: "local", repository: "example/project", thread: "thread", place: { kind: "device", device: "mac" } }, correlationId, why: "a fixture" })
const empty = (): BorrowingState => ({ state: emptyBroker("local"), waiting: [], unanswered: [] })
const options = { device: "mac", account: "local", sources: { tree: async () => ({ answer: "yes" as const, version: "a".repeat(64) }) }, now: () => clock }
const brokers: LocalBorrowing[] = []
const broker = (folder: string) => { const made = new LocalBorrowing({ ...options, folder }); brokers.push(made); return made }
try {
  // Same reach, newest end decides the refusal. Different selectors/modes/scopes never collapse into each other.
  const before = empty()
  for (let i = 0; i < 40; i++) {
    const given = grant(`g${i}`, `items-${i % 4}`)
    if (i % 3 === 0) given.mode = "live"
    if (i % 5 === 0) given.scope = { level: "thread", account: "local", thread: "other" }
    before.state.grants[given.id] = { grant: given, consented: [], ended: { at: clock - 40 + i, why: i % 2 ? "expired" : "revoked", by: { kind: "mako" } } }
  }
  const compact = structuredClone(before)
  atOnce(compactGrants(compact))
  for (const mode of [undefined, "copy", "live"] as const) for (let i = 0; i < 5; i++) for (const thread of ["thread", "other"])
    assert.deepEqual(chooseGrant(compact.state, { ...need(`items-${i}/file`), mode, for: { ...need().for, thread } }, clock), chooseGrant(before.state, { ...need(`items-${i}/file`), mode, for: { ...need().for, thread } }, clock))

  const orderFolder = join(root, "order")
  await import("node:fs/promises").then(fs => fs.mkdir(orderFolder))
  const ordered = empty()
  ordered.state.grants.z = { grant: grant("z", "items"), consented: [], ended: { at: clock, why: "expired", by: { kind: "mako" } } }
  ordered.state.grants.a = { grant: grant("a", "items/**"), consented: [], ended: { at: clock, why: "revoked", by: { kind: "mako" } } }
  await writeFile(join(orderFolder, "state.json"), JSON.stringify(ordered))
  assert.deepEqual(await broker(orderFolder).borrow(need()), { refusal: { refused: "expired" } }, "reload preserves the protocol's first-wins order for equal end times")

  const folder = join(root, "large")
  await import("node:fs/promises").then(fs => fs.mkdir(folder))
  let legacy: BorrowingState | undefined = empty()
  for (let i = 0; i < 43_000; i++) {
    const given = { ...grant(`old-${i}`, `items-${i % 4}`), label: "historical fixture ".repeat(10) }
    legacy.state.grants[given.id] = { grant: given, consented: [], ended: { at: clock - 43_000 + i, why: "revoked", by: { kind: "mako" } } }
  }
  legacy.state.grants.live = { grant: grant("live", "live-items"), consented: [] }
  await writeFile(join(folder, "state.json"), JSON.stringify(legacy))
  const originalBytes = (await stat(join(folder, "state.json"))).size
  assert.ok(originalBytes > 20 * 1024 * 1024)
  legacy = undefined
  const a = broker(folder)
  assert.equal((await a.grants()).length, 1)
  assert.ok((await stat(join(folder, "state.json"))).size < 100, "the legacy snapshot becomes a tiny format fence")
  const inspect = new DatabaseSync(join(folder, "state.sqlite"))
  assert.equal(inspect.prepare("SELECT count(*) AS n FROM ended_grants").get()?.n, 43_000, "old IDs cannot be re-granted")
  assert.equal(inspect.prepare("SELECT count(*) AS n FROM borrowing_rows WHERE kind='grants'").get()?.n, 5, "only live and latest refusal grants remain materialized")
  inspect.close()
  assert.match((await a.grant(grant("old-0")))!, /ended/)
  assert.deepEqual(await a.borrow(need("items-0/file")), { refusal: { refused: "revoked" } })

  // The cache never exposes mutable state to a view.
  const listing = await a.grants(); listing[0]!.resource.ref = "tampered"
  assert.equal((await a.grants())[0]?.resource.ref, "live-items")
  const parse = JSON.parse, stringify = JSON.stringify
  let wholeParses = 0, wholeWrites = 0
  // SAFETY: this observer forwards the intrinsic unchanged after counting a large parse.
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text.length > 4096) { wholeParses++; throw new Error("A borrowing operation parsed a whole snapshot") }
    return parse(text, reviver)
  }) as typeof JSON.parse
  // SAFETY: this intrinsic observer forwards the original argument tuple, including replacer and spacing.
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    if (args[0] && Object.hasOwn(args[0], "state") && Object.hasOwn(args[0], "unanswered")) { wholeWrites++; throw new Error("A borrowing operation encoded a whole snapshot") }
    return stringify.apply(JSON, args)
  }) as typeof JSON.stringify
  const longest: number[] = []
  try {
    for (let sample = 0; sample < 5; sample++) {
      let maximum = 0
      const started = new Map<number, number>()
      const hook = createHook({ before(id) { const cpu = process.threadCpuUsage(); started.set(id, cpu.user + cpu.system) }, after(id) { const from = started.get(id); if (from === undefined) return; started.delete(id); const cpu = process.threadCpuUsage(); maximum = Math.max(maximum, (cpu.user + cpu.system - from) / 1000) } })
      hook.enable()
      try {
        for (let i = 0; i < 12; i++) { await a.grants(); await a.leases(); await a.tick() }
        const given = grant(`fresh-${sample}`, "fresh")
        await a.grant(given); await a.revoke(given.id, { kind: "person", account: "local" })
      } finally { hook.disable() }
      longest.push(maximum)
    }
  } finally { JSON.parse = parse; JSON.stringify = stringify }
  assert.equal(wholeParses, 0); assert.equal(wholeWrites, 0)
  const median = [...longest].sort((a, b) => a - b)[2]!
  assert.ok(median < 20, `warm row operations' callback CPU median ${median.toFixed(2)} ms, samples ${longest.map(n => n.toFixed(2))}`)
  console.log(JSON.stringify({ legacyBytes: originalBytes, warmLongestCallbackCpuMs: longest, medianMs: median }))

  const borrowed = await a.borrow(need("live-items/file", "cache-copy"))
  assert.ok("lease" in borrowed)
  borrowed.lease.version = "b".repeat(64)
  assert.equal((await a.lease(borrowed.lease.id))?.lease.version, "a".repeat(64), "mutating an answer cannot change the cached decision")
  const b = broker(folder)
  const gave = grant("foreign", "foreign")
  await a.grant(gave); assert.ok((await b.grants()).some(g => g.id === gave.id))
  await b.revoke(gave.id, { kind: "person", account: "local" })
  await a.grant(grant("another", "elsewhere"))
  assert.deepEqual(await a.borrow(need("foreign/file", "after-revoke")), { refusal: { refused: "revoked" } })
  assert.match((await a.grant(gave))!, /ended/, "another instance cannot undo a revoke")

  // A source failure is a typed refusal. A failed durable save must not poison cached state.
  const failed = new LocalBorrowing({ ...options, folder, sources: { tree: async () => { throw new Error("fixture") } } }); brokers.push(failed)
  assert.ok("refusal" in await failed.borrow(need("live-items/file", "source-error")))
  const db = new DatabaseSync(join(folder, "state.sqlite"))
  db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON borrowing_rows BEGIN SELECT RAISE(ABORT,'fixture write failure'); END")
  await assert.rejects(a.grant(grant("rolled-back", "not-persisted")), /fixture write failure/)
  db.exec("DROP TRIGGER reject_fixture"); db.close()
  assert.ok(!(await a.grants()).some(g => g.id === "rolled-back"))

  // A legacy process already open at migration still reads on every locked operation. Its exact dereference
  // fails closed at the fence instead of creating grants from a stale snapshot. New decisions survive reopen.
  const oldLoad = async () => {
    // SAFETY: deliberately replay the original reader's unchecked dereference; the new fence must make it throw.
    const saved = JSON.parse(await readFile(join(folder, "state.json"), "utf8")) as { state: { account: string } }
    return saved.state.account
  }
  await assert.rejects(oldLoad(), TypeError)
  for (const item of brokers) await item.close()
  const reopened = broker(folder)
  assert.match((await reopened.grant(grant("old-0")))!, /ended/)
  const fence = await readFile(join(folder, "state.json"), "utf8")
  await writeFile(join(folder, "state.json"), JSON.stringify(empty()))
  await assert.rejects(reopened.grants(), /refusing to overwrite newer decisions/)
  await writeFile(join(folder, "state.json"), fence)
  assert.ok((await reopened.grants()).some(g => g.id === "another"))
  await writeFile(join(folder, "state.json"), JSON.stringify({ version: 3, reads: 2, state: null }))
  assert.ok((await reopened.grants()).some(g => g.id === "another"))
  await assert.rejects(reopened.tick(), /cannot change it/)
  await writeFile(join(folder, "state.json"), JSON.stringify({ version: 3, reads: 3, state: null }))
  await assert.rejects(reopened.grants(), /update Mako to read it/)
  await writeFile(join(folder, "state.json"), fence)

  // A crash after the import commits but before the fence publishes leaves JSON authoritative. Importing the
  // next locked operation replaces that incomplete migration, including its tentative tombstones.
  const recovery = join(root, "recovery"); await import("node:fs/promises").then(fs => fs.mkdir(recovery))
  const partial = new BorrowingStore(join(recovery, "state.sqlite"), "local")
  const stale = empty(); stale.state.grants.stale = { grant: grant("stale"), consented: [], ended: { at: clock, why: "revoked", by: { kind: "mako" } } }
  await partial.write(stale, true); partial.close()
  const current = empty(); current.state.grants.current = { grant: grant("current"), consented: [] }
  await writeFile(join(recovery, "state.json"), JSON.stringify(current))
  const recovered = broker(recovery)
  assert.deepEqual((await recovered.grants()).map(g => g.id), ["current"])
  assert.equal(await recovered.grant(grant("stale", "separate")), undefined, "an unpublished tentative tombstone was replaced too")
  assert.ok("lease" in await recovered.borrow(need("separate/file", "recovered")))
  assert.ok((await Array.fromAsync(recovered.events())).some(event => event.event === "granted"))
  const future = new DatabaseSync(join(recovery, "state.sqlite"))
  future.exec("UPDATE meta SET value='2' WHERE key='schema'")
  assert.ok((await recovered.grants()).length > 0, "a readable newer format still lists decisions")
  const logBytes = (await stat(join(recovery, "events.jsonl"))).size
  await assert.rejects(recovered.grant(grant("newer-format")), /cannot change borrowing decisions/)
  assert.equal((await stat(join(recovery, "events.jsonl"))).size, logBytes, "read-only means no event-log write either")
  future.exec("UPDATE meta SET value='2' WHERE key='reads'")
  await assert.rejects(recovered.grants(), /needs .* to read/)
  future.close()
  const closing = broker(folder)
  await closing.grants()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const blocking = reopened.locked(async () => { entered(); await held })
  await arrived
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([closing.close().then(() => "closed"), new Promise<string>(resolve => { timer = setTimeout(() => resolve("blocked"), 1000) })])
    assert.equal(result, "closed", "closing a connection never waits for another broker's lock")
    await assert.rejects(closing.grants(), /closed/)
  } finally { clearTimeout(timer); release(); await blocking }
  console.log("local borrowing: bounded materialized state, unchanged cache, row writes, durable revocation IDs, foreign invalidation, rollback, interrupted migration and old-writer fence")
} finally {
  await Promise.allSettled(brokers.map(b => b.close()))
  await rm(root, { recursive: true, force: true })
}
