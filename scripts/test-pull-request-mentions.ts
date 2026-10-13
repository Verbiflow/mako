import assert from "node:assert/strict"
import { mock } from "node:test"
import type { GitHubStatus, PullRequest } from "../src/lib/types.js"
import type { PullRequestListing, PullRequestSearchRequest, PullRequestSearchResult } from "@mako/host/contracts/pull-request-search"

/*
 * The window's half of `#` pull request mentions: the chip's detail, the
 * ranking of rows, why there are none, and the search's debounce, loading
 * and unavailable states against a stub bridge.
 */

const statuses = new Map<string, GitHubStatus>()
let currentRoot = ""
const searches: PullRequestSearchRequest[] = []
let answer: (request: PullRequestSearchRequest) => Promise<PullRequestSearchResult> = async () => ({ status: "ready", repository: "o/r", pulls: [] })
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    mako: {
      githubStatus: async () => statuses.get(currentRoot) ?? { installed: true, authenticated: true, login: "you", repo: "o/r" },
      userAvatar: async () => undefined,
      pullRequestSearch: async (request: PullRequestSearchRequest) => {
        searches.push(request)
        return answer(request)
      },
    },
  },
})

const { PullRequestDetailSchema } = await import("../src/lib/context-detail.js")
const { pullRequestDetail, pullMentionReason, pullSearchFailure, rankPullRequests, matchPullRequests } = await import("../src/lib/pull-request-mentions.js")
const { watchPullRequestSearch, PULL_SEARCH_DEBOUNCE_MS } = await import("../src/state/pull-request-search.js")
type View = import("../src/state/pull-request-search.js").PullRequestSearchView

const listing = (number: number, title: string, head: string, author: string | undefined, updatedAt: string): PullRequestListing => ({
  number, title, state: "open", draft: false, url: `https://github.com/o/r/pull/${number}`, head, base: "main", author, updatedAt,
})

// The chip's detail, from a search row or the branch's whole pull request.
const branchPull: PullRequest = {
  number: 42, title: "Retry webhooks", body: "long body", state: "merged", draft: false, url: "https://github.com/o/r/pull/42",
  head: "fix/retry", base: "main", additions: 3, deletions: 1, files: 1, mergeable: "clean", reviewDecision: "approved",
  author: "ada", updatedAt: "2026-10-01T00:00:00Z", checks: [{ name: "test", state: "passed" }], reviews: [],
}
const detail = pullRequestDetail(branchPull, "o/r")
assert.deepEqual(detail, { kind: "pull-request", number: 42, title: "Retry webhooks", url: "https://github.com/o/r/pull/42", state: "merged", draft: false, head: "fix/retry", base: "main", author: "ada", repository: "o/r" })
assert.deepEqual(PullRequestDetailSchema.parse(detail), detail)
const bare = pullRequestDetail(listing(7, "Draft", "wip", undefined, "2026-10-01T00:00:00Z"))
assert.equal("author" in bare, false, "an unknown author is left out, not empty")
assert.equal("repository" in bare, false)
assert.deepEqual(PullRequestDetailSchema.parse(bare), bare)

// Ranking rows: exact number 100, title start 90, title contains 80, head 60, author 50, then the newest.
const rows = [
  listing(5, "Docs", "docs", "login-bot", "2026-10-09T00:00:00Z"),
  listing(4, "Webhooks", "fix/login", "ada", "2026-10-08T00:00:00Z"),
  listing(3, "Fix the login redirect", "redirect", "linus", "2026-10-07T00:00:00Z"),
  listing(2, "Login form", "form", "grace", "2026-10-01T00:00:00Z"),
  listing(1, "Unrelated", "misc", "ada", "2026-10-10T00:00:00Z"),
]
assert.deepEqual(rankPullRequests(rows, "login").map((row) => row.number), [2, 3, 4, 5, 1])
assert.deepEqual(matchPullRequests(rows, "login").map((row) => row.number), [2, 3, 4, 5], "match drops what doesn't match here")
assert.deepEqual(rankPullRequests(rows, "#3").map((row) => row.number)[0], 3)
assert.deepEqual(rankPullRequests(rows, "").map((row) => row.number), [1, 5, 4, 3, 2])

// Why there are no rows, in the panel's three sentences.
assert.equal(pullMentionReason({ installed: false, authenticated: false }), "Install the gh CLI to mention pull requests")
assert.equal(pullMentionReason({ installed: true, authenticated: false }), "Sign in to GitHub to mention pull requests")
assert.equal(pullMentionReason({ installed: true, authenticated: true, login: "you" }), "Add a GitHub remote to mention pull requests")
assert.equal(pullMentionReason({ installed: true, authenticated: true, login: "you", repo: "o/r" }), null)
assert.equal(pullSearchFailure({ status: "unavailable", reason: "no-repository" }), "Add a GitHub remote to mention pull requests")
assert.equal(pullSearchFailure({ status: "unavailable", reason: "failed", message: "\nerror connecting to api.github.com\ncheck your internet connection" }), "GitHub didn't answer: error connecting to api.github.com")

// The search.
mock.timers.enable({ apis: ["setTimeout"] })
const flush = async () => {
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
}
const watch = (root: string | undefined, query: string | null, previous?: View) => {
  currentRoot = root ?? ""
  const views: View[] = []
  const stop = watchPullRequestSearch({ root, query, previous }, (view) => views.push(view))
  return { views, stop }
}
try {
  assert.deepEqual(watch("/r", null).views, [{ status: "idle", pulls: [] }], "no menu asks nothing")

  // Words wait for a pause.
  answer = async (request) => ({ status: "ready", repository: "o/r", pulls: rankPullRequests(rows, request.query) })
  const typed = watch("/r", "login")
  assert.deepEqual(typed.views.map((view) => view.status), ["loading"])
  await flush()
  assert.equal(searches.length, 0, "nothing is asked before the pause")
  mock.timers.tick(PULL_SEARCH_DEBOUNCE_MS - 1)
  await flush()
  assert.equal(searches.length, 0)
  mock.timers.tick(1)
  await flush()
  assert.deepEqual(searches, [{ query: "login" }])
  const ready = typed.views.at(-1)!
  assert.equal(ready.status, "ready")
  assert.equal(ready.repository, "o/r")
  assert.deepEqual(ready.pulls.map((row) => row.number), [2, 3, 4, 5, 1])

  // A keystroke before the pause asks nothing.
  searches.length = 0
  const abandoned = watch("/r", "logi")
  abandoned.stop()
  mock.timers.tick(PULL_SEARCH_DEBOUNCE_MS)
  await flush()
  assert.equal(searches.length, 0)
  assert.deepEqual(abandoned.views.map((view) => view.status), ["loading"])

  // A number, or the menu just opening, asks at once.
  for (const query of ["#3", "12", ""]) {
    searches.length = 0
    watch("/r", query)
    await flush()
    assert.deepEqual(searches, [{ query }], `${JSON.stringify(query)} is asked without waiting`)
  }

  // While the next answer comes, the rows held are narrowed to the new query.
  const narrowing = watch("/r", "redirect", ready)
  assert.equal(narrowing.views[0]!.status, "loading")
  assert.deepEqual(narrowing.views[0]!.pulls.map((row) => row.number), [3])
  assert.equal(narrowing.views[0]!.repository, "o/r")
  narrowing.stop()

  // An answer after the stop is dropped.
  let release!: () => void
  answer = () => new Promise((resolve) => { release = () => resolve({ status: "ready", repository: "o/r", pulls: rows }) })
  const late = watch("/r", "5")
  await flush()
  late.stop()
  release()
  await flush()
  assert.deepEqual(late.views.map((view) => view.status), ["loading"])

  // Unavailable, said plainly, and GitHub isn't asked.
  searches.length = 0
  statuses.set("/signed-out", { installed: true, authenticated: false })
  const signedOut = watch("/signed-out", "")
  await flush()
  assert.deepEqual(signedOut.views.at(-1), { status: "unavailable", pulls: [], reason: "Sign in to GitHub to mention pull requests" })
  statuses.set("/no-cli", { installed: false, authenticated: false })
  const noCli = watch("/no-cli", "")
  await flush()
  assert.deepEqual(noCli.views.at(-1), { status: "unavailable", pulls: [], reason: "Install the gh CLI to mention pull requests" })
  statuses.set("/local", { installed: true, authenticated: true, login: "you" })
  const local = watch("/local", "")
  await flush()
  assert.deepEqual(local.views.at(-1), { status: "unavailable", pulls: [], reason: "Add a GitHub remote to mention pull requests" })
  const outside = watch(undefined, "")
  await flush()
  assert.deepEqual(outside.views.at(-1), { status: "unavailable", pulls: [], reason: "Add a GitHub remote to mention pull requests" })
  assert.equal(searches.length, 0)

  // The host's own refusals.
  answer = async () => ({ status: "unavailable", reason: "failed", message: "HTTP 502: Bad Gateway" })
  const failed = watch("/r", "")
  await flush()
  assert.deepEqual(failed.views.at(-1), { status: "unavailable", pulls: [], reason: "GitHub didn't answer: HTTP 502: Bad Gateway" })
  answer = async () => { throw new Error("The Mako host restarted") }
  const thrown = watch("/r", "")
  await flush()
  assert.deepEqual(thrown.views.at(-1), { status: "unavailable", pulls: [], reason: "GitHub didn't answer: The Mako host restarted" })
} finally {
  mock.timers.reset()
}

console.log("pull request mentions: ok")
