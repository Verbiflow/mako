import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadStore } from "../electron/thread-store.js"
import { ThreadWorktreeService } from "../electron/thread-worktrees.js"
import { WorktreeStarts } from "../electron/worktree-start.js"

/**
 * Where a new Thread's branch starts: the project folder's branch, or its
 * upstream when only the upstream moved; what a minute-old fetch skips; and
 * that an unreachable remote still answers with what was fetched last.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-worktree-start-")))

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function commit(cwd: string, name: string) {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`)
  git(cwd, "add", ".")
  git(cwd, "commit", "-q", "-m", name)
}

function identify(cwd: string) {
  git(cwd, "config", "user.email", "test@example.invalid")
  git(cwd, "config", "user.name", "Test")
}

const origin = join(root, "origin.git")
git(root, "init", "-q", "--bare", "-b", "main", origin)
const seed = join(root, "seed")
git(root, "clone", "-q", origin, seed)
identify(seed)
commit(seed, "first")
git(seed, "push", "-q", "origin", "main")

const project = join(root, "project")
git(root, "clone", "-q", origin, project)
identify(project)

let now = 1_000_000
const starts = new WorktreeStarts(() => now)

let point = await starts.point(project, true)
assert.deepEqual(point.standing, { kind: "level" })
assert.equal(point.from, "main")
assert.equal(point.commit, git(project, "rev-parse", "HEAD"))
assert.equal(point.fetched?.failed, null, "a reachable remote fetches")

// Someone else pushed: the folder doesn't know until a fetch, and a minute-old fetch isn't repeated.
commit(seed, "theirs")
git(seed, "push", "-q", "origin", "main")
point = await starts.point(project, true)
assert.deepEqual(point.standing, { kind: "level" }, "a fetch younger than a minute isn't repeated")
now += 61_000
point = await starts.point(project, true)
assert.deepEqual(point.standing, { kind: "behind", behind: 1 })
assert.equal(point.from, "origin/main")
assert.equal(point.commit, git(seed, "rev-parse", "HEAD"), "only the upstream moved: start from it")
assert.notEqual(point.commit, git(project, "rev-parse", "HEAD"))

// Two asks at once share one fetch.
commit(seed, "again")
git(seed, "push", "-q", "origin", "main")
now += 61_000
const [one, two] = await Promise.all([starts.point(project, true), starts.point(project, true)])
assert.deepEqual(one.standing, { kind: "behind", behind: 2 })
assert.deepEqual(two.standing, one.standing)

// Unpushed work in the folder is kept, whether or not the upstream moved too.
commit(project, "mine")
point = await starts.point(project, false)
assert.deepEqual(point.standing, { kind: "diverged", ahead: 1, behind: 2 })
assert.equal(point.from, "main")
assert.equal(point.commit, git(project, "rev-parse", "HEAD"))
git(project, "reset", "-q", "--hard", "origin/main")
commit(project, "mine again")
point = await starts.point(project, false)
assert.deepEqual(point.standing, { kind: "ahead", ahead: 1 })
assert.equal(point.commit, git(project, "rev-parse", "HEAD"))

// A remote that can't be reached answers with what was fetched last.
const url = git(project, "remote", "get-url", "origin")
git(project, "remote", "set-url", "origin", join(root, "gone.git"))
now += 61_000
point = await starts.point(project, true)
assert.equal(point.fetched?.failed, "Couldn't reach origin; using what was fetched last.")
assert.deepEqual(point.standing, { kind: "ahead", ahead: 1 })
git(project, "remote", "set-url", "origin", url)

// No upstream, and no branch at all.
git(project, "switch", "-q", "-c", "local-only")
point = await starts.point(project, true)
assert.deepEqual(point.standing, { kind: "alone" })
assert.equal(point.fetched, null, "nothing to fetch")
git(project, "switch", "-q", "--detach", "HEAD~1")
point = await starts.point(project, false)
assert.deepEqual(point.standing, { kind: "detached" })
assert.equal(point.from, point.commit.slice(0, 7))

// The service starts a new Thread's branch there, and a move where the changes were made.
git(project, "switch", "-q", "main")
git(project, "reset", "-q", "--hard", "origin/main~1")
assert.deepEqual((await starts.point(project, false)).standing, { kind: "behind", behind: 1 })
const threads = new ThreadStore(join(root, "threads.sqlite"))
const service = new ThreadWorktreeService(join(root, "worktrees"), threads)
assert.equal((await service.startPoint(project, false))?.from, "origin/main")
assert.equal(await service.startPoint(root, false), null, "outside Git there is nothing to start from")
const fresh = await service.prepare(randomUUID(), project, "Newest", { kind: "newest" })
assert.equal(git(fresh.path, "rev-parse", "HEAD"), git(project, "rev-parse", "origin/main"))
const moved = await service.prepare(randomUUID(), project, "Here", { kind: "head" })
assert.equal(git(moved.path, "rev-parse", "HEAD"), git(project, "rev-parse", "HEAD"))

// Branches to choose from: local ones, and a remote's only where no local one has the name.
git(seed, "switch", "-q", "-c", "remote-only")
commit(seed, "remote work")
git(seed, "push", "-q", "origin", "remote-only")
git(seed, "switch", "-q", "-c", "pr-branch", "main")
commit(seed, "pull request work")
git(seed, "push", "-q", "origin", "pr-branch")
git(origin, "update-ref", "refs/pull/7/head", git(seed, "rev-parse", "HEAD"))
git(project, "fetch", "-q", "origin", "remote-only:refs/remotes/origin/remote-only")
git(project, "switch", "-q", "-c", "feature")
commit(project, "feature work")
git(project, "switch", "-q", "main")
const branches = await service.branches(project)
const names = branches.map((branch) => branch.name)
assert.ok(names.includes("feature") && names.includes("origin/remote-only"), names.join(", "))
assert.ok(!names.includes("origin/main"), "a remote's branch with a local namesake is the local one")
assert.ok(!names.includes("origin/HEAD"))
assert.equal(branches.find((branch) => branch.name === "main")?.checkedOut, project)
assert.equal(branches.find((branch) => branch.name === "feature")?.checkedOut, null)
assert.ok(branches.find((branch) => branch.name === fresh.branch)?.checkedOut, "a Thread's branch is checked out in its worktree")

// A new branch from another one.
const fromFeature = await service.prepare(randomUUID(), project, "On top of feature", { kind: "from", ref: "feature" })
assert.match(fromFeature.branch, /^mako\//)
assert.equal(git(fromFeature.path, "rev-parse", "HEAD"), git(project, "rev-parse", "feature"))
await assert.rejects(service.prepare(randomUUID(), project, "Gone", { kind: "from", ref: "no-such-branch" }), /isn't in project anymore/)

// Working on a branch that exists: it's checked out as it is, and abandoning the start keeps it.
const onFeatureId = randomUUID()
const onFeature = await service.prepare(onFeatureId, project, "Work on feature", { kind: "branch", branch: "feature" })
assert.equal(onFeature.branch, "feature")
assert.equal(git(onFeature.path, "rev-parse", "HEAD"), git(project, "rev-parse", "feature"))
await service.abandon(onFeatureId)
assert.equal(git(project, "rev-parse", "--verify", "--quiet", "refs/heads/feature"), git(project, "rev-parse", "feature"), "an adopted branch is never deleted")
await assert.rejects(service.prepare(randomUUID(), project, "Main", { kind: "branch", branch: "main" }), /checked out in your project folder/)

// A remote's branch gets a local one that tracks it.
const onRemote = await service.prepare(randomUUID(), project, "Remote", { kind: "branch", branch: "origin/remote-only" })
assert.equal(onRemote.branch, "remote-only")
assert.equal(git(project, "rev-parse", "--abbrev-ref", "remote-only@{upstream}"), "origin/remote-only")

// A pull request: its branch fetched from the remote, or from a fork through refs/pull.
const onPull = await service.prepare(randomUUID(), project, "Pull", { kind: "pull", number: 6, branch: "pr-branch", cross: false })
assert.equal(onPull.branch, "pr-branch")
assert.equal(git(onPull.path, "rev-parse", "HEAD"), git(seed, "rev-parse", "pr-branch"))
const onFork = await service.prepare(randomUUID(), project, "Fork", { kind: "pull", number: 7, branch: "patch-1", cross: true })
assert.equal(onFork.branch, "pr-7")
assert.equal(git(onFork.path, "rev-parse", "HEAD"), git(seed, "rev-parse", "pr-branch"))

threads.close()
rmSync(root, { recursive: true, force: true })
console.log("worktree start points: ok")
