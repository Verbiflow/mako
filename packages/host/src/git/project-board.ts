import { readFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { commonDirOf, parseGitConfig } from "@mako/git"
import { githubRepository } from "../contracts/projects.js"
import {
  BOARD_HISTORY_MS,
  BOARD_MAX_FOLDERS,
  boardKey,
  repositoryKey,
  type Board,
  type BoardIssue,
  type BoardKind,
  type BoardProblem,
  type BoardProject,
  type BoardPull,
  type BoardPullDetail,
  type BoardPullFile,
  type BoardPullRequest,
  type BoardRepository,
  type BoardRequest,
  type ChecksRollup,
} from "../contracts/project-pulls.js"
import { discoverRepositories } from "./repository-discovery.js"
import { GitHubCliMissing, GitHubRateLimitError, GitHubRepositoryLookupError } from "./github-reads.js"

/**
 * The pull requests and issues of projects' GitHub repositories (`mako:project-board`), for the right panel and the
 * Pull requests page.
 *
 * Every read is a plain REST GET through the host's GitHub reader, which sends `If-None-Match` with the ETag of the
 * last answer: an unchanged list comes back 304 and costs nothing of the login's rate limit. Per repository and
 * request:
 * - the open pull requests (or issues), one list, at most once a minute;
 * - the recently closed, one list, at most every ten minutes;
 * - per open pull request, its head's check runs only while they may still change (read once more after they
 *   settle, never again for that head), and its reviews only when the pull request's `updated_at` moved.
 * Nothing here runs on its own: a window asks while it shows the list, and what's fresh is answered from memory.
 * One instance belongs to a host; a test makes its own with stub reads and a clock.
 */

export const OPEN_FRESH_MS = 60_000
export const CLOSED_FRESH_MS = 10 * 60_000
const VIEWER_FRESH_MS = 5 * 60_000
const FOLDER_FRESH_MS = 60_000
/** A head with no check runs this long after its pull request last moved isn't going to get any. */
const NO_CHECKS_SETTLE_MS = 30 * 60_000
/** Open pull requests per repository whose checks and reviews are read; the rest list without them. */
const ENRICH_LIMIT = 40
const OPEN_LIMIT = 50
const CLOSED_LIMIT = 20
const MAX_HELD = 2048

export interface ProjectBoardDeps {
  /** A plain REST GET's body (`repos/o/n/pulls?…`), run in `cwd`; throws what `gh` threw. */
  api(cwd: string, path: string): Promise<string>
  /** Who is signed in, null when nobody is; throws `GitHubCliMissing` without `gh`. */
  viewer(cwd: string): Promise<string | null>
  /** The GitHub repositories a project folder's checkouts name as `origin`; the local files alone, no network. */
  repositories?(folder: string): Promise<LocalRepository[]>
  now?(): number
}

export interface LocalRepository {
  /** `owner/name`. */
  name: string
  url: string
  /** A checkout of it, where `gh` runs. */
  root: string
}

interface Listing<Row> { at: number; rows: Row[] }

interface Held {
  name: string
  url: string
  root: string
  pulls: { open?: Listing<BoardPull>; closed?: Listing<BoardPull> }
  issues: { open?: Listing<BoardIssue>; closed?: Listing<BoardIssue> }
  readAt?: number
  problem?: BoardProblem
  reading: Partial<Record<BoardKind, Promise<void>>>
}

const User = z.looseObject({ login: z.string() }).nullable().optional()
const RestPull = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  user: User,
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
  merged_at: z.string().nullable().optional(),
  head: z.looseObject({ ref: z.string(), sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  requested_reviewers: z.array(z.looseObject({ login: z.string() })).nullable().optional(),
})
const RestIssue = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  user: User,
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
  assignees: z.array(z.looseObject({ login: z.string() })).nullable().optional(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string().optional() }).transform((label) => label.name)])).optional(),
  comments: z.number().optional(),
  pull_request: z.unknown().optional(),
})
const RestPulls = z.array(RestPull)
const RestIssues = z.array(RestIssue)
const CommandFailure = z.object({ stderr: z.string().optional(), message: z.string().optional(), code: z.unknown().optional() })
const RestPullDetail = z.looseObject({
  body: z.string().nullable().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changed_files: z.number().optional(),
  mergeable_state: z.string().optional(),
  head: z.looseObject({ sha: z.string() }),
})
const RestFiles = z.array(z.looseObject({
  filename: z.string(),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
}))
const CheckRuns = z.looseObject({
  total_count: z.number(),
  check_runs: z.array(z.looseObject({ name: z.string().optional(), status: z.string(), conclusion: z.string().nullable().optional(), html_url: z.string().nullable().optional() })),
})
const Reviews = z.array(z.looseObject({ state: z.string(), user: User, submitted_at: z.string().nullable().optional() }))

function time(text: string | null | undefined): number | undefined {
  const at = text ? Date.parse(text) : Number.NaN
  return Number.isFinite(at) ? at : undefined
}

function same(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase()
}

/** A head's check runs as one rollup: skipped and cancelled runs left out, as they neither pass nor fail it. */
export function checkRollup(runs: z.infer<typeof CheckRuns>["check_runs"]): ChecksRollup {
  const rollup = { passed: 0, failed: 0, running: 0, total: 0 }
  for (const run of runs) {
    const conclusion = (run.conclusion ?? "").toLowerCase()
    if (run.status !== "completed") rollup.running++
    else if (conclusion === "skipped" || conclusion === "cancelled" || conclusion === "stale") continue
    else if (conclusion === "success" || conclusion === "neutral") rollup.passed++
    else rollup.failed++
    rollup.total++
  }
  return rollup
}

/** Reviews folded to what the latest review of each reviewer says: changes requested wins, then approval. */
export function reviewVerdict(reviews: z.infer<typeof Reviews>): BoardPull["review"] {
  const latest = new Map<string, string>()
  for (const review of reviews) {
    const login = review.user?.login?.toLowerCase()
    if (!login || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue
    latest.set(login, review.state)
  }
  const states = [...latest.values()]
  if (states.includes("CHANGES_REQUESTED")) return "changes"
  if (states.includes("APPROVED")) return "approved"
  return undefined
}

/** What a failed read says, in the board's words; never `gh`'s output. */
export function boardProblem(cause: unknown, now: number): BoardProblem {
  if (cause instanceof GitHubCliMissing) return { kind: "no-cli" }
  if (cause instanceof GitHubRateLimitError) return { kind: "limited", until: cause.retryAt }
  if (cause instanceof GitHubRepositoryLookupError) return { kind: "unreachable", until: cause.retryAt }
  const failure = CommandFailure.safeParse(cause)
  const text = failure.success ? `${failure.data.stderr ?? ""}\n${failure.data.message ?? ""}` : ""
  if ((failure.success && failure.data.code === 4) || /gh auth login|HTTP 401|Bad credentials|not logged in/i.test(text)) return { kind: "signed-out" }
  if (/HTTP 404|HTTP 403|Not Found|Resource not accessible/i.test(text)) return { kind: "no-access" }
  return { kind: "unreachable", until: now + OPEN_FRESH_MS }
}

function realOrSelf(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** Where a folder's repository keeps its common files, or undefined when the folder is in none. */
function commonDir(folder: string): string | undefined {
  const found = commonDirOf(folder)
  return found === resolve(folder) || found === realOrSelf(resolve(folder)) ? undefined : found
}

/**
 * The GitHub repositories of a project folder: the repository it is in, or each one it holds, by their `origin`.
 * Worktrees of one repository share its common folder and so its `origin`: they are one repository here.
 */
export async function localRepositories(folder: string): Promise<LocalRepository[]> {
  const inside = commonDir(folder)
  const roots = inside ? [folder] : (await discoverRepositories(folder)).roots
  const found = new Map<string, LocalRepository>()
  for (const root of roots) {
    const common = commonDir(root)
    if (!common) continue
    const text = await readFile(join(common, "config"), "utf8").catch(() => undefined)
    const origin = text === undefined ? undefined : parseGitConfig(text).get("remote.origin.url")?.at(-1)
    const repository = origin ? githubRepository(origin) : undefined
    if (!repository) continue
    const name = `${repository.owner}/${repository.name}`
    if (!found.has(repositoryKey(name))) found.set(repositoryKey(name), { name, url: repository.url, root })
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export class ProjectBoard {
  readonly #deps: ProjectBoardDeps
  readonly #now: () => number
  readonly #held = new Map<string, Held>()
  readonly #folders = new Map<string, { at: number; value: Promise<LocalRepository[]> }>()
  /** Check runs by repository and head: settled ones are never asked again. */
  readonly #checks = new Map<string, { rollup: ChecksRollup; settled: boolean }>()
  /** Review verdicts by pull request and the `updated_at` they were read at. */
  readonly #reviews = new Map<string, { updatedAt: number; review: BoardPull["review"] }>()
  #viewer: { at: number; cwd: string; value: Promise<string | null> } | undefined

  constructor(deps: ProjectBoardDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  async read(request: BoardRequest): Promise<Board> {
    const folders = [...new Set(request.folders)].slice(0, BOARD_MAX_FOLDERS)
    const kind = request.kind
    const located = await Promise.all(folders.map(async (folder) => ({ folder, repositories: await this.#locate(folder) })))
    const projects: BoardProject[] = located.map(({ folder, repositories }) => ({ folder, repositories: repositories.map(({ name }) => repositoryKey(name)) }))
    const unique = new Map<string, LocalRepository>()
    for (const { repositories } of located) for (const repository of repositories) if (!unique.has(repositoryKey(repository.name))) unique.set(repositoryKey(repository.name), repository)
    const board: Board = { kind, projects, repositories: {}, pulls: [], issues: [] }
    if (unique.size === 0) return board

    let viewer: string | null
    try {
      viewer = await this.#viewerOf([...unique.values()][0]!.root)
    } catch (cause) {
      viewer = null
      board.problem = boardProblem(cause, this.#now())
    }
    if (viewer === null && !board.problem) board.problem = { kind: "signed-out" }
    if (viewer) board.viewer = viewer

    await Promise.all([...unique.values()].map((repository) => this.#readRepository(repository, kind, request.why === "refresh", board.problem, viewer ?? undefined)))
    for (const key of unique.keys()) {
      const held = this.#held.get(key)!
      board.repositories[key] = { name: held.name, url: held.url, ...(held.readAt !== undefined && { readAt: held.readAt }), ...(held.problem && { problem: held.problem }) } satisfies BoardRepository
      if (kind === "pulls") board.pulls.push(...held.pulls.open?.rows ?? [], ...held.pulls.closed?.rows ?? [])
      else board.issues.push(...held.issues.open?.rows ?? [], ...held.issues.closed?.rows ?? [])
    }
    return board
  }

  /**
   * One pull request opened from a list: its words, checks, reviews and files, each a conditional GET in a checkout
   * of its repository that a list already read. Asked when the person opens it, never on a timer.
   */
  async detail(request: BoardPullRequest): Promise<BoardPullDetail> {
    const held = this.#held.get(repositoryKey(request.repository))
    if (!held) throw new Error("Open the list this pull request is in first.")
    const base = `repos/${held.name}/pulls/${request.number}`
    const pull = RestPullDetail.parse(JSON.parse(await this.#deps.api(held.root, base)))
    const [files, runs, reviews] = await Promise.all([
      this.#deps.api(held.root, `${base}/files?per_page=100`).then((body) => RestFiles.parse(JSON.parse(body))),
      this.#deps.api(held.root, `repos/${held.name}/commits/${pull.head.sha}/check-runs?per_page=100`).then((body) => CheckRuns.parse(JSON.parse(body)).check_runs),
      this.#deps.api(held.root, `${base}/reviews?per_page=100`).then((body) => Reviews.parse(JSON.parse(body))),
    ])
    const latest = new Map<string, BoardPullDetail["reviews"][number]>()
    for (const review of reviews) {
      const login = review.user?.login
      if (!login) continue
      const state = review.state === "APPROVED" ? "approved" : review.state === "CHANGES_REQUESTED" ? "changes" : review.state === "COMMENTED" ? "commented" : undefined
      if (state && (state !== "commented" || !latest.has(login))) latest.set(login, { login, state })
    }
    return {
      body: pull.body ?? "",
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? files.length,
      ...(pull.mergeable_state && { mergeable: pull.mergeable_state }),
      checks: runs.map((run) => {
        const conclusion = (run.conclusion ?? "").toLowerCase()
        const state = run.status !== "completed" ? "running" : conclusion === "success" || conclusion === "neutral" ? "passed" : conclusion === "skipped" || conclusion === "cancelled" || conclusion === "stale" ? "skipped" : "failed"
        return { name: run.name ?? "check", state, ...(run.html_url && { url: run.html_url }) } satisfies BoardPullDetail["checks"][number]
      }),
      reviews: [...latest.values()],
      files: files.map((file): BoardPullFile => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, ...(file.patch !== undefined && { patch: file.patch }) })),
      moreFiles: (pull.changed_files ?? 0) > files.length,
    }
  }

  /** A write or a Git action moved something: the next read asks again (each still a conditional request). */
  forget(): void {
    for (const held of this.#held.values()) { held.pulls = {}; held.issues = {} }
  }

  #locate(folder: string): Promise<LocalRepository[]> {
    const now = this.#now()
    const held = this.#folders.get(folder)
    if (held && now - held.at < FOLDER_FRESH_MS) return held.value
    if (this.#folders.size >= MAX_HELD) this.#folders.clear()
    const value = (this.#deps.repositories ?? localRepositories)(folder).catch(() => [])
    this.#folders.set(folder, { at: now, value })
    return value
  }

  #viewerOf(cwd: string): Promise<string | null> {
    const now = this.#now()
    if (this.#viewer && now - this.#viewer.at < VIEWER_FRESH_MS) return this.#viewer.value
    const value = this.#deps.viewer(cwd)
    const entry = { at: now, cwd, value }
    this.#viewer = entry
    // A failure, or nobody signed in, is asked again on the next read: signing in shows at once.
    value.then((login) => { if (login === null && this.#viewer === entry) this.#viewer = undefined }, () => { if (this.#viewer === entry) this.#viewer = undefined })
    return value
  }

  #readRepository(repository: LocalRepository, kind: BoardKind, refresh: boolean, problem: BoardProblem | undefined, viewer: string | undefined): Promise<void> {
    const key = repositoryKey(repository.name)
    let held = this.#held.get(key)
    if (!held) {
      if (this.#held.size >= MAX_HELD) this.#held.clear()
      held = { name: repository.name, url: repository.url, root: repository.root, pulls: {}, issues: {}, reading: {} }
      this.#held.set(key, held)
    }
    held.root = repository.root
    if (problem) {
      held.problem = problem
      return Promise.resolve()
    }
    const running = held.reading[kind]
    if (running) return running
    const entry = held
    const reading = this.#refresh(entry, kind, refresh, viewer).finally(() => { if (entry.reading[kind] === reading) delete entry.reading[kind] })
    entry.reading[kind] = reading
    return reading
  }

  async #refresh(held: Held, kind: BoardKind, refresh: boolean, viewer: string | undefined): Promise<void> {
    const now = this.#now()
    if (held.problem && "until" in held.problem && held.problem.until > now && !refresh) return
    const stale = (listing: Listing<unknown> | undefined, freshMs: number) => refresh || !listing || now - listing.at >= freshMs
    const list = (state: "open" | "closed") => this.#deps.api(held.root, `repos/${held.name}/${kind}?state=${state}&sort=updated&direction=desc&per_page=${state === "open" ? OPEN_LIMIT : CLOSED_LIMIT}`)
    const recent = <Row extends { closedAt?: number }>(rows: Row[]) => rows.filter((row) => row.closedAt !== undefined && now - row.closedAt <= BOARD_HISTORY_MS)
    try {
      if (kind === "pulls") {
        const open = held.pulls.open
        // Rows held fresh still have their running heads asked again; nothing else is.
        held.pulls.open = stale(open, OPEN_FRESH_MS) || !open
          ? { at: now, rows: await this.#pulls(held, await list("open"), viewer) }
          : { at: open.at, rows: await this.#enrich(held, open.rows) }
        if (stale(held.pulls.closed, CLOSED_FRESH_MS)) held.pulls.closed = { at: now, rows: recent(this.#closedPulls(held, await list("closed"), viewer)) }
      } else {
        if (stale(held.issues.open, OPEN_FRESH_MS)) held.issues.open = { at: now, rows: this.#issues(held, await list("open"), viewer) }
        if (stale(held.issues.closed, CLOSED_FRESH_MS)) held.issues.closed = { at: now, rows: recent(this.#issues(held, await list("closed"), viewer)) }
      }
      held.readAt = now
      delete held.problem
    } catch (cause) {
      held.problem = boardProblem(cause, this.#now())
    }
  }

  #pullRow(held: Held, raw: z.infer<typeof RestPull>, viewer: string | undefined): BoardPull {
    const mergedAt = time(raw.merged_at)
    const closedAt = mergedAt ?? time(raw.closed_at)
    return {
      key: boardKey(held.name, raw.number),
      repository: held.name,
      number: raw.number,
      title: raw.title,
      url: raw.html_url,
      ...(raw.user?.login && { author: raw.user.login }),
      draft: raw.draft === true,
      state: raw.state === "open" ? "open" : mergedAt !== undefined ? "merged" : "closed",
      head: raw.head.ref,
      base: raw.base.ref,
      createdAt: time(raw.created_at) ?? 0,
      updatedAt: time(raw.updated_at) ?? 0,
      ...(raw.state !== "open" && closedAt !== undefined && { closedAt }),
      reviewRequested: (raw.requested_reviewers ?? []).some((reviewer) => same(reviewer.login, viewer)),
      mine: same(raw.user?.login, viewer),
    }
  }

  async #pulls(held: Held, body: string, viewer: string | undefined): Promise<BoardPull[]> {
    const raws = RestPulls.parse(JSON.parse(body))
    const shas = new Map<number, string>()
    const rows = raws.map((raw) => {
      shas.set(raw.number, raw.head.sha)
      return this.#pullRow(held, raw, viewer)
    })
    this.#heads.set(repositoryKey(held.name), shas)
    return this.#enrich(held, rows)
  }

  /** Each pull request's head, by repository and number, from the last list: what check runs are asked of. */
  readonly #heads = new Map<string, Map<number, string>>()

  #closedPulls(held: Held, body: string, viewer: string | undefined): BoardPull[] {
    return RestPulls.parse(JSON.parse(body)).map((raw) => this.#pullRow(held, raw, viewer))
  }

  /** Checks and reviews for the open pull requests that need them, most recently updated first. */
  async #enrich(held: Held, rows: BoardPull[]): Promise<BoardPull[]> {
    const heads = this.#heads.get(repositoryKey(held.name)) ?? new Map<number, string>()
    const now = this.#now()
    return Promise.all(rows.map(async (row, index) => {
      if (index >= ENRICH_LIMIT || row.state !== "open") return row
      const sha = heads.get(row.number)
      const [checks, review] = await Promise.all([
        sha ? this.#checksOf(held, sha, row, now) : Promise.resolve(row.checks),
        row.draft ? Promise.resolve(undefined) : this.#reviewOf(held, row),
      ])
      return { ...row, ...(checks && { checks }), ...(review && { review }) }
    }))
  }

  async #checksOf(held: Held, sha: string, row: BoardPull, now: number): Promise<ChecksRollup | undefined> {
    const key = `${repositoryKey(held.name)}@${sha}`
    const kept = this.#checks.get(key)
    if (kept?.settled) return kept.rollup
    try {
      const reading = CheckRuns.parse(JSON.parse(await this.#deps.api(held.root, `repos/${held.name}/commits/${sha}/check-runs?per_page=100`)))
      const rollup = checkRollup(reading.check_runs)
      const settled = rollup.total > 0 ? rollup.running === 0 : now - row.updatedAt >= NO_CHECKS_SETTLE_MS
      if (this.#checks.size >= MAX_HELD) this.#checks.clear()
      this.#checks.set(key, { rollup, settled })
      return rollup
    } catch (cause) {
      if (cause instanceof GitHubRateLimitError) throw cause
      return kept?.rollup
    }
  }

  async #reviewOf(held: Held, row: BoardPull): Promise<BoardPull["review"]> {
    const kept = this.#reviews.get(row.key)
    if (kept && kept.updatedAt === row.updatedAt) return kept.review
    try {
      const review = reviewVerdict(Reviews.parse(JSON.parse(await this.#deps.api(held.root, `repos/${held.name}/pulls/${row.number}/reviews?per_page=100`))))
      if (this.#reviews.size >= MAX_HELD) this.#reviews.clear()
      this.#reviews.set(row.key, { updatedAt: row.updatedAt, review })
      return review
    } catch (cause) {
      if (cause instanceof GitHubRateLimitError) throw cause
      return kept?.review
    }
  }

  #issues(held: Held, body: string, viewer: string | undefined): BoardIssue[] {
    return RestIssues.parse(JSON.parse(body)).filter((raw) => raw.pull_request === undefined).map((raw) => {
      const closedAt = time(raw.closed_at)
      return {
        key: boardKey(held.name, raw.number),
        repository: held.name,
        number: raw.number,
        title: raw.title,
        url: raw.html_url,
        ...(raw.user?.login && { author: raw.user.login }),
        state: raw.state === "open" ? "open" : "closed",
        createdAt: time(raw.created_at) ?? 0,
        updatedAt: time(raw.updated_at) ?? 0,
        ...(raw.state !== "open" && closedAt !== undefined && { closedAt }),
        assigned: (raw.assignees ?? []).some((assignee) => same(assignee.login, viewer)),
        labels: (raw.labels ?? []).filter((label): label is string => Boolean(label)),
        comments: raw.comments ?? 0,
      } satisfies BoardIssue
    })
  }
}
