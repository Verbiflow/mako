import assert from "node:assert/strict"
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { discoverRepositories } from "../electron/repository-discovery.ts"
import { AgentHost } from "../electron/host.ts"
import { WorkspaceFiles } from "../electron/host-workspace.ts"
import { WorkspaceGit } from "../electron/host-git.ts"
import { closeKiriEngine } from "../electron/kiri-engine.ts"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-repositories-")))
try {
  const first = join(root, "mako")
  const second = join(root, "group", "backend")
  for (const path of [first, second]) {
    await mkdir(path, { recursive: true })
    execFileSync("git", ["init", "-q", path])
  }
  await writeFile(join(first, "changed.txt"), "fixture")
  await mkdir(join(first, "ignore", "hidden", ".git"), { recursive: true })
  await mkdir(join(root, "node_modules", "hidden", ".git"), { recursive: true })
  await symlink(root, join(root, "cycle"))
  assert.deepEqual((await discoverRepositories(root)).roots, [second, first].sort())
  const cold = new WorkspaceGit(root)
  assert.equal((await cold.selectRepository(root, first)).root, first, "A fresh Git owner accepts a repository shown by an earlier owner without requiring a status call first")
  assert.equal((await cold.selectRepository(root, second)).root, second)
  assert.equal((await cold.selectRepository(root, first)).root, first)
  const changing = new WorkspaceGit(root)
  const staleSelection = changing.selectRepository(root, first)
  changing.setCwd(first)
  await assert.rejects(staleSelection, /workspace changed/, "Discovery must not apply a selection after the workspace changes")
  await assert.rejects(new WorkspaceGit(root).selectRepository(root, tmpdir()), /current workspace/)
  const workspace = new WorkspaceGit(root)
  const status = await workspace.status()
  assert.equal(status.root, second)
  assert.equal(status.cwd, root)
  assert.deepEqual(status.repositories?.map(repo => [repo.root, repo.changes]), [[second, 0], [first, 1]])
  assert.equal((await new WorkspaceGit(first).status()).root, first)
  const selected = await workspace.selectRepository(root, first)
  assert.equal(selected.root, first)
  assert.equal(selected.cwd, root, "Selecting a repository must preserve the workspace")
  assert.equal(selected.files[0]?.path, "changed.txt")
  const workspaceFiles = new WorkspaceFiles(root, workspace)
  assert.ok((await workspaceFiles.list()).some(file => file.path === "mako/changed.txt" && file.changed))
  assert.equal((await workspaceFiles.read("mako/changed.txt")).contents, "fixture")
  await writeFile(join(second, "changed.txt"), "backend")
  await workspace.stage(["changed.txt"])
  assert.equal(execFileSync("git", ["-C", first, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "changed.txt")
  assert.equal(execFileSync("git", ["-C", second, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "")
  const backend = await workspace.selectRepository(root, second)
  assert.equal(backend.files[0]?.staged, false)
  const preview = await workspace.diff("changed.txt")
  assert.equal(preview.newFile?.contents, "backend")
  assert.equal(workspace.cwd, root)
  await assert.rejects(workspace.selectRepository(first, second), /workspace changed/)
  await assert.rejects(workspace.selectRepository(root, tmpdir()), /current workspace/)
  const reading = workspace.status()
  const switching = workspace.selectRepository(root, first)
  assert.equal((await switching).root, first)
  assert.equal((await reading).root, first, "An in-flight refresh follows the latest selection")
  const host = new AgentHost("repository-test", () => {})
  try {
    host.setForeground(false)
    await host.start(root)
    const session = host.meta().sessionId
    await host.selectGitRepository(root, first)
    assert.equal(host.workspace, root)
    assert.equal(host.meta().sessionId, session)
    assert.equal(host.gitWorkspace, first)
    assert.equal((await host.readWorkspaceFile("mako/changed.txt")).contents, "fixture")
    await host.selectGitRepository(root, second)
    assert.equal(host.gitWorkspace, second)
    assert.equal(host.workspace, root)
  } finally { await host.dispose() }

  const changes = (status: Awaited<ReturnType<WorkspaceGit["status"]>>) => Object.fromEntries(status.repositories!.map(repo => [repo.label, repo.changes]))
  const tracked = new WorkspaceGit(root)
  assert.equal(tracked.noteChange("notes.txt"), true, "Before the first status every change counts")
  tracked.trackChanges(true)
  assert.deepEqual(changes(await tracked.status()), { "group/backend": 1, mako: 1 })
  assert.equal(tracked.noteChange("notes.txt"), false, "A file outside every discovered repository cannot move Git status")
  assert.equal(tracked.noteChange("group/notes.txt"), false)
  await writeFile(join(first, "second.txt"), "fixture")
  assert.deepEqual(changes(await tracked.status()), { "group/backend": 1, mako: 1 }, "An unchanged child summary is reused while the watcher is live")
  assert.equal(tracked.noteChange("mako/second.txt"), true)
  assert.deepEqual(changes(await tracked.status()), { "group/backend": 1, mako: 2 }, "A change inside a child re-reads that child")
  await writeFile(join(second, "selected.txt"), "fixture")
  assert.deepEqual(changes(await tracked.status()), { "group/backend": 2, mako: 2 }, "The selected repository's summary follows its fresh status")
  const added = join(root, "added")
  await mkdir(added)
  execFileSync("git", ["init", "-q", added])
  assert.equal(tracked.noteChange("added/.git/HEAD"), true, "A new repository re-runs discovery")
  assert.deepEqual(changes(await tracked.status()), { added: 0, "group/backend": 2, mako: 2 })
  await writeFile(join(first, "third.txt"), "fixture")
  assert.equal(tracked.noteChange(undefined), true, "An unnamed change forgets every summary")
  assert.equal(changes(await tracked.status()).mako, 3)
  tracked.trackChanges(false)
  await writeFile(join(first, "fourth.txt"), "fixture")
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(changes(await tracked.status()).mako, 4, "Without a watcher every refresh re-reads every child")

  const pushes: string[] = []
  const watching = new AgentHost("repository-watch-test", (event) => { if (event.type === "git") pushes.push(event.git.cwd) })
  try {
    await watching.start(root)
    await watching.gitStatus()
    const settle = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 5000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(label)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    await new Promise(resolve => setTimeout(resolve, 600))
    pushes.length = 0
    for (let index = 0; index < 5; index++) await writeFile(join(root, `noise-${index}.log`), String(index))
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.deepEqual(pushes, [], "Writes outside every repository must not refresh Git")
    await writeFile(join(first, "watched.txt"), "fixture")
    await settle(() => pushes.length > 0, "A write inside a repository must refresh Git")
  } finally { await watching.dispose() }

  const worktree = join(root, "worktree")
  await mkdir(worktree)
  await writeFile(join(worktree, ".git"), "gitdir: /fixture")
  assert.ok((await discoverRepositories(root)).roots.includes(worktree))
  assert.equal((await discoverRepositories(root, { maxDirectories: 1 })).limited, true)
  assert.equal((await discoverRepositories(root, { maxEntries: 1 })).limited, true)
  console.log("Repository discovery: nested roots, Git status, single-repo behavior, worktree markers, excluded trees, symlink cycles and limits passed")
} finally {
  await closeKiriEngine()
  await rm(root, { recursive: true, force: true })
}
