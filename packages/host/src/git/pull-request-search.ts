import {
  PULL_SEARCH_MAX_LIMIT,
  matchPullRequests,
  normalizePullQuery,
  pullQueryNumber,
  pullSearchLimit,
  pullSearchText,
  rankPullRequests,
  type PullRequestListing,
  type PullRequestSearchRequest,
  type PullRequestSearchResult,
} from "../contracts/pull-request-search.js"
import { githubPullSource, type PullRequestSource } from "./github.js"

/** How long an answer from GitHub stands before the next search asks again. */
const LIST_TTL_MS = 30_000
/** A folder's repository changes only with its remote; asked again after five minutes. */
const REPOSITORY_TTL_MS = 5 * 60_000
/** Answers kept at once; a person typing makes one per pause, and the oldest go first. */
const MAX_ENTRIES = 64

interface Entry<TValue> {
  /** When the answer settled; undefined while it is in flight, which every caller shares. */
  settledAt?: number
  value: Promise<TValue>
}

export interface PullRequestSearchOptions {
  source?: PullRequestSource
  now?: () => number
  listTtlMs?: number
}

/**
 * Any pull request of a workspace's GitHub repository, found by number or
 * words.
 *
 * A number is matched against the hundred most recently updated, exact
 * first, then numbers holding its digits; one not among them is looked up
 * directly. Words go to GitHub's search over titles, head branches and
 * authors. Each answer is kept for 30 seconds by repository and query, and a
 * search already in flight is shared rather than asked twice. A failure is
 * never kept. Nothing here polls: an entry expires when it is next read.
 *
 * One instance belongs to a host (`declareGitMethods`), so a test makes its
 * own with a stub source and clock.
 */
export class PullRequestSearch {
  readonly #source: PullRequestSource
  readonly #now: () => number
  readonly #listTtlMs: number
  readonly #repositories = new Map<string, Entry<string | null>>()
  readonly #answers = new Map<string, Entry<PullRequestListing[]>>()

  constructor({ source = githubPullSource(), now = Date.now, listTtlMs = LIST_TTL_MS }: PullRequestSearchOptions = {}) {
    this.#source = source
    this.#now = now
    this.#listTtlMs = listTtlMs
  }

  async search(cwd: string, request: PullRequestSearchRequest = {}): Promise<PullRequestSearchResult> {
    const query = normalizePullQuery(request.query)
    const limit = pullSearchLimit(request.limit)
    try {
      const repository = await this.#cached(this.#repositories, cwd, REPOSITORY_TTL_MS, () => this.#source.repository(cwd))
      if (!repository) return { status: "unavailable", reason: "no-repository" }
      const number = pullQueryNumber(query)
      const pulls = number !== null
        ? await this.#byNumber(cwd, repository, number, query)
        : rankPullRequests(await this.#list(cwd, repository, query, query ? limit : PULL_SEARCH_MAX_LIMIT), query)
      return { status: "ready", repository, pulls: pulls.slice(0, limit) }
    } catch (cause) {
      return { status: "unavailable", reason: "failed", message: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  /** The recently updated that match the number, and the number itself when they don't hold it. */
  async #byNumber(cwd: string, repository: string, number: number, query: string): Promise<PullRequestListing[]> {
    const recent = await this.#list(cwd, repository, "", PULL_SEARCH_MAX_LIMIT)
    const matched = matchPullRequests(recent, query)
    if (matched.some((pull) => pull.number === number)) return matched
    const exact = await this.#cached(this.#answers, JSON.stringify([repository, "#", number]), this.#listTtlMs, async () => {
      const pull = await this.#source.view(cwd, repository, number)
      return pull ? [pull] : []
    })
    return rankPullRequests([...exact, ...matched], query)
  }

  #list(cwd: string, repository: string, query: string, limit: number): Promise<PullRequestListing[]> {
    return this.#cached(this.#answers, JSON.stringify([repository, query, limit]), this.#listTtlMs, () =>
      this.#source.search(cwd, repository, pullSearchText(query), limit)
    )
  }

  #cached<TValue>(entries: Map<string, Entry<TValue>>, key: string, ttlMs: number, load: () => Promise<TValue>): Promise<TValue> {
    const now = this.#now()
    for (const [held, entry] of entries) {
      if (entry.settledAt !== undefined && now - entry.settledAt >= ttlMs) entries.delete(held)
    }
    const held = entries.get(key)
    if (held) return held.value
    const entry: Entry<TValue> = {
      value: load().then(
        (value) => {
          entry.settledAt = this.#now()
          return value
        },
        (cause: unknown) => {
          if (entries.get(key) === entry) entries.delete(key)
          throw cause
        }
      ),
    }
    entries.set(key, entry)
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    return entry.value
  }
}
