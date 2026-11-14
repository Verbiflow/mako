import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { mock } from "node:test"
import { Git } from "@mako/git"
import type { HistoryMark } from "@mako/host/contracts/watcher-child"
import type { FileHistory, HistoryOptions } from "@mako/host/workspaces/watch-backend"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"

/**
 * A turn's checkpoint, which its agent waits for, is the last one taken of its workspace when nothing it holds can
 * have changed since: the watcher's history names no path there and lost none, HEAD is where it was and the index
 * stages the same. Anything else is a capture. On 2026-11-12 every message waited 1.2-3.9 s on its checkpoint at the
 * scale of the person's day, and twice that on their 12,661-file checkout.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-checkpoint-reuse-")))
const cwd = join(root, "workspace")
mkdirSync(cwd)
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
git("init", "-q", "-b", "main")
git("config", "user.email", "test@localhost")
git("config", "user.name", "Test")
writeFileSync(join(cwd, "a.txt"), "a\n")
git("add", ".")
git("commit", "-qm", "first")

// The watcher's history as a script: each change it heard is numbered, and a mark is the number reached.
const heard: { at: number; path: string }[] = []
let count = 0
let lost = false
let reads = 0
const history: FileHistory = {
  mark: async (): Promise<HistoryMark> => ({ id: String(count), at: String(BigInt(Date.now()) * 1_000_000n) }),
  since: async (mark: HistoryMark, roots: readonly string[], options?: HistoryOptions) => {
    reads++
    const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)
    const paths = heard.filter((change) => change.at > Number(mark.id) && roots.some((root) => inside(change.path, root)) && !options?.exclude?.some((folder) => inside(change.path, folder))).map((change) => change.path)
    return { paths, lost: lost ? [...roots] : [], ignored: [] }
  },
}
const edit = (path: string, content: string, told = true) => {
  writeFileSync(join(cwd, path), content)
  if (told) heard.push({ at: ++count, path: join(cwd, path) })
}

const store = new WorkspaceSnapshots(new Git(), join(root, "store"))
store.followHistory(history)
const turn = async () => {
  const id = randomUUID()
  const began = performance.now()
  const before = await store.beginRun(id, cwd)
  const ms = performance.now() - began
  const after = await store.endRun(id)
  return { before, after, ms }
}

try {
  const first = await turn()
  assert.notEqual(first.before.id, first.after.id, "the first turn takes its own checkpoint")

  // Nothing changed since the last turn ended: the next goes on that checkpoint, without a capture.
  const quiet = await turn()
  assert.equal(quiet.before.id, first.after.id, "a turn after a quiet wait starts from the last checkpoint")
  assert.notEqual(quiet.after.id, quiet.before.id, "its end is checkpointed as ever")

  // A file the watcher heard change: a capture, holding the change.
  edit("a.txt", "edited\n")
  const edited = await turn()
  assert.notEqual(edited.before.id, quiet.after.id, "a change in the working tree is captured")

  // Changes in Git's own folder are HEAD's and the index's to say, not the history's.
  heard.push({ at: ++count, path: join(cwd, ".git", "index") })
  const gitFolder = await turn()
  assert.equal(gitFolder.before.id, edited.after.id, "a write in .git alone (a status refreshing the index) changes nothing")

  // The index stages something new and the history never said so: the staged digest does.
  edit("b.txt", "b\n", false)
  git("add", "b.txt")
  const staged = await turn()
  assert.notEqual(staged.before.id, gitFolder.after.id, "what the index stages is compared, whatever the history said")

  // HEAD moved: a commit changes nothing in the working tree.
  git("commit", "-qm", "second")
  const committed = await turn()
  assert.notEqual(committed.before.id, staged.after.id, "a moved HEAD is captured")

  // The history lost events there: nothing it says can be trusted.
  lost = true
  const unsure = await turn()
  assert.notEqual(unsure.before.id, committed.after.id, "a history that lost events is a capture")
  lost = false

  // History that can't be read is a capture too.
  const reading = history.since
  history.since = async () => { throw new Error("watcher gone") }
  const unread = await turn()
  assert.notEqual(unread.before.id, unsure.after.id, "a history that can't be read is a capture")
  history.since = reading

  // An ignore rule outside the working tree changed: the history can't see it, its file's stamp does.
  writeFileSync(join(cwd, ".git", "info", "exclude"), "*.log\n")
  const excluded = await turn()
  assert.notEqual(excluded.before.id, unread.after.id, "a changed info/exclude is captured")

  // Another turn in the same workspace: its checkpoint names the runs that share it, so it's always its own.
  const other = randomUUID()
  await store.beginRun(other, cwd)
  const sharing = randomUUID()
  const shared = await store.beginRun(sharing, cwd)
  assert.ok(shared.shared?.includes(other), "a shared workspace's checkpoint names the other run")
  const sharedEnd = await store.endRun(sharing)
  assert.ok(sharedEnd.shared?.includes(other), "and so does its end")
  await store.endRun(other)
  // The last one taken there named the other run (`other`'s end shares nothing now): a turn alone next never reuses
  // one that names others.
  const sharingAgain = randomUUID()
  await store.beginRun(sharingAgain, cwd)
  const third = randomUUID()
  await store.beginRun(third, cwd)
  await store.endRun(third)
  await store.endRun(sharingAgain)
  const alone = await turn()
  assert.equal(alone.before.shared, undefined, "a turn alone never starts on a checkpoint that names other runs")

  // From the last checkpoint: the turn is told once what changed is read, and the agent writes at once. The checkpoint
  // still holds the workspace as the turn started, tree for tree what a whole capture of that moment takes.
  const treeOf = (storeRoot: string, id: string) => {
    const db = new DatabaseSync(join(storeRoot, "snapshots.sqlite"), { readOnly: true })
    try {
      const row = z.object({ value: z.string() }).optional().parse(db.prepare("SELECT value FROM snapshots WHERE id = ?").get(id))
      return row ? z.object({ tree: z.string() }).loose().parse(JSON.parse(row.value)).tree : undefined
    } finally {
      db.close()
    }
  }
  await turn()
  edit("a.txt", "the person's edit\n")
  mkdirSync(join(cwd, "dir"), { recursive: true })
  edit("dir/new.txt", "new in a new folder\n")
  mkdirSync(join(cwd, "gone"), { recursive: true })
  rmSync(join(cwd, "b.txt"))
  heard.push({ at: ++count, path: join(cwd, "b.txt") })
  edit("ignored.log", "an ignored file\n")
  const whole = new WorkspaceSnapshots(new Git(), join(root, "whole"))
  const expected = treeOf(join(root, "whole"), (await whole.capture(cwd)).id)
  whole.close()
  const saved = () => {
    const db = new DatabaseSync(join(root, "store", "snapshots.sqlite"), { readOnly: true })
    try {
      return z.object({ n: z.number() }).parse(db.prepare("SELECT count(*) AS n FROM snapshots").get()).n
    } finally {
      db.close()
    }
  }
  const savedBefore = saved()
  let savedWhenTold = -1
  const racing = randomUUID()
  let toldAt = -1
  const began = performance.now()
  const raced = store.beginRun(racing, cwd, () => {
    toldAt = performance.now() - began
    savedWhenTold = saved()
    // The agent's first writes, the moment it's told: a changed file again, a new one, one deleted.
    edit("a.txt", "the agent's write\n")
    edit("agent.txt", "the agent's new file\n")
    rmSync(join(cwd, "dir", "new.txt"))
    heard.push({ at: ++count, path: join(cwd, "dir", "new.txt") })
  })
  const startedOn = await raced
  const savedAt = performance.now() - began
  assert.equal(savedWhenTold, savedBefore, "the turn was told before its checkpoint was saved")
  assert.equal(treeOf(join(root, "store"), startedOn.id), expected, "the checkpoint is the workspace as the turn started, the agent's writes left out")
  await store.endRun(racing)
  console.log(JSON.stringify({ toldMs: Math.round(toldAt), savedMs: Math.round(savedAt) }))

  // Reused, the wait is the history's read and two Git reads, not a capture.
  const settled = await turn()
  const again = await turn()
  assert.equal(again.before.id, settled.after.id)
  console.log(JSON.stringify({ captureMs: Math.round(settled.ms), reusedMs: Math.round(again.ms), historyReads: reads }))
  // Each run has its own sharing metadata, while its repository parts can reuse unchanged content.
  {
    const folder = join(root, "shared-project")
    const storeRoot = join(root, "shared-project-store")
    const runner = new Git()
    const grouped = new WorkspaceSnapshots(runner, storeRoot)
    grouped.followHistory(history)
    // App has no HEAD or user index; backend has tracked content. Both kinds must retain exact incremental content.
    for (const name of ["app", "backend"]) {
      const repository = join(folder, name)
      mkdirSync(repository, { recursive: true })
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository })
      writeFileSync(join(repository, "file.txt"), `${name}\n`)
      if (name === "backend") {
        execFileSync("git", ["add", "file.txt"], { cwd: repository })
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "first"], { cwd: repository })
      }
    }
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const original = runner.run.bind(runner)
    const commands = mock.method(runner, "run", original)
    const trees = (where: string, id: string) => {
      const db = new DatabaseSync(join(where, "snapshots.sqlite"), { readOnly: true })
      try {
        const row = z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM groups WHERE id=?").get(id))
        const group = z.object({ parts: z.array(z.object({ path: z.string(), id: z.string() })) }).parse(JSON.parse(row.value))
        return Object.fromEntries(group.parts.map(part => {
          const saved = z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM snapshots WHERE id=?").get(part.id))
          return [part.path, z.object({ tree: z.string() }).parse(JSON.parse(saved.value)).tree]
        }))
      } finally { db.close() }
    }
    try {
      const first = await grouped.beginRun(ids[0], folder)
      commands.mock.resetCalls()
      const second = await grouped.beginRun(ids[1], folder)
      assert.notEqual(second.id, first.id, "sharing metadata is a fresh run boundary")
      assert.deepEqual(second.shared, [ids[0]], "the group names the other run, not itself")
      for (const name of ["app", "backend"]) {
        const file = join(folder, name, "file.txt")
        writeFileSync(file, "changed before the third turn\n")
        heard.push({ at: ++count, path: file })
      }
      const third = await grouped.beginRun(ids[2], folder)
      assert.deepEqual([...third.shared ?? []].sort(), ids.slice(0, 2).sort())
      assert.equal(commands.mock.calls.some(call => call.arguments[0].args.includes("ls-files") && call.arguments[0].args.includes("-v")), false, "sharing a project folder must not force full repository-part captures")
      const wholeRoot = join(root, "shared-project-whole")
      const whole = new WorkspaceSnapshots(new Git(), wholeRoot)
      try {
        const expected = await whole.capture(folder)
        assert.deepEqual(trees(storeRoot, third.id), trees(wholeRoot, expected.id), "shared incremental parts hold the full capture's exact content")
      } finally { whole.close() }
    } finally {
      commands.mock.restore()
      for (const id of ids) grouped.abandonRun(id)
      grouped.close()
    }
  }
  console.log("shared groups: distinct run metadata with reusable exact repository content")

  console.log("checkpoint reuse: a quiet workspace's turn starts on its last checkpoint; a change, a staged path, a moved HEAD, a lost or unread history, or a shared workspace is captured")
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}
