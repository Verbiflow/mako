import type { AttachmentInput } from "@/lib/attachments"
import { useBranchPull } from "@/state/github"
import { useSession } from "@/state/session"
import { useWorktrees, useWorktreeSummaries, worktreeAt } from "@/state/worktrees"
import { gitActionPrompt, gitCommands, pullSetupReason, type GitAction, type GitCommand } from "../../electron/contracts/git-actions"

/**
 * Put a message in the composer that asks the Thread's agent to take a Git
 * action with its `mako` tool, below anything already written. Nothing is
 * sent until the person sends it.
 */
export function stageGitAction(action: GitAction, files: AttachmentInput[] = []): void {
  window.dispatchEvent(new CustomEvent("mako:attach", {
    detail: {
      files,
      text: (references: string) => gitActionPrompt(action.kind === "resolve" ? { ...action, reference: references || undefined } : action),
    },
  }))
}

/** Mako's Git commands for the checkout the composer works in, each with what it does here or why it can't; none outside Git. */
export function useGitCommands(): GitCommand[] {
  const root = useSession((state) => state.git?.root)
  const cwd = useSession((state) => state.git?.cwd)
  const branch = useSession((state) => state.git?.branch) || null
  const operation = useSession((state) => state.git?.operation)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, cwd)?.worktree)
  const summary = useWorktreeSummaries((state) => (worktree ? state.byPath[worktree.path] : undefined))
  const branchPull = useBranchPull()
  if (!root) return []
  const pull = branchPull?.pull?.state === "open" && branchPull.pull.head === branch ? branchPull.pull : null
  return gitCommands({
    branch,
    github: branchPull ? pullSetupReason(branchPull.status) : undefined,
    defaultBranch: branchPull?.status.defaultBranch,
    operation,
    worktree: worktree ? { into: summary?.into ?? null, behind: summary?.behind ?? null } : undefined,
    pull: pull && { number: pull.number, failing: pull.checks.filter((check) => check.state === "failed").map((check) => check.name) },
  })
}
