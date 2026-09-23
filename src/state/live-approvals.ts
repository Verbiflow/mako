import { getMako } from "@/lib/bridge"
import { applyLiveSnapshot } from "@/state/live-recovery"
import type { LivePermissionResponse } from "../../electron/contracts/providers-acp"
import { toast } from "sonner"

/** Recover the saved receipt after either RPC outcome; never resend an answer here. */
export async function answerLiveApproval(id: string, requestId: string, response: LivePermissionResponse): Promise<void> {
  let failure: unknown
  try { await getMako().livePermission(id, requestId, response) } catch (error) { failure = error }
  const snapshot = await getMako().liveSnapshot(id).catch(() => null)
  if (snapshot) applyLiveSnapshot(snapshot)
  if (failure && !snapshot?.control?.approvalResponses?.some(receipt => receipt.id === requestId))
    toast.error(failure instanceof Error ? failure.message : String(failure))
}
