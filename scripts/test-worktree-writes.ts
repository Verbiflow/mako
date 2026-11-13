import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
const [, , solo] = repositories

type Write = { repository: string; args: string; start: number; end: number; waited: number }
const writes: Write[] = []
const traced = new Git({
  trace: (run) => {
    if (!run.write) return
    const end = performance.now()
    writes.push({ repository: run.repository ?? "", args: run.args.join(" "), start: end - run.ms, end, waited: run.queuedMs })
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

  const byRepository = Map.groupBy(writes, (write) => write.repository)
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
  console.log("worktree writes: spares made while Threads start and are given back never write at once in a repository, and every empty branch goes")
} finally {
  await traced.close()
}
