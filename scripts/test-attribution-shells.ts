import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"
import { FakeClock, FakeEventSource, FakeFileSystem } from "@mako/protocol/attribution-conformance"
import type { TrackerChangeListener } from "@mako/protocol"
import { LaptopTracker, type TrackerRepository } from "@mako/host/attribution/tracker"
import { removeScratch } from "./lib/remove-scratch.mjs"

beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_123 }))
afterEach(() => mock.timers.reset())
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

async function world(lagMs = 0) {
  const storage = await mkdtemp(join(tmpdir(), "mako-shell-reconcile-"))
  const clock = new FakeClock(Date.now()), events = new FakeEventSource(), fs = new FakeFileSystem(clock, events)
  const base = new Map([["a.ts", "a original\n"], ["b.ts", "b original\n"], ["old.ts", "rename original\n"]])
  const disk = new Set(base.keys()), tracked = [...base.keys()]
  for (const [path, text] of base) fs.write(posix.join("/repo", path), text)
  let inventories = 0, fail = false
  const repo: TrackerRepository = {
    head: async () => "head",
    inventory: async () => {
      inventories++
      if (fail) throw new Error("Git helper failed")
      return { tracked, untracked: [...disk].filter((path) => !base.has(path) && !path.startsWith("ignored/")), changed: tracked.filter((path) => fs.text(posix.join("/repo", path)) !== base.get(path)) }
    },
    ignored: async (paths) => new Set(paths.filter((path) => path.startsWith("ignored/"))),
    ignoredEntries: async () => ["ignored/"],
    read: async (_commit, path) => base.has(path) ? new TextEncoder().encode(base.get(path)!) : null,
    changed: async () => [],
  }
  let listener: TrackerChangeListener | undefined
  const source = { mark: events.mark.bind(events), since: events.since.bind(events), watch: async (root: string, changed: TrackerChangeListener) => { listener = changed; return events.watch(root, changed) } }
  const tracker = await LaptopTracker.open({ storage, fs, clock, events: source, device: "test" }, { repository: async () => repo, deliveryLagMs: () => lagMs })
  await tracker.track({ id: "repo", path: "/repo", kind: "workspace" })
  events.drop() // Silent delivery loss: no dropped notification is sent to the tracker.
  const advance = async (ms: number) => { clock.advance(ms); mock.timers.tick(ms); await flush() }
  const activity = (thread: string, kind: "turn" | "call", edge: "start" | "end") => tracker.activity({ kind, id: kind === "turn" ? thread + "-turn" : thread + "-call", edge, at: clock.now(), thread, session: thread + "-session", turn: thread + "-turn", checkout: "/repo" })
  const start = (thread = "one") => { activity(thread, "turn", "start"); activity(thread, "call", "start") }
  const finish = (thread = "one", command = "python3 generate.py", status: "completed" | "failed" | "refused" | "running" = "completed", endedAt = clock.now()) => {
    activity(thread, "call", "end")
    tracker.reported({ thread, session: thread + "-session", turn: thread + "-turn", call: thread + "-call", checkout: "/repo", startedAt: endedAt - 1, endedAt, status, effects: [{ kind: "command", command, cwd: "/repo" }] })
  }
  return {
    tracker, fs, clock, advance, start, finish, activity,
    deliver: () => listener?.changed(["a.ts"]),
    drain: async (thread = "one") => { activity(thread, "turn", "end"); await advance(Math.max(3100, lagMs)); await tracker.settled({ rescans: false, checkouts: ["/repo"] }); await tracker.settled() },
    write: (path: string, content: string) => { disk.add(path); fs.write(posix.join("/repo", path), content) },
    remove: (path: string) => { disk.delete(path); fs.remove(posix.join("/repo", path)) },
    rename: (from: string, to: string) => { disk.delete(from); disk.add(to); fs.rename(posix.join("/repo", from), posix.join("/repo", to)) },
    inventories: () => inventories,
    fail: (value: boolean) => { fail = value },
    close: async () => { await tracker.close(); await removeScratch(storage) },
  }
}

test("silent watcher: shell-created, changed, deleted and renamed files use existing evidence and no filesystem walk", async () => {
  const w = await world()
  try {
    await w.advance(10); w.start(); await w.advance(1)
    w.write("a.ts", "a by shell\n"); w.write("generated.ts", "generated\n"); w.write("ignored/output", "ignored\n")
    w.remove("b.ts"); w.rename("old.ts", "renamed.ts")
    await w.advance(1); w.finish()
    await w.drain()
    const entries = w.tracker.changes(0)
    assert(entries.some((entry) => entry.path === "generated.ts" && entry.kind === "create"))
    assert(entries.some((entry) => entry.path === "a.ts" && entry.kind === "modify"))
    assert(entries.some((entry) => entry.path === "b.ts" && entry.kind === "delete"))
    assert(entries.some((entry) => entry.path === "renamed.ts" && entry.kind === "rename" && entry.from === "old.ts"))
    assert(!entries.some((entry) => entry.path.startsWith("ignored/")))
    assert(entries.filter((entry) => entry.kind === "create" || entry.kind === "modify").every((entry) => entry.author.certainty === "window" && entry.author.author.thread === "one"))
    // A deletion has no modification time: waiting for delivery cannot invent a precise writer for it.
    assert.equal(w.fs.walks, 0, "a Git inventory must not turn each shell into a checkout walk")
    assert(entries.every((entry) => !entry.settled), "inventory observations still admit later tool evidence")
  } finally { await w.close() }
})

test("the finalization barrier waits for delivery lag and includes a write landing just after command completion", async () => {
  const w = await world(8000)
  try {
    w.start(); await w.advance(1); w.finish(); w.activity("one", "turn", "end")
    let done = false
    const heard = w.tracker.settled({ rescans: false }).then(() => { done = true })
    await flush(); await w.advance(50); await w.tracker.settled()
    assert.equal(done, false)
    await w.advance(1000); w.write("late.ts", "arrived after the shell\n")
    await w.advance(6900); assert.equal(done, false)
    await w.advance(100); await heard
    const entry = w.tracker.changes(0).find((entry) => entry.path === "late.ts")
    assert(entry)
    assert.equal(entry.author.certainty, "window")
    if (entry.author.certainty === "window") assert.equal(entry.author.author.thread, "one")
  } finally { await w.close() }
})

test("a shared checkout stays ambiguous; inventory is not a writer claim", async () => {
  const w = await world()
  try {
    w.start("one"); w.start("two"); await w.advance(1)
    w.write("shared.ts", "unknown writer\n"); await w.advance(1); w.finish("one")
    await w.drain()
    const entry = w.tracker.changes(0).find((entry) => entry.path === "shared.ts")
    assert(entry)
    assert.equal(entry.author.certainty, "ambiguous")
  } finally { await w.close() }
})

test("read-only, running, refused and historic commands do not trigger new inventories", async () => {
  const w = await world()
  try {
    w.start(); const before = w.inventories()
    w.finish("one", "git status"); await w.drain(); assert.equal(w.inventories(), before)
    w.finish("one", "python3 generate.py", "running"); await w.drain(); assert.equal(w.inventories(), before)
    w.finish("one", "python3 generate.py", "refused"); await w.drain(); assert.equal(w.inventories(), before)
    await w.advance(20_000); w.finish("old", "python3 generate.py", "completed", w.clock.now() - 20_000); await w.drain(); assert.equal(w.inventories(), before)
  } finally { await w.close() }
})

test("helper failure never rejects a count; a later turn recovers a return to HEAD", async () => {
  const w = await world()
  try {
    w.start(); await w.advance(1); w.write("a.ts", "first dirty\n"); w.finish(); await w.drain()
    w.start(); await w.advance(1); w.write("a.ts", "a original\n"); w.finish("one", "git restore a.ts")
    w.fail(true)
    w.activity("one", "turn", "end")
    const counted = w.tracker.settled({ rescans: false, checkouts: ["/repo"] })
    await flush(); await w.advance(3100); assert.equal(await counted, false)
    w.fail(false); w.start(); w.finish("one", "git restore a.ts"); await w.drain()
    const entries = w.tracker.changes(0).filter((entry) => entry.path === "a.ts")
    assert.equal(entries.length, 2, "a clean Git status still rechecks versions the journal already holds")
    assert.deepEqual(w.tracker.blame("repo", "a.ts"), [], "returned-to-HEAD lines retain the existing clean-file representation")
  } finally { w.fail(false); await w.close() }
})


test("clean historical line maps are not restatted on every shell inventory", async () => {
  const w = await world()
  try {
    const state = w.tracker.rootStates().get("repo")!
    assert(state.files instanceof Map)
    const template = { root: "repo", base: null, baseSeq: 0, current: null, text: true, map: [] }
    for (let i = 0; i < 5000; i++) state.files.set(`old-${i}.ts`, { ...template, path: `old-${i}.ts` })
    const stated: string[] = []
    const stat = w.fs.stat.bind(w.fs)
    w.fs.stat = async (path) => { stated.push(path); return stat(path) }
    w.start(); await w.advance(1); w.write("a.ts", "new dirty\n"); w.finish()
    await w.drain()
    assert(!stated.some((path) => path.includes("old-")), "historical line maps must not expand the live dirty set")
  } finally { await w.close() }
})


test("a sleeping tracked root cannot poison the global reconciliation barrier", async () => {
  const w = await world()
  try {
    await w.advance(7 * 60 * 60_000)
    await w.tracker.sleepIdle()
    assert(w.tracker.asleep("/repo"))
    const before = w.inventories()
    w.start(); w.finish()
    await w.tracker.settled({ rescans: false })
    assert.equal(w.inventories(), before)
  } finally { await w.close() }
})


test("twenty writable commands trigger one turn-end inventory, never per-command work", async () => {
  const w = await world()
  try {
    const before = w.inventories()
    w.start()
    for (let i = 0; i < 20; i++) {
      await w.advance(1000); w.write("a.ts", `command ${i}\n`); w.finish()
      await w.tracker.settled()
    }
    assert.equal(w.inventories(), before)
    await w.drain()
    assert.equal(w.inventories(), before + 1)
  } finally { await w.close() }
})

for (const delayed of [false, true]) test(`${delayed ? "delayed" : "healthy"} watcher avoids the recovery inventory`, async () => {
  const w = await world()
  try {
    const before = w.inventories()
    w.start(); await w.advance(10)
    w.write("a.ts", "watched change\n"); if (!delayed) w.deliver(); w.finish()
    w.activity("one", "turn", "end")
    if (delayed) {
      await w.advance(1000)
      w.deliver()
    }
    await w.advance(3100)
    await w.tracker.settled({ rescans: false, checkouts: ["/repo"] })
    assert.equal(w.inventories(), before)
  } finally { await w.close() }
})


test("a pending or failed root never delays or rejects another checkout's count", async () => {
  const w = await world()
  try {
    w.fs.write("/other/a.ts", "other\n")
    await w.tracker.track({ id: "other", path: "/other", kind: "workspace" })
    const mark = { kind: "turn" as const, id: "bad-turn", session: "bad-session", thread: "bad", turn: "bad-turn", checkout: "/", at: w.clock.now() }
    w.tracker.activity({ ...mark, edge: "start" })
    await w.advance(1)
    w.tracker.reported({ session: mark.session, thread: mark.thread, turn: mark.turn, checkout: mark.checkout, call: "bad-call", startedAt: mark.at, endedAt: w.clock.now(), status: "completed", effects: [{ kind: "command", command: "python3 generate.py", cwd: "/other" }] })
    w.tracker.activity({ ...mark, at: w.clock.now(), edge: "end" })
    // No timer advance: the unrelated root still has its entire delivery allowance ahead of it.
    await w.tracker.settled({ rescans: false, checkouts: ["/repo"] })
    w.fail(true); await w.advance(3100)
    await w.tracker.settled({ rescans: false, checkouts: ["/other"] })
    await w.tracker.settled({ rescans: false, checkouts: ["/repo"] })
  } finally { w.fail(false); await w.close() }
})


test("a healthy notification delivered after the command report avoids even the turn-end wait", async () => {
  const w = await world(8000)
  try {
    w.start(); await w.advance(1); w.write("a.ts", "watched\n"); w.finish()
    await w.advance(50); w.deliver(); w.activity("one", "turn", "end")
    let done = false
    const read = w.tracker.settled({ rescans: false, checkouts: ["/repo"] }).then(() => { done = true })
    await flush()
    assert.equal(done, true, "a report arriving before its watch event must not charge a healthy root the lag window")
    await read
  } finally { await w.close() }
})
