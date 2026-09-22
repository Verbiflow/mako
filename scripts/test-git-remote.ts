import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceGit } from "../electron/host-git.ts"
import { closeKiriEngine } from "../electron/kiri-engine.ts"
import type { GitRemoteAction } from "../electron/shared.ts"

const root = await mkdtemp(join(tmpdir(), "mako-remote-"))
const local = join(root, "local"), peer = join(root, "peer"), remote = join(root, "remote.git")
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Git fixture", GIT_AUTHOR_EMAIL: "git@example.invalid", GIT_COMMITTER_NAME: "Git fixture", GIT_COMMITTER_EMAIL: "git@example.invalid" })
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const commit = async (cwd: string, name: string, contents: string) => { await writeFile(join(cwd, name), contents); git(cwd, "add", name); git(cwd, "commit", "-qm", `Update ${name}`) }
try {
  await mkdir(local)
  git(root, "init", "--bare", "-q", remote)
  git(local, "init", "-qb", "main")
  await commit(local, "shared.txt", "base\n")
  git(local, "remote", "add", "origin", remote)
  git(local, "push", "-u", "origin", "main")
  git(root, "clone", "-qb", "main", remote, peer)
  const workspace = new WorkspaceGit(local)
  const act = async (action: GitRemoteAction) => { const status = await workspace.status(); return workspace.remote({ cwd: local, branch: "main", head: status.head, action }) }
  await commit(peer, "incoming.txt", "remote\n"); git(peer, "push")
  let result = await act("fetch")
  assert.equal(result.status.behind, 1)
  result = await act("pull")
  assert.equal(result.problem, undefined)
  assert.equal(result.status.behind, 0)
  assert.equal(await readFile(join(local, "incoming.txt"), "utf8"), "remote\n")
  await commit(local, "local.txt", "local\n")
  await commit(peer, "next.txt", "next\n"); git(peer, "push")
  await assert.rejects(workspace.push("main"))
  result = await act("fetch")
  assert.equal(result.status.ahead, 1); assert.equal(result.status.behind, 1)
  result = await act("pull")
  assert.equal(result.problem?.kind, "incoming")
  result = await act("merge")
  assert.equal(result.problem, undefined); assert.equal(result.status.behind, 0); assert.equal(result.status.ahead, 2)
  await workspace.push("main")
  git(peer, "pull", "--ff-only")
  await commit(local, "shared.txt", "local conflict\n")
  await commit(peer, "shared.txt", "remote conflict\n"); git(peer, "push")
  result = await act("merge")
  assert.equal(result.problem?.kind, "conflicts")
  assert.equal(result.status.operation, "merge")
  assert.equal(result.status.files.find(file => file.path === "shared.txt")?.status, "conflicted")
  result = await act("continue")
  assert.equal(result.problem?.kind, "conflicts")
  result = await act("abort")
  assert.equal(result.problem, undefined); assert.equal(result.status.operation, undefined)
  assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "local conflict\n")
  await act("merge")
  await writeFile(join(local, "shared.txt"), "resolved\n")
  await workspace.stage(["shared.txt"])
  result = await act("continue")
  assert.equal(result.problem, undefined); assert.equal(result.status.operation, undefined); assert.equal(result.status.behind, 0)
  await workspace.push("main")
  git(peer, "pull", "--ff-only")
  await commit(peer, "dirty.txt", "incoming\n"); git(peer, "push")
  await writeFile(join(local, "shared.txt"), "keep my edits\n")
  result = await act("pull")
  assert.equal(result.problem?.kind, "dirty")
  assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "keep my edits\n")
  console.log("Git remote workflow passed: fetch, pull, rejected push, divergence, merge, conflicts, abort, resolution, continue, push, and dirty-edit preservation")
} finally { await closeKiriEngine(); await rm(root, { recursive: true, force: true }) }
