/**
 * A connection's credential, and how it stays good. A token proves who a connection speaks for (an account and a
 * device) for a few minutes. Before it runs out, the connection sends a fresh one in the socket (`renew`), and the
 * gateway answers `renewed` with its expiry, so a connection that lasts hours is never torn down to renew. One that
 * isn't renewed in time is closed: the gateway says why first, then closes with one of `CLOSE_CODES`.
 *
 * The gateway checks that a renewal speaks for the same account and device as the connection did; a token for
 * anyone else closes it.
 */

/** The subprotocol every connection offers first, and the one the gateway answers with. */
export const SUBPROTOCOL = "mako.v1"
/** A credential rides as a connection's second subprotocol: a browser can't set headers on a WebSocket. */
export const CREDENTIAL_SUBPROTOCOL_PREFIX = "mako.token."

/** What a connection offers as it opens with a credential: `mako.v1, mako.token.<credential>`. */
export function subprotocols(credential: string): [string, string] {
  return [SUBPROTOCOL, `${CREDENTIAL_SUBPROTOCOL_PREFIX}${credential}`]
}

/** The credential offered beside `mako.v1` in a `Sec-WebSocket-Protocol` header; undefined without both. */
export function offeredCredential(
  header: string | null | undefined
): string | undefined {
  const offered = (header ?? "").split(",").map((entry) => entry.trim())
  if (!offered.includes(SUBPROTOCOL)) return undefined
  const credential = offered
    .find((entry) => entry.startsWith(CREDENTIAL_SUBPROTOCOL_PREFIX))
    ?.slice(CREDENTIAL_SUBPROTOCOL_PREFIX.length)
  return credential || undefined
}

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
/** A renewal the gateway hasn't answered in this long is sent again: renewing is idempotent. */
export const RENEWED_WITHIN_MS = 15_000
/**
 * How long to wait after each failed attempt in a row: a token supply that failed, or a renewal left unanswered.
 * A token is due well before it runs out (a minute, by the host's measure), and the gateway allows 30 s past its
 * expiry, so a blip in the token supply is ridden out and the connection never notices.
 */
export const RENEW_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const

/** A connection's renewals: told when the gateway took one, and stopped when the connection ends. */
export type Renewal = { renewed(): void; stop(): void }

/**
 * Renews on schedule: waits until the credential is due, sends a fresh token, and again after each `renewed`. A
 * token supply that fails, or a renewal the gateway doesn't answer, is tried again with backoff until the
 * connection ends; a connection that still runs out is closed by the gateway, and its owner connects again.
 */
export function renewal(
  credential: ConnectionCredential,
  send: (token: string) => void
): Renewal {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let failures = 0
  const retry = () =>
    schedule(
      RENEW_RETRY_MS[Math.min(failures++, RENEW_RETRY_MS.length - 1)] ??
        MIN_RENEW_MS
    )
  const schedule = (ms: number) => {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(() => {
      credential.token().then(
        (token) => {
          if (stopped) return
          send(token)
          // Answered by `renewed`; otherwise sent again.
          clearTimeout(timer)
          timer = setTimeout(retry, RENEWED_WITHIN_MS)
        },
        () => retry()
      )
    }, Math.max(MIN_RENEW_MS, ms))
  }
  schedule(credential.renewInMs())
  return {
    renewed: () => {
      failures = 0
      schedule(credential.renewInMs())
    },
    stop: () => {
      stopped = true
      clearTimeout(timer)
    },
  }
}
