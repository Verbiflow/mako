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
const fresh = await service.prepare(randomUUID(), project, "Newest", "newest")
assert.equal(git(fresh.path, "rev-parse", "HEAD"), git(project, "rev-parse", "origin/main"))
const moved = await service.prepare(randomUUID(), project, "Here", "head")
assert.equal(git(moved.path, "rev-parse", "HEAD"), git(project, "rev-parse", "HEAD"))

threads.close()
rmSync(root, { recursive: true, force: true })
console.log("worktree start points: ok")
