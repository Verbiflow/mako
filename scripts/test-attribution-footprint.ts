import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ActivityMark, HistorySince } from "@mako/protocol"
import { FakeClock, FakeEventSource, FakeFileSystem } from "@mako/protocol/attribution-conformance"
import { classify, type FootprintInput, type RuleFolder, type TurnEvidence } from "@mako/host/attribution/footprint"
import type { PathVerdict } from "@mako/host/attribution/footprint-reader"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { otherAppsData } from "@mako/host/base/other-apps-data"
import { otherAppsTemporary } from "@mako/host/attribution/footprint-reader"
import { childHistory } from "@mako/host/workspaces/watch-backend"
import { WatchReadings } from "@mako/host/workspaces/watch-readings"

/*
 * The footprint outside the checkouts: each rule in its order, and turns
 * read end to end through the tracker on fakes: the history read only under
 * what a turn named, mentioned or ran in, and never anywhere else. On
 * macOS, the watcher child's history read leaves folders out and counts them.
 */

const HOME = "/h"
const ROOTS = [HOME, "/private/tmp"]
const none: TurnEvidence = { named: new Map(), mentioned: new Set(), cwds: new Set() }

function input(over: Partial<FootprintInput> = {}): FootprintInput {
  const folders: RuleFolder[] = [
    { folder: "/h/work/app", rule: "tracked", why: "a tracked checkout" },
    { folder: "/h/.claude", rule: "store", why: "a harness's store" },
    { folder: "/h/other", rule: "other-session", why: "codex session 9f2c" },
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
    // What only the turn's window links to it is `window`: the reader counts it and keeps no row.
    ["/h/.sync/index/1.db", "kept window"],
    ["/h/notes.txt", "kept window"],
    // The temporary root is no `tmp` folder: only folders below it count.
    ["/private/tmp/tool-out/run.txt", "kept window"],
    ["/private/tmp/build/node_modules/p/index.js", "out noise"],
  ]
  for (const [path, expected] of cases) assert.equal(outcome(path, { turn, others }), expected, path)
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

const described = (verdict: PathVerdict | undefined) => (!verdict ? "not read" : "rule" in verdict ? `out ${verdict.rule}` : `kept ${verdict.kept}`)

/** An event source that remembers every history read, and can fail the reads under a folder. */
class CountedEvents extends FakeEventSource {
  readonly reads: { mark: string; root: string }[] = []
  readonly broken = new Set<string>()
  override async since(mark: string, root: string, options?: { ignore?: readonly string[] }): Promise<HistorySince | null> {
    this.reads.push({ mark, root })
    if (this.broken.has(root)) return null
    return super.since(mark, root, options)
  }
}

/** A tracker on fakes with a footprint whose containers are `/h` and `/private/tmp`, the history reads it made and the verdicts they gave. */
async function footprintWorld(over: { segmentMs?: number } = {}) {
  const clock = new FakeClock()
  const events = new CountedEvents()
  const fs = new FakeFileSystem(clock, events)
  const storage = mkdtempSync(join(tmpdir(), "mako-footprint-test-"))
  const verdicts = new Map<string, PathVerdict>()
  const tracker = await LaptopTracker.open(
    { fs, events, clock, storage, device: "test" },
    {
      footprint: {
        home: HOME,
        roots: ROOTS,
        stores: () => ["/h/.harness", "/h/proj/.store"],
        others: () => [{ folder: "/h/proj/other", why: "codex session 9f2c" }],
        explain: (_turn, path, verdict) => verdicts.set(path, verdict),
        ...over,
      },
    },
  )
  const reader = tracker.footprints!
  const mark = (thread: string, over: Partial<ActivityMark> & Pick<ActivityMark, "kind" | "id" | "edge">): ActivityMark => ({ thread, session: `S-${thread}`, at: clock.now(), ...over })
  const close = async () => {
    await tracker.close()
    rmSync(storage, { recursive: true, force: true })
  }
  /** The folders whose history was read, each once, in order. */
  const readRoots = () => [...new Set(events.reads.map((read) => read.root))].sort()
  return { clock, fs, events, tracker, reader, verdicts, mark, close, readRoots }
}

test("a turn with no claims outside its checkout reads no history, whatever else the machine changes", async () => {
  const world = await footprintWorld()
  const { clock, fs, events, tracker, reader, verdicts, mark } = world
  try {
    fs.write("/h/work/app/a.ts", "one")
    await tracker.track({ id: "app", path: "/h/work/app", kind: "attached" })
    await tracker.settled()
    events.reads.length = 0
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/work/app" }))
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "start", turn: "t1", cwd: "/h/work/app", named: ["/h/work/app/a.ts"] }))
    fs.write("/h/work/app/a.ts", "two")
    fs.write("/h/notes.txt", "a note another app wrote")
    fs.write("/h/.sync/index/c3.db", "x")
    fs.write("/h/Library/Caches/tool/x", "x")
    fs.write("/private/tmp/scratch-1.txt", "x")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "end", turn: "t1" }))
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    assert.deepEqual(events.reads, [], "no history read")
    assert.equal(verdicts.size, 0)
    assert.deepEqual(tracker.footprint("T1"), [])
    const [summary] = tracker.footprintTurns("T1")
    assert.ok(summary, "the turn's summary is still saved")
    assert.equal(summary.read, 0)
    assert.equal(summary.complete, true)
    assert.deepEqual(summary.kept, { strong: 0, weak: 0 })
    assert.deepEqual(summary.excluded, {})
  } finally {
    await world.close()
  }
})

test("a named file changed during the turn is kept as written and one it only read as read, with no history read", async () => {
  const world = await footprintWorld()
  const { clock, fs, events, tracker, reader, mark } = world
  try {
    fs.write("/h/docs/read.md", "notes")
    fs.write("/h/docs/beside.md", "never named")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start" }))
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "start", turn: "t1", named: ["/h/docs/read.md", "/private/tmp/out.txt", "/private/tmp/never-made.txt"] }))
    clock.advance(100)
    fs.write("/private/tmp/out.txt", "made")
    // Changed beside a named file, in a folder nothing claimed: not the turn's.
    fs.write("/h/docs/beside.md", "changed by another app")
    clock.advance(100)
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "end", turn: "t1" }))
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    assert.deepEqual(events.reads, [], "a file's own times say whether it changed")
    const kept = tracker.footprint("T1").map((entry) => ({ path: entry.path, access: entry.access, basis: entry.basis, evidence: entry.evidence, size: entry.size })).sort((a, b) => a.path.localeCompare(b.path))
    assert.deepEqual(kept, [
      { path: "/h/docs/read.md", access: "read", basis: "named", evidence: "strong", size: undefined },
      { path: "/private/tmp/out.txt", access: "write", basis: "named", evidence: "strong", size: 4 },
    ])
    assert.ok(tracker.footprint("T1").find((entry) => entry.path === "/private/tmp/out.txt")?.ref, "what it wrote is addressed, to be carried")
  } finally {
    await world.close()
  }
})

test("a folder the turn ran in, outside every checkout, has its changed files kept, read only from that folder's history", async () => {
  const world = await footprintWorld()
  const { clock, fs, events, tracker, reader, verdicts, mark } = world
  try {
    fs.write("/h/scratch/seed.txt", "x")
    fs.write("/h/scratch/untouched.txt", "x")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/scratch" }))
    fs.write("/h/scratch/build/out.o", "obj")
    fs.remove("/h/scratch/seed.txt")
    // The rest of the home folder and the temporary folder churn all along.
    fs.write("/h/notes.txt", "a note another app wrote")
    fs.write("/h/.sync/index/c3.db", "x")
    for (let index = 0; index < 300; index++) fs.write(`/private/tmp/zz/many/f${index}.txt`, "x")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    assert.deepEqual(events.reads.map((read) => read.root), ["/h/scratch"])
    assert.equal(described(verdicts.get("/h/scratch/build/out.o")), "kept cwd")
    assert.equal(described(verdicts.get("/h/notes.txt")), "not read")
    assert.equal(described(verdicts.get("/private/tmp/zz/many/f0.txt")), "not read")
    const kept = tracker.footprint("T1").map((entry) => ({ path: entry.path, access: entry.access, basis: entry.basis, evidence: entry.evidence, size: entry.size }))
    // A file removed in the folder is the turn's write too, with nothing left to carry.
    assert.deepEqual(kept.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: "/h/scratch/build/out.o", access: "write", basis: "cwd", evidence: "strong", size: 3 },
      { path: "/h/scratch/seed.txt", access: "write", basis: "cwd", evidence: "strong", size: undefined },
    ])
    const [summary] = tracker.footprintTurns("T1")
    assert.equal(summary?.read, 2)
    assert.deepEqual(summary?.kept, { strong: 2, weak: 0 })
    assert.deepEqual(summary?.bases, { cwd: 2 })
    assert.deepEqual(summary?.excluded, {})
  } finally {
    await world.close()
  }
})

test("what a claim folder holds is decided by rule: checkouts and stores inside it never cross, other sessions and Threads are left out with why", async () => {
  const world = await footprintWorld()
  const { clock, fs, tracker, reader, verdicts, mark } = world
  try {
    fs.write("/h/proj/app/src/a.ts", "one")
    await tracker.track({ id: "app", path: "/h/proj/app", kind: "attached" })
    await tracker.settled()
    world.events.reads.length = 0
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/proj" }))
    reader.activity(mark("T2", { kind: "turn", id: "u1", edge: "start" }))
    // A folder named inside the folder the turn runs in is read with it, not again.
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "start", turn: "t1", named: ["/h/.config/tool", "/h/proj/gen", "/h/elsewhere/shared.txt"] }))
    reader.activity(mark("T2", { kind: "call", id: "d1", edge: "start", turn: "u1", named: ["/h/proj/shared"] }))
    fs.write("/h/.config/tool/state.json", "{}")
    fs.write("/h/elsewhere/shared.txt", "x")
    fs.write("/h/proj/build/out.o", "x")
    fs.write("/h/proj/gen/x.ts", "x")
    fs.write("/h/proj/app/src/a.ts", "two")
    fs.write("/h/proj/.store/s.jsonl", "{}")
    fs.write("/h/proj/other/b.ts", "x")
    fs.write("/h/proj/shared/out.json", "{}")
    fs.write("/h/proj/state.db-wal", "x")
    fs.write("/h/.harness/s.jsonl", "{}")
    fs.write("/h/notes.txt", "a note another app wrote")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "end", turn: "t1" }))
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()

    assert.deepEqual(world.readRoots().filter((root) => root !== "/h/proj/app"), ["/h/.config/tool", "/h/proj"])
    const verdict = (path: string) => described(verdicts.get(path))
    assert.equal(verdict("/h/.config/tool/state.json"), "kept folder")
    assert.equal(verdict("/h/elsewhere/shared.txt"), "kept named")
    assert.equal(verdict("/h/proj/build/out.o"), "kept cwd")
    assert.equal(verdict("/h/proj/gen/x.ts"), "kept folder")
    assert.equal(verdict("/h/proj/other/b.ts"), "out other-session")
    assert.equal(verdict("/h/proj/shared/out.json"), "out other-thread")
    assert.equal(verdict("/h/proj/state.db-wal"), "out bookkeeping")
    // A checkout and a store inside the folder never cross from the history: only counted.
    assert.equal(verdict("/h/proj/app/src/a.ts"), "not read")
    assert.equal(verdict("/h/proj/.store/s.jsonl"), "not read")
    assert.equal(verdict("/h/.harness/s.jsonl"), "not read")
    assert.equal(verdict("/h/notes.txt"), "not read")

    const [summary] = tracker.footprintTurns("T1")
    assert.ok(summary)
    assert.deepEqual(summary.kept, { strong: 4, weak: 0 })
    assert.deepEqual(summary.excluded, { tracked: 1, store: 1, "other-session": 1, "other-thread": 1, bookkeeping: 1 })
    assert.equal(summary.ignored, 2)
    assert.ok(summary.groups.some((group) => group.rule === "other-session" && group.why === "codex session 9f2c"))
    const entries = tracker.footprint("T1")
    assert.equal(entries.length, 4)
    assert.ok(entries.every((entry) => entry.evidence === "strong"))
  } finally {
    await world.close()
  }
})

test("a folder first claimed late in a long turn still gets changes from before the claim, and a folder read once goes on from where that read stood", async () => {
  // Segments of 25 ms, so the turn's folders are read while it runs.
  const world = await footprintWorld({ segmentMs: 25 })
  const { clock, fs, events, tracker, reader, mark } = world
  try {
    fs.write("/h/one/seed.txt", "x")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/one" }))
    fs.write("/h/one/a1.txt", "x")
    // Written in a folder the turn has not claimed yet.
    fs.write("/h/late/b0.txt", "x")
    while (!events.reads.length) await new Promise((done) => setTimeout(done, 5))
    await reader.settled()
    assert.ok(events.reads.every((read) => read.root === "/h/one"), "only the claimed folder is read so far")
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "start", turn: "t1", cwd: "/h/late" }))
    fs.write("/h/one/a2.txt", "x")
    fs.write("/h/late/b1.txt", "x")
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    assert.deepEqual(tracker.footprint("T1").map((entry) => entry.path).sort(), ["/h/late/b0.txt", "/h/late/b1.txt", "/h/one/a1.txt", "/h/one/a2.txt"])
    const of = (root: string) => events.reads.filter((read) => read.root === root).map((read) => Number(read.mark))
    const [started] = of("/h/one")
    assert.equal(of("/h/late")[0], started, "the late folder is read from the turn's start")
    assert.ok(of("/h/one").at(-1)! > started!, "the first folder's last read starts after its first")
    assert.deepEqual(of("/h/one"), [...of("/h/one")].sort((a, b) => a - b), "and never goes back")
    assert.equal(tracker.footprintTurns("T1")[0]?.complete, true)
  } finally {
    await world.close()
  }
})

test("a history read that fails, or one that lost events, says the footprint is incomplete", async () => {
  const world = await footprintWorld()
  const { clock, fs, events, tracker, reader, mark } = world
  try {
    fs.write("/h/scratch/seed.txt", "x")
    clock.advance(1_000)
    events.broken.add("/h/scratch")
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/scratch" }))
    fs.write("/h/scratch/out.txt", "x")
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    assert.equal(events.reads.length, 1, "the history was asked")
    assert.equal(tracker.footprintTurns("T1").find((item) => item.turn === "t1")?.complete, false)
    assert.deepEqual(tracker.footprint("T1"), [])

    // Events dropped mid-turn: the history answers, and says it lost some.
    events.broken.clear()
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t2", edge: "start", cwd: "/h/scratch" }))
    events.drop()
    fs.write("/h/scratch/lost.txt", "x")
    events.restore()
    reader.activity(mark("T1", { kind: "turn", id: "t2", edge: "end" }))
    await reader.settled()
    assert.equal(tracker.footprintTurns("T1").find((item) => item.turn === "t2")?.complete, false)

    // A turn after, with nothing lost, is whole again.
    clock.advance(1_000)
    reader.activity(mark("T1", { kind: "turn", id: "t3", edge: "start", cwd: "/h/scratch" }))
    fs.write("/h/scratch/whole.txt", "x")
    reader.activity(mark("T1", { kind: "turn", id: "t3", edge: "end" }))
    await reader.settled()
    assert.equal(tracker.footprintTurns("T1").find((item) => item.turn === "t3")?.complete, true)
  } finally {
    await world.close()
  }
})

test("a wait scoped to a checkout stands behind the footprints of turns that ran there, never another Thread's read", async () => {
  const world = await footprintWorld()
  const { fs, tracker, reader, mark } = world
  try {
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/one" }))
    reader.activity(mark("T2", { kind: "turn", id: "u1", edge: "start", cwd: "/h/two" }))
    fs.write("/h/one/out.json", "{}")
    fs.write("/h/two/out.json", "{}")
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    // T1's footprint is being read; a count or a checkpoint of T2's checkout goes on without it.
    await reader.settled(["/h/two"])
    assert.deepEqual(tracker.footprint("T1"), [], "T1's read is still under way")
    // One of T1's own checkout, or of a folder holding it, waits for it.
    await reader.settled(["/h/one"])
    assert.deepEqual(tracker.footprint("T1").map((entry) => entry.path), ["/h/one/out.json"])
    reader.activity(mark("T2", { kind: "turn", id: "u1", edge: "end" }))
    await reader.settled(["/h"])
    assert.deepEqual(tracker.footprint("T2").map((entry) => entry.path), ["/h/two/out.json"])
  } finally {
    await world.close()
  }
})

test("another app's data is every container, group, daemon container and scripts folder, by case on macOS only", () => {
  assert.equal(otherAppsData("/h/Library/Containers/com.example.notes/Data/a.json", "/h", "darwin"), "/h/Library/Containers/com.example.notes")
  assert.equal(otherAppsData("/h/Library/Group Containers/group.example.chat/db", "/h", "darwin"), "/h/Library/Group Containers/group.example.chat")
  assert.equal(otherAppsData("/h/Library/Daemon Containers/0A1B-2C3D/Data/x", "/h", "darwin"), "/h/Library/Daemon Containers/0A1B-2C3D")
  assert.equal(otherAppsData("/h/Library/Application Scripts/com.example.notes/run.scpt", "/h/", "darwin"), "/h/Library/Application Scripts/com.example.notes")
  assert.equal(otherAppsData("/h/Library/Containers", "/h", "darwin"), "/h/Library/Containers")
  // APFS usually ignores case: an agent's spelling is the same folder, and the answer keeps that spelling.
  assert.equal(otherAppsData("/h/library/containers/com.example.notes/Data/a.json", "/h", "darwin"), "/h/library/containers/com.example.notes")
  assert.equal(otherAppsData("/h/LIBRARY/Group containers/g/x", "/h", "darwin"), "/h/LIBRARY/Group containers/g")
  // Linux's folders tell case apart, and a name that only begins the same is another folder.
  assert.equal(otherAppsData("/h/library/containers/x", "/h", "linux"), undefined)
  assert.equal(otherAppsData("/h/Library/ContainersOld/x", "/h", "darwin"), undefined)
  assert.equal(otherAppsData("/h/Library/Application Support/x", "/h", "darwin"), undefined)
  assert.equal(otherAppsData("/other/Library/Containers/x", "/h", "darwin"), undefined)
})

test("another app's container is never stat-ed or read, even when a call named it: macOS would ask the person each time", async () => {
  const world = await footprintWorld()
  const { fs, tracker, reader, verdicts, mark } = world
  const touched: string[] = []
  const stat = fs.stat.bind(fs)
  const read = fs.read.bind(fs)
  fs.stat = async (path) => (touched.push(path), stat(path))
  fs.read = async (path) => (touched.push(path), read(path))
  try {
    const chat = "/h/Library/Group Containers/group.net.example.chat/Message/db.sqlite"
    const notes = "/h/Library/Containers/com.example.notes/Data/notes.json"
    // APFS usually ignores case, so on macOS a Fin's lowercase spelling is the same container; Linux's folders don't.
    const read1 = process.platform === "darwin" ? "/h/library/containers/com.example.reader/Data/prefs.plist" : "/h/Library/Containers/com.example.reader/Data/prefs.plist"
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/work/app" }))
    await reader.settled()
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "start", turn: "t1", named: [chat, notes, read1, "/h/work/app/a.ts"] }))
    fs.write(chat, "x")
    fs.write(notes, "{}")
    fs.write("/h/work/app/a.ts", "x")
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "end", turn: "t1" }))
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    // A container is no claim: nothing under it is read from the history, so nothing is decided.
    for (const path of [chat, notes, read1]) assert.equal(described(verdicts.get(path)), "not read")
    assert.ok(touched.includes("/h/work/app/a.ts"), "the stats were heard")
    assert.deepEqual(touched.filter((path) => /\/library\//i.test(path)), [])
    assert.deepEqual(tracker.footprint("T1").map((entry) => entry.path), ["/h/work/app/a.ts"])
  } finally {
    await world.close()
  }
})

test("another app's folder in a temporary folder is never claimed, stat-ed or read, though a command listed it", async () => {
  const world = await footprintWorld()
  const { fs, events, tracker, reader, verdicts, mark, readRoots } = world
  const touched: string[] = []
  const stat = fs.stat.bind(fs)
  fs.stat = async (path) => (touched.push(path), stat(path))
  try {
    // An updater stages its app in the temporary folder; a command's output (a listing of it) names that folder.
    const update = "/private/tmp/com.electron.example-notes.ShipIt.Q1w2E3/Example Notes.app/Contents/Resources/app.asar"
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/h/work/app" }))
    await reader.settled()
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "start", turn: "t1", mentioned: ["/private/tmp/com.electron.example-notes.ShipIt.Q1w2E3", "/private/tmp/build-1"] }))
    fs.write(update, "an update another app staged")
    fs.write("/private/tmp/build-1/out.txt", "the turn's own output")
    reader.activity(mark("T1", { kind: "call", id: "c1", edge: "end", turn: "t1" }))
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    assert.deepEqual(touched.filter((path) => path.includes("ShipIt")), [], "another app's folder is never stat-ed")
    assert.deepEqual(readRoots().filter((path) => path.includes("ShipIt")), [], "nor its history read")
    assert.equal(described(verdicts.get(update)), "not read")
    assert.deepEqual(tracker.footprint("T1").map((entry) => entry.path), ["/private/tmp/build-1/out.txt"])
    assert.ok(events.reads.length > 0)
  } finally {
    await world.close()
  }
})

test("a path that can't be read leaves the turn's footprint incomplete, never lost", async () => {
  const world = await footprintWorld()
  const { fs, tracker, reader, mark } = world
  const stat = fs.stat.bind(fs)
  // Electron's Node opened an `.asar` being written as an archive: "Invalid package", and the turn's whole read was lost.
  fs.stat = async (path) => { if (path.endsWith(".asar")) throw new Error(`Invalid package ${path}`); return stat(path) }
  try {
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "start", cwd: "/private/tmp/packaging-1" }))
    await reader.settled()
    fs.write("/private/tmp/packaging-1/App.app/Contents/Resources/app.asar", "half an archive")
    fs.write("/private/tmp/packaging-1/notes.txt", "written by the turn")
    reader.activity(mark("T1", { kind: "turn", id: "t1", edge: "end" }))
    await reader.settled()
    assert.deepEqual(tracker.footprint("T1").map((entry) => entry.path), ["/private/tmp/packaging-1/notes.txt"])
    const [turn] = tracker.footprintTurns("T1")
    assert.equal(turn?.complete, false, "the footprint says a path of it couldn't be read")
  } finally {
    await world.close()
  }
})

test("another app's temporary folder is one named by its bundle id, right under a temporary folder", () => {
  const roots = ["/private/tmp", "/scratch/tmp-root/T"]
  assert.equal(otherAppsTemporary("/scratch/tmp-root/T/com.electron.example.ShipIt.Ab12/App.app/x", roots), "/scratch/tmp-root/T/com.electron.example.ShipIt.Ab12")
  assert.equal(otherAppsTemporary("/private/tmp/com.apple.Safari/cache", roots), "/private/tmp/com.apple.Safari")
  assert.equal(otherAppsTemporary("/private/tmp/mako-environment-Ab12/Mako.app/Contents/Resources/app.asar", roots), undefined)
  assert.equal(otherAppsTemporary("/private/tmp/build/com.example.app/x", roots), undefined, "only right under the temporary folder")
  assert.equal(otherAppsTemporary("/private/tmp/notes.v1.txt", roots), undefined, "a file's name is no bundle id")
  assert.equal(otherAppsTemporary("/h/com.example.app/x", roots), undefined)
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

test("where the platform names writers, a Thread's own process keeps a path no call named, in a folder the turn claimed", async () => {
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
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "start", at: clock.now(), cwd: "/h/.config" })
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

test("Mako's own folders are left out of a history read before they're replayed, unless the read is of one of them (macOS)", { skip: process.platform !== "darwin" }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-footprint-exclude-")))
  const own = join(root, "own")
  const readings = new WatchReadings()
  const history = childHistory(undefined, readings)
  try {
    const mark = await history.mark()
    mkdirSync(join(own, "deep"), { recursive: true })
    mkdirSync(join(root, "kept"))
    for (let index = 0; index < 5; index++) writeFileSync(join(own, "deep", `f${index}`), "x")
    writeFileSync(join(root, "kept/a.txt"), "x")
    await new Promise((done) => setTimeout(done, 1_000))
    const found = await history.since(mark, [root], { ignore: [own], exclude: [own] })
    assert.ok(found.paths.includes(join(root, "kept/a.txt")))
    assert.ok(!found.paths.some((path) => path.startsWith(own)), "nothing under an excluded folder crosses")
    assert.equal(found.ignored[0], 0, "nor is it counted: fseventsd never sent it")
    const inside = await history.since(mark, [own], { exclude: [own, root] })
    assert.ok(inside.paths.includes(join(own, "deep/f0")), "a read of the folder itself, or inside one that holds it, reads it")
    assert.equal(readings.reading().history.readsLastHour, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a history read of the home folder never replays another app's container, so the watcher never stats one (macOS)", { skip: process.platform !== "darwin" }, async () => {
  // A scratch home: the child reads its home from HOME, and the person's own containers are never written.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mako-footprint-home-")))
  const real = process.env.HOME
  process.env.HOME = home
  const history = childHistory()
  try {
    // The child starts with the first call, and keeps the HOME it started with.
    const mark = await history.mark().finally(() => (process.env.HOME = real))
    const container = join(home, "Library/Containers/com.example.notes/Data")
    const group = join(home, "Library/Group Containers/group.example.chat")
    const daemon = join(home, "Library/Daemon Containers/0A1B-2C3D/Data")
    const scripts = join(home, "Library/Application Scripts/com.example.notes")
    for (const folder of [container, group, daemon, scripts]) mkdirSync(folder, { recursive: true })
    writeFileSync(join(daemon, "state.plist"), "x")
    writeFileSync(join(scripts, "run.scpt"), "x")
    mkdirSync(join(home, "work"))
    writeFileSync(join(container, "notes.json"), "{}")
    writeFileSync(join(group, "db.sqlite"), "x")
    writeFileSync(join(home, "work/a.txt"), "x")
    await new Promise((done) => setTimeout(done, 1_000))
    const found = await history.since(mark, [home], {})
    assert.ok(found.paths.includes(join(home, "work/a.txt")), "the rest of the home folder crosses")
    assert.deepEqual(found.paths.filter((path) => path.includes("Containers") || path.includes("Application Scripts")), [], "nothing in another app's data is replayed")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
