import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFile, execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Git } from "@mako/git"
import { HostStopping } from "@mako/host/base/host-stopping"
import { listBranchPulls, forgetGitHubReads } from "@mako/host/git/github"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"

const root = await mkdtemp(join(tmpdir(), "mako-pr-ref-")), repo = join(root, "repo"), origin = join(root, "origin.git")
const catalog = join(root, "catalog"), calls = join(root, "calls"), binary = join(root, "gh-fixture")
const previous = process.env.GH_PATH
const git = new Git(), host = new HostStopping(), store = new ThreadStore(join(root, "threads.sqlite"))
let invalidations = 0
const service = new ThreadWorktreeService(git, join(root, "worktrees"), store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => true, async cwd => {
  await forgetGitHubReads(cwd); invalidations++
})
const command = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const queryCount = async () => (await readFile(calls, "utf8")).trim().split("\n").filter(line => line === "list").length
try {
  await mkdir(repo); command(repo, "init", "-q", "-b", "main"); command(repo, "config", "user.email", "fixture@example.invalid"); command(repo, "config", "user.name", "Fixture")
  await writeFile(join(repo, "README"), "Fixture\n"); command(repo, "add", "README"); command(repo, "commit", "-qm", "Fixture")
  command(repo, "init", "-q", "--bare", origin); command(repo, "remote", "add", "origin", origin)
  const id = randomUUID()
  store.registerJournal({ conversationId: id, createdAt: Date.now(), bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
  const made = await service.prepare(id, repo, "Fixture")
  const oldHead = command(made.path, "rev-parse", "HEAD")
  const pull = (head: string, conclusion = "SUCCESS") => ({ conclusion, number: 7, title: "Fixture", url: "https://github.com/fixture/project/pull/7", state: "OPEN", isDraft: false, headRefName: made.branch, headRefOid: head })
  await writeFile(catalog, JSON.stringify(pull(oldHead)))
  await writeFile(binary, `#!${process.execPath}\nimport{readFileSync,appendFileSync}from'node:fs';const a=process.argv.slice(2),p=JSON.parse(readFileSync(${JSON.stringify(catalog)},'utf8')),n=a.some(x=>x.startsWith('number='));appendFileSync(${JSON.stringify(calls)},(a[0]==='repo'?'repo':n?'checks':'list')+'\\n');if(a[0]==='repo')console.log('{"nameWithOwner":"fixture/project","url":"https://github.com/fixture/project"}');else console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify({data:{repository:n?{pullRequest:{...p,commits:{nodes:[{commit:{statusCheckRollup:{contexts:{pageInfo:{hasNextPage:false},nodes:[{name:'fixture',status:'COMPLETED',conclusion:p.conclusion}]}}}}]}}}:{pullRequests:{nodes:[p]}}}}));\n`, { mode: 0o700 })
  process.env.GH_PATH = binary
  const first = await host.run(() => listBranchPulls(made.path, [oldHead], new Map([[made.branch, oldHead]])))
  assert.equal(first?.[0]?.checks, "passed")
  const originalSummary = await host.run(() => service.summaries(listBranchPulls))
  assert.equal(originalSummary[0]?.pull?.head, oldHead)
  assert.equal(originalSummary[0]?.pull?.checks, "passed")
  // Delay file events deliberately: the very next summary must compare live HEAD, even with both caches warm.
  service.closeSummaries()
  await writeFile(join(made.path, "next"), "Next\n"); command(made.path, "add", "next"); command(made.path, "commit", "-qm", "Next")
  const head = command(made.path, "rev-parse", "HEAD"); await writeFile(catalog, JSON.stringify(pull(head, "FAILURE")))
  await promisify(execFile)("git", ["push", "-q", "origin", `HEAD:refs/heads/${made.branch}`], { cwd: made.path })
  const summary = await host.run(() => service.summaries(listBranchPulls))
  assert.equal(summary[0]?.pull?.head, head, "the next summary sees the shell-pushed HEAD without a file event or TTL wait")
  assert.equal(summary[0]?.pull?.checks, "failed", "HEAD B cannot inherit HEAD A's passing checks")
  const refreshed = await host.run(() => listBranchPulls(made.path, [head], new Map([[made.branch, head]])))
  assert.equal(refreshed?.[0]?.head, head, "a matching open branch gets one fresh per-number read despite the old list and old checks")
  assert.equal(refreshed?.[0]?.checks, "failed")
  assert.equal(await queryCount(), 1, "the fallback does not refetch the five-minute list")
  const beforeRepeat = (await readFile(calls, "utf8")).split("\n").filter(line => line === "checks").length
  assert.equal(beforeRepeat, 2, "one per-PR read per HEAD, with the cached broad list unchanged")
  await host.run(() => service.summaries(listBranchPulls))
  assert.equal((await readFile(calls, "utf8")).split("\n").filter(line => line === "checks").length, beforeRepeat, "same-HEAD summaries reuse the per-PR read")
  // Watch a shell push to another ref in the same branch directory, without moving logs/HEAD.
  service.followSummaries(() => {})
  await host.run(() => service.summaries(listBranchPulls))
  const before = invalidations
  await promisify(execFile)("git", ["push", "-q", "origin", `HEAD:refs/heads/${made.branch}-second`], { cwd: made.path })
  for (const deadline = performance.now() + 15_000; invalidations === before; await new Promise(resolve => setTimeout(resolve, 25))) {
    if (performance.now() > deadline) throw new Error("A push-only ref event never invalidated the repository")
  }
  await host.run(() => listBranchPulls(made.path, [head], new Map([[made.branch, head]])))
  assert.ok(await queryCount() > 1, "the shell push invalidates the reader's canonical list before its five-minute TTL")
  // An existing ref may be rewritten in place: its contents, not just its parent directory, must be watched.
  const afterFirst = invalidations
  await writeFile(join(repo, ".git", "refs", "remotes", "origin", made.branch), `${oldHead}\n`)
  for (const deadline = performance.now() + 15_000; invalidations === afterFirst; await new Promise(resolve => setTimeout(resolve, 25))) {
    if (performance.now() > deadline) throw new Error("An existing remote ref rewrite never invalidated the repository")
  }
  console.log("GitHub refs: stale-head per-number fallback and actual next-summary HEAD refresh, shell push and in-place remote-ref invalidation passed")
} finally {
  if (previous === undefined) delete process.env.GH_PATH; else process.env.GH_PATH = previous
  service.closeSummaries(); await service.settled(); store.close(); await Promise.allSettled([host.stop(), git.close()]); await rm(root, { recursive: true, force: true })
}
