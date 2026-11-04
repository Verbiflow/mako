import assert from "node:assert/strict"
import {
  CLOUD_ACCESS_CATALOG,
  CLOUD_ACCESS_SERVICES,
  CloudAccessGrantSchema,
  CloudAccessGrantsAnswerSchema,
  CloudAccessRepositorySchema,
  CloudAccessUsesAnswerSchema,
  type CloudAccessGrant,
} from "@mako/host/contracts/cloud-access"
import type { JsonValue } from "@mako/host/contracts/json"
import { grantAccount, givenWords } from "../src/state/cloud-access"
import { listedRepositories, webCloudAccess } from "../src/web-client/cloud-access"
import type { Gateway } from "../src/web-client/gateway"

/**
 * A project's cloud access as the open app reads the account's routes: the answers' shapes, each service as Settings
 * names it, a browser's calls (method, path, body) against a stand-in gateway, the projects a browser lists, and the
 * words a connected row says. No network.
 */

const REPOSITORY = "https://github.com/acme/shop"
const grant: CloudAccessGrant = {
  service: "cloudflare",
  repository: REPOSITORY,
  account: { id: "acc-1", name: null },
  variables: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  savedAt: "2026-11-01T10:00:00.000Z",
  expiresAt: null,
  lastGiven: { at: "2026-11-03T09:55:00.000Z", threadId: "t-1" },
}

// The answers as the gateway gives them.
assert.deepEqual(CloudAccessGrantsAnswerSchema.parse({ grants: [grant] }).grants, [grant])
assert.equal(CloudAccessGrantSchema.safeParse({ ...grant, service: "netlify" }).success, false)
assert.equal(CloudAccessUsesAnswerSchema.parse({ uses: [{ service: "vercel", threadId: "t-2", machine: null, at: grant.savedAt }] }).uses.length, 1)
assert.equal(CloudAccessRepositorySchema.safeParse(REPOSITORY).success, true)
for (const bad of ["acme/shop", "https://gitlab.com/acme/shop", "https://github.com/acme/shop?x=1", "https://github.com/acme"])
  assert.equal(CloudAccessRepositorySchema.safeParse(bad).success, false, bad)

// Every service named, with its own token page and the variables its shells get.
assert.deepEqual(Object.keys(CLOUD_ACCESS_CATALOG), [...CLOUD_ACCESS_SERVICES])
assert.deepEqual(CLOUD_ACCESS_CATALOG.cloudflare.variables.always, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
assert.deepEqual([...CLOUD_ACCESS_CATALOG.vercel.variables.always, ...CLOUD_ACCESS_CATALOG.vercel.variables.whenAccount], ["VERCEL_TOKEN", "VERCEL_ORG_ID"])
for (const service of CLOUD_ACCESS_SERVICES) assert.match(CLOUD_ACCESS_CATALOG[service].tokenPage, /^https:\/\//)

// A browser's calls: the account's routes, the repository in the query, no account field when none was named.
const calls: Array<{ method: string; path: string; body?: string }> = []
const answers: Array<JsonValue | undefined> = []
const gateway: Pick<Gateway, "rest"> = {
  rest: async <Body>(method: string, path: string, body?: Body) => {
    calls.push(body === undefined ? { method, path } : { method, path, body: JSON.stringify(body) })
    return answers.shift()
  },
}
const transport = webCloudAccess(gateway, "acct 1")
const base = "/v1/accounts/acct%201/cloud-access"
const query = `?repository=${encodeURIComponent(REPOSITORY)}`
answers.push({ grants: [grant] })
assert.deepEqual(await transport.grants(REPOSITORY), [grant])
answers.push(grant)
await transport.save(REPOSITORY, "cloudflare", "secret-token")
answers.push({ ...grant, service: "vercel", variables: ["VERCEL_TOKEN", "VERCEL_ORG_ID"] })
await transport.save(REPOSITORY, "vercel", "secret-token", "team_acme")
answers.push(undefined)
await transport.remove(REPOSITORY, "vercel")
answers.push({ uses: [] })
assert.deepEqual(await transport.uses(REPOSITORY), [])
assert.deepEqual(calls, [
  { method: "GET", path: `${base}${query}` },
  { method: "PUT", path: `${base}/cloudflare${query}`, body: JSON.stringify({ token: "secret-token" }) },
  { method: "PUT", path: `${base}/vercel${query}`, body: JSON.stringify({ token: "secret-token", account: "team_acme" }) },
  { method: "DELETE", path: `${base}/vercel${query}` },
  { method: "GET", path: `${base}/uses${query}` },
])
// An answer that isn't the contract's is refused rather than drawn.
answers.push({ grants: [{ ...grant, account: "acc-1" }] })
await assert.rejects(transport.grants(REPOSITORY))

// The projects a browser lists: each repository once, the one prompted in latest first.
assert.deepEqual(
  listedRepositories([
    { repository: { url: "https://github.com/acme/docs" }, createdAt: "2026-11-01T00:00:00.000Z" },
    { repository: { url: REPOSITORY }, createdAt: "2026-10-01T00:00:00.000Z", promptedAt: "2026-11-02T00:00:00.000Z" },
    { createdAt: "2026-11-03T00:00:00.000Z" },
    { repository: { url: "https://github.com/acme/docs" }, createdAt: "2026-10-20T00:00:00.000Z" },
  ]),
  [REPOSITORY, "https://github.com/acme/docs"],
)
// An account whose projects are cloud-only: its cloud machines' Sessions are listed without a repository, so the
// account's cloud projects are the list, newest first.
const cloudOnly = [
  { createdAt: "2026-11-03T00:00:00.000Z", promptedAt: "2026-11-03T01:00:00.000Z" },
  { createdAt: "2026-11-02T00:00:00.000Z" },
]
assert.deepEqual(
  listedRepositories(cloudOnly, [
    { url: "https://github.com/acme/api", usedAt: "2026-11-03T02:00:00.000Z" },
    { url: REPOSITORY, usedAt: "2026-11-01T00:00:00.000Z" },
  ]),
  ["https://github.com/acme/api", REPOSITORY],
)
assert.deepEqual(listedRepositories(cloudOnly), [])
// Both together: each repository once, at the later of its project's use and its Sessions' prompts; anything that
// isn't a GitHub repository's URL left out.
assert.deepEqual(
  listedRepositories(
    [{ repository: { url: REPOSITORY }, createdAt: "2026-10-01T00:00:00.000Z", promptedAt: "2026-11-04T00:00:00.000Z" }],
    [
      { url: "https://github.com/acme/api", usedAt: "2026-11-03T02:00:00.000Z" },
      { url: REPOSITORY, usedAt: "2026-11-01T00:00:00.000Z" },
      { url: "https://gitlab.com/acme/other", usedAt: "2026-11-05T00:00:00.000Z" },
    ],
  ),
  [REPOSITORY, "https://github.com/acme/api"],
)

// A connected row's words.
assert.equal(grantAccount(grant), "acc-1")
assert.equal(grantAccount({ ...grant, account: { id: "acc-1", name: "Acme" } }), "Acme")
assert.equal(givenWords(grant, Date.parse("2026-11-03T10:00:00.000Z")), "Given to a cloud Thread 5 minutes ago")
assert.equal(givenWords({ ...grant, lastGiven: null }), "Not given to a cloud Thread yet")

console.log("Cloud access: the answers parsed and refused as the contract says, every service named, a browser's calls on the account's routes, its projects (cloud-only ones too) listed once each, and a connected row's words")
