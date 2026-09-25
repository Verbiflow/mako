import { activeLiveAcp, useAcp } from "@/state/acp"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { describeApprovalResponse, nativeApprovalMatchesAnswer, sameApprovalOrigin } from "../../../electron/contracts/approval-response"
import { Notice } from "@/components/ui/notice"

export function ApprovalStatus({ history = false }: { history?: boolean }) {
  const id = useAcp(state => state.activeKey)
  const receipt = useAcp(state => activeLiveAcp(state)?.control?.approvalResponses?.at(-1))
  const permission = useAcp(state => activeLiveAcp(state)?.permission)
  const key = id && receipt ? `approval:${id}:${receipt.id}` : ""
  const dismissed = usePrefs(state => state.dismissedRecoveryRequests[key])
  if (!id || !receipt) return null
  const status = receipt.nativeDecision ? nativeApprovalMatchesAnswer(receipt) ? "native-confirmed" : "native-different" : receipt.state.kind
  if (!history && (status === "submitted" || status === "native-confirmed" || dismissed === status ||
    (permission && permission.id !== receipt.id && (!permission.origin || !sameApprovalOrigin(permission.origin, receipt.origin))))) return null
  const description = describeApprovalResponse(receipt, Boolean(permission?.origin && sameApprovalOrigin(permission.origin, receipt.origin) && permission.id !== receipt.id))
  return <Notice
    data-approval-recovery={receipt.id}
    title={description.title}
    description={description.guidance}
    tone={description.tone}
    surface={history ? "flush" : "card"}
    className={history ? undefined : "mx-3 mb-2"}
    onDismiss={history ? undefined : () => setPref("dismissedRecoveryRequests", {
      ...prefsStore.get().dismissedRecoveryRequests, [key]: status,
    })}
  />
}
