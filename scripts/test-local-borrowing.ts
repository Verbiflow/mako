import assert from "node:assert/strict"
import { createHook } from "node:async_hooks"
import { mkdtemp, writeFile, readFile, stat, rm, readdir, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyBroker, chooseGrant, type Grant, type Need } from "@mako/protocol/borrow"
import { atOnce } from "@mako/sessions/slices"
import { LocalBorrowing } from "@mako/host/base/local-borrowing"
import { BorrowingSnapshot } from "@mako/host/base/borrowing-snapshot"
import { compactGrants, type BorrowingState } from "@mako/host/base/borrowing-state"

const root = await mkdtemp(join(tmpdir(), "mako-borrowing-snapshot-"))
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
  assert.ok((await stat(join(folder, "state.json"))).size < 16 * 1024, "the legacy snapshot keeps only live, pinned and latest-per-reach grants")
  assert.equal((await readFile(join(folder, "ended-grants.jsonl"), "utf8")).trim().split("\n").length, 43_000, "compact IDs survive payload pruning")
  assert.ok(!(await readdir(folder)).some(name => name.includes("sqlite")), "no format migration or database is created")
  // The original reader dereferences state.account and writes only these three fields. Both stay valid.
  const oldLoad = async () => {
    // SAFETY: this fixture replays the original reader on the snapshot produced by the broker above.
    const saved = JSON.parse(await readFile(join(folder, "state.json"), "utf8")) as BorrowingState
    assert.equal(saved.state.account, "local")
    return { state: saved.state, waiting: saved.waiting ?? [], unanswered: saved.unanswered ?? [] }
  }
  const oldView = await oldLoad()
  assert.equal(Object.keys(oldView.state.grants).length, 5)
  await writeFile(join(folder, "state.json"), JSON.stringify(oldView))
  assert.match((await a.grant(grant("old-0")))!, /ended/)
  assert.deepEqual(await a.borrow(need("items-0/file")), { refusal: { refused: "revoked" } })

  // The cache never exposes mutable state to a view.
  const listing = await a.grants(); listing[0]!.resource.ref = "tampered"
  assert.equal((await a.grants())[0]?.resource.ref, "live-items")
  await a.grants()
  const parse = JSON.parse, stringify = JSON.stringify
  let wholeParses = 0, wholeWrites = 0
  // SAFETY: this observer forwards the intrinsic unchanged after counting a large parse.
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text.includes('"state"')) { wholeParses++; throw new Error("An unchanged borrowing read parsed a snapshot") }
    return parse(text, reviver)
  }) as typeof JSON.parse
  // SAFETY: this intrinsic observer forwards the original argument tuple, including replacer and spacing.
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    if (args[0] && Object.hasOwn(args[0], "state") && Object.hasOwn(args[0], "unanswered")) { wholeWrites++ }
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
        for (let i = 0; i < 12; i++) { await a.grants(); await a.leases() }
        const given = grant(`fresh-${sample}`, "fresh")
        await a.grant(given); await a.revoke(given.id, { kind: "person", account: "local" })
      } finally { hook.disable() }
      longest.push(maximum)
    }
  } finally { JSON.parse = parse; JSON.stringify = stringify }
  assert.equal(wholeParses, 0); assert.equal(wholeWrites, 10, "only the two actual mutations per sample encode the compact legacy file")
  const median = [...longest].sort((a, b) => a - b)[2]!
  assert.ok(median < 20, `warm snapshot operations' callback CPU median ${median.toFixed(2)} ms, samples ${longest.map(n => n.toFixed(2))}`)
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

  // Old writes remain readable; new reads reload and compaction never removes a live decision.
  const oldWritten = await oldLoad()
  oldWritten.state.grants["old-writer"] = { grant: grant("old-writer", "old-writer"), consented: [] }
  const file = join(folder, "state.json")
  await writeFile(file, JSON.stringify(oldWritten))
  assert.ok((await a.grants()).some(g => g.id === "old-writer"))
  await a.revoke("old-writer", { kind: "person", account: "local" })
  assert.ok((await oldLoad()).state.grants["old-writer"]?.ended, "the old binary sees a new revoke")
  // A newer instance must retain compact revocation IDs even after an old writer rewrites the snapshot.
  const reopened = broker(folder)
  await writeFile(file, JSON.stringify(await oldLoad()))
  assert.match((await reopened.grant(grant("old-0")))!, /ended/)

  // A source failure is a typed refusal; a failed atomic save invalidates its cached decision.
  const failed = new LocalBorrowing({ ...options, folder, sources: { tree: async () => { throw new Error("fixture") } } }); brokers.push(failed)
  assert.ok("refusal" in await failed.borrow(need("live-items/file", "source-error")))
  const snapshot = new BorrowingSnapshot(folder, "local")
  const savedText = await readFile(file, "utf8")
  const tentative = structuredClone(await snapshot.read())
  tentative.state.grants.tentative = { grant: grant("tentative"), consented: [] }
  await rm(file); await mkdir(file)
  await assert.rejects(snapshot.write(tentative))
  await rm(file, { recursive: true }); await writeFile(file, savedText)
  assert.equal((await snapshot.read()).state.grants.tentative, undefined)
  // A process dying during a ledger append leaves a partial final line, never a published pruning without IDs.
  await import("node:fs/promises").then(fs => fs.appendFile(join(folder, "ended-grants.jsonl"), '{"account":"local","id":"partial'))
  const recovered = broker(folder)
  assert.match((await recovered.grant(grant("old-0")))!, /ended/)
  await recovered.revoke("live", { kind: "person", account: "local" })
  assert.equal((await oldLoad()).state.grants.live?.ended?.why, "revoked")
  assert.ok((await Array.fromAsync(recovered.events())).some(event => event.event === "granted"))
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
  console.log("local borrowing: compact legacy snapshots, unchanged cache, old-reader/writer compatibility, durable revocation IDs, foreign invalidation, failed save and interrupted append")
} finally {
  await Promise.allSettled(brokers.map(b => b.close()))
  await rm(root, { recursive: true, force: true })
}
