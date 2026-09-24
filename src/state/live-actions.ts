import { readLiveSnapshot } from "@/state/live-history"
import { toast } from "sonner"
import { z } from "zod"
import { getMako } from "@/lib/bridge"
import type { LiveActionInput } from "@/lib/types"
import { actionRetainsInput } from "../../electron/contracts/operation-recovery"
import { applyLiveSnapshot } from "./live-recovery"

// Older desktop preloads still route every action through live-action. Read
// their exact pre-dispatch rejection until those clients have been retired.
const legacyActionRejection = z.array(z.object({
  code: z.literal("invalid_union"),
  path: z.tuple([z.literal(1)]),
  errors: z.array(z.array(z.object({
    code: z.literal("invalid_value"),
    path: z.tuple([z.literal("kind")]),
    values: z.array(z.string()),
  }))),
}))

function actionError(input: LiveActionInput, message: string): string {
  if (input.kind !== "steer-queued") return message
  let unsupported = /newer shared host|unknown mako host method.*live-steer-queued/i.test(message)
  try {
    const parsed = legacyActionRejection.safeParse(JSON.parse(message))
    unsupported ||= parsed.success && parsed.data.some((issue) => {
      const kinds = issue.errors.flatMap((errors) => errors.flatMap((item) => item.values))
      return kinds.includes("steer") && kinds.includes("compact") && !kinds.includes("steer-queued")
    })
  } catch { /* Ordinary error text is not a schema rejection. */ }
  return unsupported
    ? "The running host needs an update to steer queued messages. Your message is still queued. You can send a new message from the composer to steer the current turn."
    : message
}

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
    const snapshot = await readLiveSnapshot(id)
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
    toast.error(actionError(input, error instanceof Error ? error.message : String(error)))
    return false
  }
}

export async function acknowledgeLiveAction(
  id: string,
  actionId: string
): Promise<void> {
  try {
    await getMako().liveAcknowledgeAction(id, actionId)
    const snapshot = await readLiveSnapshot(id)
    if (snapshot) applyLiveSnapshot(snapshot)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}
