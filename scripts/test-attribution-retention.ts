import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { FakeClock, FakeEventSource, FakeFileSystem } from "@mako/protocol/attribution-conformance"
import { inSlices } from "@mako/sessions/slices"
import { TURN_CHANGES_VERSION, type TurnChanges } from "@mako/host/contracts/turn-changes"
import { countTurnInSlices, storedView, threadSummary } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { turnOnlyPair, turnWriters, undoPlan } from "@mako/host/attribution/turn-lines"

/*
 * Retention of the journal's records (`LaptopTracker.prune`), the footprint table's rebuild, the tables that keep
 * when a root last changed (`JournalStore.recency`), and the one read that finds a restored version
 * (`JournalStore.versionWith`). Each journal here is a scratch one over a fake file system.
 */

const DAY = 86_400_000

async function world() {
  const storage = await mkdtemp(join(tmpdir(), "mako-retention-"))
  const clock = new FakeClock(), events = new FakeEventSource(), fs = new FakeFileSystem(clock, events)
  const open = () => LaptopTracker.open({ storage, fs, clock, events, device: "test" })
  const raw = () => new DatabaseSync(join(storage, "journal.sqlite"))
  return { storage, clock, fs, open, raw, close: () => rm(storage, { recursive: true, force: true }) }
}

/** One turn of `thread` in the checkout, with one call that may write: what `write` changes is its, by timing. */
async function turn(tracker: LaptopTracker, clock: FakeClock, thread: string, id: string, write: () => void | Promise<void>): Promise<void> {
  const mark = (kind: "turn" | "call", edge: "start" | "end") =>
    tracker.activity({ kind, id: kind === "turn" ? id : `${id}-call`, edge, at: clock.now(), thread, session: `${thread}-session`, turn: id, checkout: "/work" })
  mark("turn", "start")
  mark("call", "start")
  clock.advance(10)
  await write()
  await tracker.settled()
  clock.advance(10)
  mark("call", "end")
  mark("turn", "end")
  clock.advance(60_000)
}

const summary = (thread: string, id: string, at: number): TurnChanges => ({
  version: TURN_CHANGES_VERSION, state: "settled", thread, turn: id, own: { files: 1, added: 1, removed: 1 }, maybe: { files: 0, added: 0, removed: 0 },
  others: { files: 0, added: 0, removed: 0 }, files: [], more: 0, journal: "test", through: 0, at,
})

test("retention drops what is past the window and keeps what an uncommitted file or a worked Thread needs", async () => {
  const w = await world()
  const tracker = await w.open()
  try {
    const { store } = tracker
    for (const name of ["held", "dead", "live", "person"]) w.fs.write(`/work/${name}.ts`, `${name} one\n${name} two\n`)
    await tracker.track({ id: "work", path: "/work", kind: "workspace" })
    const edit = (name: string, text: string) => async () => {
      w.fs.write(`/work/${name}.ts`, text)
      await tracker.settled()
      w.clock.advance(5)
    }
    const back = (name: string) => async () => {
      await edit(name, `${name} one\nchanged\n`)()
      await edit(name, `${name} one\n${name} two\n`)()
    }
    // Five weeks ago: a Thread that then stopped, one that goes on, and the person.
    await turn(tracker, w.clock, "dead", "dead-turn", async () => {
      await edit("held", "held one\nheld by dead\n")()
      await back("dead")()
    })
    await turn(tracker, w.clock, "live", "live-old", back("live"))
    await back("person")()
    const old = w.clock.now()
    for (const thread of ["dead", "live"]) {
      store.saveTurnChanges(summary(thread, thread === "dead" ? "dead-turn" : "live-old", old), `${thread}-session`)
      store.addFootprint({ thread, session: `${thread}-session`, turn: "t", path: `/outside/${thread}.md`, access: "write", evidence: "strong", basis: "named", at: old, secret: false })
      store.saveFootprintTurn({ thread, session: `${thread}-session`, turn: `${thread}-old`, start: old, end: old, read: 1, ignored: 0, complete: true, kept: { strong: 1, weak: 0 }, bases: {}, excluded: {}, groups: [], ms: { read: 0, classify: 0 } })
      store.saveChoice({ thread, spelling: "notes.md", path: "/work/notes.md", at: old })
    }
    const held = tracker.rootStates().get("work")!.files.get("held.ts")!
    assert.ok(held.base, "the held file is uncommitted, with a base")
    store.saveCommit("work", "old-commit", "dead.ts", old, new Int32Array([1, 2]), "ref-of-no-file")
    store.saveCommit("work", "base-commit", "held.ts", old, new Int32Array([0, 0]), held.base)
    store.closeGap(store.openGap("work", old - 1_000, "dropped"), old)
    const raw = w.raw()
    raw.exec("PRAGMA busy_timeout=5000")
    const weak = raw.prepare("INSERT INTO footprint (thread, session, turn, path, access, evidence, at, secret) VALUES (?, ?, 't', ?, 'write', 'weak', ?, 0)")
    for (const thread of ["dead", "live"]) for (let index = 0; index < 40; index++) weak.run(thread, `${thread}-session`, `/elsewhere/${thread}-${index}`, old)
    raw.prepare("INSERT INTO carried (thread, journal, device, through, at, received, roots) VALUES ('dead', 'other', 'laptop', 1, ?, ?, '[]')").run(old, old)
    raw.prepare("INSERT INTO carried_paths (thread, journal, kind, seq, at, path) VALUES ('dead', 'other', 'write', 1, ?, '/work/dead.ts')").run(old)
    const stat = raw.prepare("INSERT INTO stats (root, path, dev, ino, size, mode, mtime_ns, ctime_ns, checked_ns) VALUES ('gone-root', ?, 1, ?, 1, 1, 1, 1, 1)")
    for (let index = 0; index < 30; index++) stat.run(`file-${index}`, index)
    raw.close()
    const oldEntries = tracker.changes(0)
    const seqsOf = (path: string) => oldEntries.filter((entry) => entry.path === path).map((entry) => entry.seq)
    assert.equal(seqsOf("dead.ts").length, 2)
    assert.equal(seqsOf("held.ts").length, 1)

    w.clock.advance(35 * DAY)
    tracker.sweep()
    await turn(tracker, w.clock, "live", "live-new", back("live"))
    tracker.sweep()
    store.saveCommit("work", "new-commit", "live.ts", w.clock.now(), new Int32Array([3]), "ref-new")
    store.closeGap(store.openGap("work", w.clock.now() - 1_000, "dropped"), w.clock.now())
    store.saveFootprintTurn({ thread: "live", session: "live-session", turn: "live-new", start: w.clock.now(), end: w.clock.now(), read: 1, ignored: 0, complete: true, kept: { strong: 0, weak: 0 }, bases: {}, excluded: {}, groups: [], ms: { read: 0, classify: 0 } })
    assert.equal(store.footprintCompact(), false, "the table is as the migration makes it until retention has swept every Thread")

    // A pass of a few steps drops part, and the next goes on where it stopped.
    const first = await tracker.prune(4)
    const rest = await tracker.prune()
    await tracker.prune()
    const total = (key: keyof typeof first) => first[key] + rest[key]

    const kept = new Set(tracker.changes(0).map((entry) => entry.seq))
    assert.deepEqual(seqsOf("held.ts").filter((seq) => !kept.has(seq)), [], "an uncommitted file's chain stays however old, its Thread gone or not")
    assert.deepEqual(seqsOf("dead.ts").filter((seq) => kept.has(seq)), [], "a stopped Thread's old entries on a clean file go")
    assert.deepEqual(seqsOf("person.ts").filter((seq) => kept.has(seq)), [], "the person's old entries on a clean file go")
    assert.deepEqual(seqsOf("live.ts").filter((seq) => !kept.has(seq)), [], "a worked Thread's entries stay, the old with the new")
    assert.equal(total("entries"), 4)
    const line = tracker.blame("work", "held.ts")?.find((run) => run.entry !== null)
    assert.equal(line?.author && "author" in line.author ? line.author.author.thread : undefined, "dead", "the uncommitted line still names its writer")
    assert.ok(store.hasBlob(held.base) && store.hasBlob(tracker.rootStates().get("work")!.files.get("held.ts")!.current!), "and its contents are kept")

    assert.equal(store.activityOfThread("dead").length, 0, "a stopped Thread's calls and turns go")
    assert.ok(store.turn("live", "live-old"), "a worked Thread's old turn stays")
    assert.deepEqual(store.turnChangesOf("dead"), [])
    assert.deepEqual(store.turnChangesOf("live").map((item) => item.turn), ["live-old"], "an open Thread's old turn keeps its count")
    assert.deepEqual(store.footprint("thread", "dead"), [])
    assert.deepEqual(store.footprint("thread", "live").map((entry) => [entry.path, entry.evidence]), [["/outside/live.md", "strong"]], "weak rows go for every Thread, strong ones stay for a worked one")
    assert.deepEqual(store.footprintTurns("dead"), [])
    assert.deepEqual(store.footprintTurns("live").map((item) => item.turn), ["live-new"], "a turn's footprint summary goes at the window, as it did")
    assert.equal(store.commitAuthors("work", "old-commit", "dead.ts"), undefined, "an old commit's line writers go")
    assert.ok(store.commitAuthors("work", "base-commit", "held.ts"), "those of an uncommitted file's base stay")
    assert.ok(store.commitAuthors("work", "new-commit", "live.ts"))
    assert.equal(store.gaps().length, 1, "an old gap goes, a new one stays")
    assert.equal(store.choices("dead").get("notes.md"), "/work/notes.md", "a person's pick stays")
    assert.deepEqual(store.carriedParts("dead"), [])
    assert.equal(store.statPaths("gone-root").length, 0, "stat rows of a root that isn't tracked go")
    assert.equal(store.statPaths("work").length, 4, "a tracked root's stay")
    assert.equal(total("stats"), 30)
    assert.ok(store.prunedBefore("dead"), "the stopped Thread is noted")
    assert.equal(store.prunedBefore("live"), undefined)

    // What a window reads of the pruned turn: no longer kept, never an error and never "changed nothing".
    const view = storedView(store)
    assert.equal(await countTurnInSlices(view, "dead", "dead-turn", "settled"), undefined, "a pruned turn isn't counted again as empty")
    const span = { path: "/work/dead.ts", root: "work", relative: "dead.ts", entries: { first: seqsOf("dead.ts")[0]!, last: seqsOf("dead.ts")[1]! } }
    assert.equal(turnWriters(view, "dead", "dead-turn", span), undefined)
    assert.equal(turnOnlyPair(view, "dead", "dead-turn", span), undefined)
    assert.doesNotThrow(() => undoPlan(view, "dead", { kind: "turn", requestId: "dead-turn" }, "/work"))
    assert.ok(threadSummary(store, "dead").keptSince !== undefined, "its summary says its records are no longer kept")
    assert.equal(threadSummary(store, "live").keptSince, undefined)
    assert.ok(await countTurnInSlices(view, "live", "live-old", "settled"), "a worked Thread's old turn still counts")

    // The footprint table no longer keeps its key twice, and reads and writes as before.
    assert.equal(store.footprintCompact(), true)
    const check = w.raw()
    assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE tbl_name='footprint' AND type='index'").get()?.count, 0, "no second copy of the key")
    check.close()
    for (const size of [1, 2]) store.addFootprint({ thread: "live", session: "live-session", path: "/outside/again.md", access: "write", evidence: "strong", basis: "named", at: w.clock.now(), size, secret: false })
    assert.deepEqual(store.footprint("thread", "live").filter((entry) => entry.path === "/outside/again.md").map((entry) => entry.size), [2], "one row a key, the later write's")
    assert.deepEqual(await tracker.prune(), { entries: 0, activity: 0, commits: 0, footprint: 0, turns: 0, gaps: 0, stats: 0, threads: 0 }, "a pass with nothing past the window drops nothing")
  } finally {
    await tracker.close()
    await w.close()
  }
})

test("a journal with nothing inside the window keeps its newest entry, so the next is numbered after it by any build", async () => {
  const w = await world()
  let tracker = await w.open()
  try {
    w.fs.write("/work/a.ts", "one\n")
    await tracker.track({ id: "work", path: "/work", kind: "workspace" })
    for (const text of ["two\n", "one\n", "three\n", "one\n"]) {
      w.fs.write("/work/a.ts", text)
      await tracker.settled()
      w.clock.advance(5)
    }
    const newest = tracker.changes(0).at(-1)!.seq
    assert.equal(newest, 4)
    w.clock.advance(40 * DAY)
    tracker.sweep()
    assert.equal((await tracker.prune()).entries, 3, "every entry is past the window and nothing needs one, and the newest stays")
    assert.deepEqual(tracker.changes(0).map((entry) => entry.seq), [newest])
    await tracker.close()
    // As a build from before retention reads where the numbering stands.
    const raw = w.raw()
    assert.equal(raw.prepare("SELECT coalesce(max(seq), 0) AS seq FROM entries").get()?.seq, newest)
    raw.close()
    tracker = await w.open()
    await tracker.track({ id: "work", path: "/work", kind: "workspace" })
    w.fs.write("/work/a.ts", "four\n")
    await tracker.settled()
    assert.equal(tracker.changes(0).at(-1)!.seq, newest + 1, "the next entry is numbered on from it")
  } finally {
    await tracker.close()
    await w.close()
  }
})

test("which roots are idle is read from what the journal keeps as it writes, not from its entries or ended calls", async () => {
  const w = await world()
  const tracker = await w.open()
  try {
    const { store } = tracker
    w.fs.write("/work/a.ts", "one\n")
    await tracker.track({ id: "work", path: "/work", kind: "workspace" })
    await turn(tracker, w.clock, "one", "turn-1", async () => {
      w.fs.write("/work/a.ts", "two\n")
      await tracker.settled()
    })
    tracker.activity({ kind: "background", id: "server", edge: "start", at: w.clock.now(), thread: "one", session: "one-session", checkout: "/elsewhere" })
    const now = w.clock.now() + DAY
    const read = async () => {
      const found = await inSlices(store.recency(now, () => true), 0)
      return { changed: [...found.changed].sort(), worked: [...found.worked].sort() }
    }
    const before = await read()
    assert.deepEqual(before.changed.map(([root]) => root), ["work"])
    assert.deepEqual(before.worked.map(([folder]) => folder), ["/elsewhere", "/work"])
    assert.equal(before.worked[0]![1], now, "work still open counts as now")
    assert.deepEqual({ changed: [...store.recencyNow(now).changed].sort(), worked: [...store.recencyNow(now).worked].sort() }, before)

    // With every entry and every ended call gone, the reading is the same: neither is what it reads.
    const raw = w.raw()
    raw.exec("PRAGMA busy_timeout=5000; DELETE FROM entries; DELETE FROM activity WHERE ended_at IS NOT NULL")
    assert.deepEqual(await read(), before)

    // A journal from before the tables: read whole once, and kept from then on.
    raw.exec("INSERT INTO activity (session, kind, id, thread, checkout, cwd, named, started_at, ended_at) VALUES ('s', 'call', 'c', 'two', '/older', '/older/src', '[]', 5, 9)")
    raw.exec("DELETE FROM root_changed; DELETE FROM folder_worked; DELETE FROM meta WHERE key='recency'")
    raw.prepare("INSERT INTO entries (at, changed_at, root, path, kind, text, stored, observed, certainty, author, settled) VALUES (?, ?, 'older-root', 'a.ts', 'modify', 1, 0, 'event', 'person', ?, 1)")
      .run(7, 7, JSON.stringify({ certainty: "person", via: "editor" }))
    raw.exec("DELETE FROM root_changed; DELETE FROM folder_worked")
    await tracker.close()
    const reopened = await w.open()
    try {
      const filled = await inSlices(reopened.store.recency(now, () => true), 0)
      assert.equal(filled.changed.get("older-root"), 7)
      assert.equal(filled.worked.get("/older/src"), 9)
      assert.equal(reopened.store.meta("recency"), "1", "the filling is noted, so it happens once")
      raw.exec("DELETE FROM entries; DELETE FROM activity")
      assert.equal((await inSlices(reopened.store.recency(now, () => true), 0)).changed.get("older-root"), 7)
    } finally {
      raw.close()
      await reopened.close()
    }
  } finally {
    await tracker.close()
    await w.close()
  }
})

test("a change back to an earlier version finds it in one read, whatever the file's chain holds", async () => {
  const w = await world()
  const tracker = await w.open()
  try {
    const { store } = tracker
    w.fs.write("/work/a.ts", "base\n")
    await tracker.track({ id: "work", path: "/work", kind: "workspace" })
    const edits = 120
    const write = async (text: string) => {
      w.fs.write("/work/a.ts", text)
      await tracker.settled()
      w.clock.advance(5)
    }
    await write("base\nfirst\n")
    const first = tracker.changes(0).at(-1)!
    let chains = 0
    const chain = store.chain.bind(store)
    store.chain = (...args) => {
      chains++
      return chain(...args)
    }
    let versions = 0
    const versionWith = store.versionWith.bind(store)
    store.versionWith = (...args) => {
      versions++
      return versionWith(...args)
    }
    for (let index = 0; index < edits; index++) await write(`base\nedit ${index}\n`)
    await write("base\nfirst\n")
    const restored = tracker.changes(0).at(-1)!
    assert.equal(restored.restores, first.seq, "the version put back is found")
    assert.deepEqual(tracker.blame("work", "a.ts")?.map((run) => run.entry), [null, first.seq], "with the writers it had")
    assert.equal(chains, 0, "no change reads the file's chain")
    assert.equal(versions, edits + 1, "each change asks once")
    // The read walks the file's own index from its newest entry, and decodes the one map it returns.
    const raw = w.raw()
    const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT seq FROM entries WHERE root=?1 AND path=?2 AND seq > ?3 AND after=?4 AND map IS NOT NULL ORDER BY seq DESC LIMIT 1`).all("work", "a.ts", 0, "x")
    raw.close()
    assert.match(JSON.stringify(plan), /USING INDEX entries_path/)
    const started = performance.now()
    for (let index = 0; index < 200; index++) store.versionWith("work", "a.ts", 0, "no such content")
    const each = (performance.now() - started) / 200
    const startedChain = performance.now()
    for (let index = 0; index < 20; index++) chain("work", "a.ts", 0)
    const eachChain = (performance.now() - startedChain) / 20
    console.log(`restored: ${each.toFixed(3)} ms a change over ${edits + 2} entries, ${eachChain.toFixed(3)} ms reading the chain as before`)
    assert.ok(each < eachChain, "cheaper than reading the chain")
  } finally {
    await tracker.close()
    await w.close()
  }
})

test("a sleeping root with nothing uncommitted is let go once it has slept the window, whatever goes on around it; one with uncommitted lines is kept", async () => {
  const w = await world()
  const tracker = await w.open()
  try {
    w.fs.write("/project/clean/a.ts", "one\n")
    w.fs.write("/project/dirty/a.ts", "one\n")
    await tracker.track({ id: "clean", path: "/project/clean", kind: "workspace" })
    await tracker.track({ id: "dirty", path: "/project/dirty", kind: "workspace" })
    w.fs.write("/project/dirty/a.ts", "two\n")
    await tracker.settled()
    w.clock.advance(7 * 60 * 60_000)
    assert.deepEqual((await tracker.sleepIdle()).sort(), ["/project/clean", "/project/dirty"])
    w.clock.advance(8 * DAY)
    assert.deepEqual(await tracker.letGoIdle(), [], "eight days asleep: both stay")
    w.clock.advance(7 * DAY)
    // A Thread works in a folder that holds both, which wakes neither and keeps both from being let go as idle.
    for (const edge of ["start", "end"] as const) tracker.activity({ kind: "turn", id: "around", edge, at: w.clock.now(), thread: "one", session: "one-session", turn: "around", checkout: "/" })
    assert.deepEqual(await tracker.letGoIdle(), ["/project/clean"])
    assert.equal(tracker.store.statPaths("clean").length, 0, "its stat rows go with it")
    assert.equal(tracker.store.statPaths("dirty").length, 1, "the root with uncommitted lines keeps its rows, to wake against")
    assert.equal(tracker.rootStates().get("dirty")?.files.size, 1)
    // Tracked again, the clean root starts from what is there.
    await tracker.track({ id: "clean", path: "/project/clean", kind: "workspace" })
    assert.equal(tracker.store.statPaths("clean").length, 1)
  } finally {
    await tracker.close()
    await w.close()
  }
})

test("an uncommitted line keeps the entry it names when nothing holds its file in memory and the file's base has moved past it", async () => {
  const w = await world()
  let tracker = await w.open()
  try {
    w.fs.write("/work/a.ts", "one\ntwo\n")
    await tracker.track({ id: "work", path: "/work", kind: "workspace" })
    await turn(tracker, w.clock, "gone", "gone-turn", async () => {
      w.fs.write("/work/a.ts", "one\nwritten\n")
      await tracker.settled()
    })
    const named = tracker.changes(0).at(-1)!.seq
    await tracker.close()
    // As a commit that kept the line uncommitted leaves the file: its base moved on past the entry its line names.
    const raw = w.raw()
    raw.prepare("UPDATE files SET base_seq = ? WHERE root = 'work' AND path = 'a.ts'").run(named + 10)
    raw.close()
    w.clock.advance(40 * DAY)
    // The store alone, as retention would run with every root asleep and no file's lines handed to it.
    tracker = await w.open()
    const { store } = tracker
    store.retaining(new Set())
    try {
      const live = store.liveness(w.clock.now() - 14 * DAY)
      store.workEndedInside(live, live.retainAfter, w.clock.now() + 1)
      assert.equal(store.threadLive("gone", live), false, "its Thread stopped long ago")
      // Journaled after it, so the entry isn't kept as the newest.
      store.insertEntry({ at: w.clock.now(), changedAt: w.clock.now(), root: "work", path: "other.ts", kind: "create", before: null, after: null, text: false, stored: false, observed: "event", author: { certainty: "person", via: "editor" }, settled: true })
      store.pruneEntries(0, 512, live)
    } finally {
      store.retained()
    }
    assert.ok(store.entry(named), "the entry the line names stays")
    const line = [...storedView(store).roots()].flatMap((root) => [...root.files.values()]).find((file) => file.path === "a.ts")?.map.find((run) => run.ins === named)
    assert.ok(line && store.author(named), "and still names its writer")
  } finally {
    await tracker.close()
    await w.close()
  }
})

test("a Thread whose only work in the window is one that began before it and ended inside it is still worked in", async () => {
  const w = await world()
  const tracker = await w.open()
  try {
    const mark = (thread: string, edge: "start" | "end") => tracker.activity({ kind: "background", id: `${thread}-server`, edge, at: w.clock.now(), thread, session: `${thread}-session`, checkout: "/work" })
    mark("server", "start")
    mark("stopped", "start")
    w.clock.advance(DAY)
    mark("stopped", "end")
    w.clock.advance(19 * DAY)
    mark("server", "end")
    w.clock.advance(2 * DAY)
    const pruned = await tracker.prune()
    assert.equal(pruned.threads, 1)
    assert.equal(tracker.store.activityOfThread("server").length, 1, "its server ran into the window")
    assert.equal(tracker.store.prunedBefore("server"), undefined)
    assert.equal(tracker.store.activityOfThread("stopped").length, 0, "one whose work ended before the window is stopped")
  } finally {
    await tracker.close()
    await w.close()
  }
})
