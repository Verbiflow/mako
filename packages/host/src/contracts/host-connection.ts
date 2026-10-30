/**
 * One wording for "the shared host went away mid-call".
 *
 * The host says it when it closes with requests still pending, the client says
 * it when the socket drops under a call, and the renderer matches on it so a
 * refresh that failed for this reason rides the reconnect banner instead of
 * raising a second alarm. Kept free of imports so both sides can share it.
 */
/** The host closed with this call already dispatched; its outcome is unknown. */
export const HOST_RESTARTING_CODE = "host-restarting"
/** The call reached a host that had already begun closing; nothing ran. */
export const HOST_CLOSED_CODE = "host-closed"
export const HOST_RECONNECTING_MESSAGE =
  "The connection to Mako's shared host was interrupted. This window reconnects on its own."
export const HOST_CALL_UNCONFIRMED_MESSAGE = `${HOST_RECONNECTING_MESSAGE} The last action was not confirmed; check its result before repeating it.`
/**
 * The same, for a cloud Thread: what was asked hasn't reached it yet, and goes on by itself. The person reads it only
 * where a toast is the answer (a stop, a mode); a message or a start keeps waiting quietly, as on a reconnect.
 */
export const CLOUD_RECONNECTING_MESSAGE = "Reconnecting to this cloud Thread. It carries on by itself."
export const CLOUD_CALL_UNCONFIRMED_MESSAGE = `${CLOUD_RECONNECTING_MESSAGE} Check that your last action went through before repeating it.`
/**
 * The reconnect banner. Messages and agent commands carry ids the host
 * settles once, so a client re-issues them when the host is back; a commit, a
 * push or shell input has no such receipt and is left to the user.
 */
export const HOST_OUTAGE_MESSAGE =
  "Reconnecting to the shared Mako host. Messages and agent commands sent meanwhile are delivered once it is back; commits, pushes and shell input are not repeated."

export function isHostReconnectingError(error: Error): boolean {
  return error.message.includes(HOST_RECONNECTING_MESSAGE) || error.message.includes(CLOUD_RECONNECTING_MESSAGE) ||
    // An older owning host or Electron IPC may still supply the old wording.
    error.message.includes("Mako's shared host is restarting. This window reconnects on its own.")
}

/** Delivery state survives forwarding; a peer outage does not disconnect the UI's own host. */
export class RuntimeDisconnectedError extends Error {
  readonly code = "host-disconnected"
  readonly unconfirmed: boolean
  readonly conversationId?: string
  /** `message`: what the person reads, where the host that didn't answer isn't this Mac's (a cloud Thread's). */
  constructor(unconfirmed: boolean, conversationId?: string, message?: string) {
    super(message ?? (unconfirmed ? HOST_CALL_UNCONFIRMED_MESSAGE : HOST_RECONNECTING_MESSAGE))
    this.name = "RuntimeDisconnectedError"
    this.unconfirmed = unconfirmed
    this.conversationId = conversationId
  }
}

export const HOST_CALL_SLOW_MESSAGE = "Mako's shared host is busy and didn't answer in time. Try again in a moment."
export const HOST_CALL_SLOW_UNCONFIRMED_MESSAGE =
  "Mako's shared host is busy and hasn't answered yet. The last action was not confirmed; check its result before repeating it."

/**
 * A call the host took but didn't answer before its deadline. The host is slow, not gone: whether it is still there
 * is the event stream's to say, so this never raises the reconnect banner and is never repeated by itself.
 * `unconfirmed`: a mutation whose outcome is unknown.
 */
export class HostCallTimeoutError extends Error {
  readonly code = "host-call-timeout"
  readonly unconfirmed: boolean
  constructor(unconfirmed: boolean) {
    super(unconfirmed ? HOST_CALL_SLOW_UNCONFIRMED_MESSAGE : HOST_CALL_SLOW_MESSAGE)
    this.name = "HostCallTimeoutError"
    this.unconfirmed = unconfirmed
  }
}

/**
 * The host a call was for isn't connected: another device's runtime that's off or asleep, as the cloud says when it
 * refuses the call unapplied (`owner-unavailable`). A disconnect like any other to whoever doesn't ask; a reader that
 * can answer from elsewhere (the account's copy of a Session) tells it from its own connection's loss.
 */
export class OwnerUnavailableError extends RuntimeDisconnectedError {
  constructor(unconfirmed: boolean, conversationId?: string, message?: string) {
    super(unconfirmed, conversationId, message)
    this.name = "OwnerUnavailableError"
  }
}
