import { toast } from "sonner"
import { HostCallTimeoutError, RuntimeDisconnectedError, isHostReconnectingError } from "@mako/host/contracts/host-connection"
import { errorMessage, type FailureBoundary } from "@mako/host/contracts/error-message"

/** How long a read or a save waits before it's asked again, once. */
export const QUIET_RETRY_MS = 1_500

/** Whether a failure is the connection's (a timeout, a reconnect), not the host's answer: asked again, it may well go. */
export function passing({ error }: FailureBoundary): boolean {
  return error instanceof HostCallTimeoutError || error instanceof RuntimeDisconnectedError || (error instanceof Error && isHostReconnectingError(error))
}

/**
 * A read, or a save that sets a value, asked once more after a moment when the connection failed it, before anyone
 * hears it failed. Never a mutation whose repeat could do something twice, and never a refusal: those are answers.
 * What the first try met goes to the host's log (a window's warnings reach it), not to the person.
 */
export async function quietly<T>(what: string, work: () => Promise<T>, waitMs = QUIET_RETRY_MS): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!passing({ error })) throw error
    console.warn(`Asked again quietly ${JSON.stringify({ what, error: errorMessage({ error }) })}`)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return work()
  }
}

/**
 * A setting that wasn't saved: it's back as it was. A refusal is the host's answer and says why in its words (a rule
 * with no words); a connection that failed twice says only that, its words going to the host's log. `what` names the
 * setting ("Your Fin rules").
 */
export function notSaved(what: string, failure: FailureBoundary): void {
  if (!passing(failure)) {
    toast.error(`${what} wasn't saved`, { description: errorMessage(failure) })
    return
  }
  console.warn(`Not saved ${JSON.stringify({ what, error: errorMessage(failure) })}`)
  toast.error(`${what} wasn't saved`, { description: "It's back as it was. Mako couldn't reach its host; try again in a moment." })
}
