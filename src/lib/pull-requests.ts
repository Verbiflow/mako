import type { CheckSummary, GitHubStatus, PullRequest } from "@/lib/types"

export function summarizeChecks(checks: readonly CheckSummary[]) {
  let passed = 0
  let failed = 0
  let running = 0
  for (const check of checks) {
    if (check.state === "passed") passed += 1
    else if (check.state === "failed") failed += 1
    else if (check.state === "running") running += 1
  }
  return { total: checks.length, passed, failed, running }
}

/** Why GitHub won't merge the pull request now, or undefined when it will. */
export function pullMergeReason(pull: PullRequest): string | undefined {
  const checks = summarizeChecks(pull.checks)
  if (pull.state !== "open") return `This pull request is already ${pull.state}`
  if (pull.mergeable === "conflicting") return "Resolve merge conflicts first"
  if (checks.failed > 0) return "Fix failing checks first"
  if (checks.running > 0) return "Wait for checks to finish"
  if (pull.reviewDecision === "changes") return "Address requested changes first"
  return undefined
}

/** Why a pull request can't be opened from here, or null once GitHub is set up. */
export function pullSetupReason(status: GitHubStatus): string | null {
  if (!status.installed) return "Install the GitHub CLI to open a pull request."
  if (!status.authenticated) return "Sign in to GitHub with gh auth login to open a pull request."
  if (!status.repo) return "Add a GitHub remote to open a pull request."
  return null
}
