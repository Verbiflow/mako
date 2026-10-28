import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { CloudTurnOnFollower, turnOnOf, type TurnOnReading, type TurnOnSources } from "@mako/host/conversations/cloud-turn-on"
import type { CloudAccount } from "@mako/host/contracts/cloud-account"
import type { CloudSignInRow, CloudSignInsState } from "@mako/host/contracts/cloud-sign-ins"
import type { CloudRepository } from "@mako/host/contracts/cloud-threads"
import type { BaseStanding, CloudTurnOn, TurnOnStepId, TurnOnStepOf } from "@mako/host/contracts/cloud-turn-on"
import type { SyncStatus, SyncTier } from "@mako/host/contracts/sync-status"

/**
 * Turning the cloud on, read from what owns each step: the phases from signed out to on, which steps a Thread waits
 * for (only signing in, the cloud and the agents) and which go on behind it, each stuck step with its fix, the steps
 * that stay done once seen, the times kept across a restart, and the bases' standing read only as often as it changes.
 */

const scratch = await mkdtemp(join(tmpdir(), "mako-turn-on-"))
after(() => rm(scratch, { recursive: true, force: true }))

const device = { id: "d1", kind: "desktop" as const, name: "Mac", platform: "macOS", appVersion: "1", enrolledBy: "browser" as const, createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-28T00:00:00Z" }
const signedIn = (entitlements: string[], connection: "connected" | "offline" = "connected"): CloudAccount => ({
  cloud: "cloud.test",
  state: { status: "signed-in", account: { id: "a1", name: "Ada", email: "ada@example.com", image: null, entitlements }, device, connection, kept: "keychain" },
})
const row = (harness: CloudSignInRow["harness"], status: CloudSignInRow["status"], rotates = false, kept?: "connected" | "needs-reconnect"): CloudSignInRow => {
  const value: CloudSignInRow = { harness, status, label: null, expiresAt: null }
  if (rotates) value.rotates = true
  if (kept)
    value.kept = { harness, label: null, state: kept, expiresAt: null, connectedAt: "2026-10-28T00:00:00Z", refreshedAt: null, problem: kept === "needs-reconnect" ? { reason: "revoked", detail: "invalid_grant", at: "2026-10-28T00:00:00Z" } : null, token: "fp", source: "shared", mine: true }
  return value
}
const signIns = (harnesses: CloudSignInRow[], sharing = true): CloudSignInsState => ({ sharing, checkedAt: "2026-10-28T00:00:00Z", harnesses })
const tier = (name: SyncTier["tier"], threads: number, inCloud: number): SyncTier => ({ tier: name, threads, sessions: threads, readable: inCloud, held: threads, whole: inCloud, inCloud, threadsInCloud: inCloud })
const syncing = (inCloud: number, state: "syncing" | "synced" | "failing" | "paused" = "syncing"): SyncStatus => ({
  state,
  sessions: 20,
  tiers: [tier("now", 1, Math.min(1, inCloud)), tier("day", 4, Math.min(4, Math.max(0, inCloud - 1))), tier("week", 15, Math.max(0, inCloud - 5))],
  sending: 1,
  stale: 0,
  failures: state === "failing" ? [{ at: 1, harness: "codex", nativeId: "n1", message: "The gateway answered 503", correlationId: "c-1" }] : [],
})
const MAKO: CloudRepository = { url: "https://github.com/acme/mako", branch: "main" }
const project = (base: BaseStanding) => [{ folder: "/Users/ada/mako", repository: MAKO.url, base }]
const reading = (patch: Partial<TurnOnReading> = {}): TurnOnReading => ({
  account: signedIn(["cloud"]),
  signIns: signIns([row("claude", "sent", true, "connected"), row("cursor", "sent"), row("opencode", "signed-out")]),
  sync: syncing(5),
  projects: project({ state: "making", since: "2026-10-28T00:00:00Z" }),
  firstThread: undefined,
  machine: undefined,
  ...patch,
})
const step = <Id extends TurnOnStepId>(turnOn: CloudTurnOn, id: Id): TurnOnStepOf<Id> => {
  const found = turnOn.steps.find((each): each is TurnOnStepOf<Id> => each.id === id)
  assert.ok(found, `the line has its ${id} step`)
  return found
}

test("signed out, the account is the person's and nothing else is reached; signed in without the cloud, the invite is", () => {
  const out = turnOnOf(reading({ account: { cloud: "cloud.test", state: { status: "signed-out" } } }), undefined, 1_000)
  assert.equal(out.turnOn.phase, "signed-out")
  assert.deepEqual(out.turnOn.steps.map((each) => each.state), ["yours", "later", "later", "later", "later", "later"])
  assert.equal(out.kept, undefined, "nothing kept before the cloud")
  const invite = turnOnOf(reading({ account: signedIn([]) }), undefined, 1_000).turnOn
  assert.equal(invite.phase, "no-cloud")
  assert.equal(step(invite, "plan").state, "yours")
  assert.equal(step(invite, "plan").fix, "check-plan")
  assert.equal(step(invite, "agents").state, "later")
})

test("ready once the agents are in, with the base, history and first Thread still going behind it", () => {
  const { turnOn, kept } = turnOnOf(reading(), undefined, 1_000)
  assert.equal(turnOn.phase, "ready")
  assert.equal(turnOn.since, 1_000)
  assert.equal(turnOn.readyAt, 1_000)
  assert.equal(step(turnOn, "agents").state, "done")
  assert.deepEqual(step(turnOn, "agents").agents.map((agent) => agent.harness), ["claude", "cursor"], "an agent not signed in here has nothing to send")
  assert.equal(step(turnOn, "projects").state, "working")
  assert.equal(step(turnOn, "history").state, "working")
  assert.deepEqual([step(turnOn, "history").inCloud, step(turnOn, "history").threads, step(turnOn, "history").today.inCloud], [5, 20, 5])
  const thread = step(turnOn, "thread")
  assert.equal(thread.state, "yours")
  assert.equal(thread.fix, "start-thread")
  assert.equal(thread.folder, "/Users/ada/mako")
  assert.deepEqual(kept?.done, { account: 1_000, plan: 1_000, agents: 1_000 })
})

test("an agent still sending holds ready; one to sign in again doesn't, while another is there", () => {
  const sending = turnOnOf(reading({ signIns: signIns([row("claude", "sent", true), row("cursor", "waiting")]) }), undefined, 1_000).turnOn
  assert.equal(sending.phase, "turning-on")
  assert.deepEqual(step(sending, "agents").agents.map((agent) => agent.state), ["sending", "sending"], "a rotating sign-in the cloud doesn't keep yet is still going")
  const stuck = turnOnOf(reading({ signIns: signIns([row("claude", "sent", true, "needs-reconnect"), row("cursor", "sent")]) }), undefined, 1_000).turnOn
  assert.equal(stuck.phase, "ready")
  assert.equal(step(stuck, "agents").state, "stuck")
  assert.equal(step(stuck, "agents").fix, "sign-in-agent")
  assert.equal(step(stuck, "agents").agents[0]?.problem, "invalid_grant")
  const none = turnOnOf(reading({ signIns: signIns([row("claude", "sent", true, "needs-reconnect")]) }), undefined, 1_000).turnOn
  assert.notEqual(none.phase, "ready", "with every agent stuck, no Thread could sign in")
  const kept = turnOnOf(reading({ signIns: signIns([], false) }), undefined, 1_000).turnOn
  assert.equal(step(kept, "agents").state, "done")
  assert.equal(step(kept, "agents").sharing, false)
})

test("a base that failed, Sessions that didn't go up and an unreachable cloud are stuck, each with its fix", () => {
  const turnOn = turnOnOf(reading({ projects: project({ state: "failed", message: "the clone failed: private" }), sync: syncing(4, "failing"), account: signedIn(["cloud"], "offline") }), undefined, 1_000).turnOn
  assert.deepEqual([step(turnOn, "account").state, step(turnOn, "account").fix], ["stuck", "check-plan"])
  assert.deepEqual([step(turnOn, "projects").state, step(turnOn, "projects").fix, step(turnOn, "projects").problem], ["stuck", "retry-bases", "the clone failed: private"])
  assert.deepEqual([step(turnOn, "history").state, step(turnOn, "history").fix, step(turnOn, "history").correlationIds], ["stuck", "copy-details", ["c-1"]])
  const none = turnOnOf(reading({ projects: [] }), undefined, 1_000).turnOn
  assert.equal(step(none, "projects").state, "done", "no project on GitHub leaves nothing to make")
  assert.equal(step(none, "thread").fix, undefined, "and no project to start a Thread in")
  const cloudWithoutBases = turnOnOf(reading({ projects: project({ state: "none" }) }), undefined, 1_000).turnOn
  assert.equal(step(cloudWithoutBases, "projects").state, "done")
  // A private repository (or one gone) isn't a failure to retry: settled, and the first Thread goes to one the cloud reads.
  const privateFirst = turnOnOf(reading({ projects: [
    { folder: "/Users/ada/secret", repository: "https://github.com/acme/secret", base: { state: "waiting", message: "could not read Username", reason: "no-access" } },
    { folder: "/Users/ada/mako", repository: MAKO.url, base: { state: "ready", madeAt: "x" } },
  ] }), undefined, 1_000).turnOn
  assert.equal(step(privateFirst, "projects").state, "done")
  assert.equal(step(privateFirst, "thread").folder, "/Users/ada/mako")
})

test("on once every step is done; what stays done stays so, and the times are each step's own", () => {
  let { turnOn, kept } = turnOnOf(reading({ signIns: signIns([row("cursor", "waiting")]) }), undefined, 1_000)
  assert.equal(turnOn.phase, "turning-on")
  ;({ turnOn, kept } = turnOnOf(reading(), kept, 3_400))
  assert.equal(turnOn.readyAt, 3_400)
  assert.equal(step(turnOn, "agents").at, 3_400)
  ;({ turnOn, kept } = turnOnOf(reading({ projects: project({ state: "ready", madeAt: "x" }), sync: syncing(20, "synced"), firstThread: 50_000 }), kept, 60_000))
  assert.equal(turnOn.phase, "on")
  assert.equal(turnOn.onAt, 60_000)
  assert.equal(step(turnOn, "projects").at, 60_000)
  // A new turn makes history catch up again, and the base is made again for a new image: neither is turning on now.
  ;({ turnOn, kept } = turnOnOf(reading({ projects: project({ state: "making", since: "y" }), sync: syncing(19) }), kept, 90_000))
  assert.equal(turnOn.phase, "on")
  assert.equal(step(turnOn, "history").state, "done")
  assert.equal(step(turnOn, "history").at, 60_000)
  assert.equal(step(turnOn, "projects").state, "done")
  // An agent signed out by its provider is said again: that one is live.
  ;({ turnOn } = turnOnOf(reading({ signIns: signIns([row("claude", "sent", true, "needs-reconnect"), row("cursor", "sent")]) }), kept, 95_000))
  assert.equal(step(turnOn, "agents").state, "stuck")
  // Signed out, it starts over from signing in; signed in again, the kept times stand.
  assert.equal(turnOnOf(reading({ account: { cloud: null, state: { status: "signed-out" } } }), kept, 99_000).turnOn.phase, "signed-out")
  assert.equal(turnOnOf(reading(), kept, 100_000).turnOn.since, 1_000)
})

test("the follower keeps the times across a restart, says each change once, and reads a base's standing only as often as it changes", async () => {
  const file = join(scratch, "follower", "turn-on.json")
  let now = 10_000
  let account = signedIn([])
  let standing: BaseStanding = { state: "making", since: "x" }
  let standingReads = 0
  let asked: CloudRepository[] = []
  let sync = syncing(2)
  const sources: TurnOnSources = {
    account: async () => account,
    signIns: async () => signIns([row("cursor", "sent")]),
    sync: async () => sync,
    projects: async () => [{ folder: "/Users/ada/mako", repository: MAKO }],
    standings: async (repositories) => {
      standingReads += 1
      return repositories.map((repository) => ({ repository, standing }))
    },
    askBases: async (repositories) => void (asked = repositories),
    checkPlan: async () => void (account = signedIn(["cloud"])),
    firstThread: () => undefined,
    machine: () => "warming",
    now: () => now,
  }
  const heard: CloudTurnOn[] = []
  const follower = new CloudTurnOnFollower({ sources, file, emit: (turnOn) => heard.push(turnOn) })
  assert.equal((await follower.read()).phase, "no-cloud")
  assert.equal((await follower.checkPlan()).phase, "ready", "Check now hears the grant at once")
  assert.equal(heard.length, 2)
  await follower.tick()
  assert.equal(heard.length, 2, "nothing new is said twice")
  assert.equal(standingReads, 1, "read again only after a few seconds")
  now += 5_000
  standing = { state: "failed", message: "no room" }
  const failed = await follower.read()
  assert.equal(standingReads, 2)
  assert.equal(step(failed, "projects").state, "stuck")
  assert.equal(step(failed, "thread").machine, "warming")
  standing = { state: "making", since: "z" }
  const retried = await follower.retryBases()
  assert.deepEqual(asked, [MAKO], "asked again with its branch")
  assert.equal(step(retried, "projects").state, "working")
  const kept = JSON.parse(await readFile(file, "utf8"))
  assert.equal(kept.accounts.a1.since, 15_000 - 5_000)
  // A new follower (the host restarted) reads the same times.
  const again = new CloudTurnOnFollower({ sources, file, emit: () => {} })
  const read = await again.read()
  assert.equal(read.since, 10_000)
  assert.equal(read.readyAt, 10_000)
  // A file this build can't read starts afresh rather than stopping the line.
  await writeFile(file, "{not json")
  assert.equal((await new CloudTurnOnFollower({ sources, file, emit: () => {} }).read()).phase, "ready")
  sync = syncing(20, "synced")
})
