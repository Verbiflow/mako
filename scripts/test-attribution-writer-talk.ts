import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { FakeClock, FakeEventSource, FakeFileSystem } from "@mako/protocol/attribution-conformance"
import type { ChildSource, Thread } from "@mako/sessions"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { TURN_CHANGES_VERSION } from "@mako/host/contracts/turn-changes"
import { Backfill, type BackfillSession } from "@mako/host/attribution/backfill"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { contextChange, type SentContext } from "@mako/host/attribution/writer-client"
import { applyContextChange, WriterContextChangeSchema, type HeldContext } from "@mako/host/attribution/writer-protocol"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { residentOf } from "@mako/host/conversations/live-runtime"
import { LiveTurnChanges, type TurnLedger } from "@mako/host/conversations/live-turn-changes"

/*
 * What crosses between the host and the journal's writer, and how often: the host's context once a change, a
 * read-back's passes one at a time with one waiting, and a turn's settled count following what the writer says.
 */

const microtasks = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

test("the host's context crosses once a change, and only the sessions that moved", () => {
  const row = (path: string, updatedAt: string) => ({ harness: "claude", nativeId: path, path, cwd: "/work", updatedAt, threadId: "thread", sessionId: "session", title: "never read by the writer", messages: 400 })
  let rows = [row("/sessions/a", "2026-11-01T00:00:00Z"), row("/sessions/b", "2026-11-01T00:00:00Z"), row("/sessions/c", "2026-11-01T00:00:00Z")]
  const stores = ["/stores/claude"]
  const running = {}
  let sent: SentContext = { version: 0, byPath: new Map(), running: "" }
  let held: HeldContext = { version: 0, sessions: new Map(), context: { sessions: [], running: {}, stores: [] } }
  const crossed: number[] = []
  // One ask as the writer makes it: its version to the host, the answer through the port's schema, applied.
  const ask = () => {
    const told = contextChange(sent, held.version, { rows, running, stores })
    sent = told.sent
    const change = WriterContextChangeSchema.parse(structuredClone(told.change))
    crossed.push("same" in change ? 0 : change.sessions.length)
    held = applyContextChange(held, change)
    return held.context
  }
  assert.deepEqual(ask().sessions.map((session) => session.path), ["/sessions/a", "/sessions/b", "/sessions/c"])
  assert.equal("title" in ask().sessions[0]!, false, "only what the writer reads crosses")
  ask()
  assert.deepEqual(crossed, [3, 0, 0], "asked again with nothing moved, nothing crosses")
  // One session writes its record: the catalog puts a new row in its place, the others' objects as they were.
  rows = rows.map((item) => (item.path === "/sessions/b" ? row("/sessions/b", "2026-11-02T00:00:00Z") : item))
  assert.equal(ask().sessions.find((session) => session.path === "/sessions/b")?.updatedAt, "2026-11-02T00:00:00Z")
  ask()
  rows = rows.filter((item) => item.path !== "/sessions/a")
  assert.deepEqual(ask().sessions.map((session) => session.path), ["/sessions/b", "/sessions/c"], "a session that went is taken out")
  assert.deepEqual(crossed, [3, 0, 0, 1, 0, 0], "the one changed session crosses once; a removal sends none")
  // A writer whose version isn't the host's last (a new worker, a lost answer) gets everything, in place of what it held.
  held = { ...held, version: held.version - 1, sessions: new Map([...held.sessions, ["/sessions/stale", held.sessions.get("/sessions/b")!]]) }
  assert.deepEqual(ask().sessions.map((session) => session.path), ["/sessions/b", "/sessions/c"])
})

test("read-back passes run one at a time with one waiting for every ask, each within its budget and only over the folders asked", async () => {
  let now = 0
  const opened: string[] = []
  let release: (() => void) | undefined
  const gate = () => new Promise<void>((resolve) => { release = resolve })
  let slow: Promise<void> | undefined = gate()
  const thread = (path: string): Thread => ({ ref: { harness: "claude", nativeId: path, path, cwd: "/work/a" }, entries: [] })
  const records: ChildSource = {
    open: async (path) => {
      opened.push(path)
      if (slow) await slow
      return thread(path)
    },
    children: async (path) => ({
      parent: { harness: "claude", nativeId: "parent", path },
      children: path === "/sessions/long" ? [1, 2, 3].map((index) => ({ nativeId: `child-${index}`, path: `/sessions/long/child-${index}`, state: { kind: "complete" as const } })) : [],
    }),
  }
  const asked: (string | undefined)[] = []
  const sessions: BackfillSession[] = [
    { harness: "claude", nativeId: "one", path: "/sessions/one", cwd: "/work/a", updatedAt: new Date(10).toISOString(), threadId: "t", sessionId: "s" },
    { harness: "claude", nativeId: "two", path: "/sessions/two", cwd: "/work/b", updatedAt: new Date(5).toISOString(), threadId: "t", sessionId: "s" },
  ]
  const backfill = new Backfill({
    sessions: () => sessions,
    records,
    unsure: (folder) => {
      asked.push(folder)
      return new Map((folder ? [folder] : ["/work/a", "/work/b"]).map((root) => [`${root}/file.ts`, { root, since: 1 }]))
    },
    reconcile: async () => ({ entries: 0, lines: 0 }),
    now: () => now,
  })
  const first = backfill.run("/work/a")
  await microtasks()
  // Five asks while the first pass reads: one pass waits for all of them.
  const waiting = [backfill.run("/work/b"), backfill.run("/work/a"), backfill.run("/work/b"), backfill.run("/work/b", 50_000), backfill.run("/work/a")]
  assert.equal(new Set(waiting).size, 1, "every ask made meanwhile shares the one pass that waits")
  slow = undefined
  release?.()
  assert.equal((await first).sessions, 1)
  await Promise.all(waiting)
  assert.deepEqual(asked, ["/work/a", "/work/b", "/work/a"], "the first pass reads its folder's files, the second the two folders asked for, no root's besides")
  assert.deepEqual(opened, ["/sessions/one", "/sessions/one", "/sessions/two"], "two passes in all: the second, with a folder's lines newly unsure, reads both sessions once")

  // A record that takes the whole budget ends the pass there: nothing more is opened, and the session is read again later.
  sessions.push({ harness: "claude", nativeId: "long", path: "/sessions/long", cwd: "/work/a", updatedAt: new Date(20).toISOString(), threadId: "t", sessionId: "s" })
  opened.length = 0
  records.open = async (path) => {
    opened.push(path)
    now += 30_000
    return thread(path)
  }
  const cut = await backfill.run("/work/a", 20_000)
  assert.equal(cut.partial, true)
  assert.deepEqual(opened, ["/sessions/long"], "none of its three children is opened once the budget is spent")
  now += 1
  records.open = async (path) => {
    opened.push(path)
    return thread(path)
  }
  await backfill.run("/work/a", 20_000)
  assert.deepEqual(opened.slice(1), ["/sessions/long", "/sessions/long/child-1", "/sessions/long/child-2", "/sessions/long/child-3"], "the next pass reads the session it cut short")
})

test("the tracker says once when changes are settled through a point", async (t) => {
  const storage = await mkdtemp(join(tmpdir(), "mako-settled-"))
  const clock = new FakeClock(), events = new FakeEventSource(), fs = new FakeFileSystem(clock, events)
  const said: number[] = []
  const tracker = await LaptopTracker.open({ storage, fs, clock, events, device: "test" }, { settledThrough: (through) => said.push(through) })
  try {
    fs.write("/work/a.ts", "one\n")
    await tracker.track({ id: "work", path: "/work", kind: "workspace" })
    const mark = (edge: "start" | "end") => tracker.activity({ kind: "turn", id: "turn", edge, at: clock.now(), thread: "one", session: "one-session", turn: "turn", checkout: "/work" })
    mark("start")
    clock.advance(10)
    fs.write("/work/a.ts", "two\n")
    await tracker.settled()
    const changedAt = tracker.changes(0).at(-1)!.changedAt
    mark("end")
    await tracker.settled()
    tracker.sweep()
    assert.deepEqual(said.filter((through) => through >= changedAt), [], "an open change is not yet settled")
    clock.advance(60_000)
    await tracker.settled()
    // The pass that settles it runs slow: every reading of the loop's clock 10 ms after the last, so its slice of the
    // turn is spent on the one open change. It says so in that pass all the same, with nothing left to come back for.
    // Said a turn later, this read 0 on a runner where that write took the slice (gate 26, 2026-11-21).
    const real = performance.now.bind(performance)
    let readings = 0
    const slow = t.mock.method(performance, "now", () => real() + 10 * readings++)
    try {
      tracker.sweep()
    } finally {
      slow.mock.restore()
    }
    assert.ok(readings > 0, "the pass read the clock for its slice")
    assert.equal(tracker.changes(0).at(-1)!.settled, true)
    assert.equal(said.filter((through) => through >= changedAt).length, 1, "said once it is")
    tracker.sweep()
    tracker.sweep()
    assert.equal(said.filter((through) => through >= changedAt).length, 1, "and not again while nothing moves")
  } finally {
    await tracker.close()
    await rm(storage, { recursive: true, force: true })
  }
})

test("a turn's settled count follows the writer's word instead of asking again and again", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "mako-settled-count-"))
  const journal = new LiveJournal(folder, "c0ffee00-1234-4abc-8def-0123456789ab")
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 })
  const snapshot: LiveSnapshot = {
    session: { connection: "connected", id: "c0ffee00-1234-4abc-8def-0123456789ab", harness: "claude", cwd: "/repo", status: "ready", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: Date.now(), blocks: [], base: null, permissions: [],
    requests: [{ id: "turn", text: "Write a file", attachments: [], status: "completed" }],
  }
  const resident = residentOf(snapshot, journal)
  let flushes = 0, reads = 0, settled = false, say: (() => void) | undefined
  const ledger: TurnLedger = {
    placement: () => ({ thread: "thread", session: "session" }),
    flushed: async () => { flushes++; return true },
    countTurn: async (thread, turn, state) => ({ version: TURN_CHANGES_VERSION, thread, turn, state, own: { files: 1, added: 1, removed: 0 }, maybe: { files: 0, added: 0, removed: 0 }, others: { files: 0, added: 0, removed: 0 }, files: [], more: 0, journal: "journal", through: 1, at: Date.now() }),
    settledThrough: () => { reads++; return settled },
    settledAfter: () => new Promise<void>((resolve) => { say = resolve }),
    counted: () => {}, turnsChangedAfter: () => new Map(), settleMs: 10_000,
  }
  const counts = new LiveTurnChanges({ ledger: () => ledger, flush() {} })
  try {
    counts.ended(resident, "turn"); await microtasks()
    t.mock.timers.tick(10_000); await microtasks()
    assert.equal(resident.snapshot.requests[0]!.changes?.state, "settling")
    const asked = { flushes, reads }
    // A minute of the journal holding the turn's changes open: at 2.5 s a try, twenty-four tries before.
    t.mock.timers.tick(60_000); await microtasks()
    assert.deepEqual({ flushes, reads }, asked, "nothing is asked while it waits to be told")
    settled = true
    say?.(); await microtasks()
    assert.equal(resident.snapshot.requests[0]!.changes?.state, "settled")
    assert.deepEqual({ flushes: flushes - asked.flushes, reads: reads - asked.reads }, { flushes: 1, reads: 1 }, "told, it looks once and counts")
    assert.equal(resident.counting, 0)
  } finally {
    t.mock.timers.reset()
    await journal.close()
    await rm(folder, { recursive: true, force: true })
  }
})
