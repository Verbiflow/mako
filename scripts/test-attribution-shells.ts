import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"
import { FakeClock, FakeEventSource, FakeFileSystem } from "@mako/protocol/attribution-conformance"
import { LaptopTracker, type TrackerRepository } from "@mako/host/attribution/tracker"

beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_123 }))
afterEach(() => mock.timers.reset())
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

async function world(lagMs = 0) {
  const storage = await mkdtemp(join(tmpdir(), "mako-shell-reconcile-"))
  const clock = new FakeClock(Date.now()), events = new FakeEventSource(), fs = new FakeFileSystem(clock, events)
  const base = new Map([["a.ts", "a original\n"], ["b.ts", "b original\n"], ["old.ts", "rename original\n"]])
  const disk = new Set(base.keys()), tracked = [...base.keys()]
  for (const [path, text] of base) fs.write(join("/repo", path), text)
  let inventories = 0, fail = false
  const repo: TrackerRepository = {
    head: async () => "head",
    inventory: async () => {
      inventories++
      if (fail) throw new Error("Git helper failed")
      return { tracked, untracked: [...disk].filter((path) => !base.has(path) && !path.startsWith("ignored/")), changed: tracked.filter((path) => fs.text(join("/repo", path)) !== base.get(path)) }
    },
    ignored: async (paths) => new Set(paths.filter((path) => path.startsWith("ignored/"))),
    ignoredEntries: async () => ["ignored/"],
    read: async (_commit, path) => base.has(path) ? new TextEncoder().encode(base.get(path)!) : null,
    changed: async () => [],
  }
  const tracker = await LaptopTracker.open({ storage, fs, clock, events, device: "test" }, { repository: async () => repo, deliveryLagMs: () => lagMs })
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
    write: (path: string, content: string) => { disk.add(path); fs.write(join("/repo", path), content) },
    remove: (path: string) => { disk.delete(path); fs.remove(join("/repo", path)) },
    rename: (from: string, to: string) => { disk.delete(from); disk.add(to); fs.rename(join("/repo", from), join("/repo", to)) },
    inventories: () => inventories,
    fail: (value: boolean) => { fail = value },
    close: async () => { await tracker.close(); await rm(storage, { recursive: true, force: true }) },
  }
}

test("silent watcher: shell-created, changed, deleted and renamed files use existing evidence and no filesystem walk", async () => {
  const w = await world()
  try {
    await w.advance(10); w.start(); await w.advance(1)
    w.write("a.ts", "a by shell\n"); w.write("generated.ts", "generated\n"); w.write("ignored/output", "ignored\n")
    w.remove("b.ts"); w.rename("old.ts", "renamed.ts")
    await w.advance(1); w.finish()
    await w.tracker.settled()
    const entries = w.tracker.changes(0)
    assert(entries.some((entry) => entry.path === "generated.ts" && entry.kind === "create"))
    assert(entries.some((entry) => entry.path === "a.ts" && entry.kind === "modify"))
    assert(entries.some((entry) => entry.path === "b.ts" && entry.kind === "delete"))
    assert(entries.some((entry) => entry.path === "renamed.ts" && entry.kind === "rename" && entry.from === "old.ts"))
    assert(!entries.some((entry) => entry.path.startsWith("ignored/")))
    assert(entries.every((entry) => entry.author.certainty === "window" && entry.author.author.thread === "one"))
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
    await w.tracker.settled()
    const entry = w.tracker.changes(0).find((entry) => entry.path === "shared.ts")
    assert(entry)
    assert.equal(entry.author.certainty, "ambiguous")
  } finally { await w.close() }
})

test("read-only, running, refused and historic commands do not trigger new inventories", async () => {
  const w = await world()
  try {
    w.start(); const before = w.inventories()
    w.finish("one", "git status"); await w.tracker.settled(); assert.equal(w.inventories(), before)
    w.finish("one", "python3 generate.py", "running"); await w.tracker.settled(); assert.equal(w.inventories(), before)
    w.finish("one", "python3 generate.py", "refused"); await w.tracker.settled(); assert.equal(w.inventories(), before)
    await w.advance(20_000); w.finish("old", "python3 generate.py", "completed", w.clock.now() - 20_000); await w.tracker.settled(); assert.equal(w.inventories(), before)
  } finally { await w.close() }
})

test("helper failures prevent false finalization, recover on retry, and a return to HEAD is inventoried", async () => {
  const w = await world()
  try {
    w.start(); await w.advance(1); w.write("a.ts", "first dirty\n"); w.finish(); await w.tracker.settled()
    await w.advance(1); w.write("a.ts", "a original\n"); w.finish("one", "git restore a.ts")
    w.fail(true)
    const rejected = assert.rejects(w.tracker.settled({ rescans: false }), /incomplete/)
    await flush(); await w.advance(3100); await rejected
    w.fail(false); await w.advance(2100); await w.tracker.settled({ rescans: false })
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
    await w.tracker.settled()
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
