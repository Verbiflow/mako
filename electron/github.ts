import { app } from "electron"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import { resolveExecutable } from "./executable.js"
import type {
  PullRequest,
  GitHubStatus,
  CheckSummary,
  ReviewSummary,
} from "./shared.js"
import type { WorktreeBranchPull, WorktreePull } from "./contracts/thread-worktrees.js"

const run = promisify(execFile)

/**
 * GitHub, through the `gh` CLI.
 *
 * Not through the REST API with an OAuth flow of our own, and that is a
 * decision rather than a shortcut. Anyone running an agent on a repo already
 * has `gh` authenticated, usually with an SSH protocol preference and an org
 * scope we would otherwise have to ask for again. Building a second login for
 * the same account is asking the user to solve a problem they already solved.
 *
 * The cost is a dependency we do not control, so every call degrades: no `gh`,
 * no auth, or no remote each report themselves plainly rather than failing.
 */

/** Ceilings so a hung `gh` cannot hold a panel open forever. */
const TIMEOUT = 15_000
const MAX_BUFFER = 8 * 1024 * 1024
async function githubExecutable(): Promise<string> {
  const executable = resolveExecutable(process.env.GH_PATH ?? "gh")
  if (!executable) throw new Error("GitHub CLI was not found")
  return executable
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(await githubExecutable(), args, {
    cwd,
    timeout: TIMEOUT,
    maxBuffer: MAX_BUFFER,
  })
  return stdout
}

type GitHubParser<TResult> = (value: JsonValue) => TResult | null

interface GitHubUser {
  login?: string
}

interface GitHubRepository {
  nameWithOwner?: string
  defaultBranch?: string
}

interface ProcessFailure {
  message: string
}

async function ghJson<TResult>(
  cwd: string,
  args: string[],
  parse: GitHubParser<TResult>
): Promise<TResult | null> {
  try {
    const value: JsonValue = JSON.parse(await gh(cwd, args))
    return parse(value)
  } catch {
    return null
  }
}

function parseGitHubUser(value: JsonValue): GitHubUser | null {
  if (!isJsonObject(value)) return null
  return { login: stringValue(value.login) }
}

function parseGitHubRepository(value: JsonValue): GitHubRepository | null {
  if (!isJsonObject(value)) return null
  const defaultBranchRef = objectValue(value.defaultBranchRef)
  return {
    nameWithOwner: stringValue(value.nameWithOwner),
    defaultBranch: stringValue(defaultBranchRef?.name),
  }
}

/**
 * Whether GitHub is usable here, and if not, exactly why.
 *
 * Three different "no"s that want three different answers from the UI —
 * install a tool, log in, or add a remote — so they are three different
 * fields rather than one boolean.
 */
export async function githubStatus(cwd: string): Promise<GitHubStatus> {
  try {
    await run(await githubExecutable(), ["--version"], {
      cwd,
      timeout: TIMEOUT,
    })
  } catch {
    return { installed: false, authenticated: false }
  }

  const who = await ghJson(
    cwd,
    ["api", "user", "--jq", "{login: .login}"],
    parseGitHubUser
  )
  const login = who?.login
  if (!login) return { installed: true, authenticated: false }

  const repo = await ghJson(
    cwd,
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    parseGitHubRepository
  )

  return {
    installed: true,
    authenticated: true,
    login,
    repo: repo?.nameWithOwner,
    defaultBranch: repo?.defaultBranch,
  }
}

interface RawCheck {
  name?: string
  context?: string
  state?: string
  conclusion?: string
  status?: string
  detailsUrl?: string
  targetUrl?: string
}

interface RawReview {
  state?: string
  author?: GitHubUser
}

interface RawPull {
  number: number
  title: string
  body?: string
  state: string
  isDraft: boolean
  url: string
  headRefName: string
  baseRefName: string
  additions?: number
  deletions?: number
  changedFiles?: number
  mergeable?: string
  reviewDecision?: string
  createdAt?: string
  updatedAt?: string
  author?: GitHubUser
  statusCheckRollup?: RawCheck[]
  latestReviews?: RawReview[]
}

const PULL_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "isDraft",
  "url",
  "headRefName",
  "baseRefName",
  "additions",
  "deletions",
  "changedFiles",
  "mergeable",
  "reviewDecision",
  "createdAt",
  "updatedAt",
  "author",
  "statusCheckRollup",
  "latestReviews",
].join(",")

function parseRawCheck(value: JsonValue): RawCheck | null {
  if (!isJsonObject(value)) return null
  return {
    name: stringValue(value.name),
    context: stringValue(value.context),
    state: stringValue(value.state),
    conclusion: stringValue(value.conclusion),
    status: stringValue(value.status),
    detailsUrl: stringValue(value.detailsUrl),
    targetUrl: stringValue(value.targetUrl),
  }
}

function parseRawReview(value: JsonValue): RawReview | null {
  if (!isJsonObject(value)) return null
  const author =
    value.author === undefined ? undefined : parseGitHubUser(value.author)
  return {
    state: stringValue(value.state),
    author: author ?? undefined,
  }
}

function parseRawPull(value: JsonValue): RawPull | null {
  if (!isJsonObject(value)) return null
  const number = numberValue(value.number)
  const title = stringValue(value.title)
  const state = stringValue(value.state)
  const isDraft = booleanValue(value.isDraft)
  const url = stringValue(value.url)
  const headRefName = stringValue(value.headRefName)
  const baseRefName = stringValue(value.baseRefName)
  if (
    number === undefined ||
    title === undefined ||
    state === undefined ||
    isDraft === undefined ||
    url === undefined ||
    headRefName === undefined ||
    baseRefName === undefined
  ) {
    return null
  }

  return {
    number,
    title,
    body: stringValue(value.body),
    state,
    isDraft,
    url,
    headRefName,
    baseRefName,
    additions: numberValue(value.additions),
    deletions: numberValue(value.deletions),
    changedFiles: numberValue(value.changedFiles),
    mergeable: stringValue(value.mergeable),
    reviewDecision: stringValue(value.reviewDecision),
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
    author: parseOptionalUser(value.author),
    statusCheckRollup: parseJsonArray(value.statusCheckRollup, parseRawCheck),
    latestReviews: parseJsonArray(value.latestReviews, parseRawReview),
  }
}

function parseRawPullList(value: JsonValue): RawPull[] | null {
  if (!Array.isArray(value)) return null
  const pulls: RawPull[] = []
  for (const entry of value) {
    const pull = parseRawPull(entry)
    if (pull !== null) pulls.push(pull)
  }
  return pulls
}

function parseOptionalUser(
  value: JsonValue | undefined
): GitHubUser | undefined {
  if (value === undefined) return undefined
  return parseGitHubUser(value) ?? undefined
}

function parseJsonArray<TResult>(
  value: JsonValue | undefined,
  parse: GitHubParser<TResult>
): TResult[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: TResult[] = []
  for (const item of value) {
    const entry = parse(item)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/**
 * Normalize a check.
 *
 * GitHub has two check systems with different shapes — the Checks API and the
 * older commit statuses — and `gh` passes both through as they come. Anything
 * downstream of here sees one shape, because "is CI green" should not require
 * the reader to know which system a repo happens to use.
 */
function toCheck(raw: RawCheck): CheckSummary {
  const name = raw.name ?? raw.context ?? "check"
  const url = raw.detailsUrl ?? raw.targetUrl
  const verdict = (raw.conclusion ?? raw.state ?? "").toUpperCase()
  const running = (raw.status ?? "").toUpperCase()

  if (
    running === "IN_PROGRESS" ||
    running === "QUEUED" ||
    running === "PENDING" ||
    verdict === "PENDING"
  ) {
    return { name, state: "running", url }
  }
  if (verdict === "SUCCESS" || verdict === "NEUTRAL" || verdict === "SKIPPED") {
    return { name, state: "passed", url }
  }
  if (
    verdict === "FAILURE" ||
    verdict === "ERROR" ||
    verdict === "TIMED_OUT" ||
    verdict === "CANCELLED"
  ) {
    return { name, state: "failed", url }
  }
  return { name, state: "unknown", url }
}

function toReviews(raw: RawPull["latestReviews"]): ReviewSummary[] {
  return (raw ?? []).map((review) => ({
    login: review.author?.login ?? "someone",
    state:
      review.state === "APPROVED"
        ? "approved"
        : review.state === "CHANGES_REQUESTED"
          ? "changes"
          : "commented",
  }))
}

function toPull(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state:
      raw.state === "MERGED"
        ? "merged"
        : raw.state === "CLOSED"
          ? "closed"
          : "open",
    draft: Boolean(raw.isDraft),
    url: raw.url,
    head: raw.headRefName,
    base: raw.baseRefName,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    files: raw.changedFiles ?? 0,
    mergeable:
      raw.mergeable === "MERGEABLE"
        ? "clean"
        : raw.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    reviewDecision:
      raw.reviewDecision === "APPROVED"
        ? "approved"
        : raw.reviewDecision === "CHANGES_REQUESTED"
          ? "changes"
          : raw.reviewDecision === "REVIEW_REQUIRED"
            ? "required"
            : "none",
    author: raw.author?.login,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    checks: (raw.statusCheckRollup ?? []).map(toCheck),
    reviews: toReviews(raw.latestReviews),
  }
}

/** The pull request for the branch you are on, if there is one. */
export async function pullForBranch(cwd: string): Promise<PullRequest | null> {
  const raw = await ghJson(
    cwd,
    ["pr", "view", "--json", PULL_FIELDS],
    parseRawPull
  )
  return raw ? toPull(raw) : null
}

export async function listPulls(
  cwd: string,
  limit = 20
): Promise<PullRequest[]> {
  const raw = await ghJson(
    cwd,
    ["pr", "list", "--limit", String(limit), "--json", PULL_FIELDS],
    parseRawPullList
  )
  return raw ? raw.map(toPull) : []
}

/** Open pull requests a new Thread can work on: just what names and finds each branch. Null when `gh` can't answer here. */
export async function listPullHeads(cwd: string): Promise<WorktreePull[] | null> {
  return ghJson(
    cwd,
    ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,headRefName,isDraft,author,updatedAt,isCrossRepository"],
    (value) => {
      if (!Array.isArray(value)) return null
      const pulls: WorktreePull[] = []
      for (const entry of value) {
        if (!isJsonObject(entry)) continue
        const number = numberValue(entry.number)
        const title = stringValue(entry.title)
        const branch = stringValue(entry.headRefName)
        if (number === undefined || title === undefined || !branch) continue
        pulls.push({
          number,
          title,
          branch,
          draft: booleanValue(entry.isDraft) ?? false,
          author: parseOptionalUser(entry.author)?.login ?? null,
          updatedAt: stringValue(entry.updatedAt) ?? null,
          cross: booleanValue(entry.isCrossRepository) ?? false,
        })
      }
      return pulls
    }
  )
}

/** Recent pull requests in any state, newest first, with the head commit and one word for their checks. Null when `gh` can't answer here. */
export async function listBranchPulls(cwd: string): Promise<WorktreeBranchPull[] | null> {
  return ghJson(
    cwd,
    ["pr", "list", "--state", "all", "--limit", "60", "--json", "number,title,url,headRefName,headRefOid,state,isDraft,statusCheckRollup"],
    (value) => {
      if (!Array.isArray(value)) return null
      const pulls: WorktreeBranchPull[] = []
      for (const entry of value) {
        if (!isJsonObject(entry)) continue
        const number = numberValue(entry.number)
        const title = stringValue(entry.title)
        const url = stringValue(entry.url)
        const branch = stringValue(entry.headRefName)
        const head = stringValue(entry.headRefOid)
        const state = stringValue(entry.state)
        if (number === undefined || title === undefined || url === undefined || !branch || !head || !state) continue
        const checks = (parseJsonArray(entry.statusCheckRollup, parseRawCheck) ?? []).map(toCheck)
        pulls.push({
          number,
          title,
          url,
          branch,
          head,
          state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : booleanValue(entry.isDraft) ? "draft" : "open",
          checks: checks.length === 0
            ? null
            : checks.some((check) => check.state === "failed")
              ? "failed"
              : checks.some((check) => check.state === "running")
                ? "running"
                : "passed",
        })
      }
      return pulls
    }
  )
}

export async function listRemoteBranches(cwd: string): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
    { cwd, timeout: TIMEOUT, maxBuffer: MAX_BUFFER }
  )
  return stdout
    .split("\n")
    .map((branch) => branch.trim().replace(/^origin\//, ""))
    .filter((branch) => branch && branch !== "HEAD")
    .filter((branch, index, branches) => branches.indexOf(branch) === index)
    .sort((left, right) => left.localeCompare(right))
}

function parseProcessFailure(cause: unknown): ProcessFailure {
  return { message: cause instanceof Error ? cause.message : String(cause) }
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
  return isBoolean(value) ? value : undefined
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBoolean(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

export interface CreatePullOptions {
  title: string
  body: string
  base?: string
  draft?: boolean
}

/**
 * Open a pull request.
 *
 * The branch is pushed first when it has no upstream, because `gh pr create`
 * against an unpushed branch fails in a way that reads like a GitHub problem
 * rather than a local one. Everything else is left to `gh`, including the
 * default base, which respects whatever the repository has configured.
 */
export async function createPull(
  cwd: string,
  options: CreatePullOptions
): Promise<PullRequest | null> {
  await run("git", ["push", "--set-upstream", "origin", "HEAD"], {
    cwd,
    timeout: 120_000,
  }).catch(async (cause) => {
    // Already published is not a failure; anything else is.
    const failure = parseProcessFailure(cause)
    if (!/everything up-to-date|up to date/i.test(failure.message)) throw cause
  })

  const args = [
    "pr",
    "create",
    "--title",
    options.title,
    "--body",
    options.body,
  ]
  if (options.base) args.push("--base", options.base)
  if (options.draft) args.push("--draft")
  await gh(cwd, args)
  return pullForBranch(cwd)
}

export async function mergePull(
  cwd: string,
  strategy: "merge" | "squash" | "rebase"
): Promise<PullRequest | null> {
  await gh(cwd, ["pr", "merge", `--${strategy}`])
  return pullForBranch(cwd)
}

/**
 * The project's avatar, as a data URL.
 *
 * Fetched here and cached to disk rather than pointed at from an `<img>` in
 * the renderer. Two reasons: it works offline after the first look, and the
 * window makes no network request of its own — everything Mako sends to
 * GitHub goes through one file, which is the only way that claim stays
 * checkable.
 *
 * Failure is silent and returns nothing. A missing logo is a folder icon; it
 * is not worth a toast, a retry, or a line in a crash report.
 */
export async function repoAvatar(
  cwd: string,
  repo: string
): Promise<string | undefined> {
  const owner = repo.split("/")[0]
  if (!owner) return undefined

  const dir = join(app.getPath("userData"), "avatars")
  const file = join(dir, `${owner.replace(/[^\w.-]/g, "-")}.png`)
  try {
    return `data:image/png;base64,${(await readFile(file)).toString("base64")}`
  } catch {
    // Not cached yet.
  }

  try {
    const url = (
      await gh(cwd, ["api", `repos/${repo}`, "--jq", ".owner.avatar_url"])
    ).trim()
    if (!url.startsWith("https://")) return undefined
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}s=128`)
    if (!response.ok) return undefined
    const bytes = Buffer.from(await response.arrayBuffer())
    // A logo is a few kilobytes; anything much larger is not one.
    if (bytes.length > 512_000) return undefined
    await mkdir(dir, { recursive: true })
    await writeFile(file, bytes)
    return `data:image/png;base64,${bytes.toString("base64")}`
  } catch {
    return undefined
  }
}

/**
 * The signed-in user's avatar, as a data URL — the identity mark for the
 * titlebar. Same discipline as the repo avatar: fetched here, cached to
 * disk, silent on failure (a missing avatar is a monogram, not a toast),
 * and every request Mako makes to GitHub stays in this one file.
 */
export async function userAvatar(cwd: string): Promise<string | undefined> {
  const dir = join(app.getPath("userData"), "avatars")
  try {
    const login = (await gh(cwd, ["api", "user", "--jq", ".login"])).trim()
    if (!login) return undefined
    const file = join(dir, `user-${login.replace(/[^\w.-]/g, "-")}.png`)
    try {
      return `data:image/png;base64,${(await readFile(file)).toString("base64")}`
    } catch {
      // Not cached yet.
    }
    const url = (await gh(cwd, ["api", "user", "--jq", ".avatar_url"])).trim()
    if (!url.startsWith("https://")) return undefined
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}s=128`)
    if (!response.ok) return undefined
    const bytes = Buffer.from(await response.arrayBuffer())
    // An avatar is a few kilobytes; anything much larger is not one.
    if (bytes.length > 512_000) return undefined
    await mkdir(dir, { recursive: true })
    await writeFile(file, bytes)
    return `data:image/png;base64,${bytes.toString("base64")}`
  } catch {
    return undefined
  }
}

/** Ask GitHub to re-run whatever failed, rather than making the user leave. */
export async function rerunChecks(cwd: string): Promise<void> {
  await gh(cwd, ["run", "rerun", "--failed"]).catch(async () => {
    // No failed run to retry is a normal outcome, not an error worth raising.
  })
}
