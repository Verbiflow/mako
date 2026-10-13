/**
 * A connection's credential, and how it stays good. A token proves who a connection speaks for (an account and a
 * device) for a few minutes. Before it runs out, the connection sends a fresh one in the socket (`renew`), and the
 * gateway answers `renewed` with its expiry, so a connection that lasts hours is never torn down to renew. One that
 * isn't renewed in time is closed: the gateway says why first, then closes with one of `CLOSE_CODES`.
 *
 * The gateway checks that a renewal speaks for the same account and device as the connection did; a token for
 * anyone else closes it.
 */

/** Close codes a client or runtime branches on, said as a frame first since a close can trail it. */
export const CLOSE_CODES = {
  /** The credential ran out or wasn't renewed: fetch a fresh one and connect again. */
  credentialExpired: 4001,
  /** The device was removed or signed out: stop, and sign in again. */
  credentialRevoked: 4003,
} as const

/** What a connection renews itself with: its owner's token supply, which already knows when each token is due. */
export type ConnectionCredential = {
  /** A token good now: the one the connection opened with until it's due, a fresh one after. */
  token(): Promise<string>
  /** How long until the token the connection holds is due for renewal, by the supplier's own measure. */
  renewInMs(): number
}

/** The shortest wait before a renewal, so a supplier whose token is already due can't make a connection spin. */
export const MIN_RENEW_MS = 1_000

/** A connection's renewals: told when the gateway took one, and stopped when the connection ends. */
export type Renewal = { renewed(): void; stop(): void }

/**
 * Renews on schedule: waits until the credential is due, sends a fresh token, and again after each `renewed`. A
 * failed token supply is tried again after the shortest wait.
 */
export function renewal(
  credential: ConnectionCredential,
  send: (token: string) => void
): Renewal {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (ms: number) => {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(() => {
      credential.token().then(
        (token) => {
          if (!stopped) send(token)
        },
        () => schedule(MIN_RENEW_MS)
      )
    }, Math.max(MIN_RENEW_MS, ms))
  }
  schedule(credential.renewInMs())
  return {
    renewed: () => schedule(credential.renewInMs()),
    stop: () => {
      stopped = true
      clearTimeout(timer)
    },
  }
}
