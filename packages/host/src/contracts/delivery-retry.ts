import type { ProviderFailureEvidence } from "./provider-failure-evidence.js"
import type { LiveRequest } from "./live-conversations.js"
import { resetWords } from "./account-usage.js"
import { limitReset } from "./limit-reset.js"
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
  /** When its usage limit says it resets: it goes then, not on the steps, however many days off that is. */
  until?: number
}

/** The waits between attempts, the last repeating: a limit that names no reset is tried every ten minutes until it clears. */
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
export function transientCause(message: string, kind: ProviderFailureKind, busy: boolean, evidence?: ProviderFailureEvidence): RetryCause | undefined {
  if (busy) return "busy"
  if (evidence?.kind === kind) return retryCause(kind, false)
  return permanentFailure(message) ? undefined : retryCause(kind, false)
}

/** Past a limit's reset by this much: its clock is the harness's, and the first try after it shouldn't race it. */
export const RESET_MARGIN_MS = 30_000

/**
 * The attempt after `previous` for `cause`, or undefined when Mako stops waiting (`GIVE_UP_MS`) and the message fails.
 * A limit whose words say when it resets (`limitReset`) goes once, then, rather than knocking until it does. That reset
 * is read once and stands for the whole wait: words such as "Try again in 3 hours" read later every time, so reading
 * them again would renew it forever. The bound then counts from the reset, so one three days off is no failure, and
 * one that never lifts ends.
 */
export function nextRetry(previous: RequestRetry | undefined, cause: RetryCause, reason: string, now: number): RequestRetry | undefined {
  const since = previous?.since ?? now
  const reset = previous?.until ?? (cause === "rate-limited" ? limitReset(reason, now) : undefined)
  if (now - (reset ?? since) >= GIVE_UP_MS[cause]) return undefined
  const attempt = (previous?.attempt ?? 0) + 1
  const wait = RETRY_STEPS_MS[Math.min(attempt, RETRY_STEPS_MS.length) - 1]!
  return { at: cause === "rate-limited" && reset !== undefined && reset > now ? reset + RESET_MARGIN_MS : now + wait, attempt, since, cause, reason: reason.slice(0, 2_000), ...(reset !== undefined && { until: reset }) }
}

/** An ambiguous authentication failure gets a sign-in check once its service retry budget is spent; not proof of sign-out. */
export function failureAfterRetry(kind: ProviderFailureKind, evidence: ProviderFailureEvidence | undefined, retry: RequestRetry | undefined, now: number): ProviderFailureKind {
  return kind === "provider-unavailable" && evidence?.kind === "provider-unavailable" && evidence.source === "unconfirmed-auth" &&
    retry?.cause === "provider-unavailable" && now - retry.since >= GIVE_UP_MS["provider-unavailable"] ? "sign-in-check" : kind
}

/** A digest of Fins' news no model answered: only an answer proves it was heard, and its reports already read as heard. */
export function unheardDigest(request: Pick<LiveRequest, "digest">): boolean {
  return request.digest !== undefined && !request.digest.heard
}

/** What says how one attempt at a digest went, rather than what the digest is. */
const DIGEST_ATTEMPT = ["sentAt", "heard", "resting", "nextTry"] as const

/**
 * What a digest carries to the row that goes on from it: all of it but how this attempt went. Named by what it leaves
 * out, so whatever a digest comes to hold goes on with it.
 */
export function carriedDigest(digest: NonNullable<LiveRequest["digest"]>): NonNullable<LiveRequest["digest"]> {
  const carried = { ...digest }
  for (const field of DIGEST_ATTEMPT) delete carried[field]
  return carried
}

/** How often a resting digest tries by itself: an Apex silent after its limit cleared is what this exists to prevent. */
export const RESTING_TRY_MS = 60 * 60_000

/**
 * `request` where Mako stops retrying: never the reports. An unheard digest rests and goes with the next turn that can
 * run, on any harness; one a limit holds also tries by itself, once an hour for its Thread, since nothing else may come
 * along once the limit clears. Anything else, undefined, fails as ever.
 */
export function resting(request: LiveRequest, cause: RetryCause | undefined, now: number): LiveRequest | undefined {
  if (!unheardDigest(request)) return undefined
  const { digest } = request
  return { ...request, status: "held", retry: undefined, digest: { ...digest!, resting: true, ...(cause === "rate-limited" ? { nextTry: now + RESTING_TRY_MS } : { nextTry: undefined }) } }
}

/**
 * What a failure leaves of `request`, waiting: its next attempt, or a digest at rest. A digest resting stays resting,
 * since a retry from nothing would start the budget again; undefined when it fails.
 */
export function waitsAgain(request: LiveRequest, cause: RetryCause | undefined, reason: string, now: number): LiveRequest | undefined {
  const retry = cause && !request.digest?.resting ? nextRetry(request.retry, cause, reason, now) : undefined
  return retry ? { ...request, status: "held", retry } : resting(request, cause, now)
}

/**
 * The queued messages a failure left, held to go again (`nextRetry`), or
 * undefined when Mako stops waiting for one of them, so they fail together
 * as before.
 */
export function holdForRetry(requests: readonly LiveRequest[], cause: RetryCause, reason: string, now: number): LiveRequest[] | undefined {
  const next = new Map<string, LiveRequest>()
  for (const request of requests) {
    if (request.status !== "queued") continue
    const held = waitsAgain(request, cause, reason, now)
    if (!held) return undefined
    next.set(request.id, held)
  }
  if (!next.size) return undefined
  return requests.map((request) => next.get(request.id) ?? request)
}

/** Whether `after` holds a message to go again that `before` had queued: the failure between them is waited out. */
export function retriesBegun(before: readonly LiveRequest[], after: readonly LiveRequest[]): boolean {
  const queued = new Set(before.filter((request) => request.status === "queued").map((request) => request.id))
  return after.some((request) => queued.has(request.id) && request.status === "held" && request.retry !== undefined)
}

/** Whether its next attempt is the one its reset was waited for; past that, it goes on the steps, each with its own time. */
export function waitsForReset(retry: Pick<RequestRetry, "at" | "until">): boolean {
  return retry.until !== undefined && retry.at <= retry.until + RESET_MARGIN_MS
}

/** The queue row's line for a message that goes again by itself: what holds it, in the harness's name. */
export function retryWords(retry: Pick<RequestRetry, "cause" | "until">, harness: string, now = Date.now()): string {
  switch (retry.cause) {
    case "rate-limited":
      return retry.until === undefined || retry.until <= now ? `${harness} is at capacity or its usage limit` : `${harness} is at its usage limit until ${resetWords(retry.until, now)}`
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
