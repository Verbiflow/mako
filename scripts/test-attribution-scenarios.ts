import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { Git } from "@mako/git"
import type { ActivityMark, ExactBounds, ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { JournalStore } from "@mako/host/attribution/journal-store"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { contentRef } from "@mako/host/attribution/content"
import { writersSince } from "@mako/host/attribution/writers-since"
import { CallBounds, liveCallBounds, type LiveCallBounds } from "@mako/host/harnesses/call-bounds"
import { claudeCallHooks } from "@mako/host/harnesses/claude/call-hooks"
import { changes, hunks, partition, restorable, turnChanges, type JournalView } from "@mako/host/attribution/queries"
import { lineNow, ThreadFiles } from "@mako/host/attribution/thread-files"
import { threadTotals } from "@mako/host/attribution"
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
    /** A call's exact bounds, as a harness's hooks publish them (`liveCallBounds`). */
    bounds: (call: string, status: "completed" | "failed", exact: ExactBounds) => adapter.bounds("conversation-7", call, status, exact),
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
    /** Every change so far settled, as the journal settles them once nothing can reach them; each heard at once, as the watcher hears it. */
    async settle() {
      await tracker.settled()
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
const TURN_FIVE = "55555555-5555-4555-8555-555555555555"
const TURN_SIX = "66666666-6666-4666-8666-666666666666"

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

/**
 * A repository with an upstream to pull from, its own tracker on a scripted
 * clock, and Git run for real. `gitHeard` tells the tracker what a Git
 * command touched as the watcher hears it: the files it wrote, then its own
 * files (HEAD, the index, the reflog), each file's time set to the clock.
 */
async function gitWorld(t: { after(run: () => Promise<void> | void): void }) {
  const upstream = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-upstream-")))
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-git-")))
  const journal = mkdtempSync(join(tmpdir(), "mako-attribution-git-journal-"))
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true" } }).trim()
  run(upstream, "init", "-q", "-b", "main")
  writeFileSync(join(upstream, "a.ts"), lines(6))
  writeFileSync(join(upstream, "b.ts"), "export const b = 1\n")
  run(upstream, "add", "-A")
  run(upstream, "commit", "-q", "-m", "base")
  run(folder, "clone", "-q", upstream, ".")
  const worldClock = new FakeClock(Date.now())
  const worldEvents = new FakeEventSource()
  const worldTracker = await LaptopTracker.open(
    { fs: nodeFileSystem(), events: worldEvents, clock: worldClock, storage: journal, device: "scenario" },
    { repository: async (path) => gitRepository(runner, path) },
  )
  await worldTracker.track({ id: "git", path: folder, kind: "workspace" })
  t.after(async () => {
    await worldTracker.close()
    for (const path of [upstream, folder, journal]) rmSync(path, { recursive: true, force: true })
  })
  const touch = (path: string) => {
    const absolute = join(folder, path)
    try {
      utimesSync(absolute, worldClock.now() / 1000, worldClock.now() / 1000)
    } catch {
      // Gone: a deletion is heard all the same.
    }
    worldEvents.changed(absolute)
  }
  return {
    upstream,
    folder,
    tracker: worldTracker,
    clock: worldClock,
    git: (...args: string[]) => run(folder, ...args),
    upstreamGit: (...args: string[]) => run(upstream, ...args),
    write(path: string, text: string) {
      writeFileSync(join(folder, path), text)
      touch(path)
    },
    /** What a Git command wrote, heard as the watcher hears it: files first, then Git's own. */
    gitHeard(paths: readonly string[], own: readonly string[] = [".git/index", ".git/HEAD", ".git/logs/HEAD", ".git/ORIG_HEAD"]) {
      for (const path of paths) touch(path)
      for (const path of own) worldEvents.changed(join(folder, path))
    },
    mark(kind: ActivityMark["kind"], thread: string, id: string, edge: "start" | "end", turn?: string) {
      worldTracker.activity({ kind, id, edge, at: worldClock.now(), thread, session: `${thread}-session`, checkout: folder, turn })
    },
    entries: () => worldTracker.changes(0),
  }
}

test("a branch switch, a pull, a stash and a rebase are Git's, not the running Thread's", async (t) => {
  const world = await gitWorld(t)
  const { folder } = world
  const since = () => world.entries().at(-1)?.seq ?? 0

  // The person switches branches while T1's turn runs: the files the switch wrote are the new branch's base.
  world.git("checkout", "-q", "-b", "feature")
  writeFileSync(join(folder, "a.ts"), lines(6, { 2: "line 2 on feature" }))
  writeFileSync(join(folder, "f.ts"), "export const f = 6\n")
  world.git("rm", "-q", "b.ts")
  world.git("add", "-A")
  world.git("commit", "-q", "-m", "feature work")
  world.git("checkout", "-q", "main")
  world.gitHeard(["a.ts", "b.ts", "f.ts"])
  await world.tracker.settled()
  let from = since()
  world.mark("turn", "T1", "t1", "start")
  world.clock.advance(100)
  world.git("checkout", "-q", "feature")
  world.gitHeard(["a.ts", "b.ts", "f.ts"])
  await world.tracker.settled()
  assert.deepEqual(world.entries().filter((entry) => entry.seq > from), [], "a branch switch journals nothing")
  assert.equal(world.tracker.rootStates().get("git")?.files.size, 0, "every file is clean against the new branch")

  // An agent's `git checkout -b x && git pull`: the pulled files are the new base, not the call's edits.
  world.upstreamGit("checkout", "-q", "main")
  writeFileSync(join(world.upstream, "a.ts"), lines(6, { 5: "line 5 upstream" }))
  writeFileSync(join(world.upstream, "u.ts"), "export const u = 21\n")
  world.upstreamGit("add", "-A")
  world.upstreamGit("commit", "-q", "-m", "upstream work")
  world.git("checkout", "-q", "main")
  world.gitHeard(["a.ts", "b.ts", "f.ts"])
  await world.tracker.settled()
  from = since()
  world.clock.advance(100)
  world.mark("call", "T1", "pull", "start", "t1")
  world.clock.advance(20)
  const head = world.git("rev-parse", "HEAD")
  world.git("checkout", "-q", "-b", "x")
  world.git("pull", "-q", "--no-rebase", "origin", "main")
  world.gitHeard(world.git("diff", "--name-only", head, "HEAD").split("\n"))
  world.clock.advance(20)
  world.tracker.reported({ thread: "T1", session: "T1-session", turn: "t1", call: "pull", status: "completed", endedAt: world.clock.now(), effects: [{ kind: "command", command: "git checkout -b x && git pull", cwd: folder }] })
  world.mark("call", "T1", "pull", "end", "t1")
  await world.tracker.settled()
  assert.deepEqual(world.entries().filter((entry) => entry.seq > from), [], "a pull journals nothing")

  // Git wrote the files before HEAD moved and they were heard first: their entries are marked as Git's.
  from = since()
  world.git("checkout", "-q", "-b", "y", head)
  world.gitHeard(["a.ts", "u.ts"], [])
  await world.tracker.settled()
  world.gitHeard([], [".git/HEAD", ".git/index", ".git/logs/HEAD"])
  await world.tracker.settled()
  const early = world.entries().filter((entry) => entry.seq > from)
  assert.ok(early.length > 0 && early.every((entry) => entry.git), "files heard before HEAD moved are marked as Git's")
  world.git("checkout", "-q", "x")
  world.gitHeard(["a.ts", "u.ts"])
  await world.tracker.settled()

  // The person's own edit, stashed before T1's turn and popped during it: the lines stay the person's.
  world.clock.advance(20_000)
  world.mark("turn", "T1", "t1", "end")
  world.clock.advance(5_000)
  world.write("b.ts", "export const b = 2 // the person's\n")
  await world.tracker.settled()
  const persons = world.entries().at(-1)!
  assert.deepEqual(persons.author, { certainty: "person", via: "no-activity" })
  world.git("stash", "-q")
  world.gitHeard(["b.ts"], [".git/index", ".git/logs/refs/stash", ".git/refs/stash"])
  await world.tracker.settled()
  const stashed = world.entries().at(-1)!
  assert.deepEqual([stashed.path, stashed.git], ["b.ts", true], "a stash's reset to the base is Git's")
  world.clock.advance(1_000)
  world.mark("turn", "T1", "t2", "start")
  world.clock.advance(100)
  world.git("stash", "pop", "-q")
  world.gitHeard(["b.ts"], [".git/index", ".git/logs/refs/stash", ".git/refs/stash"])
  await world.tracker.settled()
  const popped = world.entries().at(-1)!
  assert.equal(popped.path, "b.ts")
  assert.equal(popped.git, true, "the pop is Git's, not T1's")
  assert.equal(popped.restores, persons.seq, "the popped version is the person's")
  const writer = world.tracker.blame("git", "b.ts")?.find((run) => run.entry !== null)
  assert.equal(writer?.entry, persons.seq, "its line is still the person's")

  // An agent's own `git checkout -- b.ts`, the file named: its work, not Git's.
  world.clock.advance(100)
  world.mark("call", "T1", "undo", "start", "t2")
  world.clock.advance(20)
  world.git("checkout", "--", "b.ts")
  world.gitHeard(["b.ts"], [".git/index"])
  world.clock.advance(20)
  world.tracker.reported({ thread: "T1", session: "T1-session", turn: "t2", call: "undo", status: "completed", endedAt: world.clock.now(), effects: [{ kind: "command", command: "git checkout -- b.ts", cwd: folder, named: [join(folder, "b.ts")] }] })
  world.mark("call", "T1", "undo", "end", "t2")
  await world.tracker.settled()
  const undone = world.entries().at(-1)!
  assert.equal(undone.git, undefined, "a call that named the file did it")
  assert.equal(undone.author.certainty, "named")

  // An interactive rebase while T2 runs: every file it rewrote is the rewritten branch's base.
  world.clock.advance(5_000)
  world.mark("turn", "T1", "t2", "end")
  for (const [path, text] of [["r1.ts", "export const r1 = 1\n"], ["r2.ts", "export const r2 = 2\n"]] as const) {
    writeFileSync(join(folder, path), text)
    world.git("add", path)
    world.git("commit", "-q", "-m", path)
    world.gitHeard([path])
  }
  await world.tracker.settled()
  from = since()
  world.mark("turn", "T2", "r", "start")
  world.clock.advance(100)
  const before = world.git("rev-parse", "HEAD")
  // Drop the older of the two commits, as `git rebase -i` with that line removed does.
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "rebase", "-q", "-i", "HEAD~2"], {
    cwd: folder,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: `${process.execPath} -e "const f=process.argv[1];const fs=require('fs');const l=fs.readFileSync(f,'utf8').split('\\n');l[0]='drop'+l[0].slice(4);fs.writeFileSync(f,l.join('\\n'))"` },
  })
  assert.notEqual(world.git("rev-parse", "HEAD"), before)
  world.gitHeard(["r1.ts", "r2.ts"])
  await world.tracker.settled()
  assert.deepEqual(world.entries().filter((entry) => entry.seq > from), [], "a rebase journals nothing")
  world.mark("turn", "T2", "r", "end")
  assert.equal(world.tracker.rootStates().get("git")?.files.size, 0)
})

test("a call a hook bounds: its write proven by content, the person's saves around it the person's", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-hooked-")))
  const journal = mkdtempSync(join(tmpdir(), "mako-attribution-hooked-journal-"))
  const hookedClock = new FakeClock(Date.now())
  const hookedEvents = new FakeEventSource()
  const hooked = await LaptopTracker.open({ fs: nodeFileSystem(), events: hookedEvents, clock: hookedClock, storage: journal, device: "scenario" })
  t.after(async () => {
    await hooked.close()
    rmSync(folder, { recursive: true, force: true })
    rmSync(journal, { recursive: true, force: true })
  })
  for (const name of ["a.ts", "x.ts", "p.ts", "q.ts"]) writeFileSync(join(folder, name), `${name} as it was\n`)
  await hooked.track({ id: "hooked", path: folder, kind: "attached" })
  const began = hookedClock.now()
  const when = (ms: number) => hookedClock.advance(began + ms - hookedClock.now())
  const save = (name: string, text: string) => {
    writeFileSync(join(folder, name), text)
    utimesSync(join(folder, name), hookedClock.now() / 1000, hookedClock.now() / 1000)
    hookedEvents.changed(join(folder, name))
  }
  const T5 = { thread: "T5", session: "T5-session", checkout: folder }
  const author = (name: string) => hooked.changes(0).findLast((entry) => entry.path === name)?.author

  hooked.activity({ ...T5, kind: "turn", id: "t5", edge: "start", at: hookedClock.now() })
  // The stream shows the call as the model starts writing it.
  when(100)
  hooked.activity({ ...T5, kind: "call", id: "h1", edge: "start", at: hookedClock.now(), turn: "t5", named: [join(folder, "a.ts")] })
  // The person saves while the model is still writing the call, before the tool runs.
  when(600)
  save("x.ts", "x.ts saved by the person\n")
  // The tool runs from 1000 to 1030 ms; its stream reports no patch.
  when(1_010)
  save("a.ts", "a.ts written by the call\n")
  when(1_030)
  hooked.reported({ ...T5, call: "h1", status: "completed", startedAt: began + 1_000, endedAt: began + 1_030, effects: [], exact: {
    start: began + 1_000,
    end: began + 1_030,
    files: [{ path: join(folder, "a.ts"), before: contentRef(Buffer.from("a.ts as it was\n")), after: contentRef(Buffer.from("a.ts written by the call\n")) }],
  } })
  when(1_100)
  hooked.reported({ ...T5, turn: "t5", call: "h1", status: "completed", endedAt: hookedClock.now(), effects: [{ kind: "write", path: join(folder, "a.ts") }] })
  hooked.activity({ ...T5, kind: "call", id: "h1", edge: "end", at: hookedClock.now(), turn: "t5" })
  // The person saves just after the call ended, as the model writes its next one.
  when(1_400)
  save("p.ts", "p.ts saved by the person\n")
  when(3_000)
  hooked.activity({ ...T5, kind: "call", id: "h2", edge: "start", at: hookedClock.now(), turn: "t5" })
  await hooked.settled()
  assert.deepEqual(author("a.ts"), { certainty: "exact", author: { thread: "T5", session: "T5-session", turn: "t5", call: "h1" }, effect: "modify" }, "the hook's own record of the file proves the write")
  assert.deepEqual(author("x.ts"), { certainty: "person", via: "no-activity" }, "a save while the model wrote the call is the person's")
  assert.deepEqual(author("p.ts"), { certainty: "person", via: "no-activity" }, "a save just after the hooked call ended is the person's")
  when(3_100)
  hooked.reported({ ...T5, call: "h2", status: "completed", startedAt: began + 3_050, endedAt: began + 3_080, effects: [], exact: { start: began + 3_050, end: began + 3_080 } })
  hooked.activity({ ...T5, kind: "call", id: "h2", edge: "end", at: hookedClock.now(), turn: "t5" })
  hooked.activity({ ...T5, kind: "turn", id: "t5", edge: "end", at: hookedClock.now() })
  // Just after the turn ended: the person's.
  when(3_500)
  save("q.ts", "q.ts saved by the person\n")
  await hooked.settled()
  assert.deepEqual(author("q.ts"), { certainty: "person", via: "no-activity" }, "a save just after a hooked turn ended is the person's")
  // A rewind's preview names each file's writers since its checkpoint.
  const hookedView: JournalView = { store: hooked.store, roots: () => hooked.rootStates().values(), author: (seq) => hooked.authorOf(seq) }
  assert.deepEqual(writersSince(hookedView, [join(folder, "a.ts"), join(folder, "x.ts")], began), {
    [join(folder, "a.ts")]: [{ kind: "thread", thread: "T5", sure: true }],
    [join(folder, "x.ts")]: [{ kind: "person" }],
  })

  // The same timing with no hook: only the stream's marks, so the save trails the call and stays its maybe.
  const T6 = { thread: "T6", session: "T6-session", checkout: folder }
  when(10_000)
  hooked.activity({ ...T6, kind: "turn", id: "t6", edge: "start", at: hookedClock.now() })
  hooked.activity({ ...T6, kind: "call", id: "s1", edge: "start", at: hookedClock.now(), turn: "t6" })
  when(10_500)
  hooked.activity({ ...T6, kind: "call", id: "s1", edge: "end", at: hookedClock.now(), turn: "t6" })
  when(10_800)
  save("p.ts", "p.ts saved again by the person\n")
  await hooked.settled()
  const trailing = author("p.ts")
  assert.equal(trailing?.certainty, "window", "without exact bounds the stream's trail still reaches it")
  hooked.activity({ ...T6, kind: "turn", id: "t6", edge: "end", at: hookedClock.now() })
})

test("Claude's hooks mark a call's exact bounds and hash the file it wrote; a call left running bounds nothing", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-hooks-")))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const target = join(folder, "page.ts")
  writeFileSync(target, "export const title = 'old'\n")
  const heard: LiveCallBounds[] = []
  const unsubscribe = liveCallBounds.subscribe((bounds) => heard.push(bounds))
  t.after(unsubscribe)
  let now = 1_000
  const hooks = claudeCallHooks(new CallBounds("conversation-1", () => now))
  const base = { session_id: "s", transcript_path: join(folder, "t.jsonl"), cwd: folder }
  const signal = { signal: new AbortController().signal }
  await hooks.pre({ ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "toolu_1", tool_input: { file_path: target, old_string: "'old'", new_string: "'new'" } }, "toolu_1", signal)
  // The person takes 4 s to approve; the tool itself runs 30 ms.
  now = 5_000
  writeFileSync(target, "export const title = 'new'\n")
  now = 5_030
  await hooks.post({ ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "toolu_1", tool_input: { file_path: target }, tool_response: {}, duration_ms: 30 }, "toolu_1", signal)
  assert.deepEqual(heard, [{ conversation: "conversation-1", call: "toolu_1", status: "completed", exact: {
    start: 5_000,
    end: 5_030,
    files: [{ path: target, before: contentRef(Buffer.from("export const title = 'old'\n")), after: contentRef(Buffer.from("export const title = 'new'\n")) }],
  } }], "the start is when the tool ran, not when it was asked")
  await hooks.pre({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_2", tool_input: { command: "npm run dev", run_in_background: true } }, "toolu_2", signal)
  now = 5_100
  await hooks.post({ ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_2", tool_input: { command: "npm run dev", run_in_background: true }, error: "exit 1" }, "toolu_2", signal)
  assert.deepEqual(heard.at(-1), { conversation: "conversation-1", call: "toolu_2", status: "failed", exact: { start: 5_030, end: 5_100, detached: true } })
})

/*
 * The journal's two halves together: what a turn changed (`turnChanges`,
 * the stored summary, "changes made") is counted from the same entries and
 * the same evidence the capture side writes, Git's put-backs and a hook's
 * exact bounds among them.
 */

test("an agent's `git checkout -b x && git pull` in a turn: the pulled files are in neither its summary nor changes made", async (t) => {
  const world = await gitWorld(t)
  const { folder } = world
  const view: JournalView = { store: world.tracker.store, roots: () => world.tracker.rootStates().values(), author: (seq) => world.tracker.authorOf(seq) }
  world.upstreamGit("checkout", "-q", "main")
  writeFileSync(join(world.upstream, "a.ts"), lines(6, { 3: "line 3 upstream" }))
  writeFileSync(join(world.upstream, "u.ts"), "export const u = 1\nexport const v = 2\n")
  world.upstreamGit("add", "-A")
  world.upstreamGit("commit", "-q", "-m", "upstream work")
  const began = world.clock.now()
  world.mark("turn", "T1", TURN_SIX, "start")
  // The agent's own edit in the turn: counted, as before.
  world.clock.advance(100)
  world.mark("call", "T1", "own", "start", TURN_SIX)
  world.clock.advance(20)
  world.write("own.ts", "export const own = 1\n")
  await world.tracker.settled()
  world.clock.advance(20)
  world.tracker.reported({ thread: "T1", session: "T1-session", turn: TURN_SIX, call: "own", status: "completed", endedAt: world.clock.now(), effects: [{ kind: "write", path: join(folder, "own.ts"), content: "export const own = 1\n" }] })
  world.mark("call", "T1", "own", "end", TURN_SIX)
  const from = world.entries().at(-1)!.seq
  // Its command switches branch and pulls; the watcher hears the files Git wrote before Git's own, so they are journaled first.
  world.clock.advance(100)
  world.mark("call", "T1", "pull", "start", TURN_SIX)
  world.clock.advance(20)
  const head = world.git("rev-parse", "HEAD")
  world.git("checkout", "-q", "-b", "x")
  world.git("pull", "-q", "--no-rebase", "origin", "main")
  const pulled = world.git("diff", "--name-only", head, "HEAD").split("\n")
  assert.deepEqual(pulled.sort(), ["a.ts", "u.ts"])
  world.gitHeard(pulled, [])
  await world.tracker.settled()
  world.gitHeard([], [".git/HEAD", ".git/index", ".git/logs/HEAD"])
  await world.tracker.settled()
  world.clock.advance(20)
  world.tracker.reported({ thread: "T1", session: "T1-session", turn: TURN_SIX, call: "pull", status: "completed", endedAt: world.clock.now(), effects: [{ kind: "command", command: "git checkout -b x && git pull", cwd: folder }] })
  world.mark("call", "T1", "pull", "end", TURN_SIX)
  world.clock.advance(100)
  world.mark("turn", "T1", TURN_SIX, "end")
  world.clock.advance(15_000)
  world.tracker.sweep()
  await world.tracker.settled()

  const gits = world.entries().filter((entry) => entry.seq > from)
  assert.deepEqual(gits.map((entry) => [entry.path, entry.git]).sort(), [["a.ts", true], ["u.ts", true]], "what the pull wrote was journaled, and marked as Git's")
  assert.ok(gits.every((entry) => "author" in entry.author && entry.author.author.thread === "T1"), "timing alone names the running Thread: only the mark keeps it out")
  const summary = turnChanges(view, "T1", TURN_SIX)
  assert.deepEqual(summary.files.map((file) => [file.relative, file.own]), [["own.ts", { added: 1, removed: 0 }]], "the turn's summary is its own edit alone")
  assert.deepEqual([summary.own, summary.maybe.files, summary.others.files], [{ files: 1, added: 1, removed: 0 }, 0, 0], "the pulled files are nobody's: not own, maybe or others'")
  // "Changes made" sums the stored summaries; the thread's own count of sure changes agrees.
  world.tracker.store.saveTurnChanges(summary, "T1-session")
  const found = changes(view, "T1")
  const made = threadTotals(world.tracker.store.turnChangesOf("T1"), found)
  assert.deepEqual([made.files, made.lines, made.maybe], [{ created: 1, changed: 0, deleted: 0, renamed: 0 }, { added: 1, removed: 0 }, 0])
  assert.deepEqual([found.files.created.map((path) => basename(path)), found.files.modified, found.maybe], [["own.ts"], [], 0])
  assert.deepEqual(world.tracker.store.turnsChangedAfter("T1", from), new Map(), "nothing Git wrote calls for a recount")
  // A rewind's preview agrees: Git wrote them, and Git is no writer.
  assert.deepEqual(writersSince(view, [join(folder, "a.ts"), join(folder, "u.ts"), join(folder, "own.ts")], began), {
    [join(folder, "a.ts")]: [],
    [join(folder, "u.ts")]: [],
    [join(folder, "own.ts")]: [{ kind: "thread", thread: "T1", sure: true }],
  })
})

test("a hook-bounded call's turn: its summary keeps the call's write and leaves out the person's save just after it", async () => {
  const world = await liveWorld()
  try {
    world.write("a.ts", "a.ts as it was\n")
    world.write("p.ts", "p.ts as it was\n")
    await world.settle()
    const a = join(world.folder, "a.ts")
    world.batch({ requestChanges: [request(TURN_FIVE, "dispatching")], sessionChanges: { status: "running" } })
    const started = world.clock.now()
    // The stream shows the call as the model starts writing it; the tool runs once the person approves it.
    world.batch({ updates: [{ kind: "tool", id: "toolu_h1", title: "Edit", name: "Edit", status: "in_progress", input: JSON.stringify({ file_path: a, old_string: "as it was", new_string: "by the call" }) }] })
    world.clock.advance(900)
    const ran = world.clock.now()
    world.write("a.ts", "a.ts by the call\n")
    world.clock.advance(30)
    world.bounds("toolu_h1", "completed", {
      start: ran,
      end: world.clock.now(),
      files: [{ path: a, before: contentRef(Buffer.from("a.ts as it was\n")), after: contentRef(Buffer.from("a.ts by the call\n")) }],
    })
    world.clock.advance(50)
    world.batch({ updates: [{ kind: "tool-update", id: "toolu_h1", status: "completed", output: "ok", effects: [{ kind: "modify", path: a, edits: [{ old: "as it was", new: "by the call" }] }] }] })
    // The person saves while the model writes its next call; a whole second would read as a coarse file system's rounding.
    world.clock.advance(300)
    if (world.clock.now() % 1_000 === 0) world.clock.advance(1)
    world.write("p.ts", "p.ts saved by the person\n")
    await world.tracker.settled()
    world.clock.advance(1_500)
    world.batch({ updates: [{ kind: "tool", id: "toolu_h2", title: "Bash", name: "Bash", status: "in_progress", input: JSON.stringify({ command: "npm test" }) }] })
    await world.tracker.settled()
    world.clock.advance(30)
    world.bounds("toolu_h2", "completed", { start: world.clock.now() - 20, end: world.clock.now() })
    world.batch({ updates: [{ kind: "tool-update", id: "toolu_h2", status: "completed", output: "ok" }] })
    // A subagent's write the stream never shows: only the hooks report it, and it is the turn's all the same.
    world.clock.advance(200)
    const sub = world.clock.now()
    world.write("s.ts", "s.ts by a subagent\n")
    world.clock.advance(20)
    world.bounds("toolu_sub", "completed", { start: sub, end: world.clock.now(), files: [{ path: join(world.folder, "s.ts"), before: null, after: contentRef(Buffer.from("s.ts by a subagent\n")) }] })
    await world.tracker.settled()
    world.batch({ requestChanges: [request(TURN_FIVE, "completed")], sessionChanges: { status: "ready" } })
    await world.settle()

    // One record of each call, under the request its marks carry: the hook's bounds took the same path.
    const calls = world.tracker.store.activityOfThread("T7").filter((item) => item.kind === "call")
    assert.deepEqual(calls.map((call) => [call.id, call.turn, call.status]).sort(), [["toolu_h1", TURN_FIVE, "completed"], ["toolu_h2", TURN_FIVE, "completed"], ["toolu_sub", TURN_FIVE, "completed"]])
    const h1 = calls.find((call) => call.id === "toolu_h1")!
    assert.deepEqual(h1.effects, [{ kind: "modify", path: a }], "the stream's effects and the hook's bounds are one call")
    const author = (name: string) => world.tracker.changes(0).findLast((entry) => entry.path === name)?.author
    assert.deepEqual(author("a.ts"), { certainty: "exact", author: { thread: "T7", session: "session-7", turn: TURN_FIVE, call: "toolu_h1" }, effect: "modify" })
    assert.deepEqual(author("p.ts"), { certainty: "person", via: "no-activity" }, "outside the hook's bounds, between two calls: the person's")
    const summary = turnChanges(world.view(), "T7", TURN_FIVE)
    assert.deepEqual(author("s.ts"), { certainty: "exact", author: { thread: "T7", session: "session-7", turn: TURN_FIVE, call: "toolu_sub" }, effect: "create" }, "the hook's report carries the request its turn answers")
    assert.deepEqual(summary.files.map((file) => [file.relative, file.own, file.maybe]), [["a.ts", { added: 1, removed: 1 }, undefined], ["s.ts", { added: 1, removed: 0 }, undefined]], "the person's save is neither the turn's nor its maybe")
    assert.deepEqual([summary.own.files, summary.maybe.files, summary.others.files], [2, 0, 1], "it counts as others' while the turn ran")
    // A rewind's writers read the same entries the same way.
    assert.deepEqual(writersSince(world.view(), [a, join(world.folder, "p.ts")], started), {
      [a]: [{ kind: "thread", thread: "T7", sure: true }],
      [join(world.folder, "p.ts")]: [{ kind: "person" }],
    })
  } finally {
    await world.close()
  }
})

test("a version Git puts back in a turn keeps its writers: a stash and pop of the turn's own edit is still its own", async (t) => {
  const world = await gitWorld(t)
  const { folder } = world
  const view: JournalView = { store: world.tracker.store, roots: () => world.tracker.rootStates().values(), author: (seq) => world.tracker.authorOf(seq) }
  const turn = "77777777-7777-4777-8777-777777777777"
  world.mark("turn", "T1", turn, "start")
  world.clock.advance(100)
  world.mark("call", "T1", "edit", "start", turn)
  world.clock.advance(20)
  const edited = lines(6, { 4: "line 4 by the turn" })
  world.write("a.ts", edited)
  await world.tracker.settled()
  world.clock.advance(20)
  world.tracker.reported({ thread: "T1", session: "T1-session", turn, call: "edit", status: "completed", endedAt: world.clock.now(), effects: [{ kind: "write", path: join(folder, "a.ts"), content: edited }] })
  world.mark("call", "T1", "edit", "end", turn)
  await world.tracker.settled()
  // The person stashes and pops while the turn still runs.
  world.clock.advance(4_000)
  world.git("stash", "-q")
  world.gitHeard(["a.ts"], [".git/index", ".git/logs/refs/stash", ".git/refs/stash"])
  await world.tracker.settled()
  world.clock.advance(4_000)
  world.git("stash", "pop", "-q")
  world.gitHeard(["a.ts"], [".git/index", ".git/logs/refs/stash", ".git/refs/stash"])
  await world.tracker.settled()
  // The turn edits the file again: its count spans the stash and the pop.
  world.clock.advance(4_000)
  world.mark("call", "T1", "again", "start", turn)
  world.clock.advance(20)
  const again = lines(6, { 4: "line 4 by the turn", 5: "line 5 by the turn" })
  world.write("a.ts", again)
  await world.tracker.settled()
  world.clock.advance(20)
  world.tracker.reported({ thread: "T1", session: "T1-session", turn, call: "again", status: "completed", endedAt: world.clock.now(), effects: [{ kind: "write", path: join(folder, "a.ts"), content: again }] })
  world.mark("call", "T1", "again", "end", turn)
  await world.tracker.settled()
  world.clock.advance(100)
  world.mark("turn", "T1", turn, "end")
  world.clock.advance(15_000)
  world.tracker.sweep()
  await world.tracker.settled()
  const [stash, pop] = world.entries().filter((entry) => entry.path === "a.ts").slice(-3, -1)
  assert.deepEqual([stash?.git, pop?.git], [true, true], "both are Git's")
  const own = world.tracker.blame("git", "a.ts")?.filter((run) => run.entry !== null)
  assert.equal(own?.length, 2)
  assert.ok(own?.every((run) => view.author(run.entry!)?.certainty === "exact"), "the line map has the turn's line back")
  const summary = turnChanges(view, "T1", turn)
  assert.deepEqual(summary.files.map((file) => [file.relative, file.own]), [["a.ts", { added: 2, removed: 2 }]], "and so does the turn's count")
  assert.deepEqual(writersSince(view, [join(folder, "a.ts")], 0), { [join(folder, "a.ts")]: [{ kind: "thread", thread: "T1", sure: true }] })
})

test("a journal from before either column set opens in the one format: turns and candidates filled once, nothing Git's", () => {
  const folder = mkdtempSync(join(tmpdir(), "mako-attribution-format-"))
  const path = join(folder, "journal.sqlite")
  try {
    const at = Date.now()
    const entry = (author: Parameters<JournalStore["insertEntry"]>[0]["author"], name: string) => ({
      at, changedAt: at, root: "r1", path: name, kind: "modify" as const, before: null, after: null, text: true, added: 1, removed: 0, stored: false, observed: "event" as const, author, settled: true,
    })
    const older = JournalStore.open(path, { device: "scenario" })
    older.insertEntry(entry({ certainty: "exact", author: { thread: "T1", session: "S1", turn: TURN_ONE, call: "c1" }, effect: "modify" }, "own.ts"))
    older.insertEntry(entry({ certainty: "ambiguous", reason: "several-threads", candidates: [{ thread: "T1", session: "S1", turn: TURN_ONE }, { thread: "T2", session: "S2", turn: TURN_TWO }] }, "shared.ts"))
    older.saveActivity({ kind: "call", id: "c1", session: "S1", thread: "T1", turn: TURN_ONE, named: [], start: at, end: at + 10 })
    older.close()
    // As the journal was before this format: no turn, run, status or git columns, nor the tables beside the entries.
    const db = new DatabaseSync(path)
    db.exec(`DROP INDEX entries_turn; ALTER TABLE entries DROP COLUMN turn; ALTER TABLE entries DROP COLUMN git;
      ALTER TABLE activity DROP COLUMN status; ALTER TABLE activity DROP COLUMN run; DROP TABLE entry_candidates; DROP TABLE turn_changes`)
    db.close()

    const store = JournalStore.open(path, { device: "scenario" })
    try {
      assert.deepEqual(store.entriesOfTurn("T1", TURN_ONE).map((found) => found.path), ["own.ts", "shared.ts"], "each entry's turn, and the candidates of an ambiguous one, read from its author once")
      assert.deepEqual(store.entriesOfTurn("T2", TURN_TWO).map((found) => found.path), ["shared.ts"])
      assert.equal(store.ambiguousWith("T2"), 1)
      assert.ok(store.entries(0).every((found) => found.git === undefined), "nothing older is Git's")
      store.markGit(store.entries(0)[1]!.seq, true)
      assert.deepEqual(store.entriesOfTurn("T2", TURN_TWO), [], "once marked Git's, no turn's")
      assert.equal(store.ambiguousWith("T2"), 0)
      store.saveActivity({ kind: "call", id: "c1", session: "S1", thread: "T1", status: "failed", named: [], start: at, end: at + 10 })
      assert.equal(store.activityOfThread("T1")[0]?.status, "failed")
    } finally {
      store.close()
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test.after(async () => {
  await tracker.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(storage, { recursive: true, force: true })
})
