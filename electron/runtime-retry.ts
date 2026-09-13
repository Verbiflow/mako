import { HOST_CALL_REPLAY_WAIT_MS, hostCallReplay, readOnlyHostCalls, replayableHostCalls } from "./contracts/host-call-policy.js"
import { RuntimeDisconnectedError } from "./runtime-connection.js"

/**
 * Calls the window may repeat once the shared host is back: reads, which
 * change nothing, and mutations the host settles by a caller-minted id, which
 * it answers with the first acceptance. Anything else is told its outcome is
 * unknown. The table itself lives in `contracts/host-call-policy.ts` so the
 * dev web bridge reads the same one.
 */
export const recoverableHostCalls: ReadonlySet<string> = readOnlyHostCalls
export { hostCallReplay, replayableHostCalls }

export interface RecoveryLink {
  /** Called once per dropped call, before any retry, so the window can show the reconnect banner. */
  lost(): void
  /** Resolves true once the event stream is attached to a host again, false on timeout. */
  whenConnected(timeoutMs: number): Promise<boolean>
}

/**
 * Run one host call; if the host drops under it and the call is safe to repeat,
 * wait for the reconnect and run it once more against whatever host answers.
 * The second run is marked as attempt 2 so the host can record the replay.
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
    link.lost()
    if (hostCallReplay(channel) === "never") throw error
    if (!(await link.whenConnected(timeoutMs))) throw error
    return run(2)
  }
}
