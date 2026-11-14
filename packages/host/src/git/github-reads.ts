import { z } from "zod"
import { createHash } from "node:crypto"
import { githubRateLimitWords } from "../contracts/git-actions.js"

/** A cheap repository list; checks belong to individual PRs whose heads a caller is actually using. */
const LIST_FIELDS = "number,title,url,headRefName,headRefOid,state,isDraft,author,updatedAt,isCrossRepository"
// Explicit API calls expose rate-limit headers that `gh pr list/view` hide.
const PULL_SELECTION = `number title body state isDraft url headRefName headRefOid baseRefName additions deletions changedFiles mergeable reviewDecision createdAt updatedAt isCrossRepository author { login }
 latestReviews(first:100) { pageInfo { hasNextPage } nodes { author { login } state submittedAt } }
 commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes {
  __typename ... on StatusContext { context state targetUrl }
  ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
 } } } } } }`
const PULL_LIST_QUERY = `query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { pullRequests(first:60,states:[OPEN,CLOSED,MERGED],orderBy:{field:CREATED_AT,direction:DESC}) { nodes { number title url headRefName headRefOid state isDraft updatedAt isCrossRepository author { login } } } } }`
const PULL_QUERY = `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { ${PULL_SELECTION} } } }`
const CHECK_QUERY = `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { number headRefName state headRefOid
 commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes {
 __typename ... on StatusContext { context state targetUrl }
 ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
 } } } } } } } } }`
const GraphPull = z.looseObject({
  number: z.number(), headRefName: z.string(), state: z.string(),
  latestReviews: z.object({ pageInfo: z.object({ hasNextPage: z.literal(false) }), nodes: z.array(z.unknown()) }).nullable().optional(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ contexts: z.object({ pageInfo: z.object({ hasNextPage: z.literal(false) }), nodes: z.array(z.looseObject({
    checkSuite: z.object({ workflowRun: z.object({ workflow: z.object({ name: z.string() }).nullable() }).nullable() }).nullable().optional(),
  })) }) }).nullable() }) })) }).optional(),
})
function graphPull(output: string): string {
  const response = z.object({ errors: z.never().optional(), data: z.object({ repository: z.object({ pullRequest: GraphPull }) }) }).parse(JSON.parse(output))
  const pull = response.data.repository.pullRequest
  return JSON.stringify({
    ...pull,
    latestReviews: pull.latestReviews?.nodes ?? [],
    statusCheckRollup: (pull.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(check => ({ ...check, workflowName: check.checkSuite?.workflowRun?.workflow?.name })),
  })
}
const REPO_FIELDS = "url,nameWithOwner,defaultBranchRef,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"
const FRESH_MS = 60_000
const MAX_READS = 512

type Runner = (cwd: string, args: string[], env?: Readonly<Record<string, string>>) => Promise<string>
interface Entry { until: number; value: Promise<string>; etag?: string; body?: string }
interface Deps {
  run: Runner
  common(cwd: string): Promise<string>
  branch(cwd: string): Promise<string>
  now(): number
  /** Fixed labels and counters only: never arguments, query text, output, authentication or repository names. */
  trace?(event: "request" | "cached" | "limited", kind: string): void
}

/** A transport refusal carries the original deadline through cached reads and tool preflights. */
export class GitHubRateLimitError extends Error {
  readonly retryAt: number
  constructor(retryAt: number) {
    super(githubRateLimitWords(retryAt))
    this.name = "GitHubRateLimitError"
    this.retryAt = retryAt
  }
}

/** Normalise only rate-limit facts; arbitrary gh output is never a user-facing error. */
export function githubRateLimit(cause: unknown, now: number, backoffMs = 60_000): GitHubRateLimitError | undefined {
  if (cause instanceof GitHubRateLimitError) return cause
  const failure = z.object({ stderr: z.string().optional(), stdout: z.string().optional() }).safeParse(cause)
  const stderr = failure.success ? failure.data.stderr ?? "" : ""
  const stdout = failure.success ? failure.data.stdout ?? "" : ""
  const headers = httpResponse(stdout).headers
  if (!/secondary rate|rate limit|abuse detection|HTTP 429/i.test(stderr) && headers.get("retry-after") === undefined && headers.get("x-ratelimit-remaining") !== "0") return undefined
  const retryAfter = headers.get("retry-after")
  const retry = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? "") - now
  const reset = headers.get("x-ratelimit-remaining") === "0" ? Number(headers.get("x-ratelimit-reset")) * 1000 - now : 0
  return new GitHubRateLimitError(now + Math.max(backoffMs, Number.isFinite(retry) ? retry : 0, Number.isFinite(reset) ? reset : 0))
}

/** The login's transport is serial even across repositories; a limit stops admission, including queued work. */
export class GitHubReads {
  private readonly entries = new Map<string, Entry>()
  private readonly scopes = new Map<string, Promise<string>>()
  private tail: Promise<unknown> = Promise.resolve()
  private blockedUntil = 0
  private failures = 0

  private readonly deps: Deps

  constructor(deps: Deps) { this.deps = deps }

  async run(cwd: string, args: string[], env?: Readonly<Record<string, string>>): Promise<string> {
    // An App's override never shares the person's readings. Hashes stay in memory, never in logs.
    const auth = createHash("sha256").update(JSON.stringify([process.env.GH_HOST, process.env.GH_REPO, process.env.GH_CONFIG_DIR, process.env.HOME, process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_ENTERPRISE_TOKEN, process.env.GITHUB_ENTERPRISE_TOKEN, env])).digest("hex")
    const explicit = args.indexOf("--repo")
    const scope = explicit >= 0 ? args[explicit + 1]! : await this.scope(cwd)
    const prefix = `${auth}:${scope}:`
    const fields = args.indexOf("--json")
    if (args[0] === "pr" && ["view", "list"].includes(args[1]!) && fields >= 0 && !args.includes("--search")) {
      // One repository snapshot feeds all the usual lists and views. A PR outside the bounded list gets its own read.
      const repository = z.object({ nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/), url: z.string().url() }).parse(JSON.parse(await this.read(`${prefix}repo`, cwd, ["repo", "view", ...(explicit >= 0 ? [scope] : []), "--json", REPO_FIELDS], env, 5 * FRESH_MS)))
      const repo = repository.nameWithOwner.toLowerCase()
      const hostname = new URL(repository.url).hostname
      if (!repo) throw new Error("GitHub did not name this repository")
      const [owner, name] = repo.split("/")
      const list = await this.read(`${auth}:${hostname}/${repo}:pulls`, cwd, ["api", "graphql", "--hostname", hostname, "-f", `query=${PULL_LIST_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`], env, 5 * FRESH_MS)
      const response = z.object({ errors: z.never().optional(), data: z.object({ repository: z.object({ pullRequests: z.object({ nodes: z.array(z.looseObject({ number: z.number(), headRefName: z.string(), state: z.string(), isCrossRepository: z.boolean().optional() })) }) }) }) }).parse(JSON.parse(list))
      const pulls = response.data.repository.pullRequests.nodes
      if (args[1] === "list") {
        const stateAt = args.indexOf("--state"), limitAt = args.indexOf("--limit")
        const state = stateAt < 0 ? "open" : args[stateAt + 1]
        const limit = limitAt < 0 ? 30 : Number(args[limitAt + 1])
        const matching = pulls.filter(pull => state === "all" || pull.state.toLowerCase() === state)
        const cheap = args[fields + 1]!.split(",").every(field => LIST_FIELDS.split(",").includes(field))
        if (cheap && limit <= 60 && (state === "all" || pulls.length < 60 || matching.length >= limit)) return JSON.stringify(matching.slice(0, limit))
      } else {
        const selected = args[2]?.startsWith("--") ? await this.deps.branch(cwd) : args[2]!
        const candidates = pulls.filter(pull => pull.headRefName === selected && pull.state === "OPEN" && !pull.isCrossRepository)
        const number = /^\d+$/.test(selected) ? Number(selected) : candidates.length === 1 ? candidates[0]!.number : undefined
        if (number !== undefined) {
          const checksOnly = args[fields + 1]!.split(",").every(field => ["headRefOid", "statusCheckRollup"].includes(field))
          const key = `${auth}:${hostname}/${repo}:pull:${number}`
          const full = this.entries.get(key)
          if (checksOnly && full && full.until > this.deps.now()) return graphPull(await full.value)
          return graphPull(await this.read(`${key}${checksOnly ? ":checks" : ""}`, cwd, ["api", "graphql", "--hostname", hostname, "-f", `query=${checksOnly ? CHECK_QUERY : PULL_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], env))
        }
        // Ambiguous fork/branch selection keeps gh's own upstream resolution, never a same-name guess.
        return this.read(`${auth}:${hostname}/${repo}:branch:${selected}`, cwd, args, env)
      }
    }
    const graphRead = args[0] === "api" && args[1] === "graphql" && args.some(arg => /^query=\s*query[\s({]/.test(arg))
    const read = graphRead || (args[0] === "repo" && args[1] === "view") || (args[0] === "pr" && args[1] === "list") || (args[0] === "run" && ["view", "list"].includes(args[1]!)) || args[0] === "api" && !args.includes("--method") && !args.includes("-X") && !args.includes("-f") && !args.includes("-F")
    if (args[0] === "repo" && args[1] === "view" && args[2] === "--json") return this.read(`${prefix}repo`, cwd, ["repo", "view", "--json", REPO_FIELDS], env, 5 * FRESH_MS)
    if (read) return this.read(`${args[0] === "api" && !args[1]?.includes("{") ? `${auth}:api:` : prefix}${JSON.stringify(args)}`, cwd, args, env)
    // No mutation is cached, joined or retried. A write might have succeeded despite a lost response, so forget reads even then.
    try { return await this.send(cwd, args, env) }
    finally { this.entries.clear() }
  }

  /** Explicit writes re-read their preflight and invalidate the pushed head; backoff is never reset. */
  forget(): void { this.entries.clear() }

  private scope(cwd: string): Promise<string> {
    let found = this.scopes.get(cwd)
    if (!found) {
      found = this.deps.common(cwd).catch(() => cwd)
      if (this.scopes.size >= MAX_READS) this.scopes.clear()
      this.scopes.set(cwd, found)
    }
    return found
  }

  private read(key: string, cwd: string, args: string[], env?: Readonly<Record<string, string>>, freshMs = FRESH_MS): Promise<string> {
    const prior = this.entries.get(key)
    if (prior && prior.until > this.deps.now()) {
      this.deps.trace?.("cached", args[0]!)
      return prior.value
    }
    if (this.entries.size >= MAX_READS && !prior) {
      for (const [old, value] of this.entries) if (value.until !== Infinity) this.entries.delete(old)
      if (this.entries.size >= MAX_READS) throw new Error("GitHub has too many readings waiting. Try again later.")
    }
    const entry: Entry = { until: Infinity, value: Promise.resolve("") }
    // Only plain REST GETs: jq output cannot be reused as an HTTP body, and GraphQL has no ETag contract.
    const conditional = args[0] === "api" && args.length === 2 && args[1] !== "graphql"
    const include = args[0] === "api" && !args.includes("--include")
    entry.value = this.send(cwd, include ? [...args, "--include", ...(conditional && prior?.etag ? ["-H", `If-None-Match: ${prior.etag}`] : [])] : args, env).then(output => {
      if (include) {
        const response = httpResponse(output)
        if (response.status === 304) {
          if (prior?.body === undefined) throw new Error("GitHub returned an unowned conditional response")
          entry.body = prior.body
          entry.etag = prior.etag
        } else {
          entry.body = response.body
          entry.etag = response.headers.get("etag")
        }
        output = entry.body!
      }
      entry.until = this.deps.now() + freshMs
      return output
    }).catch(cause => {
      // Negative readings are shared for one minute too. Never serve old checks after a failed refresh.
      entry.until = this.deps.now() + FRESH_MS
      throw cause
    })
    this.entries.set(key, entry)
    return entry.value
  }

  private send(cwd: string, args: string[], env?: Readonly<Record<string, string>>): Promise<string> {
    const request = this.tail.catch(() => {}).then(async () => {
      if (this.deps.now() < this.blockedUntil) throw new GitHubRateLimitError(this.blockedUntil)
      this.deps.trace?.("request", args[0]!)
      try {
        const output = await this.deps.run(cwd, args, env)
        if (this.deps.now() > this.blockedUntil + 15 * 60_000) this.failures = 0
        return output
      } catch (cause) {
        const limited = githubRateLimit(cause, this.deps.now(), 60_000 * 2 ** Math.min(this.failures, 6))
        if (limited) {
          this.failures++
          this.blockedUntil = Math.max(this.blockedUntil, limited.retryAt)
          this.deps.trace?.("limited", args[0]!)
          throw limited
        }
        throw cause
      }
    })
    this.tail = request
    return request
  }
}

/** `gh api --include`'s HTTP status and headers, kept out of every consumer's JSON. */
function httpResponse(output: string) {
  const end = output.search(/\r?\n\r?\n/)
  const head = end >= 0 ? output.slice(0, end) : ""
  const headers = new Map<string, string>()
  for (const line of head.split(/\r?\n/).slice(1)) {
    const at = line.indexOf(":")
    if (at > 0) headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim())
  }
  return { status: Number(/^HTTP\/\S+ (\d+)/.exec(head)?.[1]), headers, body: end < 0 ? output : output.slice(end).replace(/^\r?\n\r?\n/, "") }
}
