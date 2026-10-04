import type { ThreadWorktree, WorktreeSummary } from "../../electron/contracts/thread-worktrees.ts"

/** What a rail row's worktree mark shows: the branch's state as a glyph, never a hue. */
export type WorktreeMarkState =
  | { kind: "branch" }
  | { kind: "ahead"; ahead: number }
  | { kind: "pull"; number: number; draft: boolean }
  | { kind: "landed" }

export function worktreeMark(summary: WorktreeSummary | undefined): WorktreeMarkState {
  if (!summary) return { kind: "branch" }
  const { pull } = summary
  if (pull && (pull.state === "open" || pull.state === "draft")) return { kind: "pull", number: pull.number, draft: pull.state === "draft" }
  if (summary.landing.kind === "merged") return { kind: "landed" }
  if (summary.ahead > 0) return { kind: "ahead", ahead: summary.ahead }
  return { kind: "branch" }
}

function commits(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`
}

function files(count: number): string {
  return count === 1 ? "1 file" : `${count} files`
}

export function worktreeMarkLabel(mark: WorktreeMarkState, worktree: ThreadWorktree, into: string | null): string {
  const main = into ?? "main"
  if (mark.kind === "pull") return `${mark.draft ? "Draft pull request" : "Pull request"} #${mark.number} on ${worktree.branch}`
  if (mark.kind === "landed") return `${worktree.branch}: its work is in ${main}`
  if (mark.kind === "ahead") return `${worktree.branch}: ${commits(mark.ahead)} not in ${main}`
  return `On its own branch, ${worktree.branch}`
}

/** The lines the row's tip gives the branch, below the row's own. */
export function worktreeTip(worktree: ThreadWorktree, summary: WorktreeSummary | undefined): string[] {
  const from = worktree.start?.from
  const lines = [from ? `On ${worktree.branch} from ${from}` : `On ${worktree.branch}`]
  if (!summary) return lines
  const main = summary.into ?? "main"
  const state = summary.landing.kind === "merged"
    ? `Its work is in ${main}`
    : summary.ahead > 0
      ? `${commits(summary.ahead)} not in ${main}`
      : summary.landing.kind === "empty"
        ? "Nothing committed yet"
        : `Nothing that ${main} doesn't have`
  lines.push(summary.changes === 0
    ? state
    : summary.landing.kind === "empty"
      ? `${files(summary.changes)} not committed yet`
      : `${state} · ${files(summary.changes)} not committed`)
  const { pull } = summary
  if (pull) {
    const checks = pull.checks === "passed" ? "checks passed" : pull.checks === "failed" ? "checks failed" : pull.checks === "running" ? "checks running" : undefined
    lines.push([`#${pull.number} ${pull.state}`, pull.state === "open" || pull.state === "draft" ? checks : undefined].filter(Boolean).join(" · "))
  }
  return lines
}
