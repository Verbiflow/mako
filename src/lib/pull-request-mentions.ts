import type { GitHubStatus } from "@/lib/types"
import type { PullRequestDetail } from "@/lib/context-detail"
import type { PullRequestListing, PullRequestSearchResult } from "@mako/host/contracts/pull-request-search"

export {
  matchPullRequests,
  pullQueryNumber,
  pullRequestScore,
  rankPullRequests,
  type PullRequestListing,
} from "@mako/host/contracts/pull-request-search"

/**
 * A pull request as the context chip a `#` mention adds. It takes any
 * pull request the host lists (a search row or the branch's own), keeps
 * only what names it, and leaves out what is unknown rather than writing
 * an empty value.
 */
export function pullRequestDetail(pull: PullRequestListing, repository?: string): PullRequestDetail {
  const detail: PullRequestDetail = {
    kind: "pull-request",
    number: pull.number,
    title: pull.title,
    url: pull.url,
    state: pull.state,
    draft: pull.draft,
    head: pull.head,
    base: pull.base,
  }
  if (pull.author) detail.author = pull.author
  if (repository) detail.repository = repository
  return detail
}

/**
 * Why pull requests can't be mentioned here, in the pull request panel's
 * three sentences (a missing CLI, a missing login and a folder with no
 * GitHub remote are fixed differently); null when GitHub can answer.
 */
export function pullMentionReason(status: GitHubStatus | undefined): string | null {
  if (!status) return null
  if (!status.installed) return "Install the gh CLI to mention pull requests"
  if (!status.authenticated) return "Sign in to GitHub to mention pull requests"
  if (!status.repo) return "Add a GitHub remote to mention pull requests"
  return null
}

/** What the host's unavailable answer reads as. */
export function pullSearchFailure(result: Extract<PullRequestSearchResult, { status: "unavailable" }>): string {
  if (result.reason === "no-repository") return "Add a GitHub remote to mention pull requests"
  const said = result.message?.split("\n").find((line) => line.trim())?.trim()
  return said ? `GitHub didn't answer: ${said}` : "GitHub didn't answer"
}
