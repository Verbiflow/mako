import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { pullSetupReason } from "@mako/host/contracts/git-actions"
import { HostStopping } from "@mako/host/base/host-stopping"
import { githubStatus } from "@mako/host/git/github"
import { pullRequestTools, registerPullRequestTools } from "@mako/host/git/pull-request-tools"

// Actual status/open MCP handlers with a valid origin. gh and push's destination are strictly local fixtures.
const root = await mkdtemp(join(tmpdir(), "mako-github-limit-")), repo = join(root, "repo"), origin = join(root, "origin.git")
const state = join(root, "mode"), calls = join(root, "calls"), binary = join(root, "gh-fixture")
const previous = process.env.GH_PATH
const git = new Git()
const host = new HostStopping()
const server = new McpServer({ name: "fixture", version: "1" })
const client = new Client({ name: "fixture-client", version: "1" })
try {
  await mkdir(repo)
  execFileSync("git", ["init", "-q", "-b", "fix", repo])
  execFileSync("git", ["init", "-q", "--bare", origin])
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  run("config", "user.name", "Fixture"); run("config", "user.email", "fixture@example.invalid")
  await writeFile(join(repo, "README"), "Fixture\n"); run("add", "README"); run("commit", "-qm", "Fixture")
  run("remote", "add", "origin", "https://github.com/fixture/project.git")
  run("remote", "set-url", "--push", "origin", origin)
  await writeFile(state, "repo")
  await writeFile(binary, `#!${process.execPath}\nimport{readFileSync,appendFileSync}from'node:fs';\nconst a=process.argv.slice(2), mode=readFileSync(${JSON.stringify(state)},'utf8');\nappendFileSync(${JSON.stringify(calls)},a[0]+' '+(a[1]||'')+'\\n');\nconst fail=()=>{if(a.includes('--include'))process.stdout.write('HTTP/2.0 403 Forbidden\\nRetry-After: 180\\n\\n{}');process.stderr.write('HTTP 403: You have exceeded a secondary rate limit. DO-NOT-SHOW-FIXTURE-DETAIL');process.exit(1)};\nif(a[0]==='--version')console.log('gh fixture');\nelse if(a[0]==='api'&&a[1]==='user'){if(mode==='user')fail();if(a.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\\n\\n');console.log('{"login":"fixture","id":7}')}\nelse if(a[0]==='repo'){if(mode!=='pull')fail();console.log('{"url":"https://github.com/fixture/project","nameWithOwner":"fixture/project","defaultBranchRef":{"name":"main"}}')}else if(a[0]==='api'&&a[1]==='graphql')fail();else process.exit(1);\n`, { mode: 0o700 })
  process.env.GH_PATH = binary
  const tools = pullRequestTools({ git, place: async () => ({ folder: repo, repositories: [{ name: "repo", root: repo, startedFrom: null }] }), changed: () => { throw new Error("A limited request cannot publish a change") } })
  registerPullRequestTools(server, tools, () => "fixture", () => true)
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(left), client.connect(right)])
  const limited = async (name: "pull_request_status" | "pull_request_open") => {
    const before = Date.now()
    const result = await host.run(() => client.callTool({ name, arguments: name === "pull_request_open" ? { title: "Fixture", body: "Fixture" } : {} }))
    const text = JSON.stringify(result)
    console.log(JSON.stringify({ name, result: text }))
    assert.match(text, /GitHub is rate limited/)
    assert.match(text, /Try again after \d{4}-\d\d-\d\dT/)
    assert.doesNotMatch(text, /Add a GitHub remote|gh auth login|DO-NOT-SHOW-FIXTURE-DETAIL/)
    const retry = Date.parse(/Try again after ([\d-]+T[\d:.]+Z)/.exec(text)![1]!)
    assert.ok(retry >= before, "retry deadline is a future bound, not a fresh duration guessed by the tool")
    return retry
  }
  const deadline = await limited("pull_request_status")
  const prior = (await readFile(calls, "utf8")).split("\n").filter(line => !line.startsWith("--version")).length
  assert.equal(await limited("pull_request_open"), deadline, "open preserves the same cooldown even after forgetting its preflight")
  assert.equal((await readFile(calls, "utf8")).split("\n").filter(line => !line.startsWith("--version")).length, prior, "cooldown starts no remote command")
  assert.equal(run("ls-remote", origin), "", "neither tool pushed anything")
  // Also cover a rate limit at account lookup, with an actual exposed Retry-After header.
  await writeFile(state, "user")
  const other = new HostStopping()
  try {
    const before = Date.now(), status = await other.run(() => githubStatus(repo)), after = Date.now()
    assert.ok(status.rateLimit)
    assert.ok(status.rateLimit.retryAt >= before + 180_000 && status.rateLimit.retryAt <= after + 180_000)
  } finally { await other.stop() }
  // A later PR lookup may hit the limit even though account/repository setup already succeeded.
  await writeFile(state, "pull")
  const pullHost = new HostStopping()
  try {
    const result = await pullHost.run(() => client.callTool({ name: "pull_request_status", arguments: {} }))
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /GitHub is rate limited.*Try again after/)
    assert.doesNotMatch(JSON.stringify(result), /Add a GitHub remote|gh auth login|DO-NOT-SHOW-FIXTURE-DETAIL/)
  } finally { await pullHost.stop() }
  await writeFile(state, "user")
  // Standalone consumers without a host still retain a safe minimum retry time.
  const standalone = await githubStatus(repo)
  assert.ok(standalone.rateLimit)
  assert.match(pullSetupReason({ installed: false, authenticated: false })!, /Install the GitHub CLI/)
  assert.match(pullSetupReason({ installed: true, authenticated: false })!, /gh auth login/)
  assert.match(pullSetupReason({ installed: true, authenticated: true })!, /Add a GitHub remote/)
  assert.equal(pullSetupReason({ installed: true, authenticated: true, repo: "fixture/project" }), null)
  console.log("GitHub status/open: rate limits retain their retry deadline, never report missing remote/login, and do no writes")
} finally {
  if (previous === undefined) delete process.env.GH_PATH; else process.env.GH_PATH = previous
  await Promise.allSettled([client.close(), server.close(), host.stop(), git.close()])
  await rm(root, { recursive: true, force: true })
}
