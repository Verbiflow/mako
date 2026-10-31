import type { AttachmentInput } from "@/lib/attachments"
import { acp } from "@/state/acp"
import { acpStore, activeLiveAcp } from "@/state/acp-state"
import { draftText, rememberDraft } from "@/state/drafts"
import { useBranchPull } from "@/state/github"
import { store as sessionStore, useSession } from "@/state/session"
import { openSessionDraft, sessionDraftKey, threadGroupsStore } from "@/state/thread-groups"
import { newSessionInThread } from "@/state/thread-sessions"
import { useWorktrees, useWorktreeSummaries, worktreeAt } from "@/state/worktrees"
import { gitActionPrompt, gitCommands, gitRepositoryName, pullSetupReason, type GitAction, type GitCommand } from "@mako/host/contracts/git-actions"

/** In a project folder of several repositories, the action names the one the Git panel shows; worktree_update acts on all of them. */
function forShownRepository(action: GitAction): GitAction {
  if (action.kind === "update" || action.repository) return action
  const repository = gitRepositoryName(sessionStore.get().git)
  return repository ? { ...action, repository } : action
}

/**
 * Put a message in the composer that asks the Thread's agent to take a Git
 * action with its `mako` tool, below anything already written. Nothing is
 * sent until the person sends it.
 */
export function stageGitAction(action: GitAction, files: AttachmentInput[] = []): void {
  const named = forShownRepository(action)
  window.dispatchEvent(new CustomEvent("mako:attach", {
    detail: {
      files,
      text: (references: string) => gitActionPrompt(named.kind === "resolve" ? { ...named, reference: references || undefined } : named),
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
  const prompt = gitActionPrompt(forShownRepository(action))
  if (where === "new") {
    if (!newSessionInThread()) throw new Error("This conversation isn't in a Thread, so there's no Thread to add a session to.")
    const key = sessionDraftKey(openSessionDraft(threadGroupsStore.get()))
    if (!key) throw new Error("The new session's tab did not open.")
    const current = draftText(key)
    if (!current.includes(prompt)) rememberDraft(key, current.trim() ? `${current}\n\n${prompt}` : prompt)
    window.dispatchEvent(new CustomEvent("mako:focus-composer"))
    return
  }
  if (await sendIfIdle(prompt)) return
  stageGitAction(action)
}

/** Sends the session on screen `prompt` when it's idle and asking nothing; false when it can't take it now. */
async function sendIfIdle(prompt: string): Promise<boolean> {
  const live = activeLiveAcp(acpStore.get())
  return Boolean(live && live.session.status !== "running" && !live.permission && (await acp.send(prompt)))
}

/**
 * The person's own words for the Thread's agent, from a button: sent at once to an idle session, or else put in the
 * composer for them to send, as a Git action is.
 */
export async function askAgent(prompt: string): Promise<void> {
  if (await sendIfIdle(prompt)) return
  window.dispatchEvent(new CustomEvent("mako:attach", { detail: { files: [], text: () => prompt } }))
}

/** Mako's Git commands for the checkout the composer works in, each with what it does here or why it can't; none outside Git. */
export function useGitCommands(): GitCommand[] {
  const root = useSession((state) => state.git?.root)
  const branch = useSession((state) => state.git?.branch) || null
  const operation = useSession((state) => state.git?.operation)
  const worktree = useWorktrees((state) => worktreeAt(state.worktrees, root)?.worktree)
  const summary = useWorktreeSummaries((state) => (worktree ? state.byPath[worktree.path] : undefined))
  const repository = useSession((state) => gitRepositoryName(state.git))
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
    repository,
  })
}
