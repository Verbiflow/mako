import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  JournalEntrySchema,
  JournalIdSchema,
  type AttributionTracker,
  type HistorySince,
  type JournalEntry,
  type RootPath,
  type TrackerChangeListener,
  type TrackerClock,
  type TrackerEventSource,
  type TrackerFileStat,
  type TrackerFileSystem,
  type TrackerPorts,
} from "./attribution.js"
import type { ConformanceTest } from "./conformance.js"

/*
 * What every attribution tracker owes, run over a fake file system and a
 * fake event source the suite controls: it can write in the same clock tick,
 * drop events on purpose, and change files while no tracker listens. A
 * laptop tracker and a cloud machine's run the same cases.
 */

/** A clock the suite moves by hand. */
export class FakeClock implements TrackerClock {
  private at: number
  constructor(start = 1_800_000_000_000) {
    this.at = start
  }
  now(): number {
    return this.at
  }
  advance(ms: number): void {
    this.at += ms
  }
}

interface FakeFile {
  bytes: Uint8Array
  ino: number
  mode: number
  mtimeNs: bigint
  ctimeNs: bigint
}

const encoder = new TextEncoder()
const nanos = (ms: number) => BigInt(ms) * 1_000_000n

/** Files in memory, with stat data from the fake clock. Every write tells `events`. */
export class FakeFileSystem implements TrackerFileSystem {
  private readonly files = new Map<string, FakeFile>()
  private nextIno = 100
  /** How many walks the tracker made, to prove a restart catches up without one. */
  walks = 0
  private readonly clock: FakeClock
  private readonly events: FakeEventSource

  constructor(clock: FakeClock, events: FakeEventSource) {
    this.clock = clock
    this.events = events
  }

  write(path: string, content: string): void {
    this.writeBytes(path, encoder.encode(content))
  }

  writeBytes(path: string, bytes: Uint8Array): void {
    const known = this.files.get(path)
    const now = nanos(this.clock.now())
    this.files.set(path, { bytes, ino: known?.ino ?? this.nextIno++, mode: known?.mode ?? 0o100644, mtimeNs: now, ctimeNs: now })
    this.events.changed(path)
  }

  remove(path: string): void {
    this.files.delete(path)
    this.events.changed(path)
  }

  rename(from: string, to: string): void {
    const file = this.files.get(from)
    if (!file) throw new Error(`${from} isn't there`)
    this.files.delete(from)
    this.files.set(to, { ...file, ctimeNs: nanos(this.clock.now()) })
    this.events.changed(from)
    this.events.changed(to)
  }

  text(path: string): string | undefined {
    const file = this.files.get(path)
    return file ? new TextDecoder().decode(file.bytes) : undefined
  }

  async stat(path: string): Promise<TrackerFileStat | null> {
    const file = this.files.get(path)
    if (file) return { kind: "file", dev: 1, ino: file.ino, size: file.bytes.byteLength, mode: file.mode, mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs }
    const folder = `${path}/`
    for (const known of this.files.keys()) if (known.startsWith(folder)) return { kind: "directory", dev: 1, ino: 1, size: 0, mode: 0o40755, mtimeNs: 0n, ctimeNs: 0n }
    return null
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.bytes ?? null
  }

  async walk(root: string, skip: (path: RootPath) => boolean): Promise<RootPath[]> {
    this.walks++
    const out: RootPath[] = []
    for (const path of this.files.keys()) {
      if (!path.startsWith(`${root}/`)) continue
      const relative = path.slice(root.length + 1)
      const parts = relative.split("/")
      if (parts.some((_, at) => skip(parts.slice(0, at + 1).join("/")))) continue
      out.push(relative)
    }
    return out.sort()
  }
}

/**
 * Watches over the fake file system, and its history: every change is
 * numbered as FSEvents numbers them, so a tracker opened later asks what
 * changed since a mark. `drop` loses events on purpose until `restore`.
 */
export class FakeEventSource implements TrackerEventSource {
  private readonly watchers = new Map<string, Set<TrackerChangeListener>>()
  private readonly history: string[] = []
  /** The processes that wrote a path, for a source standing in for one that names writers. */
  private readonly writers = new Map<string, number[]>()
  /** Positions in `history` where events were dropped. */
  private readonly lost: number[] = []
  private dropping = false

  changed(path: string, writer?: number): void {
    this.history.push(path)
    if (writer !== undefined) this.writers.set(path, [...(this.writers.get(path) ?? []), writer])
    if (this.dropping) {
      this.lost.push(this.history.length)
      return
    }
    for (const [root, listeners] of this.watchers)
      if (path.startsWith(`${root}/`)) for (const listener of listeners) listener.changed([path.slice(root.length + 1)])
  }

  /** Lose every event until `restore`. */
  drop(): void {
    this.dropping = true
  }

  /** Delivery is back; every watch hears that events were lost. */
  restore(): void {
    this.dropping = false
    for (const listeners of this.watchers.values()) for (const listener of listeners) listener.lost("dropped")
  }

  async watch(root: string, listener: TrackerChangeListener): Promise<{ close(): void }> {
    let listeners = this.watchers.get(root)
    if (!listeners) this.watchers.set(root, (listeners = new Set()))
    listeners.add(listener)
    return { close: () => listeners.delete(listener) }
  }

  async mark(): Promise<string | null> {
    return String(this.history.length)
  }

  async since(mark: string, root: string, options?: { ignore?: readonly string[] }): Promise<HistorySince | null> {
    const from = Number(mark)
    const ignore = options?.ignore ?? []
    const ignored = ignore.map(() => 0)
    const paths: string[] = []
    for (const path of new Set(this.history.slice(from).filter((path) => path.startsWith(`${root}/`)))) {
      const at = ignore.findIndex((folder) => path === folder || path.startsWith(`${folder}/`))
      if (at < 0) paths.push(path)
      else ignored[at]! += 1
    }
    const writers = new Map(paths.flatMap((path) => (this.writers.has(path) ? [[path, this.writers.get(path)!] as const] : [])))
    const found: HistorySince = { paths, complete: !this.lost.some((at) => at > from), ignored }
    if (writers.size) found.writers = writers
    return found
  }
}

/** One case's world: the fakes, a root, and the tracker under test. */
export interface TrackerWorld {
  clock: FakeClock
  fs: FakeFileSystem
  events: FakeEventSource
  ports: TrackerPorts
  root: string
  tracker: AttributionTracker
  /** Close the tracker and open another on the same journal. */
  reopen(): Promise<AttributionTracker>
}

export type MakeTracker = (ports: TrackerPorts) => Promise<AttributionTracker>

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`

/**
 * The cases every tracker passes. Each gets a fresh world, with `/work` as
 * an attached folder holding what `files` says before tracking begins.
 */
export function runTrackerConformance(make: MakeTracker, test: ConformanceTest): void {
  const scenario = (name: string, files: Record<string, string>, body: (world: TrackerWorld) => Promise<void>) =>
    test(name, async () => {
      const storage = await mkdtemp(join(tmpdir(), "mako-tracker-conformance-"))
      const clock = new FakeClock()
      const events = new FakeEventSource()
      const fs = new FakeFileSystem(clock, events)
      const root = "/work"
      for (const [path, content] of Object.entries(files)) fs.write(`${root}/${path}`, content)
      clock.advance(5_000)
      const ports: TrackerPorts = { fs, events, clock, storage, device: "conformance" }
      const world: TrackerWorld = {
        clock, fs, events, ports, root,
        tracker: await make(ports),
        async reopen() {
          await world.tracker.close()
          world.tracker = await make(ports)
          return world.tracker
        },
      }
      try {
        await world.tracker.track({ id: "work", path: root, kind: "attached" })
        await body(world)
      } finally {
        await world.tracker.close()
        await rm(storage, { recursive: true, force: true })
      }
    })

  const entries = async (world: TrackerWorld): Promise<JournalEntry[]> => {
    await world.tracker.settled()
    return world.tracker.changes(0).map((entry) => JournalEntrySchema.parse(entry))
  }
  const step = (world: TrackerWorld, ms = 100) => world.clock.advance(ms)

  scenario("a created file is one entry, numbered from 1, with its content's address", {}, async (world) => {
    world.fs.write("/work/a.txt", "one\n")
    const [entry, ...rest] = await entries(world)
    assert.equal(rest.length, 0)
    assert.ok(JournalIdSchema.safeParse(entry!.journal).success)
    assert.equal(entry!.seq, 1)
    assert.equal(entry!.kind, "create")
    assert.equal(entry!.before, null)
    assert.equal(entry!.after, sha256("one\n"))
    assert.deepEqual(entry!.lines, { added: 1, removed: 0 })
    assert.equal(world.tracker.stored(entry!.after!), true)
  })

  scenario("content that didn't change is not journaled again, whatever an event says", { "a.txt": "same\n" }, async (world) => {
    world.events.changed("/work/a.txt")
    step(world, 5_000)
    world.fs.write("/work/a.txt", "same\n")
    assert.equal((await entries(world)).length, 0)
  })

  scenario("a second write in the same clock tick, the same size, is still seen", {}, async (world) => {
    world.fs.write("/work/racy.txt", "aaaa")
    await world.tracker.settled()
    world.fs.write("/work/racy.txt", "bbbb")
    const all = await entries(world)
    assert.deepEqual(all.map((entry) => entry.kind), ["create", "modify"])
    assert.equal(all[1]!.after, sha256("bbbb"))
  })

  scenario("modify, delete and create again are three entries", { "a.txt": "1\n" }, async (world) => {
    world.fs.write("/work/a.txt", "1\n2\n")
    await world.tracker.settled()
    step(world)
    world.fs.remove("/work/a.txt")
    await world.tracker.settled()
    step(world)
    world.fs.write("/work/a.txt", "3\n")
    const all = await entries(world)
    assert.deepEqual(all.map((entry) => [entry.kind, entry.before === null, entry.after === null]), [["modify", false, false], ["delete", false, true], ["create", true, false]])
    assert.equal(all[1]!.before, sha256("1\n2\n"))
  })

  scenario("a rename heard in one burst is one rename entry", { "old.txt": "moved\n" }, async (world) => {
    world.fs.rename("/work/old.txt", "/work/new.txt")
    const all = await entries(world)
    assert.equal(all.length, 1)
    assert.equal(all[0]!.kind, "rename")
    assert.equal(all[0]!.from, "old.txt")
    assert.equal(all[0]!.path, "new.txt")
  })

  scenario("after lost events a rescan finds the change, and claims no more than `window`", {}, async (world) => {
    world.tracker.activity({ kind: "turn", id: "t1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", checkout: "/work" })
    step(world)
    world.tracker.activity({ kind: "call", id: "c1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", turn: "t1", checkout: "/work", named: ["/work/hidden.txt"] })
    world.events.drop()
    world.fs.write("/work/hidden.txt", "unheard\n")
    step(world)
    world.tracker.reported({ thread: "T1", session: "S1", turn: "t1", call: "c1", status: "completed", effects: [{ kind: "create", path: "/work/hidden.txt", content: "unheard\n" }] })
    world.tracker.activity({ kind: "call", id: "c1", edge: "end", at: world.clock.now(), thread: "T1", session: "S1", turn: "t1" })
    world.events.restore()
    const [entry] = await entries(world)
    assert.equal(entry?.observed, "rescan")
    assert.ok(entry?.gap, "the entry names its gap")
    assert.ok(["window", "ambiguous", "person"].includes(entry!.author.certainty), `claimed ${entry!.author.certainty} across lost events`)
    assert.ok(world.tracker.gaps().some((gap) => gap.id === entry!.gap))
  })

  scenario("a change a call reported exactly is `exact`", { "a.txt": "x\n" }, async (world) => {
    world.tracker.activity({ kind: "turn", id: "t1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", checkout: "/work" })
    world.tracker.activity({ kind: "call", id: "c1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", turn: "t1", checkout: "/work" })
    step(world, 20)
    world.fs.write("/work/a.txt", "x\ny\n")
    step(world, 20)
    world.tracker.reported({ thread: "T1", session: "S1", turn: "t1", call: "c1", status: "completed", effects: [{ kind: "modify", path: "/work/a.txt", patch: "@@ -1 +1,2 @@\n x\n+y\n" }] })
    world.tracker.activity({ kind: "call", id: "c1", edge: "end", at: world.clock.now(), thread: "T1", session: "S1", turn: "t1" })
    const [entry] = await entries(world)
    assert.equal(entry?.author.certainty, "exact")
    assert.equal(entry?.author.certainty === "exact" && entry.author.author.thread, "T1")
  })

  scenario("a change a call's command named the folder of is `named`", {}, async (world) => {
    world.tracker.activity({ kind: "call", id: "c1", edge: "start", at: world.clock.now(), thread: "T2", session: "S2", checkout: "/work", named: ["/work/gen"] })
    step(world, 20)
    world.fs.write("/work/gen/out.ts", "export {}\n")
    const [entry] = await entries(world)
    assert.equal(entry?.author.certainty, "named")
    assert.equal(entry?.author.certainty === "named" && entry.author.author.thread, "T2")
  })

  scenario("one Thread running in its checkout is `window`; two are `ambiguous`; none is the person's", {}, async (world) => {
    world.fs.write("/work/before.txt", "nobody ran\n")
    await world.tracker.settled()
    step(world, 5_000)
    world.tracker.activity({ kind: "turn", id: "t1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", checkout: "/work" })
    step(world)
    world.fs.write("/work/one.txt", "T1 alone\n")
    await world.tracker.settled()
    // Well clear of any slack a tracker allows for a start it heard late.
    step(world, 1_000)
    world.tracker.activity({ kind: "turn", id: "t2", edge: "start", at: world.clock.now(), thread: "T2", session: "S2", checkout: "/work" })
    step(world)
    world.fs.write("/work/two.txt", "both\n")
    const all = await entries(world)
    assert.deepEqual(all.map((entry) => entry.author.certainty), ["person", "window", "ambiguous"])
    const both = all[2]!.author
    assert.ok(both.certainty === "ambiguous" && both.candidates.map((candidate) => candidate.thread).sort().join() === "T1,T2")
  })

  scenario("Mako's own writes are `mako`; a save through Mako's editor is the person's", {}, async (world) => {
    const git = world.tracker.mako({ kind: "git", operation: "git stash push", paths: ["/work"] })
    world.tracker.activity({ kind: "turn", id: "t1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", checkout: "/work" })
    world.fs.write("/work/stashed.txt", "back\n")
    await world.tracker.settled()
    git.end()
    step(world, 5_000)
    const editor = world.tracker.mako({ kind: "editor", operation: "save", paths: ["/work/saved.txt"] })
    world.fs.write("/work/saved.txt", "typed\n")
    await world.tracker.settled()
    editor.end()
    const all = await entries(world)
    assert.deepEqual(all.map((entry) => entry.author), [{ certainty: "mako", operation: "git stash push" }, { certainty: "person", via: "editor" }])
  })

  scenario("dependencies are never journaled; a secret's content is never kept", {}, async (world) => {
    world.fs.write("/work/node_modules/pkg/index.js", "module.exports = 1\n")
    world.fs.write("/work/.env", "TOKEN=1\n")
    const all = await entries(world)
    assert.deepEqual(all.map((entry) => entry.path), [".env"])
    assert.equal(all[0]!.stored, false)
    assert.equal(world.tracker.stored(all[0]!.after!), false)
  })

  scenario("each current line belongs to its last writer", { "a.txt": "1\n2\n3\n" }, async (world) => {
    world.tracker.activity({ kind: "turn", id: "t1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", checkout: "/work" })
    step(world)
    world.fs.write("/work/a.txt", "1\ntwo\n3\n")
    await world.tracker.settled()
    world.tracker.activity({ kind: "turn", id: "t1", edge: "end", at: world.clock.now(), thread: "T1", session: "S1" })
    step(world, 5_000)
    world.fs.write("/work/a.txt", "1\ntwo\n3\nfour\n")
    const [first, second] = await entries(world)
    const runs = world.tracker.blame("work", "a.txt")
    assert.deepEqual(runs?.map((run) => [run.start, run.length, run.entry]), [[0, 1, null], [1, 1, first!.seq], [2, 1, null], [3, 1, second!.seq]])
    assert.equal(runs?.[1]?.author?.certainty, "window")
    assert.equal(runs?.[3]?.author?.certainty, "person")
  })

  scenario("evidence that arrives after the change still makes it `exact`", {}, async (world) => {
    world.tracker.activity({ kind: "call", id: "c1", edge: "start", at: world.clock.now(), thread: "T1", session: "S1", checkout: "/work" })
    world.fs.write("/work/late.txt", "content\n")
    await world.tracker.settled()
    step(world, 50)
    world.tracker.reported({ thread: "T1", session: "S1", call: "c1", status: "completed", endedAt: world.clock.now(), effects: [{ kind: "write", path: "/work/late.txt", content: "content\n" }] })
    world.tracker.activity({ kind: "call", id: "c1", edge: "end", at: world.clock.now(), thread: "T1", session: "S1" })
    const [entry] = await entries(world)
    assert.equal(entry?.author.certainty, "exact")
  })

  scenario("a reopened tracker keeps its journal and catches up from history without walking", { "a.txt": "1\n" }, async (world) => {
    world.fs.write("/work/b.txt", "heard\n")
    const before = await entries(world)
    const journal = before[0]!.journal
    await world.tracker.close()
    step(world, 60_000)
    world.fs.write("/work/a.txt", "1\nwhile closed\n")
    const walks = world.fs.walks
    world.tracker = await make(world.ports)
    const all = await entries(world)
    assert.equal(world.fs.walks, walks, "caught up without walking")
    assert.equal(all.length, 2)
    assert.equal(all[1]!.journal, journal)
    assert.equal(all[1]!.seq, 2)
    assert.equal(all[1]!.observed, "history")
    assert.equal(all[1]!.path, "a.txt")
  })
}
