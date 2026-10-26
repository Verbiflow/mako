import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import type { ActivityMark, ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { changes, hunks, partition, restorable, turnChanges, type JournalView } from "@mako/host/attribution/queries"
import { lineNow, ThreadFiles } from "@mako/host/attribution/thread-files"
import { threadTrees } from "@mako/host/attribution/thread-tree"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { LiveActivity } from "@mako/host/attribution/live-activity"
import type { LiveBatch, LiveRequest } from "@mako/host/contracts/live-conversations"

/*
 * Two Threads and the person in one checkout, on a real repository: the same
 * file edited by all three, interleaved; a revert; a rename; a delete and
 * re-create; a formatter that no call reported; lost events; a commit
 * mid-way. Events and the clock are scripted so every step is exact, and
 * each file's modification time is set to the scripted clock.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-scenario-")))
const storage = mkdtempSync(join(tmpdir(), "mako-attribution-journal-"))
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const lines = (count: number, edit: Record<number, string> = {}) => Array.from({ length: count }, (_, i) => `${edit[i + 1] ?? `line ${i + 1}`}\n`).join("")

git("init", "-q", "-b", "main")
git("config", "user.email", "test@example.com")
git("config", "user.name", "Test")
writeFileSync(join(root, "a.ts"), lines(24))
writeFileSync(join(root, "b.ts"), "export const b = 1\n")
writeFileSync(join(root, "c.md"), "# Notes\n\nsome  text\n")
writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho hi\n")
chmodSync(join(root, "run.sh"), 0o755)
writeFileSync(join(root, ".gitignore"), "ignored/\n")
git("add", "-A")
git("commit", "-q", "-m", "base")

const clock = new FakeClock(Date.now())
const events = new FakeEventSource()
const runner = new Git()
const tracker = await LaptopTracker.open(
  { fs: nodeFileSystem(), events, clock, storage, device: "scenario" },
  { repository: async (path) => gitRepository(runner, path) },
)
const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
const ROOT = "repo"

const at = (ms: number) => {
  const target = start + ms
  if (target > clock.now()) clock.advance(target - clock.now())
}
const write = (path: string, text: string) => {
  const absolute = join(root, path)
  writeFileSync(absolute, text)
  utimesSync(absolute, clock.now() / 1000, clock.now() / 1000)
  events.changed(absolute)
}
const remove = (path: string) => {
  rmSync(join(root, path))
  events.changed(join(root, path))
}
const mark = (kind: ActivityMark["kind"], thread: string, id: string, edge: "start" | "end", turn?: string, named?: string[]) =>
  tracker.activity({ kind, id, edge, at: clock.now(), thread, session: `${thread}-session`, checkout: root, turn, named })
/** One tool call that reported its effects: start, write, report, end. */
const call = async (thread: string, turn: string, id: string, effects: ReportedEffect[], act: () => void) => {
  mark("call", thread, id, "start", turn)
  clock.advance(50)
  act()
  clock.advance(50)
  tracker.reported({ thread, session: `${thread}-session`, turn, call: id, status: "completed", endedAt: clock.now(), effects })
  mark("call", thread, id, "end", turn)
  await tracker.settled()
}
const entries = () => tracker.changes(0)
const last = () => entries().at(-1)!
const start = clock.now()

await tracker.track({ id: ROOT, path: root, kind: "workspace" })

test("interleaved Threads and the person, line by line", async () => {
  // T1 and T2 work in the same checkout at once, in the same file.
  at(1_000)
  mark("turn", "T1", "t1", "start")
  at(1_100)
  let a = lines(24, { 3: "line 3 by T1" })
  await call("T1", "t1", "c1", [{ kind: "modify", path: join(root, "a.ts"), edits: [{ old: "line 3\n", new: "line 3 by T1\n" }] }], () => write("a.ts", a))
  assert.equal(last().author.certainty, "exact")
  at(2_000)
  mark("turn", "T2", "t2", "start")
  at(2_100)
  a = lines(24, { 3: "line 3 by T1", 15: "line 15 by T2" })
  await call("T2", "t2", "c2", [{ kind: "modify", path: join(root, "a.ts"), patch: "@@ -15 +15 @@\n-line 15\n+line 15 by T2\n" }], () => write("a.ts", a))
  const afterT2 = last()
  assert.deepEqual(afterT2.author.certainty === "exact" && afterT2.author.author.thread, "T2")
  at(2_400)
  await call("T2", "t2", "c3", [{ kind: "create", path: join(root, "d.ts"), content: "export const d = 4\n" }], () => write("d.ts", "export const d = 4\n"))
  assert.equal(last().kind, "create")
  at(2_600)
  await call("T1", "t1", "c4", [{ kind: "rename", from: join(root, "b.ts"), to: join(root, "b2.ts") }], () => {
    renameSync(join(root, "b.ts"), join(root, "b2.ts"))
    events.changed(join(root, "b.ts"))
    events.changed(join(root, "b2.ts"))
  })
  assert.deepEqual([last().kind, last().from, last().path, last().author.certainty], ["rename", "b.ts", "b2.ts", "exact"])
  // A formatter T1's command ran rewrote c.md, and no call reported it: both Threads were running.
  at(3_000)
  mark("call", "T1", "c5", "start", "t1")
  at(3_100)
  write("c.md", "# Notes\n\nsome text\n")
  await tracker.settled()
  mark("call", "T1", "c5", "end", "t1")
  assert.equal(last().author.certainty, "ambiguous")
  at(4_000)
  mark("turn", "T1", "t1", "end")
  mark("turn", "T2", "t2", "end")

  // The person edits after both turns ended, then undoes it: the lines are back with their writers.
  at(10_000)
  write("a.ts", lines(24, { 3: "line 3 by T1", 10: "line 10 by the person", 15: "line 15 by T2" }))
  await tracker.settled()
  assert.deepEqual(last().author, { certainty: "person", via: "no-activity" })
  at(11_000)
  write("a.ts", a)
  await tracker.settled()
  assert.equal(last().restores, afterT2.seq, "the undo brings back the version T2 left")
  const blame = tracker.blame(ROOT, "a.ts")!
  const writerOfLine = (line: number) => blame.find((run) => line >= run.start && line < run.start + run.length)
  assert.equal(writerOfLine(2)?.author?.certainty === "exact" && writerOfLine(2)?.author?.certainty, "exact")
  assert.equal(writerOfLine(9)?.entry, null, "line 10 is the base's again")

  // T1 deletes c.md and writes it again.
  at(12_000)
  mark("turn", "T1", "t3", "start")
  at(12_100)
  await call("T1", "t3", "c6", [{ kind: "delete", path: join(root, "c.md") }], () => remove("c.md"))
  at(12_300)
  await call("T1", "t3", "c7", [{ kind: "create", path: join(root, "c.md"), content: "# Rewritten\n" }], () => write("c.md", "# Rewritten\n"))
  assert.deepEqual(entries().slice(-2).map((entry) => [entry.kind, entry.author.certainty]), [["delete", "exact"], ["create", "exact"]])
  at(13_000)
  mark("turn", "T1", "t3", "end")

  // Adjacent lines by two Threads: one hunk, divided line by line.
  at(14_000)
  mark("turn", "T1", "t4", "start")
  a = lines(24, { 3: "line 3 by T1", 7: "line 7 by T1", 15: "line 15 by T2" })
  await call("T1", "t4", "c8", [{ kind: "modify", path: join(root, "a.ts"), edits: [{ old: "line 7\n", new: "line 7 by T1\n" }] }], () => write("a.ts", a))
  at(14_500)
  mark("turn", "T2", "t5", "start")
  a = lines(24, { 3: "line 3 by T1", 7: "line 7 by T1", 8: "line 8 by T2", 15: "line 15 by T2" })
  await call("T2", "t5", "c9", [{ kind: "modify", path: join(root, "a.ts"), edits: [{ old: "line 8\n", new: "line 8 by T2\n" }] }], () => write("a.ts", a))
  // T2 writes over T1's uncommitted line 20: the line is T2's, the last writer.
  a = lines(24, { 3: "line 3 by T1", 7: "line 7 by T1", 8: "line 8 by T2", 15: "line 15 by T2", 20: "line 20 by T1" })
  await call("T1", "t4", "c10", [{ kind: "modify", path: join(root, "a.ts"), edits: [{ old: "line 20\n", new: "line 20 by T1\n" }] }], () => write("a.ts", a))
  a = lines(24, { 3: "line 3 by T1", 7: "line 7 by T1", 8: "line 8 by T2", 15: "line 15 by T2", 20: "line 20 by T2" })
  await call("T2", "t5", "c11", [{ kind: "modify", path: join(root, "a.ts"), edits: [{ old: "line 20 by T1\n", new: "line 20 by T2\n" }] }], () => write("a.ts", a))
  // T1 removes line 22; later the person puts it back, and changes line 1: that hunk can't be divided.
  a = lines(24, { 3: "line 3 by T1", 7: "line 7 by T1", 8: "line 8 by T2", 15: "line 15 by T2", 20: "line 20 by T2", 22: "" }).replace("\n\n", "\n")
  await call("T1", "t4", "c12", [{ kind: "modify", path: join(root, "a.ts"), edits: [{ old: "line 22\n", new: "" }] }], () => write("a.ts", a))
  at(15_500)
  mark("turn", "T1", "t4", "end")
  mark("turn", "T2", "t5", "end")
  at(20_000)
  a = lines(24, { 1: "line 1 by the person", 3: "line 3 by T1", 7: "line 7 by T1", 8: "line 8 by T2", 15: "line 15 by T2", 20: "line 20 by T2" })
  write("a.ts", a)
  await tracker.settled()
  assert.deepEqual(last().author, { certainty: "person", via: "no-activity" })

  const moving = partition(view, root, "T1")
  const byPath = new Map(moving.files.map((file) => [file.path, file]))
  assert.deepEqual([...byPath.keys()].sort(), ["a.ts", "b.ts", "b2.ts", "c.md"])
  assert.deepEqual(byPath.get("b.ts")?.thread, { kind: "absent" })
  assert.equal(byPath.get("b2.ts")?.move, "whole")
  const aTs = byPath.get("a.ts")!
  assert.equal(aTs.thread.kind === "text" && aTs.thread.text, lines(24, { 3: "line 3 by T1", 7: "line 7 by T1" }))
  assert.equal(aTs.remaining.kind === "text" && aTs.remaining.text, lines(24, { 1: "line 1 by the person", 8: "line 8 by T2", 15: "line 15 by T2", 20: "line 20 by T2" }))
  assert.deepEqual(moving.whole.map((hunk) => [hunk.path, hunk.to, hunk.reason]), [["a.ts", "checkout", "line-restored-by-another-writer"]])
  assert.equal(byPath.get("c.md")?.thread.kind === "text" && byPath.get("c.md")!.thread.kind, "text")
  const cmd = byPath.get("c.md")!
  assert.ok(cmd.thread.kind === "text" && cmd.thread.text === "# Rewritten\n")
  assert.ok(cmd.remaining.kind === "text" && cmd.remaining.text === "# Notes\n\nsome  text\n")
  assert.ok(moving.ms < 200, `partition took ${moving.ms} ms`)

  const other = partition(view, root, "T2")
  assert.deepEqual(other.files.map((file) => file.path).sort(), ["a.ts", "d.ts"])

  // The Thread's side as a Git tree, without touching the checkout.
  const statusBefore = git("status", "--porcelain")
  const [tree] = await threadTrees(runner, view, moving)
  assert.equal(git("status", "--porcelain"), statusBefore, "the checkout and its index are untouched")
  const listed = git("ls-tree", "--name-only", tree!.tree).split("\n")
  assert.ok(listed.includes("b2.ts") && !listed.includes("b.ts") && !listed.includes("d.ts"))
  assert.equal(git("show", `${tree!.tree}:a.ts`) + "\n", lines(24, { 3: "line 3 by T1", 7: "line 7 by T1" }))
  assert.equal(git("show", `${tree!.tree}:c.md`), "# Rewritten")
  assert.match(git("ls-tree", tree!.tree, "run.sh"), /^100755 /)

  const hunked = hunks(view, root).filter((hunk) => hunk.path === "a.ts")
  assert.ok(hunked.some((hunk) => hunk.writers.some((writer) => writer.thread === "T1") && hunk.writers.some((writer) => writer.thread === "T2")), "the line 7–8 hunk has both Threads")

  const t1 = changes(view, "T1")
  assert.deepEqual(t1.files.renamed, [{ from: join(root, "b.ts"), to: join(root, "b2.ts") }])
  assert.ok(t1.files.modified.includes(join(root, "a.ts")))
  assert.ok((t1.certainty.exact ?? 0) >= 6)
  assert.ok(t1.maybe >= 1, "the formatter's change might be T1's")
  assert.ok(restorable(view, { thread: "T1" }).some((version) => version.path === "c.md"))
})

test("lost events are rescanned, and claim no more than one running Thread", async () => {
  // Heard in full up to here, well after the last turns ended: the gap starts at the last flush.
  at(22_000)
  events.changed(join(root, "a.ts"))
  await tracker.settled()
  at(22_500)
  mark("turn", "T2", "t6", "start")
  events.drop()
  at(22_600)
  write("e.ts", "export const e = 5\n")
  at(22_700)
  events.restore()
  await tracker.settled()
  const found = last()
  assert.deepEqual([found.path, found.observed, found.author.certainty], ["e.ts", "rescan", "window"])
  assert.ok(found.gap)
  at(23_000)
  mark("turn", "T2", "t6", "end")
})

test("a commit moves the base and records who wrote what it took", async () => {
  at(25_000)
  git("add", "a.ts")
  git("commit", "-q", "-m", "a.ts by several")
  events.changed(join(root, ".git/index"))
  events.changed(join(root, ".git/logs/HEAD"))
  await tracker.settled()
  const head = git("rev-parse", "HEAD")
  assert.equal(tracker.rootStates().get(ROOT)?.root.head, head)
  assert.equal(tracker.rootStates().get(ROOT)?.files.has("a.ts"), false, "a.ts has no uncommitted lines left")
  const authors = tracker.store.commitAuthors(ROOT, head, "a.ts")!
  const threads = new Set([...authors].filter((seq) => seq > 0).map((seq) => {
    const author = tracker.authorOf(seq)
    return author && "author" in author ? author.author.thread : author?.certainty
  }))
  assert.deepEqual([...threads].sort(), ["T1", "T2", "person"])
  assert.ok(!partition(view, root, "T1").files.some((file) => file.path === "a.ts"))
  // Lines written after the commit are measured from it.
  at(26_000)
  write("a.ts", readFileSync(join(root, "a.ts"), "utf8") + "after the commit\n")
  await tracker.settled()
  assert.deepEqual(tracker.blame(ROOT, "a.ts")?.map((run) => [run.start, run.length, run.entry === null]), [[0, 24, true], [24, 1, false]])
})

test("a turn's footprint outside the checkout: named paths strong, the rest weak, stores and churn left out", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-home-")))
  const footClock = new FakeClock(Date.now())
  const footEvents = new FakeEventSource()
  const footStorage = mkdtempSync(join(tmpdir(), "mako-attribution-footprint-"))
  const footprinted = await LaptopTracker.open(
    { fs: nodeFileSystem(), events: footEvents, clock: footClock, storage: footStorage, device: "scenario" },
    { footprint: { home, roots: [home], stores: () => [join(home, ".harness")] } },
  )
  try {
    const touch = (path: string, text: string) => {
      execFileSync("mkdir", ["-p", join(path, "..")])
      writeFileSync(path, text)
      footEvents.changed(path)
    }
    const turn = { thread: "T1", session: "S1", checkout: root }
    footprinted.activity({ ...turn, kind: "turn", id: "f1", edge: "start", at: footClock.now() })
    footprinted.activity({ ...turn, kind: "call", id: "fc1", edge: "start", at: footClock.now(), turn: "f1", named: [join(home, ".config/tool")] })
    touch(join(home, ".config/tool/state.json"), "{}\n")
    touch(join(home, "notes.txt"), "a note another app wrote\n")
    touch(join(home, ".harness/sessions/s1.jsonl"), "{}\n")
    touch(join(home, ".config/tool/state.json.tmp"), "{}\n")
    touch(join(home, ".ssh/known_hosts"), "host\n")
    writeFileSync(join(home, "read-me.md"), "read\n")
    footprinted.reported({ ...turn, turn: "f1", call: "fc1", status: "completed", effects: [{ kind: "read", path: join(home, "read-me.md") }] })
    footClock.advance(100)
    footprinted.activity({ ...turn, kind: "call", id: "fc1", edge: "end", at: footClock.now(), turn: "f1" })
    footprinted.activity({ ...turn, kind: "turn", id: "f1", edge: "end", at: footClock.now() })
    await footprinted.settled()
    const found = footprinted.footprint("T1").map((entry) => [entry.path.slice(home.length + 1), entry.access, entry.evidence, entry.secret, Boolean(entry.ref)])
    assert.deepEqual(found.sort(), [
      [".config/tool/state.json", "write", "strong", false, true],
      [".ssh/known_hosts", "write", "weak", true, false],
      ["notes.txt", "write", "weak", false, false],
      ["read-me.md", "read", "strong", false, false],
    ])
  } finally {
    await footprinted.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(footStorage, { recursive: true, force: true })
  }
})

test("the live conversations' batches become turns, calls, background work and reported effects", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-live-")))
  const liveStorage = mkdtempSync(join(tmpdir(), "mako-attribution-live-journal-"))
  const liveEvents = new FakeEventSource()
  const liveClock = new FakeClock(Date.now())
  const live = await LaptopTracker.open({ fs: nodeFileSystem(), events: liveEvents, clock: liveClock, storage: liveStorage, device: "scenario" })
  try {
    writeFileSync(join(folder, "page.ts"), "export const title = 'old'\n")
    await live.track({ id: "live", path: folder, kind: "attached" })
    const tracked: string[] = []
    const adapter = new LiveActivity({
      tracker: live,
      placement: (id) => (id === "conversation-1" ? { thread: "T9", session: "session-1" } : undefined),
      session: () => ({ cwd: folder, harness: "claude", record: join(folder, "..", "transcript.jsonl") }),
      checkout: () => folder,
      working: (cwd) => tracked.push(cwd),
      now: () => liveClock.now(),
    })
    const batch = (fields: Partial<LiveBatch>): LiveBatch => ({ id: "conversation-1", revision: 1, updates: [], ...fields })
    const path = join(folder, "page.ts")
    const request: LiveRequest = { id: "8f0c2a4e-3b1d-4c55-9e0a-1d2b3c4d5e6f", text: "Retitle the page", attachments: [], status: "dispatching" }
    adapter.observe(batch({ requestChanges: [request], sessionChanges: { status: "running" } }))
    liveClock.advance(10)
    adapter.observe(batch({ updates: [{ kind: "tool", id: "toolu_1", title: "Edit", name: "Edit", status: "in_progress", input: JSON.stringify({ file_path: path, old_string: "'old'", new_string: "'new'" }) }] }))
    liveClock.advance(10)
    writeFileSync(path, "export const title = 'new'\n")
    utimesSync(path, liveClock.now() / 1000, liveClock.now() / 1000)
    liveEvents.changed(path)
    liveClock.advance(10)
    adapter.observe(batch({ updates: [{ kind: "tool-update", id: "toolu_1", status: "completed", output: "ok", effects: [{ kind: "modify", path, edits: [{ old: "'old'", new: "'new'" }] }] }] }))
    const agent = { nativeId: "bg-1", title: "npm run dev", work: "command" as const, detail: "npm run dev --prefix ./web", state: { kind: "working" as const }, bindingId: "conversation-1", provider: "claude", observedAt: liveClock.now() }
    adapter.observe(batch({ nativeAgents: { agents: [agent], limited: false } }))
    liveClock.advance(10)
    adapter.observe(batch({ sessionChanges: { status: "ready" } }))
    adapter.observe(batch({ nativeAgents: { agents: [], limited: false } }))
    await live.settled()
    const [entry] = live.changes(0)
    assert.deepEqual(entry?.author, { certainty: "exact", author: { thread: "T9", session: "session-1", turn: request.id, call: "toolu_1" }, effect: "modify" }, "the turn is the request it answers")
    assert.deepEqual(tracked, [folder], "the turn's folder is tracked")
    const activity = live.store.activityOfThread("T9").map((item) => [item.kind, item.id, item.end !== null, item.record !== undefined || item.kind !== "turn"])
    assert.deepEqual(activity.sort(), [["background", "bg-1", true, true], ["call", "toolu_1", true, true], ["turn", request.id, true, true]])
    assert.ok(live.store.activityOfThread("T9").find((item) => item.kind === "background")?.named.includes(join(folder, "web")))
  } finally {
    await live.close()
    rmSync(folder, { recursive: true, force: true })
    rmSync(liveStorage, { recursive: true, force: true })
  }
})

/**
 * A Thread's conversation as the live engine reports it, on a real tracker:
 * requests dispatching and settling, tool calls with their effects, the
 * person's own saves, and a host restart that reopens the journal and
 * starts the live adapter over.
 */
async function liveWorld() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-turns-")))
  const store = mkdtempSync(join(tmpdir(), "mako-attribution-turns-journal-"))
  const events = new FakeEventSource()
  const clock = new FakeClock(Date.now())
  const ports = { fs: nodeFileSystem(), events, clock, storage: store, device: "scenario" }
  let tracker = await LaptopTracker.open(ports)
  await tracker.track({ id: "turns", path: folder, kind: "attached" })
  const adapterOf = (open: LaptopTracker) => new LiveActivity({
    tracker: open,
    placement: () => ({ thread: "T7", session: "session-7" }),
    session: () => ({ cwd: folder, harness: "claude" }),
    checkout: () => folder,
    working: () => undefined,
    now: () => clock.now(),
  })
  let adapter = adapterOf(tracker)
  let revision = 0
  const batch = (fields: Partial<LiveBatch>) => adapter.observe({ id: "conversation-7", revision: ++revision, updates: [], ...fields })
  const write = (name: string, text: string) => {
    const path = join(folder, name)
    writeFileSync(path, text)
    utimesSync(path, clock.now() / 1000, clock.now() / 1000)
    events.changed(path)
  }
  const world = {
    folder,
    clock,
    get tracker() {
      return tracker
    },
    view: (): JournalView => ({ store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }),
    batch,
    write,
    /** One call that edits a file and reports it, ending as `status` says. */
    async edit(id: string, name: string, text: string, status: "completed" | "failed" = "completed") {
      const path = join(folder, name)
      batch({ updates: [{ kind: "tool", id, title: "Write", name: "Write", status: "in_progress", input: JSON.stringify({ file_path: path, content: text }) }] })
      clock.advance(20)
      if (status === "completed") write(name, text)
      clock.advance(20)
      batch({ updates: [{ kind: "tool-update", id, status, output: status === "completed" ? "ok" : "Error: the file was changed since it was read", effects: [{ kind: "write", path, content: text }] }] })
      await tracker.settled()
    },
    /** Every change so far settled, as the journal settles them once nothing can reach them. */
    async settle() {
      clock.advance(15_000)
      tracker.sweep()
      await tracker.settled()
    },
    /** The host stops and starts again: the journal reopens, and the live adapter starts over with nothing of the last one. */
    async restart() {
      await tracker.close()
      tracker = await LaptopTracker.open(ports)
      await tracker.settled()
      adapter = adapterOf(tracker)
    },
    async close() {
      await tracker.close()
      rmSync(folder, { recursive: true, force: true })
      rmSync(store, { recursive: true, force: true })
    },
  }
  return world
}

const request = (id: string, status: LiveRequest["status"], nativeRun?: string): LiveRequest =>
  ({ id, text: "Do the thing", attachments: [], status, ...(nativeRun && { nativeRun: { bindingId: "binding-7", runId: nativeRun } }) })
const TURN_ONE = "11111111-1111-4111-8111-111111111111"
const TURN_TWO = "22222222-2222-4222-8222-222222222222"
const TURN_THREE = "33333333-3333-4333-8333-333333333333"
const TURN_FOUR = "44444444-4444-4444-8444-444444444444"

test("a turn is the request it answers: two turns, a restart between them, and a stale run id", async () => {
  const world = await liveWorld()
  try {
    world.write("app.ts", lines(30))
    world.write("util.ts", "export const util = 1\n")
    await world.settle()
    // Turn one: the harness names its run while it runs.
    world.batch({ requestChanges: [request(TURN_ONE, "dispatching")], sessionChanges: { status: "running", nativeRunId: "run-A" } })
    await world.edit("toolu_a1", "app.ts", lines(30, { 4: "line 4 by turn one", 5: "line 5 by turn one" }))
    world.batch({ requestChanges: [request(TURN_ONE, "completed")], sessionChanges: { status: "ready" } })
    await world.settle()

    // The host restarts. The session comes back whole, still carrying turn one's run id, as the next turn starts.
    await world.restart()
    world.batch({ requests: [request(TURN_ONE, "completed"), request(TURN_TWO, "dispatching")], session: { connection: "connected", id: "conversation-7", harness: "claude", cwd: world.folder, status: "running", nativeRunId: "run-A", modes: [], currentMode: null, configOptions: [] } })
    await world.edit("toolu_b1", "util.ts", "export const util = 2\nexport const more = 3\n")
    world.batch({ sessionChanges: { nativeRunId: "run-B" } })
    await world.edit("toolu_b2", "app.ts", lines(30, { 4: "line 4 by turn one", 5: "line 5 by turn one", 20: "line 20 by turn two" }))
    world.batch({ requestChanges: [request(TURN_TWO, "completed")], sessionChanges: { status: "ready" } })
    await world.settle()

    const turns = world.tracker.store.activityOfThread("T7").filter((item) => item.kind === "turn")
    assert.deepEqual(turns.map((turn) => [turn.id, turn.run]), [[TURN_ONE, "run-A"], [TURN_TWO, "run-B"]], "each turn is its request; the stale run id named neither")
    const one = turnChanges(world.view(), "T7", TURN_ONE)
    const two = turnChanges(world.view(), "T7", TURN_TWO)
    assert.deepEqual(one.files.map((file) => [file.relative, file.own]), [["app.ts", { added: 2, removed: 2 }]])
    assert.deepEqual(two.files.map((file) => [file.relative, file.own]), [["app.ts", { added: 1, removed: 1 }], ["util.ts", { added: 2, removed: 1 }]])
    assert.deepEqual(two.own, { files: 2, added: 3, removed: 2 })
    assert.deepEqual([one.state, one.maybe.files, two.maybe.files], ["settled", 0, 0])
    // The file's chain spans both turns; each counts only its own entries, first before to last after.
    assert.ok(two.files[0]!.entries.first > one.files[0]!.entries.last)
  } finally {
    await world.close()
  }
})

test("a turn's lines are net, a failed edit changes nothing, and the person's save while it ran is only maybe", async () => {
  const world = await liveWorld()
  try {
    world.write("list.ts", lines(10))
    await world.settle()
    world.batch({ requestChanges: [request(TURN_THREE, "dispatching")], sessionChanges: { status: "running" } })
    // Five lines added, then taken back, then one line changed: the turn changed one line.
    await world.edit("toolu_c1", "list.ts", lines(10) + "a\nb\nc\nd\ne\n")
    await world.edit("toolu_c2", "list.ts", lines(10))
    await world.edit("toolu_c3", "list.ts", lines(10, { 7: "line 7 changed" }))
    // An edit the harness refused: it reported the write, but the file never changed.
    await world.edit("toolu_c4", "refused.ts", "never written\n", "failed")
    // A long command runs, naming nothing; meanwhile the person saves a file the agent never went near.
    world.batch({ updates: [{ kind: "tool", id: "toolu_c5", title: "Bash", name: "Bash", status: "in_progress", input: JSON.stringify({ command: "npm test" }) }] })
    world.clock.advance(500)
    world.write("notes.md", "the person's own note\n")
    await world.tracker.settled()
    world.clock.advance(500)
    world.batch({ updates: [{ kind: "tool-update", id: "toolu_c5", status: "completed", output: "ok" }] })
    world.batch({ requestChanges: [request(TURN_THREE, "completed")], sessionChanges: { status: "ready" } })
    await world.settle()

    const counted = turnChanges(world.view(), "T7", TURN_THREE)
    assert.deepEqual(counted.own, { files: 1, added: 1, removed: 1 }, "net lines: the five added and removed count for nothing")
    assert.deepEqual(counted.maybe, { files: 1, added: 1, removed: 0 }, "the person's save while it ran is maybe")
    const note = counted.files.find((file) => file.relative === "notes.md")
    assert.ok(note && note.own === undefined && note.maybe, "never the turn's own")
    assert.ok(!counted.files.some((file) => file.relative === "refused.ts"))

    // A file link to the refused edit's file says the Thread named it, never that it changed it.
    const refused = join(world.folder, "refused.ts")
    writeFileSync(refused, "the person made it later\n")
    const call = world.tracker.store.activityOfThread("T7").find((item) => item.id === "toolu_c4")
    assert.equal(call?.status, "failed", "the call's status is kept with its effects")
    const context = await new ThreadFiles({ git: runner, home: world.folder }).context(world.tracker.store, { thread: "T7", cwd: world.folder, current: [world.folder] })
    assert.equal(context.touched.get(refused)?.kind, "named")
    assert.equal(context.touched.get(join(world.folder, "list.ts"))?.kind, "wrote")
  } finally {
    await world.close()
  }
})

test("a line an answer named is followed to where it is now, and is gone once removed", async () => {
  const world = await liveWorld()
  try {
    world.write("long.ts", lines(40))
    await world.settle()
    world.batch({ requestChanges: [request(TURN_FOUR, "dispatching")], sessionChanges: { status: "running" } })
    await world.edit("toolu_d1", "long.ts", lines(40, { 20: "line 20, the one the answer names" }))
    world.batch({ requestChanges: [request(TURN_FOUR, "completed")], sessionChanges: { status: "ready" } })
    const answered = world.clock.now()
    world.clock.advance(60_000)
    // Later, someone adds three lines at the top and removes line 30.
    const later = ["// a\n", "// b\n", "// c\n", ...lines(40, { 20: "line 20, the one the answer names" }).split(/(?<=\n)/).filter((_line, i) => i !== 29)].join("")
    world.write("long.ts", later)
    await world.tracker.settled()
    const roots = world.tracker.store.roots()
    const path = join(world.folder, "long.ts")
    assert.equal(lineNow(world.tracker.store, roots, path, 20, answered), 23, "three lines above it moved it down")
    assert.equal(lineNow(world.tracker.store, roots, path, 30, answered), null, "the line was removed")
    assert.equal(lineNow(world.tracker.store, roots, path, 5, world.clock.now()), 5, "nothing changed since")
    const files = new ThreadFiles({ git: runner, home: world.folder })
    const [found] = await files.resolve(world.tracker.store, { thread: "T7", cwd: world.folder, current: [world.folder], asOf: answered }, ["long.ts:20"])
    assert.ok(found?.kind === "file")
    assert.deepEqual(found.file.line, { was: 20, now: 23 })
  } finally {
    await world.close()
  }
})

test("a root whose folder went while no tracker ran is let go, not journaled as every file deleted", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-gone-")))
  const goneStorage = mkdtempSync(join(tmpdir(), "mako-attribution-gone-journal-"))
  const goneEvents = new FakeEventSource()
  const ports = { fs: nodeFileSystem(), events: goneEvents, clock: new FakeClock(Date.now()), storage: goneStorage, device: "scenario" }
  writeFileSync(join(folder, "a.txt"), "a\n")
  let gone = await LaptopTracker.open(ports)
  await gone.track({ id: "gone", path: folder, kind: "attached" })
  await gone.close()
  rmSync(folder, { recursive: true, force: true })
  gone = await LaptopTracker.open(ports)
  await gone.settled()
  assert.equal(gone.changes(0).length, 0)
  assert.equal(gone.rootStates().size, 0)
  await gone.close()
  rmSync(goneStorage, { recursive: true, force: true })
})

test.after(async () => {
  await tracker.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(storage, { recursive: true, force: true })
})
