import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Git } from "@mako/git"
import type { ActivityMark, ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { partition, shares, type JournalView, type Partition, type CheckoutShares } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import type { MoveLedger } from "@mako/host/workspaces/worktree-move"

/*
 * Moving a Thread into its worktree by author, on real repositories: two
 * Threads and the person in one checkout, the same file edited by all
 * three; created, deleted, renamed, binary and untracked files; lines that
 * might be the Thread's and lines nobody can be named for; a hunk given
 * whole by majority; a staged file; a project of two repositories; a move
 * cut short at each step, in a process that is killed there, then resumed
 * or rolled back; and a move of 100 changed files, timed.
 */

const here = fileURLToPath(import.meta.url)
const runner = new Git()
const lines = (count: number, edit: Record<number, string | null> = {}) =>
  Array.from({ length: count }, (_, i) => (edit[i + 1] === null ? "" : `${edit[i + 1] ?? `line ${i + 1}`}\n`)).join("")

/** A child process: a stub journal from the parent's partitions, a move, and a kill at the step it names. */
if (process.argv[2] === "child") {
  // SAFETY: the parent wrote this file from a ChildConfig just before it started this process.
  const config = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as ChildConfig
  const service = new ThreadWorktreeService(runner, config.worktrees, new ThreadStore(config.store), undefined, undefined, undefined, undefined, undefined, () => stubLedger(config))
  let seen = 0
  service.stepped = (step) => {
    if (step === config.crashAt && ++seen >= config.crashCount) process.kill(process.pid, "SIGKILL")
  }
  await service.moveChanges(config.conversation, { thread: config.thread })
  process.exit(0)
}

interface ChildConfig {
  worktrees: string
  store: string
  conversation: string
  thread: string
  crashAt: string
  crashCount: number
  head: string
  taken: Partition
  all: Partition
  shares: CheckoutShares
}

function stubLedger(config: Pick<ChildConfig, "head" | "taken" | "all" | "shares">): MoveLedger {
  return {
    settled: async () => {},
    track: async () => {},
    head: () => config.head,
    partition: (_checkout, _thread, options) => (options?.bring ? config.all : config.taken),
    shares: () => config.shares,
    mako: () => ({ end: () => {} }),
  }
}

/** A repository with a tracker over it on a scripted clock, and the edits of two Threads and the person. */
async function fixture(name: string, files: Record<string, string> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `mako-move-${name}-`)))
  const repo = join(base, "repo")
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Test")
  const initial = {
    "shared.ts": lines(30),
    "old.ts": "export const old = 1\n",
    "gone.ts": "export const gone = 1\n",
    "pre.ts": "before tracking\n",
    "window.ts": "export const w = 1\n",
    "fmt.md": "# Notes\n\nsome  text\n",
    "person.ts": "export const p = 1\n",
    ".gitignore": "ignored/\n",
    ...files,
  }
  for (const [path, text] of Object.entries(initial)) {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]))
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  // Changed before tracking began: nobody can be named for it.
  writeFileSync(join(repo, "pre.ts"), "before tracking, edited\n")
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  const tracker = await LaptopTracker.open(
    { fs: nodeFileSystem(), events, clock, storage: join(base, "journal"), device: "moves" },
    { repository: async (path) => gitRepository(runner, path) },
  )
  await tracker.track({ id: "repo", path: repo, kind: "workspace" })
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  const ledger: MoveLedger = {
    settled: () => tracker.settled(),
    track: async () => {},
    head: (repository) => [...tracker.rootStates().values()].find((state) => state.root.path === repository)?.root.head,
    partition: (checkout, thread, options) => partition(view, checkout, thread, options),
    shares: (checkout, thread) => shares(view, checkout, thread),
    mako: (write) => tracker.mako(write),
  }
  const write = (path: string, content: string | Buffer) => {
    const absolute = join(repo, path)
    mkdirSync(join(absolute, ".."), { recursive: true })
    writeFileSync(absolute, content)
    utimesSync(absolute, clock.now() / 1000, clock.now() / 1000)
    events.changed(absolute)
  }
  const mark = (kind: ActivityMark["kind"], thread: string, id: string, edge: "start" | "end", turn?: string) =>
    tracker.activity({ kind, id, edge, at: clock.now(), thread, session: `${thread}-session`, checkout: repo, turn })
  const call = async (thread: string, turn: string, id: string, effects: ReportedEffect[], act: () => void) => {
    mark("call", thread, id, "start", turn)
    clock.advance(50)
    act()
    clock.advance(50)
    tracker.reported({ thread, session: `${thread}-session`, turn, call: id, status: "completed", endedAt: clock.now(), effects })
    mark("call", thread, id, "end", turn)
    await tracker.settled()
  }
  const abs = (path: string) => join(repo, path)
  return { base, repo, git, clock, events, tracker, view, ledger, write, mark, call, abs }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** T1, T2 and the person, as the move by T1 meets them. */
async function edits(f: Fixture) {
  const { clock, write, mark, call, abs } = f
  clock.advance(1_000)
  mark("turn", "T1", "t1", "start")
  await call("T1", "t1", "c1", [{ kind: "modify", path: abs("shared.ts"), edits: [{ old: "line 3\n", new: "line 3 by T1\n" }] }], () => write("shared.ts", lines(30, { 3: "line 3 by T1" })))
  mark("turn", "T1", "t1", "end")
  clock.advance(1_000)
  mark("turn", "T2", "t2", "start")
  await call("T2", "t2", "c2", [{ kind: "modify", path: abs("shared.ts"), edits: [{ old: "line 15\n", new: "line 15 by T2\n" }] }], () => write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2" })))
  await call("T2", "t2", "c3", [{ kind: "create", path: abs("new2.ts"), content: "export const two = 2\n" }], () => write("new2.ts", "export const two = 2\n"))
  mark("turn", "T2", "t2", "end")
  clock.advance(1_000)
  mark("turn", "T1", "t3", "start")
  // Adjacent to T2's line: one hunk, split by line.
  await call("T1", "t3", "c4", [{ kind: "modify", path: abs("shared.ts"), edits: [{ old: "line 16\n", new: "line 16 by T1\n" }] }], () => write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2", 16: "line 16 by T1" })))
  await call("T1", "t3", "c5", [{ kind: "create", path: abs("src/new1.ts"), content: "export const one = 1\n" }], () => write("src/new1.ts", "export const one = 1\n"))
  await call("T1", "t3", "c6", [{ kind: "rename", from: abs("old.ts"), to: abs("renamed.ts") }], () => {
    renameSync(abs("old.ts"), abs("renamed.ts"))
    f.events.changed(abs("old.ts"))
    f.events.changed(abs("renamed.ts"))
  })
  await call("T1", "t3", "c7", [{ kind: "delete", path: abs("gone.ts") }], () => {
    rmSync(abs("gone.ts"))
    f.events.changed(abs("gone.ts"))
  })
  await call("T1", "t3", "c8", [{ kind: "write", path: abs("bin.dat") }], () => write("bin.dat", Buffer.from([9, 9, 0, 9])))
  // T1 removes lines 25–27, and the person puts line 25 back: that hunk can't be split, and T1 wrote most of it.
  await call("T1", "t3", "c9", [{ kind: "modify", path: abs("shared.ts"), edits: [{ old: "line 25\nline 26\nline 27\n", new: "" }] }], () =>
    write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2", 16: "line 16 by T1", 25: null, 26: null, 27: null })))
  // Only T1's turn was running and no call named it: it might be T1's.
  clock.advance(100)
  write("window.ts", "export const w = 2\n")
  await f.tracker.settled()
  mark("turn", "T1", "t3", "end")
  // A formatter while both Threads ran: either could have.
  clock.advance(1_000)
  mark("turn", "T1", "t4", "start")
  mark("turn", "T2", "t5", "start")
  write("fmt.md", "# Notes\n\nsome text\n")
  await f.tracker.settled()
  mark("turn", "T1", "t4", "end")
  mark("turn", "T2", "t5", "end")
  // The person, with nothing running.
  clock.advance(5_000)
  write("person.ts", "export const p = 2\n")
  write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2", 16: "line 16 by T1", 25: null, 26: null, 27: null }).replace("line 24\n", "line 24\nline 25\n").replace("line 30\n", "line 30 by the person\n"))
  await f.tracker.settled()
  clock.advance(15_000)
  f.tracker.sweep()
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null)

/** A worktree service over the fixture's repository, its receipts beside it. */
function service(f: Fixture, ledger: MoveLedger | null = f.ledger) {
  const store = new ThreadStore(join(f.base, "threads.sqlite"))
  return { store, worktrees: new ThreadWorktreeService(runner, join(f.base, "worktrees"), store, undefined, undefined, undefined, undefined, undefined, () => ledger ?? undefined) }
}

test("two Threads and the person in one checkout: only T1's lines and files move", async () => {
  const f = await fixture("three")
  await edits(f)
  const before = Object.fromEntries(["shared.ts", "new2.ts", "person.ts", "window.ts", "fmt.md", "pre.ts"].map((path) => [path, read(f.abs(path))]))
  f.git("add", "src/new1.ts")
  const { worktrees } = service(f)
  const id = randomUUID()
  const made = await worktrees.prepare(id, f.repo, "Move T1", { kind: "head" })
  const started = performance.now()
  const outcome = await worktrees.moveChanges(id, { thread: "T1" })
  const tookMs = performance.now() - started
  const wt = (path: string) => read(join(made.path, path))

  // The worktree: the base plus T1's lines, its created, deleted, renamed and binary files.
  assert.equal(wt("shared.ts"), lines(30, { 3: "line 3 by T1", 16: "line 16 by T1", 25: null, 26: null, 27: null }).replace("line 24\n", "line 24\nline 25\n"), "T1's lines, with the hunk it wrote most of whole")
  assert.equal(wt("src/new1.ts"), "export const one = 1\n")
  assert.equal(wt("renamed.ts"), "export const old = 1\n")
  assert.equal(wt("old.ts"), null)
  assert.equal(wt("gone.ts"), null)
  assert.deepEqual([...readFileSync(join(made.path, "bin.dat"))], [9, 9, 0, 9])
  for (const path of ["new2.ts"]) assert.equal(wt(path), null, `${path} is T2's and stays`)
  for (const path of ["person.ts", "window.ts", "fmt.md", "pre.ts"]) assert.equal(wt(path), f.git("show", `HEAD:${path}`) + "\n", `${path} stays`)

  // The main checkout: everyone else's, and nothing of T1's.
  assert.equal(read(f.abs("shared.ts")), lines(30, { 15: "line 15 by T2", 30: "line 30 by the person" }))
  assert.equal(read(f.abs("src/new1.ts")), null)
  assert.equal(existsSync(f.abs("src")), false, "the folder T1 made goes with its file")
  assert.equal(read(f.abs("old.ts")), "export const old = 1\n")
  assert.equal(read(f.abs("renamed.ts")), null)
  assert.equal(read(f.abs("gone.ts")), "export const gone = 1\n")
  assert.deepEqual([...readFileSync(f.abs("bin.dat"))], [0, 1, 2, 3, 0, 255])
  for (const path of ["new2.ts", "person.ts", "window.ts", "fmt.md", "pre.ts"]) assert.equal(read(f.abs(path)), before[path], `${path} is as it was`)
  assert.equal(f.git("diff", "--cached", "--name-only"), "", "the staged file left with T1, and its index entry with it")

  // What the card and the agent hear.
  assert.deepEqual(outcome.came.paths.sort(), ["bin.dat", "gone.ts", "old.ts", "renamed.ts", "shared.ts", "src/new1.ts"])
  assert.equal(outcome.came.files, 6)
  // shared.ts 7 (lines 3 and 16 replaced, 25–27 removed), src/new1.ts 1, gone.ts 1; a rename adds none, a binary file has no lines.
  assert.equal(outcome.came.lines, 9)
  assert.deepEqual(outcome.stayed.others.paths.sort(), ["new2.ts", "shared.ts"])
  assert.deepEqual(outcome.stayed.person.paths.sort(), ["person.ts", "shared.ts"])
  assert.deepEqual(outcome.stayed.uncertain.paths.sort(), ["fmt.md", "window.ts"])
  assert.deepEqual(outcome.stayed.unattributed.paths, ["pre.ts"])
  assert.deepEqual(outcome.split, [{ path: "shared.ts", to: "thread" }])
  assert.equal(outcome.brought, false)
  assert.equal(outcome.backup, `refs/mako/moves/${JSON.parse(readFileSync(join(f.base, "worktrees", "receipts", `${id}.json`), "utf8")).moved.id}`)

  // The whole state before is kept: files, untracked ones too, and the index as its second parent.
  const backup = outcome.backup!
  assert.equal(f.git("show", `${backup}:shared.ts`) + "\n", before["shared.ts"])
  assert.equal(f.git("show", `${backup}:src/new1.ts`), "export const one = 1")
  assert.equal(f.git("show", `${backup}^2:src/new1.ts`), "export const one = 1", "the index had it staged")
  assert.equal(f.git("cat-file", "-t", `${backup}:pre.ts`), "blob")

  // A repeated request answers the same and moves nothing again.
  writeFileSync(f.abs("later.ts"), "after\n")
  assert.deepEqual(await worktrees.moveChanges(id, { thread: "T1" }), outcome)
  assert.equal(read(f.abs("later.ts")), "after\n")
  rmSync(f.abs("later.ts"))

  // "Bring these": the uncertain and unattributed follow, from where the move left them.
  const brought = await worktrees.bringStayed(id)
  assert.deepEqual(brought.left, [])
  assert.equal(brought.outcome.brought, true)
  assert.equal(wt("window.ts"), "export const w = 2\n")
  assert.equal(wt("fmt.md"), "# Notes\n\nsome text\n")
  assert.equal(wt("pre.ts"), "before tracking, edited\n")
  for (const path of ["window.ts", "fmt.md", "pre.ts"]) assert.equal(read(f.abs(path)), f.git("show", `HEAD:${path}`) + "\n", `${path} left the main checkout`)
  assert.equal(read(f.abs("person.ts")), "export const p = 2\n", "the person's own stays")
  assert.equal(brought.outcome.stayed.uncertain.files + brought.outcome.stayed.unattributed.files, 0)
  assert.equal(brought.outcome.came.files, 9)
  assert.deepEqual(brought.outcome.came.paths, ["bin.dat", "fmt.md", "gone.ts", "old.ts", "pre.ts", "renamed.ts", "shared.ts", "src/new1.ts", "window.ts"])
  assert.deepEqual((await worktrees.bringStayed(id)).left, [], "bringing again changes nothing")
  console.log(`  move of 6 files by author: ${tookMs.toFixed(0)} ms`)
  await f.tracker.close()
})

test("a move that brings everything uncertain at once, and a file changed under it refuses with nothing written", async () => {
  const f = await fixture("bring")
  await edits(f)
  const { worktrees } = service(f)
  const id = randomUUID()
  const made = await worktrees.prepare(id, f.repo, "Bring all", { kind: "head" })
  const outcome = await worktrees.moveChanges(id, { thread: "T1", bring: true })
  assert.equal(outcome.brought, true)
  assert.equal(read(join(made.path, "pre.ts")), "before tracking, edited\n")
  assert.equal(read(join(made.path, "window.ts")), "export const w = 2\n")
  assert.equal(read(join(made.path, "new2.ts")), null, "other Threads' changes still stay")
  assert.equal(outcome.stayed.uncertain.files + outcome.stayed.unattributed.files, 0)

  // The journal hasn't heard a write yet: the move waits for it, then refuses with nothing touched.
  const g = await fixture("stale")
  await edits(g)
  const { worktrees: other } = service(g)
  const staleId = randomUUID()
  const stale = await other.prepare(staleId, g.repo, "Stale", { kind: "head" })
  writeFileSync(g.abs("shared.ts"), "unheard\n")
  const statusBefore = g.git("status", "--porcelain")
  await assert.rejects(other.moveChanges(staleId, { thread: "T1" }), /still changing/)
  assert.equal(g.git("status", "--porcelain"), statusBefore)
  assert.equal(read(join(stale.path, "shared.ts")), lines(30))
  assert.equal(g.git("for-each-ref", "refs/mako/moves/"), "", "no backup for a move that didn't start writing")
  await f.tracker.close()
  await g.tracker.close()
})

test("without the journal nothing is attributed: nothing moves unless brought, then everything does", async () => {
  const f = await fixture("unjournaled")
  await edits(f)
  await f.tracker.close()
  const { worktrees } = service(f, null)
  const id = randomUUID()
  const made = await worktrees.prepare(id, f.repo, "No journal", { kind: "head" })
  const statusBefore = f.git("status", "--porcelain")
  const outcome = await worktrees.moveChanges(id, { thread: "T1" })
  assert.equal(outcome.came.files, 0)
  assert.equal(f.git("status", "--porcelain"), statusBefore)
  assert.ok(outcome.stayed.unattributed.files >= 9)
  const brought = await worktrees.bringStayed(id)
  assert.equal(f.git("status", "--porcelain", "--untracked-files=all"), "", "everything came")
  assert.equal(read(join(made.path, "new2.ts")), "export const two = 2\n")
  assert.equal(read(join(made.path, "renamed.ts")), "export const old = 1\n")
  assert.equal(brought.outcome.brought, true)
})

test("a project folder of two repositories: one worktree per repository, each with T1's own", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "mako-move-project-")))
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events, clock, storage: join(project, ".journal"), device: "project" }, { repository: async (path) => gitRepository(runner, path) })
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  for (const name of ["api", "web"]) {
    const repo = join(project, name)
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
    git("init", "-q", "-b", "main")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Test")
    writeFileSync(join(repo, "index.ts"), lines(10))
    git("add", "-A")
    git("commit", "-q", "-m", "base")
    await tracker.track({ id: name, path: repo, kind: "workspace" })
  }
  const edit = async (thread: string, repo: string, line: number) => {
    const path = join(project, repo, "index.ts")
    tracker.activity({ kind: "call", id: `${thread}-${repo}-${line}`, edge: "start", at: clock.now(), thread, session: thread, checkout: project })
    clock.advance(50)
    const next = readFileSync(path, "utf8").replace(`line ${line}\n`, `line ${line} by ${thread}\n`)
    writeFileSync(path, next)
    utimesSync(path, clock.now() / 1000, clock.now() / 1000)
    events.changed(path)
    tracker.reported({ thread, session: thread, call: `${thread}-${repo}-${line}`, status: "completed", endedAt: clock.now(), effects: [{ kind: "modify", path, edits: [{ old: `line ${line}\n`, new: `line ${line} by ${thread}\n` }] }] })
    tracker.activity({ kind: "call", id: `${thread}-${repo}-${line}`, edge: "end", at: clock.now(), thread, session: thread })
    await tracker.settled()
    clock.advance(1_000)
  }
  await edit("T1", "api", 2)
  await edit("T2", "api", 8)
  await edit("T1", "web", 5)
  clock.advance(15_000)
  tracker.sweep()
  const ledger: MoveLedger = {
    settled: () => tracker.settled(),
    track: async () => {},
    head: (repository) => [...tracker.rootStates().values()].find((state) => state.root.path === repository)?.root.head,
    partition: (checkout, thread, options) => partition(view, checkout, thread, options),
    shares: (checkout, thread) => shares(view, checkout, thread),
    mako: (write) => tracker.mako(write),
  }
  const store = new ThreadStore(join(project, ".threads.sqlite"))
  const worktrees = new ThreadWorktreeService(runner, join(project, ".worktrees"), store, undefined, undefined, undefined, undefined, undefined, () => ledger)
  const id = randomUUID()
  const made = await worktrees.prepare(id, project, "Both repos", { kind: "head" })
  const outcome = await worktrees.moveChanges(id, { thread: "T1" })
  assert.deepEqual(outcome.came.paths.sort(), ["api/index.ts", "web/index.ts"])
  assert.equal(readFileSync(join(made.path, "api", "index.ts"), "utf8"), lines(10, { 2: "line 2 by T1" }))
  assert.equal(readFileSync(join(made.path, "web", "index.ts"), "utf8"), lines(10, { 5: "line 5 by T1" }))
  assert.equal(readFileSync(join(project, "api", "index.ts"), "utf8"), lines(10, { 8: "line 8 by T2" }))
  assert.equal(readFileSync(join(project, "web", "index.ts"), "utf8"), lines(10))
  assert.deepEqual(outcome.stayed.others.paths, ["api/index.ts"])
  for (const name of ["api", "web"])
    assert.match(execFileSync("git", ["for-each-ref", "refs/mako/moves/"], { cwd: join(project, name), encoding: "utf8" }), /refs\/mako\/moves\//, `${name} keeps its backup`)
  await tracker.close()
})

/**
 * A move killed at `step` (the `count`th time it's reached), in a process of
 * its own, then picked up by the next start (`tidy`). With `meddle`, a moved
 * file is changed between the kill and the start, so the move can't finish.
 */
async function crash(step: string, count = 1, meddle = false) {
  const f = await fixture(`crash-${step}-${count}`)
  await edits(f)
  const { worktrees } = service(f)
  const id = randomUUID()
  const made = await worktrees.prepare(id, f.repo, `Crash ${step}`, { kind: "head" })
  const snapshot = (folder: string) => Object.fromEntries(["shared.ts", "src/new1.ts", "old.ts", "renamed.ts", "gone.ts", "bin.dat", "new2.ts", "window.ts"].map((path) => [path, existsSync(join(folder, path)) ? readFileSync(join(folder, path), "latin1") : null]))
  const mainBefore = snapshot(f.repo)
  const worktreeBefore = snapshot(made.path)
  const config: ChildConfig = {
    worktrees: join(f.base, "worktrees"),
    store: join(f.base, "threads.sqlite"),
    conversation: id,
    thread: "T1",
    crashAt: step,
    crashCount: count,
    head: f.git("rev-parse", "HEAD"),
    taken: partition(f.view, f.repo, "T1"),
    all: partition(f.view, f.repo, "T1", { bring: true }),
    shares: shares(f.view, f.repo, "T1"),
  }
  await f.tracker.close()
  const configPath = join(f.base, "child.json")
  writeFileSync(configPath, JSON.stringify(config))
  const child = spawnSync(process.execPath, [...process.execArgv, here, "child", configPath], { encoding: "utf8", env: process.env })
  assert.equal(child.signal, "SIGKILL", `the move was killed at ${step}: ${child.stderr}`)
  if (meddle) writeFileSync(join(f.repo, "person.ts"), "someone else\n")
  if (meddle) writeFileSync(join(made.path, "shared.ts"), "the agent already edited this\n")
  const { worktrees: next } = service(f, stubLedger(config))
  await next.tidy()
  const receipt = JSON.parse(readFileSync(join(f.base, "worktrees", "receipts", `${id}.json`), "utf8"))
  assert.equal(receipt.moving, undefined, "the next start leaves no move half-done")
  return { f, made, next, id, receipt, mainBefore, worktreeBefore, snapshot }
}

test("a move killed at each step finishes or rolls back on the next start, and never loses a line", async () => {
  // Before the plan was saved nothing was written: the move simply hasn't happened, and a repeat does it.
  for (const step of ["planning", "stored", "backed-up"]) {
    const { f, made, next, id, receipt, mainBefore, worktreeBefore, snapshot } = await crash(step)
    assert.equal(receipt.moved, undefined, `${step}: nothing moved`)
    assert.deepEqual(snapshot(f.repo), mainBefore)
    assert.deepEqual(snapshot(made.path), worktreeBefore)
    const outcome = await next.moveChanges(id, { thread: "T1" })
    assert.equal(outcome.came.files, 6, `${step}: a repeat moves it`)
    assert.equal(read(join(made.path, "src/new1.ts")), "export const one = 1\n")
  }
  // Once the plan was saved, the move rolls forward: every file is as it was or as the plan wants.
  for (const [step, count] of [["saved", 1], ["wrote", 1], ["wrote", 5], ["written", 1], ["done", 1]] as const) {
    const { f, made, receipt, mainBefore } = await crash(step, count)
    assert.equal(receipt.moved?.files, 6, `${step} ${count}: finished`)
    assert.equal(read(join(made.path, "src/new1.ts")), "export const one = 1\n")
    assert.equal(read(join(made.path, "shared.ts")), lines(30, { 3: "line 3 by T1", 16: "line 16 by T1", 25: null, 26: null, 27: null }).replace("line 24\n", "line 24\nline 25\n"))
    assert.equal(read(f.abs("shared.ts")), lines(30, { 15: "line 15 by T2", 30: "line 30 by the person" }))
    assert.equal(read(f.abs("new2.ts")), mainBefore["new2.ts"])
    assert.equal(read(f.abs("src/new1.ts")), null)
  }
  // A file someone changed after the kill: the move can't finish, so it rolls back around that file.
  {
    const { f, made, receipt, mainBefore, worktreeBefore, snapshot } = await crash("wrote", 3, true)
    assert.equal(receipt.moved, undefined)
    const main = snapshot(f.repo)
    assert.deepEqual(main, mainBefore, "the main checkout is as it was before the move")
    const worktree = snapshot(made.path)
    assert.equal(worktree["shared.ts"], "the agent already edited this\n", "a file changed since stays as it was left")
    assert.deepEqual({ ...worktree, "shared.ts": worktreeBefore["shared.ts"] }, worktreeBefore, "everything else in the worktree is the base again")
    assert.equal(read(f.abs("person.ts")), "someone else\n")
    assert.match(f.git("for-each-ref", "refs/mako/moves/"), /refs\/mako\/moves\//, "the backup is kept")
  }
})

test("a move of 100 changed files, timed end to end", async () => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`src/file-${String(i).padStart(3, "0")}.ts`, lines(200)]))
  const f = await fixture("hundred", files)
  f.clock.advance(1_000)
  f.mark("turn", "T1", "big", "start")
  f.mark("turn", "T2", "big2", "start")
  // T1 changes every file; T2 changes every other one too, further down.
  for (let i = 0; i < 100; i++) {
    const path = `src/file-${String(i).padStart(3, "0")}.ts`
    await f.call("T1", "big", `c1-${i}`, [{ kind: "modify", path: f.abs(path), edits: [{ old: "line 10\n", new: "line 10 by T1\n" }] }], () => f.write(path, lines(200, { 10: "line 10 by T1" })))
    if (i % 2) await f.call("T2", "big2", `c2-${i}`, [{ kind: "modify", path: f.abs(path), edits: [{ old: "line 100\n", new: "line 100 by T2\n" }] }], () => f.write(path, lines(200, { 10: "line 10 by T1", 100: "line 100 by T2" })))
  }
  f.mark("turn", "T1", "big", "end")
  f.mark("turn", "T2", "big2", "end")
  f.clock.advance(15_000)
  f.tracker.sweep()
  const { worktrees } = service(f)
  const id = randomUUID()
  const made = await worktrees.prepare(id, f.repo, "Hundred", { kind: "head" })
  const started = performance.now()
  const outcome = await worktrees.moveChanges(id, { thread: "T1" })
  const ms = performance.now() - started
  assert.equal(outcome.came.files, 100)
  assert.equal(read(join(made.path, "src/file-000.ts")), lines(200, { 10: "line 10 by T1" }))
  assert.equal(read(f.abs("src/file-000.ts")), lines(200))
  assert.equal(read(f.abs("src/file-001.ts")), lines(200, { 100: "line 100 by T2" }))
  assert.equal(read(join(made.path, "src/file-001.ts")), lines(200, { 10: "line 10 by T1" }))
  console.log(`  move of 100 changed files (200 lines each): ${ms.toFixed(0)} ms end to end`)
  assert.ok(ms < 3_000, `took ${ms} ms`)
  await f.tracker.close()
})
