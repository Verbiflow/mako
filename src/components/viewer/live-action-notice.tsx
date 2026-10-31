import { useAcp, activeLiveAcp } from "@/state/acp"
import { actionNoticeCurrent, describeActionRecovery } from "@mako/host/contracts/operation-recovery"
import { acknowledgeLiveAction } from "@/state/live-actions"
import type { ComposerNotice } from "@/extend/notices"

/** The newest compaction or steering command above the composer while it runs, or while what went wrong still stands. */
export function useLiveActionNotice(): ComposerNotice | null {
  const id = useAcp((state) => state.activeKey)
  const action = useAcp((state) => activeLiveAcp(state)?.control?.actions?.at(-1))
  const requests = useAcp((state) => activeLiveAcp(state)?.requests)
  if (!id || !action || !actionNoticeCurrent(action, requests ?? [])) return null
  const state = action.state
  const recovery = describeActionRecovery(action)
  const troubled = state.kind === "uncertain" || state.kind === "not-accepted" || state.kind === "failed"
  return {
    id: `live-action:${action.input.id}`,
    tone: state.kind === "failed" || state.kind === "not-accepted" ? "danger" : state.kind === "uncertain" ? "caution" : "progress",
    title: recovery.title,
    description: recovery.guidance,
    detail: (troubled && state.reason) || action.input.kind !== "compact" ? (
      <>
        {troubled && state.reason ? <p className="text-faint">{state.reason}</p> : null}
        {action.input.kind !== "compact" ? <p className="mt-1.5 whitespace-pre-wrap">{action.input.text}</p> : null}
      </>
    ) : undefined,
    actions: state.kind === "uncertain"
      ? [{ label: action.input.kind === "compact" ? "Disconnect and keep history" : "Acknowledge without resending", primary: true, onClick: () => void acknowledgeLiveAction(id, action.input.id) }]
      : undefined,
    data: { "data-action-recovery": action.input.id },
  }
}
