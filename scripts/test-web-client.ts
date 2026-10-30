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
