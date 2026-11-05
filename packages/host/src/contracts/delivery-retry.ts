import type { LiveRequest } from "./live-conversations.js"
import { permanentFailure, type ProviderFailureKind } from "./provider-failure.js"

/**
 * Why a message that didn't reach its harness waits and goes again by itself
 * rather than failing: the harness's service was at capacity or rate-limited
 * (its usage limit included), failed on its side, the network dropped, it
 * went quiet starting, or its session was busy in another process, Mako's own
 * one still closing included. Each clears without anyone doing anything, so
 * none is a failure the person has to act on.
 */
export type RetryCause = "rate-limited" | "provider-unavailable" | "network" | "launch-stalled" | "busy"

/** A held message's next attempt (`LiveRequest.retry`): when, which one, since when it has waited, and why. */
export interface RequestRetry {
  at: number
  attempt: number
  since: number
  cause: RetryCause
  /** The harness's own words for the last failure, for Details. */
  reason: string
}

/** The waits between attempts, the last repeating: a usage limit that resets in hours is tried every ten minutes until it does. */
export const RETRY_STEPS_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000] as const

/**
 * How long each cause is waited out before Mako stops and the message fails with its card. A usage limit resets
 * within hours, so a rate limit is waited for six; a service, a network or a start that stays broken an hour is
 * something the person should hear about; a session open elsewhere for half an hour is theirs, not a passing hold.
 */
export const GIVE_UP_MS = {
  "rate-limited": 6 * 60 * 60_000,
  "provider-unavailable": 60 * 60_000,
  network: 60 * 60_000,
  "launch-stalled": 60 * 60_000,
  busy: 30 * 60_000,
} as const satisfies Record<RetryCause, number>

/** The cause a failure is waited out for, or undefined when it's one the person must act on. */
export function retryCause(kind: ProviderFailureKind, busy: boolean): RetryCause | undefined {
  if (busy) return "busy"
  switch (kind) {
    case "rate-limited":
    case "provider-unavailable":
    case "network":
    case "launch-stalled":
      return kind
    default:
      return undefined
  }
}

/**
 * The cause a failure in `message` is waited out for: none when anything in it is a cause the person must fix,
 * whatever transient words wrap it (`permanentFailure`: "API error: 400 … unknown model" is a setting, not an outage).
 */
export function transientCause(message: string, kind: ProviderFailureKind, busy: boolean): RetryCause | undefined {
  if (busy) return "busy"
  return permanentFailure(message) ? undefined : retryCause(kind, false)
}

/** The attempt after `previous` for `cause`, or undefined when Mako stops waiting (`GIVE_UP_MS`) and the message fails. */
export function nextRetry(previous: RequestRetry | undefined, cause: RetryCause, reason: string, now: number): RequestRetry | undefined {
  const since = previous?.since ?? now
  if (now - since >= GIVE_UP_MS[cause]) return undefined
  const attempt = (previous?.attempt ?? 0) + 1
  const wait = RETRY_STEPS_MS[Math.min(attempt, RETRY_STEPS_MS.length) - 1]!
  return { at: now + wait, attempt, since, cause, reason: reason.slice(0, 2_000) }
}

/**
 * The queued messages a failure left, held to go again (`nextRetry`), or
 * undefined when Mako stops waiting for one of them, so they fail together
 * as before.
 */
export function holdForRetry(requests: readonly LiveRequest[], cause: RetryCause, reason: string, now: number): LiveRequest[] | undefined {
  const next = new Map<string, RequestRetry>()
  for (const request of requests) {
    if (request.status !== "queued") continue
    const retry = nextRetry(request.retry, cause, reason, now)
    if (!retry) return undefined
    next.set(request.id, retry)
  }
  if (!next.size) return undefined
  return requests.map((request) => {
    const retry = next.get(request.id)
    return retry ? { ...request, status: "held" as const, retry } : request
  })
}

/** Whether `after` holds a message to go again that `before` had queued: the failure between them is waited out. */
export function retriesBegun(before: readonly LiveRequest[], after: readonly LiveRequest[]): boolean {
  const queued = new Set(before.filter((request) => request.status === "queued").map((request) => request.id))
  return after.some((request) => queued.has(request.id) && request.status === "held" && request.retry !== undefined)
}

/** The queue row's line for a message that goes again by itself: what holds it, in the harness's name. */
export function retryWords(retry: Pick<RequestRetry, "cause">, harness: string): string {
  switch (retry.cause) {
    case "rate-limited":
      return `${harness} is at capacity or its usage limit`
    case "provider-unavailable":
      return `${harness}'s service failed on its side`
    case "network":
      return `the connection to ${harness} dropped`
    case "launch-stalled":
      return `${harness} went quiet while starting`
    case "busy":
      return `${harness} still has this session open`
  }
}

/**
 * A Stop's latch, kept on each request it found waiting or being sent (`LiveRequest.pause`): whatever comes back for
 * one later (a refusal, a retry, a time) leaves it held as the Stop's pause, never to go by itself, until a deliberate
 * resume clears the mark. `requests` itself when nothing changes.
 */
export function latchedByStop(requests: LiveRequest[]): LiveRequest[] {
  const loose = (request: LiveRequest) => request.pause === "stop" && (request.status === "queued" || (request.status === "held" && (request.retry !== undefined || request.wake !== undefined)))
  if (!requests.some(loose)) return requests
  return requests.map((request) => loose(request) ? { ...request, status: "held" as const, retry: undefined, wake: undefined } : request)
}
