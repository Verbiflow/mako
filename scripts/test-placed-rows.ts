import assert from "node:assert/strict"
import { test } from "node:test"
import type { ListedFin, ListedSession } from "@mako/protocol/thread-listing"
import { listedApexOf, listedSummary } from "@mako/host/contracts/listed-conversations"
import { childEntry, type ThreadParent } from "@mako/host/contracts/agents"
import { childStateOf } from "@mako/host/contracts/children"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { apexViewStore, finOpening, openFinInApex, threadChildren } from "../src/state/apex-fins"
import { acpStore, conversationRoster, conversationWork, threadChildren as sharedThreadChildren } from "../src/state/acp-state"
import { listLive } from "../src/state/live-recovery"
import { foldThreads, placedUnder, threadById } from "../src/web-client/threads"
import { waitingThreads, webInboxCount } from "../src/web-client/inbox"

/**
 * A Fin placed on another device, as every client lists it (decision D6): the device running it writes its row, and
 * every other device shows that row under its Apex, never as a Thread of its own, and opens it from there with that
 * device answering. The Apex's device being off changes nothing of that: the row is the Fin's device's, so what the
 * Fin asks reaches the person from under its Apex. A Fin whose device never listed it opens nothing, and its row says
 * so, rather than a view with nothing behind it.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const MAC = uuid(900)
const LOFT = uuid(901)
const APEX_THREAD = uuid(100)
const APEX_SESSION = uuid(1)
const FIN_THREAD = uuid(200)
const FIN_SESSION = uuid(2)
const at = (minutes: number) => new Date(Date.parse("2026-11-06T12:00:00Z") + minutes * 60_000).toISOString()
const devices = new Map([
  [MAC, { id: MAC, kind: "desktop", name: "MacBook", platform: "macOS" }],
  [LOFT, { id: LOFT, kind: "runtime", name: "Loft", platform: "Linux x64 · Debian GNU/Linux 12" }],
])

function row(fields: Partial<ListedSession> & Pick<ListedSession, "session" | "thread" | "conversation">): ListedSession {
  return { harness: "claude", state: "idle", folder: "/Users/ana/mako", createdAt: at(0), activityAt: at(1), generation: 1, runsOn: { kind: "device", deviceId: MAC }, listedAt: at(1), ...fields }
}

/** The Apex's row, as its Mac writes it: its Fins named, the placed one among them as the Mac last heard it. */
const finOfApex: ListedFin = { thread: FIN_THREAD, name: "asker", harness: "opencode", title: "Approval proof", state: { kind: "blocked", question: "Approve: echo HOTEL", on: "approval" }, startedAt: at(0) }
const apexRow = row({ session: APEX_SESSION, thread: APEX_THREAD, conversation: "c-apex", threadTitle: "Placed Fins proof", title: "Placed Fins proof", state: "working", fins: [finOfApex] })
/** The Fin's own row, as Loft writes it: waiting on an approval there. */
const finRow = row({ session: FIN_SESSION, thread: FIN_THREAD, conversation: "c-fin", harness: "opencode", title: "Approval proof", state: "waiting", waitingOn: "Approve: echo HOTEL", waitingFor: "approval", folder: "/data/worktrees/hello-world/approval-proof", runsOn: { kind: "device", deviceId: LOFT }, activityAt: at(3), order: 1 })
/** Another Session nobody's row names: a Thread of its own. */
const loneRow = row({ session: uuid(3), thread: uuid(300), conversation: "c-lone", title: "Release notes", runsOn: { kind: "device", deviceId: LOFT } })

test("C2: a placed Fin's row is its Apex's to show, not a Thread of its own, on every device but its own", () => {
  assert.deepEqual(listedApexOf(finRow, [apexRow, finRow, loneRow]), { thread: APEX_THREAD, session: APEX_SESSION }, "the Apex's row names the Fin among its Fins")
  assert.equal(listedApexOf(loneRow, [apexRow, finRow, loneRow]), undefined, "a row no Apex names stands on its own")
  assert.equal(listedApexOf(apexRow, [apexRow, finRow]), undefined, "an Apex's own row is nobody's Fin")
  // The host's mapping for a Mac's window: the Fin's listed conversation carries its Apex, so the rail nests it.
  const summary = listedSummary(finRow, "Loft", undefined, undefined, listedApexOf(finRow, [apexRow, finRow]))
  assert.deepEqual(summary.parent, { thread: APEX_THREAD, session: APEX_SESSION })
  assert.equal(summary.waitingFor, "approval")
  // The browser's fold: the Fin is under its Apex, with its device, and never among the Threads.
  const folded = foldThreads({ rows: [apexRow, finRow, loneRow], devices, quiet: new Map(), waiting: new Map(), archived: [] })
  assert.deepEqual(folded.threads.map((thread) => thread.id).sort(), [APEX_THREAD, uuid(300)].sort(), "the Threads: the Apex and the lone one")
  assert.deepEqual(placedUnder(folded, APEX_THREAD).map((thread) => [thread.id, thread.apex?.title, thread.where, thread.standing]), [[FIN_THREAD, "Placed Fins proof", "Loft", "waiting"]])
  assert.equal(threadById(folded, (thread) => thread.id === FIN_THREAD)?.apex?.thread, APEX_THREAD, "a route to the Fin still finds it")
  // Under Needs you it's a row of its own, opening where it's answered; its Apex's row doesn't stand in for it.
  const needs = waitingThreads(folded.threads, [], folded.placed)
  assert.deepEqual(needs.map((thread) => thread.id), [FIN_THREAD])
  assert.equal(webInboxCount(folded.threads, [], folded.placed), 1)
})

test("the Apex's device off: the Fin's row, written by its own device, still says what it asks, under its Apex", () => {
  const quiet = new Map([[MAC, at(-30)]])
  const folded = foldThreads({ rows: [apexRow, finRow], devices, quiet, waiting: new Map(), archived: [] })
  const apex = folded.threads.find((thread) => thread.id === APEX_THREAD)
  assert.equal(apex?.quietSince, at(-30), "the Apex's row is its quiet device's")
  assert.equal(apex?.standing, "idle", "and nothing of the Apex's is waiting on anyone")
  const fin = placedUnder(folded, APEX_THREAD)[0]
  assert.equal(fin?.standing, "waiting", "the Fin's row is Loft's, and Loft is heard")
  assert.equal(fin?.quietSince, undefined)
  assert.deepEqual(waitingThreads(folded.threads, [], folded.placed).map((thread) => thread.id), [FIN_THREAD], "so the person finds it under Needs you, and it opens on Loft")
  assert.equal(fin?.sessions[0]?.owner.kind === "device" && fin.sessions[0].owner.deviceId, LOFT)
  // A window's roster of the Apex, as its row says it, over the Fin's own listed conversation: at work on Loft's word, with Loft's conversation to open.
  acpStore.set({ activeKey: null, conversations: {} })
  const quietApex = listedSummary(apexRow, "MacBook", at(-30))
  const finListed = listedSummary(finRow, "Loft", undefined, undefined, listedApexOf(finRow, [apexRow, finRow]))
  listLive([quietApex, finListed])
  const children = threadChildren(acpStore.get(), APEX_THREAD)
  assert.equal(children.length, 1)
  assert.equal(children[0]?.child?.conversation, "c-fin", "the Fin's own conversation, Loft's")
  assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: "Approve: echo HOTEL", on: "approval" })
  assert.deepEqual(finOpening(acpStore.get(), children[0]!), { kind: "conversation", key: "c-fin" })
})

test("the Fin's device quiet: the Apex's word stands, and the row still opens Loft's conversation", () => {
  acpStore.set({ activeKey: null, conversations: {} })
  const apex = listedSummary(apexRow, "MacBook", undefined)
  const fin = listedSummary(row({ ...finRow, state: "working", waitingOn: undefined, waitingFor: undefined }), "Loft", at(-20), undefined, { thread: APEX_THREAD, session: APEX_SESSION })
  listLive([apex, fin])
  const children = threadChildren(acpStore.get(), APEX_THREAD)
  assert.equal(children[0]?.child?.conversation, "c-fin")
  assert.deepEqual(childStateOf(children[0]!), finOfApex.state, "a quiet device's row says nothing newer than its Apex")
})

/** The Apex's own device: its roster has the placed Fin as `childEntry` makes it, with no conversation here. */
function placedChild(): NativeAgent {
  const edge: ThreadParent = {
    child: ThreadIdSchema.parse(FIN_THREAD),
    parent: ThreadIdSchema.parse(APEX_THREAD),
    parentSession: SessionIdSchema.parse(APEX_SESSION),
    name: "asker",
    role: "worker",
    origin: "started",
    asked: { brief: { objective: "Run the command you're given." }, harness: "opencode", place: "device:Loft" },
    op: `start:${APEX_SESSION}:asker`,
    startedBy: { kind: "agent", session: SessionIdSchema.parse(APEX_SESSION) },
    createdAt: Date.parse(at(0)),
    placed: { target: { kind: "device", device: LOFT, name: "Loft" }, working: false, epoch: 1 },
  }
  const latest = { id: `report:${FIN_THREAD}:to-person:1`, child: ThreadIdSchema.parse(FIN_THREAD), status: "blocked" as const, summary: "It waits: Approve: echo HOTEL", question: "Approve: echo HOTEL", for: "person" as const, told: true as const, implicit: true as const, ownerGeneration: 1, at: Date.parse(at(2)) }
  return childEntry(edge, { source: "placed", title: "Approval proof", harness: "opencode", startedAt: Date.parse(at(0)) }, { latest })
}

test("C1: a placed Fin's row opens its own conversation on its device, and opens nothing with no row behind it", () => {
  acpStore.set({ activeKey: null, conversations: {} })
  const child = placedChild()
  assert.equal(child.child?.conversation, undefined, "the Apex's device holds no conversation of it")
  assert.equal(finOpening(acpStore.get(), child), undefined, "with no row of it listed, nothing opens")
  openFinInApex(APEX_THREAD, "Placed Fins proof", child)
  assert.equal(apexViewStore.get().open, null, "and no Fin view is set with nothing behind it")
  assert.equal(acpStore.get().activeKey, null)
  // Loft's row arrives: the roster's entry takes its conversation and its word, and the row opens it.
  listLive([listedSummary(finRow, "Loft", undefined, undefined, { thread: APEX_THREAD, session: APEX_SESSION })])
  const children = threadChildren(acpStore.get(), APEX_THREAD)
  assert.equal(children.length, 0, "a listed Fin's conversation is no Apex's roster by itself")
  const opening = finOpening(acpStore.get(), child)
  assert.deepEqual(opening, { kind: "conversation", key: "c-fin" }, "the Fin's own conversation, listed from Loft, is what opens")
})

/** An older Session of the same placed Fin on Loft, idle: listed too, and never the one that opens. */
const OLD_FIN_SESSION = uuid(4)
const oldFinRow = row({ session: OLD_FIN_SESSION, thread: FIN_THREAD, conversation: "c-fin-old", harness: "opencode", title: "Approval proof", state: "idle", folder: "/data/worktrees/hello-world/approval-proof", runsOn: { kind: "device", deviceId: LOFT }, createdAt: at(-60), activityAt: at(-50), order: 0 })

// The Fin's Thread is Loft's: this window holds no group of it, so each row's place in it, which Loft wrote (`order`), ranks them.
test("a placed Fin with two Sessions on its device: its newest is the one its row opens and stands by, whichever is listed first", () => {
  const apex = { thread: APEX_THREAD, session: APEX_SESSION }
  assert.equal(acpStore.get().threadSessions?.[FIN_THREAD], undefined, "the Fin's Thread's group is its own device's, not held here")
  {
    for (const order of ["older first", "newest first"] as const) {
      acpStore.set({ activeKey: null, conversations: {} })
      const rows = order === "older first" ? [oldFinRow, finRow] : [finRow, oldFinRow]
      listLive([listedSummary(apexRow, "MacBook", undefined), ...rows.map((each) => listedSummary(each, "Loft", undefined, undefined, apex))])
      const children = threadChildren(acpStore.get(), APEX_THREAD)
      assert.equal(children.length, 1, order)
      assert.equal(children[0]?.child?.conversation, "c-fin", `${order}: the roster's entry is the newest Session's conversation`)
      assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: "Approve: echo HOTEL", on: "approval" }, `${order}: and stands as it does there, waiting on the approval`)
      assert.deepEqual(finOpening(acpStore.get(), children[0]!), { kind: "conversation", key: "c-fin" }, `${order}: from under the Apex it opens the approval`)
      assert.deepEqual(finOpening(acpStore.get(), placedChild()), { kind: "conversation", key: "c-fin" }, `${order}: and so does the Apex's own roster entry`)
    }
  }
})

// An open ask always surfaces: an older Session asking outranks a newer one idle, whichever is listed first.
test("a placed Fin whose older Session asks while its newer one is idle: the ask is what opens and stands, whichever is listed first", () => {
  const apex = { thread: APEX_THREAD, session: APEX_SESSION }
  const asking = row({ ...oldFinRow, state: "waiting", waitingOn: "Approve: echo HOTEL", waitingFor: "approval" })
  const idle = row({ ...finRow, state: "idle", waitingOn: undefined, waitingFor: undefined })
  for (const [order, rows] of [["older first", [asking, idle]], ["newest first", [idle, asking]]] as const) {
    acpStore.set({ activeKey: null, conversations: {}, threadSessions: {} })
    listLive([listedSummary(apexRow, "MacBook", undefined), ...rows.map((each) => listedSummary(each, "Loft", undefined, undefined, apex))])
    const children = threadChildren(acpStore.get(), APEX_THREAD)
    assert.equal(children[0]?.child?.conversation, "c-fin-old", `${order}: the asking Session's conversation`)
    assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: "Approve: echo HOTEL", on: "approval" }, `${order}: standing on its ask`)
    assert.deepEqual(finOpening(acpStore.get(), children[0]!), { kind: "conversation", key: "c-fin-old" }, `${order}: from under the Apex`)
    assert.deepEqual(finOpening(acpStore.get(), placedChild()), { kind: "conversation", key: "c-fin-old" }, `${order}: and from the Apex's own roster entry`)
  }
})

// An older Session waiting on the person for something other than an approval or a question (its owner's needs-you
// fallback, `conversationShown` with nothing more specific) outranks a newer idle one too: every kind the protocol's `asks` names.
test("a placed Fin whose older Session needs you, by its owner's fallback, while its newer one is idle: the wait is what opens and stands, whichever is listed first", () => {
  const apex = { thread: APEX_THREAD, session: APEX_SESSION }
  const needing = row({ ...oldFinRow, state: "waiting", waitingOn: "Waiting for you", waitingFor: "needs-you" })
  const idle = row({ ...finRow, state: "idle", waitingOn: undefined, waitingFor: undefined })
  for (const [order, rows] of [["older first", [needing, idle]], ["newest first", [idle, needing]]] as const) {
    acpStore.set({ activeKey: null, conversations: {}, threadSessions: {} })
    listLive([listedSummary(apexRow, "MacBook", undefined), ...rows.map((each) => listedSummary(each, "Loft", undefined, undefined, apex))])
    const children = threadChildren(acpStore.get(), APEX_THREAD)
    assert.equal(children[0]?.child?.conversation, "c-fin-old", `${order}: the waiting Session's conversation`)
    assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: "Waiting for you", on: "person" }, `${order}: standing on its wait`)
    assert.deepEqual(finOpening(acpStore.get(), children[0]!), { kind: "conversation", key: "c-fin-old" }, `${order}: from under the Apex`)
    assert.deepEqual(finOpening(acpStore.get(), placedChild()), { kind: "conversation", key: "c-fin-old" }, `${order}: and from the Apex's own roster entry`)
  }
})

// A host before link version 22 writes no `order`: its rows rank where they arrive, as every device did before.
test("rows from a host that says no order rank as they arrive: the first listed stands, whichever it is", () => {
  const apex = { thread: APEX_THREAD, session: APEX_SESSION }
  // Neither row asks anything, so nothing but arrival ranks them.
  const without = (each: ListedSession): ListedSession => ({ ...each, order: undefined, state: "idle", waitingOn: undefined, waitingFor: undefined })
  for (const [order, rows, expected] of [["older first", [oldFinRow, finRow], "c-fin-old"], ["newest first", [finRow, oldFinRow], "c-fin"]] as const) {
    acpStore.set({ activeKey: null, conversations: {}, threadSessions: {} })
    listLive([listedSummary(apexRow, "MacBook", undefined), ...rows.map((each) => listedSummary(without(each), "Loft", undefined, undefined, apex))])
    assert.equal(threadChildren(acpStore.get(), APEX_THREAD)[0]?.child?.conversation, expected, `${order}: the first listed`)
  }
})

// A Session's own ask outranks its idle peers; an older Apex's copy of a Fin's ask never outranks the newest roster.
// The shared selectors that lifecycle and notification readers use must see the placed Fin's selected row too.
for (const kind of ["approval", "question", "needs-you"] as const) {
  test(`shared roster and work select a placed Fin's ${kind} in either listing order, with a stale older Apex roster`, () => {
    const oldApex = row({ ...apexRow, conversation: "c-apex-old", session: uuid(5), state: "idle", order: 0 })
    const newestApex = row({ ...apexRow, state: "idle", order: 1, fins: [{ ...finOfApex, state: { kind: "idle" } }] })
    const asking = row({ ...oldFinRow, state: "waiting", waitingOn: "Waiting for you", waitingFor: kind })
    const idle = row({ ...finRow, state: "idle", waitingOn: undefined, waitingFor: undefined })
    for (const rows of [[oldApex, newestApex, asking, idle], [idle, asking, newestApex, oldApex]]) {
      acpStore.set({ activeKey: null, conversations: {}, threadSessions: {} })
      listLive(rows.map((each) => listedSummary(each, each.thread === APEX_THREAD ? "MacBook" : "Loft", undefined, undefined, listedApexOf(each, rows))))
      const state = acpStore.get()
      const children = sharedThreadChildren(state, APEX_THREAD)
      assert.equal(threadChildren(state, APEX_THREAD), children, "the strip and shared state use the same selector and cached array")
      assert.equal(children[0]?.child?.conversation, "c-fin-old", "the Fin's own open ask wins over its newer idle Session")
      assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: "Waiting for you", on: kind === "approval" ? "approval" : "person" })
      for (const key of ["c-apex-old", "c-apex"]) {
        const apex = state.conversations[key]
        assert.ok(apex?.kind === "live")
        const roster = conversationRoster(state, apex)
        assert.equal(roster?.agents[0]?.child?.conversation, "c-fin-old", "both Apex Sessions read the selected placed row")
        assert.equal(conversationWork(state, apex)?.named[0]?.child?.conversation, "c-fin-old", "background work reads that same row")
      }
      assert.deepEqual(finOpening(state, placedChild()), { kind: "conversation", key: "c-fin-old" })
      // When the Fin's device is quiet, the newest Apex roster stands: its older copy's ask was answered.
      acpStore.set({ activeKey: null, conversations: {}, threadSessions: {} })
      listLive(rows.map((each) => listedSummary(each, each.thread === APEX_THREAD ? "MacBook" : "Loft", each.thread === FIN_THREAD ? at(-20) : undefined, undefined, listedApexOf(each, rows))))
      const quietState = acpStore.get()
      assert.deepEqual(childStateOf(sharedThreadChildren(quietState, APEX_THREAD)[0]!), { kind: "idle" }, "the newest Apex's idle word outranks the older copy's ask")
      for (const key of ["c-apex-old", "c-apex"]) {
        const apex = quietState.conversations[key]
        assert.ok(apex?.kind === "live")
        assert.equal(conversationWork(quietState, apex), null, "neither Apex Session counts work from the answered copy")
      }
    }
  })
}
