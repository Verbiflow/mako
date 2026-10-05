import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { gitActionPrompt, gitCommands, PULL_REQUEST_WRITING, pullBaseFor, pullRequestDraftPrompt, type GitCommandFacts } from "../electron/contracts/git-actions.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { pullRequestTools } from "../electron/pull-request-tools.js"
import { mergePullRequest, openPullRequest, pullRequestReport, pullTemplate, rerunFailedChecks } from "../electron/pull-requests.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-git-actions-")))
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, "add", file)
  git(cwd, "commit", "-qm", message)
  return git(cwd, "rev-parse", "HEAD")
}

/*
 * GitHub, as a script standing in for `gh`: pull requests, runs and review
 * threads live in a JSON file the test reads and changes. It refuses to open a
 * pull request for a branch origin doesn't have, as GitHub does.
 */
const state = join(root, "github.json")
const ghPath = join(root, "gh")
writeFileSync(ghPath, `#!/usr/bin/env node
const { execFileSync } = require("node:child_process")
const { readFileSync, renameSync, writeFileSync } = require("node:fs")
const file = ${JSON.stringify(state)}
const db = JSON.parse(readFileSync(file, "utf8"))
const args = process.argv.slice(2)
// Mako reads several runs' logs at once; another gh mid-write must never see half a file.
const save = () => { writeFileSync(file + "." + process.pid, JSON.stringify(db, null, 2)); renameSync(file + "." + process.pid, file) }
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value))
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1) }
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const branch = () => execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()
db.calls.push(args.filter((arg) => !arg.startsWith("query=")).join(" "))
save()
const [a, b] = args
if (a === "--version") out("gh version 2.0.0")
else if (a === "api" && b === "user") out({ login: "you" })
else if (a === "api" && b === "graphql") out({ data: { repository: { pullRequest: { reviewThreads: { nodes: db.threads } } } } })
else if (a === "repo" && b === "view") out(flag("--json").includes("squash") ? db.methods : { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } })
else if (a === "pr" && b === "view") {
  const pull = db.pulls.filter((entry) => entry.headRefName === branch()).at(-1)
  pull ? out(pull) : fail("no pull requests found for branch " + branch())
} else if (a === "pr" && b === "create") {
  const head = branch()
  const pushed = execFileSync("git", ["ls-remote", "origin", "refs/heads/" + head], { encoding: "utf8" }).trim()
  if (!pushed) fail("aborted: you must first push the current branch to a remote")
  const number = 100 + db.pulls.length
  db.pulls.push({ number, title: flag("--title"), body: flag("--body"), state: "OPEN", isDraft: args.includes("--draft"), url: "https://github.com/o/r/pull/" + number,
    headRefName: head, baseRefName: flag("--base"), mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], latestReviews: [] })
  save()
  out("https://github.com/o/r/pull/" + number + "\\n")
} else if (a === "pr" && b === "edit") {
  const pull = db.pulls.find((entry) => entry.number === Number(args[2]))
  if (flag("--title") !== undefined) pull.title = flag("--title")
  if (flag("--body") !== undefined) pull.body = flag("--body")
  save()
} else if (a === "pr" && b === "merge") {
  const pull = db.pulls.find((entry) => entry.number === Number(args[2]))
  pull.state = "MERGED"
  db.merged.push(args[3])
  save()
} else if (a === "run" && b === "list") out(db.runs.filter((run) => run.branch === flag("--branch")))
else if (a === "run" && b === "rerun") { db.reruns.push(args[2] + " " + args[3]); save() }
else if (a === "run" && b === "view") out(db.logs[args[2]] ?? "")
else fail("unknown command: " + args.join(" "))
`)
chmodSync(ghPath, 0o755)
interface FakePull {
  number: number
  title: string
  body: string
  state: "OPEN" | "MERGED" | "CLOSED"
  reviewDecision: string
  latestReviews: { state: string; author: { login: string } }[]
  statusCheckRollup: { name: string; conclusion: string; detailsUrl?: string }[]
}
interface GitHubState {
  calls: string[]
  pulls: FakePull[]
  methods: Record<string, boolean>
  merged: string[]
  runs: { databaseId: number; headSha: string; conclusion: string; workflowName: string; url: string; branch: string }[]
  reruns: string[]
  logs: Record<string, string>
  threads: unknown[]
}
const github = (): GitHubState => JSON.parse(readFileSync(state, "utf8"))
const setGithub = (change: (db: GitHubState) => void) => {
  const db = github()
  change(db)
  writeFileSync(state, JSON.stringify(db))
}
writeFileSync(state, JSON.stringify({ calls: [], pulls: [], methods: { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }, merged: [], runs: [], reruns: [], logs: {}, threads: [] }))
process.env.GH_PATH = ghPath

let grants: Awaited<ReturnType<typeof startConversationMcp>> | undefined
const agent = new Client({ name: "git-actions-agent", version: "1" })

try {
  // The shared rules, read alike by the window and the host.
  assert.equal(pullBaseFor("mako/x", "origin/release", ["main", "release"], "main"), "release", "a worktree's pull request targets the branch it started from")
  assert.equal(pullBaseFor("mako/x", "release", ["main", "release"], "main"), "release")
  assert.equal(pullBaseFor("mako/x", "origin/spike", ["main"], "main"), "main", "a start the remote doesn't have falls back to the default")
  assert.equal(pullBaseFor("mako/x", "a1b2c3d", ["main"], "main"), "main", "a start at a commit falls back to the default")
  assert.equal(pullBaseFor("main", "origin/main", ["main"], "main"), undefined, "never a branch into itself")
  assert.ok(pullRequestDraftPrompt(null).includes(PULL_REQUEST_WRITING), "the drafter writes by the agent's rules")
  assert.match(pullRequestDraftPrompt("## Why\n\n## Risk"), /template:\n\n## Why\n\n## Risk$/)
  assert.ok(pullRequestDraftPrompt("x".repeat(9_000)).length < 6_000, "a long template is cut to fit the drafter's prompt")

  const facts: GitCommandFacts = { branch: "mako/x", github: null, defaultBranch: "main", worktree: { into: "main", behind: { from: "origin/main", commits: 4 } }, pull: null }
  const byName = (given: GitCommandFacts) => Object.fromEntries(gitCommands(given).map((command) => [command.name, command]))
  const ready = byName(facts)
  assert.deepEqual(Object.keys(ready), ["pr", "update", "fix-checks", "review"])
  assert.equal(ready.pr!.prompt, gitActionPrompt({ kind: "pr", branch: "mako/x" }))
  assert.equal(ready.update!.hint, "origin/main has 4 commits this branch doesn't")
  assert.equal(ready["fix-checks"]!.blocked, "Open a pull request first; its checks run on GitHub.")
  assert.match(ready.review!.prompt!, /git diff main\.\.\.HEAD/)
  const open = byName({ ...facts, pull: { number: 7, failing: ["test", "lint"] } })
  assert.equal(open.pr!.hint, "Push new commits to #7")
  assert.match(open["fix-checks"]!.prompt!, /^test and lint are failing on #7\. Call pull_request_status with logs: true/)
  const main = byName({ branch: "main", github: null, defaultBranch: "main", pull: null })
  assert.match(main.pr!.blocked!, /^Pull requests come from a branch other than main/)
  assert.equal(main.update!.blocked, "Only a Thread on its own branch updates from main.")
  assert.match(main.review!.prompt!, /^Review my uncommitted changes/)
  assert.equal(byName({ ...facts, github: undefined }).pr!.blocked, "Checking GitHub…")
  assert.equal(byName({ ...facts, operation: "merge" }).update!.blocked, "Finish the merge first.")
  assert.equal(byName({ ...facts, worktree: { into: "main", behind: { from: "origin/main", commits: 0 } } }).update!.blocked, "Already has everything in origin/main.")
  for (const command of gitCommands(facts)) assert.ok(Boolean(command.prompt) !== Boolean(command.blocked), `${command.name} either stages a message or says why not`)

  // An origin with main and release, and a clone to work in.
  const origin = join(root, "origin.git")
  git(root, "init", "-q", "--bare", "-b", "main", origin)
  const seed = join(root, "seed")
  git(root, "clone", "-q", origin, seed)
  git(seed, "checkout", "-q", "-b", "main")
  mkdirSync(join(seed, ".github"))
  writeFileSync(join(seed, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Why\n\n## Risk\n")
  git(seed, "add", ".github")
  commit(seed, "a.txt", "a", "one")
  git(seed, "push", "-q", "origin", "main")
  git(seed, "push", "-q", "origin", "main:release")
  const project = join(root, "project")
  git(root, "clone", "-q", origin, project)
  git(project, "checkout", "-q", "-b", "mako/feature", "origin/main")

  assert.equal(await pullTemplate(project), "## Why\n\n## Risk", "the template is found in any case")
  const nothing = await pullRequestReport(project)
  assert.equal(nothing.opening?.base, "main")
  assert.equal(nothing.opening?.blocked, "mako/feature has no commits that main doesn't. Commit the work first.")
  assert.equal(nothing.opening?.template, "## Why\n\n## Risk")
  assert.equal((await pullRequestReport(project, { startedFrom: "origin/release" })).opening?.base, "release", "the report targets the worktree's start")
  await assert.rejects(openPullRequest(project, { title: "Nothing" }), /no commits that main doesn't/)
  assert.equal(git(origin, "branch", "--list", "mako/feature"), "", "a refused opening pushes nothing")

  // Opening: pushed first, then opened against the base by the shared rule.
  const first = commit(project, "b.txt", "b", "Add b")
  writeFileSync(join(project, "draft.txt"), "not yet")
  const report = await pullRequestReport(project)
  assert.deepEqual(report.opening?.commits, [`${first.slice(0, 7)} Add b`])
  assert.equal(report.opening?.blocked, undefined)
  await assert.rejects(openPullRequest(project, { body: "no title" }), /needs a title/)
  const opened = await openPullRequest(project, { title: "Add b", body: "## Why\nBecause." })
  assert.deepEqual([opened.opened, opened.pushed, opened.uncommitted, opened.pull.number, opened.pull.base], [true, 1, 1, 100, "main"])
  assert.equal(git(origin, "rev-parse", "mako/feature"), first, "the branch was pushed before GitHub was asked")
  assert.ok(github().calls.includes("pr create --title Add b --body ## Why\nBecause. --base main"))

  // Again, with the pull request open: push the new commit, leave the title alone unless given.
  commit(project, "c.txt", "c", "Add c")
  const again = await openPullRequest(project, {})
  assert.deepEqual([again.opened, again.pushed, again.edited], [false, 1, false])
  assert.equal(git(origin, "rev-parse", "mako/feature"), git(project, "rev-parse", "HEAD"))
  const edited = await openPullRequest(project, { body: "## Why\nBecause, and c." })
  assert.deepEqual([edited.pushed, edited.edited, edited.pull.body], [0, true, "## Why\nBecause, and c."])
  assert.ok(!github().calls.some((call) => call.startsWith("pr edit 100 --title")), "a title not passed isn't changed")

  // Someone else pushed: refused, and nothing forced.
  const other = join(root, "other")
  git(root, "clone", "-q", "-b", "mako/feature", origin, other)
  const theirs = commit(other, "d.txt", "d", "Theirs")
  git(other, "push", "-q", "origin", "mako/feature")
  commit(project, "e.txt", "e", "Mine")
  await assert.rejects(openPullRequest(project, {}), /origin\/mako\/feature has commits this branch doesn't\. Pull them in first .* Mako never force-pushes\./)
  assert.equal(git(origin, "rev-parse", "mako/feature"), theirs, "origin keeps their commit")
  git(project, "pull", "-q", "--no-rebase", "--no-edit", "origin", "mako/feature")
  await openPullRequest(project, {})
  const pushed = git(project, "rev-parse", "HEAD")

  // Status: checks, reviews, unresolved comments, and the failed jobs' logs on the pushed commit only.
  setGithub((db) => {
    Object.assign(db.pulls[0]!, {
      reviewDecision: "CHANGES_REQUESTED",
      latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "ann" } }],
      statusCheckRollup: [{ name: "test", conclusion: "FAILURE", detailsUrl: "https://ci/test" }, { name: "lint", conclusion: "SUCCESS" }],
    })
    db.runs = [
      { databaseId: 1, headSha: pushed, conclusion: "failure", workflowName: "CI", url: "https://ci/1", branch: "mako/feature" },
      { databaseId: 2, headSha: pushed, conclusion: "success", workflowName: "Docs", url: "https://ci/2", branch: "mako/feature" },
      { databaseId: 3, headSha: first, conclusion: "failure", workflowName: "CI", url: "https://ci/3", branch: "mako/feature" },
      { databaseId: 4, headSha: pushed, conclusion: "timed_out", workflowName: "E2E", url: "https://ci/4", branch: "mako/feature" },
    ]
    db.logs = { "1": "test\tRun tests\t2026-10-04T01:02:03.456Z expected 2, got 3\n", "4": "e2e\tRun\t2026-10-04T01:02:03.456Z timed out\n" }
    db.threads = [
      { isResolved: false, isOutdated: false, path: "b.txt", line: 1, comments: { nodes: [{ author: { login: "ann" }, body: "Name this better." }] } },
      { isResolved: true, isOutdated: false, path: "b.txt", line: 2, comments: { nodes: [{ author: { login: "ann" }, body: "Done." }] } },
      { isResolved: false, isOutdated: true, path: "c.txt", line: 1, comments: { nodes: [{ author: { login: "ann" }, body: "Old." }] } },
    ]
  })
  const status = await pullRequestReport(project, { logs: true })
  assert.deepEqual(status.pullRequest?.checks, [{ name: "test", state: "failed", url: "https://ci/test" }, { name: "lint", state: "passed" }])
  assert.equal(status.pullRequest?.merge, "Fix failing checks first")
  assert.deepEqual(status.pullRequest?.reviews, ["ann: changes"])
  assert.deepEqual(status.pullRequest?.reviewComments, [{ at: "b.txt:1", comments: ["ann: Name this better."] }], "only unresolved comments on current code")
  assert.deepEqual(status.pullRequest?.failedLogs, [
    { workflow: "CI", url: "https://ci/1", log: "test\tRun tests\texpected 2, got 3" },
    { workflow: "E2E", url: "https://ci/4", log: "e2e\tRun\ttimed out" },
  ], "the failed runs on the pushed commit, without timestamps")
  assert.equal(status.opening, undefined)

  // Re-run: each failed run on the pushed commit, named, since gh can't ask which.
  assert.equal(await rerunFailedChecks(project), 2)
  assert.deepEqual(github().reruns, ["1 --failed", "4 --failed"])

  // Merge: the shared guard, then a method the repository allows.
  await assert.rejects(mergePullRequest(project), /^Error: #100 can't merge yet\. Fix failing checks first\.$/)
  setGithub((db) => Object.assign(db.pulls[0]!, { reviewDecision: "APPROVED", statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }] }))
  setGithub((db) => { db.methods = { squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: false } })
  await assert.rejects(mergePullRequest(project, "squash"), /doesn't allow squash merges\. It allows: merge\./)
  const merged = await mergePullRequest(project)
  assert.deepEqual([merged.method, merged.pull.state, github().merged], ["merge", "merged", ["--merge"]])
  await assert.rejects(mergePullRequest(project), /no open pull request/)
  assert.equal((await pullRequestReport(project)).lastPullRequest?.state, "merged", "a merged pull request is reported as the last one")

  // On the default branch: refused before anything is pushed.
  git(project, "checkout", "-q", "main")
  await assert.rejects(openPullRequest(project, { title: "From main" }), /main is the repository's default branch/)

  // The tools, over the conversation's `mako` server.
  git(project, "checkout", "-q", "-b", "mako/second", "origin/main")
  commit(project, "f.txt", "f", "Add f")
  let changed = 0
  const tools = pullRequestTools({ cwd: () => project, startedFrom: async () => "origin/release", changed: () => { changed += 1 } })
  grants = await startConversationMcp({ authorizeAgent: () => {} }, async () => ({ content: [] }), undefined, undefined, tools)
  const grant = grants.mint("binding", "c")
  await agent.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl!), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
  const listed = (await agent.listTools()).tools
  assert.deepEqual(listed.map((tool) => tool.name), ["pull_request_status", "pull_request_open", "pull_request_merge"])
  for (const tool of listed) assert.match(tool.description ?? "", /^Call (when|before|only when)\b/, `${tool.name} opens with when to call it`)
  const describe = (name: string) => listed.find((tool) => tool.name === name)!
  assert.ok(describe("pull_request_open").description!.endsWith(PULL_REQUEST_WRITING), "the agent writes by the drafter's rules")
  assert.match(describe("pull_request_open").description!, /instead of `gh pr create`/)
  assert.equal(describe("pull_request_status").annotations?.readOnlyHint, true)
  assert.equal(describe("pull_request_merge").annotations?.destructiveHint, true)
  assert.match(agent.getInstructions() ?? "", /^pull_request_\*: /m, "the server says what the family is for")
  const text = (result: Awaited<ReturnType<typeof agent.callTool>>) => z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text
  const read = parseYaml(text(await agent.callTool({ name: "pull_request_status", arguments: {} })))
  assert.equal(read.opening.base, "release", "the tool targets where this Thread's worktree started")
  const refused = await agent.callTool({ name: "pull_request_open", arguments: {} })
  assert.equal(refused.isError, true)
  assert.equal(text(refused), "A new pull request needs a title.")
  assert.equal(changed, 0, "a refused call tells no window anything")
  const made = text(await agent.callTool({ name: "pull_request_open", arguments: { title: "Add f", body: "## Why\nf.", draft: true } }))
  assert.equal(made, "Opened #101 as a draft into release: https://github.com/o/r/pull/101. 1 file with uncommitted changes stayed behind; commit what belongs in it and call again to push.")
  assert.equal(changed, 1, "windows read GitHub again after opening")
  rmSync(join(project, "draft.txt"))
  assert.equal(text(await agent.callTool({ name: "pull_request_open", arguments: {} })), "#101 was already open; nothing new to push: https://github.com/o/r/pull/101.")

  console.log("Git actions: shared base, writing rules and commands; open pushes first and never forces, updates the open one, refuses the default branch and empty branches; status with checks, comments and failed logs; re-run names each run; merge by the shared guard and allowed methods; the tools over HTTP MCP")
} finally {
  await agent.close().catch(() => {})
  grants?.close()
  rmSync(root, { recursive: true, force: true })
}
