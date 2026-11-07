import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { childEntry, ThreadParentSchema } from "@mako/host/contracts/agents"
import { listedFins, rollup } from "@mako/host/contracts/children"
import { listedSummary } from "@mako/host/contracts/listed-conversations"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { conversationShown } from "@mako/host/conversations/session-report"
import { AccountSessions } from "@mako/protocol/account-sessions"
import { ReportedSessionSchema } from "@mako/protocol/thread-listing"
import { threadChildren, threadRollup } from "@/state/apex-fins"
import { acpStore } from "@/state/acp-state"
import { applyLiveSnapshot, listLive } from "@/state/live-recovery"
import { applyThreadGroupChange } from "@/state/thread-groups"

/**
 * A Thread's Fins, wherever a window reads them from, are its newest Session's (`threadChildren`'s one rule): the
 * account's listed rows of every Session, alone or beside a full roster an older Session's snapshot brought, whichever
 * order they arrive in. A Fin's progress goes to the newest Session alone (`progressReaders`), so any other is stale.
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
applyThreadGroupChange({ thread, group: null })
console.log("thread fins order: a Thread's Fins are its newest Session's, listed or held, in any order they arrive")
process.exit(0)
