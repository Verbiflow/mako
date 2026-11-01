import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { promisify } from "node:util"
import { folderRepository, ListedRepositories } from "@mako/host/conversations/index"

/**
 * A Thread worktree's branch on GitHub, as its row says it (`ListedRepositories`): one tracked after the row was made
 * is said within a reading's interval though nothing else about the row changes, and a folder the rows stopped asking
 * for isn't read again. `npm run test:listed-repositories`
 */

const run = promisify(execFile)
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-listed-repositories-")))
after(() => rmSync(join(root, "repo"), { recursive: true, force: true }))
const repo = join(root, "repo")
const git = (...args: string[]) => run("git", ["-C", repo, ...args])
const reader = { output: async (cwd: string, args: readonly string[]) => (await run("git", ["-C", cwd, ...args])).stdout }

async function until(what: string, done: () => boolean, ms = 5_000) {
  for (const deadline = Date.now() + ms; !done(); await new Promise((resolve) => setTimeout(resolve, 10)))
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
}

test("a branch tracked after its row was made is said, and a folder no longer listed isn't read", async () => {
  await run("git", ["init", "-q", "-b", "main", repo])
  await git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first")
  await git("remote", "add", "origin", "https://github.com/octocat/Hello-World.git")
  await git("update-ref", "refs/remotes/origin/main", "HEAD")
  await git("switch", "-q", "-c", "mako/proof")

  let changes = 0
  const reads: string[] = []
  const repositories = new ListedRepositories({ read: (folder) => (reads.push(folder), folderRepository(reader, folder)), changed: () => changes++, againMs: 50 })
  after(() => repositories.stop())
  const row = () => repositories.listing(() => repositories.of(repo) ?? null)

  assert.equal(row(), null, "the first ask reads it; the row says nothing until the reading is in")
  await until("the first reading", () => changes === 1)
  assert.deepEqual(row(), { url: "https://github.com/octocat/Hello-World" })

  await git("branch", "--quiet", "--set-upstream-to=origin/main")
  await until("the tracked branch read again with no row asking", () => changes === 2)
  assert.deepEqual(row(), { url: "https://github.com/octocat/Hello-World", branch: "main" })

  repositories.listing(() => undefined)
  const kept = reads.length
  await until("read again after rows that couldn't be made yet", () => reads.length > kept)

  repositories.listing(() => [])
  const before = reads.length
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(reads.length, before, "a folder the last rows didn't ask for isn't read again")
  assert.equal(changes, 2)
})
