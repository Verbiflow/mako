import { HarnessIcon } from "@/components/ui/provider-icon"
import { useHarnessLabels } from "@/lib/harness-label"
import type { ComposerNotice } from "@/extend/notices"
import { useAcp } from "@/state/acp"
import { answerThreadMoveAsk, threadMoveAskFor, useThreadMoveAsks } from "@/state/thread-move-asks"

/**
 * The agent on screen asked, through `thread_move` below full access, to move its Thread to the cloud. Allowed, it
 * moves as Move to the cloud does: a Thread in its own worktree hands off, its running turn going on there; one in the
 * main checkout goes onto its own branch first, once its turns end. A notice producer (`registerNotice`).
 */
export function useThreadMoveAskNotice(): ComposerNotice | null {
  const labels = useHarnessLabels()
  const activeKey = useAcp((state) => state.activeKey)
  const ask = useThreadMoveAsks((state) => threadMoveAskFor(state.asks, activeKey))
  if (!ask) return null
  const name = labels[ask.harness] ?? ask.harness
  return {
    id: "thread-move-ask",
    tone: "caution",
    priority: 0,
    icon: <HarnessIcon harness={ask.harness} />,
    title: `${name} wants to move this thread to the cloud`,
    description: ask.handsOff ? "with its worktree, branch and sessions" : "onto its own branch first, then the cloud",
    detail: (
      <p>
        {ask.handsOff
          ? "Its worktree, branch and every session go to a cloud machine. A turn still running pauses here and goes on there."
          : "Only its own changes leave the project folder for a new branch, once this turn ends; then it moves to a cloud machine."}
      </p>
    ),
    actions: [
      { label: "Move to the cloud", primary: true, onClick: () => void answerThreadMoveAsk(ask.id, true) },
      { label: "Keep here", onClick: () => void answerThreadMoveAsk(ask.id, false) },
    ],
    data: { "data-thread-move-ask": "asking" },
  }
}
