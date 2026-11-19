import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { subscribe } from "node:diagnostics_channel"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { promisify } from "node:util"
import { parseGitConfig } from "@mako/git"
import { HostJobs } from "@mako/host/base/host-jobs"
import { CheckoutRepositories, folderRepository, ListedRepositories } from "@mako/host/conversations/index"

/**
 * A Thread worktree's branch on GitHub, as its row says it (`ListedRepositories`): one tracked after the row was made
 * is said within a reading's interval though nothing else about the row changes, and a folder the rows stopped asking
 * for isn't read again. What it says is read from the files Git keeps, with no Git process (`CheckoutRepositories`),
 * and agrees with what Git says (`folderRepository`). `npm run test:listed-repositories`
 */

const run = promisify(execFile)
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-listed-repositories-")))
after(() => rmSync(root, { recursive: true, force: true }))
// The person's Git configuration for this test is a scratch file: what both Git and the file read take for it.
const personal = join(root, "gitconfig")
writeFileSync(personal, "")
process.env.GIT_CONFIG_GLOBAL = personal
const repo = join(root, "repo")
const git = (...args: string[]) => run("git", ["-C", repo, ...args])
const reader = { output: async (cwd: string, args: readonly string[]) => (await run("git", ["-C", cwd, ...args])).stdout }
/** Every process this test's own process starts, however it is started: reading a folder's repository starts none. */
let spawned = 0
subscribe("child_process", () => { spawned++ })

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
  const files = new CheckoutRepositories({ ask: (folder) => folderRepository(reader, folder) })
  const repositories = new ListedRepositories({ read: (folder) => (reads.push(folder), files.read(folder)), changed: () => changes++, againMs: 50, jobs: new HostJobs() })
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

test("a folder's repository is read from Git's files, with no process, and says what Git says", async () => {
  const folder = join(root, "files")
  const at = (...args: string[]) => run("git", ["-C", folder, ...args])
  await run("git", ["init", "-q", "-b", "main", folder])
  await at("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first")
  let asks = 0
  const files = new CheckoutRepositories({ ask: (cwd) => (asks++, folderRepository(reader, cwd)) })
  // What Git itself says, as the host asked it before: null where it says the folder has no repository on GitHub.
  const asked = (cwd: string) => folderRepository(reader, cwd).catch(() => null)
  const agrees = async (cwd: string, expected: { url: string; branch?: string } | null, what: string) => {
    const before = spawned
    assert.deepEqual(await files.read(cwd), expected, what)
    assert.equal(spawned, before, `no process was started to read ${what}`)
    assert.deepEqual(await asked(cwd), expected, `Git says the same: ${what}`)
    assert.ok(spawned > before, "the count hears a process when one starts")
  }

  await agrees(folder, null, "a repository with no origin")
  await at("remote", "add", "origin", "git@github.com:octocat/Hello-World.git")
  await agrees(folder, { url: "https://github.com/octocat/Hello-World" }, "an origin added since is seen")
  await at("update-ref", "refs/remotes/origin/main", "HEAD")
  await at("branch", "--quiet", "--set-upstream-to=origin/main")
  await agrees(folder, { url: "https://github.com/octocat/Hello-World", branch: "main" }, "an upstream set since")
  await at("switch", "-q", "-c", "mako/proof")
  await agrees(folder, { url: "https://github.com/octocat/Hello-World" }, "another branch checked out, with no upstream")
  await at("update-ref", "refs/remotes/origin/pushed", "HEAD")
  await at("branch", "--quiet", "--set-upstream-to=origin/pushed")
  await agrees(folder, { url: "https://github.com/octocat/Hello-World", branch: "pushed" }, "its upstream, under another name")
  await at("pack-refs", "--all")
  await agrees(folder, { url: "https://github.com/octocat/Hello-World", branch: "pushed" }, "an upstream whose ref Git packed")
  await at("update-ref", "-d", "refs/remotes/origin/pushed")
  await agrees(folder, { url: "https://github.com/octocat/Hello-World" }, "an upstream whose branch was pruned is none")
  await at("remote", "set-url", "origin", "https://github.com/octocat/Spoon-Knife.git")
  await agrees(folder, { url: "https://github.com/octocat/Spoon-Knife" }, "a changed origin")
  await at("switch", "-q", "--detach")
  await agrees(folder, { url: "https://github.com/octocat/Spoon-Knife" }, "a detached HEAD")
  await at("switch", "-q", "main")
  await agrees(folder, { url: "https://github.com/octocat/Spoon-Knife", branch: "main" }, "back on the tracked branch")

  // A linked worktree's branch is its own; the origin and the upstreams are its repository's.
  const linked = join(root, "linked")
  await at("worktree", "add", "-q", "-b", "mako/linked", linked)
  await agrees(linked, { url: "https://github.com/octocat/Spoon-Knife" }, "a linked worktree on a new branch")
  await at("update-ref", "refs/remotes/origin/mako/linked", "HEAD")
  await run("git", ["-C", linked, "branch", "--quiet", "--set-upstream-to=origin/mako/linked"])
  await agrees(linked, { url: "https://github.com/octocat/Spoon-Knife", branch: "mako/linked" }, "a linked worktree's upstream")
  await agrees(join(linked, "."), { url: "https://github.com/octocat/Spoon-Knife", branch: "mako/linked" }, "asked again, unchanged")

  // A folder in no repository says so each time for the price of a look up its path, and is found once it is one.
  const plain = join(root, "plain", "inner")
  mkdirSync(plain, { recursive: true })
  const before = spawned
  for (let asks = 0; asks < 3; asks += 1) assert.equal(await files.read(plain), null)
  assert.equal(spawned, before, "a folder in no repository is asked about without a process, however often")
  await run("git", ["init", "-q", "-b", "main", join(root, "plain")])
  await run("git", ["-C", plain, "remote", "add", "origin", "https://github.com/octocat/Hello-World"])
  await agrees(plain, { url: "https://github.com/octocat/Hello-World" }, "a repository made around the folder since")

  // Not on GitHub: no repository to continue in.
  await run("git", ["-C", plain, "remote", "set-url", "origin", "https://example.com/octocat/Hello-World.git"])
  assert.equal(asks, 0, "none of it needed Git's own answer: an SSH origin and its https form are one repository as written")
  // An origin that is no GitHub repository as written may be an alias Git knows, so Git says: once, and it stands.
  await run("git", ["-C", plain, "remote", "set-url", "origin", "https://example.com/octocat/Hello-World.git"])
  assert.equal(await files.read(plain), null, "an origin that isn't on GitHub")
  assert.equal(await asked(plain), null)
  assert.equal(asks, 1)
})

test("where the files don't say all Git would, Git is asked: once for each change, and its answer stands meanwhile", async () => {
  const folder = join(root, "aliased")
  const at = (...args: string[]) => run("git", ["-C", folder, ...args])
  await run("git", ["init", "-q", "-b", "main", folder])
  await at("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first")
  let asks = 0
  const files = new CheckoutRepositories({ ask: (cwd) => (asks++, folderRepository(reader, cwd)) })
  const asked = (cwd: string) => folderRepository(reader, cwd).catch(() => null)
  /** The reading agrees with Git, having asked it `expected` times more; asked again with nothing changed, it starts no process. */
  const reads = async (expected: number, repository: { url: string; branch?: string } | null, what: string) => {
    const before = asks
    assert.deepEqual(await files.read(folder), repository, what)
    assert.deepEqual(await asked(folder), repository, `Git says the same: ${what}`)
    assert.equal(asks - before, expected, `${what}: Git asked ${expected} time(s)`)
    const started = spawned
    for (let again = 0; again < 3; again += 1) assert.deepEqual(await files.read(folder), repository)
    assert.equal(asks - before, expected, `${what}: not asked again while nothing changed`)
    assert.equal(spawned, started, `${what}: no process while nothing changed`)
  }

  // An alias from the person's configuration: the origin as written names no repository, and Git's reading of it does.
  writeFileSync(personal, '[url "https://github.com/"]\n\tinsteadOf = gh:\n')
  await at("remote", "add", "origin", "gh:octocat/Hello-World")
  await reads(1, { url: "https://github.com/octocat/Hello-World" }, "an origin written with the person's insteadOf alias")
  await at("update-ref", "refs/remotes/origin/main", "HEAD")
  await at("branch", "--quiet", "--set-upstream-to=origin/main")
  await reads(1, { url: "https://github.com/octocat/Hello-World", branch: "main" }, "its upstream, set since")
  await at("switch", "-q", "-c", "mako/other")
  await reads(1, { url: "https://github.com/octocat/Hello-World" }, "another branch checked out")
  await at("switch", "-q", "main")
  await reads(1, { url: "https://github.com/octocat/Hello-World", branch: "main" }, "and back")

  // A rule that rewrites an origin which reads as a repository already: Git's reading is the one said.
  writeFileSync(personal, '[url "https://github.com/octocat/Spoon-Knife"]\n\tinsteadOf = https://github.com/mirror/spoon\n')
  await at("remote", "set-url", "origin", "https://github.com/mirror/spoon")
  await reads(1, { url: "https://github.com/octocat/Spoon-Knife", branch: "main" }, "an origin the person's rule rewrites to another repository")

  // The rule gone, the files say it all again, and no process starts.
  writeFileSync(personal, "")
  const before = spawned
  assert.deepEqual(await files.read(folder), { url: "https://github.com/mirror/spoon", branch: "main" })
  assert.equal(spawned, before, "with no rule and no include, the files alone are read")
  await reads(0, { url: "https://github.com/mirror/spoon", branch: "main" }, "the ordinary case")

  // The origin in a file the repository's configuration includes: the file read sees none, and Git names it.
  await at("remote", "remove", "origin")
  writeFileSync(join(folder, ".git", "extra.config"), '[remote "origin"]\n\turl = git@github.com:octocat/Included.git\n')
  await at("config", "include.path", "extra.config")
  await reads(1, { url: "https://github.com/octocat/Included" }, "an origin from an included file")
  // The same for a file the person's configuration includes.
  await at("config", "--unset", "include.path")
  await reads(0, null, "no include, no origin")
  writeFileSync(join(root, "more.config"), '[url "https://github.com/"]\n\tinsteadOf = hub:\n')
  writeFileSync(personal, `[include]\n\tpath = ${join(root, "more.config")}\n`)
  await at("remote", "add", "origin", "hub:octocat/Hello-World")
  await reads(1, { url: "https://github.com/octocat/Hello-World" }, "an alias from a file the person's configuration includes")
  writeFileSync(personal, "")
})

test("a Git configuration file reads as Git reads it", () => {
  const config = parseGitConfig([
    "# a comment",
    "[core]",
    "\tbare = false ; trailing comment",
    "\tignorecase",
    '[remote "origin"]',
    '\turl = "git@github.com:octocat/Hello-World.git"  # quoted',
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "\tfetch = +refs/pull/*/head:refs/remotes/origin/pr/*",
    '[branch "feature/a \\"quoted\\" one"]',
    "\tRemote = origin",
    "\tmerge = refs/heads/feature/a \\",
    "continued",
    "[Branch.Legacy]",
    "\tmerge = refs/heads/legacy",
  ].join("\n"))
  assert.deepEqual(config.get("core.bare"), ["false"])
  assert.deepEqual(config.get("core.ignorecase"), ["true"], "a key with no value is true")
  assert.deepEqual(config.get("remote.origin.url"), ["git@github.com:octocat/Hello-World.git"])
  assert.deepEqual(config.get("remote.origin.fetch"), ["+refs/heads/*:refs/remotes/origin/*", "+refs/pull/*/head:refs/remotes/origin/pr/*"])
  assert.deepEqual(config.get('branch.feature/a "quoted" one.remote'), ["origin"])
  assert.deepEqual(config.get('branch.feature/a "quoted" one.merge'), ["refs/heads/feature/a continued"])
  assert.deepEqual(config.get("branch.legacy.merge"), ["refs/heads/legacy"])
})
