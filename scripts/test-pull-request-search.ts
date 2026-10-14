import assert from "node:assert/strict"
import { githubPullSource, type PullRequestSource } from "@mako/host/git/github"
import { PullRequestSearch } from "@mako/host/git/pull-request-search"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import {
  normalizePullQuery,
  pullQueryNumber,
  pullRequestScore,
  pullSearchLimit,
  pullSearchText,
  rankPullRequests,
  type PullRequestListing,
} from "@mako/host/contracts/pull-request-search"

/*
 * Finding any pull request by number or words: the GitHub search a query
 * becomes, the `gh` calls the source makes, the ranking, and the 30-second
 * cache with its shared in-flight answers, against a stub transport and a
 * clock the test moves.
 */

const pull = (number: number, title: string, head: string, author: string, updatedAt: string, state: PullRequestListing["state"] = "open"): PullRequestListing => ({
  number, title, state, draft: false, url: `https://github.com/o/r/pull/${number}`, head, base: "main", author, updatedAt,
})

// The query a search runs.
assert.equal(normalizePullQuery(`  fix  "login"\n bug `), "fix login bug")
assert.equal(normalizePullQuery(undefined), "")
assert.equal(pullQueryNumber("12"), 12)
assert.equal(pullQueryNumber(" #12 "), 12)
assert.equal(pullQueryNumber("0"), null)
assert.equal(pullQueryNumber("12a"), null)
assert.equal(pullSearchLimit(undefined), 30)
assert.equal(pullSearchLimit(0), 1)
assert.equal(pullSearchLimit(500), 100)
assert.equal(pullSearchText(""), "sort:updated-desc")
assert.equal(pullSearchText("host"), `(head:host OR author:host OR ("host" in:title)) sort:updated-desc`)
assert.equal(pullSearchText("mako/host-loop"), `(head:mako/host-loop OR author:mako/host-loop OR ("mako/host-loop" in:title)) sort:updated-desc`)
assert.equal(pullSearchText(`fix "login" bug`), `"fix login bug" in:title sort:updated-desc`)
assert.equal(pullSearchText(`head:main OR x`), `"head:main OR x" in:title sort:updated-desc`, "qualifiers typed into words stay words")

// Ranking: exact number, title start, title contains, number contains, head, author, then the newest.
const rows = [
  pull(7, "Retry webhooks", "fix/login-retry", "ada", "2026-10-01T00:00:00Z"),
  pull(8, "Login form polish", "polish", "grace", "2026-10-02T00:00:00Z"),
  pull(9, "Fix the login redirect", "redirect", "linus", "2026-10-03T00:00:00Z"),
  pull(10, "Docs", "docs", "login-bot", "2026-10-04T00:00:00Z"),
  pull(11, "Unrelated", "misc", "ada", "2026-10-05T00:00:00Z"),
]
assert.equal(pullRequestScore(rows[1]!, "LOGIN"), 90)
assert.equal(pullRequestScore(rows[2]!, "login"), 80)
assert.equal(pullRequestScore(rows[0]!, "login"), 60)
assert.equal(pullRequestScore(rows[3]!, "login"), 50)
assert.equal(pullRequestScore(rows[4]!, "login"), 0)
assert.equal(pullRequestScore(rows[4]!, ""), 1)
assert.deepEqual(rankPullRequests(rows, "login").map((row) => row.number), [8, 9, 7, 10, 11], "an unmatched row GitHub returned stays, last")
assert.deepEqual(rankPullRequests(rows, "").map((row) => row.number), [11, 10, 9, 8, 7], "no query is newest first")
const numbered = [pull(12, "Twelve", "a", "x", "2026-10-01T00:00:00Z"), pull(112, "One twelve", "b", "x", "2026-10-09T00:00:00Z"), pull(120, "Release 12 notes", "c", "x", "2026-10-05T00:00:00Z")]
assert.equal(pullRequestScore(numbered[0]!, "#12"), 100)
assert.equal(pullRequestScore(numbered[1]!, "12"), 70)
assert.equal(pullRequestScore(numbered[2]!, "12"), 80, "a title holding the digits outranks a number that does")
assert.deepEqual(rankPullRequests(numbered, "12").map((row) => row.number), [12, 120, 112])

// The source: the `gh` calls it makes and what it reads back.
{
  const calls: { cwd: string; args: string[] }[] = []
  const answers = new Map<string, string | Error>()
  const runner = async (cwd: string, args: string[]) => {
    calls.push({ cwd, args })
    const answer = answers.get(args.slice(0, 2).join(" "))
    if (answer instanceof Error) throw answer
    return answer ?? "null"
  }
  const source = githubPullSource(runner)
  answers.set("repo view", JSON.stringify({ nameWithOwner: "o/r" }))
  assert.equal(await source.repository("/work"), "o/r")
  assert.deepEqual(calls.at(-1), { cwd: "/work", args: ["repo", "view", "--json", "nameWithOwner"] })

  answers.set("pr list", JSON.stringify([
    { number: 4, title: "Merged one", state: "MERGED", isDraft: false, url: "u4", headRefName: "h4", baseRefName: "main", author: { login: "ada" }, updatedAt: "2026-10-04T00:00:00Z" },
    { number: 3, title: "Closed one", state: "CLOSED", isDraft: false, url: "u3", headRefName: "h3", baseRefName: "main", createdAt: "2026-10-03T00:00:00Z" },
    { number: 2, title: "Draft", state: "OPEN", isDraft: true, url: "u2", headRefName: "h2", baseRefName: "dev", author: { login: "grace" }, updatedAt: "2026-10-02T00:00:00Z" },
    { title: "no number" },
  ]))
  const listed = await source.search("/work", "o/r", "sort:updated-desc", 100)
  assert.deepEqual(calls.at(-1)!.args, ["pr", "list", "--repo", "o/r", "--state", "all", "--limit", "100", "--search", "sort:updated-desc", "--json", "number,title,state,isDraft,url,headRefName,baseRefName,author,createdAt,updatedAt"])
  assert.deepEqual(listed, [
    { number: 4, title: "Merged one", state: "merged", draft: false, url: "u4", head: "h4", base: "main", author: "ada", updatedAt: "2026-10-04T00:00:00Z" },
    { number: 3, title: "Closed one", state: "closed", draft: false, url: "u3", head: "h3", base: "main", author: undefined, updatedAt: "2026-10-03T00:00:00Z" },
    { number: 2, title: "Draft", state: "open", draft: true, url: "u2", head: "h2", base: "dev", author: "grace", updatedAt: "2026-10-02T00:00:00Z" },
  ])

  answers.set("pr view", JSON.stringify({ number: 99, title: "Old", state: "MERGED", isDraft: false, url: "u99", headRefName: "h99", baseRefName: "main" }))
  assert.equal((await source.view("/work", "o/r", 99))?.state, "merged")
  assert.deepEqual(calls.at(-1)!.args.slice(0, 5), ["pr", "view", "99", "--repo", "o/r"])
  answers.set("pr view", Object.assign(new Error("Command failed"), { stderr: "GraphQL: Could not resolve to a PullRequest with the number of 999.\n" }))
  assert.equal(await source.view("/work", "o/r", 999), null, "a number GitHub doesn't have is no row")

  answers.set("pr list", Object.assign(new Error("Command failed: gh pr list"), { stderr: "error connecting to api.github.com\n" }))
  await assert.rejects(source.search("/work", "o/r", "x", 5), /^Error: error connecting to api\.github\.com$/, "a failure is gh's own words")
}

// The search: what it asks, how it ranks, and what it keeps.
{
  let now = 1_000_000
  const asked: string[] = []
  const lists = new Map<string, PullRequestListing[]>()
  const views = new Map<number, PullRequestListing>()
  let failNext: Error | null = null
  let gate: Promise<void> | null = null
  let repository: string | null = "o/r"
  const source: PullRequestSource = {
    async repository(cwd) {
      asked.push(`repository ${cwd}`)
      return repository
    },
    async search(_cwd, repo, search, limit) {
      asked.push(`search ${repo} ${limit} ${search}`)
      if (gate) await gate
      if (failNext) {
        const failure = failNext
        failNext = null
        throw failure
      }
      return lists.get(search) ?? []
    },
    async view(_cwd, repo, number) {
      asked.push(`view ${repo} ${number}`)
      return views.get(number) ?? null
    },
  }
  const search = new PullRequestSearch({ source, now: () => now })
  const recent = Array.from({ length: 40 }, (_, index) => pull(140 - index, "Routine change", "routine", "ada", new Date(Date.UTC(2026, 9, 1) - index * 60_000).toISOString(), index % 3 === 0 ? "merged" : "open"))
  lists.set("sort:updated-desc", recent)

  // An empty query is the recently updated, newest first, in every state.
  const opened = await search.search("/work", {})
  assert.equal(opened.status, "ready")
  assert.ok(opened.status === "ready")
  assert.equal(opened.repository, "o/r")
  assert.equal(opened.pulls.length, 30, "the default limit")
  assert.equal(opened.pulls[0]!.number, 140)
  assert.ok(opened.pulls.some((row) => row.state === "merged"))
  assert.deepEqual(asked, ["repository /work", "search o/r 100 sort:updated-desc"])

  // Within 30 seconds the same answer is kept; the repository too.
  asked.length = 0
  now += 29_000
  await search.search("/work", { limit: 5 })
  assert.equal(asked.length, 0, "the recent list and the repository are kept")

  // A number: exact first, then numbers holding its digits, from the recent list.
  const thirteen = await search.search("/work", { query: "#13" })
  assert.ok(thirteen.status === "ready")
  assert.deepEqual(thirteen.pulls.map((row) => row.number), [139, 138, 137, 136, 135, 134, 133, 132, 131, 130, 113], "numbers holding the digits, newest first")
  assert.deepEqual(asked, ["view o/r 13"], "13 isn't among the recent, so it is looked up")
  asked.length = 0
  const exact = await search.search("/work", { query: "113" })
  assert.ok(exact.status === "ready")
  assert.deepEqual(exact.pulls.map((row) => row.number), [113])
  assert.equal(asked.length, 0, "an exact number among the recent asks nothing more")

  views.set(7, pull(7, "Ancient", "old", "linus", "2020-01-01T00:00:00Z", "closed"))
  const old = await search.search("/work", { query: "7" })
  assert.ok(old.status === "ready")
  assert.deepEqual(old.pulls.map((row) => row.number), [7, 137, 127, 117, 107], "a number older than the recent list is looked up and leads")
  assert.equal(old.pulls[0]!.state, "closed")

  // Words go to GitHub's search, and come back ranked.
  asked.length = 0
  lists.set(pullSearchText("login"), [
    pull(50, "Fix the login redirect", "redirect", "linus", "2026-10-09T00:00:00Z"),
    pull(51, "Docs", "docs", "login-bot", "2026-10-10T00:00:00Z"),
    pull(52, "Login form polish", "polish", "grace", "2026-10-01T00:00:00Z"),
    pull(53, "Webhooks", "fix/login-retry", "ada", "2026-10-08T00:00:00Z"),
  ])
  const words = await search.search("/work", { query: "login", limit: 10 })
  assert.ok(words.status === "ready")
  assert.deepEqual(words.pulls.map((row) => row.number), [52, 50, 53, 51])
  assert.deepEqual(asked, [`search o/r 10 ${pullSearchText("login")}`])

  // Two searches at once share one call.
  asked.length = 0
  let open!: () => void
  gate = new Promise<void>((resolve) => { open = resolve })
  const both = Promise.all([search.search("/work", { query: "webhook" }), search.search("/work", { query: "webhook" })])
  await new Promise((resolve) => setImmediate(resolve))
  open()
  gate = null
  await both
  assert.equal(asked.filter((line) => line.startsWith("search")).length, 1, "in flight is shared")

  // Past 30 seconds, GitHub is asked again.
  asked.length = 0
  now += 31_000
  await search.search("/work", { query: "webhook" })
  assert.deepEqual(asked, [`search o/r 30 ${pullSearchText("webhook")}`])

  // A failure is said and never kept.
  asked.length = 0
  failNext = new Error("error connecting to api.github.com")
  const failed = await search.search("/work", { query: "flaky" })
  assert.deepEqual(failed, { status: "unavailable", reason: "failed", message: "error connecting to api.github.com" })
  const retried = await search.search("/work", { query: "flaky" })
  assert.equal(retried.status, "ready")
  assert.equal(asked.filter((line) => line.startsWith("search")).length, 2, "the failure wasn't kept")

  // Another checkout of the same repository shares the answers.
  asked.length = 0
  await search.search("/work-tree", { query: "flaky" })
  assert.deepEqual(asked, ["repository /work-tree"], "answers are kept by repository, not folder")

  // A folder with no GitHub repository says so.
  repository = null
  const none = await search.search("/elsewhere", { query: "x" })
  assert.deepEqual(none, { status: "unavailable", reason: "no-repository" })
}

// The wire: the call is a read, and its argument is checked.
assert.equal(hostCallReplay("mako:pull-request-search"), "read")
assert.deepEqual(hostCallSchema("mako:pull-request-search").parse([{ query: "12", limit: 5 }]), [{ query: "12", limit: 5 }])
assert.throws(() => hostCallSchema("mako:pull-request-search").parse([{ query: 12 }]))

console.log("pull request search: ok")
