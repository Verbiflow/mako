import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { performance } from "node:perf_hooks"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { RecipeSchema } from "@mako/host/workspaces/thread-recipe"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import type { Prepared } from "@mako/host/workspaces/thread-processes"
import type { CheckoutSetup } from "@mako/host/workspaces/worktree-carry"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Mako's own Git writes in one repository (a spare being made, a Thread's branch made and deleted, a worktree set
 * aside) run one at a time, whichever part of the host asks, so two never meet at a lock. Threads start and are
 * abandoned in a project folder of two repositories and in a repository of its own while each keeps spares coming:
 * every write to what a repository's checkouts share runs alone in its repository, some had to wait their turn, and
 * every empty branch goes. On 2026-11-11 CI saw an abandoned Thread's branch left behind in one repository of a project
 * folder, its delete's failure unsaid; run without the turn, this test sees writes overlap.
 *
 *   npx tsx scripts/test-worktree-writes.ts
 */
const ROUNDS = 8
const root = realpathSync(testScratch("mako-worktree-writes-"))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const repository = (name: string) => {
  const path = join(root, name)
  mkdirSync(join(path, "web", "generated"), { recursive: true })
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "test@example.invalid")
  git(path, "config", "user.name", "Test")
  // Past Git's threshold, so checkouts run their parallel workers and take as long as they do in a real project.
  for (let n = 0; n < 300; n += 1) writeFileSync(join(path, "web", "generated", `part-${n}.ts`), `export const part = ${n}\n`)
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
  return path
}
const suite = join(root, "suite")
const repositories = [repository("suite/app"), repository("suite/api"), repository("solo")]
const solo = repositories[2]

type Write = { repository: string; cwd: string; args: string; outcome: string; start: number; end: number; waited: number }
const writes: Write[] = []
const traced = new Git({
  trace: (run) => {
    if (!run.write) return
    const end = performance.now()
    writes.push({ repository: run.repository ?? "", cwd: run.cwd, args: run.args.join(" "), outcome: run.outcome, start: end - run.ms, end, waited: run.queuedMs })
  },
})
const records = new Map<string, Prepared>()
const recipe = RecipeSchema.parse({ prepare: [{ command: "true", inputs: ["package-lock.json"], outputs: ["**/node_modules"], link: false }] })
const setup: CheckoutSetup = { recipe: async () => recipe, prepared: async (checkout) => records.get(checkout) ?? { done: {} }, savePrepared: async (checkout, prepared) => { records.set(checkout, prepared) } }
const threads = new ThreadStore(join(root, "threads.sqlite"))
const worktrees = new ThreadWorktreeService(traced, join(root, "worktrees"), threads, undefined, undefined, undefined, setup)

const round = async (folder: string, n: number) => {
  const id = randomUUID()
  // The person's composer set to Worktree keeps spares coming while a Thread starts and one is given back.
  const wanted = worktrees.want(folder)
  const made = await worktrees.prepare(id, folder, `Never started ${n}`)
  await Promise.all([wanted, worktrees.want(folder), worktrees.abandon(id)])
  return `${folder}: ${made.branch}`
}

try {
  const branches = (await Promise.all(Array.from({ length: ROUNDS }, (_, n) => [round(suite, n), round(solo!, n)]).flat())).sort()
  await worktrees.settled()
  for (const repo of repositories) {
    const left = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/mako/never-started-*")
    assert.equal(left, "", `every empty branch goes from ${repo}`)
  }
  assert.equal(new Set(branches).size, ROUNDS * 2, "each Thread had a branch of its own")

  // A write in a folder that's gone (a worktree set aside and being removed) is keyed by that folder and can't run;
  // any other write is its repository's. One that ran under any other key ran outside its repository's turn.
  const known = new Set(repositories.map((repo) => realpathSync(join(repo, ".git"))))
  const strays = writes.filter((write) => !known.has(write.repository))
  assert.deepEqual(strays.filter((write) => write.outcome === "ok"), [], "every write that ran took its repository's turn")
  if (strays.length) console.log(JSON.stringify({ strayWrites: strays.map((write) => ({ args: write.args, outcome: write.outcome })) }))
  const byRepository = Map.groupBy(writes.filter((write) => known.has(write.repository)), (write) => write.repository)
  assert.equal(byRepository.size, repositories.length, "every repository was written")
  for (const [repo, own] of byRepository) {
    own.sort((a, b) => a.start - b.start)
    for (let at = 1; at < own.length; at += 1)
      assert.ok(own[at]!.start >= own[at - 1]!.end, `in ${repo}, \`git ${own[at]!.args}\` began before \`git ${own[at - 1]!.args}\` ended`)
  }
  const waited = writes.filter((write) => write.waited > 1)
  assert.ok(waited.length > 0, "writes asked for at once in one repository waited their turn")
  const verbs = (match: RegExp) => writes.filter((write) => match.test(write.args)).length
  console.log(JSON.stringify({ writes: writes.length, waited: waited.length, spareWorktrees: verbs(/worktree add --detach/), branchDeletes: verbs(/branch -D/) }))

  // A start's checkout writes its files outside the turn: on a repository whose files pass through a slow filter (an LFS
  // download, say), another write there goes while the files are still coming.
  const filtered = repository("filtered")
  git(filtered, "config", "filter.slow.smudge", "sleep 1; cat")
  git(filtered, "config", "filter.slow.clean", "cat")
  writeFileSync(join(filtered, ".gitattributes"), "*.slow filter=slow\n")
  for (const n of [1, 2, 3]) writeFileSync(join(filtered, `asset-${n}.slow`), `asset ${n}\n`)
  git(filtered, "add", ".")
  git(filtered, "commit", "-q", "-m", "slow assets")
  const slowId = randomUUID()
  const began = performance.now()
  let startEnded = 0
  const starting = worktrees.prepare(slowId, filtered, "Slow checkout").then((made) => { startEnded = performance.now() - began; return made })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const asked = performance.now()
  await traced.output(filtered, ["branch", "--no-track", "meanwhile", "HEAD"])
  const meanwhileMs = performance.now() - asked
  const slow = await starting
  assert.equal(readFileSync(join(slow.path, "asset-3.slow"), "utf8"), "asset 3\n", "the start's files came through their filter")
  assert.ok(startEnded >= 2_500, `the checkout took its filter's time (${Math.round(startEnded)} ms)`)
  assert.ok(meanwhileMs < 1_500 && meanwhileMs < startEnded - 500, `a branch made during the start's checkout waited ${Math.round(meanwhileMs)} ms; the start took ${Math.round(startEnded)} ms`)
  await worktrees.abandon(slowId)
  console.log(JSON.stringify({ slowStartMs: Math.round(startEnded), branchDuringItMs: Math.round(meanwhileMs) }))

  // Written outside the turn, a worktree still runs the repository's post-checkout hook as `worktree add` would, through
  // `core.hooksPath` as husky sets it: projects install hooks or generate code there. On a Git older than 2.36, which
  // has no `git hook` (Xcode 13's tools ship 2.32, Ubuntu 22.04 2.34): this Git's `hook` says what theirs says.
  const hooked = repository("hooked")
  mkdirSync(join(hooked, ".husky"))
  // It reads its input to the end first: Git gives a hook none, and one given an open pipe would never finish.
  writeFileSync(join(hooked, ".husky", "post-checkout"), '#!/bin/sh\ncat > /dev/null\necho "$1 $2 $3 GIT_DIR=${GIT_DIR:-unset}" > .post-checkout-ran\n', { mode: 0o755 })
  git(hooked, "add", ".husky")
  git(hooked, "commit", "-q", "-m", "hooks")
  git(hooked, "config", "core.hooksPath", ".husky")
  const olderGit = join(root, "older-git")
  mkdirSync(olderGit)
  writeFileSync(join(olderGit, "git"), `#!/bin/sh\nfor word in "$@"; do [ "$word" = hook ] && { echo "git: 'hook' is not a git command. See 'git --help'." >&2; exit 1; }; done\nexec "${traced.executable}" "$@"\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${olderGit}${delimiter}${path ?? ""}`
  const older = new Git()
  // The Git it runs is the first on PATH, resolved once.
  assert.equal(older.executable, join(olderGit, "git"))
  process.env.PATH = path
  await assert.rejects(older.output(hooked, ["hook", "run", "--ignore-missing", "post-checkout"]), /'hook' is not a git command/, "this Git has no `git hook`")
  const onOlder = new ThreadWorktreeService(older, join(root, "older-worktrees"), threads, undefined, undefined, undefined, setup)
  const hookedId = randomUUID()
  const hookStarted = performance.now()
  const started = await Promise.race([
    onOlder.prepare(hookedId, hooked, "Hooked"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("a start whose post-checkout hook reads its stdin is still waiting after 30 s")), 30_000).unref()),
  ])
  assert.ok(performance.now() - hookStarted < 30_000)
  const head = git(started.path, "rev-parse", "HEAD")
  assert.equal(readFileSync(join(started.path, ".post-checkout-ran"), "utf8").trim(), `${"0".repeat(head.length)} ${head} 1 GIT_DIR=unset`, "the post-checkout hook ran in the new worktree, as worktree add runs it")
  await onOlder.abandon(hookedId)
  await onOlder.settled()
  await older.close()
  console.log("worktree writes: spares made while Threads start and are given back never write at once in a repository, and every empty branch goes, and each new worktree runs its post-checkout hook")
} finally {
  await traced.close()
}
