import type { ReviewTarget } from "../../contracts/live-reviews.js"

/**
 * OpenCode's built-in `/review` for the target. Its template reviews the
 * uncommitted changes with no argument, `git show` of a commit hash, and
 * `git diff <branch>...HEAD` for a branch name.
 */
export function openCodeReviewCommand(target: ReviewTarget): string {
  switch (target.kind) {
    case "changes":
      return "/review"
    case "branch":
      return `/review ${target.base}`
    case "commit":
      return `/review ${target.sha}`
  }
}
