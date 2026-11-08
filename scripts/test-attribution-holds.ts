import assert from "node:assert/strict"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Attribution } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { inSlices } from "@mako/sessions/slices"
import { contentRef } from "@mako/host/attribution/content"
import { JournalStore } from "@mako/host/attribution/journal-store"
import { nodeFileSystem } from "@mako/host/attribution/ports"
import { countingTurn, countTurnInSlices, storedView, turnChanges } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The record of changes reads big without holding the host's loop (`npm run test:attribution-holds`).
 *
 * On 2026-11-07 the person's host held its loop for 1.6 s letting go of idle roots (`LaptopTracker.letGoIdle`: the
 * newest entry of every root and the last work in every folder, read at once over a journal of 100,000 entries and
 * 137,000 calls), and for 1.2 s counting a turn of 337 files (`turnChanges`). Both now read a step at a time
 * (`JournalStore.recency`, `countingTurn`), run in slices.
 *
 * Each is held to the same work done at once in the same run (the yardstick): the longest hold in slices must stay
 * under a `TIMES`th of the one at once, and what it finds must be exactly what the reading at once finds. And since
 * other work runs between the reading and the letting go, a root a turn began on meanwhile, after the reading or
 * between two roots let go, stays. A count or a pass cut by the journal's close (its host stopping) ends at its next
 * step, under a `TIMES`th of the whole sliced work's time, quietly: nothing counted, nothing let go, nothing failed.
 */
const TIMES = 4
const DAY = 86_400_000
const root = realpathSync(testScratch("mako-attribution-holds-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The longest the loop went without turning while `work` ran, and a moment after, sampled every millisecond. */
async function longestHold<Value>(work: () => Promise<Value> | Value): Promise<{ value: Value; holdMs: number }> {
  let longest = 0
  let last = performance.now()
  let running = true
  const tick = () => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    if (running) setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
  await pause(5)
  const value = await work()
  await pause(50)
  running = false
  return { value, holdMs: Math.max(longest, performance.now() - last) }
}

/** How long `work` takes to end once `stop` runs, a slice into it, against `wholeMs`, the whole of it in slices. */
async function stoppedMidway<Value>(what: string, work: () => Promise<Value>, stop: () => void, wholeMs: number): Promise<Value> {
  const running = work()
  await new Promise((resolve) => setImmediate(resolve))
  const stopped = performance.now()
  stop()
  const value = await running
  const endMs = performance.now() - stopped
  const limit = wholeMs / TIMES
  console.log(`${what}: ended ${Math.round(endMs)} ms after its stop (limit ${Math.round(limit)} ms, a ${TIMES}th of the ${Math.round(wholeMs)} ms it takes whole in slices)`)
  assert.ok(endMs < limit, `${what} took ${Math.round(endMs)} ms to end after its stop, not under ${Math.round(limit)} ms`)
  return value
}

function judge(what: string, atOnce: number, sliced: number): void {
  const limit = atOnce / TIMES
  console.log(`${what}: at once the loop held ${Math.round(atOnce)} ms, in slices ${Math.round(sliced)} ms (limit ${Math.round(limit)} ms, a ${TIMES}th of at once)`)
  assert.ok(sliced < limit, `${what} in slices held the loop ${Math.round(sliced)} ms, not under ${Math.round(limit)} ms, a ${TIMES}th of the ${Math.round(atOnce)} ms at once`)
}

/** A turn of `FILES` files, each written `VERSIONS` times by the turn, with another Thread's writes in the checkout meanwhile. */
async function countATurn(): Promise<void> {
  const FILES = 400
  const VERSIONS = 6
  const LINES = 300
  const OTHERS = 3_000
  const store = JournalStore.open(join(root, "turn", "journal.sqlite"), { device: "attribution-holds" })
  const started = 1_790_000_000_000
  const checkout = join(root, "turn", "repo")
  store.saveRoot({ id: "r1", path: checkout, kind: "workspace", repository: false, head: null, mark: null, seenAt: started, trackedAt: started, active: true })
  const own: Attribution = { certainty: "exact", author: { thread: "T1", session: "S1", turn: "R1" }, effect: "modify" }
  const other: Attribution = { certainty: "exact", author: { thread: "T2", session: "S2", turn: "T2-turn" }, effect: "modify" }
  const version = (file: number, step: number) => {
    const text = Array.from({ length: LINES }, (_, line) => (line % 30 === step * 5 % 30 ? `line ${line} of file ${file}, step ${step}` : `line ${line} of file ${file}`)).join("\n")
    const bytes = new TextEncoder().encode(text)
    const ref = contentRef(bytes)
    store.putBlob(ref, bytes, started)
    return ref
  }
  store.transaction(() => {
    let at = started
    for (let file = 0; file < FILES; file++) {
      let before = version(file, 0)
      for (let step = 1; step <= VERSIONS; step++) {
        const after = version(file, step)
        at += 10
        store.insertEntry({ at, changedAt: at, root: "r1", path: `src/file-${file}.ts`, kind: "modify", before, after, text: true, added: 10, removed: 10, stored: true, observed: "event", author: own, settled: true })
        before = after
      }
    }
    for (let index = 0; index < OTHERS; index++) {
      at += 1
      const path = `docs/other-${index % 50}.md`
      store.insertEntry({ at, changedAt: at, root: "r1", path, kind: "modify", before: null, after: null, text: false, added: 2, removed: 1, stored: false, observed: "event", author: other, settled: true })
    }
    store.saveActivity({ kind: "turn", id: "R1", session: "S1", thread: "T1", turn: "R1", checkout, named: [], start: started, end: at + 1 })
  })
  const view = storedView(store)
  const atOnce = await longestHold(() => turnChanges(view, "T1", "R1", "settled", 0))
  const began = performance.now()
  const sliced = await longestHold(() => inSlices(countingTurn(view, "T1", "R1", "settled", 0)))
  const wholeMs = performance.now() - began
  assert.equal(atOnce.value.own.files, FILES, "every file the turn wrote is counted")
  assert.ok(atOnce.value.others.files > 0, "and the other Thread's writes meanwhile")
  assert.deepEqual(sliced.value, atOnce.value, "counted in slices, the turn counts exactly as at once")
  judge(`a turn of ${FILES} files written ${VERSIONS} times each`, atOnce.holdMs, sliced.holdMs)
  const cut = await stoppedMidway("a count its journal closed under", () => countTurnInSlices(view, "T1", "R1", "settled"), () => store.close(), wholeMs)
  assert.equal(cut, undefined, "a count its journal closed under counts nothing, and fails nothing")
}

/** A tracker whose journal holds a day's worth of other roots' entries and other folders' calls, with one root idle past retention. */
async function letGoOfIdleRoots(): Promise<void> {
  const ENTRIES = 250_000
  const CALLS = 250_000
  const storage = join(root, "idle")
  const folder = join(storage, "repo")
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "a.ts"), "export const a = 1\n")
  const clock = new FakeClock(1_790_000_000_000)
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events: new FakeEventSource(), clock, storage, device: "attribution-holds" })
  await tracker.track({ id: "idle", path: folder, kind: "workspace" })
  await tracker.settled()
  // Written beside the tracker, as another process's writes would be: the rows' shape is the journal's own.
  const raw = new DatabaseSync(join(storage, "journal.sqlite"))
  raw.exec("PRAGMA busy_timeout=5000; BEGIN")
  const author = JSON.stringify({ certainty: "person", via: "editor" })
  const entry = raw.prepare("INSERT INTO entries (at, changed_at, root, path, kind, text, stored, observed, certainty, author, settled) VALUES (?, ?, ?, ?, 'modify', 1, 0, 'event', 'person', ?, 1)")
  for (let index = 0; index < ENTRIES; index++) {
    const at = clock.now() - 20 * DAY + index
    entry.run(at, at, `other-${index % 200}`, `file-${index % 1_000}.ts`, author)
  }
  const call = raw.prepare("INSERT INTO activity (session, kind, id, thread, checkout, cwd, named, started_at, ended_at) VALUES (?, 'call', ?, ?, ?, ?, '[]', ?, ?)")
  for (let index = 0; index < CALLS; index++) {
    const at = clock.now() - (index % 2 ? 20 : 1) * DAY + index
    call.run(`session-${index % 500}`, `call-${index}`, `thread-${index % 300}`, `/elsewhere/checkout-${index % 400}`, `/elsewhere/checkout-${index % 400}/src`, at, at + 1_000)
  }
  raw.exec("COMMIT")
  // The reading at once letGoIdle made before, on the same journal: the yardstick.
  const now = clock.now() + 15 * DAY
  const readAtOnce = () => {
    const changed = raw.prepare("SELECT root, MAX(at) AS at FROM entries GROUP BY root").all()
    const worked = raw.prepare("SELECT checkout, cwd, MAX(coalesce(ended_at, ?)) AS at FROM activity GROUP BY checkout, cwd").all(now)
    return changed.length + worked.length
  }
  readAtOnce()
  const atOnce = await longestHold(readAtOnce)

  // Tracked a moment ago: nobody let go, and where Threads worked isn't read.
  const began = performance.now()
  const kept = await longestHold(() => tracker.letGoIdle())
  const wholeMs = performance.now() - began
  assert.deepEqual(kept.value, [], "a root tracked a moment ago stays")
  // Fifteen days on, nothing changed there and nobody worked in or around it: let go.
  clock.advance(15 * DAY)
  const letGo = await longestHold(() => tracker.letGoIdle())
  assert.deepEqual(letGo.value, [folder], "the root idle past retention is let go, and only it")
  judge(`letting go of idle roots, no root idle (${ENTRIES.toLocaleString("en-US")} entries)`, atOnce.holdMs, kept.holdMs)
  judge(`letting go of idle roots, one idle (${ENTRIES.toLocaleString("en-US")} entries, ${CALLS.toLocaleString("en-US")} calls)`, atOnce.holdMs, letGo.holdMs)
  raw.close()
  // Cut by the tracker's close, as its host stops.
  let closed: Promise<void> | undefined
  const cut = await stoppedMidway("letting go of idle roots, its tracker closed under it", () => tracker.letGoIdle(), () => {
    closed = tracker.close()
  }, wholeMs)
  assert.deepEqual(cut, [], "a pass its tracker closed under lets go of nothing, and fails nothing")
  await closed
}

/** Two roots idle past retention; `meanwhile` runs as `letGoIdle` reads and lets go, and says what it began work on. */
async function idleWhileWorkBegins(name: string, meanwhile: (tracker: LaptopTracker, folders: readonly string[], clock: FakeClock) => void): Promise<{ letGo: string[]; folders: string[]; tracker: LaptopTracker }> {
  const storage = join(root, name)
  const folders = ["one", "two"].map((repo) => join(storage, repo))
  for (const folder of folders) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "a.ts"), "export const a = 1\n")
  }
  const clock = new FakeClock(1_790_000_000_000)
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events: new FakeEventSource(), clock, storage, device: "attribution-holds" })
  for (const [index, folder] of folders.entries()) await tracker.track({ id: `root-${index}`, path: folder, kind: "workspace" })
  await tracker.settled()
  clock.advance(15 * DAY)
  meanwhile(tracker, folders, clock)
  return { letGo: await tracker.letGoIdle(), folders, tracker }
}

const turnIn = (tracker: LaptopTracker, folder: string, clock: FakeClock) =>
  tracker.activity({ kind: "turn", id: `turn-in-${folder.split("/").at(-1)}`, edge: "start", at: clock.now(), thread: "T1", session: "S1", checkout: folder })

async function workBeginsMeanwhile(): Promise<void> {
  // pr-review's case: a turn begins on the root after the reading, before the root is let go.
  {
    const { letGo, folders, tracker } = await idleWhileWorkBegins("after-reading", (tracker, folders, clock) => queueMicrotask(() => turnIn(tracker, folders[0]!, clock)))
    assert.deepEqual(letGo, [folders[1]], "the root a turn began on after the reading stays; the other goes")
    assert.ok(tracker.rootStates().has("root-0"), "and it's still tracked")
    await tracker.close()
  }
  // Between two roots let go: a turn begins on the second while the first is let go.
  {
    const { letGo, folders, tracker } = await idleWhileWorkBegins("between-roots", (tracker, folders, clock) => {
      const untrack = tracker.untrack.bind(tracker)
      tracker.untrack = async (id) => {
        const untracked = untrack(id)
        if (id === "root-0") turnIn(tracker, folders[1]!, clock)
        return untracked
      }
    })
    assert.deepEqual(letGo, [folders[0]], "the root a turn began on while another was let go stays")
    assert.ok(tracker.rootStates().has("root-1"), "and it's still tracked")
    await tracker.close()
  }
  console.log("a root work began on after the reading, or between two let go, stays")
}

try {
  await workBeginsMeanwhile()
  await countATurn()
  await letGoOfIdleRoots()
  console.log("attribution holds: ok")
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
