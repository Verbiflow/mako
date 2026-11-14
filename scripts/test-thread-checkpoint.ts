import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, statSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import type { ActivityMark, ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { contentRef } from "@mako/host/attribution/index"
import { JournalReader } from "@mako/host/attribution/journal-reader"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { partition, type JournalView, type Partition } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { applyMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"
import { CheckoutLeave, cloudHasAll } from "@mako/host/workspaces/leave-checkout"
import { captureThreadCheckpoint, type ThreadCheckpointInput } from "@mako/host/workspaces/thread-checkpoint"

/*
 * One Thread's changes in a checkout it shares with the person and another Thread, captured as a checkpoint over HEAD
 * (`thread-checkpoint.ts`), on real repositories and a real journal: only the Thread's lines and files are in it, the
 * person's never; capture writes nothing into the checkout; the same changes make the same bundle, whatever the person
 * does meanwhile; a clone of the remote applies it and reads the Thread's changes, uncommitted, on the Thread's
 * branch. What it leaves out it names (too large, over the total, Git LFS, ignored), and a checkout mid-merge, one with
 * no commits and a journal that hasn't caught up are refused.
 */

const runner = new Git()
const lines = (count: number, edit: Record<number, string | null> = {}) =>
  Array.from({ length: count }, (_, i) => (edit[i + 1] === null ? "" : `${edit[i + 1] ?? `line ${i + 1}`}\n`)).join("")

async function fixture(name: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `mako-thread-checkpoint-${name}-`)))
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
  const remote = join(base, "remote.git")
  sh(base, "init", "--bare", "--quiet", remote)
  const repo = join(base, "mac")
  sh(base, "clone", "--quiet", remote, repo)
  const git = (...args: string[]) => sh(repo, ...args)
  const initial = {
    "shared.ts": lines(30),
    "old.ts": "export const old = 1\n",
    "gone.ts": "export const gone = 1\n",
    "pre.ts": "before tracking\n",
    "person.ts": "export const p = 1\n",
    ".gitignore": "ignored/\n",
    ".gitattributes": "*.lfs filter=lfs diff=lfs merge=lfs -text\n",
  }
  for (const [path, text] of Object.entries(initial)) writeFileSync(join(repo, path), text)
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]))
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 })
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  git("push", "-q", "origin", "main")
  // A commit the remote lacks: the bundle carries it.
  writeFileSync(join(repo, "local.ts"), "committed here\n")
  git("add", "local.ts")
  git("commit", "-q", "-m", "local")
  writeFileSync(join(repo, "pre.ts"), "before tracking, edited\n")
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  const tracker = await LaptopTracker.open(
    { fs: nodeFileSystem(), events, clock, storage: join(base, "journal"), device: "checkpoints" },
    { repository: async (path) => gitRepository(runner, path) },
  )
  await tracker.track({ id: "repo", path: repo, kind: "workspace" })
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  const ledger: ThreadCheckpointInput["ledger"] = {
    settled: () => tracker.settled(),
    track: async () => {},
    head: (repository) => [...tracker.rootStates().values()].find((state) => state.root.path === repository)?.root.head,
    partition: (checkout, thread) => partition(view, checkout, thread),
  }
  const abs = (path: string) => join(repo, path)
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(join(abs(path), ".."), { recursive: true })
    writeFileSync(abs(path), content)
    utimesSync(abs(path), clock.now() / 1000, clock.now() / 1000)
    events.changed(abs(path))
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
  const capture = async (options: Partial<ThreadCheckpointInput> = {}) =>
    captureThreadCheckpoint({ git: runner, ledger, thread: "T1", repoRoot: repo, branch: "mako/t1", folder: mkdtempSync(join(base, "out-")), ...options })
  /** A file of a checkpoint's work commit, read from its bundle in a clone of the remote. */
  const reader = join(base, "reader")
  const show = (taken: { file: string; checkpoint: { work: string } }, path: string) => {
    if (!existsSync(reader)) sh(base, "clone", "--quiet", remote, reader)
    sh(reader, "fetch", "--quiet", taken.file, "refs/mako/*:refs/read/*")
    return execFileSync("git", ["show", `${taken.checkpoint.work}:${path}`], { cwd: reader, encoding: "utf8" })
  }
  return { base, remote, repo, sh, git, clock, events, tracker, ledger, abs, write, mark, call, capture, show }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** T1 and T2 at work in one checkout, and the person between their turns. */
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
  await call("T1", "t3", "c4", [{ kind: "create", path: abs("src/new1.ts"), content: "export const one = 1\n" }], () => write("src/new1.ts", "export const one = 1\n"))
  await call("T1", "t3", "c5", [{ kind: "rename", from: abs("old.ts"), to: abs("renamed.ts") }], () => {
    renameSync(abs("old.ts"), abs("renamed.ts"))
    f.events.changed(abs("old.ts"))
    f.events.changed(abs("renamed.ts"))
  })
  await call("T1", "t3", "c6", [{ kind: "delete", path: abs("gone.ts") }], () => {
    rmSync(abs("gone.ts"))
    f.events.changed(abs("gone.ts"))
  })
  await call("T1", "t3", "c7", [{ kind: "write", path: abs("bin.dat") }], () => write("bin.dat", Buffer.from([9, 9, 0, 9])))
  await call("T1", "t3", "c8", [{ kind: "write", path: abs("huge.bin") }], () => write("huge.bin", Buffer.alloc(3 * 1024 * 1024, 7)))
  await call("T1", "t3", "c9", [{ kind: "create", path: abs("model.lfs"), content: "weights\n" }], () => write("model.lfs", "weights\n"))
  await call("T1", "t3", "c10", [{ kind: "create", path: abs("ignored/cache.ts"), content: "cache\n" }], () => write("ignored/cache.ts", "cache\n"))
  await call("T1", "t3", "c11", [{ kind: "create", path: abs("tool.sh"), content: "#!/bin/sh\n" }], () => {
    write("tool.sh", "#!/bin/sh\n")
    chmodSync(abs("tool.sh"), 0o755)
  })
  mark("turn", "T1", "t3", "end")
  // The person, with nothing running: a file of their own, a line in T1's file, and a file staged.
  clock.advance(5_000)
  write("person.ts", "export const p = 2\n")
  write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2", 30: "line 30 by the person" }))
  await f.tracker.settled()
  f.git("add", "person.ts")
  clock.advance(15_000)
  f.tracker.sweep()
}

/** Every file of a checkout but `.git`, with its bytes. */
function files(root: string): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === ".git") continue
      if (entry.isDirectory()) walk(path)
      else found.set(relative(root, path), readFileSync(path).toString("base64"))
    }
  }
  walk(root)
  return found
}

test("only the Thread's lines and files are in its checkpoint, over HEAD, and the checkout is untouched", async () => {
  const f = await fixture("only")
  await edits(f)
  const objects = f.git("count-objects", "-v")
  const refs = f.git("for-each-ref")
  const status = f.git("status", "--porcelain=v1", "--untracked-files=all")
  const index = readFileSync(join(f.repo, ".git", "index"))
  const before = files(f.repo)
  // The person's repository splits its index: a scratch index must still write no shared index into their `.git`.
  f.git("config", "core.splitIndex", "true")
  f.git("update-index", "--split-index")
  const shared = () => readdirSync(join(f.repo, ".git")).filter((name) => name.startsWith("sharedindex.")).sort()
  const sharedBefore = shared()
  const indexSplit = readFileSync(join(f.repo, ".git", "index"))

  const taken = await f.capture()
  assert.deepEqual(shared(), sharedBefore, "no sharedindex.* written into the person's .git")
  assert.equal(taken.unpushed, 1, "the commit the remote lacks is counted, to be named")
  const { checkpoint } = taken
  assert.equal(checkpoint.head, f.git("rev-parse", "HEAD"))
  assert.equal(checkpoint.branch, "mako/t1")
  assert.deepEqual(taken.took, ["bin.dat", "gone.ts", "old.ts", "renamed.ts", "shared.ts", "src/new1.ts", "tool.sh"])
  assert.deepEqual(taken.left.map((entry) => `${entry.path}:${entry.why}`).filter((entry) => !entry.startsWith("ignored/")), ["huge.bin:too-large", "model.lfs:lfs"])
  assert.ok(taken.left.every((entry) => !entry.path.startsWith("ignored/") || entry.why === "ignored"), "an ignored file is named as ignored if the journal holds it")

  // Capture wrote nothing into the checkout.
  assert.equal(f.git("count-objects", "-v"), objects, "no objects")
  assert.equal(f.git("for-each-ref"), refs, "no refs")
  assert.deepEqual(readFileSync(join(f.repo, ".git", "index")), indexSplit, "the index as it was")
  assert.ok(index.length > 0)
  assert.equal(f.git("status", "--porcelain=v1", "--untracked-files=all"), status)
  assert.deepEqual(files(f.repo), before, "the files as they were")

  // A clone of the remote applies it: HEAD, the Thread's branch, its changes uncommitted, and nothing of anyone else's.
  const machine = join(f.base, "machine")
  f.sh(f.base, "clone", "--quiet", f.remote, machine)
  await applyMoveCheckpoint(runner, machine, taken.file, checkpoint)
  const at = (path: string) => (existsSync(join(machine, path)) ? readFileSync(join(machine, path), "utf8") : null)
  assert.equal(f.sh(machine, "rev-parse", "HEAD"), checkpoint.head)
  assert.equal(f.sh(machine, "symbolic-ref", "--short", "HEAD"), "mako/t1")
  assert.equal(at("shared.ts"), lines(30, { 3: "line 3 by T1" }), "T1's line alone: not T2's, not the person's")
  assert.equal(at("src/new1.ts"), "export const one = 1\n")
  assert.equal(at("renamed.ts"), "export const old = 1\n")
  assert.equal(at("old.ts"), null)
  assert.equal(at("gone.ts"), null)
  assert.deepEqual([...readFileSync(join(machine, "bin.dat"))], [9, 9, 0, 9])
  assert.equal(at("new2.ts"), null, "T2's file stays behind")
  assert.equal(at("person.ts"), "export const p = 1\n", "the person's edit, staged, stays behind")
  assert.equal(at("pre.ts"), "before tracking\n", "a change nobody can be named for stays behind")
  assert.equal(at("local.ts"), "committed here\n", "a commit the remote lacks came in the bundle")
  assert.equal(at("huge.bin"), null)
  assert.equal(at("model.lfs"), null)
  assert.equal(at("ignored/cache.ts"), null)
  assert.equal(f.sh(machine, "ls-files", "-s", "tool.sh"), "", "a file the Thread made stays untracked")
  assert.ok(statSync(join(machine, "tool.sh")).mode & 0o100, "and executable")
  assert.ok(Number.parseInt(f.sh(machine, "ls-files", "-s", "run.sh").split(" ")[0]!, 8) & 0o111, "an untouched file keeps its mode")
  assert.equal(f.sh(machine, "diff", "--cached", "--name-only"), "", "nothing staged: the person's index isn't the Thread's")
  assert.deepEqual(f.sh(machine, "status", "--porcelain=v1", "--untracked-files=all").split("\n").map((line) => line.trim()).sort(), ["?? renamed.ts", "?? src/new1.ts", "?? tool.sh", "D gone.ts", "D old.ts", "M bin.dat", "M shared.ts"])
})

test("the same Thread changes make the same bundle, whatever the person does; the Thread's next edit changes it", async () => {
  const f = await fixture("same")
  await edits(f)
  const first = await f.capture()
  assert.equal((await f.capture()).checkpoint.sha256, first.checkpoint.sha256, "byte for byte")
  f.clock.advance(1_000)
  f.write("person.ts", "export const p = 3\n")
  f.write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2", 20: "line 20 by the person", 30: "line 30 by the person" }))
  await f.tracker.settled()
  f.clock.advance(15_000)
  f.tracker.sweep()
  const after = await f.capture()
  assert.equal(after.checkpoint.sha256, first.checkpoint.sha256, "the person's edits never reach it")
  assert.equal(after.checkpoint.work, first.checkpoint.work)
  f.mark("turn", "T1", "t9", "start")
  await f.call("T1", "t9", "c90", [{ kind: "modify", path: f.abs("shared.ts"), edits: [{ old: "line 5\n", new: "line 5 by T1\n" }] }], () =>
    f.write("shared.ts", lines(30, { 3: "line 3 by T1", 5: "line 5 by T1", 15: "line 15 by T2", 20: "line 20 by the person", 30: "line 30 by the person" })))
  f.mark("turn", "T1", "t9", "end")
  const next = await f.capture()
  assert.notEqual(next.checkpoint.sha256, first.checkpoint.sha256)
  assert.equal(f.show(next, "shared.ts"), lines(30, { 3: "line 3 by T1", 5: "line 5 by T1" }))
})

test("read on the journal's worker, the partition and the checkpoint are the same as read on the host's thread", async () => {
  const f = await fixture("worker")
  await edits(f)
  const reader = new JournalReader(f.tracker.store.path)
  try {
    const onThread = await f.ledger.partition(f.repo, "T1")
    const onWorker = await reader.partition(f.repo, "T1")
    assert.deepEqual(onWorker.files, onThread.files, "what the journal committed, divided the same")
    const here = await f.capture()
    const there = await f.capture({ ledger: { ...f.ledger, partition: (checkout, thread) => reader.partition(checkout, thread) } })
    assert.equal(there.checkpoint.sha256, here.checkpoint.sha256)
  } finally {
    reader.close()
  }
})

test("past the total the largest files are left out and named; the rest stay", async () => {
  const f = await fixture("total")
  await edits(f)
  const small = await f.capture({ maxBytes: 64 })
  assert.deepEqual(small.left.filter((entry) => entry.why === "over-total").map((entry) => entry.path), ["shared.ts"])
  assert.ok(small.took.includes("bin.dat") && !small.took.includes("shared.ts"))
})

test("refused: a checkout mid-merge, one with no commits, and a journal that hasn't caught up", async () => {
  const f = await fixture("refused")
  await edits(f)

  // The journal's view of a file isn't what's on disk: asked again, then refused.
  const stale: Partition = { checkout: f.repo, thread: "T1", roots: [{ root: "repo", path: f.repo, head: null }], files: [{ root: "repo", path: "shared.ts", move: "lines", current: contentRef(Buffer.from("not this")), thread: { kind: "absent" }, remaining: { kind: "absent" } }], whole: [], uncertain: [], unattributed: [], ms: 0 }
  const head = f.git("rev-parse", "HEAD")
  const staleLedger: ThreadCheckpointInput["ledger"] = { settled: async () => {}, track: async () => {}, head: () => head, partition: () => stale }
  await assert.rejects(f.capture({ ledger: staleLedger }), { name: "ThreadCheckpointRefused", kind: "changing" })
  // Its record of HEAD is behind a commit.
  await assert.rejects(f.capture({ ledger: { ...staleLedger, head: () => "0".repeat(40), partition: f.ledger.partition } }), { name: "ThreadCheckpointRefused", kind: "changing" })

  // Mid-merge, in this scratch repository.
  f.git("reset", "-q", "--hard")
  f.git("clean", "-q", "-fd")
  f.git("checkout", "-q", "-b", "side", "HEAD~1")
  writeFileSync(join(f.repo, "person.ts"), "side\n")
  f.git("commit", "-q", "-am", "side")
  f.git("checkout", "-q", "main")
  writeFileSync(join(f.repo, "person.ts"), "main\n")
  f.git("commit", "-q", "-am", "main")
  try {
    f.git("merge", "-q", "side")
  } catch {}
  await assert.rejects(f.capture(), { name: "ThreadCheckpointRefused", kind: "in-progress" })

  // No commits.
  const empty = mkdtempSync(join(tmpdir(), "mako-thread-checkpoint-empty-"))
  f.sh(empty, "init", "-q")
  await assert.rejects(f.capture({ repoRoot: empty }), { name: "ThreadCheckpointRefused", kind: "no-commits" })
})

/** T1 edits a line of a shared file, makes a file and deletes one; T2 and the person edit beside it. Nothing left out. */
async function plainEdits(f: Fixture) {
  const { clock, write, mark, call, abs } = f
  clock.advance(1_000)
  mark("turn", "T1", "p1", "start")
  await call("T1", "p1", "p1c1", [{ kind: "modify", path: abs("shared.ts"), edits: [{ old: "line 3\n", new: "line 3 by T1\n" }] }], () => write("shared.ts", lines(30, { 3: "line 3 by T1" })))
  await call("T1", "p1", "p1c2", [{ kind: "create", path: abs("src/new1.ts"), content: "export const one = 1\n" }], () => write("src/new1.ts", "export const one = 1\n"))
  await call("T1", "p1", "p1c3", [{ kind: "delete", path: abs("gone.ts") }], () => {
    rmSync(abs("gone.ts"))
    f.events.changed(abs("gone.ts"))
  })
  mark("turn", "T1", "p1", "end")
  clock.advance(1_000)
  mark("turn", "T2", "p2", "start")
  await call("T2", "p2", "p2c1", [{ kind: "modify", path: abs("shared.ts"), edits: [{ old: "line 15\n", new: "line 15 by T2\n" }] }], () => write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2" })))
  mark("turn", "T2", "p2", "end")
  clock.advance(5_000)
  write("person.ts", "export const p = 2\n")
  write("shared.ts", lines(30, { 3: "line 3 by T1", 15: "line 15 by T2", 30: "line 30 by the person" }))
  await f.tracker.settled()
  clock.advance(15_000)
  f.tracker.sweep()
}

const leaveLedger = (f: Fixture) => ({ ...f.ledger, heard: () => f.tracker.settled(), partition: (checkout: string, thread: string) => f.ledger.partition(checkout, thread), mako: (write: Parameters<typeof f.tracker.mako>[0]) => f.tracker.mako(write) })

test("back from going away, a Thread the cloud took leaves the project folder: only its own changes, all at once", async () => {
  const f = await fixture("leave")
  await plainEdits(f)
  const taken = await f.capture()
  assert.deepEqual(taken.versions.map((each) => each.path), ["gone.ts", "shared.ts", "src/new1.ts"])
  const leave = new CheckoutLeave(join(f.base, "leaving"), runner, () => {})
  const outcome = await leave.leave("T1", f.repo, [{ root: f.repo, versions: taken.versions }], leaveLedger(f))
  assert.equal(outcome.kind, "left", JSON.stringify(outcome))
  const at = (path: string) => (existsSync(f.abs(path)) ? readFileSync(f.abs(path), "utf8") : null)
  assert.equal(at("shared.ts"), lines(30, { 15: "line 15 by T2", 30: "line 30 by the person" }), "T1's line went; T2's and the person's stay")
  assert.equal(at("src/new1.ts"), null, "the file it made went")
  assert.equal(at("gone.ts"), "export const gone = 1\n", "the file it deleted is back")
  assert.equal(at("person.ts"), "export const p = 2\n", "the person's file as they left it")
  assert.equal(await leave.stayed("T1"), undefined)
  assert.ok(outcome.kind === "left" && f.git("rev-parse", "--verify", outcome.backup), "the project folder before it is kept")
})

test("a file of the Thread's someone touched since: nothing leaves, and what stayed is kept for its row", async () => {
  const f = await fixture("stay")
  await plainEdits(f)
  const taken = await f.capture()
  const before = files(f.repo)
  f.clock.advance(2_000)
  f.write("src/new1.ts", "export const one = 1 // and the person's note\n")
  await f.tracker.settled()
  const ledger = leaveLedger(f)
  const leave = new CheckoutLeave(join(f.base, "leaving"), runner, () => {})
  const outcome = await leave.leave("T1", f.repo, [{ root: f.repo, versions: taken.versions }], ledger)
  assert.equal(outcome.kind, "stayed")
  assert.ok(outcome.kind === "stayed" && outcome.paths.includes("src/new1.ts"), JSON.stringify(outcome))
  const after = files(f.repo)
  before.set("src/new1.ts", after.get("src/new1.ts")!)
  assert.deepEqual(after, before, "nothing else changed")
  assert.ok((await new CheckoutLeave(join(f.base, "leaving"), runner, () => {}).stayed("T1"))?.includes("src/new1.ts"), "kept on disk for the row")
})

test("a change of the Thread's the cloud never got (left out of its checkpoint): nothing leaves", async () => {
  const f = await fixture("never-got")
  await edits(f)
  const taken = await f.capture()
  const leave = new CheckoutLeave(join(f.base, "leaving"), runner, () => {})
  const outcome = await leave.leave("T1", f.repo, [{ root: f.repo, versions: taken.versions }], leaveLedger(f))
  assert.equal(outcome.kind, "stayed")
  assert.ok(outcome.kind === "stayed" && outcome.paths.includes("huge.bin"), "the file too large to carry stays, and so does the rest")
  assert.equal(readFileSync(f.abs("shared.ts"), "utf8"), lines(30, { 3: "line 3 by T1", 15: "line 15 by T2", 30: "line 30 by the person" }))
})


test("a Thread's changes leave the project folder only where the cloud has them all: every checkpoint the note carried, and the machine says it applied", () => {
  const [a, b, b2] = ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
  const one = [{ root: "/p/api", sha256: a, changes: 2 }]
  const two = [...one, { root: "/p/web", sha256: b, changes: 1 }]
  assert.equal(cloudHasAll(one, [a], [a]), undefined, "one repository, its checkpoint noted and applied: it leaves")
  assert.equal(cloudHasAll(two, [a, b], [b, a]), undefined, "two, both noted and both applied, in any order: both leave")
  assert.match(cloudHasAll(two, [a], [a]) ?? "", /\/p\/web/, "two, the note carried the first's alone: the second's change stays, and so does the first's")
  assert.match(cloudHasAll(two, [a, b], [a]) ?? "", /didn't apply \/p\/web/, "the machine applied the first's alone: nothing leaves")
  assert.equal(cloudHasAll([...one, { root: "/p/web", sha256: b, changes: 0 }], [a], [a]), undefined, "a second with no change of the Thread's has nothing to lose")
  assert.match(cloudHasAll(two, [a, b], undefined) ?? "", /didn't say which checkpoints/, "an account that doesn't say what it applied: nothing leaves, whatever was sent")
  assert.match(cloudHasAll(two, [a, b], []) ?? "", /didn't apply/, "it said it applied none: nothing leaves")
  assert.match(cloudHasAll(two, undefined, [a, b]) ?? "", /no going-away note/, "no note recorded here")
  assert.match(cloudHasAll([...one, { root: "/p/web", sha256: b2, changes: 1 }], [a, b], [a, b]) ?? "", /\/p\/web/, "the second acknowledged anew after the note went: that one isn't on the machine")
  assert.match(cloudHasAll([], [a], [a]) ?? "", /nothing/)
})
