import { hostCommand } from "../base/host-command.js"
import { hostFetch, hostStopping, type HostStopping } from "../base/host-stopping.js"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { GitHubReads } from "./github-reads.js"
import { hostLog } from "../base/host-log.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import { resolveExecutable } from "../base/executable.js"
import { MACHINE_GITHUB_ENV } from "../contracts/machine-agent.js"
import type { PullRequest, GitHubStatus, CheckSummary, ReviewSummary } from "../contracts/git-workspace-search.js"
import type { PullRequestListing } from "../contracts/pull-request-search.js"
import type { PullReading } from "../contracts/pull-waits.js"
import type { WorktreeBranchPull, WorktreePull } from "../contracts/thread-worktrees.js"
import { MERGE_METHODS, type MergeMethod } from "../contracts/git-actions.js"
import type { Git } from "@mako/git"

const run = hostCommand

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

/** `env`: added to `gh`'s environment, as on a cloud machine to open a pull request as Mako's App (`MACHINE_GITHUB_AS`). */
async function directGh(cwd: string, args: string[], env?: Readonly<Record<string, string>>): Promise<string> {
  const { stdout } = await run(await githubExecutable(), args, {
    cwd,
    timeout: TIMEOUT,
    maxBuffer: MAX_BUFFER,
    ...env && { env: { ...process.env, ...env } },
  })
  return stdout
}

// Entries belong to the host that owns the key, not to the process; stopping a host releases its reader.
const readers = new WeakMap<HostStopping, GitHubReads>()
function gh(cwd: string, args: string[], env?: Readonly<Record<string, string>>): Promise<string> {
  const host = hostStopping()
  if (!host) return directGh(cwd, args, env)
  host.signal.throwIfAborted()
  let reader = readers.get(host)
  if (!reader) {
    reader = new GitHubReads({
      run: directGh,
      common: async cwd => (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: TIMEOUT })).stdout.trim(),
      branch: async cwd => (await run("git", ["symbolic-ref", "--short", "HEAD"], { cwd, timeout: TIMEOUT })).stdout.trim(),
      now: Date.now,
      trace: (event, kind) => { if (event !== "cached") hostLog("github", event, { kind }) },
    })
    readers.set(host, reader)
  }
  return reader.run(cwd, args, env)
}

/** A write needs a fresh preflight; forgetting readings cannot bypass the login's rate-limit gate. */
export function forgetGitHubReads(): void {
  const host = hostStopping()
  if (host) readers.get(host)?.forget()
}

type GitHubParser<TResult> = (value: JsonValue) => TResult | null

interface GitHubUser {
  login?: string
  id?: string
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
  return { login: stringValue(value.login), id: Number.isSafeInteger(value.id) ? String(value.id) : undefined }
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
 * On a cloud machine, who its person is on GitHub, from beside the machine's GitHub access (`MACHINE_GITHUB_ENV`).
 * That access is a GitHub App's token for the Thread's repository, which can't ask GitHub who it is (`api user` is
 * for a person's own sign-in), so the person is read from what the machine was given with it. Undefined anywhere
 * else, or while the machine has no access.
 */
async function machineUser(): Promise<GitHubUser | undefined> {
  const folder = process.env[MACHINE_GITHUB_ENV]
  if (!folder) return undefined
  try {
    const value: JsonValue = JSON.parse(await readFile(join(folder, "access.json"), "utf8"))
    const user = isJsonObject(value) ? objectValue(value.user) : undefined
    const login = stringValue(user?.login)
    const id = stringValue(user?.id)
    return login ? { login, id: id && /^\d+$/.test(id) ? id : undefined } : undefined
  } catch {
    return undefined
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

  const who = (await machineUser()) ?? (await ghJson(
    cwd,
    ["api", "user"],
    parseGitHubUser
  ))
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
    userId: who?.id,
    repo: repo?.nameWithOwner,
    defaultBranch: repo?.defaultBranch,
  }
}

interface RawCheck {
  name?: string
  /** The workflow its run is a job of: two workflows may name a job alike. */
  workflowName?: string
  context?: string
  state?: string
  conclusion?: string
  status?: string
  detailsUrl?: string
  targetUrl?: string
  completedAt?: string
  startedAt?: string
}

interface RawReview {
  state?: string
  author?: GitHubUser
  submittedAt?: string
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
    workflowName: stringValue(value.workflowName),
    context: stringValue(value.context),
    state: stringValue(value.state),
    conclusion: stringValue(value.conclusion),
    status: stringValue(value.status),
    detailsUrl: stringValue(value.detailsUrl),
    targetUrl: stringValue(value.targetUrl),
    completedAt: stringValue(value.completedAt),
    startedAt: stringValue(value.startedAt),
  }
}

function parseRawReview(value: JsonValue): RawReview | null {
  if (!isJsonObject(value)) return null
  const author =
    value.author === undefined ? undefined : parseGitHubUser(value.author)
  return {
    state: stringValue(value.state),
    author: author ?? undefined,
    submittedAt: stringValue(value.submittedAt),
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
/**
 * A check's runs less those cancelled because another replaced them: a push twice or a retarget runs the same head
 * again and GitHub cancels the older run, which failed nothing. A cancelled run goes when another run of the same check
 * (its workflow and name) didn't end cancelled, or when a later cancelled one did; a lone cancelled run stays, and says
 * so (`toCheck`). Every other run stays as GitHub lists it: gh's rollup doesn't say which event started a run, so a
 * workflow run on both push and pull_request reads as two runs of one check, and neither's outcome may hide the other's.
 */
export function withoutSuperseded<Check extends { name?: string; workflowName?: string; context?: string; conclusion?: string; startedAt?: string; completedAt?: string }>(checks: readonly Check[]): Check[] {
  const key = (check: Check) => `${check.workflowName ?? ""}\0${check.name ?? check.context ?? ""}`
  const cancelled = (check: Check) => check.conclusion?.toUpperCase() === "CANCELLED"
  const at = (check: Check) => timeOf(check.startedAt ?? check.completedAt) ?? Number.NEGATIVE_INFINITY
  const groups = new Map<string, Check[]>()
  for (const check of checks) groups.set(key(check), [...(groups.get(key(check)) ?? []), check])
  const kept = new Set<Check>()
  for (const runs of groups.values()) {
    const others = runs.filter((run) => !cancelled(run))
    // Of cancelled runs alone, the latest started (a tie, the one listed later) says the check's cancelled.
    const latest = runs.reduce<Check | undefined>((held, run) => (cancelled(run) && (!held || at(run) >= at(held)) ? run : held), undefined)
    for (const run of others.length ? others : latest ? [latest] : []) kept.add(run)
  }
  return checks.filter((check) => kept.has(check))
}

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
  if (verdict === "FAILURE" || verdict === "ERROR" || verdict === "TIMED_OUT") {
    return { name, state: "failed", url }
  }
  // A cancelled run nothing replaced (`withoutSuperseded` drops one that was): it didn't fail, and didn't pass.
  if (verdict === "CANCELLED") return { name, state: "cancelled", url }
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
    checks: withoutSuperseded(raw.statusCheckRollup ?? []).map(toCheck),
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

/** Runs `gh` with arguments in a folder and returns what it printed; a test hands in its own. */
export type GitHubRunner = (cwd: string, args: string[]) => Promise<string>

/** `gh api`, for what this file has no reading of its own. */
export function githubApi(cwd: string, path: string): Promise<string> {
  return gh(cwd, ["api", path])
}

/** A pull request a Fin waits on, as the watch asks for it: by repository and number, or by number in the Fin's folder. */
export interface PullTarget {
  repository?: string
  number: number
  cwd: string
}

const READING_FIELDS = "state,url,headRefOid,author,statusCheckRollup,latestReviews"

function timeOf(text: string | undefined): number | undefined {
  const at = text ? Date.parse(text) : Number.NaN
  return Number.isFinite(at) ? at : undefined
}

/**
 * One pull request's state, checks and reviews for the watch (`PullReading`), with the same `gh pr view` and the same
 * normalising of checks and reviews `pull_request_status` reads with. Null when `gh` can't say.
 */
export async function readPull(target: PullTarget, runner: GitHubRunner = gh): Promise<PullReading | null> {
  const args = ["pr", "view", String(target.number), ...(target.repository ? ["--repo", target.repository] : []), "--json", READING_FIELDS]
  let value: JsonValue
  try {
    value = JSON.parse(await runner(target.cwd, args))
  } catch {
    return null
  }
  if (!isJsonObject(value)) return null
  const state = stringValue(value.state)
  const url = stringValue(value.url)
  if (!state || !url) return null
  const checks = withoutSuperseded(parseJsonArray(value.statusCheckRollup, parseRawCheck) ?? [])
  const reviews = parseJsonArray(value.latestReviews, parseRawReview) ?? []
  const author = parseOptionalUser(value.author)?.login
  const head = stringValue(value.headRefOid)
  return {
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    url,
    ...(head && /^[a-f0-9]{40,64}$/.test(head) && { head }),
    ...(author && { author }),
    checks: checks.map((raw) => {
      const check = toCheck(raw)
      const at = timeOf(raw.completedAt ?? raw.startedAt)
      return { name: check.name, state: check.state, ...(at !== undefined && { at }) }
    }),
    reviews: reviews.map((raw) => {
      const at = timeOf(raw.submittedAt)
      return { ...toReviews([raw])[0]!, ...(at !== undefined && { at }) }
    }),
  }
}

/** What `PullRequestSearch` asks GitHub: the folder's repository, a search of its pull requests, and one by number. */
export interface PullRequestSource {
  /** `owner/name` of the repository `gh` resolves in the folder, null when it names none. Throws `gh`'s own words when it can't answer. */
  repository(cwd: string): Promise<string | null>
  /** Pull requests in every state matching a GitHub search, in its order. Throws `gh`'s own words when it can't answer. */
  search(cwd: string, repository: string, search: string, limit: number): Promise<PullRequestListing[]>
  /** One pull request by number; null when there is none or `gh` can't say. */
  view(cwd: string, repository: string, number: number): Promise<PullRequestListing | null>
}

const LISTING_FIELDS = "number,title,state,isDraft,url,headRefName,baseRefName,author,createdAt,updatedAt"

function toListing(raw: RawPull): PullRequestListing {
  const { number, title, state, draft, url, head, base, author, updatedAt } = toPull(raw)
  return { number, title, state, draft, url, head, base, author, updatedAt }
}

/** Pull requests by search and by number through `gh`, or through `runner` in a test. */
export function githubPullSource(runner: GitHubRunner = gh): PullRequestSource {
  const json = async (cwd: string, args: string[]): Promise<JsonValue> => {
    const stdout = await runner(cwd, args).catch((cause) => { throw ghFailure(cause) })
    return JSON.parse(stdout)
  }
  return {
    async repository(cwd) {
      const repository = parseGitHubRepository(await json(cwd, ["repo", "view", "--json", "nameWithOwner"]))
      return repository?.nameWithOwner ?? null
    },
    async search(cwd, repository, search, limit) {
      const pulls = parseRawPullList(await json(cwd, ["pr", "list", "--repo", repository, "--state", "all", "--limit", String(limit), "--search", search, "--json", LISTING_FIELDS]))
      if (!pulls) throw new Error("GitHub answered the pull request search with something other than a list")
      return pulls.map(toListing)
    },
    async view(cwd, repository, number) {
      try {
        const raw = parseRawPull(await json(cwd, ["pr", "view", String(number), "--repo", repository, "--json", LISTING_FIELDS]))
        return raw ? toListing(raw) : null
      } catch {
        return null
      }
    },
  }
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
export async function listBranchPulls(cwd: string, liveHeads: readonly string[] = []): Promise<WorktreeBranchPull[] | null> {
  const listed = await ghJson(
    cwd,
    ["pr", "list", "--state", "all", "--limit", "60", "--json", "number,title,url,headRefName,headRefOid,state,isDraft"],
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
        const checks = withoutSuperseded(parseJsonArray(entry.statusCheckRollup, parseRawCheck) ?? []).map(toCheck)
        pulls.push({
          number,
          title,
          url,
          branch,
          head,
          state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : booleanValue(entry.isDraft) ? "draft" : "open",
          checks: checks.length === 0
            ? null
            // A lone cancelled check didn't pass either: the list's mark has no word of its own for it.
            : checks.some((check) => check.state === "failed" || check.state === "cancelled")
              ? "failed"
              : checks.some((check) => check.state === "running")
                ? "running"
                : "passed",
        })
      }
      return pulls
    }
  )
  if (!listed) return null
  const live = new Set(liveHeads)
  return Promise.all(listed.map(async pull => {
    if (!live.has(pull.head)) return pull
    const reading = await ghJson(cwd, ["pr", "view", String(pull.number), "--json", "headRefOid,statusCheckRollup"], value => {
      if (!isJsonObject(value)) return null
      const head = stringValue(value.headRefOid)
      const checks = withoutSuperseded(parseJsonArray(value.statusCheckRollup, parseRawCheck) ?? []).map(toCheck)
      return { head, checks }
    })
    if (!reading || reading.head !== pull.head) return { ...pull, checks: null }
    const checks = reading.checks
    return { ...pull, checks: checks.length === 0 ? null : checks.some(check => check.state === "failed" || check.state === "cancelled") ? "failed" as const : checks.some(check => check.state === "running") ? "running" as const : "passed" as const }
  }))
}

export async function listRemoteBranches(git: Git, cwd: string): Promise<string[]> {
  const stdout = await git.text({ cwd, args: ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], read: true, timeoutMs: TIMEOUT, maxBytes: MAX_BUFFER })
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
  /** On a cloud machine whose person opens pull requests as themselves: open this one as Mako's App, as they chose. */
  as?: "app"
}

/** A `gh` failure in its own words: what it printed on stderr, not Node's "Command failed" line. */
function ghFailure(cause: unknown): Error {
  const stderr = cause instanceof Error && "stderr" in cause ? String(cause.stderr ?? "").trim() : ""
  return new Error(stderr || parseProcessFailure(cause).message, { cause })
}

/** Open a pull request for the pushed branch; the push and the rules are `pull-requests.ts`'s. */
export async function createPull(cwd: string, options: CreatePullOptions, env?: Readonly<Record<string, string>>): Promise<void> {
  const args = ["pr", "create", "--title", options.title, "--body", options.body]
  if (options.base) args.push("--base", options.base)
  if (options.draft) args.push("--draft")
  await gh(cwd, args, env).catch((cause) => { throw ghFailure(cause) })
}

export async function editPull(cwd: string, number: number, edit: { title?: string; body?: string }, env?: Readonly<Record<string, string>>): Promise<void> {
  const args = ["pr", "edit", String(number)]
  if (edit.title !== undefined) args.push("--title", edit.title)
  if (edit.body !== undefined) args.push("--body", edit.body)
  await gh(cwd, args, env).catch((cause) => { throw ghFailure(cause) })
}

export async function mergePull(cwd: string, number: number, method: MergeMethod, env?: Readonly<Record<string, string>>): Promise<void> {
  await gh(cwd, ["pr", "merge", String(number), `--${method}`], env).catch((cause) => { throw ghFailure(cause) })
}

/** The ways the repository lets a pull request merge, in the order Mako offers them. */
export async function mergeMethods(cwd: string): Promise<MergeMethod[] | null> {
  return ghJson(cwd, ["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"], (value) => {
    if (!isJsonObject(value)) return null
    const allowed = { squash: value.squashMergeAllowed, merge: value.mergeCommitAllowed, rebase: value.rebaseMergeAllowed }
    return MERGE_METHODS.filter((method) => allowed[method] !== false)
  })
}

/** A GitHub Actions run that failed on a commit. */
export interface FailedRun {
  id: number
  workflow: string
  url: string
}

/** The GitHub Actions runs on the branch whose head is `commit` and that failed, newest first. */
export async function failedRuns(cwd: string, branch: string, commit: string): Promise<FailedRun[]> {
  const runs = await ghJson(cwd, ["run", "list", "--branch", branch, "--limit", "30", "--json", "databaseId,headSha,conclusion,workflowName,url"], (value) => {
    if (!Array.isArray(value)) return null
    const runs = value.filter(isJsonObject).filter((entry) => stringValue(entry.headSha) === commit)
    // A run cancelled because another of its workflow ran this commit again failed nothing: its checks say so too
    // (`withoutSuperseded`). gh lists runs newest first, so of cancelled runs alone the first is the latest.
    const replaced = (entry: JsonObject, index: number) =>
      stringValue(entry.conclusion) === "cancelled" &&
      runs.some((other, at) => other !== entry && stringValue(other.workflowName) === stringValue(entry.workflowName) && (stringValue(other.conclusion) !== "cancelled" || at < index))
    const failed: FailedRun[] = []
    runs.forEach((entry, index) => {
      const conclusion = stringValue(entry.conclusion)
      const id = numberValue(entry.databaseId)
      if (id === undefined || !conclusion || !["failure", "timed_out", "cancelled", "startup_failure"].includes(conclusion) || replaced(entry, index)) return
      failed.push({ id, workflow: stringValue(entry.workflowName) ?? "workflow", url: stringValue(entry.url) ?? "" })
    })
    return failed
  })
  return runs ?? []
}

/** What a failed run's failed steps printed, as `job  step  line`; the last `lines` only. */
export async function failedRunLog(cwd: string, id: number, lines: number): Promise<string> {
  const log = await gh(cwd, ["run", "view", String(id), "--log-failed"]).catch((cause) => { throw ghFailure(cause) })
  // Each line is "job\tstep\ttimestamp text"; the timestamp says nothing a reader needs.
  const rows = log.split("\n").filter(Boolean).map((line) => line.replace(/\t\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z /, "\t"))
  return rows.slice(-lines).join("\n")
}

/** A review comment thread nobody resolved, on code the branch still has. */
export interface ReviewThread {
  path: string
  line: number | null
  comments: { author: string; body: string }[]
}

const REVIEW_THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes { isResolved isOutdated path line comments(first: 5) { nodes { author { login } body } } }
      }
    }
  }
}`

export async function openReviewThreads(cwd: string, repo: string, number: number): Promise<ReviewThread[] | null> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) return null
  return ghJson(cwd, ["api", "graphql", "-f", `query=${REVIEW_THREADS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], (value) => {
    const pull = objectValue(objectValue(objectValue(isJsonObject(value) ? value.data : undefined)?.repository)?.pullRequest)
    const nodes = objectValue(pull?.reviewThreads)?.nodes
    if (!Array.isArray(nodes)) return null
    const threads: ReviewThread[] = []
    for (const node of nodes) {
      if (!isJsonObject(node) || node.isResolved === true || node.isOutdated === true) continue
      const comments = objectValue(node.comments)?.nodes
      threads.push({
        path: stringValue(node.path) ?? "",
        line: numberValue(node.line) ?? null,
        comments: (Array.isArray(comments) ? comments : []).filter(isJsonObject).map((comment) => ({
          author: stringValue(objectValue(comment.author)?.login) ?? "someone",
          body: stringValue(comment.body) ?? "",
        })),
      })
    }
    return threads
  })
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
  repo: string,
  dir: string
): Promise<string | undefined> {
  const owner = repo.split("/")[0]
  if (!owner) return undefined

  const file = join(dir, `${owner.replace(/[^\w.-]/g, "-")}.png`)
  try {
    return `data:image/png;base64,${(await readFile(file)).toString("base64")}`
  } catch {
    // Not cached yet.
  }

  try {
    const url = await ghJson(cwd, ["api", `repos/${repo}`], value => isJsonObject(value) ? stringValue(objectValue(value.owner)?.avatar_url) ?? null : null)
    if (!url) return undefined
    if (!url.startsWith("https://")) return undefined
    const response = await hostFetch(`${url}${url.includes("?") ? "&" : "?"}s=128`)
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
export async function userAvatar(cwd: string, dir: string): Promise<string | undefined> {
  try {
    const login = await ghJson(cwd, ["api", "user"], value => isJsonObject(value) ? stringValue(value.login) ?? null : null)
    if (!login) return undefined
    const file = join(dir, `user-${login.replace(/[^\w.-]/g, "-")}.png`)
    try {
      return `data:image/png;base64,${(await readFile(file)).toString("base64")}`
    } catch {
      // Not cached yet.
    }
    const url = await ghJson(cwd, ["api", "user"], value => isJsonObject(value) ? stringValue(value.avatar_url) ?? null : null)
    if (!url) return undefined
    if (!url.startsWith("https://")) return undefined
    const response = await hostFetch(`${url}${url.includes("?") ? "&" : "?"}s=128`)
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

/** Re-run a run's failed jobs. `gh run rerun` needs the run named when no terminal can ask which. */
export async function rerunFailedJobs(cwd: string, id: number): Promise<void> {
  await gh(cwd, ["run", "rerun", String(id), "--failed"]).catch((cause) => { throw ghFailure(cause) })
}

