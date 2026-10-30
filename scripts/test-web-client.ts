import assert from "node:assert/strict"
import { resolveObjectURL } from "node:buffer"
import { test } from "node:test"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { foldThreads, openingSession } from "../src/web-client/threads"
import { parseRoute, routeHref, type WebRoute } from "../src/web-client/route"
import { typedRepository } from "../src/web-client/account"
import { Gateway } from "../src/web-client/gateway"
import { rowDetail } from "../src/web-client/rows"
import { CLOUD_PLACE, defaultPlace, macProjects, orderedHarnesses, placeKey, places } from "../src/web-client/places"
import { ROW, rubberband, SETTLE, springPath } from "../src/web-client/motion"
import { ACTION_PX, commitDistance, swipeRelease } from "../src/web-client/row-gestures"
import { isUnread, markSeen, markUnread, noteListed, readStore } from "../src/web-client/read-state"
import { shouldOffer } from "../src/web-client/install"
import { HeldPreviews, type Picked } from "../src/web-client/attachments"
import { accessInEffect, chooseAccess, orderedModes, readAccessChoices, type Ladder } from "../src/web-client/access"
import { AccessChoosingSchema, type AccessChoices } from "@mako/protocol/access-choices"
import { delayedStatusDeadline, stepDelayedStatus, type DelayedStatus } from "../src/web-client/delayed-status"
import { returnKind } from "../src/web-client/resume"
import { newerBuild, QUIET_AFTER_MS, quietMoment } from "../src/web-client/update"
import { newDraftKey, noteSending, openingText, readDraft, settleSending, threadDraftKey, writeDraft } from "../src/web-client/drafts"
import { answeredWords, dockStatus, statusWords, workingWords, type DockStatusInput } from "../src/web-client/dock-status"
import { DELIVERY_WORDS, deliveryOf, type Sending } from "../src/web-client/delivery"
import { SAY_WAKING_MS, wakeThread, wakingNow, wakingStore } from "../src/web-client/wake"
import { sendChoiceDetail, sendPresentation, type SendSituation } from "../src/web-client/send-action"
import { appendHeard, DictationSession, elapsedWords, frameDecibels, meterLevel, splitUnsure, type Recognition } from "../src/web-client/dictation"
import { freshStep, stepsLine } from "../src/web-client/steps-words"
import { switchedWords } from "../src/web-client/answered"
import type { ToolCall } from "../src/extend/slots"
import { diagnose, diagnosisText, lastSeen, type ReachInput } from "../src/web-client/diagnosis"
import { barFrom, forward, percentWords, sentWords, stepFraction, stepWords } from "../src/web-client/move-progress"
import { endMove, followedWays, listedMove, movesStore, putMove, stepHeard } from "../src/web-client/moves"
import { followAnswer } from "../src/web-client/move-actions"
import { appKey, appShownAs, appsStore, loopbackTarget, readApp, serversOf, withPath } from "../src/web-client/previews"
import { cloudReach } from "../src/web-client/trouble-state"
import { OwnerUnavailableError, RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { Payload, problem, type ClientSession, type Operation, type Reply } from "@mako/protocol"
import { connectStep, macConnection } from "../src/web-client/mac-connection"
import { reachLog, reachStore } from "../src/web-client/reach"

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const STUDIO = uuid(900)
const at = (minutes: number) => new Date(Date.parse("2026-10-28T12:00:00Z") + minutes * 60_000).toISOString()

function row(n: number, fields: Partial<ListedSession>): ListedSession {
  return {
    session: uuid(n),
    thread: uuid(100),
    conversation: `c${n}`,
    harness: "claude",
    state: "idle",
    folder: "/Users/ana/api",
    createdAt: at(n),
    activityAt: at(n),
    generation: 1,
    runsOn: { kind: "cloud", threadId: "t-0123456789abcdef" },
    listedAt: at(n),
    ...fields,
  }
}

const devices = new Map([[STUDIO, { id: STUDIO, kind: "desktop", name: "Studio", platform: "macOS" }]])

test("one row per Thread, folded by its ID, the ones that need the person first", () => {
  const rows = [
    row(1, { thread: uuid(100), harness: "claude", threadTitle: "Fix retries" }),
    row(2, { thread: uuid(100), harness: "codex", state: "working" }),
    row(3, { thread: uuid(200), state: "waiting", waitingOn: "Approve: npm test", runsOn: { kind: "device", deviceId: STUDIO } }),
    row(4, { thread: uuid(300), state: "idle", activityAt: at(50) }),
  ]
  const { threads } = foldThreads({ rows, devices, quiet: new Map(), waiting: new Map(), archived: [] })
  assert.deepEqual(threads.map((thread) => [thread.id, thread.standing]), [[uuid(200), "waiting"], [uuid(100), "working"], [uuid(300), "idle"]])
  const folded = threads.find((thread) => thread.id === uuid(100))
  assert.equal(folded?.sessions.length, 2)
  assert.equal(folded?.title, "Fix retries")
  assert.equal(folded?.where, "the cloud")
  assert.equal(folded?.project, "api")
  assert.equal(threads[0]?.where, "Studio")
  assert.equal(threads[0]?.waitingOn, "Approve: npm test")
  assert.equal(openingSession(folded!).row.conversation, "c2", "a Thread opens on the Session at work")
  // The host's own mapping lists each row, as a Mac's window does.
  assert.equal(threads[0]?.sessions[0]?.summary.waitingOn, "Approve: npm test")
  assert.equal(threads[0]?.sessions[0]?.owner.kind, "device")
})

test("the phone folds the account's Sessions into Threads as a Mac's rail does: one rule, the same rows, the same Threads", async () => {
  // Another Mac's Thread of three Sessions (its second a fork, its third another harness), listed out of order; a cloud
  // Thread of two; two Threads of one Session each that share a title, as two Threads made with one prompt do.
  const rows = [
    row(13, { thread: uuid(500), harness: "cursor", runsOn: { kind: "device", deviceId: STUDIO }, threadTitle: "Find the flaky payments test" }),
    row(11, { thread: uuid(500), harness: "codex", runsOn: { kind: "device", deviceId: STUDIO }, threadTitle: "Find the flaky payments test" }),
    row(12, { thread: uuid(500), harness: "codex", runsOn: { kind: "device", deviceId: STUDIO }, threadTitle: "Find the flaky payments test", title: "Fork of the flaky test" }),
    row(14, { thread: uuid(600), harness: "claude" }),
    row(15, { thread: uuid(600), harness: "opencode", state: "working" }),
    row(16, { thread: uuid(700), runsOn: { kind: "device", deviceId: STUDIO }, threadTitle: "Run the payments suite" }),
    row(17, { thread: uuid(800), runsOn: { kind: "device", deviceId: STUDIO }, threadTitle: "Run the payments suite" }),
  ]
  const { threads } = foldThreads({ rows, devices, quiet: new Map(), waiting: new Map(), archived: [] })
  // The rail reads its modules' stores at import, which keep drafts in the browser's storage.
  const kept = new Map<string, string>()
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => kept.set(key, value), removeItem: (key: string) => kept.delete(key) } })
  const { foldThreads: foldRail } = await import("../src/lib/thread-fold")
  // What a Mac's window holds for each row the account lists (`selectAcpPresence` of the host's `listedSummary`): no
  // Thread of this Mac's store, so its Thread is the one the row names.
  const sessions = threads.flatMap((thread) => thread.sessions)
  const rail = foldRail(
    sessions.map(({ summary }) => ({
      kind: "live" as const,
      key: summary.session.id,
      presence: { key: summary.session.id, harness: summary.session.harness, cwd: summary.session.cwd, createdAt: summary.createdAt, status: "ready" as const, threadId: summary.threadId, sessionId: summary.sessionId, elsewhere: summary.elsewhere },
    })),
    {},
    {}
  )
  const railThreads = sessions
    .map((session) => session.row.conversation)
    .filter((conversation) => !rail.hidden.has(conversation))
    .map((lead) => rail.byLead.get(lead)?.members.map((member) => member.key) ?? [lead])
  assert.deepEqual(
    threads.map((thread) => thread.sessions.map((session) => session.row.conversation)).sort(),
    railThreads.sort(),
    "the same Sessions make each Thread, in the same order, on the phone and on a Mac"
  )
  assert.equal(threads.length, 4, "a fork is a Session of its Thread; two Threads with one title stay two")
  assert.deepEqual(threads.find((thread) => thread.id === uuid(500))?.sessions.map((session) => session.row.conversation), ["c11", "c12", "c13"])
})

test("a quiet device's rows stand as it left them, none at work, and its Thread says when it was seen", () => {
  const rows = [row(5, { thread: uuid(400), state: "waiting", waitingOn: "Approve: rm", runsOn: { kind: "device", deviceId: STUDIO } })]
  const { threads } = foldThreads({ rows, devices, quiet: new Map([[STUDIO, at(-180)]]), waiting: new Map(), archived: [] })
  assert.equal(threads[0]?.standing, "idle")
  assert.equal(threads[0]?.waitingOn, undefined)
  assert.equal(threads[0]?.quietSince, at(-180))
  assert.equal(threads[0]?.sessions[0]?.summary.session.status, "ready", "the host's quiet status")
})

test("archived cloud Threads fold apart, as the account keeps them", () => {
  const archived = [{ thread: "t-00000000000000aa", move: uuid(7), archivedAt: at(10), sessions: [row(6, { thread: uuid(500) })] }]
  const { threads, archived: folded } = foldThreads({ rows: [], devices, quiet: new Map(), waiting: new Map(), archived })
  assert.equal(threads.length, 0)
  assert.equal(folded[0]?.archived?.move, uuid(7))
})

test("a route survives its address: Back, a reload and a notification land where they should", () => {
  const routes: WebRoute[] = [{ kind: "list" }, { kind: "thread", thread: uuid(1) }, { kind: "thread", thread: uuid(1), session: uuid(2) }, { kind: "new" }, { kind: "settings" }]
  // At the root of the app's own host, and under a path of another's.
  for (const base of ["/", "/app/"])
    for (const route of routes) {
      const href = new URL(routeHref(route, base), "https://example.test")
      assert.deepEqual(parseRoute(href.pathname, href.search, base), route, `${base} ${href.pathname}`)
    }
  assert.deepEqual(parseRoute("/elsewhere", "", "/app/"), { kind: "list" })
  assert.deepEqual(parseRoute("/elsewhere", "", "/"), { kind: "list" })
})

test("a repository typed in any of Git's shapes is the cloud's", () => {
  assert.equal(typedRepository("verbiflow/mako")?.url, "https://github.com/verbiflow/mako")
  assert.equal(typedRepository("git@github.com:verbiflow/mako.git")?.url, "https://github.com/verbiflow/mako")
  assert.equal(typedRepository("https://github.com/verbiflow/mako/")?.url, "https://github.com/verbiflow/mako")
  assert.equal(typedRepository("https://gitlab.com/a/b"), undefined)
})

test("a connection token is renewed before it runs out, never on every ask, however short it lives", async () => {
  for (const lifeMs of [20_000, 5 * 60_000]) {
    let asked = 0
    const gateway = new Gateway({
      origin: "https://example.test",
      connect: async () => {
        asked++
        return { token: `t${asked}`, expiresAt: Date.now() + lifeMs, deviceId: uuid(1), account: { id: uuid(2), name: "Ana", email: "ana@example.test", image: null, entitlements: [] } }
      },
    })
    const first = await gateway.connection()
    const again = await Promise.all([gateway.connection(), gateway.connection()])
    assert.deepEqual([first.token, ...again.map((connection) => connection.token)], ["t1", "t1", "t1"], `a ${lifeMs / 1000}s token is kept while it's good`)
    assert.equal(asked, 1)
    gateway.close()
  }
})

test("a row says one fact under its title: what it waits on, that it failed or works, else its project", () => {
  const rows = [
    row(10, { thread: uuid(110), state: "waiting", waitingOn: "Approve: npm test" }),
    row(11, { thread: uuid(111), state: "failed" }),
    row(12, { thread: uuid(112), state: "working" }),
    row(13, { thread: uuid(113), runsOn: { kind: "device", deviceId: STUDIO }, folder: "/Users/ana/web" }),
    row(14, { thread: uuid(114) }),
  ]
  const { threads } = foldThreads({ rows, devices, quiet: new Map(), waiting: new Map(), archived: [] })
  const said = (id: number, named = false) => rowDetail(threads.find((thread) => thread.id === uuid(id))!, named)
  assert.deepEqual(said(110), { text: "Approve: npm test", tone: "caution" })
  assert.deepEqual(said(111), { text: "Failed", tone: "negative" })
  assert.deepEqual(said(112), { text: "Working", tone: "working" })
  assert.deepEqual(said(113), { text: "web", tone: "faint", place: "device" }, "one Mac: its name goes without saying")
  assert.deepEqual(said(113, true), { text: "web · Studio", tone: "faint", place: "device" }, "several: the Mac is named")
  assert.deepEqual(said(114, true), { text: "api", tone: "faint", place: "cloud" }, "the cloud is its glyph, never a word again")
})

test("a Thread starts on a Mac that's on, the one last used first, else the cloud; a Mac that's off is listed, not chosen", () => {
  const LAPTOP = uuid(901)
  const twoMacs = new Map([...devices, [LAPTOP, { id: LAPTOP, kind: "desktop", name: "Laptop", platform: "macOS" }], [uuid(902), { id: uuid(902), kind: "browser", name: "Safari", platform: "iOS" }]])
  const rows = [row(20, { runsOn: { kind: "device", deviceId: STUDIO }, activityAt: at(5) }), row(21, { runsOn: { kind: "device", deviceId: LAPTOP }, activityAt: at(9) })]
  const listed = places({ rows, devices: twoMacs, quiet: new Map() }, true)
  assert.deepEqual(listed.map((place) => placeKey(place)), [LAPTOP, STUDIO, CLOUD_PLACE], "browsers aren't places; the cloud comes last")
  assert.equal(placeKey(defaultPlace(listed, undefined)!), LAPTOP)
  assert.equal(placeKey(defaultPlace(listed, STUDIO)!), STUDIO, "the place last started from, while it can start one")
  const laptopOff = places({ rows, devices: twoMacs, quiet: new Map([[LAPTOP, at(0)]]) }, true)
  assert.deepEqual(laptopOff.map((place) => placeKey(place)), [STUDIO, LAPTOP, CLOUD_PLACE], "a Mac that's off goes after the ones that are on")
  assert.equal(placeKey(defaultPlace(laptopOff, LAPTOP)!), STUDIO, "remembered but off: the next that can start one")
  assert.equal(places({ rows, devices: twoMacs, quiet: new Map() }, false).some((place) => place.kind === "cloud"), false, "no cloud without the plan")
})

test("a Mac's projects are its Sessions' folders, a worktree's counted for its project, newest first", () => {
  const rows = [
    row(30, { runsOn: { kind: "device", deviceId: STUDIO }, folder: "/Users/ana/api", activityAt: at(1) }),
    row(31, { runsOn: { kind: "device", deviceId: STUDIO }, folder: "/Users/ana/.mako/worktrees/w1/api", activityAt: at(8) }),
    row(32, { runsOn: { kind: "device", deviceId: STUDIO }, folder: "/Users/ana/web", activityAt: at(4) }),
    row(33, { runsOn: { kind: "device", deviceId: STUDIO }, folder: "/Users/ana/.mako/worktrees/gone/api", activityAt: at(9) }),
    row(34, { folder: "/home/node/cloud-only", activityAt: at(9) }),
  ]
  const worktrees = { root: "/Users/ana/.mako/worktrees", worktrees: [{ path: "/Users/ana/.mako/worktrees/w1/api", thread: uuid(77), repoRoot: "/Users/ana/api", project: "/Users/ana/api", branch: "mako/w1", base: "abc", createdAt: 0 }] }
  // SAFETY: a worktree as `mako:worktrees` answers it; its Thread ID is a branded string.
  const projects = macProjects(rows, STUDIO, worktrees as Parameters<typeof macProjects>[2])
  assert.deepEqual(projects.map((project) => [project.name, project.usedAt]), [["api", Date.parse(at(8))], ["web", Date.parse(at(4))]])
})

test("harnesses are offered as the desk orders them: the account's most recent first, then the person's order", () => {
  const catalog = { order: ["claude", "codex", "opencode"], harnesses: [{ harness: "claude", available: true, pending: false, models: [] }, { harness: "codex", available: true, pending: false, models: [] }, { harness: "opencode", available: false, pending: true, models: [] }, { harness: "grok", available: false, pending: false, models: [] }] }
  const rows = [row(40, { harness: "codex", activityAt: at(9) }), row(41, { harness: "claude", activityAt: at(1) })]
  assert.deepEqual(orderedHarnesses(catalog, rows).map((each) => each.harness), ["codex", "claude", "opencode", "grok"])
})

test("a spring settles where it's sent, from where it is, without overshooting when critically damped", () => {
  const path = springPath(300, 0, 0, SETTLE)
  assert.equal(path[0], 300)
  assert.equal(path.at(-1), 0)
  assert.ok(path.every((value, index) => index === 0 || value <= path[index - 1]! + 1e-9), "never back up")
  assert.ok(path.length < 120, "settles within a second")
  const thrown = springPath(200, 800, 2, SETTLE)
  assert.ok(thrown[1]! - thrown[0]! > 10, "a flick's speed carries into the first frame")
  assert.ok(Math.abs(rubberband(400, 800)) < 400 && rubberband(-400, 800) < 0, "past an edge it moves less, the same way")
})

test("the install is offered once it has earned it: a second day, or an approval answered; not for 30 days after Not now", () => {
  assert.equal(shouldOffer({ days: ["2026-10-28"], answered: false, snoozedUntil: 0 }), false)
  assert.equal(shouldOffer({ days: ["2026-10-27", "2026-10-28"], answered: false, snoozedUntil: 0 }), true)
  assert.equal(shouldOffer({ days: ["2026-10-28"], answered: true, snoozedUntil: 0 }), true)
  assert.equal(shouldOffer({ days: ["2026-10-27", "2026-10-28"], answered: true, snoozedUntil: Date.now() + 1_000 }), false)
})

test("a chip's picture lasts as long as its attachment: a message that didn't go keeps them, removed or sent lets go", () => {
  const picked = (name: string): Picked => ({
    id: name,
    attachment: { name, mimeType: "image/png", size: 1, data: "AA==" },
    preview: URL.createObjectURL(new Blob([name], { type: "image/png" })),
  })
  const live = (each: Picked) => resolveObjectURL(each.preview!) !== undefined
  const previews = new HeldPreviews()
  const [first, second, third] = [picked("a.png"), picked("b.png"), picked("c.png")]
  for (const each of [first, second, third]) previews.hold(each)
  // Picking another, or a send that failed and put them back, throws nothing away.
  assert.ok([first, second, third].every(live), "held while they wait")
  previews.release([first])
  assert.deepEqual([first, second, third].map(live), [false, true, true], "a removed one lets go of its own picture alone")
  previews.release([first])
  previews.release([second])
  assert.deepEqual([second, third].map(live), [false, true], "a sent one lets go")
  previews.releaseAll()
  assert.equal(live(third), false, "the composer gone, every picture with it")
})

test("a start runs in the access the person chose for its harness, the one their account keeps for every device", async () => {
  const claude: Ladder = { defaultMode: "default", modes: [{ id: "default", name: "Default", access: "ask" }, { id: "plan", name: "Plan", access: "plan" }, { id: "bypassPermissions", name: "Bypass permissions", access: "full" }] }
  const cursor: Ladder = { defaultMode: "full-access", modes: [{ id: "full-access", name: "Full access", access: "full" }] }
  const choices = { claude: { mode: "bypassPermissions", access: "full" } }
  // As the desk's chip says it: the tier's name, the harness's own beside it, and the mode a start names.
  assert.deepEqual(accessInEffect("claude", choices, claude), { mode: "bypassPermissions", tier: "full", label: "Full access", detail: "Bypass permissions" })
  // No Mac to list the ladder (a phone, the cloud): the choice stands as the account keeps it.
  assert.deepEqual(accessInEffect("claude", choices, undefined), { mode: "bypassPermissions", tier: "full", label: "Full access" })
  // A mode the harness no longer offers names nothing, so the harness's own configuration decides, as on the desk.
  assert.equal(accessInEffect("claude", { claude: { mode: "gone" } }, claude).label, "Default")
  assert.equal(accessInEffect("codex", choices, undefined).label, "Default")
  // A one-mode harness runs in its one level; plan reads as what it allows.
  assert.deepEqual(accessInEffect("cursor", {}, cursor), { tier: "full", label: "Full access" })
  assert.equal(accessInEffect("claude", { claude: { mode: "plan" } }, claude).label, "Read-only")
  assert.deepEqual(orderedModes(claude.modes).map((mode) => mode.id), ["plan", "default", "bypassPermissions"])

  // Read and changed in the account: one harness's choice sent, all of them answered.
  const sent: Array<{ method: string; path: string; body?: unknown }> = []
  let kept: AccessChoices = { codex: { mode: "access:ask", access: "ask" } }
  const fetched = globalThis.fetch
  // SAFETY: the gateway client calls fetch with a URL and an init, and reads only what this answers.
  globalThis.fetch = (async (input: URL, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ method: init.method ?? "GET", path: input.pathname, body })
    if (init.method === "PATCH") kept = { ...kept, ...AccessChoosingSchema.parse(body).choices }
    return new Response(JSON.stringify({ choices: kept, revision: sent.length }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const gateway = new Gateway({ origin: "https://example.test", connect: async () => ({ token: "t", expiresAt: Date.now() + 60_000, deviceId: uuid(1), account: { id: uuid(2), name: "Ana", email: "ana@example.test", image: null, entitlements: [] } }) })
  try {
    assert.deepEqual(await readAccessChoices(gateway), { codex: { mode: "access:ask", access: "ask" } })
    assert.deepEqual(await chooseAccess(gateway, "claude", claude.modes[2]!), { codex: { mode: "access:ask", access: "ask" }, claude: { mode: "bypassPermissions", access: "full" } })
    assert.deepEqual(sent, [{ method: "GET", path: "/v1/access", body: undefined }, { method: "PATCH", path: "/v1/access", body: { choices: { claude: { mode: "bypassPermissions", access: "full" } } } }])
    // A cloud that doesn't keep them yet: no choices, and a start names no mode.
    // SAFETY: as above; every request is answered as a gateway without the route answers it.
    globalThis.fetch = (async () => new Response(JSON.stringify({ title: "Not found" }), { status: 404, headers: { "content-type": "application/problem+json" } })) as typeof fetch
    assert.equal(await readAccessChoices(gateway), undefined)
  } finally {
    globalThis.fetch = fetched
    gateway.close()
  }
})

test("a status word shows only once it has lasted 400 ms, then stays 400 ms at least: a quick reconnect never flickers", () => {
  let clock = 1_000
  const now = () => clock
  const step = (state: DelayedStatus<string> | null, value: string | null) => stepDelayedStatus(state, "list", value, now)
  // A drop that's over in 300 ms: nothing is ever said.
  let state = step(null, "Reconnecting…")
  assert.equal(state.phase, "pending")
  clock += 300
  state = step(state, null)
  assert.equal(state.phase, "idle", "back before 400 ms: never shown")
  // A drop that lasts: said at 400 ms, and held 400 ms though it's over at once.
  state = step(state, "Reconnecting…")
  clock += 399
  assert.equal(step(state, "Reconnecting…").phase, "pending")
  clock += 1
  state = step(state, "Reconnecting…")
  assert.deepEqual(state, { phase: "shown", key: "list", value: "Reconnecting…", holdUntil: 2_100 })
  assert.equal(delayedStatusDeadline(state), 2_100)
  clock += 50
  state = step(state, null)
  assert.equal(state.phase, "shown", "over 50 ms after it showed: it stays its 400 ms")
  clock = 2_100
  assert.equal(step(state, null).phase, "idle")
  // Another word in its place is said at once, held afresh; another subject starts over.
  assert.deepEqual(step(state, "Connecting…"), { phase: "shown", key: "list", value: "Connecting…", holdUntil: 2_500 })
  assert.equal(stepDelayedStatus(state, "thread", "Syncing…", now).phase, "pending")
})

test("coming back after ten seconds away reads everything again; a glance away only checks the connection", () => {
  assert.equal(returnKind(undefined, 50_000), "probe", "never hidden (a focus, the network back)")
  assert.equal(returnKind(41_000, 50_000), "probe", "away nine seconds")
  assert.equal(returnKind(40_000, 50_000), "long", "away ten seconds")
})

test("a newer build is taken only at a quiet moment: nothing touched for 8 s, no sheet, no keyboard, nothing on its way", () => {
  const quiet = { sinceInput: QUIET_AFTER_MS, sheetOpen: false, typing: false, busy: false }
  assert.equal(quietMoment(quiet), true)
  assert.equal(quietMoment({ ...quiet, sinceInput: QUIET_AFTER_MS - 1 }), false, "touched in the last 8 s")
  assert.equal(quietMoment({ ...quiet, sheetOpen: true }), false, "a sheet is open")
  assert.equal(quietMoment({ ...quiet, typing: true }), false, "the composer has the keyboard")
  assert.equal(quietMoment({ ...quiet, busy: true }), false, "a message is on its way")
  assert.equal(newerBuild("abc123", "def456"), true)
  assert.equal(newerBuild("abc123", "abc123"), false)
  assert.equal(newerBuild("dev", "def456"), false, "a development server never reloads itself")
  assert.equal(newerBuild(undefined, "def456"), false)
  assert.equal(newerBuild("abc123", undefined), false, "a host that names no build")
})

test("a row speaks for its Thread by what needs the person most: an approval, a question, waiting, then work, a failure", () => {
  const rows = [
    row(40, { thread: uuid(140), state: "waiting", waitingFor: "needs-you", waitingOn: "Waiting for you", activityAt: at(9) }),
    row(41, { thread: uuid(141), state: "waiting", waitingFor: "question", waitingOn: "A question: which branch?", activityAt: at(8) }),
    row(42, { thread: uuid(142), state: "waiting", waitingFor: "approval", waitingOn: "Approve: npm test", activityAt: at(1) }),
    // One Session asks a question, another an approval: the approval speaks.
    row(43, { thread: uuid(143), state: "waiting", waitingFor: "question", waitingOn: "A question: which file?", activityAt: at(7) }),
    row(44, { thread: uuid(143), state: "waiting", waitingFor: "approval", waitingOn: "Approve: rm -rf dist", activityAt: at(2) }),
    // At work in one Session, failed in another: it works.
    row(45, { thread: uuid(145), state: "failed", activityAt: at(6) }),
    row(46, { thread: uuid(145), state: "working", changedAt: at(3), activityAt: at(5) }),
    row(47, { thread: uuid(147), state: "failed", activityAt: at(9) }),
  ]
  const { threads } = foldThreads({ rows, devices, quiet: new Map(), waiting: new Map(), archived: [] })
  assert.deepEqual(threads.map((thread) => [thread.id, thread.standing, thread.waitingFor]), [
    [uuid(143), "waiting", "approval"],
    [uuid(142), "waiting", "approval"],
    [uuid(141), "waiting", "question"],
    [uuid(140), "waiting", "needs-you"],
    [uuid(145), "working", undefined],
    [uuid(147), "failed", undefined],
  ])
  assert.equal(threads[0]?.waitingOn, "Approve: rm -rf dist")
  assert.equal(threads.find((thread) => thread.id === uuid(145))?.workingSince, Date.parse(at(3)), "its run started when its owner said it changed")
})

test("a working row counts its run, and a finished one says Done until it's opened again", () => {
  const rows = [row(50, { thread: uuid(150), state: "working" }), row(51, { thread: uuid(151), state: "idle", activityAt: at(20) })]
  const { threads } = foldThreads({ rows, devices, quiet: new Map(), waiting: new Map(), archived: [] })
  const [working, idle] = [threads.find((thread) => thread.id === uuid(150))!, threads.find((thread) => thread.id === uuid(151))!]
  assert.deepEqual(rowDetail(working, false, { now: 1_000 + 42_000, workingSince: 1_000 }), { text: "Working", tone: "working", elapsed: "42s" })
  assert.deepEqual(rowDetail(working, false, { now: 3 * 60_000 + 5_000, workingSince: 0 }).elapsed, "3m")
  assert.deepEqual(rowDetail(working, false, { now: 75 * 60_000, workingSince: 0 }).elapsed, "1h 15m")
  assert.deepEqual(rowDetail(working, false), { text: "Working", tone: "working" }, "a run whose start isn't known says only that it works")
  assert.deepEqual(rowDetail(idle, false, { done: true }), { text: "api", tone: "faint", place: "cloud", lead: "Done" })

  // Read state: first listed reads as seen; a run that finishes after is news until the Thread is opened.
  const listed = { id: uuid(151), activityAt: Date.parse(at(20)) }
  noteListed([listed])
  assert.equal(isUnread(readStore.get(), listed), false, "what was there before is not news")
  const finished = { ...listed, activityAt: Date.parse(at(25)) }
  assert.equal(isUnread(readStore.get(), finished), true, "finished since it was last on screen")
  markSeen(finished.id, finished.activityAt)
  assert.equal(isUnread(readStore.get(), finished), false, "opened: read")
  markUnread(finished.id)
  assert.equal(isUnread(readStore.get(), finished), true, "marked unread by hand")
  markSeen(finished.id, finished.activityAt)
  assert.equal(isUnread(readStore.get(), finished), false, "opened again: the mark goes")
})

test("a row swiped left opens on Archive past 42% of it, and archives past the full swipe or when thrown", () => {
  const width = 393
  assert.equal(commitDistance(width), Math.max(ACTION_PX + 44, width * 0.58))
  assert.equal(commitDistance(320), ACTION_PX + 44 > 320 * 0.58 ? ACTION_PX + 44 : 320 * 0.58)
  const release = (offset: number, velocity = 0) => swipeRelease({ offset, velocity, width })
  assert.equal(release(-ACTION_PX * 0.41), "close", "short of 42% of the action: shut")
  assert.equal(release(-ACTION_PX * 0.43), "open", "past it: open on Archive")
  assert.equal(release(-commitDistance(width) + 1), "open")
  assert.equal(release(-commitDistance(width)), "commit", "a full swipe archives")
  assert.equal(release(-ACTION_PX - 10, -0.8), "commit", "thrown left once Archive is out: archived")
  assert.equal(release(-20, -0.8), "open", "a flick left on a nudge: opened")
  assert.equal(release(-ACTION_PX, 0.8), "close", "a flick right: shut")
  // The row's spring is T3's (stiffness 330, damping 26, mass 0.7): barely under critical, at rest within 0.4 s.
  assert.ok(Math.abs(ROW.response - 0.2894) < 0.001 && Math.abs(ROW.damping - 0.855) < 0.001)
  assert.ok(springPath(-ACTION_PX, 0, 0, ROW).length / 120 < 0.4)
})

/** A page's `localStorage`, for the drafts a composer keeps. */
function withStorage<T>(run: (storage: Map<string, string>) => T): T {
  const storage = new Map<string, string>()
  const held = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  })
  try {
    return run(storage)
  } finally {
    if (held) Object.defineProperty(globalThis, "localStorage", held)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
}

test("a draft is kept by place and by account, and outlives the composer until its message is confirmed sent", () => {
  withStorage((storage) => {
    const here = threadDraftKey("ana", "c1")
    const elsewhere = threadDraftKey("ana", "c2")
    writeDraft(here, "Half a thought about")
    assert.equal(openingText(here, () => false), "Half a thought about")
    assert.equal(openingText(elsewhere, () => false), "", "another Thread's field starts empty")
    assert.equal(openingText(threadDraftKey("ben", "c1"), () => false), "", "another account's drafts aren't read")
    assert.notEqual(newDraftKey("ana", "thread"), here)
    // Sent: the field empties, the words are kept under the message's ID until it's confirmed.
    noteSending(here, "m1", "Half a thought about retries")
    writeDraft(here, "")
    assert.deepEqual(readDraft(here)?.sending, { m1: "Half a thought about retries" })
    // The page goes before the answer, and the outbox still holds the message: it's sent from there, not put back.
    assert.equal(openingText(here, (id) => id === "m1"), "")
    // Nothing holds it (it never reached the outbox): its words come back, after what was written since.
    writeDraft(here, "And another")
    assert.equal(openingText(here, () => false), "And another\n\nHalf a thought about retries")
    assert.equal(readDraft(here)?.sending, undefined)
    // Confirmed: nothing is kept for it, and an empty field keeps nothing at all.
    noteSending(here, "m2", "Second")
    settleSending(here, "m2")
    writeDraft(here, "")
    assert.equal(storage.has(here), false)
    // A month untouched, it goes.
    writeDraft(elsewhere, "Old words", Date.now() - 31 * 24 * 60 * 60_000)
    assert.equal(readDraft(elsewhere), undefined)
  })
})

test("the capsule says one thing, by priority, and Working only once the host started the turn", () => {
  const quiet: DockStatusInput = { online: true, unconfirmed: false, canceling: false, waking: false, wakingMessage: false, running: false, since: undefined, asking: false }
  assert.equal(dockStatus(quiet), undefined)
  assert.deepEqual(dockStatus({ ...quiet, running: true, since: 1 }), { kind: "working", since: 1 })
  assert.equal(dockStatus({ ...quiet, running: true, since: 1, asking: true }), undefined, "the card says it while the agent waits on the person")
  assert.deepEqual(dockStatus({ ...quiet, running: true, since: 1, canceling: true }), { kind: "stopping" })
  assert.deepEqual(dockStatus({ ...quiet, wakingMessage: true }), { kind: "waking", message: true })
  assert.deepEqual(dockStatus({ ...quiet, canceling: true, unconfirmed: true }), { kind: "reconnecting" })
  assert.deepEqual(dockStatus({ ...quiet, online: false, unconfirmed: true, running: true, since: 1 }), { kind: "offline" })
  assert.equal(statusWords({ kind: "waking", message: true }), "Waking the agent… your message sends when it's ready.")
  assert.deepEqual([0, 9_400, 59_999, 60_000, 83_000, 3_600_000 + 120_000].map(workingWords), ["Working 0s", "Working 9s", "Working 59s", "Working 1m 00s", "Working 1m 23s", "Working 1h 02m"])
  assert.deepEqual(["Allow once", "Deny and stop", "Allow matching commands", "Blue"].map(answeredWords), ["Allowed once", "Denied and stopped", "Allowed matching commands", "Blue"])
})

test("a sent message says how its delivery stands, and never Delivered on a guess", () => {
  const sending = new Map<string, Sending>([["waking", "waking"]])
  const conversation = {
    requests: [
      { id: "running", status: "dispatching" as const },
      { id: "behind", status: "queued" as const },
      { id: "answered", status: "completed" as const },
    ],
    pendingPrompts: [{ id: "on-its-way" }, { id: "lost", unconfirmed: true }, { id: "waking" }],
  }
  const said = (id: string) => {
    const delivery = deliveryOf(id, conversation, sending)
    return delivery && DELIVERY_WORDS[delivery]
  }
  assert.deepEqual(["running", "behind", "answered", "on-its-way", "lost", "waking", "unknown"].map(said), ["Delivered", "Queued", undefined, "Sending…", "Not confirmed", "Waking…", undefined])
})

test("a cloud Thread's machine wakes once for every key and message, and is said to wake only when it takes a while", async () => {
  const asked: string[] = []
  let answer: () => void = () => undefined
  // SAFETY: the wake asks only `livePrewarm` of the bridge.
  Object.defineProperty(globalThis, "window", { configurable: true, value: { mako: { livePrewarm: (conversation: string) => (asked.push(conversation), new Promise<"waking">((done) => (answer = () => done("waking")))) } } })
  try {
    const first = wakeThread("t1", "c1")
    const second = wakeThread("t1", "c1")
    assert.equal(first, second, "one wake per Thread, however many ask")
    assert.equal(asked.length, 1)
    assert.equal(wakingNow("t1"), true)
    assert.equal(wakingStore.get().waking.has("t1"), false, "not said at once: an awake machine answers in a moment")
    await new Promise((done) => setTimeout(done, SAY_WAKING_MS + 50))
    assert.equal(wakingStore.get().waking.has("t1"), true)
    answer()
    await first
    assert.equal(wakingStore.get().waking.has("t1"), false)
    assert.equal(wakingNow("t1"), false)
    await wakeThread("t1", "c1")
    assert.equal(asked.length, 1, "woken a moment ago: the next key asks nothing")
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})

test("one send button: Send idle, Stop when empty at work, Steer or Queue by the desk's choice, ✓ while editing", () => {
  const at = (situation: Partial<SendSituation>) => sendPresentation({ running: false, hasContent: true, editingQueued: false, canSteer: false, steerByDefault: true, ...situation })
  assert.deepEqual(at({}), { kind: "send", label: "Send" })
  assert.deepEqual(at({ sendLabel: "Start" }), { kind: "send", label: "Start" })
  assert.equal(at({ hasContent: false }).kind, "send")
  assert.equal(at({ running: true, hasContent: false, canSteer: true }).kind, "stop")
  // The desk's preference decides the tap; a long press offers the other, only where the harness can steer.
  assert.deepEqual(at({ running: true, canSteer: true }), { kind: "steer", label: "Steer", alternate: "queue" })
  assert.deepEqual(at({ running: true, canSteer: true, steerByDefault: false }), { kind: "queue", label: "Queue", alternate: "steer" })
  assert.deepEqual(at({ running: true, canSteer: false }), { kind: "queue", label: "Queue" })
  assert.equal(at({ running: true, editingQueued: true }).kind, "update")
  assert.equal(at({ running: true, hasContent: false, editingQueued: true }).kind, "update")
  // Words under an open question answer it: Send, whatever the turn is doing.
  assert.deepEqual(at({ running: true, canSteer: true, answering: true }), { kind: "send", label: "Send answer" })
  assert.equal(at({ running: true, hasContent: false, answering: true }).kind, "stop")
  assert.equal(sendChoiceDetail("queue", "step"), "Runs after this turn")
  assert.notEqual(sendChoiceDetail("steer", "interrupt"), sendChoiceDetail("steer", "step"))
})

test("dictation's meter: −60 dB is silence, 0 dB full, the square root between; words append, the last three unsure", () => {
  assert.equal(meterLevel(undefined), 0)
  assert.equal(meterLevel(-Infinity), 0)
  assert.equal(meterLevel(-60), 0)
  assert.equal(meterLevel(-75), 0)
  assert.equal(meterLevel(0), 1)
  assert.equal(meterLevel(6), 1)
  const quiet = meterLevel(-40)
  const loud = meterLevel(-10)
  assert.ok(quiet > 0.05 && quiet < loud && loud < 1)
  // Square-root scaling: −40 dB (amplitude 0.01) reads near 0.1, not 0.01.
  assert.ok(Math.abs(quiet - Math.sqrt((0.01 - 0.001) / (1 - 0.001))) < 1e-9)
  assert.equal(frameDecibels(new Uint8Array(64).fill(128)), -Infinity)
  assert.ok(Math.abs(frameDecibels(Uint8Array.from({ length: 64 }, (_, index) => (index % 2 ? 192 : 64))) - 20 * Math.log10(0.5)) < 1e-9)
  assert.deepEqual(splitUnsure("check the retry backoff on a slow runner"), { sure: "check the retry backoff on", unsure: "a slow runner" })
  assert.deepEqual(splitUnsure("two words"), { sure: "", unsure: "two words" })
  assert.equal(elapsedWords(7_400), "0:07")
  assert.equal(elapsedWords(102_000), "1:42")
  assert.equal(elapsedWords(725_000), "12:05")
  assert.equal(appendHeard("", " Let's check "), "Let's check")
  assert.equal(appendHeard("Fix the retry.", "Then the lint"), "Fix the retry. Then the lint")
  assert.equal(appendHeard("Fix it\n", "then"), "Fix it\nthen")
  assert.equal(appendHeard("Kept", "  "), "Kept")
})

test("a run of steps is one line: its count and its newest step, present while it runs, failed when it failed", () => {
  const call = (id: string, kind: "shell" | "read", target: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id, name: kind, tool: { kind, name: kind, label: kind === "shell" ? "Shell" : "Read", target }, pending: false, ...extra })
  const three = [call("a", "read", "test/payments.mjs"), call("b", "shell", "npm test"), call("c", "shell", "npm run lint")]
  assert.deepEqual(stepsLine(three, false), { count: "3 steps", newest: "ran npm run lint", running: false, failed: false })
  assert.deepEqual(stepsLine([...three.slice(0, 2), call("c", "shell", "npm run lint", { pending: true })], true), { count: "3 steps", newest: "running npm run lint", running: true, failed: false })
  // A finished record's call that never returned isn't running: only a live run's is.
  assert.equal(stepsLine([call("c", "shell", "sleep 9", { pending: true })], false).running, false)
  assert.equal(stepsLine([...three.slice(0, 2), call("c", "shell", "npm run lint", { isError: true })], false).failed, true)
  assert.equal(stepsLine([call("c", "shell", "npm test", { isCanceled: true })], false).newest, "Ran npm test · stopped")
  // One step is its own words: a count of one says nothing.
  assert.deepEqual(stepsLine([call("a", "read", "README.md")], false), { count: "", newest: "Read README.md", running: false, failed: false })
  assert.equal(freshStep({ startedAt: 10_000 }, 12_000), true)
  assert.equal(freshStep({ startedAt: 10_000 }, 13_500), false)
  assert.equal(freshStep({}, 13_500), false)
})

test("a switch from the composer leaves its line: switched, or not, in so many words", () => {
  assert.equal(switchedWords({ what: "GPT-5.5", refused: false }), "Switched to GPT-5.5")
  assert.equal(switchedWords({ what: "Full access", refused: true }), "Not switched to Full access")
})

test("dictation listens until it's stopped: silence starts it again, and what it was still hearing is kept", () => {
  const made: FakeRecognizer[] = []
  class FakeRecognizer extends EventTarget implements Recognition {
    lang = ""
    continuous = false
    interimResults = false
    onresult: Recognition["onresult"] = null
    onend: Recognition["onend"] = null
    onerror: Recognition["onerror"] = null
    stopped = false
    constructor() {
      super()
      made.push(this)
    }
    start() {}
    stop() {
      this.stopped = true
      this.onend?.()
    }
    abort() {}
    say(results: Array<[string, boolean]>) {
      this.onresult?.({ resultIndex: 0, results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) })
    }
  }
  const settled: string[] = []
  const hearing: string[] = []
  let ended: string | undefined | null = null
  const session = new DictationSession(FakeRecognizer, { settled: (words) => settled.push(words), hearing: (words) => hearing.push(words), levels: () => undefined, ended: (why) => (ended = why) })
  session.begin()
  made[0]!.say([["Check the retry", true], ["backoff on a", false]])
  made[0]!.say([["Check the retry", true], ["backoff on a slow", false]])
  assert.deepEqual(settled, ["Check the retry"])
  assert.equal(hearing.at(-1), "backoff on a slow")
  // The platform ends it on silence: what it was hearing is kept, and it listens again.
  made[0]!.onend?.()
  assert.deepEqual(settled, ["Check the retry", "backoff on a slow"])
  assert.equal(made.length, 2)
  assert.equal(ended, null)
  made[1]!.say([["runner", true]])
  session.end(false)
  assert.equal(made[1]!.stopped, true)
  assert.deepEqual(settled, ["Check the retry", "backoff on a slow", "runner"])
  assert.equal(ended, undefined)
})

test("dictation that fails keeps what it heard and says why; one that won't listen stops rather than looping", () => {
  const made: Array<Recognition & { fail(error: string): void }> = []
  class Failing extends EventTarget implements Recognition {
    lang = ""
    continuous = false
    interimResults = false
    onresult: Recognition["onresult"] = null
    onend: Recognition["onend"] = null
    onerror: Recognition["onerror"] = null
    constructor() {
      super()
      made.push(this)
    }
    start() {}
    stop() {}
    abort() {}
    fail(error: string) {
      this.onerror?.({ error })
      this.onend?.()
    }
  }
  const settled: string[] = []
  let ended: string | undefined | null = null
  const session = new DictationSession(Failing, { settled: (words) => settled.push(words), hearing: () => undefined, levels: () => undefined, ended: (why) => (ended = why) })
  session.begin()
  made[0]!.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "half a sentence" } }] })
  made[0]!.fail("network")
  assert.deepEqual(settled, ["half a sentence"])
  assert.equal(ended, "Dictation stopped. What it heard is kept.")
  // Ending again and again with nothing heard: it gives up after a few tries instead of spinning.
  let quit: string | undefined | null = null
  const looping = new DictationSession(Failing, { settled: () => undefined, hearing: () => undefined, levels: () => undefined, ended: (why) => (quit = why) })
  const before = made.length
  looping.begin()
  for (let index = 0; index < 8 && quit === null; index++) made.at(-1)!.onend?.()
  assert.ok(made.length - before <= 5)
  assert.equal(quit, "Dictation stopped. What it heard is kept.")
})

const reach = (fields: Partial<ReachInput> = {}): ReachInput => ({ now: Date.parse("2026-10-30T12:00:00Z"), online: true, cloud: "ok", ...fields })

test("what can't be reached is said at the first hop that failed, every hop before it reached and every one after not checked", () => {
  const studio = { name: "Studio", link: "unknown" as const }
  assert.equal(diagnose(reach({ mac: studio, harness: { name: "Codex", state: "unknown" } })), undefined, "nothing failed: nothing said, and nothing unknown is painted as off")
  const asleep = diagnose(reach({ mac: { ...studio, quietSince: "2026-10-30T11:55:00Z" }, harness: { name: "Codex", state: "unknown" } }))
  assert.equal(asleep?.headline, "Studio is asleep or offline")
  assert.equal(asleep?.detail, "Last seen 5 minutes ago")
  assert.deepEqual(asleep?.hops.map((hop) => [hop.label, hop.state]), [["This phone", "ok"], ["Mako Cloud", "ok"], ["Studio", "failed"], ["Codex", "unknown"]])
  assert.equal(asleep?.causes[0], "It may be asleep, or its lid closed.")
  const ahead = diagnose(reach({ mac: { ...studio, quietSince: "2026-10-30T12:09:00Z" } }))
  assert.equal(ahead?.detail, "Last seen a moment ago", "a clock ahead of this one never makes it seen in the future")
  assert.equal(lastSeen("not a time", reach().now), "a moment ago")
  const closed = diagnose(reach({ mac: { ...studio, link: "failed" }, failure: { message: "No answer", at: reach().now, correlationId: "c-9", outcome: "owner-unavailable" } }))
  assert.equal(closed?.headline, "Mako Cloud answers, but Studio's Mako isn't connected")
  assert.ok(closed && diagnosisText(closed).includes("Correlation ID: c-9"), "its correlation ID goes with the diagnostics")
  assert.equal(diagnose(reach({ online: false, cloud: "failed", mac: { ...studio, quietSince: "2026-10-30T11:00:00Z" } }))?.headline, "This phone is offline", "the nearest hop that failed is the one said")
  assert.equal(diagnose(reach({ cloud: "failed", mac: studio }))?.headline, "Mako Cloud isn't answering")
  const harness = diagnose(reach({ mac: { ...studio, link: "ok" }, harness: { name: "Codex", state: "failed", reason: "Codex is not installed" } }))
  assert.equal(harness?.headline, "Codex on Studio didn't start")
  assert.equal(harness?.detail, "Codex is not installed")
  assert.deepEqual(harness?.hops.map((hop) => hop.state), ["ok", "ok", "ok", "failed"])
  assert.equal(diagnose(reach({ machine: { state: "unknown" }, harness: { name: "Claude", state: "failed" } }))?.headline, "Claude in the cloud didn't start")
})

test("what a call met is kept by the place it went to: refused as not connected is not reached, refused by the host itself is reached", () => {
  const log = reachLog("d-studio")
  const quiet = console.warn
  console.warn = () => undefined
  try {
    log.warn("operation failed", { op: "live.read", correlationId: "c-1", attempt: 1, outcome: "owner-unavailable", ms: 3 })
    assert.deepEqual(reachStore.get().places.get("d-studio")?.ok, false)
    assert.equal(reachStore.get().places.get("d-studio")?.correlationId, "c-1")
    log.warn("operation failed", { op: "live.start", correlationId: "c-2", attempt: 1, outcome: "failed", ms: 3 })
    assert.equal(reachStore.get().places.get("d-studio")?.ok, true, "a harness's own refusal came from a Mac that answered")
    log.warn("a conversation's stream ended", { stream: "x" })
    assert.equal(reachStore.get().places.get("d-studio")?.ok, true, "other lines say nothing of reach")
    for (const outcome of ["unavailable", "restarting"]) {
      log.warn("operation failed", { op: "live.read", correlationId: "c-3", attempt: 1, outcome, ms: 3 })
      assert.equal(reachStore.get().places.get("d-studio")?.ok, false, `${outcome}: its host is closing, not reached`)
      log.warn("operation failed", { op: "live.start", correlationId: "c-4", attempt: 1, outcome: "failed", ms: 3 })
    }
    for (const outcome of ["not-found", "conflict", "fenced", "bad-request", "forbidden"]) {
      log.warn("operation failed", { op: "live.read", correlationId: "c-5", attempt: 1, outcome, ms: 3 })
      assert.equal(reachStore.get().places.get("d-studio")?.ok, true, `${outcome} came from a Mac that answered`)
    }
    log.warn("operation lost", { op: "live.read", correlationId: "c-6", attempt: 1, error: "socket closed" })
    assert.equal(reachStore.get().places.get("d-studio")?.ok, true, "a call this browser's socket lost says nothing of the Mac")
  } finally {
    console.warn = quiet
  }
})

test("a read the network failed is asked once more; a change never is", async () => {
  const fetched: string[] = []
  const real = globalThis.fetch
  // SAFETY: a stand-in that answers the two calls this test makes, as fetch does: a promise of a Response.
  globalThis.fetch = (async (_url: URL, init: RequestInit) => {
    fetched.push(init.method ?? "GET")
    if (fetched.length % 2 === 1) throw new TypeError("Load failed")
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const gateway = new Gateway({ origin: "https://example.test", connect: async () => ({ token: "t", expiresAt: Date.now() + 600_000, deviceId: uuid(1), account: { id: uuid(2), name: "Ana", email: "ana@example.test", image: null, entitlements: [] } }) })
  try {
    assert.deepEqual(await gateway.rest("GET", "/v1/devices"), { ok: true })
    assert.deepEqual(fetched, ["GET", "GET"])
    fetched.length = 0
    await assert.rejects(gateway.rest("PUT", "/v1/sessions/x/waiting/y", { text: "hi" }), /Load failed/)
    assert.deepEqual(fetched, ["PUT"], "a message may have landed: it isn't sent twice")
  } finally {
    globalThis.fetch = real
    gateway.close()
  }
})

test("a read the network failed and then refused as run out is still renewed once", async () => {
  const seen: string[] = []
  const real = globalThis.fetch
  let tries = 0
  // SAFETY: a stand-in that answers as fetch does: a promise of a Response, or a network failure.
  globalThis.fetch = (async (_url: URL, init: RequestInit) => {
    seen.push(new Headers(init.headers).get("authorization") ?? "")
    tries++
    if (tries === 1) throw new TypeError("Load failed")
    if (tries === 2) return new Response(JSON.stringify({ title: "Expired" }), { status: 401 })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  let asked = 0
  const gateway = new Gateway({ origin: "https://example.test", connect: async () => ({ token: `t${++asked}`, expiresAt: Date.now() + 600_000, deviceId: uuid(1), account: { id: uuid(2), name: "Ana", email: "ana@example.test", image: null, entitlements: [] } }) })
  try {
    assert.deepEqual(await gateway.rest("GET", "/v1/devices"), { ok: true })
    assert.deepEqual(seen, ["Bearer t1", "Bearer t1", "Bearer t2"], "asked again after the network, then renewed")
  } finally {
    globalThis.fetch = real
    gateway.close()
  }
})

test("a move's bar only goes forward: each step its own span, an upload by its bytes, a wait creeping and never reaching the next step", () => {
  const packingStart = stepFraction("cloud", "packing", 0)!
  const handing = stepFraction("cloud", "handing-over", 0)!
  assert.ok(stepFraction("cloud", "asking", 0)! < packingStart)
  assert.ok(stepFraction("cloud", "packing", 10 * 60_000)! < stepFraction("cloud", "pausing", 0)!, "a wait never reaches the next step, however long")
  const half = stepFraction("cloud", "packing", 0, { bytes: 5_000_000, of: 10_000_000 })!
  assert.ok(half > packingStart && half < stepFraction("cloud", "packing", 0, { bytes: 10_000_000, of: 10_000_000 })!, "an upload fills by its bytes")
  assert.ok(handing > half)
  assert.equal(stepFraction("cloud", "unsettled", 0), undefined, "an answer waited on keeps the bar where it was")
  assert.equal(forward(0.5, 0.3), 0.5, "a step back (a bigger upload added) never moves it back")
  assert.equal(forward(0.5, undefined), 0.5)
  assert.equal(forward(0.2, 0.3), 0.3)
  assert.equal(percentWords(0.999, false), "99% done", "never 100 before it ends")
  assert.equal(percentWords(0.4, true), "100% done")
  assert.equal(sentWords({ bytes: 3_200_000, of: 14_400_000 }), "3.2 of 14 MB")
  assert.equal(stepWords("device", "bringing", "Studio", false), "Bringing it to Studio")
  assert.equal(stepWords("cloud", "packing", "Studio", true), "Sending ahead while it works")
})

test("a move is followed from its steps, said by the list from its first step, and ends once", () => {
  const thread = uuid(100)
  movesStore.set({ moves: new Map() })
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "packing" }, thread, mac: { deviceId: STUDIO, name: "Studio" } })
  assert.equal(movesStore.get().moves.get(thread)?.ours, false, "a move asked on the Mac is followed here too")
  const began = movesStore.get().moves.get(thread)?.stepAt
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "packing", sent: { bytes: 1, of: 4 } }, thread, mac: undefined })
  assert.equal(movesStore.get().moves.get(thread)?.stepAt, began, "its bytes don't start the step again")
  assert.deepEqual(movesStore.get().moves.get(thread)?.sent, { bytes: 1, of: 4 })
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "pausing" }, thread, mac: undefined })
  assert.equal(movesStore.get().moves.get(thread)?.handOff, true, "a pause says its turn goes along")
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "kept-here", reason: "The cloud is full." }, thread, mac: undefined })
  assert.deepEqual(movesStore.get().moves.get(thread)?.end, { kind: "failed", reason: "The cloud is full." })
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "moved", conversations: ["c1"] }, thread, mac: undefined })
  assert.equal(movesStore.get().moves.get(thread)?.end?.kind, "failed", "an end is said once")
  putMove({ thread: uuid(200), conversation: "c2", way: "device", mac: { deviceId: STUDIO, name: "Studio" }, step: "asking", stepAt: 0, handOff: false, ours: true })
  movesStore.set({ moves: new Map() })
  const going = foldThreads({ rows: [row(1, { runsOn: { kind: "device", deviceId: STUDIO }, move: { to: "cloud", step: "packing", since: at(1) } })], devices, quiet: new Map(), waiting: new Map(), archived: [] }).threads[0]!
  assert.equal(going.standing, "moving", "a Thread on its way stands with the ones at work from its first step")
  assert.equal(listedMove(going)?.way, "cloud")
  assert.equal(rowDetail(going, false, { move: "cloud" }).text, "Moving to the cloud")
  const transit = foldThreads({ rows: [row(2, { state: "moving" })], devices, quiet: new Map(), waiting: new Map(), archived: [] }).threads[0]!
  assert.equal(listedMove(transit)?.way, "device", "a cloud Thread in transit is coming back")
})

test("a move whose answer the network lost is not confirmed, asked again under the same ID, and ends as the Mac says", async () => {
  const thread = uuid(100)
  const mac = { deviceId: STUDIO, name: "Studio" }
  const ask = { thread, conversation: "c1", way: "cloud" as const, mac, move: "m1" }
  movesStore.set({ moves: new Map() })
  putMove({ thread, conversation: "c1", way: "cloud", mac, move: "m1", step: "asking", stepAt: Date.now(), handOff: false, ours: true })
  const asked: number[] = []
  const said: Array<string | undefined> = []
  await followAnswer(
    ask,
    async (attempt) => {
      asked.push(attempt)
      if (attempt === 0) throw new RuntimeDisconnectedError(true, undefined, "The connection dropped mid-call.")
      return { kind: "done" }
    },
    async () => {
      said.push(movesStore.get().moves.get(thread)?.end?.kind)
      // Meanwhile the Mac goes on, and its steps say so.
      stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "packing" }, thread, mac })
      said.push(movesStore.get().moves.get(thread)?.end?.kind ?? movesStore.get().moves.get(thread)?.step)
    }
  )
  assert.deepEqual(said, ["unconfirmed", "packing"], "not confirmed, never failed; a later step carries it on")
  assert.deepEqual(asked, [0, 1], "asked again, by the same move: its ask carries one ID")
  assert.equal(movesStore.get().moves.get(thread)?.end?.kind, "done", "and it ends as the Mac answers")
  assert.equal(movesStore.get().moves.get(thread)?.move, "m1", "no second move")

  // Dropped, then its last step heard before the next ask: the step's end overrides what the phone assumed.
  movesStore.set({ moves: new Map() })
  putMove({ thread, conversation: "c1", way: "cloud", mac, move: "m2", step: "packing", stepAt: Date.now(), handOff: false, ours: true })
  const calls: number[] = []
  await followAnswer({ ...ask, move: "m2" }, async (attempt) => {
    calls.push(attempt)
    throw new RuntimeDisconnectedError(true)
  }, async () => stepHeard({ conversation: "c1", move: "m2", way: "cloud", step: { kind: "moved", conversations: ["c1"] }, thread, mac }))
  assert.equal(movesStore.get().moves.get(thread)?.end?.kind, "done")
  assert.deepEqual(calls, [0], "nothing is asked once its end is heard")

  // Asked of a Mac that's off: nothing started, said as it is.
  movesStore.set({ moves: new Map() })
  putMove({ thread, conversation: "c1", way: "cloud", mac, move: "m3", step: "asking", stepAt: Date.now(), handOff: false, ours: true })
  await followAnswer({ ...ask, move: "m3" }, async () => {
    throw new OwnerUnavailableError(false, undefined, "Studio's Mako isn't connected.")
  })
  assert.deepEqual(movesStore.get().moves.get(thread)?.end, { kind: "failed", reason: "Studio's Mako isn't connected." })

  // The owner's refusal is its last word; an end only assumed here isn't.
  movesStore.set({ moves: new Map() })
  putMove({ thread, conversation: "c1", way: "cloud", mac, move: "m4", step: "packing", stepAt: 0, handOff: false, ours: true })
  endMove(thread, "m4", { kind: "unconfirmed", reason: "x" })
  stepHeard({ conversation: "c1", move: "m4", way: "cloud", step: { kind: "kept-here", reason: "The cloud is full." }, thread, mac })
  assert.deepEqual(movesStore.get().moves.get(thread)?.end, { kind: "failed", reason: "The cloud is full." })
  endMove(thread, "m4", { kind: "unconfirmed", reason: "x" })
  assert.equal(movesStore.get().moves.get(thread)?.end?.kind, "failed", "a lost answer after it changes nothing")
  movesStore.set({ moves: new Map() })
})

test("a main-checkout Thread's move follows the conversation it forked to onto its own branch, to its end", () => {
  const thread = uuid(100)
  const mac = { deviceId: STUDIO, name: "Studio" }
  movesStore.set({ moves: new Map() })
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "own-branch" }, thread, mac })
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "own-branch", to: "c-fork" }, thread, mac })
  assert.equal(movesStore.get().moves.get(thread)?.conversation, "c-fork", "the rest of its steps are the fork's, and that's what's followed")
  // The fork's own steps, heard on its own stream, where the list doesn't name it yet.
  stepHeard({ conversation: "c-fork", move: "m1", way: "cloud", step: { kind: "packing" }, thread: undefined, mac: undefined })
  assert.equal(movesStore.get().moves.get(thread)?.step, "packing")
  stepHeard({ conversation: "c-fork", move: "m1", way: "cloud", step: { kind: "moved", conversations: ["c-fork"] }, thread: undefined, mac: undefined })
  assert.equal(movesStore.get().moves.get(thread)?.end?.kind, "done", "it ends rather than freezing at its own branch")
  movesStore.set({ moves: new Map() })
})

test("a move's bar never goes back as the list's word gives way to its steps: the step began when the list said", () => {
  const thread = uuid(100)
  const mac = { deviceId: STUDIO, name: "Studio" }
  movesStore.set({ moves: new Map() })
  const since = new Date(Date.now() - 20_000).toISOString()
  const going = foldThreads({ rows: [row(1, { runsOn: { kind: "device", deviceId: STUDIO }, move: { to: "cloud", step: "packing", since } })], devices, quiet: new Map(), waiting: new Map(), archived: [] }).threads[0]!
  const listed = listedMove(going)!
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "packing", sent: { bytes: 0, of: 10 } }, thread, mac, listed: { to: "cloud", step: "packing", since } })
  const followed = movesStore.get().moves.get(thread)!
  assert.equal(followed.stepAt, listed.stepAt, "seeded from the list's since, not restarted now")
  const now = Date.now()
  assert.equal(stepFraction("cloud", followed.step, now - followed.stepAt, followed.sent), stepFraction("cloud", listed.step, now - listed.stepAt))
  // The bar the list drew is carried to the move it turns out to be; a retry, another move, starts its own.
  assert.deepEqual(barFrom({ move: undefined, fraction: 0.34 }, "m1"), { move: "m1", fraction: 0.34 })
  assert.deepEqual(barFrom({ move: "m1", fraction: 0.34 }, "m1"), { move: "m1", fraction: 0.34 })
  assert.deepEqual(barFrom({ move: "m1", fraction: 0.6 }, "m2"), { move: "m2", fraction: 0 })
  // A row's arrow reads only which way it goes: its bytes are no change to the list.
  const before = followedWays(movesStore.get().moves)
  stepHeard({ conversation: "c1", move: "m1", way: "cloud", step: { kind: "packing", sent: { bytes: 5, of: 10 } }, thread, mac: undefined })
  assert.deepEqual(followedWays(movesStore.get().moves), before)
  movesStore.set({ moves: new Map() })
})

test("an open cloud Thread's app is read passively: an asleep machine is said asleep, never woken; opening the app wakes it", async () => {
  const sent: Operation[] = []
  let asleep = true
  const session: ClientSession = {
    subscribe: () => {
      throw new Error("nothing is followed here")
    },
    watch: () => {
      throw new Error("nothing is watched here")
    },
    call: async (operation: Operation): Promise<Reply> => {
      sent.push(operation)
      if (asleep && operation.passive) return { v: 1, id: operation.id, ok: false, problem: problem("owner-unavailable", "Its machine is asleep", operation.correlationId, "not-applied") }
      return { v: 1, id: operation.id, ok: true, value: Payload.encoded(encodeRuntimeValue({ kind: "ready", project: "api", phase: "running", processes: [{ name: "web", state: "running", port: 5173 }], checks: [] })!) }
    },
  }
  const client = { gateway: { session }, deviceId: uuid(1) }
  const owner = { kind: "cloud", threadId: "t-0123456789abcdef" } as const
  const looked = await readApp(client, owner, "/srv/api", { passive: true })
  assert.equal(sent[0]?.passive, true, "the look a Thread on screen keeps taking is passive")
  assert.deepEqual([looked?.asleep, looked?.runnable, looked?.servers.length], [true, true, 0], "asleep, said so: Run wakes it")
  assert.equal(sent.length, 1, "a passive look isn't repeated until the machine wakes")
  asleep = false
  const opened = await readApp(client, owner, "/srv/api")
  assert.equal(sent[1]?.passive, undefined, "the person opening the app asks as themselves")
  assert.equal(opened?.servers[0]?.state, "ready")
  appsStore.set({ apps: new Map(), conversations: new Map() })
  assert.ok(appKey(owner, "/srv/api"))
})

test("a running app is said once per screen: the capsule on a phone, its cards where there's room", () => {
  assert.equal(appShownAs("phone"), "capsule")
  assert.equal(appShownAs("tablet"), "cards")
  assert.equal(appShownAs("desk"), "cards")
})

test("Mako Cloud is one fact for the list and a Thread: the live stream says it answers, whatever one request met", () => {
  const failed = { at: 1, ok: false, outcome: "502", message: "The gateway answered 502" }
  assert.equal(cloudReach({ phase: "live" }, failed).state, "ok", "the list's live stream answers now")
  assert.deepEqual(cloudReach({ phase: "reconnecting" }, failed), { state: "failed", failure: { message: "The gateway answered 502", at: 1, outcome: "502" } })
  assert.equal(cloudReach({ phase: "reconnecting" }, { at: 2, ok: true }).state, "ok")
  assert.equal(cloudReach({ phase: "starting" }, undefined).state, "unknown")
})

test("a Thread's app as servers: each process with a port, Ready once it runs, Starting… on its way, the address the host names first", () => {
  const ready = serversOf({ kind: "ready", project: "api", phase: "running", address: { host: "127.0.0.1", port: 5173 }, processes: [{ name: "api", state: "running", port: 8787 }, { name: "web", state: "running", port: 5173 }, { name: "worker", state: "running" }], checks: [] })
  assert.deepEqual(ready.servers, [{ name: "web", port: 5173, state: "ready" }, { name: "api", port: 8787, state: "ready" }])
  assert.equal(ready.runnable, false)
  const starting = serversOf({ kind: "ready", project: "api", phase: "starting", processes: [{ name: "web", state: "starting", port: 5173 }], checks: [] })
  assert.equal(starting.servers[0]?.state, "starting")
  const stopped = serversOf({ kind: "ready", project: "api", phase: "stopped", processes: [{ name: "web", state: "stopped", port: 5173 }], checks: [] })
  assert.deepEqual([stopped.servers[0]?.state, stopped.runnable], ["stopped", true])
  assert.match(serversOf({ kind: "none", project: "api", root: "/x" }).reason ?? "", /isn't set up yet/)
  assert.deepEqual(loopbackTarget("http://localhost:5173/login?next=1#a"), { port: 5173, path: "/login?next=1#a" })
  assert.deepEqual(loopbackTarget("http://127.0.0.1:3000"), { port: 3000, path: "/" })
  assert.deepEqual(loopbackTarget("http://[::1]:8080/x"), { port: 8080, path: "/x" })
  assert.deepEqual(loopbackTarget("http://app.localhost:4000/"), { port: 4000, path: "/" })
  assert.equal(loopbackTarget("https://example.com:5173/"), undefined, "another computer's address opens as itself")
  assert.equal(loopbackTarget("file:///etc/hosts"), undefined)
  assert.equal(withPath("https://p-1.example.test/", "/login?next=1"), "https://p-1.example.test/login?next=1")
  assert.equal(withPath("https://p-1.example.test/", "//evil.test/x"), "https://p-1.example.test/", "a path never leaves the grant's origin")
})

test("a Mac to connect: none yet, one that joined and isn't heard from, one that's there", () => {
  const none = macConnection({ devices: new Map(), rows: [], quiet: new Map() }, new Set())
  assert.equal(connectStep(none), "install")
  const joined = macConnection({ devices, rows: [], quiet: new Map() }, new Set())
  assert.deepEqual([joined.mac?.name, connectStep(joined)], ["Studio", "connect"])
  assert.equal(connectStep(macConnection({ devices, rows: [row(1, { runsOn: { kind: "device", deviceId: STUDIO } })], quiet: new Map() }, new Set())), "done", "it listed what it runs")
  assert.equal(connectStep(macConnection({ devices, rows: [], quiet: new Map() }, new Set([STUDIO]))), "done", "or answered")
  const asleep = macConnection({ devices, rows: [], quiet: new Map([[STUDIO, at(1)]]) }, new Set())
  assert.equal(asleep.connected, false, "a quiet one isn't there")
  assert.equal(connectStep(asleep), "done", "but it connected before, with nothing to list: a Mac to wake, not to connect")
})
