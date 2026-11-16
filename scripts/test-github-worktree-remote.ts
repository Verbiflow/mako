import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Git } from "@mako/git"
import { HostStopping } from "@mako/host/base/host-stopping"
import { githubStatus, pullForBranch } from "@mako/host/git/github"
import { pullRequestTools } from "@mako/host/git/pull-request-tools"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import { repositoryPlace } from "@mako/host/workspaces/tools"
import { declareToolMethods, openTools } from "@mako/host/tools"
import type { Control } from "@mako/host/control"
import type { MachineCapability } from "@mako/host/base/machine"
import type { MethodTable } from "@mako/host/base/methods"
import { pullSetupReason } from "@mako/host/contracts/git-actions"
import type { IntegrationCatalogSnapshot, McpRegistrySnapshot } from "@mako/host/contracts/mcp-skills-integrations"

// Real linked Git worktrees and repository/tool resolution; every gh answer and push destination is local.
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-worktree-remote-")))
const project = join(root, "project"), binary = join(root, "gh"), calls = join(root, "calls"), mode = join(root, "mode")
const previous = process.env.GH_PATH
const git = new Git(), store = new ThreadStore(join(root, "threads.sqlite"))
const worktrees = new ThreadWorktreeService(git, join(root, "worktrees"), store)
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
try {
  await mkdir(project)
  for (const name of ["api", "web"]) {
    const repo = join(project, name)
    run(root, "init", "-q", "-b", "main", repo)
    run(repo, "config", "user.name", "Fixture"); run(repo, "config", "user.email", "fixture@example.invalid")
    await writeFile(join(repo, "README"), "Fixture\n")
    run(repo, "add", "README"); run(repo, "commit", "-qm", "Fixture")
  }
  const id = randomUUID(), checkout = await worktrees.prepare(id, project, "Fin remote")
  const place = await repositoryPlace(git, worktrees, id, checkout.path)
  assert.equal(place.repositories.length, 2)
  for (const repo of place.repositories) {
    assert.equal(basename(repo.root), repo.name)
    assert.equal((await readFile(join(repo.root, ".git"), "utf8")).startsWith("gitdir:"), true)
    const origin = join(root, `${repo.name}.git`)
    run(root, "init", "-q", "--bare", origin)
    run(repo.root, "remote", "add", "origin", repo.name === "api" ? "git@github.com:fixture/api.git" : "https://github.com/fixture/web.git")
    run(repo.root, "remote", "set-url", "--push", "origin", origin)
  }
  await writeFile(mode, "ok")
  await writeFile(binary, String.raw`#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
const a=process.argv.slice(2), name=basename(process.cwd()), mode=readFileSync(${JSON.stringify(mode)},'utf8');
appendFileSync(${JSON.stringify(calls)},JSON.stringify({cwd:process.cwd(),args:a})+'\n');
const output=value=>{if(a.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\n\n');console.log(JSON.stringify(value))};
const fail=message=>{process.stderr.write(message);process.exit(1)};
if(a[0]==='--version')console.log('gh fixture');
else if(a[0]==='api'&&a[1]==='user')output({login:'fixture',id:7});
else if(a[0]==='repo')fail('GraphQL repository metadata refused. PRIVATE-FIXTURE-DETAIL');
else if(a[0]==='api'&&a[1]==='repos/{owner}/{repo}'){
 if(mode==='fail')fail('HTTP 502: PRIVATE-FIXTURE-DETAIL');
 if(mode==='malformed'){console.log('not JSON');process.exit(0)}
 if(!execFileSync('git',['remote'],{encoding:'utf8'}).trim())fail('no git remotes found');
 output({full_name:'fixture/'+name,html_url:'https://github.com/fixture/'+name,default_branch:'main',allow_squash_merge:true});
}else if(a[0]==='api'&&a[1]==='graphql'){
 const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim();
 const pull={number:806,title:'Fixture',url:'https://github.com/fixture/'+name+'/pull/806',state:'OPEN',isDraft:false,headRefName:branch,headRefOid:'a'.repeat(40),baseRefName:'main',latestReviews:{pageInfo:{hasNextPage:false},nodes:[]}};
 const query=a.find(x=>x.startsWith('query='))||'';
 output({data:{repository:query.includes('reviewThreads')?{pullRequest:{reviewThreads:{nodes:[]}}}:a.some(x=>x.startsWith('number='))?{pullRequest:pull}:{pullRequests:{nodes:[pull]}}}});
}else process.exit(1);
`, { mode: 0o700 })
  process.env.GH_PATH = binary
  const tools = pullRequestTools({ git, place: async () => place, changed: () => {} })
  const host = new HostStopping()
  try {
    const status = await host.run(() => tools.status(id))
    assert.doesNotMatch(status, /Add a GitHub remote|opening:/, "a failed GraphQL metadata query must not hide either worktree's PR")
    assert.equal((status.match(/number: 806/g) ?? []).length, 2)
    const web = place.repositories.find(repo => repo.name === "web")!
    await mkdir(join(web.root, "src"))
    assert.equal((await repositoryPlace(git, worktrees, id, join(web.root, "src"))).here?.root, web.root)
    const standalone = await repositoryPlace(git, null, id, web.root)
    assert.equal(standalone.here?.root, web.root, "a linked worktree also resolves without a registered checkout")
    assert.match(await host.run(() => tools.open(id, { repository: "web" })), /#806 was already open/)
    assert.equal(run(place.repositories.find(repo => repo.name === "web")!.root, "ls-remote", "--heads", "--exit-code", join(root, "web.git")).includes(checkout.branch), true)
  } finally { await host.stop() }
  const requests = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.ok(requests.some(row => row.args[1] === "repos/{owner}/{repo}"))
  assert.ok(requests.every(row => row.args[0] !== "repo"), "repository metadata uses REST, not GraphQL repo view")
  assert.ok(requests.every(row => place.repositories.some(repo => repo.root === row.cwd)))
  for (const failure of ["fail", "malformed"]) {
    await writeFile(mode, failure)
    let integrations: (() => Promise<IntegrationCatalogSnapshot>) | undefined
    let discoveries = 0
    const methods: MethodTable = { handle(channel, listener) {
      if (channel === "mako:integrations") {
        // SAFETY: this registered channel has no arguments and returns IntegrationCatalogSnapshot.
        integrations = listener as () => Promise<IntegrationCatalogSnapshot>
      }
    } }
    const snapshot: McpRegistrySnapshot = { cwd: place.repositories[0]!.root, generatedAt: 1, servers: [], providers: [] }
    const empty = { get: () => undefined, list: () => [] }
    const integrationTools = openTools({
      mcpSources: empty, skillSources: empty, mcpEditing: empty, skillEditing: empty,
      authoring: { hooks: empty, commands: empty, mcp: empty }, harnesses: empty,
      label: provider => provider, account: async () => ({ env: {}, account: { name: "fixture" } }),
    }, root)
    integrationTools.mcp.discover = async () => { discoveries++; return snapshot }
    // SAFETY: integrations uses only these control methods; browser/driver/permissions are explicit local fixtures.
    const control = {
      ensureLocalControl: async (): Promise<string | null> => null,
      driverStatus: async () => ({ executable: "/fixture/driver", version: "fixture", verified: "fixture", outdated: false, detail: "fixture" }),
      computerPermissions: async () => ({ supported: true, persistentAcrossUpdates: true, accessibility: true, screenRecording: "granted" as const }),
      browser: { status: () => [{ id: "fixture", name: "Fixture", connection: { status: "connected" as const, generation: "fixture" } }] },
    } as Control
    // SAFETY: the machine capability belongs only to the uninvoked reveal-plugins handler; integrations never uses it.
    declareToolMethods(methods, { tools: integrationTools, control, workspace: async () => snapshot.cwd, dataRoot: root, machine: {} as MachineCapability })
    assert.ok(integrations)
    const readIntegrations = integrations
    const apiRoot = place.repositories[0]!.root
    const repositoryReads = async () => (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(row => row.cwd === apiRoot && row.args[1] === "repos/{owner}/{repo}").length
    const before = await repositoryReads()
    const failedHost = new HostStopping()
    try {
      await failedHost.run(async () => {
        const catalog = await readIntegrations()
        assert.equal(discoveries, 1)
        for (const name of ["github", "local-browser", "computer-use"]) assert.equal(catalog.integrations.find(row => row.id === name)?.connection.kind, "ready")
        const failedStatus = await githubStatus(apiRoot)
        assert.equal(failedStatus.authenticated, true)
        assert.equal(failedStatus.repo, undefined)
        assert.equal(failedStatus.repoLookup?.state, "failed")
        assert.ok(failedStatus.repoLookup!.until > Date.now())
        assert.match(pullSetupReason(failedStatus)!, /GitHub could not read this repository/)
        assert.match(await tools.status(id), /GitHub could not read this repository/)
        await assert.rejects(tools.open(id, { repository: "api" }), error => error instanceof Error && !/PRIVATE-FIXTURE-DETAIL|Add a GitHub remote/.test(error.message))
        await assert.rejects(pullForBranch(apiRoot), /GitHub could not read this repository/, "failure inside the cached PR reader cannot become no PR")
        await readIntegrations()
        assert.equal(await repositoryReads() - before, 1, "catalog refresh, PR status/open and cached PR reading share one failed metadata lookup")
      })
    } finally { await failedHost.stop() }
    assert.equal((await githubStatus(apiRoot)).repoLookup?.state, "failed", "standalone status callers get the same typed result")
  }
  await writeFile(mode, "ok")
  const noRemote = join(root, "no-remote")
  run(root, "init", "-q", noRemote)
  assert.equal((await githubStatus(noRemote)).repo, undefined, "a genuinely missing remote stays a setup problem")
  console.log("Fin project worktrees: REST repository metadata, existing PR status/open, correct cwd, and safe lookup failure passed")
} finally {
  if (previous === undefined) delete process.env.GH_PATH; else process.env.GH_PATH = previous
  await worktrees.closeSummaries(); await worktrees.settled(); store.close(); await git.close()
  await rm(root, { recursive: true, force: true })
}
