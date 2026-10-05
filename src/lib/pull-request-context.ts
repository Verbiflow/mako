import { z } from "zod"
import type { PullRequest } from "@/lib/types"
import { summarizeChecks } from "@/lib/pull-requests"

/** Menu action, replaced by an ordinary portable attachment when picked. */
export const PULL_REQUEST_CONTEXT = "mako:pull-request"

const PullRequestSnapshotSchema = z.object({
  repository: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  head: z.string(),
  base: z.string(),
  failing: z.array(z.string()),
})

export type PullRequestSnapshot = z.infer<typeof PullRequestSnapshotSchema>

/** The snapshot `pullRequestContext` wrote, read back for its tile; null for anything else. */
export function readPullRequestContext(text: string): PullRequestSnapshot | null {
  const start = text.indexOf("\n{\n")
  const end = text.indexOf("\n}\n", start)
  if (start < 0 || end < 0) return null
  try {
    return PullRequestSnapshotSchema.safeParse(JSON.parse(text.slice(start + 1, end + 2))).data ?? null
  } catch {
    return null
  }
}

/** The branch's pull request as a file the harness reads: what GitHub said, and where to read it fresh. */
export function pullRequestContext(root: string, pull: PullRequest, capturedAt = new Date().toISOString()) {
  const repository = root.split("/").filter(Boolean).at(-1) ?? "repository"
  const checks = summarizeChecks(pull.checks)
  const failing = pull.checks.filter((check) => check.state === "failed").map((check) => check.name)
  return {
    name: `${repository}-pull-${pull.number}.md`,
    label: `#${pull.number} · ${pull.title}`,
    text: `# Pull request #${pull.number}: ${pull.title}

This is a snapshot attached by the user, not a request to change the pull request.

${JSON.stringify({
      repository: root,
      number: pull.number,
      title: pull.title,
      url: pull.url,
      state: pull.state,
      draft: pull.draft,
      head: pull.head,
      base: pull.base,
      capturedAt,
      changes: { files: pull.files, additions: pull.additions, deletions: pull.deletions },
      mergeable: pull.mergeable,
      reviewDecision: pull.reviewDecision,
      checks: { total: checks.total, passed: checks.passed, running: checks.running, failed: checks.failed },
      failing,
    }, null, 2)}

## Description

${pull.body.trim() || "(empty)"}

Before acting, call pull_request_status for its current state; checks, reviews and commits may have moved since capture. Follow the user's request. Change the pull request only with pull_request_open, and only when asked.
`,
  }
}
