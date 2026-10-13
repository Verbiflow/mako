import type { ReviewTarget } from "../../contracts/live-reviews.js"

/**
 * Claude's `/code-review` for the target. It reads its argument as the
 * review's target, after an optional effort level; with none, it reviews the
 * branch against its upstream together with the uncommitted changes.
 */
export function claudeReviewCommand(target: ReviewTarget): string {
  switch (target.kind) {
    case "changes":
      return "/code-review uncommitted changes"
    case "branch":
      return `/code-review ${target.base}...HEAD`
    case "commit":
      return `/code-review ${target.sha}`
  }
}
