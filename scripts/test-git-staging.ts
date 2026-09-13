import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { WorkspaceGit, waitForIndexWrites } from "../electron/host-git.ts"
import { collectCommitPatch } from "../electron/commit-patch.ts"
import { AgentHost } from "../electron/host.ts"
import type { GitStatus, HostEvent } from "../electron/shared.ts"

class DelayedGitHost extends AgentHost {
  readonly reads: Array<(git: GitStatus) => void> = []
  override gitStatus(): Promise<GitStatus> {
    return new Promise((resolve) => this.reads.push(resolve))
  }
}

const run = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "mako-staging-queue-"))
const root = join(directory, "repo")
const other = join(directory, "other")
const command = (...args: string[]) => run("git", args, { cwd: root })
process.env.GIT_AUTHOR_NAME = "Staging Test"
process.env.GIT_AUTHOR_EMAIL = "staging@example.test"
process.env.GIT_COMMITTER_NAME = "Staging Test"
process.env.GIT_COMMITTER_EMAIL = "staging@example.test"
try {
  await mkdir(root)
  await mkdir(other)
  await command("init", "-q")
  await run("git", ["init", "-q"], { cwd: other })
  const paths = Array.from({ length: 40 }, (_, index) => `file-${index}.txt`)
  for (const path of paths)
    await writeFile(join(root, path), `Change in ${path}\n`)
  await writeFile(join(other, paths[0]), "Other workspace\n")
  const first = new WorkspaceGit(root)
  const second = new WorkspaceGit(root)
  const canonical = await first.root()
  assert.ok(canonical)
  await second.root()
  const writes = paths.map(async (path, index) => {
    const workspace = index % 2 ? first : second
    await workspace.stage([path])
    await workspace.status()
  })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    waitForIndexWrites(canonical, AbortSignal.timeout(1)),
    /abort|timeout/i
  )
  await Promise.all(writes)
  assert.equal(
    (await command("diff", "--cached", "--name-only", "-z")).stdout
      .split("\0")
      .filter(Boolean).length,
    paths.length
  )
  await Promise.all(
    paths.map((path, index) => (index % 2 ? second : first).unstage([path]))
  )
  assert.equal((await command("diff", "--cached", "--name-only")).stdout, "")
  await Promise.all([
    first.stage([paths[0]]),
    second.unstage([paths[0]]),
    first.stage([paths[0]]),
  ])
  assert.equal(
    (await command("diff", "--cached", "--name-only")).stdout.trim(),
    paths[0]
  )
  await first.unstageAll()
  const queued = paths.map((path) => first.stage([path]))
  const patch = await collectCommitPatch(root, AbortSignal.timeout(20_000))
  await Promise.all(queued)
  assert.equal(patch.scope, "staged")
  assert.equal(
    patch.files,
    paths.length,
    "Diff collection must wait for admitted staging writes"
  )
  await first.unstageAll()
  const failures = await Promise.allSettled([
    first.stage(["missing.txt"]),
    second.stage([paths[1]]),
  ])
  assert.equal(failures[0]?.status, "rejected")
  assert.equal(failures[1]?.status, "fulfilled")
  await first.unstageAll()
  const switching = new WorkspaceGit(root)
  await switching.root()
  const pending = switching.stage([paths[0]])
  switching.setCwd(other)
  await pending
  assert.equal(
    (await run("git", ["diff", "--cached", "--name-only"], { cwd: other }))
      .stdout,
    ""
  )
  await first.unstageAll()
  await Promise.all([
    first.stage([paths[0]]),
    second.commit("Commit only the queued selection"),
  ])
  assert.equal(
    (await command("ls-tree", "--name-only", "HEAD")).stdout.trim(),
    paths[0]
  )
  await writeFile(join(root, ".git", "index.lock"), "test-owned lock")
  await assert.rejects(first.unstage([paths[0]]))
  await rm(join(root, ".git", "index.lock"))
  assert.equal(
    (await command("ls-files")).stdout.trim(),
    paths[0],
    "A failed reset must not fall back to removing a committed index entry"
  )
  await first.stage([paths[1]])
  await first.unstageAll()
  assert.equal((await command("diff", "--cached", "--name-only")).stdout, "")
  // A staged deletion is in neither the index nor the worktree. Selecting it
  // again, alone or inside a folder-wide selection, is a no-op rather than a
  // missing file, so a bulk stage that happens to include one goes through.
  await command("rm", "-q", paths[0])
  await first.stage([paths[0]])
  await first.stage([paths[0], paths[2]])
  assert.equal(
    (await command("diff", "--cached", "--name-status")).stdout.trim(),
    `D\t${paths[0]}\nA\t${paths[2]}`,
    "Re-staging a staged deletion must not fail the selection around it"
  )
  await first.unstage([paths[0]])
  assert.equal(
    (await command("ls-files", "--", paths[0])).stdout.trim(),
    paths[0],
    "Unstaging a deletion restores the index entry"
  )
  await command("checkout", "--", paths[0])
  await first.unstageAll()
  assert.equal((await command("diff", "--cached", "--name-only")).stdout, "")
  await writeFile(join(root, "*"), "The literal star file\n")
  await writeFile(join(root, ".env"), "PRIVATE_VALUE=never-in-model-input\n")
  await first.stage(["*", ".env"])
  assert.equal(
    (await command("diff", "--cached", "--name-only", "-z")).stdout
      .split("\0")
      .filter(Boolean).length,
    2,
    "Selected filenames must not expand as globs"
  )
  const literal = await collectCommitPatch(root, AbortSignal.timeout(10_000))
  assert.ok(literal.text.includes("The literal star file"))
  assert.ok(
    !literal.text.includes("never-in-model-input"),
    "A wildcard filename must not bypass sensitive-file exclusions"
  )
  await first.unstage(["*", ".env"])
  assert.equal((await command("diff", "--cached", "--name-only")).stdout, "")
  const events: HostEvent[] = []
  const host = new DelayedGitHost("staging-order", (event) =>
    events.push(event)
  )
  const oldRead = host.pushGit()
  const newRead = host.pushGit()
  assert.equal(host.reads.length, 2)
  host.reads[1]({ cwd: root, ahead: 0, behind: 0, files: [], branch: "new" })
  await newRead
  host.reads[0]({ cwd: root, ahead: 0, behind: 0, files: [], branch: "old" })
  await oldRead
  assert.equal(events.filter((event) => event.type === "git").length, 1)
  assert.ok(
    events.some((event) => event.type === "git" && event.git.branch === "new")
  )
  await host.dispose()
  console.log(
    "Git staging: concurrent windows, ordered rapid toggles, cancellation of waiting readers, complete diff barriers, failure recovery, workspace isolation, literal paths, queued commits and stale snapshot rejection passed"
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
