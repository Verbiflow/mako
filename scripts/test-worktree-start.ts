import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadStore } from "../electron/thread-store.js"
import { ThreadWorktreeService } from "../electron/thread-worktrees.js"
import { succeeds } from "../electron/worktree-git.js"
import { WorktreeStarts } from "../electron/worktree-start.js"
import { ThreadIdSchema } from "../electron/contracts/thread-identity.js"
import type { WorktreeBranchPull, WorktreeSummary } from "../electron/contracts/thread-worktrees.js"
import { worktreeMark, worktreeMarkLabel, worktreeTip } from "../src/lib/worktree-marks.ts"
import { landState, readLandWith } from "../src/lib/worktree-landing.ts"

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
const placed = () => {
  const conversationId = randomUUID()
  threads.registerJournal({ conversationId, createdAt: Date.now(), bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
  return conversationId
}
assert.equal((await service.startPoint(project, false))?.from, "origin/main")
assert.equal(await service.startPoint(root, false), null, "outside Git there is nothing to start from")
const freshId = placed()
const fresh = await service.prepare(freshId, project, "Newest", { kind: "newest" })
assert.equal(git(fresh.path, "rev-parse", "HEAD"), git(project, "rev-parse", "origin/main"))
const movedId = placed()
const moved = await service.prepare(movedId, project, "Here", { kind: "head" })
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
const fromFeatureId = placed()
const fromFeature = await service.prepare(fromFeatureId, project, "On top of feature", { kind: "from", ref: "feature" })
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
const onRemoteId = placed()
const onRemote = await service.prepare(onRemoteId, project, "Remote", { kind: "branch", branch: "origin/remote-only" })
assert.equal(onRemote.branch, "remote-only")
assert.equal(git(project, "rev-parse", "--abbrev-ref", "remote-only@{upstream}"), "origin/remote-only")

// A pull request: its branch fetched from the remote, or from a fork through refs/pull.
const onPull = await service.prepare(randomUUID(), project, "Pull", { kind: "pull", number: 6, branch: "pr-branch", cross: false })
assert.equal(onPull.branch, "pr-branch")
assert.equal(git(onPull.path, "rev-parse", "HEAD"), git(seed, "rev-parse", "pr-branch"))
const onFork = await service.prepare(placed(), project, "Fork", { kind: "pull", number: 7, branch: "patch-1", cross: true })
assert.equal(onFork.branch, "pr-7")
assert.equal(git(onFork.path, "rev-parse", "HEAD"), git(seed, "rev-parse", "pr-branch"))

// Each worktree says where its branch started and how the start went.
const listed = (await service.list()).worktrees
const startOf = (path: string) => listed.find((worktree) => worktree.path === path)?.start
assert.equal(startOf(fresh.path)?.from, "origin/main")
assert.equal(startOf(moved.path)?.from, "main")
assert.equal(startOf(fromFeature.path)?.from, "feature")
assert.deepEqual([startOf(onRemote.path)?.from, startOf(onRemote.path)?.adopted], [null, true])
assert.ok((startOf(fresh.path)?.tookMs ?? -1) >= 0)

// Choosing the project folder while the worktree is made: the start goes ahead at once, and the worktree is given back.
const skippedId = randomUUID()
const making = service.prepare(skippedId, project, "Skipped", { kind: "newest" })
const waiting = service.unlessSkipped(skippedId, making)
service.skip(skippedId)
assert.equal(await waiting, undefined)
const skipped = await making
for (let tries = 0; existsSync(skipped.path) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 20))
assert.ok(!existsSync(skipped.path), "a skipped worktree is removed once it's made")
const kept = randomUUID()
const keptPath = (await service.unlessSkipped(kept, service.prepare(kept, project, "Kept", { kind: "newest" })))?.path
service.skip(kept)
assert.ok(keptPath && existsSync(keptPath), "skipping after the worktree is ready changes nothing")

// The rail's summaries: commits main doesn't have, uncommitted files, and the pull request by branch.
commit(moved.path, "thread work")
writeFileSync(join(moved.path, "scratch.txt"), "not yet\n")
const movedTip = git(moved.path, "rev-parse", "HEAD")
let asked = 0
const pulls = async (): Promise<WorktreeBranchPull[]> => {
  asked++
  return [
    { number: 9, title: "Here", url: "https://example.test/9", branch: moved.branch, state: "merged", head: movedTip, checks: "passed" },
    { number: 7, title: "Fork", url: "https://example.test/7", branch: "patch-1", state: "open", head: "abc", checks: "running" },
  ]
}
const summaryOf = async (path: string) => (await service.summaries(pulls)).find((summary) => summary.path === path)
const squashed = await summaryOf(moved.path)
assert.deepEqual([squashed?.into, squashed?.ahead, squashed?.changes, squashed?.landing.kind, squashed?.pull?.number], ["main", 1, 1, "merged", 9],
  "a pull request merged with the branch's tip as its head has landed, though main never got the commit")
assert.equal((await summaryOf(onFork.path))?.pull?.number, 7, "a fork's pull request is found by its number")
commit(moved.path, "after the merge")
assert.equal((await summaryOf(moved.path))?.landing.kind, "open", "a commit after the merge isn't in it")
assert.equal(asked, 1, "GitHub is asked once a minute per repository")
assert.equal((await service.summaries()).find((summary) => summary.path === moved.path)?.pull?.number, 9, "within the minute the last answer stands")

// Update from main: what the start point has comes in as a merge; a conflict is left for resolving.
const upId = placed()
const up = await service.prepare(upId, project, "Update me", { kind: "newest" })
await service.attach(upId)
commit(project, "main moves")
assert.deepEqual((await service.review(up.path)).behind, { from: "main", commits: 1 }, "the review counts what the start point has that the branch lacks")
assert.deepEqual(await service.update(up.path), { kind: "updated", from: "main", commits: 1 })
assert.ok(await succeeds(up.path, ["merge-base", "--is-ancestor", "main", "HEAD"]))
assert.deepEqual(await service.update(up.path), { kind: "current", from: "main" })
writeFileSync(join(up.path, "up.txt"), "mine\n")
git(up.path, "add", ".")
git(up.path, "commit", "-q", "-m", "mine")
writeFileSync(join(up.path, "up.txt"), "dirty\n")
await assert.rejects(service.update(up.path), /Commit or stash your changes first/)
git(up.path, "checkout", "-q", "--", "up.txt")
writeFileSync(join(project, "up.txt"), "theirs\n")
git(project, "add", ".")
git(project, "commit", "-q", "-m", "theirs")
assert.deepEqual(await service.update(up.path), { kind: "conflicts", from: "main", files: ["up.txt"] })
assert.ok(existsSync(join(git(up.path, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD")), "the merge is left in progress")
await assert.rejects(service.update(up.path), /Commit or stash|Finish or abort the merge/)
git(up.path, "merge", "--abort")

// The mark and the tip say the same thing in a glyph and in words.
const opened = { path: "/w", into: "main", ahead: 3, changes: 2, landing: { kind: "open", into: "main", commits: 3 }, pull: null } satisfies WorktreeSummary
const worktree = { path: "/w", thread: ThreadIdSchema.parse(randomUUID()), repoRoot: "/r", project: "/r", branch: "mako/x", base: "abc", createdAt: 0, start: { from: "main", adopted: false, tookMs: 400, copied: 0, spare: true } }
assert.deepEqual(worktreeMark(undefined), { kind: "branch" })
assert.deepEqual(worktreeMark(opened), { kind: "ahead", ahead: 3 })
assert.deepEqual(worktreeMark({ ...opened, pull: { number: 4, title: "", url: "", branch: "mako/x", state: "draft", head: "", checks: null } }), { kind: "pull", number: 4, draft: true })
assert.deepEqual(worktreeMark({ ...opened, pull: { number: 4, title: "", url: "", branch: "mako/x", state: "closed", head: "", checks: null } }), { kind: "ahead", ahead: 3 }, "a closed pull request leaves the branch's own state")
assert.deepEqual(worktreeMark({ ...opened, landing: { kind: "merged", into: "main" } }), { kind: "landed" })
assert.deepEqual(worktreeTip(worktree, opened), ["On mako/x from main", "3 commits not in main · 2 files not committed"])
assert.deepEqual(worktreeTip(worktree, { ...opened, ahead: 0, landing: { kind: "empty" } }), ["On mako/x from main", "2 files not committed yet"])
assert.deepEqual(worktreeTip(worktree, { ...opened, changes: 0, pull: { number: 4, title: "", url: "", branch: "mako/x", state: "open", head: "", checks: "failed" } }), ["On mako/x from main", "3 commits not in main", "#4 open · checks failed"])
assert.equal(worktreeMarkLabel({ kind: "ahead", ahead: 1 }, worktree, "main"), "mako/x: 1 commit not in main")

// Since main offers one landing action, and it follows the branch.
const facts = { commits: 3, changed: false, operation: false, landed: false, pullOpen: false, last: undefined }
assert.deepEqual(landState(facts), { kind: "commits", main: "merge" }, "merging is the first way to land")
assert.deepEqual(landState({ ...facts, last: "pull" }), { kind: "commits", main: "pull" }, "the way this project used last leads")
assert.deepEqual(landState({ ...facts, changed: true }), { kind: "busy" }, "changes not committed come first")
assert.deepEqual(landState({ ...facts, operation: true, pullOpen: true }), { kind: "busy" }, "a merge under way comes before anything else")
assert.deepEqual(landState({ ...facts, changed: true, pullOpen: true }), { kind: "pull" }, "an open pull request stays viewable while work goes on")
assert.deepEqual(landState({ ...facts, pullOpen: true, landed: true }), { kind: "landed" }, "landed wins over a pull request left open")
assert.deepEqual(landState({ ...facts, landed: true, changed: true }), { kind: "busy" }, "a landed branch with new edits isn't done")
assert.deepEqual(landState({ ...facts, commits: 0 }), { kind: "nothing" })
assert.equal(readLandWith("pull"), "pull")
assert.equal(readLandWith("rebase"), undefined)

threads.close()
rmSync(root, { recursive: true, force: true })
console.log("worktree start points: ok")
