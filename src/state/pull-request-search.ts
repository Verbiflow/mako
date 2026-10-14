import { useEffect, useRef, useState } from "react"
import { getMako, hasBridge } from "@/lib/bridge"
import { github, githubStore, useGitHub } from "@/state/github"
import { useSession } from "@/state/session"
import {
  matchPullRequests,
  pullMentionReason,
  pullQueryNumber,
  pullSearchFailure,
  type PullRequestListing,
} from "@/lib/pull-request-mentions"
import type { PullRequestSearchRequest } from "@mako/host/contracts/pull-request-search"

/**
 * Finding any pull request of the workspace's GitHub repository for a `#`
 * mention.
 *
 * GitHub is asked only once the person pauses: words wait 150 ms, and a
 * number or an empty query (the menu just opened) goes at once. While the
 * next answer is on its way the rows already held are narrowed to the new
 * query, so typing never empties the menu. The host keeps each answer for
 * 30 seconds and shares one already in flight, so this keeps none of its
 * own beyond the last rows.
 */

export type PullRequestSearchStatus = "idle" | "loading" | "ready" | "unavailable"

export interface PullRequestSearchView {
  status: PullRequestSearchStatus
  /** Ranked for the query; while loading, the rows held before narrowed to it. */
  pulls: PullRequestListing[]
  /** `owner/name` the rows belong to, for `pullRequestDetail`. */
  repository?: string
  /** Why there are no rows, in a sentence, when `unavailable`. */
  reason?: string
}

export const PULL_SEARCH_DEBOUNCE_MS = 150

/** A folder outside Git has no GitHub remote either, and is fixed the same way. */
const NO_REMOTE = "Add a GitHub remote to mention pull requests"

export const IDLE_PULL_SEARCH: PullRequestSearchView = { status: "idle", pulls: [] }

export interface PullSearchWatch {
  /** The workspace's Git root; none means there is no repository to ask about. */
  root: string | undefined
  /** What follows `#`; null when no menu is asking. */
  query: string | null
  limit?: number
  /** The last view, whose rows stand in, narrowed, while this one loads. */
  previous?: PullRequestSearchView
}

/**
 * Search once for `query` and report each view to `listener`: loading, then
 * ready or unavailable. Returns a stop that drops anything that arrives
 * after it. React-free; `usePullRequestSearch` is its hook.
 */
export function watchPullRequestSearch({ root, query, limit, previous }: PullSearchWatch, listener: (view: PullRequestSearchView) => void): () => void {
  if (query === null) {
    listener(IDLE_PULL_SEARCH)
    return () => {}
  }
  let stopped = false
  const report = (view: PullRequestSearchView) => {
    if (!stopped) listener(view)
  }
  const loading: PullRequestSearchView = { status: "loading", pulls: [] }
  if (previous?.repository) {
    loading.pulls = matchPullRequests(previous.pulls, query)
    loading.repository = previous.repository
  }
  report(loading)

  const run = async () => {
    if (!root || !hasBridge()) {
      report({ status: "unavailable", pulls: [], reason: NO_REMOTE })
      return
    }
    await github.ensureStatus(root)
    if (stopped) return
    const { status, statusRoot } = githubStore.get()
    if (!status || statusRoot !== root) {
      report({ status: "unavailable", pulls: [], reason: "GitHub didn't answer" })
      return
    }
    const setup = pullMentionReason(status)
    if (setup) {
      report({ status: "unavailable", pulls: [], reason: setup })
      return
    }
    try {
      const request: PullRequestSearchRequest = { query }
      if (limit !== undefined) request.limit = limit
      const result = await getMako().pullRequestSearch(request)
      if (result.status === "ready") report({ status: "ready", pulls: result.pulls, repository: result.repository })
      else report({ status: "unavailable", pulls: [], reason: pullSearchFailure(result) })
    } catch (error) {
      report({ status: "unavailable", pulls: [], reason: pullSearchFailure({ status: "unavailable", reason: "failed", message: error instanceof Error ? error.message : String(error) }) })
    }
  }

  const immediate = !query.trim() || pullQueryNumber(query) !== null
  if (immediate) {
    void run()
    return () => {
      stopped = true
    }
  }
  const timer = setTimeout(() => void run(), PULL_SEARCH_DEBOUNCE_MS)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * Pull requests of the workspace's GitHub repository matching `query` (a
 * number, `#12`, or words from a title, head branch or author; empty for the
 * recently updated). Null keeps it idle and asks nothing.
 */
export function usePullRequestSearch(query: string | null, options: { limit?: number } = {}): PullRequestSearchView {
  const { limit } = options
  const root = useSession((current) => current.git?.root)
  // Signing in, or a remote appearing, asks again.
  const status = useGitHub((current) => (current.statusRoot === root ? current.status : undefined))
  const [view, setView] = useState<PullRequestSearchView>(IDLE_PULL_SEARCH)
  const last = useRef<PullRequestSearchView>(IDLE_PULL_SEARCH)
  useEffect(
    () =>
      watchPullRequestSearch({ root, query, limit, previous: last.current }, (next) => {
        last.current = next
        setView(next)
      }),
    [root, query, limit, status]
  )
  return view
}
