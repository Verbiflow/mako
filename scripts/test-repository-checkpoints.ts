import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-repository-checkpoints-")))
const runner = new Git()
const storage = join(root, "store")
const store = new WorkspaceSnapshots(runner, storage, {}, { repositoryObjects: true })
let historyReads = 0
store.followHistory({
  mark: async () => { historyReads++; throw new Error("native history unavailable") },
  since: async () => { historyReads++; throw new Error("native history unavailable") },
})
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim()
const write = (cwd: string, path: string, text: string) => writeFileSync(join(cwd, path), text)
const read = (cwd: string, path: string) => readFileSync(join(cwd, path), "utf8")
const init = (name: string, committed = true) => {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  git(cwd, "init", "-q", "-b", "main")
  write(cwd, "file", "initial\n")
  if (committed) {
    git(cwd, "add", ".")
    git(cwd, "commit", "-qm", "initial")
  }
  return cwd
}
const rewind = async (targetId: string) => {
  const preview = await store.preview(targetId)
  await store.restore({
    sourceId: randomUUID(), targetId, expectedId: preview.current.id,
    fork: { id: randomUUID(), provider: "test", point: { kind: "run", requestId: randomUUID() } },
  }, () => {})
}

try {
  const cwd = init("workspace")
  write(cwd, ".gitignore", "ignored\n")
  write(cwd, "file", "staged\n")
  git(cwd, "add", "file")
  write(cwd, "file", "unstaged\n")
  write(cwd, "untracked", "untracked before\n")
  write(cwd, "ignored", "ignored before\n")
  const index = readFileSync(join(cwd, ".git/index"))
  const head = git(cwd, "rev-parse", "HEAD")
  const id = randomUUID()
  const before = await store.beginRun(id, cwd)
  store.abandonRun(id)
  assert.deepEqual(readFileSync(join(cwd, ".git/index")), index, "capture preserves the user's exact index")
  assert.equal(historyReads, 0, "repository capture never asks native history, even when attached")
  assert.match(git(cwd, "rev-parse", `refs/mako/checkpoints/${before.id}`), /^[a-f0-9]{40,64}$/)
  assert.equal(existsSync(join(storage, before.id, "git")), false, "no private object store is created")
  write(cwd, "file", "agent\n")
  write(cwd, "untracked", "agent untracked\n")
  write(cwd, "created", "new\n")
  write(cwd, "ignored", "ignored after\n")
  git(cwd, "gc", "--prune=now")
  await rewind(before.id)
  assert.equal(read(cwd, "file"), "unstaged\n")
  assert.equal(git(cwd, "show", ":file"), "staged")
  assert.equal(read(cwd, "untracked"), "untracked before\n")
  assert.equal(read(cwd, "ignored"), "ignored after\n")
  assert.equal(existsSync(join(cwd, "created")), false)
  assert.equal(git(cwd, "rev-parse", "HEAD"), head)
  console.log("PASS: repository refs survive GC; rewind restores staging, unstaged and untracked files, leaving ignored files and HEAD alone")

  const worktree = join(root, "linked")
  git(cwd, "worktree", "add", "-q", "-b", "linked", worktree)
  write(worktree, "file", "linked before\n")
  const linked = await store.capture(worktree)
  write(worktree, "file", "linked after\n")
  await rewind(linked.id)
  assert.equal(read(worktree, "file"), "linked before\n")
  assert.equal(read(cwd, "file"), "unstaged\n")
  assert.equal(git(worktree, "rev-parse", `refs/mako/checkpoints/${linked.id}`), git(cwd, "rev-parse", `refs/mako/checkpoints/${linked.id}`))
  console.log("PASS: linked worktrees use their own index and files, sharing only objects and refs")

  const unborn = init("unborn", false)
  const first = await store.capture(unborn)
  write(unborn, "file", "unborn after\n")
  await rewind(first.id)
  assert.equal(read(unborn, "file"), "initial\n")
  assert.equal(existsSync(join(unborn, ".git/index")), false)
  console.log("PASS: unborn repository remains unborn with no real index after rewind")

  const sparse = init("sparse")
  mkdirSync(join(sparse, "inside"))
  mkdirSync(join(sparse, "outside"))
  write(sparse, "inside/a", "inside\n")
  write(sparse, "outside/b", "outside\n")
  git(sparse, "add", ".")
  git(sparse, "commit", "-qm", "folders")
  git(sparse, "sparse-checkout", "init", "--cone")
  git(sparse, "sparse-checkout", "set", "inside")
  write(sparse, "inside/a", "sparse before\n")
  const cone = await store.capture(sparse)
  write(sparse, "inside/a", "sparse after\n")
  await rewind(cone.id)
  assert.equal(read(sparse, "inside/a"), "sparse before\n")
  assert.equal(existsSync(join(sparse, "outside/b")), false)
  console.log("PASS: sparse checkout keeps excluded files absent")

  const sub = init("submodule-source")
  const parent = init("parent")
  git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub")
  git(parent, "commit", "-qm", "submodule")
  write(join(parent, "sub"), "file", "sub before\n")
  const group = await store.capture(parent)
  write(parent, "file", "parent after\n")
  write(join(parent, "sub"), "file", "sub after\n")
  await rewind(group.id)
  assert.equal(read(parent, "file"), "initial\n")
  assert.equal(read(join(parent, "sub"), "file"), "sub before\n")
  assert.equal(historyReads, 0)
  console.log("PASS: submodules capture and rewind as separate repository parts without history")
} finally {
  store.close()
  await runner.close()
  rmSync(root, { recursive: true, force: true })
}
