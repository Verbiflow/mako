import assert from "node:assert/strict"
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { discoverRepositories } from "../electron/repository-discovery.ts"
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
  const status = await new WorkspaceGit(root).status()
  assert.equal(status.root, undefined)
  assert.deepEqual(status.repositories?.map(repo => [repo.root, repo.changes]), [[second, 0], [first, 1]])
  assert.equal((await new WorkspaceGit(first).status()).root, first)
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
