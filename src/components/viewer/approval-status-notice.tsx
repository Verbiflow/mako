import { activeLiveAcp, useAcp } from "@/state/acp"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { describeApprovalResponse, nativeApprovalMatchesAnswer, sameApprovalOrigin } from "@mako/host/contracts/approval-response"
import { useLasting } from "@/components/ui/use-lasting"
import type { ComposerNotice } from "@/extend/notices"

/**
 * An answer still on its way after this is worth saying. The host saves an
 * answer as sending, then as handed over, in the same moment for every
 * harness whose connection takes it at once: a notice for that would draw a
 * bar for a frame and take it away, so the click's own news is the approval
 * card going and the live step naming the call that now runs.
 */
export const APPROVAL_SENDING_SHOWN_AFTER_MS = 1_000

/** The newest answer's receipt above the composer, while it says something a person must know; dismissed per receipt state. */
export function useApprovalStatusNotice(): ComposerNotice | null {
  const id = useAcp(state => state.activeKey)
  const receipt = useAcp(state => activeLiveAcp(state)?.control?.approvalResponses?.at(-1))
  const permission = useAcp(state => activeLiveAcp(state)?.permission)
  const key = id && receipt ? `approval:${id}:${receipt.id}` : ""
  const dismissed = usePrefs(state => state.dismissedRecoveryRequests[key])
  const status = !receipt ? undefined : receipt.nativeDecision ? nativeApprovalMatchesAnswer(receipt) ? "native-confirmed" : "native-different" : receipt.state.kind
  const slow = useLasting(status === "dispatching" ? receipt?.id : undefined, APPROVAL_SENDING_SHOWN_AFTER_MS)
  if (!id || !receipt || !status) return null
  if (status === "submitted" || status === "native-confirmed" || dismissed === status || (status === "dispatching" && !slow) ||
    (permission && permission.id !== receipt.id && (!permission.origin || !sameApprovalOrigin(permission.origin, receipt.origin)))) return null
  const description = describeApprovalResponse(receipt, Boolean(permission?.origin && sameApprovalOrigin(permission.origin, receipt.origin) && permission.id !== receipt.id))
  return {
    id: `approval-status:${receipt.id}`,
    tone: description.tone,
    title: description.title,
    description: description.guidance,
    onDismiss: () => setPref("dismissedRecoveryRequests", { ...prefsStore.get().dismissedRecoveryRequests, [key]: status }),
    data: { "data-approval-recovery": receipt.id },
  }
}
