import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import { PathMapSchema, ThreadFileHistorySchema, type ThreadFileHistory } from "@mako/protocol"
import { HostJobs } from "@mako/host/base/host-jobs"
import type { FileResolution } from "@mako/host/contracts/file-references"
import type { LiveBatch } from "@mako/host/contracts/live-conversations"
import { JournalStore, carryHistory, openAttribution, threadHistory, type Attribution, type TreeWatcher } from "@mako/host/attribution/index"
import { ThreadFiles } from "@mako/host/attribution/thread-files"

/*
 * A Thread's file history carried between journals: a laptop's and a cloud
 * machine's, each its own device. The machine a Thread lands on resolves
 * its answers' file names as the one it left did, there and back, and a
 * history carried twice, late or through a second hop ends the same.
 * Scratch repositories and journals only.
 */

/** A host with its own journal (its own device) and a live conversation `c1` of Thread `T1` working in `cwd`. */
async function host(label: string, cwd: string) {
  const userRoot = mkdtempSync(join(tmpdir(), `mako-thread-history-${label}-`))
  const listeners = new Set<(paths: string[]) => void>()
  const watch: TreeWatcher = (_root, changed) => {
    listeners.add(changed)
    return { ready: Promise.resolve(), close: () => listeners.delete(changed) }
  }
  const journal = await openAttribution({
    dataRoot: userRoot,
    userRoot,
    label,
    git: new Git(),
    watch,
    jobs: new HostJobs(),
    stores: () => [],
    placement: (id) => (id === "c1" ? { thread: "T1", session: `S-${label}` } : undefined),
    session: (id) => (id === "c1" ? { cwd, harness: "claude", record: join(userRoot, "c1.jsonl") } : undefined),
  })
  let revision = 0
  return {
    journal,
    batch: (fields: Partial<LiveBatch>) => journal.live({ id: "c1", revision: ++revision, updates: [], ...fields }),
    emit: (...paths: string[]) => { for (const changed of listeners) changed(paths) },
    async close() {
      await journal.close()
      rmSync(userRoot, { recursive: true, force: true })
    },
  }
}

/** Each answer as what a link shows: the file and why, the files offered, or text. */
const shown = (answers: FileResolution[]) => answers.map((answer) =>
  answer.kind === "file" ? `${answer.file.path} (${answer.file.reason})` : answer.kind === "choice" ? `choose ${answer.candidates.map((file) => file.path).sort().join(" | ")}` : "text")

const resolve = async (journal: Attribution, spellings: readonly string[]) => shown(await journal.resolveFiles({ liveId: "c1" }, spellings))

test("carried to a cloud machine and back, a Thread's answers link to the same files on each, and carrying twice, late or on another hop ends the same", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-history-repo-")))
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
  run("init", "-q", "-b", "main")
  run("config", "user.email", "test@example.com")
  run("config", "user.name", "Test")
  for (const folder of ["src", "lib", "docs", "a/src", "b/src"]) mkdirSync(join(repo, folder), { recursive: true })
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(repo, "lib", "util.ts"), "export const util = 'a line long enough to be the same file'\n")
  writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n")
  for (const side of ["a", "b"]) writeFileSync(join(repo, side, "src", "dup.ts"), `export const side = "${side}"\n`)
  run("add", "-A")
  run("commit", "-q", "-m", "base")
  const laptop = await host("laptop", repo)
  const cloud = await host("cloud", repo)
  const second = await host("second", repo)
  const spellings = ["a.ts", "src/a.ts", "lib/util.ts", "util.ts", "src/dup.ts", "guide.md", "missing.ts"]
  const a = join(repo, "src", "a.ts")
  const util = join(repo, "lib", "util.ts")
  try {
    // On the laptop: the Thread edits `src/a.ts` and reads `lib/util.ts`; then the person renames that, and picks `b`'s `src/dup.ts`.
    laptop.batch({ sessionChanges: { status: "running" } })
    await laptop.journal.track(repo)
    await laptop.journal.settled()
    laptop.batch({ updates: [{ kind: "tool", id: "t1", title: "Edit", name: "Edit", status: "in_progress", input: JSON.stringify({ file_path: a, old_string: "1", new_string: "2" }) }] })
    writeFileSync(a, "export const a = 2\n")
    laptop.emit(a)
    laptop.batch({ updates: [{ kind: "tool-update", id: "t1", status: "completed", output: "ok", effects: [{ kind: "modify", path: a, edits: [{ old: "1", new: "2" }] }] }] })
    laptop.batch({ updates: [{ kind: "tool", id: "t2", title: "Read", name: "Read", status: "in_progress", input: JSON.stringify({ file_path: util }) }] })
    laptop.batch({ updates: [{ kind: "tool-update", id: "t2", status: "completed", output: "ok", effects: [{ kind: "read", path: util }] }] })
    laptop.batch({ sessionChanges: { status: "ready" } })
    await laptop.journal.settled()
    renameSync(util, join(repo, "lib", "helpers.ts"))
    laptop.emit(util, join(repo, "lib", "helpers.ts"))
    await laptop.journal.settled()
    laptop.journal.chooseFile({ liveId: "c1" }, "src/dup.ts", join(repo, "b", "src", "dup.ts"))
    await laptop.journal.settled()
    const onLaptop = await resolve(laptop.journal, spellings)
    assert.deepEqual(onLaptop, [
      `${a} (touched)`,
      `${a} (from-folder)`,
      `${join(repo, "lib", "helpers.ts")} (renamed)`,
      `${join(repo, "lib", "helpers.ts")} (renamed)`,
      `${join(repo, "b", "src", "dup.ts")} (chosen)`,
      `${join(repo, "docs", "guide.md")} (only-match)`,
      "text",
    ])

    // The cloud machine's journal tracks the same folder (a move keeps the absolute path) and knows nothing of the Thread yet.
    await cloud.journal.track(repo)
    await cloud.journal.settled()
    assert.notDeepEqual(await resolve(cloud.journal, spellings), onLaptop, "without the history, the rename and the pick are lost")

    const history: ThreadFileHistory = laptop.journal.threadHistory("T1")
    const travelled = ThreadFileHistorySchema.parse(JSON.parse(JSON.stringify(history)))
    assert.deepEqual(travelled.parts.map((part) => [part.journal, part.activity.length > 0, part.names.some((name) => name.path === util && name.to === join(repo, "lib", "helpers.ts"))]), [[history.from, true, true]])
    assert.equal(JSON.stringify(history).includes("export const"), false, "never file content")
    assert.deepEqual(await cloud.journal.carryThreadHistory(travelled), { thread: "T1", taken: [history.from], left: [], choices: 1 })
    assert.deepEqual(await resolve(cloud.journal, spellings), onLaptop, "the cloud machine links each name as the laptop did")
    assert.deepEqual(await cloud.journal.carryThreadHistory(travelled), { thread: "T1", taken: [], left: [{ journal: history.from, why: "had" }], choices: 0 }, "carried again, nothing changes")

    // The Thread goes on in the cloud: it renames `src/a.ts` itself, and the person picks `a`'s `src/dup.ts` there.
    cloud.batch({ sessionChanges: { status: "running" } })
    const core = join(repo, "src", "core.ts")
    cloud.batch({ updates: [{ kind: "tool", id: "t3", title: "Bash", name: "Bash", status: "in_progress", input: JSON.stringify({ command: "git mv src/a.ts src/core.ts" }) }] })
    renameSync(a, core)
    cloud.emit(a, core)
    cloud.batch({ updates: [{ kind: "tool-update", id: "t3", status: "completed", output: "", effects: [{ kind: "rename", from: a, to: core }] }] })
    cloud.batch({ sessionChanges: { status: "ready" } })
    await cloud.journal.settled()
    await new Promise((done) => setTimeout(done, 5))
    cloud.journal.chooseFile({ liveId: "c1" }, "src/dup.ts", join(repo, "a", "src", "dup.ts"))
    await cloud.journal.settled()
    const onCloud = await resolve(cloud.journal, spellings)
    assert.deepEqual(onCloud.slice(0, 2), [`${core} (renamed)`, `${core} (renamed)`], "followed through the cloud's rename")
    assert.equal(onCloud[4], `${join(repo, "a", "src", "dup.ts")} (chosen)`)

    // Back on the laptop: its own part is left, the cloud's taken, and the later pick holds.
    const back = cloud.journal.threadHistory("T1")
    assert.equal(back.parts.length, 2)
    assert.equal(back.parts[1]?.journal, history.from, "the laptop's part goes on unchanged behind the cloud's own")
    assert.notDeepEqual(await resolve(laptop.journal, spellings), onCloud, "the laptop never saw the cloud's rename or pick")
    const returned = await laptop.journal.carryThreadHistory(back)
    assert.deepEqual(returned, { thread: "T1", taken: [back.from], left: [{ journal: history.from, why: "own" }], choices: 1 })
    assert.deepEqual(await resolve(laptop.journal, spellings), onCloud, "the laptop links each name as the cloud machine did, though it never saw the cloud's rename")

    // The laptop's first history, carried late, changes nothing.
    assert.deepEqual(await cloud.journal.carryThreadHistory(travelled), { thread: "T1", taken: [], left: [{ journal: history.from, why: "had" }], choices: 0 })
    assert.deepEqual(await resolve(cloud.journal, spellings), onCloud)

    // A hop to another machine brings both machines' parts, each once.
    await second.journal.track(repo)
    await second.journal.settled()
    const hop = laptop.journal.threadHistory("T1")
    assert.deepEqual(hop.parts.map((part) => part.journal).sort(), [history.from, back.from].sort())
    assert.deepEqual((await second.journal.carryThreadHistory(hop)).taken.sort(), [history.from, back.from].sort())
    assert.deepEqual(await resolve(second.journal, spellings), onCloud)
  } finally {
    await Promise.all([laptop.close(), cloud.close(), second.close()])
    rmSync(repo, { recursive: true, force: true })
  }
})

test("a carried history: picks merge to the later in either order, paths map where a machine keeps them elsewhere, and what isn't the contract is refused", () => {
  const folder = mkdtempSync(join(tmpdir(), "mako-thread-history-stores-"))
  const open = (name: string) => JournalStore.open(join(folder, `${name}.sqlite`), { device: name })
  const laptop = open("laptop")
  const x = open("x")
  const y = open("y")
  const mapped = open("mapped")
  try {
    laptop.saveRoot({ id: "r1", path: "/Users/someone/project", kind: "workspace", repository: true, head: null, mark: null, seenAt: 1, trackedAt: 1, active: true })
    laptop.saveActivity({ kind: "call", id: "c1", session: "S1", thread: "T1", cwd: "/Users/someone/project/src", named: ["/Users/someone/project/src/a.ts"], start: 10, end: 20,
      effects: [{ kind: "read", path: "b.ts" }, { kind: "command", command: "cat secret-looking-text", cwd: "/Users/someone/project", named: ["/Users/someone/project/c.ts"] }] })
    laptop.saveChoice({ thread: "T1", spelling: "dup.ts", path: "/Users/someone/project/a/dup.ts", at: 100 })
    const early = threadHistory(laptop, "T1", 1_000)
    assert.deepEqual(early.parts[0]?.activity[0]?.effects, [
      { kind: "read", path: "/Users/someone/project/src/b.ts" },
      { kind: "command", cwd: "/Users/someone/project", named: ["/Users/someone/project/c.ts"] },
    ], "a relative path made absolute from where the call ran; a command's text left behind")
    laptop.saveChoice({ thread: "T1", spelling: "dup.ts", path: "/Users/someone/project/b/dup.ts", at: 200 })
    const late = threadHistory(laptop, "T1", 2_000)

    // In either order, the later pick holds.
    carryHistory(x, early, [], 1)
    carryHistory(x, late, [], 2)
    carryHistory(y, late, [], 1)
    carryHistory(y, early, [], 2)
    assert.deepEqual([x.choices("T1").get("dup.ts"), y.choices("T1").get("dup.ts")], ["/Users/someone/project/b/dup.ts", "/Users/someone/project/b/dup.ts"])
    assert.deepEqual(x.carriedParts("T1"), y.carriedParts("T1"), "and the later part, whichever came first")

    // A machine that keeps the project elsewhere takes the paths where it keeps them.
    carryHistory(mapped, late, [{ from: "/Users/someone", to: "/home/mako" }, { from: "/Users/someone/project", to: "/workspace/project" }], 1)
    const [part] = mapped.carriedParts("T1")
    assert.deepEqual([part?.roots[0]?.path, part?.activity[0]?.cwd, part?.activity[0]?.named[0], mapped.choices("T1").get("dup.ts")],
      ["/workspace/project", "/workspace/project/src", "/workspace/project/src/a.ts", "/workspace/project/b/dup.ts"], "the longest prefix wins")

    // Not the contract: refused where it arrives, whole.
    assert.deepEqual([
      { ...late, format: 2 },
      { ...late, parts: [late.parts[0], late.parts[0]] },
      { ...late, choices: [{ spelling: "a.ts", path: "relative/a.ts", at: 1 }] },
      { ...late, parts: [{ ...late.parts[0], activity: [{ ...late.parts[0]!.activity[0], content: "file text" }] }] },
    ].map((history) => ThreadFileHistorySchema.safeParse(history).success), [false, false, false, false])
    assert.equal(PathMapSchema.safeParse([{ from: "Users/someone", to: "/home/mako" }]).success, false)
  } finally {
    for (const store of [laptop, x, y, mapped]) store.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("a long Thread's history is written, carried and read for links in well under a second each", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mako-thread-history-size-"))
  const laptop = JournalStore.open(join(folder, "laptop.sqlite"), { device: "laptop" })
  const cloud = JournalStore.open(join(folder, "cloud.sqlite"), { device: "cloud" })
  try {
    laptop.saveRoot({ id: "r1", path: "/repo", kind: "workspace", repository: false, head: null, mark: null, seenAt: 1, trackedAt: 1, active: true })
    const used = new Set<string>()
    laptop.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        const named = `/repo/src/m${i % 40}/f${i % 5_000}.ts`
        const read = `/repo/src/m${i % 40}/f${(i * 7) % 5_000}.ts`
        used.add(named).add(read)
        laptop.saveActivity({ kind: "call", id: `c${i}`, session: "S1", thread: "T1", cwd: `/repo/src/m${i % 40}`, named: [named], start: 1_000 + i, end: 1_001 + i, effects: [{ kind: "read", path: read }] })
      }
    })
    let began = performance.now()
    const history = threadHistory(laptop, "T1", 100_000)
    const wrote = performance.now() - began
    const bytes = JSON.stringify(history).length
    began = performance.now()
    carryHistory(cloud, ThreadFileHistorySchema.parse(JSON.parse(JSON.stringify(history))), [], 1)
    const carried = performance.now() - began
    const files = new ThreadFiles({ git: new Git(), home: "/nowhere" })
    began = performance.now()
    const context = await files.context(cloud, { thread: "T1", current: ["/repo"] })
    const read = performance.now() - began
    began = performance.now()
    await files.context(cloud, { thread: "T1", current: ["/repo"] })
    const again = performance.now() - began
    console.log(`  20,000 calls: written in ${wrote.toFixed(0)} ms (${(bytes / 1024 / 1024).toFixed(1)} MB), carried in ${carried.toFixed(0)} ms, read for links in ${read.toFixed(0)} ms, then ${again.toFixed(0)} ms`)
    assert.equal(context.touched.size, used.size, "every file the carried calls used")
    assert.ok(wrote < 1_000 && carried < 1_000 && read < 1_000, "each well under a second")
  } finally {
    laptop.close()
    cloud.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
