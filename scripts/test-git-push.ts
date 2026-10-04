import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { WorkspaceGit } from "../electron/host-git.ts"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-push-"))
const repository = join(root, "repository")
const remote = join(root, "remote.git")
process.env.GIT_AUTHOR_NAME = "Push fixture"
process.env.GIT_AUTHOR_EMAIL = "push@example.test"
process.env.GIT_COMMITTER_NAME = "Push fixture"
process.env.GIT_COMMITTER_EMAIL = "push@example.test"
process.env.GIT_CONFIG_COUNT = "4"
process.env.GIT_CONFIG_KEY_0 = "remote.origin.url"
process.env.GIT_CONFIG_VALUE_0 = remote
process.env.GIT_CONFIG_KEY_1 = "remote.origin.fetch"
process.env.GIT_CONFIG_VALUE_1 = "+refs/heads/*:refs/remotes/origin/*"
process.env.GIT_CONFIG_KEY_2 = "branch.topic.remote"
process.env.GIT_CONFIG_VALUE_2 = "origin"
process.env.GIT_CONFIG_KEY_3 = "branch.topic.merge"
process.env.GIT_CONFIG_VALUE_3 = "refs/heads/main"
const git = (...args: string[]) => run("git", args, { cwd: repository })
try {
  await mkdir(repository)
  await run("git", ["init", "--bare", "-q", remote])
  await git("init", "-b", "main", "-q")
  await writeFile(join(repository, "file.txt"), "First\n")
  await git("add", "file.txt")
  await git("commit", "-qm", "First")
  const workspace = new WorkspaceGit(repository)
  await workspace.push("main")
  const first = (await git("rev-parse", "HEAD")).stdout.trim()
  assert.equal(
    (
      await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])
    ).stdout.trim(),
    first
  )
  await git("checkout", "-qb", "topic")
  await assert.rejects(workspace.push("main"), /branch changed/)
  await writeFile(join(repository, "file.txt"), "Second\n")
  await git("add", "file.txt")
  await git("commit", "-qm", "Second")
  await workspace.push("topic")
  const next = (await git("rev-parse", "HEAD")).stdout.trim()
  assert.equal(
    (
      await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])
    ).stdout.trim(),
    next,
    "Push must honor the configured destination, not assume the local branch name"
  )
  await assert.rejects(
    run("git", [
      "--git-dir",
      remote,
      "rev-parse",
      "--verify",
      "refs/heads/topic",
    ])
  )
  console.log(
    "Git push: actual local bare-remote publishing, branch validation and explicit configured refspec passed; no network remote used"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
