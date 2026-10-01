import { readLiveSnapshot } from "@/state/live-history"
import { getMako } from "@/lib/bridge"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp-state"
import { recordPlanBuild } from "@/state/plan-builds"
import type { LivePermissionResponse } from "../../electron/contracts/providers-acp"
import { toast } from "sonner"

/** Recover the saved receipt after either RPC outcome; never resend an answer here. */
export async function answerLiveApproval(id: string, requestId: string, response: LivePermissionResponse): Promise<void> {
  const conversation = acpStore.get().conversations[id]
  const asked = conversation?.kind === "live" && conversation.permission?.id === requestId ? conversation.permission : null
  const builds = asked?.implementsPlan && response.kind === "choice" && response.optionId === asked.implementsPlan.approve
    ? asked.implementsPlan.plan : undefined
  let failure: unknown
  try { await getMako().livePermission(id, requestId, response) } catch (error) { failure = error }
  const snapshot = await readLiveSnapshot(id).catch(() => null)
  if (snapshot) applyLiveSnapshot(snapshot)
  const answered = !failure || snapshot?.control?.approvalResponses?.some(receipt => receipt.id === requestId)
  if (answered && builds) recordPlanBuild({ id: builds }, { conversation: id })
  if (!answered) toast.error(failure instanceof Error ? failure.message : String(failure))
}
