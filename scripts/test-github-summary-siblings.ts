import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Git } from "@mako/git"
import { HostStopping } from "@mako/host/base/host-stopping"
import { listBranchPulls, forgetGitHubReads } from "@mako/host/git/github"
import { ThreadStore } from "@mako/host/threads/store"
import type { WorktreeSummary } from "@mako/host/contracts/thread-worktrees"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"

const root = await mkdtemp(join(tmpdir(), "mako-pr-siblings-")), repo = join(root, "repo")
const catalog = join(root, "catalog"), calls = join(root, "calls"), binary = join(root, "gh-fixture")
const previous = process.env.GH_PATH, originalNow = Date.now
const git = new Git(), host = new HostStopping(), store = new ThreadStore(join(root, "threads.sqlite"))
let now = Date.now(), invalidations = 0
const service = new ThreadWorktreeService(git, join(root, "worktrees"), store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => true, async cwd => {
  await forgetGitHubReads(cwd); invalidations++
})
const command = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd })).stdout.trim()
const views: { heads: readonly string[]; branches: ReadonlyMap<string, string> }[] = []
const pulls: typeof listBranchPulls = async (cwd, heads = [], branches = new Map()) => {
  views.push({ heads, branches }); return listBranchPulls(cwd, heads, branches)
}
const events: WorktreeSummary[][] = []
const wait = async (ready: () => boolean) => {
  for (const deadline = performance.now() + 15_000; !ready(); await new Promise(resolve => setTimeout(resolve, 25))) {
    if (performance.now() > deadline) throw new Error("No event-driven sibling summary arrived")
  }
}
try {
  await mkdir(repo); await command(repo, "init", "-q", "-b", "main")
  await command(repo, "config", "user.email", "fixture@example.invalid"); await command(repo, "config", "user.name", "Fixture")
  await command(repo, "commit", "-qm", "Fixture", "--allow-empty")
  await command(repo, "init", "-q", "--bare", join(root, "origin.git")); await command(repo, "remote", "add", "origin", join(root, "origin.git"))
  const make = async (name: string) => {
    const id = randomUUID(); store.registerJournal({ conversationId: id, createdAt: now, bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
    const made = await service.prepare(id, repo, name)
    await command(made.path, "commit", "-qm", name, "--allow-empty")
    return { ...made, head: await command(made.path, "rev-parse", "HEAD") }
  }
  const a = await make("Fixture A"), b = await make("Fixture B")
  const pull = (worktree: typeof a, number: number) => ({ number, title: "Fixture", url: `https://github.com/fixture/project/pull/${number}`, state: "OPEN", isDraft: false, headRefName: worktree.branch, headRefOid: worktree.head })
  const publish = () => writeFile(catalog, JSON.stringify([pull(a, 7), pull(b, 8)]))
  await publish()
  await writeFile(binary, `#!${process.execPath}\nimport{readFileSync,appendFileSync}from'node:fs';const a=process.argv.slice(2),p=JSON.parse(readFileSync(${JSON.stringify(catalog)},'utf8')),n=a.find(x=>x.startsWith('number='));appendFileSync(${JSON.stringify(calls)},(a[0]==='repo'?'repo':n?'checks':'list')+'\\n');if(a[0]==='repo')console.log('{"nameWithOwner":"fixture/project","url":"https://github.com/fixture/project"}');else console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify({data:{repository:n?{pullRequest:{...p.find(x=>x.number===Number(n.slice(7))),commits:{nodes:[{commit:{statusCheckRollup:{contexts:{pageInfo:{hasNextPage:false},nodes:[{name:'fixture',status:'COMPLETED',conclusion:'SUCCESS'}]}}}}]}}}:{pullRequests:{nodes:p}}}}));\n`, { mode: 0o700 })
  process.env.GH_PATH = binary; Date.now = () => now
  service.followSummaries(summaries => events.push(summaries))
  const initial = await host.run(() => service.summaries(pulls))
  assert.deepEqual(initial.map(summary => summary.pull?.checks), ["passed", "passed"])
  const firstReads = views.length, firstInvalidations = invalidations
  now += 6_000
  await command(a.path, "commit", "-qm", "Next", "--allow-empty")
  a.head = await command(a.path, "rev-parse", "HEAD"); await publish()
  await wait(() => events.some(summaries => summaries.find(summary => summary.path === a.path)?.pull?.head === a.head))
  assert.equal(events.at(-1)?.find(summary => summary.path === b.path)?.pull?.checks, "passed", "readStale preserves the sibling's checks")
  assert.ok(views.slice(firstReads).every(view => view.heads.includes(a.head) && view.heads.includes(b.head) && view.branches.size === 2), "every stale-path PR read includes all live repository points")
  assert.equal(invalidations, firstInvalidations, "a local commit does not evict the GitHub list")
  assert.equal((await readFile(calls, "utf8")).split("\n").filter(line => line === "list").length, 1)
  const next = await host.run(() => service.summaries(pulls))
  assert.deepEqual(next.map(summary => summary.pull?.checks), ["passed", "passed"], "the next full pass preserves both PRs")
  // Exercise the public one-worktree entry too, with no full-pass cache to hide a subset refill.
  service.forgetPulls(); const beforeSingle = views.length
  assert.equal((await host.run(() => service.summary(a.path, pulls)))?.pull?.checks, "passed")
  assert.ok(views.slice(beforeSingle).every(view => view.heads.includes(b.head) && view.branches.size === 2))
  now += 6_000
  await command(a.path, "push", "-q", "origin", `HEAD:refs/heads/${a.branch}`)
  await wait(() => invalidations > firstInvalidations)
  await wait(() => events.at(-1)?.every(summary => summary.pull?.checks === "passed") === true)
  assert.deepEqual((await host.run(() => service.summaries(pulls))).map(summary => summary.pull?.checks), ["passed", "passed"])
  console.log("GitHub summaries: repository-wide stale, single and full reads preserve both siblings; local commits retain the list and remote pushes invalidate it")
} finally {
  Date.now = originalNow
  if (previous === undefined) delete process.env.GH_PATH; else process.env.GH_PATH = previous
  service.closeSummaries(); await service.settled(); store.close(); await Promise.allSettled([host.stop(), git.close()]); await rm(root, { recursive: true, force: true })
}
