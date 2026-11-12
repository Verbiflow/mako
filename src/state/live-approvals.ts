import { getMako } from "@/lib/bridge"
import { readBackLive } from "@/state/live-recovery"
import { ANSWERED_DIFFERENTLY } from "@mako/host/contracts/approval-response"
import type { LivePermissionResponse } from "@mako/host/contracts/providers-acp"
import { toast } from "sonner"

/**
 * Recover the saved receipt after either RPC outcome; never resend an answer
 * here. The host keeps the first answer and records the plan an approval
 * builds, so a click that lost to another window's answer only says so.
 * True only when the host took this answer.
 */
export async function answerLiveApproval(id: string, requestId: string, response: LivePermissionResponse): Promise<boolean> {
  let failure: unknown
  try { await getMako().livePermission(id, requestId, response) } catch (error) { failure = error }
  // Read back as it lands, which may be after newer batches: one older than what this window took meanwhile is past.
  const snapshot = await readBackLive(id)
  if (!failure) return true
  const message = failure instanceof Error ? failure.message : String(failure)
  if (message.includes(ANSWERED_DIFFERENTLY)) {
    toast("Already answered", { description: "Someone answered this first, in another window or on another computer. Their answer stands." })
    return false
  }
  if (!snapshot?.control?.approvalResponses?.some(receipt => receipt.id === requestId)) toast.error(message)
  return false
}
