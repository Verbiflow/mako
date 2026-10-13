import type { PullRequest } from "./git-workspace-search.js"

/**
 * Finding any pull request of the workspace's GitHub repository by number,
 * title, head branch or author, as the composer's `#` menu does.
 *
 * The host asks GitHub and keeps each answer for half a minute; the ranking
 * below is shared so the host orders what it returns and the window can
 * narrow the rows it already holds while the next answer is on its way.
 */

/** A pull request as a search lists it: enough to name, rank and mention it, without its body, checks or reviews. */
export type PullRequestListing = Pick<PullRequest, "number" | "title" | "state" | "draft" | "url" | "head" | "base" | "author" | "updatedAt">

export interface PullRequestSearchRequest {
  /** A number (`12`, `#12`), or words from a title, a head branch or an author's login. Empty lists the recently updated. */
  query?: string
  /** At most this many rows; 1 to 100, 30 when left out. */
  limit?: number
}

export type PullRequestSearchResult =
  | { status: "ready"; /** `owner/name`. */ repository: string; pulls: PullRequestListing[] }
  /** `no-repository`: the workspace has no GitHub remote `gh` can name. `failed`: `gh` didn't answer, in its own words. */
  | { status: "unavailable"; reason: "no-repository" | "failed"; message?: string }

export const PULL_SEARCH_DEFAULT_LIMIT = 30
export const PULL_SEARCH_MAX_LIMIT = 100
/** Longer queries are cut; nobody types a title past this. */
const QUERY_MAX = 200

/** The query as it is matched: trimmed, one space between words, no quotes, at most 200 characters. */
export function normalizePullQuery(query: string | undefined): string {
  return (query ?? "").replace(/"/g, " ").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX).trim()
}

/** The number a query names (`12`, `#12`), or null when it is words. */
export function pullQueryNumber(query: string | undefined): number | null {
  const match = /^#?(\d{1,9})$/.exec(normalizePullQuery(query))
  if (!match) return null
  const number = Number(match[1])
  return number > 0 ? number : null
}

export function pullSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PULL_SEARCH_DEFAULT_LIMIT
  return Math.min(PULL_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * How well a pull request answers a query: 100 for the exact number, 90 for
 * a title that starts with it, 80 for one that contains it, 70 for a number
 * that contains the digits, 60 for the head branch, 50 for the author, and 0
 * for no match. Case is ignored and a leading `#` is the number's. An empty
 * query matches everything at 1, so the order falls to `updatedAt`.
 */
export function pullRequestScore(pull: PullRequestListing, query: string | undefined): number {
  const words = normalizePullQuery(query).toLowerCase()
  if (!words) return 1
  const number = pullQueryNumber(words)
  if (number !== null && pull.number === number) return 100
  const text = words.replace(/^#(?=\d)/, "")
  const title = pull.title.toLowerCase()
  if (title.startsWith(text)) return 90
  if (title.includes(text)) return 80
  if (number !== null && String(pull.number).includes(String(number))) return 70
  if (pull.head.toLowerCase().includes(text)) return 60
  if (pull.author?.toLowerCase().includes(text)) return 50
  return 0
}

/**
 * Pull requests in the order a menu lists them for a query: by score, then
 * most recently updated, then the higher number. Nothing is dropped: GitHub
 * matches words a substring test doesn't (`running` finds `run`), so a row
 * it returned stays, after the ones that match here.
 */
export function rankPullRequests<TPull extends PullRequestListing>(pulls: readonly TPull[], query: string | undefined): TPull[] {
  return pulls
    .map((pull) => ({ pull, score: pullRequestScore(pull, query), updated: Date.parse(pull.updatedAt ?? "") || 0 }))
    .sort((left, right) => right.score - left.score || right.updated - left.updated || right.pull.number - left.pull.number)
    .map(({ pull }) => pull)
}

/** Pull requests that match a query here, ranked; what the window shows from rows it holds. */
export function matchPullRequests<TPull extends PullRequestListing>(pulls: readonly TPull[], query: string | undefined): TPull[] {
  return rankPullRequests(pulls.filter((pull) => pullRequestScore(pull, query) > 0), query)
}

/**
 * The GitHub search a worded query runs, `repo:` and `is:pr` being added by
 * `gh pr list`. One word that could be a branch or a login also matches head
 * branches by prefix and authors by login; words match titles as a phrase.
 * GitHub's issue search takes `OR` between qualifiers.
 */
export function pullSearchText(query: string | undefined): string {
  const words = normalizePullQuery(query)
  if (!words) return "sort:updated-desc"
  if (/^[\w.\-/]+$/.test(words)) return `(head:${words} OR author:${words} OR ("${words}" in:title)) sort:updated-desc`
  return `"${words}" in:title sort:updated-desc`
}
