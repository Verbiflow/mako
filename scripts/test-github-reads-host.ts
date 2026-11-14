import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { HostStopping } from "@mako/host/base/host-stopping"
import { hostCommand } from "@mako/host/base/host-command"
import { listBranchPulls } from "@mako/host/git/github"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"

// Eighty actual Mako-managed scratch worktrees. gh is an offline executable; no login or GitHub traffic.
const root = await mkdtemp(join(tmpdir(), "mako-github-reader-"))
const repo = join(root, "repo"), log = join(root, "requests"), binary = join(root, "gh-fixture")
const previous = process.env.GH_PATH
const git = new Git()
const store = new ThreadStore(join(root, "threads.sqlite"))
const worktrees = new ThreadWorktreeService(git, join(root, "worktrees"), store)
try {
  await mkdir(repo)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  const command = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  command("config", "user.name", "Fixture"); command("config", "user.email", "fixture@example.invalid")
  await writeFile(join(repo, "README"), "Offline fixture\n")
  command("add", "README"); command("commit", "-qm", "Fixture")
  const head = command("rev-parse", "HEAD")
  const paths: string[] = []
  for (let i = 0; i < 80; i++) paths.push((await worktrees.prepare(randomUUID(), repo, `Fixture ${i}`)).path)
  const pulls = Array.from({ length: 60 }, (_, i) => ({ number: i + 7, title: "Fixture", state: "OPEN", isDraft: false, url: `https://github.com/fixture/project/pull/${i + 7}`, headRefName: `fixture-${i}`, headRefOid: i === 0 ? head : "b".repeat(40) }))
  await writeFile(binary, `#!${process.execPath}\nimport{appendFileSync}from'node:fs';\nconst a=process.argv.slice(2), pulls=${JSON.stringify(pulls)};\nconst q=a.find(x=>x.startsWith('query='))||'', n=Number((a.find(x=>x.startsWith('number='))||'').slice(7));\nappendFileSync(${JSON.stringify(log)},JSON.stringify({kind:a[0]==='repo'?'repo':n?'checks':'list',checksInList:!n&&(q?q.includes('statusCheckRollup'):(a[a.indexOf('--json')+1]||'').includes('statusCheckRollup'))})+'\\n');\nif(a[0]==='repo')console.log(JSON.stringify({nameWithOwner:'fixture/project',url:'https://github.com/fixture/project'}));\nelse if(a[1]==='graphql'){console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify({data:{repository:n?{pullRequest:{...pulls.find(p=>p.number===n),commits:{nodes:[]}}}:{pullRequests:{nodes:pulls}}}}));}\nelse console.log(JSON.stringify(pulls));\n`, { mode: 0o700 })
  process.env.GH_PATH = binary
  // The exact installed/main poller's old query, one uncached reader for each checkout, bounded to eight at once.
  const old = ["pr", "list", "--state", "all", "--limit", "60", "--json", "number,title,url,headRefName,headRefOid,state,isDraft,statusCheckRollup"]
  for (let start = 0; start < paths.length; start += 8) await Promise.all(paths.slice(start, start + 8).map(cwd => hostCommand(binary, old, { cwd, timeout: 15_000 })))
  const before = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.equal(before.length, 80)
  assert.ok(before.every(row => row.checksInList))
  await writeFile(log, "")
  const host = new HostStopping()
  const after = await host.run(() => Promise.all(paths.map(cwd => listBranchPulls(cwd, [head]))))
  assert.ok(after.every(pulls => pulls?.length === 60))
  const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.equal(requests.length, 3, "one canonical repository, one cheap list, one matching head's checks")
  assert.ok(requests.every(row => !row.checksInList))
  assert.equal(requests.filter(row => row.kind === "checks").length, 1, "59 unrelated PRs never get check queries")
  await host.run(() => Promise.all(paths.map(cwd => listBranchPulls(cwd, [head]))))
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, requests.length)
  await host.stop()
  console.log(JSON.stringify({ fixture: "offline scratch host reader", actualWorktrees: 80, ghBefore: before.length, ghAfter: requests.length, broadCheckListsBefore: 80, broadCheckListsAfter: 0, matchingHeadReads: 1, repeatedBurstNewReads: 0 }))
} finally {
  if (previous === undefined) delete process.env.GH_PATH
  else process.env.GH_PATH = previous
  worktrees.closeSummaries()
  await worktrees.settled()
  store.close()
  await git.close()
  await rm(root, { recursive: true, force: true })
}
