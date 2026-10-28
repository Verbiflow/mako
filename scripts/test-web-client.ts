import assert from "node:assert/strict"
import { test } from "node:test"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { foldThreads, openingSession } from "../src/web-client/threads"
import { parseRoute, routeHref, type WebRoute } from "../src/web-client/route"
import { typedRepository } from "../src/web-client/account"
import { Gateway } from "../src/web-client/gateway"
import { rowDetail } from "../src/web-client/rows"
import { CLOUD_PLACE, defaultPlace, macProjects, orderedHarnesses, placeKey, places } from "../src/web-client/places"
import { rubberband, SETTLE, springPath } from "../src/web-client/motion"
import { shouldOffer } from "../src/web-client/install"

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
  for (const route of routes) {
    const href = new URL(routeHref(route, "/app/"), "https://example.test")
    assert.deepEqual(parseRoute(href.pathname, href.search, "/app/"), route)
  }
  assert.deepEqual(parseRoute("/elsewhere", "", "/app/"), { kind: "list" })
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
