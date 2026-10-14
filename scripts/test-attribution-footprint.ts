import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ActivityMark } from "@mako/protocol"
import { FakeClock, FakeEventSource, FakeFileSystem } from "@mako/protocol/attribution-conformance"
import { classify, noiseFolders, readIgnore, type FootprintInput, type RuleFolder, type TurnEvidence } from "@mako/host/attribution/footprint"
import { MAX_WEAK, type PathVerdict } from "@mako/host/attribution/footprint-reader"
import { NoiseBaseline, template, type NoiseRow, type NoiseStore } from "@mako/host/attribution/noise-baseline"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { childHistory } from "@mako/host/workspaces/watch-backend"

/*
 * The footprint outside the checkouts: each rule in its order, what a
 * history read may leave out before anything crosses to the host, the
 * learned baseline, and a turn read end to end through the tracker on fakes.
 * On macOS, the watcher child's history read leaves folders out and counts them.
 */

const HOME = "/h"
const ROOTS = [HOME, "/private/tmp"]
const none: TurnEvidence = { named: new Map(), mentioned: new Set(), cwds: new Set() }

function input(over: Partial<FootprintInput> = {}): FootprintInput {
  const folders: RuleFolder[] = [
    { folder: "/h/work/app", rule: "tracked", why: "a tracked checkout" },
    { folder: "/h/.claude", rule: "store", why: "a harness's store" },
    { folder: "/h/other", rule: "other-session", why: "codex session 9f2c" },
    ...noiseFolders(HOME),
  ]
  return { home: HOME, roots: ROOTS, folders, turn: none, others: new Set(), ...over }
}

const outcome = (path: string, over: Partial<FootprintInput> = {}) => {
  const found = classify(path, input(over))
  return found.kept ? `kept ${found.basis}` : `out ${found.rule}`
}

test("the rules decide in their order", () => {
  const named = new Map<string, "read" | "write">([["/h/work/app/a.ts", "write"], ["/h/other/shared.txt", "write"], ["/h/.config/tool", "write"]])
  const turn: TurnEvidence = { named, mentioned: new Set(["/h/out/report.txt"]), cwds: new Set(["/h/scratch"]) }
  const others = new Set(["/h/shared"])
  const baseline = (path: string) => (path.startsWith("/h/.sync/") ? { key: "/h/.sync", why: "changed while no Thread ran" } : undefined)
  const cases: [string, string][] = [
    // A tracked checkout and a store win over everything the turn said.
    ["/h/work/app/a.ts", "out tracked"],
    ["/h/.claude/projects/s.jsonl", "out store"],
    // What the turn named wins over another session's folder.
    ["/h/other/shared.txt", "kept named"],
    ["/h/out/report.txt", "kept output"],
    ["/h/.config/tool/state.json.lock", "out bookkeeping"],
    ["/h/other/b.ts", "out other-session"],
    ["/h/shared/x.json", "out other-thread"],
    ["/h/.config/tool/state.json", "kept folder"],
    ["/h/scratch/build/out.o", "kept cwd"],
    ["/h/Library/Caches/x", "out noise"],
    ["/h/elsewhere/node_modules/p/index.js", "out noise"],
    ["/h/.zsh_history", "out noise"],
    ["/h/.sync/index/1.db", "out baseline"],
    ["/h/notes.txt", "kept window"],
    // The temporary root is no `tmp` folder: only folders below it count.
    ["/private/tmp/tool-out/run.txt", "kept window"],
    ["/private/tmp/build/node_modules/p/index.js", "out noise"],
  ]
  for (const [path, expected] of cases) assert.equal(outcome(path, { turn, others, baseline }), expected, path)
})

test("a folder that is a footprint root says nothing: a turn run in the home folder doesn't own it", () => {
  assert.equal(outcome("/h/notes.txt", { turn: { ...none, cwds: new Set(["/h"]) } }), "kept window")
  assert.equal(outcome("/h/notes.txt", { turn: { ...none, named: new Map([["/h", "read"]]) } }), "kept window")
})

test("a path filed under another session's id is that session's, unless the turn named a folder holding it", () => {
  const theirs = "8f2c1a90-1b2c-4d5e-8f90-0a1b2c3d4e5f"
  const sessions = new Map([[theirs, "claude session 8f2c1a90"], ["ses_7kq2", "opencode session ses_7kq2"]])
  const decided = (path: string, over: Partial<FootprintInput> = {}) => {
    const found = classify(path, input({ sessions, ...over }))
    return found.kept ? `kept ${found.basis}` : `out ${found.rule} ${found.group} (${found.why})`
  }
  assert.equal(decided(`/h/.memory/sections/claude/app/${theirs.toUpperCase()}/m1-m20.md`), `out other-session /h/.memory/sections/claude/app/${theirs.toUpperCase()} (claude session 8f2c1a90, by its id)`)
  assert.equal(decided(`/h/.memory/anchors/claude-${theirs}.json`), "out other-session /h/.memory/anchors (claude session 8f2c1a90, by its id)")
  assert.equal(decided("/private/tmp/ses_7kq2.log"), "out other-session /private/tmp (opencode session ses_7kq2, by its id)")
  // An id no session has, or one inside a longer name, says nothing.
  assert.equal(decided("/h/.memory/sections/claude/app/0a1b2c3d-0000-4000-8000-000000000000/m1.md"), "kept window")
  assert.equal(decided("/private/tmp/ses_7kq2x.log"), "kept window")
  // The turn's own word wins: it named the folder the tool writes in.
  const turn: TurnEvidence = { ...none, named: new Map([["/h/.memory", "write"]]) }
  assert.equal(decided(`/h/.memory/anchors/claude-${theirs}.json`, { turn }), "kept folder")
})

test("where the platform names writers, the writer decides before any name", () => {
  const writers = new Map([["/h/.config/a.json", [7]], ["/h/.config/b.json", [9]]])
  const ours = (pid: number) => pid === 7
  const turn: TurnEvidence = { ...none, named: new Map([["/h/.config/b.json", "write"]]) }
  assert.equal(outcome("/h/.config/a.json", { writers, ours }), "kept writer")
  assert.equal(outcome("/h/.config/b.json", { writers, ours, turn }), "out other-writer")
  // A path with no writer named falls through to the other rules.
  assert.equal(outcome("/h/.config/c.json", { writers, ours }), "kept window")
})

test("a history read leaves out only the folders no evidence of the turn can win back", () => {
  const folders: RuleFolder[] = [
    { folder: "/h/work/app", rule: "tracked", why: "" },
    { folder: "/h/.claude", rule: "store", why: "" },
    { folder: "/h/other", rule: "other-session", why: "" },
    { folder: "/h/api", rule: "other-session", why: "" },
    { folder: "/h/.sync/index", rule: "baseline", why: "" },
    { folder: "/h/Library", rule: "noise", why: "" },
  ]
  const left = (turn: TurnEvidence, writers = false) => readIgnore(folders, turn, writers).map((item) => item.folder)
  assert.deepEqual(left(none), folders.map((item) => item.folder))
  // A name inside a folder, or a folder the turn ran above, keeps that folder's paths crossing.
  const turn: TurnEvidence = { named: new Map([["/h/other/x.ts", "write"]]), mentioned: new Set(["/h/Library/Preferences/tool.plist"]), cwds: new Set(["/h/.sync"]) }
  assert.deepEqual(left(turn), ["/h/work/app", "/h/.claude", "/h/api"])
  // A writer can win a path back from any folder but a checkout or a store.
  assert.deepEqual(left(none, true), ["/h/work/app", "/h/.claude"])
  // A folder inside one whose rule comes first is not sent, so its paths are counted under the rule that decides them; a checkout inside another session's folder still is.
  const nested: RuleFolder[] = [
    { folder: "/h/proj/mine", rule: "tracked", why: "" },
    { folder: "/h/proj", rule: "other-session", why: "" },
    { folder: "/h/proj/pkg/dist", rule: "baseline", why: "" },
    { folder: "/h/.claude", rule: "store", why: "" },
    { folder: "/h/.claude/projects", rule: "noise", why: "" },
  ]
  assert.deepEqual(readIgnore(nested, none, false).map((item) => item.folder), ["/h/proj/mine", "/h/proj", "/h/.claude"])
})

/** The baseline's rows in memory, as the journal keeps them. */
class MemoryNoise implements NoiseStore {
  readonly rows = new Map<string, NoiseRow>()
  noise(): NoiseRow[] {
    return [...this.rows.values()]
  }
  saveNoise(rows: readonly NoiseRow[]): void {
    for (const row of rows) this.rows.set(row.key, { ...row })
  }
  dropNoise(keys: readonly string[]): void {
    for (const key of keys) this.rows.delete(key)
  }
}

test("a template turns ids, hashes and numbers into stars, and leaves words", () => {
  assert.equal(template("/tmp/claude-1f2e-cwd"), "/tmp/claude-*-cwd")
  assert.equal(template("/h/.sync/7c9e6679-7425-40de-944b-e07fc1f90ae7.json"), "/h/.sync/*.json")
  assert.equal(template("/h/.cache/9b0c41d2/log.2.txt"), "/h/.cache/*/log.*.txt")
  assert.equal(template("/h/cafe/beef/face.txt"), "/h/cafe/beef/face.txt")
})

test("the baseline learns what changes while no Thread runs, folder by folder, and forgets it", () => {
  const store = new MemoryNoise()
  const clock = new FakeClock()
  const halfLifeMs = 3_600_000
  const baseline = new NoiseBaseline(store, { roots: ROOTS, now: () => clock.now(), halfLifeMs })
  // A folder is a key only two levels or more below a root.
  assert.deepEqual(baseline.keys("/h/.sync/index/a.db"), { template: "/h/.sync/index/a.db", folder: "/h/.sync/index" })
  assert.equal(baseline.keys("/h/.sync/a.db").folder, undefined)
  assert.equal(baseline.keys("/h/notes.txt").folder, undefined)

  baseline.idle(["/h/.sync/index/a.db", "/h/.daemon-state.json"])
  assert.match(baseline.verdict("/h/.sync/index/a.db")?.why ?? "", /no Thread ran/)
  assert.ok(baseline.verdict("/h/.daemon-state.json"))
  // One window teaches a file, not its folder.
  assert.equal(baseline.verdict("/h/.sync/index/b.db"), undefined)
  assert.deepEqual(baseline.folders(), [])
  clock.advance(60_000)
  baseline.idle(["/h/.sync/index/c.db"])
  assert.equal(baseline.verdict("/h/.sync/index/b.db")?.key, "/h/.sync/index/")
  assert.deepEqual(baseline.folders(), ["/h/.sync/index"])

  // What stops changing decays below its threshold, then is forgotten at the next learning.
  clock.advance(2 * halfLifeMs)
  assert.equal(baseline.verdict("/h/.daemon-state.json"), undefined)
  assert.deepEqual(baseline.folders(), [])
  clock.advance(4 * halfLifeMs)
  baseline.idle(["/h/.other/x"])
  assert.deepEqual([...store.rows.keys()], ["/h/.other/x"])

  // Rows outlive the process.
  assert.ok(new NoiseBaseline(store, { roots: ROOTS, now: () => clock.now(), halfLifeMs }).verdict("/h/.other/x"))
})

test("a folder whose subfolders churn while no Thread runs is churn as a whole, but not a root's own folders", () => {
  const clock = new FakeClock()
  const baseline = new NoiseBaseline(new MemoryNoise(), { roots: ROOTS, now: () => clock.now() })
  // A sync tool rewrites one project's sections, then others'.
  baseline.idle(["/h/.sync/sections/claude/ky/a1/m1.md", "/h/.sync/sections/claude/notes/b2/m1.md"])
  clock.advance(60_000)
  baseline.idle(["/h/.sync/sections/claude/ky/a3/m2.md"])
  assert.equal(baseline.verdict("/h/.sync/sections/claude/mako/c4/m1.md"), undefined, "two subfolders are not enough")
  clock.advance(60_000)
  baseline.idle(["/h/.sync/sections/claude/clamp/d5/m1.md"])
  clock.advance(60_000)
  assert.match(baseline.verdict("/h/.sync/sections/claude/mako/c4/m1.md")?.why ?? "", /3 of its folders changed while no Thread ran/)
  assert.ok(baseline.folders().includes("/h/.sync/sections/claude"))
  // Folders a root holds directly never become churn whole: `/h/work` is where projects are.
  const projects = new NoiseBaseline(new MemoryNoise(), { roots: ROOTS, now: () => clock.now() })
  for (let window = 0; window < 3; window++) projects.idle(["/h/work/a/x/f", "/h/work/b/x/f", "/h/work/c/x/f", "/h/work/d/x/f"])
  assert.equal(projects.verdict("/h/work/new/x/f"), undefined)
  assert.ok(!projects.folders().includes("/h/work"))
})

test("a path left weak in turns of three different Threads is churn; one Thread's repeats are not", () => {
  const baseline = new NoiseBaseline(new MemoryNoise(), { roots: ROOTS, now: () => 1 })
  for (let turn = 0; turn < 5; turn++) baseline.weak("T1", ["/h/.tool/state/x.json"])
  baseline.weak("T2", ["/h/.tool/state/x.json"])
  assert.equal(baseline.verdict("/h/.tool/state/x.json"), undefined)
  baseline.weak("T3", ["/h/.tool/state/x.json"])
  assert.match(baseline.verdict("/h/.tool/state/x.json")?.why ?? "", /3 Threads/)
})

test("the baseline keeps at most its cap of rows, dropping the weakest", () => {
  const store = new MemoryNoise()
  const baseline = new NoiseBaseline(store, { roots: ROOTS, now: () => 1, maxRows: 3 })
  baseline.idle(["/h/.a/strong"])
  baseline.idle(["/h/.a/strong"])
  baseline.idle(["/h/.b/one", "/h/.c/two", "/h/.d/three"])
  assert.equal(baseline.size, 3)
  assert.ok(store.rows.has("/h/.a/strong"))
})

const described = (verdict: PathVerdict | undefined) => (!verdict ? "not read" : "rule" in verdict ? `out ${verdict.rule}` : `kept ${verdict.kept}`)

/** A tracker on fakes with a footprint over `/h` and `/private/tmp`, and the verdicts its reads gave. */
async function footprintWorld() {
  const clock = new FakeClock()
  const events = new FakeEventSource()
  const fs = new FakeFileSystem(clock, events)
  const storage = mkdtempSync(join(tmpdir(), "mako-footprint-test-"))
  const verdicts = new Map<string, PathVerdict>()
  const tracker = await LaptopTracker.open(
    { fs, events, clock, storage, device: "test" },
    {
      footprint: {
        home: HOME,
        roots: ROOTS,
        stores: () => ["/h/.harness"],
        others: () => [{ folder: "/h/other", why: "codex session 9f2c" }],
        explain: (_turn, path, verdict) => verdicts.set(path, verdict),
      },
    },
  )
  const reader = tracker.footprints!
  const mark = (thread: string, over: Partial<ActivityMark> & Pick<ActivityMark, "kind" | "id" | "edge">): ActivityMark => ({ thread, session: `S-${thread}`, at: clock.now(), ...over })
  const close = async () => {
    await tracker.close()
    rmSync(storage, { recursive: true, force: true })
  }
  return { clock, fs, events, tracker, reader, verdicts, mark, close }
}

test("a turn's footprint on a busy machine: churn learned while idle, other sessions, stores and other Threads left out, with why", async () => {
  const world = await footprintWorld()
  const { clock, fs, tracker, reader, verdicts, mark } = world
  try {
    // Nothing runs: a sync daemon's index changes twice, so its folder is learned.
    fs.write("/h/.sync/index/a1.db", "x")
    clock.advance(30_000)
    await reader.sampleIdleNow()
    fs.write("/h/.sync/index/b2.db", "x")
    clock.advance(30_000)
    await reader.sampleIdleNow()
    assert.deepEqual(reader.baseline.folders(), ["/h/.sync/index"])

    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/work/app" }))
    reader.activity(mark("T2", { kind: "turn", id: "u1", edge: "start" }))
    // Idle sampling stops while any turn runs.
    assert.equal(await reader.sampleIdleNow(), 0)
    // T2's start cut a segment; its read follows within a round trip to the child, before the turn's writes.
    await reader.settled()
    // Naming a file in another session's folder keeps that folder's paths crossing, each decided by rule.
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "start", turn: "t1", named: ["/h/.config/tool", "/h/other/shared.txt"] }))
    reader.activity(mark("T2", { kind: "call", id: "d1", edge: "start", turn: "u1", named: ["/h/shared"] }))
    fs.write("/h/.config/tool/state.json", "{}")
    fs.write("/h/.sync/index/c3.db", "x")
    fs.write("/h/other/b.ts", "x")
    fs.write("/h/.harness/s.jsonl", "{}")
    fs.write("/h/shared/out.json", "{}")
    fs.write("/h/notes.txt", "a note another app wrote")
    fs.write("/private/tmp/scratch-1.txt", "x")
    fs.remove("/private/tmp/scratch-1.txt")
    // Weak paths fill the cap in path order, so these come after the note and the scratch file.
    for (let index = 0; index < MAX_WEAK + 5; index++) fs.write(`/private/tmp/zz/many/f${index}.txt`, "x")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "end", turn: "t1" }))
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()

    const verdict = (path: string) => described(verdicts.get(path))
    assert.equal(verdict("/h/.config/tool/state.json"), "kept folder")
    assert.equal(verdict("/h/shared/out.json"), "out other-thread")
    assert.equal(verdict("/h/notes.txt"), "kept window")
    assert.equal(verdict("/private/tmp/scratch-1.txt"), "out gone")
    // Rule folders no evidence can win back never cross from the history: only counted.
    assert.equal(verdict("/h/.harness/s.jsonl"), "not read")
    assert.equal(verdict("/h/.sync/index/c3.db"), "not read")
    assert.equal(verdict("/h/other/b.ts"), "out other-session")

    const [summary] = tracker.footprintTurns("T1")
    assert.ok(summary)
    assert.deepEqual(summary.kept, { strong: 1, weak: MAX_WEAK })
    assert.equal(summary.excluded.store, 1)
    assert.equal(summary.excluded.baseline, 1)
    assert.equal(summary.excluded["other-session"], 1)
    assert.equal(summary.excluded["other-thread"], 1)
    assert.equal(summary.excluded.gone, 1)
    assert.equal(summary.excluded.capped, 6)
    assert.equal(summary.ignored, 2)
    assert.ok(summary.groups.some((group) => group.rule === "other-session" && group.why === "codex session 9f2c"))
    const entries = tracker.footprint("T1")
    assert.equal(entries.filter((entry) => entry.evidence === "strong").length, 1)
    assert.equal(entries.filter((entry) => entry.evidence === "weak").length, MAX_WEAK)
  } finally {
    await world.close()
  }
})

test("a change between a segment's cut and its read reaches the turn that just started, and is kept once by the one running on", async () => {
  const world = await footprintWorld()
  const { fs, tracker, reader, mark } = world
  try {
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start" }))
    reader.activity(mark("T2", { kind: "turn", id: "u1", edge: "start" }))
    // Written before the read of the segment T2's start ended: both of T1's reads hear it.
    fs.write("/h/.config/early.json", "{}")
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    reader.activity(mark("T2", { kind: "turn", id: "u1", edge: "end" }))
    await reader.settled()
    assert.deepEqual(tracker.footprint("T1").map((entry) => entry.path), ["/h/.config/early.json"])
    assert.deepEqual(tracker.footprint("T2").map((entry) => entry.path), ["/h/.config/early.json"])
  } finally {
    await world.close()
  }
})

test("a path a call names through a link is the path the history reports", async () => {
  const clock = new FakeClock()
  const events = new FakeEventSource()
  const fs = new FakeFileSystem(clock, events)
  const storage = mkdtempSync(join(tmpdir(), "mako-footprint-test-"))
  const verdicts = new Map<string, PathVerdict>()
  const tracker = await LaptopTracker.open(
    { fs, events, clock, storage, device: "test" },
    { footprint: { home: HOME, roots: ROOTS, stores: () => [], links: [["/tmp", "/private/tmp"]], explain: (_turn, path, verdict) => verdicts.set(path, verdict) } },
  )
  try {
    const turn = { thread: "T1", session: "S1" }
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "start", at: clock.now(), cwd: "/tmp/scratch" })
    tracker.activity({ ...turn, kind: "call", id: "c1", edge: "start", at: clock.now(), turn: "t1", named: ["/tmp/out.txt"] })
    fs.write("/private/tmp/out.txt", "x")
    fs.write("/private/tmp/scratch/build.log", "x")
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "end", at: clock.now() })
    await tracker.settled()
    assert.equal(described(verdicts.get("/private/tmp/out.txt")), "kept named")
    assert.equal(described(verdicts.get("/private/tmp/scratch/build.log")), "kept cwd")
    assert.deepEqual(tracker.footprint("T1").map((entry) => entry.path).sort(), ["/private/tmp/out.txt", "/private/tmp/scratch/build.log"])
  } finally {
    await tracker.close()
    rmSync(storage, { recursive: true, force: true })
  }
})

test("a temporary folder watched live gives the turn its paths without a history read, and a broken watch says the footprint is incomplete", async () => {
  // A source with no history for the temporary folder, as on Linux: only the live watch can see it.
  class NoTemporaryHistory extends FakeEventSource {
    reads = 0
    override async since(mark: string, root: string, options?: { ignore?: readonly string[] }) {
      if (root === "/private/tmp") {
        this.reads++
        return null
      }
      return super.since(mark, root, options)
    }
  }
  const clock = new FakeClock()
  const events = new NoTemporaryHistory()
  const fs = new FakeFileSystem(clock, events)
  const storage = mkdtempSync(join(tmpdir(), "mako-footprint-test-"))
  const verdicts = new Map<string, PathVerdict>()
  const tracker = await LaptopTracker.open(
    { fs, events, clock, storage, device: "test" },
    { footprint: { home: HOME, roots: ROOTS, live: ["/private/tmp"], stores: () => ["/private/tmp/mako-history"], explain: (_turn, path, verdict) => verdicts.set(path, verdict) } },
  )
  try {
    await tracker.settled()
    clock.advance(1_000)
    const turn = { thread: "T1", session: "S1" }
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "start", at: clock.now() })
    clock.advance(100)
    tracker.activity({ ...turn, kind: "call", id: "c1", edge: "start", at: clock.now(), turn: "t1", named: ["/private/tmp/probe/run.sh"] })
    fs.write("/private/tmp/probe/run.sh", "echo")
    fs.write("/private/tmp/probe/out.txt", "x")
    fs.write("/private/tmp/mako-history/123-abc", "1 2")
    clock.advance(100)
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "end", at: clock.now() })
    await tracker.settled()
    assert.equal(described(verdicts.get("/private/tmp/probe/run.sh")), "kept named")
    assert.equal(described(verdicts.get("/private/tmp/probe/out.txt")), "kept window")
    assert.equal(verdicts.has("/private/tmp/mako-history/123-abc"), false, "the watcher child's own marks never cross")
    assert.equal(events.reads, 0, "no history read of the live folder")
    assert.equal(tracker.footprintTurns("T1")[0]?.complete, true)

    // Events dropped mid-turn: the live watch can't vouch for the turn, and there's no history to fall back on.
    clock.advance(1_000)
    tracker.activity({ ...turn, kind: "turn", id: "t2", edge: "start", at: clock.now() })
    clock.advance(100)
    events.drop()
    fs.write("/private/tmp/probe/lost.txt", "x")
    events.restore()
    clock.advance(100)
    tracker.activity({ ...turn, kind: "turn", id: "t2", edge: "end", at: clock.now() })
    await tracker.settled()
    assert.ok(events.reads > 0, "the history was asked")
    const second = tracker.footprintTurns("T1").find((item) => item.turn === "t2")
    assert.equal(second?.complete, false)
  } finally {
    await tracker.close()
    rmSync(storage, { recursive: true, force: true })
  }
})

test("where the platform names writers, a Thread's own process keeps a path no call named", async () => {
  const clock = new FakeClock()
  const events = new FakeEventSource()
  const fs = new FakeFileSystem(clock, events)
  const storage = mkdtempSync(join(tmpdir(), "mako-footprint-test-"))
  const verdicts = new Map<string, PathVerdict>()
  const tracker = await LaptopTracker.open(
    { fs, events, clock, storage, device: "test", processes: { session: (pid) => (pid === 7 ? "S1" : undefined) } },
    { footprint: { home: HOME, roots: ROOTS, stores: () => [], explain: (_turn, path, verdict) => verdicts.set(path, verdict) } },
  )
  try {
    const turn = { thread: "T1", session: "S1" }
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "start", at: clock.now() })
    fs.write("/h/.config/mine.json", "{}")
    events.changed("/h/.config/mine.json", 7)
    fs.write("/h/.config/theirs.json", "{}")
    events.changed("/h/.config/theirs.json", 9)
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "end", at: clock.now() })
    await tracker.settled()
    assert.equal(described(verdicts.get("/h/.config/mine.json")), "kept writer")
    assert.equal(described(verdicts.get("/h/.config/theirs.json")), "out other-writer")
  } finally {
    await tracker.close()
    rmSync(storage, { recursive: true, force: true })
  }
})

test("the watcher child's history read leaves folders out and counts them (macOS)", { skip: process.platform !== "darwin" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-footprint-history-")))
  const history = childHistory()
  try {
    const mark = await history.mark()
    mkdirSync(join(root, "churn/deep"), { recursive: true })
    mkdirSync(join(root, "kept"))
    for (let index = 0; index < 5; index++) writeFileSync(join(root, "churn/deep", `f${index}`), "x")
    writeFileSync(join(root, "kept/a.txt"), "x")
    await new Promise((done) => setTimeout(done, 1_000))
    const found = await history.since(mark, [root], { ignore: [join(root, "churn"), join(root, "nothing-here")] })
    assert.ok(found.paths.includes(join(root, "kept/a.txt")), "a path outside every ignore folder crosses")
    assert.ok(!found.paths.some((path) => path.startsWith(join(root, "churn"))), "nothing under an ignore folder crosses")
    assert.ok(found.ignored[0]! >= 5, `the ignore folder counts its paths (${found.ignored[0]})`)
    assert.equal(found.ignored[1], 0)
    assert.deepEqual(found.lost, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
