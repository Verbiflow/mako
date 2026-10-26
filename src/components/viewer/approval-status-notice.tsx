import { activeLiveAcp, useAcp } from "@/state/acp"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { describeApprovalResponse, nativeApprovalMatchesAnswer, sameApprovalOrigin } from "@mako/host/contracts/approval-response"
import type { ComposerNotice } from "@/extend/notices"

/** The newest answer's receipt above the composer, while it says something a person must know; dismissed per receipt state. */
export function useApprovalStatusNotice(): ComposerNotice | null {
  const id = useAcp(state => state.activeKey)
  const receipt = useAcp(state => activeLiveAcp(state)?.control?.approvalResponses?.at(-1))
  const permission = useAcp(state => activeLiveAcp(state)?.permission)
  const key = id && receipt ? `approval:${id}:${receipt.id}` : ""
  const dismissed = usePrefs(state => state.dismissedRecoveryRequests[key])
  if (!id || !receipt) return null
  const status = receipt.nativeDecision ? nativeApprovalMatchesAnswer(receipt) ? "native-confirmed" : "native-different" : receipt.state.kind
  if (status === "submitted" || status === "native-confirmed" || dismissed === status ||
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
