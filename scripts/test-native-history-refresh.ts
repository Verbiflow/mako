import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage } from "@mako/sessions"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const root = mkdtempSync(join(tmpdir(), "mako-history-refresh-"))
const id = randomUUID()
let revision = 1
let missing = false
let reads = 0
let translator = "first-parser"
const entries: ThreadPage["entries"] = [{ type: "user", id: "u1", text: "Original question" }]
const owner = new LiveConversations({
  root, appPath: root, driver: () => undefined, emit: () => {},
  history: async (_path, before = entries.length) => {
    reads++
    if (missing) return null
    const start = Math.max(0, before - 2)
    return {
      ref: { harness: "codex", nativeId: "fixture", path: "fixture.jsonl", bytes: revision },
      entries: entries.slice(start, before), start, total: entries.length,
      hasEarlier: start > 0, checkpoint: revision, translator,
    }
  },
})
try {
  await owner.capture(id, "fixture.jsonl")
  entries.push({ type: "text", id: "a1", text: "External answer" },
    { type: "user", id: "u2", text: "Latest question from other client" })
  revision++
  const [a, b] = await Promise.all([owner.refreshedSnapshot(id), owner.refreshedSnapshot(id)])
  assert.deepEqual(a?.base?.entries, entries)
  assert.equal(a, b, "concurrent refresh shares capture")
  const previousReads = reads
  await owner.refreshedSnapshot(id)
  assert.equal(reads - previousReads, 1, "unchanged history only reads its latest page")
  translator = "fixed-parser"
  entries[1] = { type: "text", id: "a1", text: "External answer, parsed correctly" }
  const retranslated = await owner.refreshedSnapshot(id)
  assert.deepEqual(retranslated?.base?.entries, entries, "a new translator re-reads an unchanged native record")
  assert.equal(retranslated?.base?.translator, "fixed-parser")
  const settledReads = reads
  await owner.refreshedSnapshot(id)
  assert.equal(reads - settledReads, 1, "the re-translated history is current again")
  missing = true
  const retained = await owner.refreshedSnapshot(id)
  assert.deepEqual(retained?.base?.entries, entries, "native deletion retains captured history")
  assert.deepEqual(retained?.requests, [], "observation never sends or retries a prompt")
  console.log("PASS: external history refresh, paged capture, coalescing, unchanged revision, missing-source retention")
} finally {
  rmSync(root, { recursive: true, force: true })
}

// A Mako-origin conversation has retained blocks and no imported base. This is
// the shape that originally stayed stale when its CLI continued the same ID.
const { LiveJournal } = await import("@mako/host/conversations/live-journal")
const { projectLive } = await import("../src/state/live-projection.ts")
const mixedRoot = mkdtempSync(join(tmpdir(), "mako-history-blocks-"))
try {
  const journal = new LiveJournal(mixedRoot, id)
  journal.commit({
    session: { id, harness: "codex", cwd: mixedRoot, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [] },
    revision: 0, createdAt: 1, base: null, permissions: [],
    requests: [{ id: randomUUID(), text: "Not sent", attachments: [], status: "failed" }],
    blocks: [{ type: "user", requestId: "old", text: "Original question" }, { type: "text", id: "answer", text: "External answer" }],
    control: { activeBindingId: id, bindings: [{ id, provider: "codex", nativeId: "fixture", path: "fixture.jsonl", includesBase: true, coveredBlocks: 2 }], transfers: [], actions: [], merges: [] },
  })
  journal.close()
  const owned = new LiveConversations({ root: mixedRoot, appPath: mixedRoot, driver: () => undefined, emit: () => {}, history: async () => ({ ref: { harness: "codex", nativeId: "fixture", path: "fixture.jsonl", bytes: 20 }, entries, start: 0, total: entries.length, hasEarlier: false, checkpoint: 20 }) })
  const before = owned.snapshot(id)!
  const next = (await owned.refreshedSnapshot(id))!
  assert.equal(next.baseCoveredBlocks, 2)
  assert.deepEqual(next.blocks, before.blocks, "original live records remain intact")
  assert.deepEqual(next.requests, before.requests, "saved failed prompt remains intact")
  const projection = projectLive(next)
  assert.equal(projection.messages.filter((m) => m.role === "user").length, 2, "old prompt is not duplicated")
  const streamed = { ...next, blocks: [...next.blocks, { type: "user" as const, requestId: "new", text: "New Mako prompt" }], session: { ...next.session, status: "running" as const } }
  const live = projectLive(streamed, projection)
  assert.equal(live.messages.filter((m) => m.role === "user").length, 3, "new live prompt follows refreshed native history")
  const answering = { ...streamed, blocks: [...streamed.blocks, { type: "text" as const, id: "new-answer", text: "New Mako answer" }] }
  assert.deepEqual(projectLive(answering, live).messages, projectLive(answering).messages, "streaming tail and full projection agree")
  const reopened = new LiveJournal(mixedRoot, id)
  assert.equal(reopened.read()?.baseCoveredBlocks, 2, "coverage survives journal reload")
  reopened.close()
  console.log("PASS: locally recorded history refresh, no duplicate turns, saved requests, streaming tail, durable coverage")
} finally { rmSync(mixedRoot, { recursive: true, force: true }) }

// A session resumed where it never ran before (a Thread arriving on a cloud machine): no history yet, and the
// notices its harness gives as it opens (Codex's sandbox warning on Linux) the only live blocks. Its history is
// read all the same, the notices after it; a turn that isn't covered yet still holds the read back; and the turn
// that follows lines up after the history it continued, the notice with it.
for (const harness of registeredHarnessIds()) {
  const resumedRoot = mkdtempSync(join(tmpdir(), "mako-history-resumed-"))
  const moved: ThreadPage["entries"] = [{ type: "user", id: "m1", text: "Before the move" }, { type: "text", id: "m2", text: "Answered on the laptop" }]
  let record = moved
  const notice = { type: "event" as const, id: "notice", label: "Warning", detail: "No sandbox helper on PATH", tone: "warning" as const, setup: true }
  const journal = (conversation: string, blocks: ThreadPage["entries"], coveredBlocks: number, base: ThreadPage | null = null) => {
    const written = new LiveJournal(resumedRoot, conversation)
    written.commit({
      session: { id: conversation, harness, cwd: resumedRoot, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [] },
      revision: 0, createdAt: 1, base, permissions: [], requests: [], blocks,
      control: { activeBindingId: conversation, bindings: [{ id: conversation, provider: harness, nativeId: "resumed", path: "resumed-store", includesBase: true, coveredBlocks }], transfers: [], actions: [], merges: [] },
    })
    written.close()
  }
  const opened = randomUUID()
  const prompted = randomUUID()
  journal(opened, [notice], 0)
  journal(prompted, [notice, { type: "user", requestId: "r1", text: "Not in the record yet" }], 0)
  const owner = new LiveConversations({
    root: resumedRoot, appPath: resumedRoot, driver: () => undefined, emit: () => {},
    history: async () => ({ ref: { harness, nativeId: "resumed", path: "resumed-store", bytes: record.length }, entries: record, start: 0, total: record.length, hasEarlier: false, checkpoint: record.length }),
  })
  try {
    const read = (await owner.refreshedSnapshot(opened))!
    assert.deepEqual(read.base?.entries, moved, `${harness}: the history is read with only the opening notice live`)
    assert.deepEqual(read.blocks, [notice], `${harness}: the notice stays, drawn after it`)
    assert.equal(read.baseCoveredBlocks ?? 0, 0)
    assert.equal((await owner.refreshedSnapshot(prompted))!.base, null, `${harness}: a turn the record doesn't cover yet holds the read back`)
    owner.stop()
    // The next turn ends and is covered: its record now holds it after the history it continued.
    record = [...moved, { type: "user", id: "m3", text: "On the machine" }, { type: "text", id: "m4", text: "Answered in the cloud" }]
    const turned = randomUUID()
    journal(turned, [notice, { type: "user", requestId: "r2", text: "On the machine" }, { type: "text", id: "t1", text: "Answered in the cloud" }], 3, read.base)
    const later = new LiveConversations({
      root: resumedRoot, appPath: resumedRoot, driver: () => undefined, emit: () => {},
      history: async () => ({ ref: { harness, nativeId: "resumed", path: "resumed-store", bytes: record.length }, entries: record, start: 0, total: record.length, hasEarlier: false, checkpoint: record.length }),
    })
    try {
      const after = (await later.refreshedSnapshot(turned))!
      assert.equal(after.baseLiveStart, moved.length, `${harness}: the live part begins after the moved history`)
      assert.equal(after.baseCoveredBlocks, 3)
      const users = projectLive(after).messages.filter((message) => message.role === "user")
      assert.equal(users.length, 2, `${harness}: each prompt once`)
    } finally {
      later.stop()
    }
    console.log(`PASS: ${harness} resumed with only opening notices live reads its history, holds back for an uncovered turn, and lines the next turn up after it`)
  } finally {
    owner.stop()
    rmSync(resumedRoot, { recursive: true, force: true })
  }
}

// A fork Mako seeded into a harness's store: the store keeps tool calls as text,
// so a refresh keeps Mako's own record of the seed and adds what the harness wrote after it.
const { historyDigest, messageDigest } = await import("@mako/host/conversations/native-history")
const { messagesFromEntries } = await import("@mako/sessions")
const seededRoot = mkdtempSync(join(tmpdir(), "mako-history-seeded-"))
try {
  const own: ThreadPage["entries"] = [
    { type: "user", id: "s1", text: "Find the deploy script" },
    { type: "tool", id: "s2", name: "bash", status: "failed", input: "rg deploy", output: "scripts/deploy.sh" },
    { type: "text", id: "s2:1", text: "It is scripts/deploy.sh." },
    { type: "event", id: "s3", label: "Model changed" },
  ]
  const written: ThreadPage["entries"] = [
    { type: "user", id: "n1", text: "Find the deploy script" },
    { type: "text", id: "n2", text: "[tool: bash — failed]\ninput: rg deploy\noutput: scripts/deploy.sh\n\nIt is scripts/deploy.sh." },
  ]
  const added: ThreadPage["entries"] = [{ type: "user", id: "n3", text: "Now run it" }, { type: "text", id: "n4", text: "Ran it." }]
  // A seed taken now counts entries; one taken before entries counted messages, under that day's digest.
  const seeds = {
    entries: { native: written.length, entries: own.length, digest: historyDigest(written), unit: "entry" as const },
    messages: { native: messagesFromEntries(written).length, entries: messagesFromEntries(own).length, digest: messageDigest(messagesFromEntries(written)) },
  }
  for (const [unit, seeded] of Object.entries(seeds)) {
    let store = [...written, ...added]
    let bytes = 2
    const conversation = randomUUID()
    const journal = new LiveJournal(seededRoot, conversation)
    journal.commit({
      session: { id: conversation, harness: "claude", cwd: seededRoot, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [] },
      revision: 0, createdAt: 1, permissions: [], requests: [], blocks: [],
      base: { ref: { harness: "claude", nativeId: "seeded", path: "seeded.jsonl", bytes: 1 }, entries: own, start: 0, total: own.length, hasEarlier: false },
      control: {
        activeBindingId: conversation, transfers: [], actions: [], merges: [],
        bindings: [{ id: conversation, provider: "claude", nativeId: "seeded", path: "seeded.jsonl", includesBase: true, coveredBlocks: 0, seeded }],
      },
    })
    journal.close()
    const seededOwner = new LiveConversations({
      root: seededRoot, appPath: seededRoot, driver: () => undefined, emit: () => {},
      history: async () => ({ ref: { harness: "claude", nativeId: "seeded", path: "seeded.jsonl", bytes }, entries: store, start: 0, total: store.length, hasEarlier: false, checkpoint: bytes }),
    })
    try {
      const shown = (await seededOwner.refreshedSnapshot(conversation))!.base!
      assert.deepEqual(shown.entries, [...own, ...added], "the seed shows as Mako recorded it, tool calls and all, then the harness's turns")
      assert.equal(shown.total, store.length, "the page keeps the store's own count, so an unchanged store reads as unchanged")
      store = [...store, { type: "user", id: "n5", text: "And again" }]
      bytes++
      assert.deepEqual((await seededOwner.refreshedSnapshot(conversation))!.base!.entries, [...own, ...store.slice(written.length)], "a later refresh keeps the seed in front")
      store = [{ type: "user", id: "c1", text: "Compacted summary" }, ...added]
      bytes++
      assert.deepEqual((await seededOwner.refreshedSnapshot(conversation))!.base!.entries, store, "a store the harness rewrote shows as the harness has it")
    } finally {
      seededOwner.stop()
    }
    console.log(`PASS: a seeded fork (its seed counted in ${unit}) keeps Mako's record of the seed ahead of the harness's turns, and yields to a store the harness rewrote`)
  }
} finally { rmSync(seededRoot, { recursive: true, force: true }) }

// The reader contract permits no checkpoint. Exercise the same lifecycle and
// durability rules for every shipped provider, without inventing native evidence.
for (const harness of registeredHarnessIds()) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "mako-refresh-lifecycle-"))
  const conversation = randomUUID()
  let page: ThreadPage = {
    ref: { harness, nativeId: "native", path: "native-store", bytes: 1 },
    entries: [{ type: "user", id: "question", text: "Original" }],
    start: 0, total: 1, hasEarlier: false,
  }
  let finish!: (value: ThreadPage | null) => void
  let fail!: (error: Error) => void
  let read = () => Promise.resolve<ThreadPage | null>(page)
  let reads = 0
  let batches = 0
  const owner = new LiveConversations({
    root: fixtureRoot, appPath: fixtureRoot, driver: () => undefined,
    emit: (event) => { if (event.type === "live-batch") batches++ },
    history: () => { reads++; return read() },
  })
  const delayRead = () => {
    const pending = new Promise<ThreadPage | null>((resolve, reject) => { finish = resolve; fail = reject })
    read = () => pending
  }
  try {
    delayRead()
    const capture = owner.capture(conversation, "native-store")
    assert.equal(owner.lifecycleWork()[0]?.title, "Saving a conversation", "initial capture still protects unsaved history")
    finish(page)
    await capture
    const original = owner.snapshot(conversation)!
    delayRead()
    const first = owner.refreshedSnapshot(conversation)
    const second = owner.refreshedSnapshot(conversation)
    assert.equal(reads, 2, "concurrent refreshes share one read")
    assert.deepEqual(owner.lifecycleWork(), [], "a read of durable history is not an unsaved capture")
    finish(page)
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual(a, b)
    assert.equal(a?.revision, original.revision, "unchanged checkpoint-free history emits no revision")
    const emitted = batches
    // Same size, timestamp, count and IDs are not authoritative equality.
    page = { ...page, entries: [{ type: "user", id: "question", text: "Modified" }] }
    read = () => Promise.resolve(page)
    const changed = await owner.refreshedSnapshot(conversation)
    assert.deepEqual(changed?.base?.entries, page.entries)
    assert.equal(batches, emitted + 1, "changed contents are committed even without a revision stamp")
    delayRead()
    const failed = owner.refreshedSnapshot(conversation)
    fail(new Error("fixture reader unavailable"))
    assert.equal((await failed)?.revision, changed?.revision, "reader failure retains durable history")
    read = () => Promise.resolve(page)
    assert.equal((await owner.refreshedSnapshot(conversation))?.revision, changed?.revision, "failure releases the coalesced read for retry")
    delayRead()
    const late = owner.refreshedSnapshot(conversation)
    owner.stop()
    const stoppedBatches = batches
    finish({ ...page, entries: [{ type: "user", id: "question", text: "Arrived after shutdown" }] })
    await late
    assert.equal(batches, stoppedBatches, "a late read cannot commit after journals close")
    const retained = new LiveJournal(fixtureRoot, conversation)
    assert.deepEqual(retained.read()?.base?.entries, page.entries)
    retained.close()
    console.log(`PASS: ${harness} delayed refresh, capture safety, coalescing, checkpoint-free changes, failure/retry and shutdown`)
  } finally {
    owner.stop()
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

// Measure the fallback for a large checkpoint-free history. No metadata shortcut
// may miss same-size edits; this path must compare the actual retained contents.
const largeRoot = mkdtempSync(join(tmpdir(), "mako-refresh-large-"))
const largeId = randomUUID()
const largeEntries: ThreadPage["entries"] = Array.from({ length: 10_000 }, (_, i) => ({ type: "user", id: `u${i}`, text: `${i}: ${"x".repeat(256)}` }))
let largeReads = 0
const large = new LiveConversations({
  root: largeRoot, appPath: largeRoot, driver: () => undefined, emit: () => {},
  history: async (_path, before = largeEntries.length) => {
    largeReads++
    const start = Math.max(0, before - 100)
    return { ref: { harness: "opencode", path: "large-store", nativeId: "large", bytes: 1 }, entries: structuredClone(largeEntries.slice(start, before)), start, total: largeEntries.length, hasEarlier: start > 0 }
  },
})
try {
  await large.capture(largeId, "large-store")
  const revision = large.snapshot(largeId)!.revision
  const started = performance.now()
  const reads = largeReads
  await large.refreshedSnapshot(largeId)
  assert.equal(large.snapshot(largeId)!.revision, revision)
  assert.equal(largeReads - reads, 100)
  console.log(`PASS: checkpoint-free 10,000-entry refresh: ${(performance.now() - started).toFixed(2)} ms, 100 pages, no journal revision`)
} finally {
  large.stop()
  rmSync(largeRoot, { recursive: true, force: true })
}

// Optional private reproduction: point at a directory containing a SQLite
// backup, never the user's live journal. Reads the real native store only.
if (process.env.MAKO_HISTORY_REPRO_COPY) {
  const { CodexProvider } = await import("../packages/sessions/src/providers/codex.ts")
  const { SessionCatalog } = await import("../packages/sessions/src/catalog.ts")
  const catalog = new SessionCatalog([new CodexProvider(nativeStores)])
  const copiedRoot = process.env.MAKO_HISTORY_REPRO_COPY
  assert.ok(copiedRoot.startsWith(tmpdir()) || copiedRoot.startsWith("/tmp/"), "reproduction must use a temporary backup")
  const repro = new LiveConversations({ root: copiedRoot, appPath: copiedRoot, driver: () => undefined, emit: () => {}, history: (path, before) => catalog.page(path, before) })
  const summary = repro.summaries()[0]!
  const before = repro.snapshot(summary.session.id)!
  assert.equal(before.base, null)
  assert.ok(before.blocks.length > 900)
  const next = (await repro.refreshedSnapshot(summary.session.id))!
  assert.ok(next.base && next.base.entries.length > 0)
  assert.equal(next.baseCoveredBlocks, before.blocks.length)
  assert.deepEqual(next.blocks, before.blocks)
  assert.deepEqual(next.requests, before.requests)
  const latestUser = next.base.entries.findLast((entry) => entry.type === "user")!
  const projection = projectLive(next)
  assert.ok(latestUser.type === "user" && projection.messages.some((message) => message.role === "user" && message.blocks.some((block) => block.type === "text" && block.text === latestUser.text)))
  console.log(`PASS: actual journal backup (${before.blocks.length} preserved blocks); ${next.base.entries.length} native entries; latest native question rendered; ${next.requests.length} requests unchanged`)
}
