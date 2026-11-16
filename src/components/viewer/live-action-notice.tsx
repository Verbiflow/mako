import { compactionRecovering } from "@mako/host/contracts/conversation-control"
import { describeProviderFailure } from "@mako/host/contracts/provider-failure"
import { useAcp, activeLiveAcp } from "@/state/acp"
import { actionNotice, describeActionRecovery } from "@mako/host/contracts/operation-recovery"
import { acknowledgeLiveAction } from "@/state/live-actions"
import type { ComposerNotice } from "@/extend/notices"

/** The person's newest compaction or steering command above the composer while it runs, or while what went wrong still stands. */
export function useLiveActionNotice(): ComposerNotice | null {
  const id = useAcp((state) => state.activeKey)
  const control = useAcp((state) => activeLiveAcp(state)?.control)
  const episode = control?.compactionRecovery
  const actionEpisode = episode?.origin === "native" ? undefined : episode
  const actions = control?.actions?.filter(action => action.input.id !== actionEpisode?.actionId && (action.input.id !== actionEpisode?.retryActionId || episode?.state.kind === "withdrawn" && episode.state.reason === "superseded"))
  const requests = useAcp((state) => activeLiveAcp(state)?.requests)
  if (id && episode && compactionRecovering(episode) && episode.bindingId === control?.activeBindingId) {
    const transfer = episode.state.kind === "replace" ? control.transfers.find(item => episode.state.kind === "replace" && item.input.id === episode.state.transferId) : undefined
    // A specific transfer failure owns its one fixing action; don't cover it with a second progress notice.
    if (transfer?.state.kind === "failed" || transfer?.state.kind === "uncertain") return null
    const confirming = episode.state.kind === "reconcile" ? episode.state : undefined
    const originalWorking = confirming && control.actions?.some(action => action.input.id === confirming.actionId && ["dispatching", "accepted"].includes(action.state.kind))
    return { id: `compaction-recovery:${episode.id}`, tone: "progress",
      title: originalWorking ? "Compacting conversation" : "Recovering conversation", description: confirming ? "Waiting for the native result before continuing."
        : episode.state.kind === "retry" ? "Retrying compaction once." : "Starting a fresh session with the retained conversation.",
      data: { "data-compaction-recovery": episode.id } }
  }
  const action = actionNotice(actions, requests ?? [])
  if (!id || !action) return null
  const state = action.state
  const failure = state.kind === "failed" && state.failureEvidence ? describeProviderFailure(state.failureEvidence.kind) : undefined
  const recovery = failure ?? describeActionRecovery(action)
  const fixesAccount = failure && ["auth", "permission", "sign-in-check", "wrong-account", "plan"].includes(failure.kind)
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
    actions: fixesAccount ? [{ label: failure.kind === "auth" ? "Sign in" : "Check account", primary: true,
      onClick: () => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" })) }]
      : state.kind === "uncertain"
      ? [{ label: action.input.kind === "compact" ? "Disconnect and keep history" : "Acknowledge without resending", primary: true, onClick: () => void acknowledgeLiveAction(id, action.input.id) }]
      : undefined,
    data: { "data-action-recovery": action.input.id },
  }
}
