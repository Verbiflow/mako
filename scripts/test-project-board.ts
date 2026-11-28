import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitHubReads, GitHubRateLimitError } from "@mako/host/git/github-reads"
import { ProjectBoard, localRepositories, checkRollup, reviewVerdict, boardProblem, type LocalRepository } from "@mako/host/git/project-board"
import {
  boardReading,
  issueSections,
  multiRepositoryKeys,
  problemWords,
  pullSection,
  pullSections,
  repositorySections,
  rowCode,
  type BoardPull,
} from "@mako/host/contracts/project-pulls"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const NOW = Date.parse("2026-11-28T12:00:00Z")

// --- Sections -------------------------------------------------------------------------------------------------

const base: BoardPull = {
  key: "acme/api#1", repository: "acme/api", number: 1, title: "t", url: "https://github.com/acme/api/pull/1",
  draft: false, state: "open", head: "h", base: "main", createdAt: NOW - DAY, updatedAt: NOW - DAY,
  checks: { passed: 3, failed: 0, running: 0, total: 3 }, reviewRequested: false, mine: false,
}
const pull = (patch: Partial<BoardPull>): BoardPull => ({ ...base, ...patch, key: `${(patch.repository ?? base.repository).toLowerCase()}#${patch.number ?? base.number}` })

assert.equal(pullSection(pull({ reviewRequested: true })), "needs-you", "a review asked of the person needs them")
assert.equal(pullSection(pull({ mine: true, checks: { passed: 1, failed: 1, running: 0, total: 2 } })), "needs-you", "their own failing pull request needs them")
assert.equal(pullSection(pull({ mine: true, review: "changes" })), "needs-you", "changes requested on theirs needs them")
assert.equal(pullSection(pull({ checks: { passed: 1, failed: 1, running: 0, total: 2 } })), "others", "someone else's failing pull request waits on them")
assert.equal(pullSection(pull({})), "ready", "green and unreviewed is ready")
assert.equal(pullSection(pull({ review: "approved" })), "ready")
assert.equal(pullSection(pull({ checks: { passed: 0, failed: 0, running: 0, total: 0 } })), "ready", "no checks reported is ready")
assert.equal(pullSection(pull({ checks: { passed: 1, failed: 0, running: 2, total: 3 } })), "checks")
assert.equal(pullSection(pull({ checks: undefined })), "checks", "checks not read yet wait")
assert.equal(pullSection(pull({ draft: true, mine: true, review: undefined })), "draft")
assert.equal(pullSection(pull({ draft: true, reviewRequested: true })), "draft", "a draft asks nobody")
assert.equal(pullSection(pull({ state: "merged", closedAt: NOW })), "merged")
assert.equal(pullSection(pull({ state: "closed", closedAt: NOW })), "closed")

const listed = [
  pull({ number: 1, state: "merged", closedAt: NOW - 2 * DAY }),
  pull({ number: 2, state: "merged", closedAt: NOW - 9 * DAY }),
  pull({ number: 3, draft: true }),
  pull({ number: 4, checks: { passed: 0, failed: 0, running: 1, total: 1 } }),
  pull({ number: 5, updatedAt: NOW - 2 * DAY }),
  pull({ number: 6, updatedAt: NOW - MINUTE }),
  pull({ number: 7, reviewRequested: true }),
  pull({ number: 8, state: "closed", closedAt: NOW - DAY }),
]
const sections = pullSections(listed, NOW)
assert.deepEqual(sections.map((section) => section.key), ["needs-you", "ready", "checks", "draft", "merged", "closed"], "fixed order, empty sections left out")
assert.deepEqual(sections.find((section) => section.key === "ready")!.rows.map((row) => row.number), [6, 5], "most recently updated first")
assert.deepEqual(sections.find((section) => section.key === "merged")!.rows.map((row) => row.number), [1], "merged more than a week ago drops")
assert.deepEqual(sections.filter((section) => section.folded).map((section) => section.key), ["merged", "closed"], "history folds")
assert.deepEqual(boardReading(listed), { text: "1 needs you", attention: true })
assert.deepEqual(boardReading(listed.filter((row) => !row.reviewRequested)), { text: "4 open", attention: false })
assert.equal(boardReading([]), undefined)

const issues = issueSections([
  { key: "a/b#1", repository: "a/b", number: 1, title: "x", url: "", state: "open", createdAt: 0, updatedAt: NOW, assigned: true, labels: [], comments: 0 },
  { key: "a/b#2", repository: "a/b", number: 2, title: "y", url: "", state: "open", createdAt: 0, updatedAt: NOW, assigned: false, labels: [], comments: 0 },
  { key: "a/b#3", repository: "a/b", number: 3, title: "z", url: "", state: "closed", createdAt: 0, updatedAt: NOW, closedAt: NOW, assigned: false, labels: [], comments: 0 },
], NOW)
assert.deepEqual(issues.map((section) => [section.key, section.rows.length]), [["needs-you", 1], ["open", 1], ["closed", 1]])

// --- Multi-repository labels ----------------------------------------------------------------------------------

const projects = [
  { folder: "/p/makomono", repositories: ["acme/mako", "acme/mako-backend"] },
  { folder: "/p/site", repositories: ["acme/site"] },
]
const multi = multiRepositoryKeys(projects)
assert.equal(rowCode({ repository: "acme/mako-backend", number: 412 }, multi), "mako-backend#412", "a project of two repositories names the repository")
assert.equal(rowCode({ repository: "Acme/Mako", number: 7 }, multi), "Mako#7", "keys ignore case; the name is as GitHub spells it")
assert.equal(rowCode({ repository: "acme/site", number: 88 }, multi), "#88", "a single-repository project shows the number alone")
assert.equal(rowCode({ repository: "acme/site", number: 88 }, multiRepositoryKeys([projects[1]!])), "#88")
const byRepository = repositorySections([pull({ repository: "acme/web", number: 2 }), pull({ repository: "acme/api", number: 9, state: "merged", closedAt: NOW })], NOW)
assert.deepEqual(byRepository.map((section) => [section.label, section.folded]), [["acme/api", true], ["acme/web", false]], "group by repository, a repository with nothing open folded")

// --- Readings of GitHub's answers -----------------------------------------------------------------------------

assert.deepEqual(checkRollup([
  { status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }, { status: "completed", conclusion: "cancelled" },
  { status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "neutral" },
]), { passed: 2, failed: 1, running: 1, total: 4 })
assert.equal(reviewVerdict([{ state: "CHANGES_REQUESTED", user: { login: "a" } }, { state: "APPROVED", user: { login: "a" } }]), "approved", "a reviewer's latest review counts")
assert.equal(reviewVerdict([{ state: "APPROVED", user: { login: "a" } }, { state: "CHANGES_REQUESTED", user: { login: "b" } }]), "changes")
assert.equal(reviewVerdict([{ state: "COMMENTED", user: { login: "a" } }]), undefined)
assert.deepEqual(boardProblem({ stderr: "gh: Not Found (HTTP 404)" }, NOW), { kind: "no-access" })
assert.deepEqual(boardProblem({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }, NOW), { kind: "signed-out" })
assert.deepEqual(boardProblem(new GitHubRateLimitError(NOW + 5 * MINUTE), NOW), { kind: "limited", until: NOW + 5 * MINUTE })
assert.equal(boardProblem(new Error("socket hang up"), NOW).kind, "unreachable")
assert.equal(problemWords({ kind: "signed-out" }), "GitHub isn't signed in")

// --- Local repositories: worktrees of one repository are one ---------------------------------------------------

const scratch = await mkdtemp(join(tmpdir(), "mako-board-"))
try {
  const repo = async (path: string, url: string) => {
    await mkdir(join(path, ".git"), { recursive: true })
    await writeFile(join(path, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`)
  }
  await repo(join(scratch, "project", "mako"), "git@github.com:acme/mako.git")
  await repo(join(scratch, "project", "mako-backend"), "https://github.com/acme/mako-backend")
  // A linked worktree of mako inside the project folder: a `.git` file naming the repository's worktrees folder.
  await mkdir(join(scratch, "project", "mako", ".git", "worktrees", "spare"), { recursive: true })
  await writeFile(join(scratch, "project", "mako", ".git", "worktrees", "spare", "commondir"), "../..\n")
  await mkdir(join(scratch, "project", "spare"), { recursive: true })
  await writeFile(join(scratch, "project", "spare", ".git"), `gitdir: ${join(scratch, "project", "mako", ".git", "worktrees", "spare")}\n`)
  await repo(join(scratch, "project", "notes"), "/somewhere/else.git")
  const found = await localRepositories(join(scratch, "project"))
  assert.deepEqual(found.map((each) => each.name), ["acme/mako", "acme/mako-backend"], "a worktree collapses into its repository by remote; a non-GitHub origin is left out")
  assert.deepEqual((await localRepositories(join(scratch, "project", "spare"))).map((each) => each.name), ["acme/mako"], "a worktree folder is its repository")
} finally {
  await rm(scratch, { recursive: true, force: true })
}

// --- The board: one repository failing, the rest listed --------------------------------------------------------

interface PullPatch { state?: string; draft?: boolean; merged_at?: string; closed_at?: string; user?: { login: string }; requested_reviewers?: { login: string }[] }
const restPull = (number: number, patch: PullPatch = {}) => ({
  number, title: `Pull ${number}`, html_url: `https://github.com/x/${number}`, state: "open", draft: false,
  user: { login: "someone" }, created_at: "2026-11-27T10:00:00Z", updated_at: "2026-11-27T11:00:00Z", closed_at: null, merged_at: null,
  head: { ref: `b${number}`, sha: String(number).repeat(40).slice(0, 40) }, base: { ref: "main" }, requested_reviewers: [], ...patch,
})
const repositories = new Map<string, LocalRepository[]>([[
  "/p/makomono", [{ name: "acme/mako", url: "https://github.com/acme/mako", root: "/p/makomono/mako" }, { name: "acme/mako-backend", url: "https://github.com/acme/mako-backend", root: "/p/makomono/mako-backend" }],
]])
{
  const board = new ProjectBoard({
    now: () => NOW,
    viewer: async () => "me",
    repositories: async (folder) => repositories.get(folder) ?? [],
    api: async (_cwd, path) => {
      if (path.startsWith("repos/acme/mako-backend/")) throw Object.assign(new Error("gh failed"), { stderr: "gh: Not Found (HTTP 404)" })
      if (path.startsWith("repos/acme/mako/pulls?state=open")) return JSON.stringify([restPull(12, { user: { login: "Me" } }), restPull(13, { requested_reviewers: [{ login: "me" }] })])
      if (path.startsWith("repos/acme/mako/pulls?state=closed")) return JSON.stringify([restPull(10, { state: "closed", merged_at: "2026-11-27T09:00:00Z", closed_at: "2026-11-27T09:00:00Z" })])
      if (path.includes("/check-runs")) return JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: path.includes("12121212") ? "failure" : "success" }] })
      if (path.includes("/reviews")) return "[]"
      throw new Error(`unexpected ${path}`)
    },
  })
  const read = await board.read({ folders: ["/p/makomono"], kind: "pulls" })
  assert.equal(read.viewer, "me")
  assert.deepEqual(read.projects, [{ folder: "/p/makomono", repositories: ["acme/mako", "acme/mako-backend"] }])
  assert.deepEqual(read.repositories["acme/mako-backend"]!.problem, { kind: "no-access" }, "the failing repository says why, on its own")
  assert.equal(read.repositories["acme/mako"]!.problem, undefined)
  assert.deepEqual(read.pulls.map((row) => row.key).sort(), ["acme/mako#10", "acme/mako#12", "acme/mako#13"], "rows are keyed owner/name#n")
  const mine = read.pulls.find((row) => row.number === 12)!
  assert.equal(mine.mine, true, "the author is matched to the login without case")
  assert.equal(pullSection(mine), "needs-you", "theirs is failing")
  assert.equal(pullSection(read.pulls.find((row) => row.number === 13)!), "needs-you", "a review is asked of them")
  assert.equal(read.pulls.find((row) => row.number === 10)!.state, "merged")
  const codes = multiRepositoryKeys(read.projects)
  assert.equal(rowCode(mine, codes), "mako#12", "two repositories in the project, so the repository is named")
}
{
  const signedOut = new ProjectBoard({ now: () => NOW, viewer: async () => null, repositories: async (folder) => repositories.get(folder) ?? [], api: async () => { throw new Error("never asked") } })
  const read = await signedOut.read({ folders: ["/p/makomono"], kind: "pulls" })
  assert.deepEqual(read.problem, { kind: "signed-out" })
  assert.deepEqual(Object.values(read.repositories).map((each) => each.problem?.kind), ["signed-out", "signed-out"], "each repository says the one fix")
  const none = await signedOut.read({ folders: ["/p/notes"], kind: "pulls" })
  assert.deepEqual(none.projects, [{ folder: "/p/notes", repositories: [] }], "a project with no GitHub remote lists nothing and asks nothing")
}

// --- Polling budget: the panel open for half an hour -----------------------------------------------------------

{
  let now = NOW
  const sent: { path: string; status: number }[] = []
  let checksDoneAt = NOW + 9 * MINUTE
  const answers = new Map<string, { etag: string; body: string }>()
  const body = (path: string): string => {
    if (path.includes("pulls?state=open")) return JSON.stringify(path.includes("acme/mako/") ? [restPull(1), restPull(2), restPull(3, { draft: true })] : [restPull(4), restPull(5)])
    if (path.includes("pulls?state=closed")) return JSON.stringify([])
    if (path.includes("/check-runs")) {
      const running = path.includes("1111111111") && now < checksDoneAt
      return JSON.stringify({ total_count: 1, check_runs: [{ status: running ? "in_progress" : "completed", conclusion: running ? null : "success" }] })
    }
    if (path.includes("/reviews")) return "[]"
    throw new Error(`unexpected ${path}`)
  }
  const reader = new GitHubReads({
    now: () => now,
    common: async (cwd) => cwd,
    branch: async () => "main",
    run: async (_cwd, args) => {
      const path = args[1]!
      const match = args.find((arg) => arg.startsWith("If-None-Match: "))?.slice("If-None-Match: ".length)
      const text = body(path)
      const etag = `"${createHash("sha1").update(text).digest("hex")}"`
      answers.set(path, { etag, body: text })
      // As `gh api` answers a 304: exit 1, the response on standard output.
      if (match === etag) { sent.push({ path, status: 304 }); throw Object.assign(new Error("Command failed: gh api"), { code: 1, stdout: `HTTP/2.0 304 Not Modified\nETag: ${etag}\n\n`, stderr: "gh: HTTP 304" }) }
      sent.push({ path, status: 200 })
      return `HTTP/2.0 200 OK\nETag: ${etag}\n\n${text}`
    },
  })
  const board = new ProjectBoard({
    now: () => now,
    viewer: async () => "me",
    repositories: async (folder) => repositories.get(folder) ?? [],
    api: (cwd, path) => reader.run(cwd, ["api", path]),
  })
  // The panel reads when it opens and every two minutes while it shows; the page opened beside it reads the same.
  for (let minute = 0; minute <= 30; minute += 2) {
    now = NOW + minute * MINUTE
    const [panel, page] = await Promise.all([board.read({ folders: ["/p/makomono"], kind: "pulls" }), board.read({ folders: ["/p/makomono", "/p/notes"], kind: "pulls" })])
    assert.equal(panel.pulls.length, page.pulls.length, "the panel and the page read one cache")
    if (minute === 10) reader.forget()
  }
  if (process.env.DEBUG_BOARD) for (const each of sent) console.log(each.status, each.path)
  const fresh = sent.filter((each) => each.status === 200).length
  const read = await board.read({ folders: ["/p/makomono"], kind: "pulls" })
  assert.deepEqual(Object.values(read.repositories).map((each) => each.problem), [undefined, undefined], "an unchanged answer (gh exits 1 on a 304) is no failure")
  const lists = sent.filter((each) => each.path.includes("pulls?state=")).length
  const checks = sent.filter((each) => each.path.includes("/check-runs")).length
  const reviews = sent.filter((each) => each.path.includes("/reviews")).length
  console.log(`polling budget, 30 min, 2 repositories, 5 open: ${sent.length} requests (${fresh} full answers, ${sent.length - fresh} unchanged 304s): ${lists} lists, ${checks} check reads, ${reviews} review reads`)
  assert.ok(sent.length <= 60, `at most two requests a minute for two repositories (${sent.length})`)
  assert.ok(fresh <= 16, `few full answers: unchanged lists come back 304 (${fresh})`)
  assert.equal(reviews, 4, "reviews are read once per pull request that isn't a draft, while it doesn't move")
  assert.ok(checks <= 4 + 6, `a head's checks are read again only while they run (${checks})`)
  assert.ok(sent.filter((each) => each.path.includes("pulls?state=closed")).length <= 2 * 4, "recently closed is read every ten minutes")
  assert.ok(sent.some((each, index) => index > 0 && each.status === 304 && sent.slice(0, index).some((earlier) => earlier.path === each.path)), "a read after forget still sends its ETag")
  void checksDoneAt
  checksDoneAt = 0
}

console.log("project board ok")
