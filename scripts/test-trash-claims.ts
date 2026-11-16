import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Git } from "@mako/git"
import { WorktreeSpares } from "@mako/host/workspaces/worktree-spares"

// The trash the installed app and a dev profile share: a folder another process is moving or emptying carries its
// claim, and a sweep here leaves it; one a crash left (no claim, or a claim whose process is gone) is emptied, and
// its repository pruned, so the branch its worktree held can go.
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-trash-claims-")))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const until = async (what: string, done: () => boolean, ms = 15_000) => {
  for (const deadline = Date.now() + ms; !done(); await delay(25)) assert.ok(Date.now() < deadline, what)
}
try {
  const repo = join(root, "repo")
  mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "user.name", "Test")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "first")
  const spares = new WorktreeSpares(new Git(), join(root, "spares"), (repoRoot) => join(root, "projects", repoRoot.replaceAll("/", "_")))
  const trash = join(root, "spares", "trash")
  mkdirSync(trash, { recursive: true })
  /** A worktree on its own branch, moved into the trash by hand, as a process mid-move (or a crash) leaves it. */
  const inTrash = (branch: string) => {
    const path = join(root, branch)
    git(repo, "worktree", "add", "-q", "-b", branch, path)
    const aside = join(trash, branch)
    renameSync(path, aside)
    return aside
  }
  const held = (branch: string) => git(repo, "worktree", "list", "--porcelain").includes(`branch refs/heads/${branch}`)

  // Another process's claim: a live pid beside the folder.
  const other = spawn("sleep", ["60"], { stdio: "ignore" })
  const claimed = inTrash("claimed")
  writeFileSync(`${claimed}.claim`, JSON.stringify({ pid: other.pid, at: Date.now() }))
  await spares.sweep()
  await delay(500)
  assert.ok(existsSync(claimed), "a folder another live process claims is left to it")
  other.kill()
  await new Promise((done) => other.once("exit", done))
  await spares.sweep()
  await until("its claimer gone, the folder is emptied", () => !existsSync(claimed))
  await until("and its claim with it", () => !existsSync(`${claimed}.claim`))
  await until("and its repository pruned, so the branch is free", () => !held("claimed"))
  git(repo, "branch", "-D", "claimed")

  // A claim past a day claims nothing, even when its pid is alive again (reused): here the live pid is this process.
  const stale = inTrash("stale")
  writeFileSync(`${stale}.claim`, JSON.stringify({ pid: process.pid, at: Date.now() - 25 * 60 * 60_000 }))
  await spares.sweep()
  await until("a claim past a day leaves its folder to the sweep", () => !existsSync(stale))
  await until("and the stale claim with it", () => !existsSync(`${stale}.claim`))
  git(repo, "branch", "-D", "stale")

  // A claim that can't be written moves nothing, and leaves nothing marked as being emptied.
  chmodSync(trash, 0o500)
  try {
    await assert.rejects(spares.setAside(repo, join(root, "never-moved")), /EACCES|permission/i)
  } finally {
    chmodSync(trash, 0o700)
  }
  assert.equal(spares["emptying"].size, 0, "a failed claim leaves no folder marked as being emptied")

  // A crash mid-move: no claim at all.
  const orphan = inTrash("orphan")
  assert.ok(held("orphan"), "Git still records the moved worktree on its branch")
  await spares.sweep()
  await until("an orphan is emptied", () => !existsSync(orphan))
  await until("and its repository pruned", () => !held("orphan"))
  git(repo, "branch", "-D", "orphan")
  console.log("trash claims: another live process's claim is honoured, a dead one's and a day-old one's aren't, a claim that can't be written moves nothing, and an emptied orphan's repository is pruned so its branch can go")
} finally {
  rmSync(root, { recursive: true, force: true })
}
