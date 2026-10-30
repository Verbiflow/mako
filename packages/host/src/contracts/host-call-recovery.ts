import { HOST_CALL_REPLAY_WAIT_MS, hostCallReplay } from "./host-call-policy.js"
import { RuntimeDisconnectedError } from "./host-connection.js"

export interface RecoveryLink {
  /**
   * A call dropped. One call is no proof the host has gone: the link checks (`HostLiveness`) and says so to the
   * window only if the host doesn't show itself. Resolves true once a host is there to run the call again on, this
   * one still alive or the one the event stream attached to since, and false if none is by `timeoutMs`.
   */
  dropped(timeoutMs: number): Promise<boolean>
}

/**
 * Run one host call; if the host drops under it and the call is safe to repeat,
 * run it once more as soon as a host answers: the same one, found still alive,
 * or the one the window reconnected to. The second run is marked as attempt 2
 * so the host can record the replay. A call the host is only slow to answer
 * (`HostCallTimeoutError`) is no drop and passes straight through.
 */
export async function invokeWithRecovery<T>(
  channel: string,
  run: (attempt: number) => Promise<T>,
  link: RecoveryLink,
  timeoutMs = HOST_CALL_REPLAY_WAIT_MS
): Promise<T> {
  try {
    return await run(1)
  } catch (error) {
    if (!(error instanceof RuntimeDisconnectedError)) throw error
    // Losing a read reply never makes a user action's delivery uncertain.
    const failure = hostCallReplay(channel) === "read"
      ? new RuntimeDisconnectedError(false, error.conversationId) : error
    if (failure.conversationId) throw failure
    // Never repeated, so there is nothing to wait for; whether the host is gone is the event stream's to say.
    if (hostCallReplay(channel) === "never") throw failure
    if (!(await link.dropped(timeoutMs))) throw failure
    try { return await run(2) }
    catch (retryError) {
      // A later refusal cannot resolve whether the first mutation was accepted.
      if (error.unconfirmed && hostCallReplay(channel) === "replay") throw error
      if (retryError instanceof RuntimeDisconnectedError && hostCallReplay(channel) === "read")
        throw new RuntimeDisconnectedError(false, retryError.conversationId)
      throw retryError
    }
  }
}
