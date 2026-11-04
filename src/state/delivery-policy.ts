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
 * Host refusals that only mean "not yet": the host is busy with something the message waits behind. Each is the
 * host's own words (`LiveConversations.submit`, `LiveActions.submit`, `executionRefusal`, the Cursor driver's prompt).
 */
const BUSY = [
  /Wait for the workspace rewind to finish/i,
  /Wait for this conversation to connect and finish its pending operation/i,
  /A provider switch is pending/i,
  /Resolve the previous provider action/i,
  /is still ending the previous turn/i,
  /This session is moving to /i,
]

/**
 * Why a message the host didn't take waits in this device's outbox, in the words its row shows; undefined when the
 * host refused it for good. A message that waits keeps its place and goes again under its one ID, which the host
 * takes once (`LiveConversations.submit`), so asking again never sends it twice.
 */
export function waitsFor(error: Error): string | undefined {
  if (error instanceof DeliveryWaitError || error instanceof HostCallTimeoutError) return "Mako is busy and hasn't answered yet"
  if (isHostReconnectingError(error)) return "Waiting for Mako to reconnect"
  if (BUSY.some((pattern) => pattern.test(error.message))) return error.message.replace(/\s*(Send (the message )?again[^.]*\.|Try again[^.]*\.)\s*$/i, "")
  return undefined
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
