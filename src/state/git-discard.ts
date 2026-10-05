import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { GitFile } from "@/lib/types"
import { confirmAction } from "@/state/confirm"
import { git } from "@/state/git"
import { actions } from "@/state/session"

/** Files named in the dialog; the rest are counted. */
const SHOWN = 6

const OUTCOME = {
  modified: "Reverted",
  deleted: "Restored",
  added: "Removed",
  untracked: "Removed",
  conflicted: "Reverted",
} satisfies Record<GitFile["status"], string>

/**
 * Asks, then puts `files` back as the last commit has them. Git's stash keeps
 * what they held, and the toast's Undo pops exactly that entry.
 */
export async function discardFiles(files: readonly GitFile[]): Promise<void> {
  if (files.length === 0) return
  const one = files.length === 1 ? files[0] : undefined
  const confirmed = await confirmAction({
    title: one ? `Discard changes to ${one.path.slice(one.path.lastIndexOf("/") + 1)}?` : `Discard changes to ${files.length} files?`,
    body: one
      ? "It goes back to how the last commit has it, staged and unstaged."
      : "They go back to how the last commit has them, staged and unstaged.",
    confirm: "Discard changes",
    tone: "negative",
    icon: "remove",
    subjects: files.slice(0, SHOWN).map((file) => ({ kind: "file", name: file.path, detail: OUTCOME[file.status], lost: file.status === "added" || file.status === "untracked" })),
    more: files.length > SHOWN ? files.length - SHOWN : undefined,
    note: "Mako keeps what you discard in this repository's Git stash, so Undo, or git stash pop, brings it back.",
  })
  if (!confirmed) return
  const label = one ? one.path : `${files.length} files`
  try {
    const { stash } = await git.discard(files.map((file) => file.path))
    await actions.refreshGit()
    toast.success(`Discarded ${label}`, {
      duration: ACTION_TOAST_MS,
      description: "Kept in Git's stash.",
      action: { label: "Undo", onClick: () => void restore(stash, label) },
    })
  } catch (error) {
    await actions.refreshGit()
    toast.error(`${label} wasn't discarded`, { duration: ACTION_TOAST_MS, description: error instanceof Error ? error.message : String(error) })
  }
}

async function restore(stash: string, label: string): Promise<void> {
  try {
    await git.restoreDiscarded(stash)
    toast.success(`Brought back ${label}`)
  } catch (error) {
    toast.error(`${label} wasn't brought back`, { duration: ACTION_TOAST_MS, description: error instanceof Error ? error.message : String(error) })
  } finally {
    await actions.refreshGit()
  }
}
