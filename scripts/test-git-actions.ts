import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { gitActionPrompt, gitCommands, gitRepositoryName, PULL_REQUEST_WRITING, pullBaseFor, type GitCommandFacts } from "@mako/host/contracts/git-actions"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { pullRequestTools, registerPullRequestTools, type ReachableRepository, type RepositoryPlace } from "@mako/host/git/pull-request-tools"
import { mergePullRequest, openedSentence, openPullRequest, pullRequestReport, pullTemplate, rerunFailedChecks } from "@mako/host/git/pull-requests"
import checksFixture from "./fixtures/pull-request-checks.json" with { type: "json" }

const gitRunner = new Git()

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
// Each repository's pull requests are its own, as on GitHub: two repositories may have the same branch.
const repo = () => require("node:path").basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim())
db.calls.push(args.filter((arg) => !arg.startsWith("query=")).join(" "))
save()
const [a, b] = args
if (a === "--version") out("gh version 2.0.0")
else if (a === "api" && b === "user") out({ login: "you" })
else if (a === "api" && b === "graphql") out({ data: { repository: { pullRequest: { reviewThreads: { nodes: db.threads } } } } })
else if (a === "api" && b === "repos/{owner}/{repo}") out({ full_name: "o/r", html_url: "https://github.com/o/r", default_branch: "main", allow_squash_merge: db.methods.squashMergeAllowed, allow_merge_commit: db.methods.mergeCommitAllowed, allow_rebase_merge: db.methods.rebaseMergeAllowed })
else if (a === "pr" && b === "view" && /^\\d+$/.test(args[2])) {
  const pull = db.pulls.find((entry) => entry.number === Number(args[2]) && entry.repo === repo())
  pull ? out(pull) : fail("GraphQL: Could not resolve to a PullRequest with the number of " + args[2] + ".")
} else if (a === "pr" && b === "view") {
  const pull = db.pulls.filter((entry) => entry.headRefName === branch() && entry.repo === repo()).at(-1)
  pull ? out(pull) : fail("no pull requests found for branch " + branch())
} else if (a === "pr" && b === "create") {
  const head = branch()
  const pushed = execFileSync("git", ["ls-remote", "origin", "refs/heads/" + head], { encoding: "utf8" }).trim()
  if (!pushed) fail("aborted: you must first push the current branch to a remote")
  const number = 100 + db.pulls.length
  db.pulls.push({ number, repo: repo(), title: flag("--title"), body: flag("--body"), state: "OPEN", isDraft: args.includes("--draft"), url: "https://github.com/o/r/pull/" + number,
    headRefName: head, baseRefName: flag("--base"), mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], latestReviews: [] })
  save()
  out("https://github.com/o/r/pull/" + number + "\\n")
} else if (a === "pr" && b === "edit") {
  // gh pr edit reads the pull request's classic Projects through GraphQL, which a token without read:project can't.
  fail("error: your authentication token is missing required scopes [read:project]")
} else if (a === "api" && b === "-X" && args[2] === "PATCH" && args[3].startsWith("repos/{owner}/{repo}/pulls/")) {
  if (db.editRefusal) fail(db.editRefusal)
  const fields = JSON.parse(readFileSync(flag("--input"), "utf8"))
  const pull = db.pulls.find((entry) => entry.number === Number(args[3].split("/").at(-1)) && entry.repo === repo())
  if (!pull) fail("gh: Not Found (HTTP 404)")
  db.edits.push(fields)
  Object.assign(pull, fields)
  save()
  out(pull)
} else if (a === "pr" && b === "merge") {
  const pull = db.pulls.find((entry) => entry.number === Number(args[2]))
  pull.state = "MERGED"
  db.merged.push(args[3])
  save()
} else if (a === "run" && b === "list") out(db.runs.filter((run) => run.branch === flag("--branch")))
else if (a === "run" && b === "rerun") { db.reruns.push(args[2] + " " + args[3]); save() }
else if (a === "run" && b === "view" && args[2] === "--job") out(args[4] === "--log-failed" ? db.jobLogs[args[3]]?.failed ?? "" : db.jobLogs[args[3]]?.all ?? "")
else if (a === "run" && b === "view") out(db.logs[args[2]] ?? "")
else fail("unknown command: " + args.join(" "))
`)
chmodSync(ghPath, 0o755)
interface FakePull {
  number: number
  repo: string
  title: string
  body: string
  state: "OPEN" | "MERGED" | "CLOSED"
  reviewDecision: string
  latestReviews: { state: string; author: { login: string } }[]
  statusCheckRollup: { name: string; conclusion: string; status?: string; detailsUrl?: string; workflowName?: string; startedAt?: string; completedAt?: string }[]
}
interface GitHubState {
  calls: string[]
  pulls: FakePull[]
  /** What each REST edit sent, as its JSON input. */
  edits: { title?: string; body?: string }[]
  /** Set: GitHub refuses edits with these words. */
  editRefusal?: string
  methods: Record<string, boolean>
  merged: string[]
  runs: { databaseId: number; headSha: string; conclusion: string; workflowName: string; url: string; branch: string }[]
  reruns: string[]
  logs: Record<string, string>
  jobLogs: Record<string, { failed?: string; all?: string }>
  threads: unknown[]
}
const github = (): GitHubState => JSON.parse(readFileSync(state, "utf8"))
const setGithub = (change: (db: GitHubState) => void) => {
  const db = github()
  change(db)
  writeFileSync(state, JSON.stringify(db))
}
writeFileSync(state, JSON.stringify({ calls: [], pulls: [], edits: [], methods: { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }, merged: [], runs: [], reruns: [], logs: {}, jobLogs: {}, threads: [] }))
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

  const facts: GitCommandFacts = { branch: "mako/x", github: null, defaultBranch: "main", worktree: { into: "main", behind: { from: "origin/main", commits: 4 } }, pull: null }
  const byName = (given: GitCommandFacts) => Object.fromEntries(gitCommands(given).map((command) => [command.name, command]))
  const ready = byName(facts)
  assert.deepEqual(Object.keys(ready), ["pr", "update", "fix-checks"])
  assert.equal(ready.pr!.prompt, gitActionPrompt({ kind: "pr", branch: "mako/x" }))
  assert.equal(ready.update!.hint, "origin/main has 4 commits this branch doesn't")
  assert.equal(ready["fix-checks"]!.blocked, "Open a pull request first; its checks run on GitHub.")
  const open = byName({ ...facts, pull: { number: 7, failing: ["test", "lint"] } })
  assert.equal(open.pr!.hint, "Push new commits to #7")
  assert.match(open["fix-checks"]!.prompt!, /^test and lint are failing on #7\. Call pull_request_status with logs: true/)
  const main = byName({ branch: "main", github: null, defaultBranch: "main", pull: null })
  assert.match(main.pr!.blocked!, /^Pull requests come from a branch other than main/)
  assert.equal(main.update!.blocked, "Only a Thread on its own branch updates from main.")
  assert.equal(byName({ ...facts, github: undefined }).pr!.blocked, "Checking GitHub…")
  assert.equal(byName({ ...facts, operation: "merge" }).update!.blocked, "Finish the merge first.")
  assert.equal(byName({ ...facts, worktree: { into: "main", behind: { from: "origin/main", commits: 0 } } }).update!.blocked, "Already has everything in origin/main.")
  for (const command of gitCommands(facts)) assert.ok(Boolean(command.prompt) !== Boolean(command.blocked), `${command.name} either stages a message or says why not`)
  // In a project folder of several repositories, every tool call the message asks for names the repository on screen.
  assert.equal(
    gitActionPrompt({ kind: "pr", branch: "mako/x", base: "release", draft: true, repository: "web" }),
    "Open a pull request for `mako/x` in `web` into `release` as a draft. Call pull_request_status with repository `web` for the base, the commits it would carry and the repository's template, and commit anything that belongs in it. Then write the title and body from what this branch does and why, and open it with pull_request_open with repository `web`, base `release` and draft: true. Reply with its link.",
  )
  assert.equal(gitActionPrompt({ kind: "push", number: 7, repository: "web" }), "Bring #7 in `web` up to date: commit what belongs in it, then call pull_request_open with repository `web` to push. If its title or body no longer says what the branch does, pass new ones.")
  assert.match(gitActionPrompt({ kind: "fix-checks", number: 7, failing: ["test"], repository: "web" }), /^test is failing on #7 in `web`\. Call pull_request_status with logs: true and repository `web` to read why, .* push with pull_request_open with repository `web`\.$/)
  assert.match(gitActionPrompt({ kind: "resolve", branch: "mako/x", from: "origin/main", files: ["a.ts"], repository: "web" }), /^Merging origin\/main into mako\/x in `web` stopped on conflicts in a\.ts\. .* `git merge --continue` in that repository's folder\.$/)
  const shown = { root: "/p/web", repositories: [{ label: "api", root: "/p/api" }, { label: "web", root: "/p/web" }] }
  assert.equal(gitRepositoryName(shown), "web", "the window names the repository its Git panel shows")
  assert.equal(gitRepositoryName({ root: "/p/web", repositories: [{ label: "web", root: "/p/web" }] }), undefined, "and none in a single repository")
  assert.equal(gitRepositoryName({ root: "/p/web" }), undefined)
  const inWeb = byName({ ...facts, repository: "web", pull: { number: 7, failing: ["test"] } })
  assert.equal(inWeb.pr!.hint, "Push new commits to #7 in web")
  assert.equal(inWeb.pr!.prompt, gitActionPrompt({ kind: "push", number: 7, repository: "web" }))
  assert.equal(inWeb["fix-checks"]!.prompt, gitActionPrompt({ kind: "fix-checks", number: 7, failing: ["test"], repository: "web" }))
  assert.equal(inWeb.update!.prompt, gitActionPrompt({ kind: "update", branch: "mako/x", from: "origin/main" }), "worktree_update acts on every repository, so its message names none")

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

  assert.equal(await pullTemplate(gitRunner, project), "## Why\n\n## Risk", "the template is found in any case")
  const nothing = await pullRequestReport(gitRunner, project)
  assert.equal(nothing.opening?.base, "main")
  assert.equal(nothing.opening?.blocked, "mako/feature has no commits that main doesn't. Commit the work first.")
  assert.equal(nothing.opening?.template, "## Why\n\n## Risk")
  assert.equal((await pullRequestReport(gitRunner, project, { startedFrom: "origin/release" })).opening?.base, "release", "the report targets the worktree's start")
  await assert.rejects(openPullRequest(gitRunner, project, { title: "Nothing" }), /no commits that main doesn't/)
  assert.equal(git(origin, "branch", "--list", "mako/feature"), "", "a refused opening pushes nothing")

  // Opening: pushed first, then opened against the base by the shared rule.
  const first = commit(project, "b.txt", "b", "Add b")
  writeFileSync(join(project, "draft.txt"), "not yet")
  const report = await pullRequestReport(gitRunner, project)
  assert.deepEqual(report.opening?.commits, [`${first.slice(0, 7)} Add b`])
  assert.equal(report.opening?.blocked, undefined)
  await assert.rejects(openPullRequest(gitRunner, project, { body: "no title" }), /needs a title/)
  const opened = await openPullRequest(gitRunner, project, { title: "Add b", body: "## Why\nBecause." })
  assert.deepEqual([opened.opened, opened.pushed, opened.uncommitted, opened.pull.number, opened.pull.base], [true, 1, 1, 100, "main"])
  assert.equal(git(origin, "rev-parse", "mako/feature"), first, "the branch was pushed before GitHub was asked")
  assert.ok(github().calls.includes("pr create --title Add b --body ## Why\nBecause. --base main"))

  // Again, with the pull request open: push the new commit, leave the title alone unless given.
  commit(project, "c.txt", "c", "Add c")
  const again = await openPullRequest(gitRunner, project, {})
  assert.deepEqual([again.opened, again.pushed, again.edited], [false, 1, false])
  assert.equal(git(origin, "rev-parse", "mako/feature"), git(project, "rev-parse", "HEAD"))
  const edited = await openPullRequest(gitRunner, project, { body: "## Why\nBecause, and c." })
  assert.deepEqual([edited.pushed, edited.edited, edited.pull.body], [0, true, "## Why\nBecause, and c."], "with nothing to push, the edit still applies")
  assert.deepEqual(github().edits.at(-1), { body: "## Why\nBecause, and c." }, "a title not passed isn't changed")
  // Edits go over REST, the fields in a file: gh pr edit needs read:project, which the person's token may lack.
  assert.ok(github().calls.some((call) => /^api -X PATCH repos\/\{owner\}\/\{repo\}\/pulls\/100 --input \S+$/.test(call)), "the edit is a REST PATCH")
  assert.ok(!github().calls.some((call) => call.startsWith("pr edit")), "never gh pr edit")
  const retitled = await openPullRequest(gitRunner, project, { title: "Add b and c", body: "## Why\nBoth." })
  assert.deepEqual([retitled.pushed, retitled.edited, retitled.pull.title, retitled.pull.body], [0, true, "Add b and c", "## Why\nBoth."], "title and body together, nothing to push")

  // A push and an edit in one call: both happen.
  commit(project, "c2.txt", "c2", "Add c2")
  const pushedAndEdited = await openPullRequest(gitRunner, project, { title: "Add b, c and c2", body: "## Why\nAll three." })
  assert.deepEqual([pushedAndEdited.pushed, pushedAndEdited.edited, pushedAndEdited.pull.title, pushedAndEdited.pull.body], [1, true, "Add b, c and c2", "## Why\nAll three."])
  assert.equal(git(origin, "rev-parse", "mako/feature"), git(project, "rev-parse", "HEAD"), "the commit was pushed")
  assert.equal(openedSentence(pushedAndEdited), "#100 was already open; pushed 1 commit and updated its title and body: https://github.com/o/r/pull/100")

  // The edit refused after the push went: the error says the push happened, so nobody takes it for nothing done.
  setGithub((db) => { db.editRefusal = "gh: Validation Failed (HTTP 422)" })
  commit(project, "c3.txt", "c3", "Add c3")
  await assert.rejects(openPullRequest(gitRunner, project, { title: "Refused" }), (error: Error) => {
    assert.equal(error.message, "Pushed 1 commit to #100, but GitHub didn't change its title or body: gh: Validation Failed (HTTP 422)")
    return true
  })
  assert.equal(git(origin, "rev-parse", "mako/feature"), git(project, "rev-parse", "HEAD"), "the push stands")
  assert.equal(github().pulls[0]!.title, "Add b, c and c2", "the refused edit changed nothing")
  await assert.rejects(openPullRequest(gitRunner, project, { body: "Again" }), /^Error: #100 had nothing new to push, but GitHub didn't change its title or body: /)
  setGithub((db) => { delete db.editRefusal })

  // Someone else pushed: refused, and nothing forced.
  const other = join(root, "other")
  git(root, "clone", "-q", "-b", "mako/feature", origin, other)
  const theirs = commit(other, "d.txt", "d", "Theirs")
  git(other, "push", "-q", "origin", "mako/feature")
  commit(project, "e.txt", "e", "Mine")
  await assert.rejects(openPullRequest(gitRunner, project, {}), /origin\/mako\/feature has commits this branch doesn't\. Pull them in first .* Mako never force-pushes\./)
  assert.equal(git(origin, "rev-parse", "mako/feature"), theirs, "origin keeps their commit")
  git(project, "pull", "-q", "--no-rebase", "--no-edit", "origin", "mako/feature")
  await openPullRequest(gitRunner, project, {})
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
  const status = await pullRequestReport(gitRunner, project, { logs: true, checks: "all" })
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
  assert.equal(await rerunFailedChecks(gitRunner, project), 2)
  assert.deepEqual(github().reruns, ["1 --failed", "4 --failed"])

  // Pushed twice: GitHub ran the head again and cancelled the older runs. Those were replaced, not failed: no check
  // failing, no log, nothing to re-run. A cancelled run nothing replaced says cancelled, and holds the merge.
  setGithub((db) => {
    Object.assign(db.pulls[0]!, {
      reviewDecision: "APPROVED",
      statusCheckRollup: [
        { workflowName: "CI", name: "test", conclusion: "CANCELLED", startedAt: "2026-11-13T10:00:00Z" },
        { workflowName: "CI", name: "test", conclusion: "SUCCESS", startedAt: "2026-11-13T10:02:00Z" },
        { workflowName: "Docs", name: "build", conclusion: "CANCELLED", startedAt: "2026-11-13T10:00:00Z" },
      ],
    })
    db.runs = [
      { databaseId: 12, headSha: pushed, conclusion: "success", workflowName: "CI", url: "https://ci/12", branch: "mako/feature" },
      { databaseId: 11, headSha: pushed, conclusion: "cancelled", workflowName: "CI", url: "https://ci/11", branch: "mako/feature" },
      { databaseId: 10, headSha: pushed, conclusion: "cancelled", workflowName: "Docs", url: "https://ci/10", branch: "mako/feature" },
    ]
    db.logs = { "10": "build\tBuild\t2026-11-13T10:00:01.000Z The operation was canceled.\n", "11": "test\tRun\t2026-11-13T10:00:01.000Z The operation was canceled.\n" }
  })
  const pushedTwice = await pullRequestReport(gitRunner, project, { logs: true, checks: "all" })
  assert.deepEqual(pushedTwice.pullRequest?.checks, [{ name: "test", state: "passed" }, { name: "build", state: "cancelled" }], "the run a newer run replaced isn't read; the lone cancelled one says cancelled")
  assert.equal(pushedTwice.pullRequest?.merge, "Run the cancelled checks again first")
  assert.deepEqual(pushedTwice.pullRequest?.failedLogs, [{ workflow: "Docs", url: "https://ci/10", log: "build\tBuild\tThe operation was canceled." }], "no log of the replaced run")
  assert.equal(await rerunFailedChecks(gitRunner, project), 1)
  assert.deepEqual(github().reruns.slice(2), ["10 --failed"], "only the cancelled run nothing replaced is run again")
  setGithub((db) => Object.assign(db.pulls[0]!, { reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] }))

  // Merge: the shared guard, then a method the repository allows.
  await assert.rejects(mergePullRequest(project), /^Error: #100 can't merge yet\. Fix failing checks first\.$/)
  setGithub((db) => Object.assign(db.pulls[0]!, { reviewDecision: "APPROVED", statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }] }))
  setGithub((db) => { db.methods = { squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: false } })
  await assert.rejects(mergePullRequest(project, "squash"), /doesn't allow squash merges\. It allows: merge\./)
  const merged = await mergePullRequest(project)
  assert.deepEqual([merged.method, merged.pull.state, github().merged], ["merge", "merged", ["--merge"]])
  await assert.rejects(mergePullRequest(project), /no open pull request/)
  assert.equal((await pullRequestReport(gitRunner, project)).lastPullRequest?.state, "merged", "a merged pull request is reported as the last one")

  // On the default branch: refused before anything is pushed.
  git(project, "checkout", "-q", "main")
  await assert.rejects(openPullRequest(gitRunner, project, { title: "From main" }), /main is the repository's default branch/)

  // The tools, over the conversation's `mako` server.
  git(project, "checkout", "-q", "-b", "mako/second", "origin/main")
  commit(project, "f.txt", "f", "Add f")
  let changed = 0
  const alone: ReachableRepository = { name: "project", root: project, startedFrom: "origin/release" }
  const tools = pullRequestTools({ git: gitRunner, place: async () => ({ folder: project, repositories: [alone], here: alone }), changed: () => { changed += 1 } })
  const onFullAccess = new Set(["full"])
  grants = await startConversationMcp({ authorizeAgent: () => {} }, async () => ({ content: [] }), [(server, id) => registerPullRequestTools(server, tools, id, (conversation) => onFullAccess.has(conversation))])
  const grant = grants.mint("binding", "c")
  await agent.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl!), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
  const listed = (await agent.listTools()).tools
  assert.deepEqual(listed.map((tool) => tool.name), ["pull_request_status", "pull_request_open", "pull_request_merge", "pull_request_rerun"])
  for (const tool of listed) assert.match(tool.description ?? "", /^Call (when|before|only when)\b/, `${tool.name} opens with when to call it`)
  const describe = (name: string) => listed.find((tool) => tool.name === name)!
  assert.ok(describe("pull_request_open").description!.endsWith(PULL_REQUEST_WRITING), "the agent writes by the shared rules")
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

  // Another pull request of the same repository by its number, and one job's or run's log by its id: what an Apex
  // reads of its Fins' pull requests, read only.
  setGithub((db) => {
    Object.assign(db.pulls[0]!, { headRefOid: pushed })
    db.jobLogs = {
      "5512": { failed: "e2e\tRun\t2026-11-17T01:02:03.456Z expected 1 row, got 0\n", all: "e2e\tSetup\t2026-11-17T01:00:00.000Z ok\ne2e\tRun\t2026-11-17T01:02:03.456Z expected 1 row, got 0\n" },
      "77": { all: "lint\tRun\t2026-11-17T01:00:00.000Z 0 warnings\n" },
    }
  })
  const writesBefore = github().calls.length
  const byNumber = parseYaml(text(await agent.callTool({ name: "pull_request_status", arguments: { number: 100, logs: true } })))
  assert.deepEqual([byNumber.pullRequest.number, byNumber.pullRequest.state, byNumber.pullRequest.head, byNumber.pullRequest.merge], [100, "merged", "mako/feature", "It is merged."], "another pull request reads by its number, whatever this branch is")
  assert.deepEqual(byNumber.pullRequest.failedLogs, [{ workflow: "Docs", url: "https://ci/10", log: "build\tBuild\tThe operation was canceled." }], "its failed logs are its own head's, not this branch's")
  assert.equal(byNumber.pullRequest.headCommit, pushed, "with its head commit, which an Apex checks before a merge")
  assert.equal(byNumber.branch, undefined, "a pull request by number says nothing of this branch")
  const job = parseYaml(text(await agent.callTool({ name: "pull_request_status", arguments: { job: 5512 } })))
  assert.deepEqual(job, { job: 5512, log: "e2e\tRun\texpected 1 row, got 0" }, "a named job's failed steps, without timestamps")
  assert.deepEqual(parseYaml(text(await agent.callTool({ name: "pull_request_status", arguments: { job: 77 } }))), { job: 77, log: "lint\tRun\t0 warnings" }, "a job with no failed step gives its whole log")
  assert.deepEqual(parseYaml(text(await agent.callTool({ name: "pull_request_status", arguments: { run: 11 } }))), { run: 11, log: "test\tRun\tThe operation was canceled." }, "a named run's failed log")
  const withJob = parseYaml(text(await agent.callTool({ name: "pull_request_status", arguments: { number: 100, job: 5512 } })))
  assert.deepEqual([withJob.pullRequest.number, withJob.log.job], [100, 5512], "a number and a job read both")
  const missing = await agent.callTool({ name: "pull_request_status", arguments: { number: 999 } })
  assert.equal(missing.isError, true)
  assert.match(text(missing), /has no pull request #999/)
  const reads = github().calls.slice(writesBefore)
  assert.ok(reads.every((call) => /^(--version|api |pr view |run view |run list |repo view )/.test(call)), `reading another pull request writes nothing: ${reads.filter((call) => !/^(--version|api |pr view |run view |run list |repo view )/.test(call)).join("; ")}`)
  assert.ok(reads.includes("run view --job 5512 --log-failed"))

  // Checks as an agent waiting on CI reads them: counts, then only what didn't pass. The fixture is Verbiflow/mako#974's
  // 71 checks as gh listed them, 59 passed and 12 skipped, `gate (1)` to `gate (45)` among them.
  type Rollup = FakePull["statusCheckRollup"]
  const fixtureRows = z.array(z.object({ name: z.string(), conclusion: z.string(), status: z.string().optional(), detailsUrl: z.string().optional(), workflowName: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional() }))
  const rollup = (change: (checks: Rollup) => void = () => {}) => {
    const checks: Rollup = fixtureRows.parse(structuredClone(checksFixture))
    change(checks)
    setGithub((db) => { db.pulls.find((pull) => pull.number === 101)!.statusCheckRollup = checks })
  }
  const statusOf = async (args: { checks?: "all" } = {}) => parseYaml(text(await agent.callTool({ name: "pull_request_status", arguments: args }))).pullRequest
  const urlOf = (name: string) => checksFixture.find((check) => check.name === name)!.detailsUrl
  rollup()
  const allPassed = await statusOf()
  assert.deepEqual(allPassed.checks, { totals: "59 passed, 12 skipped" }, "all passed: one line of counts, no check listed")
  assert.equal(allPassed.number, 101, "the rest of the report stays")
  assert.ok(allPassed.merge && allPassed.mergeable, "the merge line and mergeable stay")
  const failing = ["checks (types)", "gate (7)"]
  const running = ["gate (10)", "gate (11)", "gate (12)", "gate (13)", "gate (14)"]
  rollup((checks) => {
    for (const check of checks) {
      if (failing.includes(check.name)) check.conclusion = "FAILURE"
      if (running.includes(check.name)) Object.assign(check, { status: "IN_PROGRESS", conclusion: "" })
    }
  })
  const someFailed = await statusOf()
  assert.deepEqual(someFailed.checks, {
    totals: "52 passed, 12 skipped, 2 failed, 5 running",
    notPassed: [
      `checks (types): failed ${urlOf("checks (types)")}`,
      `gate (7): failed ${urlOf("gate (7)")}`,
      `gate (10, 11, 12, 13, 14): running ${urlOf("gate (10)")}`,
    ],
  }, "failed and running checks each with a link; one matrix family sharing a state is one line")
  assert.match(someFailed.merge, /Fix failing checks first/)
  rollup((checks) => { for (const check of checks) if (running.includes(check.name)) Object.assign(check, { status: check.name === "gate (10)" ? "QUEUED" : "IN_PROGRESS", conclusion: "" }) })
  assert.deepEqual((await statusOf()).checks, {
    totals: "54 passed, 12 skipped, 5 running",
    notPassed: [`gate (10, 11, 12, 13, 14): running ${urlOf("gate (10)")}`],
  }, "running only, queued ones with them: the family once")
  rollup((checks) => { checks.find((check) => check.name === "mac-host")!.conclusion = "CANCELLED" })
  assert.deepEqual((await statusOf()).checks, {
    totals: "59 passed, 11 skipped, 1 cancelled",
    notPassed: [`mac-host: cancelled ${urlOf("mac-host")}`],
  }, "a cancelled check is listed")
  rollup()
  const every = z.array(z.object({ name: z.string(), state: z.string(), url: z.string().optional() }).strict()).parse((await statusOf({ checks: "all" })).checks)
  assert.equal(every.length, 71, "checks: all lists every check")
  assert.deepEqual(every[0], { name: "Analyze (actions)", state: "passed", url: urlOf("Analyze (actions)") })
  assert.equal(every.filter((check) => check.state === "skipped").length, 12, "and says which were skipped")
  const schema = z.object({ properties: z.object({ checks: z.object({ const: z.literal("all") }) }) }).safeParse(describe("pull_request_status").inputSchema)
  assert.ok(schema.success, "pull_request_status takes checks: all")
  // Re-run, as the sidebar's: the failed jobs of each failed run on the pushed commit.
  const rerunsBefore = github().reruns.length
  const rerun = text(await agent.callTool({ name: "pull_request_rerun", arguments: {} }))
  assert.match(rerun, /^(Re-running the failed jobs of \d+ GitHub Actions runs? on the pushed commit\.|No GitHub Actions run on the pushed commit has failed, so nothing was re-run\.)/)
  assert.equal(github().reruns.length - rerunsBefore, Number(/of (\d+) GitHub/.exec(rerun)?.[1] ?? 0), "the tool re-runs what the sidebar's Re-run does")
  assert.match(describe("pull_request_rerun").description!, /^Call when the user asks to re-run this branch's failed checks: Re-run in the Git sidebar\./, "below full access, a re-run is the person's ask")
  for (const tool of listed) {
    assert.ok(z.object({ properties: z.object({ repository: z.object({ type: z.literal("string") }) }) }).safeParse(tool.inputSchema).success, `${tool.name} takes a repository`)
    assert.match(tool.description ?? "", /one pull request per repository/, `${tool.name} says how it picks a project's repository`)
  }
  assert.match(describe("pull_request_merge").description!, /the one the others depend on first, and use method merge for a repository whose commits another one pins/)
  assert.match(describe("pull_request_merge").description!, /^Call only when the user asks to merge .*only full access lets a Thread merge on its own\./, "below full access, merging is the person's call")
  assert.match(describe("pull_request_open").description!, /^Call when the user asks to open a pull request/)

  // On full access the person's mode is the grant: the Thread opens and merges as the next step of its work.
  const fullGrant = grants.mint("binding-full", "full")
  const fullAgent = new Client({ name: "git-actions-full-agent", version: "1" })
  await fullAgent.connect(new StreamableHTTPClientTransport(new URL(fullGrant.makoUrl!), { requestInit: { headers: { Authorization: `Bearer ${fullGrant.token}` } } }))
  const onFull = new Map((await fullAgent.listTools()).tools.map((tool) => [tool.name, tool.description ?? ""]))
  await fullAgent.close()
  assert.match(onFull.get("pull_request_merge")!, /^Call when the user asks to merge .* or when merging it is the next step of the work you were given: this Thread is on full access, so it merges without asking first\./)
  assert.match(onFull.get("pull_request_open")!, /^Call when this branch's work is ready for review, .*this Thread is on full access, so it opens one without asking first\./)
  assert.equal(onFull.get("pull_request_status"), describe("pull_request_status").description, "reading is the same on every access")
  assert.match(onFull.get("pull_request_rerun")!, /^Call when a check failed for a reason outside the branch's change/, "on full access it re-runs a flaky check on its own")

  // A project folder of two repositories on one branch: a pull request each, the repository named by its folder.
  const multi = join(root, "multi")
  const members = ["api", "web"].map((name) => {
    const memberOrigin = join(root, `${name}.git`)
    git(root, "init", "-q", "--bare", "-b", "main", memberOrigin)
    const memberSeed = join(root, `${name}-seed`)
    git(root, "clone", "-q", memberOrigin, memberSeed)
    git(memberSeed, "checkout", "-q", "-b", "main")
    commit(memberSeed, "one.txt", "one", "one")
    git(memberSeed, "push", "-q", "origin", "main")
    const member = join(multi, name)
    git(root, "clone", "-q", memberOrigin, member)
    git(member, "checkout", "-q", "-b", "mako/multi", "origin/main")
    return { repository: { name, root: member, startedFrom: "origin/main" }, origin: memberOrigin }
  })
  const api = { ...members[0]!.repository, origin: members[0]!.origin }
  const web = { ...members[1]!.repository, origin: members[1]!.origin }
  let here: ReachableRepository | undefined
  const place = async (): Promise<RepositoryPlace> => ({ folder: multi, repositories: members.map(({ repository }) => repository), here })
  const project2 = pullRequestTools({ git: gitRunner, place, changed: () => {} })
  const pullOf = (name: string) => github().pulls.filter((pull) => pull.repo === name)

  commit(api.root, "api.txt", "api", "Add the endpoint")
  const both = parseYaml(await project2.status("c"))
  assert.equal(both.projectFolder, multi)
  assert.deepEqual(both.repositories.map((entry: { repository: string }) => entry.repository), ["api", "web"], "from the project folder, status reports every repository under its name")
  assert.equal(both.repositories[0].opening.commits.length, 1)
  assert.equal(both.repositories[1].opening.blocked, "mako/multi has no commits that main doesn't. Commit the work first.")
  assert.equal(await project2.open("c", { title: "Add the endpoint", body: "## Why\nweb needs it." }), "api: Opened #102 into main: https://github.com/o/r/pull/102.", "the only repository with work is the one opened, and the reply names it")
  assert.deepEqual([pullOf("api").length, pullOf("web").length], [1, 0])
  // From the project folder, a title or body for the one open pull request applies with nothing to push.
  assert.equal(await project2.open("c", { title: "Add the endpoint, validated", body: "## Why\nweb needs it, checked." }), "api: #102 was already open; nothing new to push and updated its title and body: https://github.com/o/r/pull/102.")
  assert.deepEqual([pullOf("api")[0]!.title, pullOf("api")[0]!.body], ["Add the endpoint, validated", "## Why\nweb needs it, checked."])
  await assert.rejects(project2.open("c", {}), /^Error: None of this project's repositories has work to open a pull request for:\n- api: #102 is open; /, "with nothing to push and nothing to change, there's still nothing to do")

  commit(web.root, "web.txt", "web", "Call the endpoint")
  await assert.rejects(project2.open("c", {}), /^Error: A new pull request needs a title\.$/, "web is now the only one with work: api's pull request has nothing new to push")
  assert.equal(await project2.open("c", { title: "Call the endpoint", body: "Needs #102." }), "web: Opened #103 into main: https://github.com/o/r/pull/103.")

  commit(api.root, "api2.txt", "two", "Validate input")
  commit(web.root, "web2.txt", "two", "Show errors")
  const apiPushed = git(api.origin, "rev-parse", "mako/multi")
  await assert.rejects(project2.open("c", {}), (error: Error) => {
    assert.equal(error.message, "Several of this project's repositories have work to open, and each takes its own pull request. Nothing was pushed. Call pull_request_open once for each, passing repository and a title and body for that repository's own change:\n- api: #102 is open, 1 commit to push; GitHub would merge it now\n- web: #103 is open, 1 commit to push; GitHub would merge it now")
    return true
  })
  assert.equal(git(api.origin, "rev-parse", "mako/multi"), apiPushed, "an ambiguous call pushes nothing")
  assert.equal(await project2.open("c", { repository: "web" }), "web: #103 was already open; pushed 1 commit: https://github.com/o/r/pull/103.")
  assert.equal(await project2.open("c", { repository: `${multi}/api/` }), "api: #102 was already open; pushed 1 commit: https://github.com/o/r/pull/102.", "a repository is named by its folder, absolute or from the project")
  await assert.rejects(project2.status("c", { repository: "nope" }), /^Error: .*multi has no repository named "nope"\. Pass one of: api, web\.$/)
  assert.equal(parseYaml(await project2.status("c", { repository: " ./web/ " })).repository, "web", "a name from the project folder may start with ./ and end with /")
  // Linear, judged against a pass that plainly is over the same name, timed here: counting its slashes. Whatever the
  // runner's speed does to one it does to the other, so refusing costs a few times the count, where a cost that grows
  // with the name's square costs thousands. Each the quickest of five, past a first.
  const hostile = "/".repeat(200_000) + "x"
  const quickest = async (work: () => Promise<void> | void) => {
    let best = Infinity
    for (let run = 0; run < 5; run++) {
      const began = performance.now()
      await work()
      best = Math.min(best, performance.now() - began)
    }
    return best
  }
  await assert.rejects(project2.status("c", { repository: hostile }), /has no repository named/)
  const refusing = await quickest(() => assert.rejects(project2.status("c", { repository: hostile }), /has no repository named/))
  let counted = 0
  const counting = await quickest(() => {
    let slashes = 0
    for (const character of hostile) if (character === "/") slashes++
    counted = slashes
  })
  assert.equal(counted, 200_000)
  assert.ok(refusing < counting * 50, `a hostile name is refused in linear time: ${refusing.toFixed(2)} ms for 200,000 slashes, against ${counting.toFixed(2)} ms to count them`)

  const onlyApi = parseYaml(await project2.status("c", { repository: "api" }))
  assert.deepEqual([onlyApi.repository, onlyApi.pullRequest.number, onlyApi.otherRepositories], ["api", 102, ["web"]], "one repository's report names it and its siblings")
  here = { name: "web", root: web.root, startedFrom: "origin/main" }
  assert.equal(parseYaml(await project2.status("c")).repository, "web", "from inside a repository, the tools act on it")
  here = undefined

  const mergedBefore = github().merged.length
  await assert.rejects(project2.merge("c"), /^Error: Several of this project's repositories have an open pull request; nothing was merged\. Pass repository to merge one at a time, the one the others depend on first:\n- api: #102 is open/)
  assert.equal(github().merged.length, mergedBefore, "nothing merged without a repository named")
  assert.equal(await project2.merge("c", { repository: "api", method: "merge" }), "api: Merged #102 into main (merge). The branch is kept.")
  assert.equal(await project2.merge("c"), "web: Merged #103 into main (merge). The branch is kept.", "with one left open, it's the one merged")
  await assert.rejects(project2.merge("c"), /^Error: None of this project's repositories has an open pull request:\n- api: .*\n- web: /)

  console.log("Git actions: shared base, writing rules and commands; open pushes first and never forces, updates the open one, refuses the default branch and empty branches; status with checks, comments and failed logs; re-run names each run; merge by the shared guard and allowed methods; the tools over HTTP MCP; a project folder's repositories each with its own pull request, named or found, and refused with where each stands when it's ambiguous")
} finally {
  await agent.close().catch(() => {})
  grants?.close()
  rmSync(root, { recursive: true, force: true })
}
