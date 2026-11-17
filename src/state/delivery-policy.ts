import { HostCallTimeoutError, isHostReconnectingError } from "@mako/host/contracts/host-connection"

/** How long one try of a message may wait for the host's answer before it waits in the outbox instead. */
export const DELIVERY_PATIENCE_MS = 20_000

/** A try the host hadn't answered within `DELIVERY_PATIENCE_MS`: the host may still take it, under the same ID. */
export class DeliveryWaitError extends Error {
  constructor() {
    super("Mako hasn't answered yet")
    this.name = "DeliveryWaitError"
  }
}

/**
 * Host refusals that only mean "not yet": the host is busy with something the message waits behind, matched by the
 * host's own words (`LiveConversations.submit`, `LiveActions.submit`, `executionRefusal`, the Cursor driver's prompt)
 * and said in the row's: the host's words name its internals ("pending operation", "provider action") and end in an
 * instruction the person needn't follow, since the message goes by itself.
 */
const BUSY: ReadonlyArray<readonly [RegExp, string]> = [
  [/Wait for the workspace rewind to finish/i, "Waiting for a rewind to finish"],
  [/Wait for this conversation to connect and finish its pending operation/i, "Waiting for the agent to connect"],
  [/A provider switch is pending/i, "Waiting for the switch to another agent"],
  [/Resolve the previous provider action/i, "Waiting for the agent's last action to finish"],
  [/is still ending the previous turn/i, "Waiting for the agent to end its last turn"],
  [/This session is moving to /i, "Waiting for this session's move"],
]

/** The row's words for a message that waits for a reason no rule names: the host's own words go to the log. */
export const WAITING_FOR_MAKO = "Waiting for Mako"

/**
 * Why a message the host didn't take waits in this device's outbox, in the words its row shows; undefined when the
 * host refused it for good. A message that waits keeps its place and goes again under its one ID, which the host
 * takes once (`LiveConversations.submit`), so asking again never sends it twice.
 */
export function waitsFor(error: Error): string | undefined {
  if (error instanceof DeliveryWaitError || error instanceof HostCallTimeoutError) return "Waiting for Mako, which hasn't answered yet"
  if (isHostReconnectingError(error)) return "Waiting for Mako to reconnect"
  return BUSY.find(([pattern]) => pattern.test(error.message))?.[1]
}

/** `promise`, or `DeliveryWaitError` once `ms` passed without its answer. */
export function withinPatience<T>(promise: Promise<T>, ms = DELIVERY_PATIENCE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = quietTimer(() => reject(new DeliveryWaitError()), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** A timer that doesn't keep a script's process alive while it waits, as a page's never does. */
export function quietTimer(run: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(run, ms)
  // A page's timer is a number; Node's is an object with `unref`.
  const handle: unknown = timer
  if (handle instanceof Object && "unref" in handle && handle.unref instanceof Function) handle.unref()
  return timer
}
