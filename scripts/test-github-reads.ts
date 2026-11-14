import assert from "node:assert/strict"
import { GitHubReads } from "@mako/host/git/github-reads"

let now = 0
const calls: string[][] = []
let active = 0, peak = 0
let version = 1
let fail: Error | undefined
const pull = () => ({ number: 7, headRefName: "fix", state: "OPEN", headRefOid: String(version).repeat(40), statusCheckRollup: [], latestReviews: [] })
const reader = new GitHubReads({
  now: () => now,
  common: async () => "/shared/git",
  branch: async () => "fix",
  run: async (_cwd, args) => {
    calls.push(args)
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    if (fail) throw fail
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/project", url: "https://github.com/fixture/project" })
    if (args[1] === "graphql") return "HTTP/2.0 200 OK\n\n" + JSON.stringify({ data: { repository: args.some(arg => arg.startsWith("number=")) ? { pullRequest: { ...pull(), latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] } } } : { pullRequests: { nodes: [pull()] } } } })
    if (args[0] === "pr") return JSON.stringify(args[1] === "list" ? [pull()] : pull())
    return "{}"
  },
})
const list = ["pr", "list", "--state", "all", "--limit", "60", "--json", "number,state"]
const view = ["pr", "view", "7", "--repo", "fixture/project", "--json", "statusCheckRollup"]
await Promise.all(Array.from({ length: 80 }, (_, i) => reader.run(`/checkout/${i}`, i % 2 ? view : list)))
assert.equal(calls.filter(args => args[1] === "graphql" && !args.some(arg => arg.startsWith("number="))).length, 1, "all consumers join the same repository snapshot")
assert.equal(peak, 1, "GitHub requests are serial across consumers and repositories")
const first = JSON.parse(await reader.run("/checkout/one", view))
assert.equal(first.headRefOid, "1".repeat(40))
now = 60_001; version = 2
assert.equal(JSON.parse(await reader.run("/checkout/two", view)).headRefOid, "2".repeat(40), "expiry reads a new head")
await reader.run("/checkout/two", ["pr", "edit", "7", "--title", "Fixture"])
const beforeRefresh = calls.length
await reader.run("/checkout/two", view)
assert.ok(calls.length > beforeRefresh, "writes invalidate readings")
// A search is distinct from the recent repository list; an old PR is looked up by number.
await reader.run("/checkout/two", ["pr", "view", "900", "--json", "state"])
assert.ok(calls.some(args => args.includes("number=900")))
const beforeAuth = calls.length
await reader.run("/checkout/two", view, { GH_TOKEN: "ephemeral-fixture-only" })
assert.ok(calls.length > beforeAuth, "App credentials cannot reuse a person's data")

// A queued request rechecks the shared deadline when it reaches transport, not when it was enqueued.
now += 60_001
fail = Object.assign(new Error("fixture"), { stderr: "HTTP 403: secondary rate limit", stdout: "HTTP/2.0 403 Forbidden\r\nRetry-After: 180\r\n\r\n{}" })
const beforeLimit = calls.length
await Promise.allSettled([reader.run("/one", ["api", "repos/fixture/one"]), reader.run("/two", ["api", "repos/fixture/two"])])
assert.equal(calls.length - beforeLimit, 1)
fail = undefined
now += 179_999
await assert.rejects(reader.run("/three", ["api", "repos/fixture/three"]), /rate limiting/)
assert.equal(calls.length - beforeLimit, 1, "no immediate retry or cross-repository escape")
now += 60_001
await reader.run("/four", ["api", "repos/fixture/four"])

// Conditional REST reads retain the exact body on 304 and do not expose headers as JSON.
let request = 0
const rest = new GitHubReads({ now: () => now, common: async cwd => cwd, branch: async () => "fix", run: async (_cwd, args) => {
  request++
  if (request === 1) { assert.ok(!args.includes("If-None-Match: fixture-etag")); return "HTTP/2.0 200 OK\nETag: fixture-etag\n\n{\"id\":7}" }
  assert.ok(args.includes("If-None-Match: fixture-etag"))
  return "HTTP/2.0 304 Not Modified\nETag: fixture-etag\n\n"
} })
assert.equal(await rest.run("/one", ["api", "user"]), '{"id":7}')
assert.equal(await rest.run("/other", ["api", "user"]), '{"id":7}')
assert.equal(request, 1, "identity reads are shared across repository folders")
now += 60_001
assert.equal(await rest.run("/one", ["api", "user"]), '{"id":7}')
assert.equal(request, 2)

// Filtering a full snapshot must not hide older open PRs, and explicit large lists keep their contract.
const fullCalls: string[][] = []
const full = new GitHubReads({ now: () => now, common: async () => "/repo", branch: async () => "fix", run: async (_cwd, args) => {
  fullCalls.push(args)
  const pulls = Array.from({ length: 60 }, (_, i) => ({ number: i, headRefName: `closed-${i}`, state: "CLOSED" }))
  return args[1] === "graphql" ? "HTTP/2.0 200 OK\n\n" + JSON.stringify({ data: { repository: { pullRequests: { nodes: pulls } } } }) : JSON.stringify(args[0] === "repo" ? { nameWithOwner: "fixture/project", url: "https://github.com/fixture/project" } : pulls)
} })
await full.run("/repo", ["pr", "list", "--limit", "20", "--json", "number"])
assert.ok(fullCalls.some(args => args.includes("20")), "a short filtered snapshot falls back to the full requested query")
await full.run("/repo", ["pr", "list", "--state", "all", "--limit", "100", "--json", "number"])
assert.ok(fullCalls.some(args => args.includes("100")))
console.log("GitHub reader: shared snapshots, serial admission, invalidation, credential isolation, backoff and ETags passed")

// A failed refresh never falls back to an old passing check, and a denied write is not retried.
now += 60_001
fail = Object.assign(new Error("fixture"), { stderr: "HTTP 502: fixture failure" })
await assert.rejects(reader.run("/checkout/two", view))
const failedAt = calls.length
await assert.rejects(reader.run("/checkout/two", view))
assert.equal(calls.length, failedAt, "negative results are deduplicated too")
await assert.rejects(reader.run("/checkout/two", ["pr", "merge", "7", "--merge"]))
assert.equal(calls.length, failedAt + 1, "a failed write runs exactly once")
fail = undefined

// Only a matching repository can supply a PR; repo aliases and current branch changes stay separate facts.
let branch = "first"
const selectedCalls: string[][] = []
const selected = new GitHubReads({ now: () => now, common: async () => "/shared", branch: async () => branch, run: async (_cwd, args) => {
  selectedCalls.push(args)
  if (args[0] === "repo") return JSON.stringify({ nameWithOwner: args[2]?.includes("/") ? args[2] : "fixture/first", url: "https://github.com/fixture/project" })
  if (args[1] === "graphql") {
    const number = Number(args.find(arg => arg.startsWith("number="))?.slice(7))
    return "HTTP/2.0 200 OK\n\n" + JSON.stringify({ data: { repository: number ? { pullRequest: { number, headRefName: number === 7 ? "first" : "second", state: "OPEN" } } : { pullRequests: { nodes: [{ number: 7, headRefName: "first", state: "OPEN" }, { number: 8, headRefName: "second", state: "OPEN" }] } } } })
  }
  return "{}"
} })
assert.equal(JSON.parse(await selected.run("/one", ["pr", "view", "--json", "number"])).number, 7)
branch = "second"
assert.equal(JSON.parse(await selected.run("/one", ["pr", "view", "--json", "number"])).number, 8)
await selected.run("/one", ["pr", "view", "7", "--repo", "fixture/other", "--json", "number"])
assert.equal(selectedCalls.filter(args => args[1] === "graphql" && !args.some(arg => arg.startsWith("number="))).length, 2)

// Repository lists stand for five minutes; an explicit push/PR event forgets them immediately.
let listClock = 0, listReads = 0
const cadence = new GitHubReads({ now: () => listClock, common: async () => "/cadence", branch: async () => "fix", run: async (_cwd, args) => {
  if (args[0] === "repo") return '{"nameWithOwner":"fixture/project","url":"https://github.com/fixture/project"}'
  listReads++
  assert.ok(!args.some(arg => arg.includes("statusCheckRollup")), "the list carries no checks")
  return 'HTTP/2.0 200 OK\n\n{"data":{"repository":{"pullRequests":{"nodes":[]}}}}'
} })
await cadence.run("/cadence", list)
listClock = 299_999
await cadence.run("/cadence", list)
assert.equal(listReads, 1)
listClock++
await cadence.run("/cadence", list)
assert.equal(listReads, 2)
cadence.forget()
await cadence.run("/cadence", list)
assert.equal(listReads, 3)
console.log("GitHub list: no rollups, five-minute freshness, explicit event invalidation passed")

// A ref event forgets canonical readings across checkout aliases, while unrelated and explicitly foreign repos stay cached.
const scopedQueries: string[] = []
const scoped = new GitHubReads({ now: () => 0, common: async cwd => cwd.startsWith("/one") ? "/shared/one" : "/shared/two", branch: async () => "fix", run: async (cwd, args) => {
  if (args[0] === "repo") return JSON.stringify({ nameWithOwner: args[2]?.includes("/") ? args[2] : `fixture/${cwd.startsWith("/one") ? "one" : "two"}`, url: "https://github.com/fixture/project" })
  const name = args.find(arg => arg.startsWith("name="))!.slice(5)
  scopedQueries.push(name)
  const number = Number(args.find(arg => arg.startsWith("number="))?.slice(7))
  return "HTTP/2.0 200 OK\n\n" + JSON.stringify({ data: { repository: number ? { pullRequest: { number, headRefName: "fix", state: "OPEN" } } : { pullRequests: { nodes: [] } } } })
} })
await scoped.run("/one/main", list)
await scoped.run("/two/main", list)
const foreign = ["pr", "view", "7", "--repo", "fixture/foreign", "--json", "state"]
await scoped.run("/one/main", foreign)
const beforeScope = scopedQueries.length
await scoped.forgetRepository("/one/alias")
await scoped.run("/two/main", list)
await scoped.run("/one/main", foreign)
assert.equal(scopedQueries.length, beforeScope, "neither another repo nor a foreign wait is invalidated by this checkout")
await scoped.run("/one/other-alias", list)
assert.equal(scopedQueries.length, beforeScope + 1)
assert.equal(scopedQueries.at(-1), "one")
console.log("GitHub ref invalidation: canonical aliases share eviction; other repositories and foreign waits retain their readings")
