import { toast } from "sonner"
import { getMako } from "@/lib/bridge"
import type { LiveActionInput } from "@/lib/types"
import { applyLiveSnapshot } from "./live-recovery"

/** A saved receipt owns the draft even when the HTTP response is lost. */
export async function performLiveAction(
  id: string,
  input: LiveActionInput
): Promise<boolean> {
  try {
    const result = await getMako().liveAction(id, input)
    if (result.state.kind === "not-accepted" || result.state.kind === "failed") {
      toast.error(result.state.reason)
      return false
    }
    if (result.state.kind === "uncertain") toast.error(result.state.reason)
    return true
  } catch (error) {
    const snapshot = await getMako()
      .liveSnapshot(id)
      .catch(() => null)
    if (snapshot) {
      applyLiveSnapshot(snapshot)
      const receipt = snapshot.control?.actions?.find(
        (action) => action.input.id === input.id
      )
      if (receipt && receipt.state.kind !== "not-accepted") return true
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
