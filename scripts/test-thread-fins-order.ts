import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { childEntry, ThreadParentSchema } from "@mako/host/contracts/agents"
import { listedFins, rollup } from "@mako/host/contracts/children"
import { listedSummary } from "@mako/host/contracts/listed-conversations"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { conversationShown } from "@mako/host/conversations/session-report"
import { AccountSessions } from "@mako/protocol/account-sessions"
import { ReportedSessionSchema } from "@mako/protocol/thread-listing"
import { apexConversation, threadChildren, threadRollup } from "@/state/apex-fins"
import { acpStore, conversationWork, removeAcpConversation } from "@/state/acp-state"
import { NativeAgentSchema } from "@mako/host/contracts/native-agents"
import { selectAcpPresence } from "@/state/acp-presence"
import { finAskLine } from "@/state/fin-asks"
import { noteFinAsks } from "@/state/acp-live"
import { notificationsStore } from "@/state/notifications"
import { applyLiveBatch, applyLiveSnapshot, hydrateLive, listLive } from "@/state/live-recovery"
import { applyThreadGroupChange } from "@/state/thread-groups"

/**
 * A Thread's Fins, wherever a window reads them from, are its newest Session's (`threadChildren`'s one rule): the
 * account's listed rows of every Session, alone or beside a full roster an older Session's snapshot brought, whichever
 * order they arrive in. A Fin's moves go to the newest Session alone (`finReaders`), so any other is stale: what a
 * Session waits on (`conversationWork`) counts its Thread's Fins from the newest too, whichever Session a window shows.
 * Built the way a window gets them: the host's own entries (`childEntry`, stamped as it stamps them) listed through
 * `listedFins`, `AccountSessions`, `listedSummary` and `listLive`, and the Thread's order through its group's change.
 */
const thread = ThreadIdSchema.parse(randomUUID())
const older = SessionIdSchema.parse(randomUUID()), newest = SessionIdSchema.parse(randomUUID())
const olderConversation = randomUUID(), newestConversation = randomUUID()
const now = Date.now()
const edge = ThreadParentSchema.parse({
  child: randomUUID(), parent: thread, parentSession: older, name: "worker", role: "worker", origin: "started",
  asked: { brief: { objective: "Work" }, harness: "claude" }, op: "test-start", startedBy: { kind: "agent", session: older }, createdAt: now - 60_000,
})
// A queued Fin keeps its edge's time as its place moves, and two steps may share a millisecond: no stamp orders them.
const cases = [
  { label: "a queued Fin's place", before: childEntry(edge, { source: "live", queued: { reason: "place-full", ahead: 4 } }, {}), after: childEntry(edge, { source: "live", queued: { reason: "place-full", ahead: 1 } }, {}) },
  { label: "a step in the same millisecond", before: childEntry(edge, { source: "live", working: true, updatedAt: now, step: "old step" }, {}), after: childEntry(edge, { source: "live", working: true, updatedAt: now, step: "new step" }, {}) },
]
for (const { label, before, after } of cases) {
  assert.equal(before.observedAt, after.observedAt, `${label}: the two say the same time`)
  const row = (session: string, conversation: string, agent: typeof before) => ReportedSessionSchema.parse({
    session, thread, conversation, harness: "claude",
    ...conversationShown({ session: { id: conversation, status: "ready" }, working: undefined, waitingOn: () => undefined, fins: () => listedFins([agent]) }),
    createdAt: new Date(now).toISOString(), activityAt: new Date(now).toISOString(), generation: 1,
  })
  const account = new AccountSessions()
  account.listed({ sessions: [row(older, olderConversation, before), row(newest, newestConversation, after)].map((each) => ({ ...each, runsOn: { kind: "device" as const, deviceId: "6f1d2c3b-4a59-4e68-8a7b-9c0d1e2f3a4b" }, listedAt: new Date(now).toISOString() })), seq: 1 })
  for (const order of ["older first", "newest first"] as const) {
    for (const opened of [false, true]) {
      const how = `${label}, listed ${order}${opened ? ", the older Session's full roster held" : ""}`
      acpStore.set({ activeKey: null, conversations: {} })
      const rows = [...account.sessions().values()]
      if (order === "newest first") rows.reverse()
      listLive(rows.map((each) => listedSummary(each, "another Mac", undefined)))
      applyThreadGroupChange({ thread, group: { id: thread, sessions: [older, newest].map((id) => ({ id, origin: "started", started: true })) } })
      if (opened) {
        const listed = acpStore.get().conversations[olderConversation]
        assert.ok(listed?.kind === "live", "the older Session is listed")
        applyLiveSnapshot({ session: listed.session, sessionId: older, threadId: thread, epoch: "E", revision: 5, createdAt: now, blocks: [], requests: [], permissions: [], base: null, nativeAgents: { agents: [before], limited: false } })
        assert.ok(acpStore.get().conversations[olderConversation]?.nativeAgents, "its full roster is held")
      }
      assert.deepEqual(threadChildren(acpStore.get(), thread)[0]?.child?.state, after.child?.state, `${how}: the newest Session's`)
      assert.deepEqual({ ...threadRollup(acpStore.get(), thread) }, { ...rollup([after]) }, `${how}: and counted so`)
    }
  }
}
// What this Mac's own host says of an Apex it holds no roster of is a count by Session (`LiveSummary.children`): the
// newest Session's count too, whichever is held first.
applyThreadGroupChange({ thread, group: { id: thread, sessions: [older, newest].map((id) => ({ id, origin: "started", started: true })) } })
const counted = (key: string, session: string, queued: number) =>
  // SAFETY: the fields `threadRollup` reads of a listed conversation: its Thread, its Session and its count.
  ({ kind: "live", key, threadId: thread, sessionId: session, children: { ...rollup([]), total: queued, queued } }) as never
for (const order of [[olderConversation, newestConversation], [newestConversation, olderConversation]]) {
  const conversations = Object.fromEntries(order.map((key) => [key, key === olderConversation ? counted(key, older, 4) : counted(key, newest, 1)]))
  assert.equal(threadRollup({ activeKey: null, conversations, threadSessions: acpStore.get().threadSessions }, thread).queued, 1, "a count is the newest Session's")
}
// A window showing either Session of the Thread, both held whole on this Mac: what each waits on counts the Fins the
// newest Session's roster has, never those an older one last heard, at work or ended.
const atWork = childEntry(edge, { source: "live", working: true, updatedAt: now, step: "building" }, {})
const ended = childEntry(edge, { source: "live" }, {})
const held = (key: string, session: string, agent: typeof atWork) =>
  // SAFETY: the fields `conversationWork` reads of a held conversation: its Thread, its Session, its state and its roster.
  ({ kind: "live", key, threadId: thread, sessionId: session, session: { id: key, status: "ready", connection: "connected" }, nativeAgents: { agents: [agent], limited: false } }) as never
for (const [olderSaw, newestSays] of [[atWork, ended], [ended, atWork]] as const) {
  const conversations = { [olderConversation]: held(olderConversation, older, olderSaw), [newestConversation]: held(newestConversation, newest, newestSays) }
  const state = { activeKey: null, conversations, threadSessions: acpStore.get().threadSessions }
  const waits = newestSays === atWork ? 1 : undefined
  for (const key of [olderConversation, newestConversation])
    assert.equal(conversationWork(state, conversations[key]!)?.count, waits, `${key === olderConversation ? "the older" : "the newest"} Session waits on the Fins its newest has ${newestSays === atWork ? "at work" : "ended"}`)
  // A Thread of one Session (no group) counts its own.
  const alone = { [olderConversation]: conversations[olderConversation]! }
  assert.equal(conversationWork({ activeKey: null, conversations: alone }, alone[olderConversation]!)?.count, olderSaw === atWork ? 1 : undefined, "one Session alone counts its own roster")
}
// A Fin's question, as #524's review found it: a Session's question status read its own roster, so an older Session kept
// a question the newest roster had seen answered, and missed one asked since. Every reader of it reads the Thread's.
const idle = childEntry(edge, { source: "live" }, {})
const asking = NativeAgentSchema.parse({ ...idle, child: { ...idle.child!, state: { kind: "blocked", question: "Which color?", on: "person", ask: { kind: "question", id: "ask-color", options: [{ label: "Blue" }] } } } })
for (const [olderSaw, newestSays] of [[asking, idle], [idle, asking]] as const) {
  const conversations = { [olderConversation]: held(olderConversation, older, olderSaw), [newestConversation]: held(newestConversation, newest, newestSays) }
  const state = { activeKey: null, conversations, threadSessions: acpStore.get().threadSessions }
  const asked = newestSays === asking
  for (const key of [olderConversation, newestConversation]) {
    const which = key === olderConversation ? "the older" : "the newest"
    assert.equal(finAskLine(state, conversations[key]!) !== undefined, asked, `${which} Session's question line is the newest roster's (${asked ? "asking" : "answered"})`)
    assert.equal(selectAcpPresence(state).find((presence) => presence.key === key)?.status, asked ? "needs-permission" : "ready", `${which} Session's status is the newest roster's (${asked ? "asking" : "answered"})`)
  }
  // Said once for the Thread, and taken back once the newest hears it answered, wherever it was said.
  acpStore.set(state)
  const said = () => notificationsStore.get().items.filter((item) => item.id.endsWith(`:fin:${edge.child}:ask-color`)).length
  noteFinAsks(conversations[olderConversation]!)
  noteFinAsks(conversations[newestConversation]!)
  assert.equal(said(), asked ? 1 : 0, "an ask is said once for the Thread")
  if (asked) {
    const answered = held(newestConversation, newest, idle)
    acpStore.set({ ...state, conversations: { ...conversations, [newestConversation]: answered } })
    noteFinAsks(answered)
    assert.equal(said(), 0, "and taken back when the newest hears it answered, from the older Session it was said on")
  }
  // The Apex's conversation answers go through, away from it, is its newest Session's.
  assert.equal(apexConversation(state, thread)?.key, newestConversation, "the Apex's conversation is its newest Session")
}
// An ask said for the Thread is taken back by its own state, wherever the answer is heard: as a snapshot read across a
// gap, or for a Session this window wasn't holding, and after the Session that said it has left this window. (#524's
// third review: each of these left an answered question on the attention centre.)
const snapshotOf = (id: string, session: string, agent: typeof asking, revision: number) => ({
  session: { id, harness: "codex", cwd: "/fixture", status: "ready" as const, connection: "connected" as const, modes: [], currentMode: null, configOptions: [] },
  threadId: thread, sessionId: session, epoch: "E", revision, createdAt: now, blocks: [], requests: [], permissions: [], base: null, nativeAgents: { agents: [agent], limited: false },
})
const reads: string[] = []
// The window's bridge, as `hydrateLive` reads a snapshot through it: the newest Session, answered, at revision 3.
Object.defineProperty(globalThis, "window", { value: { mako: { liveSnapshot: async (id: string) => (reads.push(id), snapshotOf(id, newest, idle, 3)) } }, configurable: true })
const unseen = () => notificationsStore.get().items.filter((item) => item.id.endsWith(`:fin:${edge.child}:ask-color`) && !item.seen)
const recoveries: [string, () => Promise<void>][] = [
  ["the answer comes as a snapshot of the newest Session, not held here", async () => {
    removeAcpConversation(newestConversation)
    applyLiveSnapshot(snapshotOf(newestConversation, newest, idle, 3))
  }],
  ["the answer's batch finds the newest Session not held, and its recovery reads the snapshot", async () => {
    removeAcpConversation(newestConversation)
    applyLiveBatch({ id: newestConversation, epoch: "E", revision: 3, updates: [], nativeAgents: { agents: [idle], limited: false } })
    assert.equal(await hydrateLive(newestConversation), true, "recovered")
    assert.deepEqual(reads, [newestConversation], "through its snapshot")
  }],
  ["the answer's batch comes past a gap, and the recovery reads the snapshot", async () => {
    applyLiveBatch({ id: newestConversation, epoch: "E", revision: 3, updates: [], nativeAgents: { agents: [idle], limited: false } })
    assert.equal(await hydrateLive(newestConversation), true, "recovered")
    assert.deepEqual(reads, [newestConversation], "through its snapshot")
  }],
  ["the Session that said it has left this window, and the newest hears the answer", async () => {
    removeAcpConversation(olderConversation)
    applyLiveSnapshot(snapshotOf(newestConversation, newest, idle, 3))
    const latest = acpStore.get().conversations[newestConversation]
    assert.ok(latest?.kind === "live")
    noteFinAsks(latest)
  }],
]
for (const [how, answer] of recoveries) {
  notificationsStore.set({ items: [] })
  acpStore.set({ activeKey: null, conversations: {}, threadSessions: { [thread]: [older, newest] } })
  applyLiveSnapshot(snapshotOf(olderConversation, older, asking, 1))
  applyLiveSnapshot(snapshotOf(newestConversation, newest, asking, 1))
  const olderHeld = acpStore.get().conversations[olderConversation]
  assert.ok(olderHeld?.kind === "live")
  noteFinAsks(olderHeld)
  assert.equal(unseen().length, 1, `${how}: the older Session said the question`)
  reads.length = 0
  await answer()
  assert.equal(threadChildren(acpStore.get(), thread)[0]?.child?.state?.kind, "idle", `${how}: the Thread's Fin is answered`)
  assert.equal(unseen().length, 0, `${how}: and the question is taken back`)
}
// Asks on one subject, the Apex's own and its Fins', in every order: `test-ask-notices.ts`.
applyThreadGroupChange({ thread, group: null })
console.log("thread fins order: a Thread's Fins are its newest Session's, listed or held, in any order they arrive")
process.exit(0)
