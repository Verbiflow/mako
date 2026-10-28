import assert from "node:assert/strict"
import { test } from "node:test"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { foldThreads, openingSession } from "../src/web-client/threads"
import { parseRoute, routeHref, type WebRoute } from "../src/web-client/route"
import { typedRepository } from "../src/web-client/account"
import { Gateway } from "../src/web-client/gateway"

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
