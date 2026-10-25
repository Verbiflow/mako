import { GitBranchIcon } from "lucide-react"
import type { ComposerNotice, ComposerNoticeAction } from "@/extend/notices"
import { useAcp } from "@/state/acp"
import { moveReviews, unsure, useMoveReviews, type MoveReview } from "@/state/workspace-moves"
import { fileCount, stayedPaths } from "@/lib/moved-files"
import { MovedReviewDetail } from "./moved-review-card"

/**
 * After a move, what the person may want to adjust, until they dismiss it:
 * the files Mako took on a best guess (only this Thread was working when
 * they changed), each of which can go back to the project folder, and the
 * files that stayed because Mako couldn't tell, which can follow. Nothing
 * here blocks the agent. A notice producer (`registerNotice`).
 */
export function useMovedReviewNotice(): ComposerNotice | null {
  const activeKey = useAcp((state) => state.activeKey)
  const review = useMoveReviews((state) => (activeKey ? state.reviews[activeKey] : undefined))
  if (!activeKey || !review) return null
  return reviewNotice(activeKey, review)
}

function reviewNotice(conversationId: string, review: MoveReview): ComposerNotice {
  const { outcome, returned, busy } = review
  const guessed = outcome.likely?.paths ?? []
  const unlisted = Math.max(0, (outcome.likely?.files ?? 0) - guessed.length)
  const stayed = unsure(outcome.stayed)
  const rows = [...guessed.map((path) => ({ path, back: false })), ...returned.map((path) => ({ path, back: true }))]
  const working = busy !== null
  const where = review.branch ? `this thread's branch, ${review.branch}` : "this thread's worktree"

  const title = rows.length
    ? guessed.length
      ? `${fileCount(guessed.length + unlisted)} came along on a best guess`
      : `${fileCount(returned.length)} put back in the project folder`
    : `${fileCount(stayed)} stayed in the project folder`
  const one = guessed.length + unlisted === 1
  const description = rows.length
    ? guessed.length
      ? one
        ? `Only this thread was working when it changed, so Mako moved it to ${where}. Put it back if it isn't this thread's.`
        : `Only this thread was working when they changed, so Mako moved them to ${where}. Put back any that aren't this thread's.`
      : returned.length === 1
        ? "It's as it was before the move, and out of the worktree. The agent hears on its next turn."
        : "They're as they were before the move, and out of the worktree. The agent hears on its next turn."
    : stayed === 1
      ? "Mako couldn't tell whether it's this thread's. Bring it if it is."
      : "Mako couldn't tell whether they're this thread's. Bring them if they are."
  const bring = { label: busy === "bring" ? "Bringing…" : stayed === 1 ? "Bring it" : "Bring them", disabled: working, onClick: () => void moveReviews.bring(conversationId) }
  const actions: ComposerNoticeAction[] = !rows.length
    ? [{ ...bring, primary: true }, { label: stayed === 1 ? "Leave it" : "Leave them", disabled: working, title: stayedPaths(outcome).join("\n"), onClick: () => moveReviews.dismiss(conversationId) }]
    : [
        { label: guessed.length ? (guessed.length === 1 ? "Keep it" : "Keep them") : "Done", primary: true, disabled: working, onClick: () => moveReviews.dismiss(conversationId) },
        ...guessed.length > 1 ? [{ label: "Put all back", disabled: working, onClick: () => void moveReviews.putBack(conversationId, guessed) }] : [],
      ]

  return {
    id: "moved-review",
    tone: "info",
    icon: <GitBranchIcon className="text-muted-foreground" />,
    title,
    description: rows.length && guessed.length ? `moved to ${where}` : undefined,
    detail: <MovedReviewDetail conversationId={conversationId} review={review} description={description} />,
    actions,
    data: { "data-move-review": true },
  }
}
