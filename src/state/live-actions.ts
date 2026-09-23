import { toast } from "sonner"
import { getMako } from "@/lib/bridge"
import type { LiveActionInput } from "@/lib/types"
import { actionRetainsInput } from "../../electron/contracts/operation-recovery"
import { applyLiveSnapshot } from "./live-recovery"

/** A saved receipt owns the draft even when the HTTP response is lost. */
export async function performLiveAction(
  id: string,
  input: LiveActionInput
): Promise<boolean> {
  try {
    const result = await getMako().liveAction(id, input)
    if (result.state.kind === "not-accepted") {
      toast.error(result.state.reason)
      return false
    }
    if (result.state.kind === "uncertain" || result.state.kind === "failed") toast.error(result.state.reason)
    return actionRetainsInput(result)
  } catch (error) {
    const snapshot = await getMako()
      .liveSnapshot(id)
      .catch(() => null)
    if (snapshot) {
      applyLiveSnapshot(snapshot)
      const receipt = snapshot.control?.actions?.find(
        (action) => action.input.id === input.id
      )
      if (receipt) {
        if (receipt.state.kind === "not-accepted") toast.error(receipt.state.reason)
        return actionRetainsInput(receipt)
      }
    }
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

export async function acknowledgeLiveAction(
  id: string,
  actionId: string
): Promise<void> {
  try {
    await getMako().liveAcknowledgeAction(id, actionId)
    const snapshot = await getMako().liveSnapshot(id)
    if (snapshot) applyLiveSnapshot(snapshot)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}
