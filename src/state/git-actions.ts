import type { AttachmentInput } from "@/lib/attachments"
import { acp } from "@/state/acp"
import { acpStore, activeLiveAcp } from "@/state/acp-state"
import { draftText, rememberDraft } from "@/state/drafts"
import { useBranchPull } from "@/state/github"
import { useSession } from "@/state/session"
import { openSessionDraft, sessionDraftKey, threadGroupsStore } from "@/state/thread-groups"
import { newSessionInThread } from "@/state/thread-sessions"
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

/** Where a Git request goes: the session on screen, or a new session in its Thread. */
export type GitHandoff = "here" | "new"

/**
 * Give a Git action to the Thread's harness. Here, an idle session is sent
 * it at once; a busy one, or none yet, finds it in the composer. A new
 * session opens the Thread's new tab with it written, on whichever harness
 * the tab picks, as a plan builds in a new session.
 */
export async function handGitAction(action: GitAction, where: GitHandoff): Promise<void> {
  const prompt = gitActionPrompt(action)
  if (where === "new") {
    if (!newSessionInThread()) throw new Error("This conversation isn't in a Thread, so there's no Thread to add a session to.")
    const key = sessionDraftKey(openSessionDraft(threadGroupsStore.get()))
    if (!key) throw new Error("The new session's tab did not open.")
    const current = draftText(key)
    if (!current.includes(prompt)) rememberDraft(key, current.trim() ? `${current}\n\n${prompt}` : prompt)
    window.dispatchEvent(new CustomEvent("mako:focus-composer"))
    return
  }
  const live = activeLiveAcp(acpStore.get())
  if (live && live.session.status !== "running" && !live.permission && (await acp.send(prompt))) return
  stageGitAction(action)
}

/** Mako's Git commands for the checkout the composer works in, each with what it does here or why it can't; none outside Git. */
export function useGitCommands(): GitCommand[] {
  const root = useSession((state) => state.git?.root)
  const branch = useSession((state) => state.git?.branch) || null
  const operation = useSession((state) => state.git?.operation)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, root)?.worktree)
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
