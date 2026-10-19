import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage } from "@mako/sessions"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { copiedBaseBytes, LiveJournal } from "@mako/host/conversations/live-journal"
import { baseFromSource, storedBase } from "@mako/host/conversations/base-source"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// A journal keeps the source of a fully covered history instead of a copy of
// it once the record store holds the session; it reads the history back on
// load, and nothing reaches the harness until it has.

const harness = "test-provider"
const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((yes) => { resolve = yes })
  return { promise, resolve }
}

function pageOf(path: string, texts: string[], translator = "build-2"): ThreadPage {
  return {
    ref: { harness, nativeId: "native-1", path, bytes: texts.length * 100, title: "Fix the rail", cwd: "/tmp" },
    entries: texts.map((text, index) => index % 2 === 0
      ? { type: "user" as const, id: `entry-${index}`, text }
      : { type: "text" as const, id: `entry-${index}`, text }),
    start: 0, total: texts.length, hasEarlier: false, translator,
  }
}

interface Native {
  /** Where the harness keeps the session now. */
  at: string
  page: ThreadPage | null
  stale: ThreadPage | null
  gate: ReturnType<typeof deferred<void>> | null
  reads: number
  holds: string[]
  hold: boolean
  /** What Mako's record store had captured of the session, by when it captured it. */
  captured: { at: number; page: ThreadPage }[]
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mako-base-source-"))
  const path = join(root, "native-session.jsonl")
  const native: Native = { at: path, page: pageOf(path, ["first ask", "first answer", "second ask", "second answer"]), stale: null, gate: null, reads: 0, holds: [], hold: true, captured: [] }
  const starts: string[] = []
  const sent: string[] = []
  const events: HostEvent[] = []
  const state = (id: string): LiveSessionState => ({
    id, nativeId: "native-1", nativePath: path, harness, cwd: "/tmp", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [],
  })
  writeFileSync(path, "")
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: "fixture" },
    launchEnvironment: { kind: "unavailable", reason: "fixture" },
    nativeIdentity: { kind: "unavailable", reason: "fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "fixture", feedback: { kind: "next-message", reason: "fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "fixture" },
    turnRecovery: { kind: "manual", reason: "fixture" },
    resume: fixtureResume(),
    provider: harness,
    available: () => true,
    start: async (bindingId) => { starts.push(bindingId); return state(bindingId) },
    prompt: async (_id, text) => { sent.push(text); await new Promise<void>(() => {}) },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  const journals = join(root, "conversations")
  const host = () => new LiveConversations({
    appPath: root,
    root: journals,
    driver: () => driver,
    emit: (event) => events.push(event),
    history: async (at) => {
      native.reads++
      if (native.gate) await native.gate.promise
      return at === native.at ? native.page : null
    },
    staleHistory: async (at) => at === native.at ? native.stale : null,
    holdHistory: async (at) => {
      native.holds.push(at)
      if (native.hold && native.page) native.captured.push({ at: Date.now(), page: native.page })
      return native.hold
    },
    historyAsOf: async (at, asOf) => at === native.at ? native.captured.findLast((capture) => capture.at <= asOf)?.page ?? null : null,
    nativePath: (identity) => identity.harness === harness && identity.nativeId === "native-1" ? native.at : undefined,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  return { root, path, journals, native, starts, sent, events, host, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Imported, held, and opened again by the next host: the history comes from the session, the journal holds none of it. */
async function dropsAndReadsBack() {
  const f = fixture()
  const id = randomUUID()
  try {
    const first = f.host()
    await first.capture(id, f.path)
    await waitFor(() => Boolean(first.snapshot(id)?.baseSource), "the journal names its source once the session is held")
    assert.deepEqual(f.native.holds, [f.path], "the session is held once")
    assert.equal(copiedBaseBytes(f.journals, id), 0, "the journal keeps no copy of the history")
    const kept = first.snapshot(id)!
    assert.ok(baseFromSource(kept), "a fully covered import is read from its source")
    await first.stop()

    // A rebuild: the next host's decoder reads the session again.
    f.native.page = pageOf(f.path, ["first ask", "first answer", "second ask", "second answer"], "build-3")
    f.native.gate = deferred<void>()
    const second = f.host()
    const unread = second.snapshot(id)!
    assert.equal(unread.base, null, "the base is unread until the session answers")
    assert.deepEqual(unread.baseSource, { harness, nativeId: "native-1", path: f.path })
    second.submit(id, randomUUID(), "third ask")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(f.sent, [], "no message reaches the harness while the history it continues is unread; its process may start meanwhile")
    f.native.gate.resolve()
    f.native.gate = null
    await waitFor(() => second.snapshot(id)?.base !== null, "the base is read from its session")
    assert.deepEqual(second.snapshot(id)!.base!.entries, f.native.page.entries, "the history read is the session's")
    assert.equal(second.snapshot(id)!.base!.translator, "build-3", "read by this build's decoder")
    await waitFor(() => f.sent.length === 1, "the queued message goes once the history is read").catch((error) => {
      const now = second.snapshot(id)!
      console.error({ starts: f.starts, status: now.session.status, connection: now.session.connection, requests: now.requests.map((request) => [request.status, request.error]), notices: f.events.filter((event) => event.type === "notice") })
      throw error
    })
    assert.match(f.sent[0]!, /third ask/)
    await second.stop()
    console.log("PASS: dropped on hold, read back on load, drain waits for it")
  } finally {
    f.cleanup()
  }
}

/** The page is written back the moment the live blocks move past what the session covered. */
function materializesWhenPartial() {
  const f = fixture()
  const id = randomUUID()
  try {
    const page = f.native.page!
    const snapshot: LiveSnapshot = {
      session: { id, harness, nativeId: "native-1", cwd: "/tmp", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
      revision: 1, createdAt: Date.now(), threadPath: f.path, base: page, baseCoveredBlocks: 0,
      baseSource: { harness, nativeId: "native-1", path: f.path },
      blocks: [], permissions: [], requests: [],
      control: { merges: [], activeBindingId: id, transfers: [], bindings: [{ id, provider: harness, nativeId: "native-1", path: f.path, coveredBlocks: 0, includesBase: true }] },
    }
    const journal = new LiveJournal(f.journals, id)
    journal.commit(snapshot)
    assert.equal(storedBase(snapshot), null)
    assert.equal(copiedBaseBytes(f.journals, id), 0, "fully covered: no copy")
    const running: LiveSnapshot = { ...snapshot, revision: 2, blocks: [{ type: "text", text: "a live answer" }] }
    assert.ok(!baseFromSource(running), "a block past the covered prefix needs the exact reading")
    journal.commit(running, snapshot)
    assert.ok(copiedBaseBytes(f.journals, id) > 0, "the page is written back")
    const reread = journal.read()!
    assert.deepEqual(reread.base, page, "a crash now reads the exact page back")
    const covered: LiveSnapshot = {
      ...running, revision: 3, baseCoveredBlocks: 1,
      control: { ...running.control!, bindings: [{ ...running.control!.bindings[0]!, coveredBlocks: 1 }] },
    }
    journal.commit(covered, running)
    assert.equal(copiedBaseBytes(f.journals, id), 0, "covered again: the copy goes")
    const seeded: LiveSnapshot = { ...covered, revision: 4, control: { ...covered.control!, bindings: [{ ...covered.control!.bindings[0]!, seeded: { native: 2, entries: 2, digest: "seeded" } }] } }
    journal.commit(seeded, covered)
    assert.ok(copiedBaseBytes(f.journals, id) > 0, "a seeded store's base is only in the journal")
    journal.close()
    console.log("PASS: written back when coverage goes partial or seeded, dropped when covered again")
  } finally {
    f.cleanup()
  }
}

/** A build that changed the decoder shows the view the last build made at once, then reads the session again. */
async function staleViewThenRefresh() {
  const f = fixture()
  const id = randomUUID()
  try {
    const first = f.host()
    await first.capture(id, f.path)
    await waitFor(() => Boolean(first.snapshot(id)?.baseSource), "held")
    await first.stop()
    f.native.stale = pageOf(f.path, ["first ask", "first answer", "second ask", "second answer"], "build-1")
    f.native.page = pageOf(f.path, ["first ask", "first answer", "second ask", "second answer"], "build-3")
    f.native.gate = deferred<void>()
    const second = f.host()
    second.snapshot(id)
    await waitFor(() => second.snapshot(id)?.base?.translator === "build-1", "the stale view answers first")
    assert.equal(second.snapshot(id)!.historyFailure, undefined)
    const refreshed = second.refreshedSnapshot(id)
    f.native.gate.resolve()
    f.native.gate = null
    await refreshed
    await waitFor(() => second.snapshot(id)?.base?.translator === "build-3" && Boolean(second.snapshot(id)?.baseSource), "refresh reads this build's translation and holds it")
    assert.equal(copiedBaseBytes(f.journals, id), 0)
    await second.stop()
    console.log("PASS: stale view first, this build's read after")
  } finally {
    f.cleanup()
  }
}

/** Turns the harness recorded outside Mako are part of the history read back. */
async function readsGrowth() {
  const f = fixture()
  const id = randomUUID()
  try {
    const first = f.host()
    await first.capture(id, f.path)
    await waitFor(() => Boolean(first.snapshot(id)?.baseSource), "held")
    await first.stop()
    f.native.page = pageOf(f.path, ["first ask", "first answer", "second ask", "second answer", "asked in the CLI", "answered there"])
    const second = f.host()
    second.snapshot(id)
    await waitFor(() => second.snapshot(id)?.base?.entries.length === 6, "the session's newer turns are read")
    await second.stop()
    console.log("PASS: growth outside Mako is read back")
  } finally {
    f.cleanup()
  }
}

/** Codex compresses an idle rollout in place: the session is found by its identity, its history read with no new copy or hold. */
async function followsMovedSession() {
  const f = fixture()
  const id = randomUUID()
  try {
    const first = f.host()
    await first.capture(id, f.path)
    await waitFor(() => Boolean(first.snapshot(id)?.baseSource), "held")
    await first.stop()
    f.native.at = `${f.path}.zst`
    f.native.page = { ...pageOf(f.native.at, ["first ask", "first answer", "second ask", "second answer"]), ref: { ...pageOf(f.native.at, []).ref, bytes: 120 } }
    const second = f.host()
    second.snapshot(id)
    await waitFor(() => second.snapshot(id)?.base !== null, "the moved session is read")
    assert.equal(second.snapshot(id)!.historyFailure, undefined)
    assert.deepEqual(second.snapshot(id)!.base!.entries, f.native.page.entries)
    await second.refreshedSnapshot(id)
    assert.ok(second.snapshot(id)!.baseSource, "the same history stays held")
    assert.deepEqual(f.native.holds, [f.path], "nothing is held again")
    assert.equal(copiedBaseBytes(f.journals, id), 0, "and nothing copied")
    second.submit(id, randomUUID(), "third ask")
    await waitFor(() => f.sent.length === 1, "the conversation goes on")
    await second.stop()
    console.log("PASS: a session its harness moved is read where it is now")
  } finally {
    f.cleanup()
  }
}

/** A journal from before base sources whose session moved since: the sweep finds it and drops the copy. */
async function settlesMovedCopy() {
  const f = fixture()
  f.native.hold = false
  const id = randomUUID()
  try {
    const first = f.host()
    await first.capture(id, f.path)
    await waitFor(() => f.native.holds.length === 1, "asked")
    await first.stop()
    assert.ok(copiedBaseBytes(f.journals, id) > 0)
    f.native.at = `${f.path}.zst`
    f.native.page = pageOf(f.native.at, ["first ask", "first answer", "second ask", "second answer"])
    f.native.hold = true
    const second = f.host()
    const settled = await second.settleHistoryCopies(0)
    assert.equal(settled.moved, 1, JSON.stringify(settled))
    assert.equal(f.native.holds.at(-1), f.native.at, "the session is held where it is now")
    assert.equal(copiedBaseBytes(f.journals, id), 0)
    await second.stop()
    const third = f.host()
    assert.deepEqual(third.snapshot(id)!.baseSource?.path, f.native.at)
    await waitFor(() => third.snapshot(id)?.base !== null, "read back")
    await third.stop()
    console.log("PASS: the sweep drops a copy whose session moved")
  } finally {
    f.cleanup()
  }
}

/** The sweep asks the record store again for a session it refused, and skips a journal kept for a reason of its own until it changes. */
async function sweepsAgain() {
  const f = fixture()
  f.native.hold = false
  const refused = randomUUID()
  const twoSessions = randomUUID()
  const second = randomUUID()
  try {
    const first = f.host()
    await first.capture(refused, f.path)
    await waitFor(() => f.native.holds.length === 1, "asked")
    await first.stop()
    const page = f.native.page!
    const journal = new LiveJournal(f.journals, twoSessions)
    journal.commit({
      session: { id: twoSessions, harness, nativeId: "native-1", cwd: "/tmp", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
      revision: 1, createdAt: Date.now(), threadPath: f.path, base: page, baseCoveredBlocks: 1,
      blocks: [{ type: "text", text: "an answer from the second session" }], permissions: [], requests: [],
      control: { merges: [], activeBindingId: second, transfers: [], bindings: [
        { id: twoSessions, provider: harness, nativeId: "native-1", path: f.path, coveredBlocks: 0, includesBase: true },
        { id: second, provider: harness, nativeId: "native-2", path: `${f.path}.second`, coveredBlocks: 1, includesBase: false },
      ] },
    })
    journal.close()
    // Gone on in two sessions, neither of them the one its history came from: a reason of its own.
    const elsewhere = randomUUID()
    const elsewhereJournal = new LiveJournal(f.journals, elsewhere)
    elsewhereJournal.commit({
      session: { id: elsewhere, harness, nativeId: "native-2", cwd: "/tmp", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
      revision: 1, createdAt: Date.now(), threadPath: f.path, base: page,
      blocks: [{ type: "text", text: "an answer from another session" }], permissions: [], requests: [],
      control: { merges: [], activeBindingId: second, transfers: [], bindings: [
        { id: elsewhere, provider: harness, nativeId: "native-2", path: `${f.path}.second`, coveredBlocks: 0, includesBase: false },
        { id: second, provider: harness, nativeId: "native-3", path: `${f.path}.third`, coveredBlocks: 1, includesBase: false },
      ] },
    })
    elsewhereJournal.close()
    const host = f.host()
    const once = await host.settleHistoryCopies(0)
    assert.equal(once.copies, 3, JSON.stringify(once))
    assert.equal(once.journals.find((entry) => entry.id === twoSessions)?.keptBecause, "the record store doesn't hold its session",
      "gone on in two sessions, it waits only for the store to hold the first")
    assert.equal(once.journals.find((entry) => entry.id === elsewhere)?.keptBecause, "the conversation went on in 2 sessions, none of them the one its history came from")
    assert.equal(once.journals.find((entry) => entry.id === refused)?.keptBecause, "the record store doesn't hold its session")
    f.native.hold = true
    const again = await host.settleHistoryCopies(0)
    assert.deepEqual(again.journals.map((entry) => entry.id).sort(), [refused, twoSessions].sort(), "the refused holds are asked again; the journal kept for its own reason is skipped")
    assert.equal(again.moved, 2)
    assert.equal(copiedBaseBytes(f.journals, refused), 0)
    assert.equal(copiedBaseBytes(f.journals, twoSessions), 0, "the two-session journal names a span of its first session")
    assert.ok(copiedBaseBytes(f.journals, elsewhere) > 0)
    await host.stop()
    console.log("PASS: the sweep retries a refused hold, moves a conversation that went on in two sessions, and skips what keeps its copy for its own reason")
  } finally {
    f.cleanup()
  }
}

/** A session nobody has any more is shown as unreadable, and messages still go. */
async function unreadable() {
  const f = fixture()
  const id = randomUUID()
  try {
    const first = f.host()
    await first.capture(id, f.path)
    await waitFor(() => Boolean(first.snapshot(id)?.baseSource), "held")
    await first.stop()
    f.native.page = null
    const second = f.host()
    second.snapshot(id)
    await waitFor(() => Boolean(second.snapshot(id)?.historyFailure), "the failure is shown")
    assert.equal(second.snapshot(id)!.base, null)
    const batch = f.events.find((event) => event.type === "live-batch" && event.batch.id === id && Boolean(event.batch.historyFailure))
    assert.ok(batch, "windows hear of the failure")
    second.submit(id, randomUUID(), "still there?")
    await waitFor(() => f.sent.length === 1, "a message goes without the history")
    await second.stop()
    console.log("PASS: unreadable history is shown and doesn't block messages")
  } finally {
    f.cleanup()
  }
}

/** Without the record store's word, the journal keeps its copy. */
/**
 * A conversation that went on in two sessions keeps no copy of its history:
 * it names the span of its first session the history is, proven exact when
 * held, and reads it back from the session while the session still begins
 * so, else from what the record store had captured, else says why not.
 */
async function spansSessions() {
  const f = fixture()
  const id = randomUUID()
  const second = randomUUID()
  try {
    const page = f.native.page!
    const journal = new LiveJournal(f.journals, id)
    journal.commit({
      session: { id, harness, nativeId: "native-2", cwd: "/tmp", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
      revision: 1, createdAt: Date.now(), threadPath: f.path, base: page,
      blocks: [{ type: "user", requestId: randomUUID(), text: "asked the second session" }, { type: "text", text: "an answer from the second session" }],
      permissions: [], requests: [],
      control: { merges: [], activeBindingId: second, transfers: [], bindings: [
        { id, provider: harness, nativeId: "native-1", path: f.path, coveredBlocks: 0, includesBase: true },
        { id: second, provider: harness, nativeId: "native-2", path: `${f.path}.second`, coveredBlocks: 2, includesBase: false },
      ] },
    })
    journal.close()
    const first = f.host()
    const swept = await first.settleHistoryCopies(0)
    assert.equal(swept.moved, 1, JSON.stringify(swept))
    const source = first.snapshot(id)!.baseSource!
    assert.equal(source.span?.entries, page.entries.length, "the span is the history's record entries")
    assert.equal(copiedBaseBytes(f.journals, id), 0)
    await first.stop()

    // The first session went on outside Mako: the span is still how it begins.
    f.native.page = pageOf(f.path, ["first ask", "first answer", "second ask", "second answer", "asked in a terminal", "answered there"])
    const grown = f.host()
    await grown.refreshedSnapshot(id)
    assert.deepEqual(grown.snapshot(id)!.base!.entries, page.entries, "read back as the span it was, not the turns the session took since")
    await grown.stop()

    // Its harness rewrote it: the record store gives the span as it was captured.
    f.native.page = pageOf(f.path, ["rewound ask", "another answer"])
    const rewritten = f.host()
    await rewritten.refreshedSnapshot(id)
    assert.deepEqual(rewritten.snapshot(id)!.base!.entries, page.entries, "read from Mako's records as the conversation continued it")
    await rewritten.stop()

    // Neither holds it: the conversation says so, and keeps its live turns.
    f.native.captured = []
    const lost = f.host()
    await lost.refreshedSnapshot(id)
    assert.equal(lost.snapshot(id)!.base, null)
    assert.match(lost.snapshot(id)!.historyFailure ?? "", /rewritten since this conversation went on in another/)
    assert.equal(lost.snapshot(id)!.blocks.length, 2)
    await lost.stop()
    console.log("PASS: a conversation that went on in two sessions names a span of the first, proven when held, read back while the session begins so, else from Mako's records")
  } finally {
    f.cleanup()
  }
}

async function keepsWithoutHold() {
  const f = fixture()
  f.native.hold = false
  const id = randomUUID()
  try {
    const first = f.host()
    await first.capture(id, f.path)
    await waitFor(() => f.native.holds.length === 1, "asked")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(first.snapshot(id)!.baseSource, undefined)
    assert.ok(copiedBaseBytes(f.journals, id) > 0, "the copy stays")
    await first.stop()
    const second = f.host()
    assert.deepEqual(second.snapshot(id)!.base!.entries, f.native.page!.entries, "the copy reads as before")
    await second.stop()
    console.log("PASS: a session the record store doesn't hold keeps its copy")
  } finally {
    f.cleanup()
  }
}

await dropsAndReadsBack()
materializesWhenPartial()
await staleViewThenRefresh()
await readsGrowth()
await followsMovedSession()
await settlesMovedCopy()
await sweepsAgain()
await spansSessions()
await unreadable()
await keepsWithoutHold()
