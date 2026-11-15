import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
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

/** How a save that didn't go is said: what pressing Try again does, and whether the person's words stay where they typed them. */
export interface NotSavedOptions {
  /** The same save again, as the button's one action. */
  retry: () => Promise<void>
  /** The words stay in their field, marked unsaved, rather than going back to what was saved. */
  kept?: boolean
}

/**
 * A setting that wasn't saved, with its one action. A refusal is the host's answer and says why in its words (a rule
 * with no words): the same save would meet it again, so the words are all it says. A connection that failed twice
 * offers Try again, which runs the same save; its words go to the host's log. `title` says what ("Your rules weren't
 * saved").
 */
export function notSaved(title: string, failure: FailureBoundary, options: NotSavedOptions): void {
  if (!passing(failure)) {
    toast.error(title, { description: errorMessage(failure) })
    return
  }
  console.warn(`Not saved ${JSON.stringify({ title, error: errorMessage(failure) })}`)
  toast.error(title, {
    duration: ACTION_TOAST_MS,
    description: `${options.kept ? "Your words are still in the field." : "It's back as it was."} Mako couldn't reach its host.`,
    action: { label: "Try again", onClick: () => void options.retry().catch((error: Error) => notSaved(title, { error }, options)) },
  })
}
