import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { clipTemplate, MERGE_METHODS, pullBaseFor, pullMergeReason, pullSetupReason, type MergeMethod } from "./contracts/git-actions.js"
import type { PullRequest } from "./contracts/git-workspace-search.js"
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
import { git, succeeds } from "@mako/git"

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
}

export interface PullRequestOpened {
  pull: PullRequest
  /** False when it was open already and was brought up to date. */
  opened: boolean
  /** Commits the push sent. */
  pushed: number
  edited: boolean
  /** Files with uncommitted changes, which the push didn't carry. */
  uncommitted: number
}

async function branchOf(cwd: string): Promise<string> {
  return git(cwd, ["branch", "--show-current"]).catch(() => "")
}

async function uncommitted(cwd: string): Promise<number> {
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => "")
  return status ? status.split("\n").length : 0
}

/**
 * The branch's own copy on origin, `origin/<branch>`, once pushed; empty
 * before. Not its upstream: a branch made from `origin/main` may track that,
 * and its pull request's head is the branch of its own name.
 */
async function pushedRef(cwd: string, branch: string): Promise<string> {
  const ref = `refs/remotes/origin/${branch}`
  return (await succeeds(cwd, ["rev-parse", "--verify", "--quiet", ref])) ? ref : ""
}

async function count(cwd: string, range: string): Promise<number | null> {
  return git(cwd, ["rev-list", "--count", range]).then(Number, () => null)
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
export async function pullTemplate(cwd: string): Promise<string | null> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")
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
async function baseFor(cwd: string, branch: string, startedFrom: string | null | undefined, defaultBranch: string | undefined) {
  const remote = await listRemoteBranches(cwd).catch(() => [])
  return pullBaseFor(branch, startedFrom, remote, defaultBranch)
}

/** Why a new pull request from `branch` into `base` can't open, or null. */
async function openingBlocker(cwd: string, branch: string, base: string | undefined, defaultBranch: string | undefined): Promise<string | null> {
  if (!base) return `${branch} is the repository's default branch. Pull requests come from another branch: put this work on its own branch first.`
  if (base === branch) return `A pull request can't merge ${branch} into itself. Pick another base.`
  if (branch === defaultBranch) return `${branch} is the repository's default branch. Pull requests come from another branch: put this work on its own branch first.`
  const ahead = await count(cwd, `refs/remotes/origin/${base}..HEAD`)
  if (ahead === 0) return `${branch} has no commits that ${base} doesn't. Commit the work first.`
  return null
}

/** Push the branch to its own name on origin, never forcing; a rejection says what to do instead. */
async function push(cwd: string, branch: string): Promise<void> {
  try {
    await git(cwd, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/rejected|non-fast-forward|fetch first/i.test(message))
      throw new Error(`origin/${branch} has commits this branch doesn't. Pull them in first (git pull --no-rebase origin ${branch}), then try again. Mako never force-pushes.`, { cause: error })
    throw new Error(`Git couldn't push ${branch}: ${message}`, { cause: error })
  }
}

/**
 * Push the branch and open its pull request, or bring the open one up to
 * date: push its new commits and, given a title or body, edit them. The base
 * is `draft.base`, else the shared rule.
 */
export async function openPullRequest(cwd: string, draft: PullRequestDraft, startedFrom?: string | null): Promise<PullRequestOpened> {
  const status = await ready(cwd)
  const branch = await branchOf(cwd)
  if (!branch) throw new Error("This checkout isn't on a branch. Check one out or create one first.")
  const [existing, remote, left] = await Promise.all([openPull(cwd), pushedRef(cwd, branch), uncommitted(cwd)])
  if (existing) {
    const pushed = remote ? (await count(cwd, `${remote}..HEAD`)) ?? 0 : 0
    await push(cwd, branch)
    const edit = { title: draft.title?.trim() || undefined, body: draft.body === undefined ? undefined : draft.body.trim() }
    const edited = edit.title !== undefined || edit.body !== undefined
    if (edited) await editPull(cwd, existing.number, edit)
    return { pull: (await pullForBranch(cwd)) ?? existing, opened: false, pushed, edited, uncommitted: left }
  }
  const title = draft.title?.trim()
  if (!title) throw new Error("A new pull request needs a title.")
  const base = draft.base?.trim() || await baseFor(cwd, branch, startedFrom, status.defaultBranch)
  const blocked = await openingBlocker(cwd, branch, base, status.defaultBranch)
  if (blocked) throw new Error(blocked)
  const pushed = (await count(cwd, `${remote || `refs/remotes/origin/${base}`}..HEAD`)) ?? 0
  await push(cwd, branch)
  await createPull(cwd, { title, body: draft.body?.trim() ?? "", base, draft: draft.draft })
  const pull = await pullForBranch(cwd)
  if (!pull) throw new Error("GitHub opened the pull request but didn't return it. Read it with gh pr view.")
  return { pull, opened: true, pushed, edited: false, uncommitted: left }
}

/** Merge the branch's open pull request on GitHub, only when the shared guard allows, with a method the repository allows. */
export async function mergePullRequest(cwd: string, method?: MergeMethod): Promise<{ pull: PullRequest; method: MergeMethod }> {
  await ready(cwd)
  const pull = await openPull(cwd)
  if (!pull) throw new Error("This branch has no open pull request.")
  const reason = pullMergeReason(pull)
  if (reason) throw new Error(`#${pull.number} can't merge yet. ${reason}.`)
  const allowed = (await mergeMethods(cwd)) ?? [...MERGE_METHODS]
  const chosen = method ?? allowed[0]
  if (!chosen) throw new Error("This repository allows no merge method.")
  if (!allowed.includes(chosen)) throw new Error(`This repository doesn't allow ${chosen} merges. It allows: ${allowed.join(", ")}.`)
  await mergePull(cwd, pull.number, chosen)
  return { pull: (await pullForBranch(cwd)) ?? pull, method: chosen }
}

/** The commit GitHub has for the branch: its copy on origin's, else `HEAD`. */
async function pushedCommit(cwd: string, branch: string): Promise<string> {
  return git(cwd, ["rev-parse", (await pushedRef(cwd, branch)) || "HEAD"])
}

/** Re-run the failed jobs of every GitHub Actions run that failed on the branch's pushed commit; how many runs. */
export async function rerunFailedChecks(cwd: string): Promise<number> {
  const branch = await branchOf(cwd)
  if (!branch) throw new Error("This checkout isn't on a branch.")
  const runs = await failedRuns(cwd, branch, await pushedCommit(cwd, branch))
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
export async function pullRequestReport(cwd: string, options: { startedFrom?: string | null; logs?: boolean } = {}): Promise<PullRequestReport> {
  const [status, branch, left] = await Promise.all([githubStatus(cwd), branchOf(cwd), uncommitted(cwd)])
  const report: PullRequestReport = { branch: branch || null, uncommittedFiles: left }
  const reason = pullSetupReason(status)
  if (reason) return { ...report, github: reason }
  if (!branch) return report
  const pull = await pullForBranch(cwd)
  if (pull?.state === "open") {
    const [remote, threads] = await Promise.all([pushedRef(cwd, branch), status.repo ? openReviewThreads(cwd, status.repo, pull.number) : null])
    const unpushed = remote ? await count(cwd, `${remote}..HEAD`) : null
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
    if (options.logs) view.failedLogs = await failedLogs(cwd, branch)
    return { ...report, pullRequest: view }
  }
  if (pull) report.lastPullRequest = { number: pull.number, state: pull.state === "merged" ? "merged" : "closed", url: pull.url }
  const base = await baseFor(cwd, branch, options.startedFrom, status.defaultBranch)
  const [subjects, blocked, template] = await Promise.all([
    base ? git(cwd, ["log", "--format=%h %s", `refs/remotes/origin/${base}..HEAD`]).catch(() => "") : Promise.resolve(""),
    openingBlocker(cwd, branch, base, status.defaultBranch),
    pullTemplate(cwd),
  ])
  const commits = subjects ? subjects.split("\n") : []
  report.opening = { base: base ?? null, commits: commits.slice(0, COMMITS_LISTED), template }
  if (commits.length > COMMITS_LISTED) report.opening.moreCommits = commits.length - COMMITS_LISTED
  if (blocked) report.opening.blocked = blocked
  return report
}

async function failedLogs(cwd: string, branch: string): Promise<NonNullable<PullRequestReport["pullRequest"]>["failedLogs"]> {
  const runs = await failedRuns(cwd, branch, await pushedCommit(cwd, branch))
  if (!runs.length) return "No GitHub Actions run failed on the pushed commit. A failing check from another service has its link in checks."
  return Promise.all(runs.slice(0, LOG_RUNS).map(async (run) => ({
    workflow: run.workflow,
    url: run.url,
    log: await failedRunLog(cwd, run.id, LOG_LINES).catch((error) => `Couldn't read its log: ${error instanceof Error ? error.message : String(error)}`),
  })))
}

/** One line for what opening or updating did, as the agent and a toast both say it. */
export function openedSentence({ pull, opened, pushed, edited }: PullRequestOpened): string {
  if (opened) return `Opened #${pull.number}${pull.draft ? " as a draft" : ""} into ${pull.base}: ${pull.url}`
  const parts = [pushed ? `pushed ${plural(pushed, "commit")}` : "nothing new to push", edited ? "updated its title and body" : null].filter(Boolean)
  return `#${pull.number} was already open; ${parts.join(" and ")}: ${pull.url}`
}
