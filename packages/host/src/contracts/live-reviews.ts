import { z } from "zod"
import { REVIEW_FENCE } from "@mako/sessions/review"

/**
 * What a code review looks at: the working tree's uncommitted changes, the
 * current branch's changes against a base branch, or one commit.
 */
export const ReviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes") }),
  z.object({
    kind: z.literal("branch"),
    base: z.string().min(1).max(200).regex(/^(?!-)(?!.*\.\.)[\w./-]+$/, "That isn't a branch name."),
  }),
  z.object({
    kind: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/i, "That isn't a commit hash."),
    /** The commit's subject, for the person reading the transcript. */
    title: z.string().trim().max(200).optional(),
  }),
])
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>

/** The target as the transcript names it: "uncommitted changes", "changes against main", "commit 1a2b3c4". */
export function reviewTargetLabel(target: ReviewTarget): string {
  switch (target.kind) {
    case "changes":
      return "uncommitted changes"
    case "branch":
      return `changes against ${target.base}`
    case "commit":
      return `commit ${target.sha.slice(0, 7)}`
  }
}

/** What the person sees as the review's message, whichever text the harness receives. */
export function reviewDisplayText(target: ReviewTarget): string {
  return `/review ${reviewTargetLabel(target)}`
}

function scope(target: ReviewTarget): string {
  switch (target.kind) {
    case "changes":
      return "the uncommitted changes: staged, unstaged and untracked files. Run `git status --short`, `git diff` and `git diff --cached`, and read each untracked file whole."
    case "branch":
      return `the current branch's changes against ${target.base}. Run \`git diff ${target.base}...HEAD\`.`
    case "commit":
      return `commit ${target.sha}${target.title ? ` ("${target.title}")` : ""}. Run \`git show ${target.sha}\`.`
  }
}

/**
 * Mako's review prompt, for a harness with no review of its own. `reviewer`
 * names how the harness should review, when it has its own reviewer to hand
 * the work to. The reply ends with the findings in a `mako-review` block,
 * which the transcript shows as the review's card.
 */
export function makoReviewPrompt(target: ReviewTarget, reviewer?: string): string {
  return [
    `Review ${scope(target)}`,
    `${reviewer ? `${reviewer} ` : ""}Don't change any files.`,
    "Read the code around each change before judging it. Report real problems: bugs, regressions, broken callers, dropped error handling, security holes, and missing tests for risky changes. Give each finding the concrete case in which the code misbehaves. Skip style preferences unless the project's own conventions ask for them, and leave out anything you aren't sure of.",
    `End your reply with the findings, most severe first, as JSON in a fenced block tagged ${REVIEW_FENCE}:`,
    [
      "```" + REVIEW_FENCE,
      JSON.stringify({
        summary: "One or two sentences on the change as a whole.",
        findings: [{ title: "The problem, in one sentence", body: "Why it's wrong, and the case that triggers it", path: "src/file.ts", line: 42, priority: 1 }],
      }),
      "```",
    ].join("\n"),
    "`path` is relative to the project root. `priority` is 0 for a problem that breaks the change for everyone, 1 for one to fix before merging, 2 for one to fix soon, and 3 for a minor one. When you find nothing wrong, give an empty `findings` list.",
  ].join("\n\n")
}
