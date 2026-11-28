/**
 * The pull requests and issues of a project's GitHub repositories, as the right panel and the Pull requests page draw
 * them from one reading (`mako:project-board`).
 *
 * A project is a folder: one repository, or a folder holding several. Its repositories are its checkouts' `origin`
 * remotes, so two worktrees of one repository are one repository here. Each repository is read on its own and keyed by
 * `owner/name`, so one that fails to load says so on its own line while the rest still show. The rules for sections,
 * labels and the panel's reading live here once, read by the host's tests and the window alike.
 */

export const BOARD_KINDS = ["pulls", "issues"] as const
/** Which list a reading is of. */
export type BoardKind = (typeof BOARD_KINDS)[number]

/** Most project folders one reading takes: the page asks for every project in the rail. */
export const BOARD_MAX_FOLDERS = 64
/** Merged and closed rows stay listed this long after they closed. */
export const BOARD_HISTORY_MS = 7 * 24 * 60 * 60_000

export interface BoardRequest {
  /** Project folders, each a repository or a folder holding several. */
  folders: string[]
  kind: BoardKind
  /** `refresh`: the person asked, so lists held are asked again (a conditional request each, free when unchanged). */
  why?: "look" | "refresh"
}

/**
 * Why a repository couldn't be read, as the one thing that fixes it says it. `limited` and `unreachable` resolve on
 * their own by `until`; the others need the person (sign in, install `gh`) or GitHub (no access).
 */
export type BoardProblem =
  | { kind: "no-cli" }
  | { kind: "signed-out" }
  | { kind: "no-access" }
  | { kind: "limited"; until: number }
  | { kind: "unreachable"; until: number }

export interface BoardRepository {
  /** `owner/name` as GitHub spells it; the key rows name it by, lower-cased. */
  name: string
  /** `https://github.com/owner/name`. */
  url: string
  /** When its rows were last read; undefined before the first reading answered. */
  readAt?: number
  /** Set while it can't be read; rows held from an earlier reading stay. */
  problem?: BoardProblem
}

export interface BoardProject {
  folder: string
  /** Its repositories' keys (`owner/name`, lower-cased), each once however many of its checkouts share it. */
  repositories: string[]
}

/** What a pull request's head checks say: GitHub Actions' check runs, cancelled and skipped ones left out. */
export interface ChecksRollup {
  passed: number
  failed: number
  running: number
  total: number
}

export interface BoardPull {
  /** `owner/name#12`, the repository lower-cased: the same pull request whichever project lists it. */
  key: string
  /** `owner/name` as GitHub spells it. */
  repository: string
  number: number
  title: string
  url: string
  author?: string
  draft: boolean
  state: "open" | "merged" | "closed"
  head: string
  base: string
  createdAt: number
  updatedAt: number
  /** When it merged or closed. */
  closedAt?: number
  /** Undefined until read (a closed one never is); `total: 0` when its head reports none. */
  checks?: ChecksRollup
  /** The latest review of each reviewer, folded: any changes requested wins, else any approval. */
  review?: "approved" | "changes"
  /** A review is asked of the signed-in person. */
  reviewRequested: boolean
  /** The signed-in person opened it. */
  mine: boolean
}

export interface BoardIssue {
  key: string
  repository: string
  number: number
  title: string
  url: string
  author?: string
  state: "open" | "closed"
  createdAt: number
  updatedAt: number
  closedAt?: number
  /** Assigned to the signed-in person. */
  assigned: boolean
  labels: string[]
  comments: number
}

export interface Board {
  kind: BoardKind
  /** The signed-in login, when there is one. */
  viewer?: string
  /** A problem that stops every repository (no `gh`, signed out); each repository says it too. */
  problem?: BoardProblem
  projects: BoardProject[]
  /** By key (`owner/name`, lower-cased). */
  repositories: Record<string, BoardRepository>
  pulls: BoardPull[]
  issues: BoardIssue[]
}

/** The key rows of a repository share: `owner/name`, lower-cased. */
export function repositoryKey(name: string): string {
  return name.toLowerCase()
}

/** `owner/name#12`, the repository lower-cased. */
export function boardKey(repository: string, number: number): string {
  return `${repositoryKey(repository)}#${number}`
}

// Sections

export const PULL_SECTIONS = [
  { key: "needs-you", label: "Needs you", folded: false },
  { key: "ready", label: "Ready to merge", folded: false },
  { key: "checks", label: "Waiting on checks", folded: false },
  { key: "others", label: "Waiting on others", folded: false },
  { key: "draft", label: "Draft", folded: false },
  { key: "merged", label: "Recently merged", folded: true },
  { key: "closed", label: "Recently closed", folded: true },
] as const
export type PullSection = (typeof PULL_SECTIONS)[number]["key"]

export const ISSUE_SECTIONS = [
  { key: "needs-you", label: "Assigned to you", folded: false },
  { key: "open", label: "Open", folded: false },
  { key: "closed", label: "Recently closed", folded: true },
] as const
export type IssueSection = (typeof ISSUE_SECTIONS)[number]["key"]

/**
 * Where a pull request is listed.
 * - Needs you: a review asked of you, or yours with changes requested or a failing check.
 * - Ready to merge: checks green (or none) and no changes requested.
 * - Waiting on checks: a check still runs.
 * - Waiting on others: someone else's with changes requested or a failing check.
 * - Draft, then merged and closed in the last seven days.
 */
export function pullSection(pull: Pick<BoardPull, "state" | "draft" | "checks" | "review" | "reviewRequested" | "mine">): PullSection {
  if (pull.state === "merged") return "merged"
  if (pull.state === "closed") return "closed"
  const failing = (pull.checks?.failed ?? 0) > 0
  const running = (pull.checks?.running ?? 0) > 0
  if (pull.reviewRequested && !pull.draft) return "needs-you"
  if (pull.mine && (pull.review === "changes" || failing)) return "needs-you"
  if (pull.draft) return "draft"
  if (running) return "checks"
  if (failing || pull.review === "changes") return "others"
  if (!pull.checks) return "checks"
  return "ready"
}

export function issueSection(issue: Pick<BoardIssue, "state" | "assigned">): IssueSection {
  if (issue.state === "closed") return "closed"
  return issue.assigned ? "needs-you" : "open"
}

export interface Section<Row, Key extends string = string> {
  key: Key
  label: string
  folded: boolean
  rows: Row[]
}

/** Most recently updated first; merged and closed by when they closed. */
function byRecency<Row extends { updatedAt: number; closedAt?: number; number: number }>(left: Row, right: Row): number {
  return (right.closedAt ?? right.updatedAt) - (left.closedAt ?? left.updatedAt) || right.number - left.number
}

/** Within the history window: what isn't merged or closed always is. */
export function inHistory(row: { closedAt?: number; state: string }, now: number): boolean {
  return row.state === "open" || (row.closedAt !== undefined && now - row.closedAt <= BOARD_HISTORY_MS)
}

/** Pull requests in their sections, in order, empty sections left out. */
export function pullSections(pulls: readonly BoardPull[], now: number): Section<BoardPull, PullSection>[] {
  const rows = pulls.filter((pull) => inHistory(pull, now))
  return PULL_SECTIONS.map(({ key, label, folded }) => ({
    key, label, folded,
    rows: rows.filter((pull) => pullSection(pull) === key).sort(byRecency),
  })).filter((section) => section.rows.length > 0)
}

export function issueSections(issues: readonly BoardIssue[], now: number): Section<BoardIssue, IssueSection>[] {
  const rows = issues.filter((issue) => inHistory(issue, now))
  return ISSUE_SECTIONS.map(({ key, label, folded }) => ({
    key, label, folded,
    rows: rows.filter((issue) => issueSection(issue) === key).sort(byRecency),
  })).filter((section) => section.rows.length > 0)
}

/**
 * Rows by repository, for Display → Group by repository: one section per repository in name order, each open
 * rows first, then merged and closed, which fold with a section of their own only when nothing in it is open.
 */
export function repositorySections<Row extends { repository: string; state: string; updatedAt: number; closedAt?: number; number: number }>(rows: readonly Row[], now: number): Section<Row>[] {
  const by = new Map<string, Row[]>()
  for (const row of rows) {
    if (!inHistory(row, now)) continue
    const key = repositoryKey(row.repository)
    by.set(key, [...(by.get(key) ?? []), row])
  }
  return [...by.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, held]) => {
      const open = held.filter((row) => row.state === "open").sort(byRecency)
      const shut = held.filter((row) => row.state !== "open").sort(byRecency)
      return { key, label: held[0]!.repository, folded: open.length === 0, rows: [...open, ...shut] }
    })
}

// Labels

/**
 * The repositories each row's project spans, by repository key: a row is labelled with its repository's name only
 * when one of the projects listing it holds more than one repository.
 */
export function multiRepositoryKeys(projects: readonly BoardProject[]): Set<string> {
  const keys = new Set<string>()
  for (const project of projects) if (project.repositories.length > 1) for (const key of project.repositories) keys.add(key)
  return keys
}

/** `name#123` when the row's project spans more than one repository, else `#123`. */
export function rowCode(row: { repository: string; number: number }, multi: ReadonlySet<string>): string {
  if (!multi.has(repositoryKey(row.repository))) return `#${row.number}`
  return `${row.repository.split("/")[1] ?? row.repository}#${row.number}`
}

/** The reading at the end of the panel's tab: how many need the person, else how many are open. */
export function boardReading(pulls: readonly BoardPull[]): { text: string; attention: boolean } | undefined {
  const open = pulls.filter((pull) => pull.state === "open")
  const needs = open.filter((pull) => pullSection(pull) === "needs-you").length
  if (needs > 0) return { text: `${needs} needs you`, attention: true }
  if (open.length > 0) return { text: `${open.length} open`, attention: false }
  return undefined
}

/** What a repository's problem says, after its name: "owner/name couldn't be read: <words>". */
export function problemWords(problem: BoardProblem): string {
  switch (problem.kind) {
    case "no-cli": return "the GitHub CLI isn't installed"
    case "signed-out": return "GitHub isn't signed in"
    case "no-access": return "this login can't see it"
    case "limited": return "GitHub is limiting requests for a moment"
    case "unreachable": return "GitHub didn't answer"
  }
}

/** Checks as the row's cell says them: `✓`, `✕ 2/7`, `3/7` while they run; empty when none are reported. */
export function checksWords(checks: ChecksRollup | undefined): { text: string; tone: "positive" | "negative" | "faint" } | undefined {
  if (!checks || checks.total === 0) return undefined
  if (checks.failed > 0) return { text: `${checks.failed}/${checks.total}`, tone: "negative" }
  if (checks.running > 0) return { text: `${checks.passed}/${checks.total}`, tone: "faint" }
  return { text: `${checks.total}`, tone: "positive" }
}
