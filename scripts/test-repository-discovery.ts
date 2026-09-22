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
  await assert.rejects(workspace.selectRepository(first, second), /current workspace/)
  await assert.rejects(workspace.selectRepository(root, tmpdir()), /current workspace/)
  const reading = workspace.status()
  const switching = workspace.selectRepository(root, first)
  assert.equal((await switching).root, first)
  assert.equal((await reading).root, first, "An in-flight refresh follows the latest selection")
  const host = new AgentHost("repository-test", () => {})
  try {
    host.setForeground(false)
    await host.start(root)
    await host.gitStatus()
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
