import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { Git } from "@mako/git"
import type { HistoryMark } from "@mako/host/contracts/watcher-child"
import type { FileHistory, HistoryOptions } from "@mako/host/workspaces/watch-backend"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"

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

  // Another turn in the same workspace: its checkpoint names the runs that share it, so it's always its own.
  const other = randomUUID()
  await store.beginRun(other, cwd)
  const sharing = randomUUID()
  const shared = await store.beginRun(sharing, cwd)
  assert.ok(shared.shared?.includes(other), "a shared workspace's checkpoint names the other run")
  await store.endRun(sharing)
  await store.endRun(other)

  // Reused, the wait is the history's read and two Git reads, not a capture.
  const settled = await turn()
  const again = await turn()
  assert.equal(again.before.id, settled.after.id)
  console.log(JSON.stringify({ captureMs: Math.round(settled.ms), reusedMs: Math.round(again.ms), historyReads: reads }))
  console.log("checkpoint reuse: a quiet workspace's turn starts on its last checkpoint; a change, a staged path, a moved HEAD, a lost or unread history, or a shared workspace is captured")
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}
