import type { LiveRequest } from "./live-conversations.js"
import type { ProviderFailureKind } from "./provider-failure.js"

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

/** How long a session busy in another process is waited for before the person is asked: past that it's theirs, not a passing hold. */
export const BUSY_GIVE_UP_MS = 30 * 60_000

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

/** The attempt after `previous` for `cause`, or undefined when Mako stops waiting and the message fails. */
export function nextRetry(previous: RequestRetry | undefined, cause: RetryCause, reason: string, now: number): RequestRetry | undefined {
  const since = previous?.since ?? now
  if (cause === "busy" && now - since >= BUSY_GIVE_UP_MS) return undefined
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
