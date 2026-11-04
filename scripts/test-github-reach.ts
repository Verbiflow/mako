import assert from "node:assert/strict"
import {
  GITHUB_REACH_LIMIT,
  GitHubAskConflictSchema,
  GitHubAskSchema,
  GitHubReachAnswerSchema,
  GitHubReachSchema,
  typedReachRepository,
  type GitHubAsk,
} from "@mako/host/contracts/github-reach"
import type { JsonValue } from "@mako/host/contracts/json"
import { reachChoices, repositoriesWords, settledWords, withoutRepository, withRepository } from "../src/state/github-reach"
import { webGitHubReach } from "../src/web-client/github-reach"
import { GatewayError, type Gateway } from "../src/web-client/gateway"

/**
 * GitHub reach as the open app reads the account's routes: the answers' shapes, a 409's ask, what a person may type for
 * a project's chosen set, a browser's calls (method, path, body) against a stand-in gateway, and the words Settings
 * says. No network.
 */

const PROJECT = "https://github.com/acme/shop"
const ask: GitHubAsk = {
  id: "ask-1",
  repository: PROJECT,
  threadId: "t-1",
  repositories: ["acme/docs"],
  access: "read",
  why: "The search index reads the docs site's front matter.",
  askedAt: "2026-11-03T10:00:00.000Z",
  state: "pending",
  answeredAt: null,
}

// The answers as the gateway gives them, and what isn't one.
assert.deepEqual(GitHubReachAnswerSchema.parse({ reach: { mode: "repository" }, asks: [ask] }).asks, [ask])
for (const reach of [{ mode: "repository" }, { mode: "installation" }, { mode: "chosen", repositories: ["acme/docs", "acme/api"] }, { mode: "chosen", repositories: [] }])
  assert.deepEqual(GitHubReachSchema.parse(reach), reach)
for (const bad of [{ mode: "chosen" }, { mode: "chosen", repositories: ["docs"] }, { mode: "chosen", repositories: ["https://github.com/acme/docs"] }, { mode: "everything" }])
  assert.equal(GitHubReachSchema.safeParse(bad).success, false, JSON.stringify(bad))
assert.equal(GitHubReachSchema.safeParse({ mode: "chosen", repositories: Array.from({ length: GITHUB_REACH_LIMIT + 1 }, (_, index) => `acme/r${index}`) }).success, false)
assert.equal(GitHubAskSchema.safeParse({ ...ask, why: "x".repeat(301) }).success, false)
assert.equal(GitHubAskSchema.safeParse({ ...ask, access: "write" }).success, false)
assert.equal(GitHubAskSchema.safeParse({ ...ask, repositories: [] }).success, false)

// A 409 carries the ask in its problem's `detail`, as an object or as its JSON.
const expired: GitHubAsk = { ...ask, state: "expired", answeredAt: "2026-11-04T10:00:00.000Z" }
assert.deepEqual(GitHubAskConflictSchema.safeParse({ title: "Already answered", detail: expired }).data?.detail, expired)
assert.deepEqual(GitHubAskConflictSchema.safeParse({ title: "Already answered", detail: JSON.stringify(expired) }).data?.detail, expired)
assert.equal(GitHubAskConflictSchema.safeParse({ title: "Already answered", detail: "It expired." }).data?.detail, undefined)
assert.equal(GitHubAskConflictSchema.safeParse(undefined).data?.detail, undefined)

// What a person types for the chosen set: a name under the project's owner, owner/name, or its address.
assert.deepEqual(typedReachRepository("docs", PROJECT), { repository: "acme/docs" })
assert.deepEqual(typedReachRepository(" acme/docs ", PROJECT), { repository: "acme/docs" })
assert.deepEqual(typedReachRepository("ACME/docs", PROJECT), { repository: "acme/docs" })
assert.deepEqual(typedReachRepository("https://github.com/acme/docs.git", PROJECT), { repository: "acme/docs" })
assert.deepEqual(typedReachRepository("github.com/acme/docs/", PROJECT), { repository: "acme/docs" })
assert.deepEqual(typedReachRepository("other/docs", PROJECT), { refused: "Only repositories under acme." })
assert.ok("refused" in typedReachRepository("acme/shop", PROJECT))
assert.ok("refused" in typedReachRepository("not a name", PROJECT))
assert.ok("refused" in typedReachRepository("acme/docs/tree/main", PROJECT))

// A browser's calls: the account's routes, the project in the query, the reach and the answer as bodies.
const calls: Array<{ method: string; path: string; body?: string }> = []
const answers: Array<JsonValue | Error | undefined> = []
const gateway: Pick<Gateway, "rest"> = {
  rest: async <Body>(method: string, path: string, body?: Body) => {
    calls.push(body === undefined ? { method, path } : { method, path, body: JSON.stringify(body) })
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  },
}
const transport = webGitHubReach(gateway, "acct 1")
const account = "/v1/accounts/acct%201"
const query = `?repository=${encodeURIComponent(PROJECT)}`
answers.push({ reach: { mode: "repository" }, asks: [ask] })
assert.deepEqual(await transport.read(PROJECT), { reach: { mode: "repository" }, asks: [ask] })
answers.push({ reach: { mode: "chosen", repositories: ["acme/docs"] } })
assert.deepEqual(await transport.save(PROJECT, { mode: "chosen", repositories: ["acme/docs"] }), { mode: "chosen", repositories: ["acme/docs"] })
answers.push({ asks: [ask] })
assert.deepEqual(await transport.asks(), [ask])
answers.push({ ask: { ...ask, state: "allowed-thread", answeredAt: "2026-11-03T10:05:00.000Z" } })
assert.deepEqual(await transport.answer("ask 1", "thread"), { ask: { ...ask, state: "allowed-thread", answeredAt: "2026-11-03T10:05:00.000Z" }, already: false })
assert.deepEqual(calls, [
  { method: "GET", path: `${account}/github-reach${query}` },
  { method: "PUT", path: `${account}/github-reach${query}`, body: JSON.stringify({ mode: "chosen", repositories: ["acme/docs"] }) },
  { method: "GET", path: `${account}/github-asks` },
  { method: "POST", path: `${account}/github-asks/ask%201`, body: JSON.stringify({ answer: "thread" }) },
])

// An ask answered or expired before this answer reached it comes back as it stands; any other refusal stays one.
answers.push(new GatewayError(409, "Already answered", undefined, { title: "Already answered", detail: expired }))
assert.deepEqual(await transport.answer("ask-1", "project"), { ask: expired, already: true })
answers.push(new GatewayError(409, "Already answered", undefined, { title: "Already answered" }))
await assert.rejects(transport.answer("ask-1", "project"), /Already answered/)
answers.push(new GatewayError(404, "No such ask", undefined, { title: "No such ask" }))
await assert.rejects(transport.answer("ask-1", "decline"), /No such ask/)
// A reach the contract refuses never leaves; an answer that isn't the contract's is refused rather than drawn.
await assert.rejects(transport.save(PROJECT, { mode: "chosen", repositories: ["docs"] }))
answers.push({ reach: { mode: "chosen", repositories: "acme/docs" } })
await assert.rejects(transport.read(PROJECT))

// The words Settings says.
assert.deepEqual(reachChoices(PROJECT).map((choice) => choice.label), ["Only this repository", "These repositories", "Every repository Mako's GitHub App can see for acme"])
assert.equal(repositoriesWords(["acme/docs"]), "acme/docs")
assert.equal(repositoriesWords(["acme/docs", "acme/api"]), "acme/docs and acme/api")
assert.equal(repositoriesWords(["acme/docs", "acme/api", "acme/ui"]), "acme/docs, acme/api and acme/ui")
assert.equal(repositoriesWords(["acme/docs", "acme/api", "acme/ui", "acme/cli"]), "acme/docs, acme/api and 2 more")
assert.equal(settledWords({ ask: { ...ask, state: "allowed-project" }, already: false }), "Allowed for the project")
assert.equal(settledWords({ ask: { ...ask, state: "declined" }, already: true }), "Already answered: declined")
assert.equal(settledWords({ ask: expired, already: true }), "Expired before an answer")

// The chosen set with one more (once each), or one fewer; from another mode it starts empty.
assert.deepEqual(withRepository({ mode: "repository" }, "acme/docs"), { mode: "chosen", repositories: ["acme/docs"] })
assert.deepEqual(withRepository({ mode: "chosen", repositories: ["acme/docs"] }, "ACME/docs"), { mode: "chosen", repositories: ["acme/docs"] })
assert.deepEqual(withoutRepository({ mode: "chosen", repositories: ["acme/docs", "acme/api"] }, "acme/docs"), { mode: "chosen", repositories: ["acme/api"] })

console.log("GitHub reach: the answers parsed and refused as the contract says, a 409's ask, what a person may type, a browser's calls on the account's routes, and Settings' words")
