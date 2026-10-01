import { readLiveSnapshot } from "@/state/live-history"
import { getMako } from "@/lib/bridge"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { ANSWERED_DIFFERENTLY } from "../../electron/contracts/approval-response"
import type { LivePermissionResponse } from "../../electron/contracts/providers-acp"
import { toast } from "sonner"

/**
 * Recover the saved receipt after either RPC outcome; never resend an answer
 * here. The host keeps the first answer and records the plan an approval
 * builds, so a click that lost to another window's answer only says so.
 */
export async function answerLiveApproval(id: string, requestId: string, response: LivePermissionResponse): Promise<void> {
  let failure: unknown
  try { await getMako().livePermission(id, requestId, response) } catch (error) { failure = error }
  const snapshot = await readLiveSnapshot(id).catch(() => null)
  if (snapshot) applyLiveSnapshot(snapshot)
  if (!failure) return
  const message = failure instanceof Error ? failure.message : String(failure)
  if (message.includes(ANSWERED_DIFFERENTLY)) {
    toast("Already answered", { description: "Someone answered this first, in another window or on another computer. Their answer stands." })
    return
  }
  if (!snapshot?.control?.approvalResponses?.some(receipt => receipt.id === requestId)) toast.error(message)
}
