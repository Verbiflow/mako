/**
 * An Apex's tree, the same on every device: the host that runs the Apex lists its Fins on the Apex's row, as its
 * publisher does (`conversationShown` with `listedFins`, wired as `core.ts` wires them), the account keeps the row by
 * the one-owner rule (`mayReplace`, as the account's object does), and another Mac and a browser follow the account's
 * list (`AccountSessions`) and show it through `listedSummary`, the one mapping every client uses, read by the desk's
 * own selectors (`threadChildren`, `apexPips`). Held starts count as the owner shows them; a Fin moving up the line
 * reaches both; the owner asleep leaves its tree readable, with its age; the Apex moved to the cloud lists it there,
 * and the old owner's late word changes nothing.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccountSessions } from "@mako/protocol/account-sessions"
import { mayReplace, ReportedSessionSchema, type ListedSession, type ReportedSession, type RunsOn } from "@mako/protocol/thread-listing"
import { listedSummary } from "@mako/host/contracts/listed-conversations"
import { listedFins, rollup } from "@mako/host/contracts/children"
import { conversationShown } from "@mako/host/conversations/session-report"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { randomUUID } from "node:crypto"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { acpStore } from "@/state/acp-state"
import { applyThreadGroupChange } from "@/state/thread-groups"
import { threadChildren } from "@/state/apex-fins"
import { apexPips } from "@/state/fin-pips"
import type { AcpState } from "@/state/acp-state"
import { AgentsWorld } from "./lib/agents-world.js"

const GB = 1024 ** 3
const MAC = { kind: "device", deviceId: "6f1d2c3b-4a59-4e68-8a7b-9c0d1e2f3a4b" } as const satisfies RunsOn
const CLOUD = { kind: "cloud", threadId: "t-832ba5da061838a3" } as const satisfies RunsOn

/** The account's list as its object keeps it: one row per Session, taken by the one-owner rule, each change said in order. */
class AccountList {
  readonly #rows = new Map<string, ListedSession>()
  readonly #followers: AccountSessions[] = []
  #seq = 0
  follow(): AccountSessions {
    const follower = new AccountSessions()
    follower.listed({ sessions: [...this.#rows.values()], seq: this.#seq })
    this.#followers.push(follower)
    return follower
  }
  report(row: ReportedSession, runsOn: RunsOn): boolean {
    const reported = ReportedSessionSchema.parse(row)
    if (!mayReplace(this.#rows.get(reported.session), { generation: reported.generation, runsOn })) return false
    const listed: ListedSession = { ...reported, runsOn, listedAt: new Date().toISOString() }
    this.#rows.set(listed.session, listed)
    this.#say({ type: "sessions-listed", sessions: [listed] })
    return true
  }
  quiet(deviceId: string, since: string | null): void {
    this.#say({ type: "device-quiet", deviceId, since })
  }
  #say(event: Parameters<AccountSessions["heard"]>[0]["event"]): void {
    this.#seq += 1
    for (const follower of this.#followers) assert.ok(follower.heard({ seq: this.#seq, event }))
  }
}

/** A window of a device that isn't the Apex's owner: the account's rows as `listedSummary` lists them, in its store's shape. */
function windowOf(follower: AccountSessions): AcpState {
  const conversations: AcpState["conversations"] = {}
  for (const row of follower.sessions().values()) {
    const quietSince = row.runsOn.kind === "device" ? follower.quietSince(row.runsOn.deviceId) : undefined
    const summary: LiveSummary = listedSummary(row, row.runsOn.kind === "device" ? "the Mac" : "a cloud machine", quietSince)
    // SAFETY: the fields of a listed conversation the selectors read, as `listLive` keeps them from the summary.
    conversations[summary.session.id] = { kind: "live", key: summary.session.id, threadId: summary.threadId, children: summary.children, fins: summary.fins, quietSince: summary.quietSince, nativeAgents: undefined } as never
  }
  return { activeKey: null, conversations }
}

const root = mkdtempSync(join(tmpdir(), "mako-fin-tree-"))
let working = 0
const w = new AgentsWorld({
  root,
  script: (turn) => (turn.text.includes("You're fin:") ? (working++, turn.world.hold(turn.conversation).then(() => (working--, "stopped"))) : "ok"),
  capacity: { read: async () => ({ cores: 6, memoryBytes: 16 * GB }) },
  finLimit: () => 2,
})
try {
  const apex = await w.apex("cursor")
  const placed = w.store.journalPlacement(apex.conversation)!
  const brief = { objective: "Hold" }
  for (const name of ["li-openoutreach", "li-protocol", "li-flage", "li-parley-fit"]) await w.agents.start(apex.caller, { brief, name, clientKey: name, cwd: w.root, queue: true })
  for (const deadline = Date.now() + 8_000; working < 2 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(working, 2, "the Mac's room: two at work, two held")

  /** The Apex's row as its host's publisher makes it, at `generation`. */
  const apexRow = (generation = 1): ReportedSession => ({
    session: placed.session,
    thread: placed.thread,
    conversation: apex.conversation,
    harness: "cursor",
    ...conversationShown({ session: { id: apex.conversation, status: "ready" }, working: undefined, waitingOn: () => undefined, fins: (id) => listedFins(w.agents.roster(id)) }),
    createdAt: new Date().toISOString(),
    activityAt: new Date().toISOString(),
    generation,
  })
  const owner = () => w.agents.roster(apex.conversation)

  const account = new AccountList()
  const otherMac = account.follow()
  account.report(apexRow(), MAC)
  const browser = account.follow()
  const same = (where: string) => {
    for (const [name, follower] of [["another Mac", otherMac], ["a browser", browser]] as const) {
      const state = windowOf(follower)
      assert.deepEqual(rollup(threadChildren(state, placed.thread)), rollup(owner()), `${where}: ${name} counts the Fins as their owner does`)
      assert.equal(apexPips(state, placed.thread).length, owner().length, `${where}: ${name} draws a pip per Fin`)
    }
  }
  same("held starts included")
  assert.deepEqual({ ...rollup(owner()) }, { total: 4, needs: 0, working: 2, queued: 2, idle: 0, failed: 0, done: 0 })
  // A Fin's moves reach only its Apex's newest Session (`finReaders`), so the Fins drawn are that Session's,
  // by its Thread's order of Sessions, whichever of its conversations a window holds first. Stamps are the host's own:
  // a queued Fin keeps its edge's time as its place moves, and a step may land in the same millisecond as the last.
  const before = owner().filter((entry) => entry.child)
  const queued = before.find((entry) => entry.child?.state?.kind === "queued")
  const atWork = before.find((entry) => entry.child?.state?.kind === "working")
  assert.ok(queued && atWork, "an Apex with a Fin queued and one at work")
  const withState = (entry: typeof queued, state: NonNullable<NonNullable<typeof queued.child>["state"]>) => ({ ...entry, child: { ...entry.child!, state } })
  const queuedState = queued.child!.state!
  assert.equal(queuedState.kind, "queued")
  const after = before.map((entry) => {
    if (entry === queued && queuedState.kind === "queued") return withState(entry, { ...queuedState, ahead: queuedState.ahead + 3 })
    if (entry === atWork) return withState(entry, { kind: "working", step: "an older step" })
    return entry
  })
  const latest = before.map((entry) => {
    if (entry === atWork) return withState(entry, { kind: "working", step: "the newest step" })
    return entry
  })
  assert.deepEqual(after.map((entry) => entry.observedAt), latest.map((entry) => entry.observedAt), "the two rosters' stamps are the same")
  const sessionHolding = (key: string, session: string, agents: typeof before) =>
    // SAFETY: the fields `threadChildren` reads of a live conversation: its Thread, its Session and its roster.
    ({ kind: "live", key, threadId: placed.thread, sessionId: session, nativeAgents: { agents, limited: false } }) as never
  const said = (state: AcpState) => threadChildren(state, placed.thread).map((entry) => {
    const now = entry.child?.state
    return now?.kind === "working" ? now.step : now?.kind === "queued" ? `${now.ahead} ahead` : now?.kind
  })
  const wanted = said({ activeKey: null, conversations: { only: sessionHolding("only", "newest-session", latest) } })
  assert.ok(wanted.includes("the newest step") && wanted.includes(`${queuedState.ahead} ahead`))
  // The order a window keeps is the one its groups say, as they load and change.
  const group = (sessions: string[]) => applyThreadGroupChange({ thread: placed.thread, group: { id: ThreadIdSchema.parse(placed.thread), sessions: sessions.map((id) => ({ id: SessionIdSchema.parse(id), origin: "started", started: true })) } })
  const olderId = randomUUID(), newestId = randomUUID()
  group([olderId, newestId])
  assert.deepEqual(acpStore.get().threadSessions?.[placed.thread], [olderId, newestId], "the window keeps the group's order")
  const ordered = acpStore.get().threadSessions
  for (const order of [["old", "new"], ["new", "old"]] as const) {
    const conversations = Object.fromEntries(order.map((which) => [which, which === "old" ? sessionHolding("old", olderId, after) : sessionHolding("new", newestId, latest)]))
    assert.deepEqual(said({ activeKey: null, conversations, threadSessions: ordered }), wanted, `the newest Session's Fins, held ${order.join(" then ")}`)
  }
  // A Session made after the newest one held is newer still: the newest held of those the window has.
  group([olderId, newestId, randomUUID()])
  assert.deepEqual(said({ activeKey: null, conversations: { old: sessionHolding("old", olderId, after), new: sessionHolding("new", newestId, latest) }, threadSessions: acpStore.get().threadSessions }), wanted, "the newest Session held")
  applyThreadGroupChange({ thread: placed.thread, group: null })
  assert.equal(acpStore.get().threadSessions?.[placed.thread], undefined, "and a Thread back to one Session has no order to keep")

  // A Fin ends: one held starts, and the other moves up the line; the owner's next report says both.
  await w.agents.stop(apex.caller, { child: "li-openoutreach" })
  for (const deadline = Date.now() + 8_000; (working < 2 || w.store.queuedSpawns().length > 1) && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(account.report(apexRow(), MAC))
  same("after one ended and a held one started")
  assert.equal(rollup(owner()).done, 1)

  // The Mac sleeps: every other device reads its tree as it last stood, and knows how old it is.
  const asleep = new Date().toISOString()
  account.quiet(MAC.deviceId, asleep)
  same("its owner asleep")
  const row = windowOf(browser).conversations[apex.conversation]
  assert.equal(row?.kind === "live" && row.quietSince, Date.parse(asleep), "read-only, marked with when it was last heard")

  // The Apex moves to the cloud (a newer generation): its new owner lists the tree, and the Mac's late word is refused.
  account.quiet(MAC.deviceId, null)
  await w.agents.stop(apex.caller, { child: "li-protocol" })
  for (const deadline = Date.now() + 8_000; w.store.queuedSpawns().length > 0 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(account.report(apexRow(2), CLOUD), "the new owner, at the move's generation")
  same("moved to the cloud")
  const moved = rollup(threadChildren(windowOf(otherMac), placed.thread))
  assert.equal(account.report({ ...apexRow(1), fins: undefined }, MAC), false, "the old owner's late word, at its generation, is refused")
  assert.deepEqual(rollup(threadChildren(windowOf(otherMac), placed.thread)), moved, "and changes nothing")
  const listed = windowOf(browser).conversations[apex.conversation]
  assert.ok(listed?.kind === "live" && listed.fins !== undefined, "the browser holds the moved Apex's Fins")
  await w.agents.stop(apex.caller, { child: "all" })
  console.log("fin tree sync: an Apex's Fins, held starts included, read the same on its owner, another Mac and a browser; live, asleep with its age, and moved to the cloud under the one-owner rule")
} finally {
  await w.close()
  rmSync(root, { recursive: true, force: true })
}
