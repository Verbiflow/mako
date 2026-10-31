import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { clipTemplate, MERGE_METHODS, pullBaseFor, pullMergeReason, pullSetupReason, type MergeMethod } from "../contracts/git-actions.js"
import type { PullRequest } from "../contracts/git-workspace-search.js"
import {
  createPull,
  editPull,
  failedRunLog,
  failedRuns,
  githubStatus,
  listRemoteBranches,
  mergeMethods,
  mergePull,
  openReviewThreads,
  pullForBranch,
  rerunFailedJobs,
  type ReviewThread,
} from "./github.js"
import { GitError, type Git } from "@mako/git"
import { authorWords, personTokenRefusal, type GitHubPerson, type PersonTokenProblem, type PullRequestAuthor } from "../contracts/github-person.js"
import { MACHINE_GITHUB_AS } from "../contracts/machine-agent.js"

/*
 * A branch's pull request as the Git sidebar's buttons and the agent's
 * `pull_request_*` tools both work it: one set of rules for its base, the
 * push before it, what's in the way and how it merges.
 */

const LOG_LINES = 80
const LOG_RUNS = 3
const COMMITS_LISTED = 30
const COMMENT_CHARS = 600

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

export interface PullRequestDraft {
  title?: string
  body?: string
  base?: string
  draft?: boolean
  /** On a cloud machine whose person opens pull requests as themselves: open this one as Mako's App, as they chose. */
  as?: "app"
}

/**
 * On a cloud machine: whether its pull requests go as its person (`github-person.ts`), asked of the account before
 * each; undefined on a Mac, where `gh`'s own sign-in is the person already.
 */
export type PersonOf = () => Promise<GitHubPerson | undefined>

/** A pull request that couldn't go as its person: refused before anything else was pushed, never sent as the App instead. */
export class PersonTokenError extends Error {
  readonly problem: PersonTokenProblem

  constructor(problem: PersonTokenProblem, options?: ErrorOptions) {
    super(personTokenRefusal(problem), options)
    this.name = "PersonTokenError"
    this.problem = problem
  }
}

/** Who an action goes as, and the environment that makes Git and `gh` go so: the person, or the App when they're off or chose it. */
type Acting = { author: PullRequestAuthor; env?: Record<string, string>; expiresAt: string | null } | undefined

async function actingAs(personOf: PersonOf | undefined, asApp: boolean, repository: string | undefined, now = Date.now()): Promise<Acting> {
  const person = await personOf?.()
  if (!person) return undefined
  if (person.state === "off") return { author: { as: "app", chosen: false }, expiresAt: null }
  if (asApp) return { author: { as: "app", chosen: true }, env: { [MACHINE_GITHUB_AS]: "app" }, expiresAt: null }
  if (person.state === "unusable" || person.state === "unknown") throw new PersonTokenError({ reason: person.state, said: person.problem, ...repository && { repository } })
  if (person.expiresAt && Date.parse(person.expiresAt) <= now) throw new PersonTokenError({ reason: "expired", login: person.login, expiredAt: person.expiresAt, ...repository && { repository } })
  return { author: { as: "person", login: person.login }, expiresAt: person.expiresAt }
}

/** GitHub refusing the person's token, as Git or `gh` said it: revoked or lapsed, or short of what this repository needs. */
const TOKEN_REFUSED = /HTTP 401|Bad credentials|Authentication failed|Invalid username or (password|token)/i
const TOKEN_SHORT = /HTTP 40[34]|Resource not accessible|Permission to .* denied|returned error: 403|Could not resolve to a Repository|Repository not found|must have (push|write) access/i

/** A failure of a write that went as the person, as the problem it is when GitHub refused their token; undefined for any other. */
function personProblemOf(error: Error, acting: Acting, repository: string | undefined): PersonTokenError | undefined {
  if (acting?.author.as !== "person") return undefined
  const said = error instanceof GitError ? error.stderr || error.message : error.message
  const where = repository ? { repository } : {}
  // Git's helper or `gh` on the machine found the token gone between the ask and the write: still never the App.
  if (/Mako didn't (push|change the pull request)/.test(said)) return new PersonTokenError({ reason: "unusable", login: acting.author.login, said: "Your GitHub token was removed from this machine just now.", ...where }, { cause: error })
  if (TOKEN_REFUSED.test(said)) {
    const lapsed = acting.expiresAt !== null && Date.parse(acting.expiresAt) <= Date.now()
    return new PersonTokenError(lapsed ? { reason: "expired", login: acting.author.login, expiredAt: acting.expiresAt!, ...where } : { reason: "refused", login: acting.author.login, ...where }, { cause: error })
  }
  if (TOKEN_SHORT.test(said) || (error instanceof GitError && error.kind === "auth")) return new PersonTokenError({ reason: "no-access", login: acting.author.login, ...where }, { cause: error })
  return undefined
}

export interface PullRequestOpened {
  pull: PullRequest
  /** On a cloud machine, who it went as; undefined on a Mac. */
  author?: PullRequestAuthor
  /** False when it was open already and was brought up to date. */
  opened: boolean
  /** Commits the push sent. */
  pushed: number
  edited: boolean
  /** Files with uncommitted changes, which the push didn't carry. */
  uncommitted: number
}

async function branchOf(git: Git, cwd: string): Promise<string> {
  return git.output(cwd, ["branch", "--show-current"]).catch(() => "")
}

async function uncommitted(git: Git, cwd: string): Promise<number> {
  const status = await git.output(cwd, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => "")
  return status ? status.split("\n").length : 0
}

/**
 * The branch's own copy on origin, `origin/<branch>`, once pushed; empty
 * before. Not its upstream: a branch made from `origin/main` may track that,
 * and its pull request's head is the branch of its own name.
 */
async function pushedRef(git: Git, cwd: string, branch: string): Promise<string> {
  const ref = `refs/remotes/origin/${branch}`
  return (await git.succeeds(cwd, ["rev-parse", "--verify", "--quiet", ref])) ? ref : ""
}

async function count(git: Git, cwd: string, range: string): Promise<number | null> {
  return git.output(cwd, ["rev-list", "--count", range]).then(Number, () => null)
}

async function ready(cwd: string) {
  const status = await githubStatus(cwd)
  const reason = pullSetupReason(status)
  if (reason) throw new Error(reason)
  return status
}

/** The branch's pull request while it's open; a merged or closed one doesn't count. */
async function openPull(cwd: string): Promise<PullRequest | null> {
  const pull = await pullForBranch(cwd)
  return pull?.state === "open" ? pull : null
}

const TEMPLATE_NAMES = ["pull_request_template.md", "pull_request_template.txt"]

/** The repository's pull request template, from `.github`, `docs` or the root, in any case; the first of a folder of them. */
export async function pullTemplate(git: Git, cwd: string): Promise<string | null> {
  const root = await git.output(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")
  if (!root) return null
  for (const folder of [".github", "", "docs"]) {
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => [])
    const file = entries.find((entry) => entry.isFile() && TEMPLATE_NAMES.includes(entry.name.toLowerCase()))
    if (file) return readFile(join(root, folder, file.name), "utf8").then((text) => clipTemplate(text.trim()), () => null)
    const many = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "pull_request_template")
    if (many) {
      const inside = (await readdir(join(root, folder, many.name)).catch(() => [])).filter((name) => /\.(md|txt)$/i.test(name)).sort()
      if (inside[0]) return readFile(join(root, folder, many.name, inside[0]), "utf8").then((text) => clipTemplate(text.trim()), () => null)
    }
  }
  return null
}

/** The base a new pull request for this checkout targets, by the shared rule. */
async function baseFor(git: Git, cwd: string, branch: string, startedFrom: string | null | undefined, defaultBranch: string | undefined) {
  const remote = await listRemoteBranches(git, cwd).catch(() => [])
  return pullBaseFor(branch, startedFrom, remote, defaultBranch)
}

/** Why a new pull request from `branch` into `base` can't open, or null. */
async function openingBlocker(git: Git, cwd: string, branch: string, base: string | undefined, defaultBranch: string | undefined): Promise<string | null> {
  if (!base) return `${branch} is the repository's default branch. Pull requests come from another branch: put this work on its own branch first.`
  if (base === branch) return `A pull request can't merge ${branch} into itself. Pick another base.`
  if (branch === defaultBranch) return `${branch} is the repository's default branch. Pull requests come from another branch: put this work on its own branch first.`
  const ahead = await count(git, cwd, `refs/remotes/origin/${base}..HEAD`)
  if (ahead === 0) return `${branch} has no commits that ${base} doesn't. Commit the work first.`
  return null
}

/** Push the branch to its own name on origin, never forcing; a rejection says what to do instead. */
async function push(git: Git, cwd: string, branch: string, acting: Acting, repository: string | undefined): Promise<void> {
  try {
    await git.run({ cwd, args: ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], ...acting?.env && { env: acting.env } })
  } catch (raw) {
    const problem = raw instanceof Error ? personProblemOf(raw, acting, repository) : undefined
    if (problem) throw problem
    const message = raw instanceof Error ? raw.message : String(raw)
    if (/rejected|non-fast-forward|fetch first/i.test(message))
      throw new Error(`origin/${branch} has commits this branch doesn't. Pull them in first (git pull --no-rebase origin ${branch}), then try again. Mako never force-pushes.`, { cause: raw })
    throw new Error(`Git couldn't push ${branch}: ${message}`, { cause: raw })
  }
}

/**
 * Push the branch and open its pull request, or bring the open one up to
 * date: push its new commits and, given a title or body, edit them. The base
 * is `draft.base`, else the shared rule.
 */
export async function openPullRequest(git: Git, cwd: string, draft: PullRequestDraft, startedFrom?: string | null, personOf?: PersonOf): Promise<PullRequestOpened> {
  const status = await ready(cwd)
  const branch = await branchOf(git, cwd)
  if (!branch) throw new Error("This checkout isn't on a branch. Check one out or create one first.")
  // Who it goes as is settled before anything is pushed: a person whose token can't be used is told so, never pushed as the App.
  const acting = await actingAs(personOf, draft.as === "app", status.repo)
  const author = acting && { author: acting.author }
  const writing = <T>(work: Promise<T>) => work.catch((error: Error) => { throw personProblemOf(error, acting, status.repo) ?? error })
  const [existing, remote, left] = await Promise.all([openPull(cwd), pushedRef(git, cwd, branch), uncommitted(git, cwd)])
  if (existing) {
    const pushed = remote ? (await count(git, cwd, `${remote}..HEAD`)) ?? 0 : 0
    await push(git, cwd, branch, acting, status.repo)
    const edit = { title: draft.title?.trim() || undefined, body: draft.body === undefined ? undefined : draft.body.trim() }
    const edited = edit.title !== undefined || edit.body !== undefined
    if (edited) await writing(editPull(cwd, existing.number, edit, acting?.env))
    return { pull: (await pullForBranch(cwd)) ?? existing, opened: false, pushed, edited, uncommitted: left, ...author }
  }
  const title = draft.title?.trim()
  if (!title) throw new Error("A new pull request needs a title.")
  const base = draft.base?.trim() || await baseFor(git, cwd, branch, startedFrom, status.defaultBranch)
  const blocked = await openingBlocker(git, cwd, branch, base, status.defaultBranch)
  if (blocked) throw new Error(blocked)
  const pushed = (await count(git, cwd, `${remote || `refs/remotes/origin/${base}`}..HEAD`)) ?? 0
  await push(git, cwd, branch, acting, status.repo)
  await writing(createPull(cwd, { title, body: draft.body?.trim() ?? "", base, draft: draft.draft }, acting?.env))
  const pull = await pullForBranch(cwd)
  if (!pull) throw new Error("GitHub opened the pull request but didn't return it. Read it with gh pr view.")
  return { pull, opened: true, pushed, edited: false, uncommitted: left, ...author }
}

/**
 * Merge the branch's open pull request on GitHub, only when the shared guard allows, with a method the repository
 * allows. On a cloud machine it goes as the person while they open pull requests as themselves, as opening does.
 */
export async function mergePullRequest(cwd: string, method?: MergeMethod, personOf?: PersonOf, asApp = false): Promise<{ pull: PullRequest; method: MergeMethod; author?: PullRequestAuthor }> {
  const status = await ready(cwd)
  const acting = await actingAs(personOf, asApp, status.repo)
  const pull = await openPull(cwd)
  if (!pull) throw new Error("This branch has no open pull request.")
  const reason = pullMergeReason(pull)
  if (reason) throw new Error(`#${pull.number} can't merge yet. ${reason}.`)
  const allowed = (await mergeMethods(cwd)) ?? [...MERGE_METHODS]
  const chosen = method ?? allowed[0]
  if (!chosen) throw new Error("This repository allows no merge method.")
  if (!allowed.includes(chosen)) throw new Error(`This repository doesn't allow ${chosen} merges. It allows: ${allowed.join(", ")}.`)
  await mergePull(cwd, pull.number, chosen, acting?.env).catch((error: Error) => { throw personProblemOf(error, acting, status.repo) ?? error })
  return { pull: (await pullForBranch(cwd)) ?? pull, method: chosen, ...acting && { author: acting.author } }
}

/** The commit GitHub has for the branch: its copy on origin's, else `HEAD`. */
async function pushedCommit(git: Git, cwd: string, branch: string): Promise<string> {
  return git.output(cwd, ["rev-parse", (await pushedRef(git, cwd, branch)) || "HEAD"])
}

/** Re-run the failed jobs of every GitHub Actions run that failed on the branch's pushed commit; how many runs. */
export async function rerunFailedChecks(git: Git, cwd: string): Promise<number> {
  const branch = await branchOf(git, cwd)
  if (!branch) throw new Error("This checkout isn't on a branch.")
  const runs = await failedRuns(cwd, branch, await pushedCommit(git, cwd, branch))
  for (const run of runs) await rerunFailedJobs(cwd, run.id)
  return runs.length
}

export interface PullRequestReport {
  branch: string | null
  /** Why GitHub can't be used here. */
  github?: string
  uncommittedFiles: number
  pullRequest?: {
    number: number
    title: string
    url: string
    state: "open" | "draft"
    base: string
    unpushedCommits?: number
    checks: { name: string; state: string; url?: string }[] | "none reported"
    review: PullRequest["reviewDecision"]
    reviews?: string[]
    mergeable: PullRequest["mergeable"]
    merge: string
    reviewComments?: { at: string; comments: string[] }[]
    failedLogs?: { workflow: string; url: string; log: string }[] | string
  }
  /** With no pull request open: what opening one would do, or what's in the way. */
  opening?: {
    base: string | null
    commits: string[]
    moreCommits?: number
    blocked?: string
    template: string | null
  }
  lastPullRequest?: { number: number; state: "merged" | "closed"; url: string }
}

function threadLines(threads: ReviewThread[]) {
  return threads.slice(0, 20).map((thread) => ({
    at: thread.line === null ? thread.path : `${thread.path}:${thread.line}`,
    comments: thread.comments.map(({ author, body }) => `${author}: ${body.length > COMMENT_CHARS ? `${body.slice(0, COMMENT_CHARS)}…` : body}`),
  }))
}

/** The branch's pull request with its checks, reviews and unresolved comments; with none open, what opening one would carry. */
export async function pullRequestReport(git: Git, cwd: string, options: { startedFrom?: string | null; logs?: boolean } = {}): Promise<PullRequestReport> {
  const [status, branch, left] = await Promise.all([githubStatus(cwd), branchOf(git, cwd), uncommitted(git, cwd)])
  const report: PullRequestReport = { branch: branch || null, uncommittedFiles: left }
  const reason = pullSetupReason(status)
  if (reason) return { ...report, github: reason }
  if (!branch) return report
  const pull = await pullForBranch(cwd)
  if (pull?.state === "open") {
    const [remote, threads] = await Promise.all([pushedRef(git, cwd, branch), status.repo ? openReviewThreads(cwd, status.repo, pull.number) : null])
    const unpushed = remote ? await count(git, cwd, `${remote}..HEAD`) : null
    const view: NonNullable<PullRequestReport["pullRequest"]> = {
      number: pull.number,
      title: pull.title,
      url: pull.url,
      state: pull.draft ? "draft" : "open",
      base: pull.base,
      checks: pull.checks.length ? pull.checks.map(({ name, state, url }) => (url ? { name, state, url } : { name, state })) : "none reported",
      review: pull.reviewDecision,
      mergeable: pull.mergeable,
      merge: pullMergeReason(pull) ?? "GitHub would merge it now. Merge only when the user asks.",
    }
    if (unpushed) view.unpushedCommits = unpushed
    if (pull.reviews.length) view.reviews = pull.reviews.map((review) => `${review.login}: ${review.state}`)
    if (threads?.length) view.reviewComments = threadLines(threads)
    if (options.logs) view.failedLogs = await failedLogs(git, cwd, branch)
    return { ...report, pullRequest: view }
  }
  if (pull) report.lastPullRequest = { number: pull.number, state: pull.state === "merged" ? "merged" : "closed", url: pull.url }
  const base = await baseFor(git, cwd, branch, options.startedFrom, status.defaultBranch)
  const [subjects, blocked, template] = await Promise.all([
    base ? git.output(cwd, ["log", "--format=%h %s", `refs/remotes/origin/${base}..HEAD`]).catch(() => "") : Promise.resolve(""),
    openingBlocker(git, cwd, branch, base, status.defaultBranch),
    pullTemplate(git, cwd),
  ])
  const commits = subjects ? subjects.split("\n") : []
  report.opening = { base: base ?? null, commits: commits.slice(0, COMMITS_LISTED), template }
  if (commits.length > COMMITS_LISTED) report.opening.moreCommits = commits.length - COMMITS_LISTED
  if (blocked) report.opening.blocked = blocked
  return report
}

async function failedLogs(git: Git, cwd: string, branch: string): Promise<NonNullable<PullRequestReport["pullRequest"]>["failedLogs"]> {
  const runs = await failedRuns(cwd, branch, await pushedCommit(git, cwd, branch))
  if (!runs.length) return "No GitHub Actions run failed on the pushed commit. A failing check from another service has its link in checks."
  return Promise.all(runs.slice(0, LOG_RUNS).map(async (run) => ({
    workflow: run.workflow,
    url: run.url,
    log: await failedRunLog(cwd, run.id, LOG_LINES).catch((error) => `Couldn't read its log: ${error instanceof Error ? error.message : String(error)}`),
  })))
}

/** One line for what opening or updating did, as the agent and a toast both say it. */
export function openedSentence({ pull, opened, pushed, edited, author }: PullRequestOpened): string {
  const as = author ? ` ${authorWords(author)}` : ""
  if (opened) return `Opened #${pull.number}${pull.draft ? " as a draft" : ""} into ${pull.base}${as}: ${pull.url}`
  const parts = [pushed ? `pushed ${plural(pushed, "commit")}` : "nothing new to push", edited ? "updated its title and body" : null].filter(Boolean)
  return `#${pull.number} was already open; ${parts.join(" and ")}${as}: ${pull.url}`
}
