import type { RequestRetry } from "./delivery-retry.js"
import type { LiveRequest, RequestWake, SignInHold } from "./live-conversations.js"

/**
 * Why a message in a conversation's queue waits, one reading of the fields a
 * held request keeps (`signIn`, `editing`, `retry`, `wake`): every rule about
 * holds reads this, and nothing reads those fields apart.
 *
 * - `edit`: the person paused it to edit it. It keeps its place, nothing goes
 *   ahead of it, and only they release it.
 * - `sign-in`: its account signed out. The session's work waits together for
 *   their Resume, in order.
 * - `retry`: its harness couldn't take it for now (`RetryCause`). It goes again
 *   at `at`, first: nothing goes ahead of it, and a new message makes it due now.
 * - `until`: the person asked to send it at a time, a usage limit's reset.
 *   Messages they send meanwhile go.
 * - `paused`: a Stop, Mako's exit or a crash paused it. Messages sent after go
 *   ahead; Resume sends it, and a Fin's next message sends a Fin's on.
 */
export type Hold =
  | { kind: "edit" }
  | { kind: "sign-in"; hold: SignInHold }
  | { kind: "retry"; retry: RequestRetry }
  | { kind: "until"; wake: RequestWake }
  | { kind: "paused" }

/** The hold a held request is under, or undefined for one that isn't held. */
export function holdOf(request: Pick<LiveRequest, "status" | "signIn" | "editing" | "retry" | "wake">): Hold | undefined {
  if (request.status !== "held") return undefined
  if (request.signIn) return { kind: "sign-in", hold: request.signIn }
  if (request.editing) return { kind: "edit" }
  if (request.retry) return { kind: "retry", retry: request.retry }
  if (request.wake) return { kind: "until", wake: request.wake }
  return { kind: "paused" }
}

/** Whether a message held so keeps its place in line: nothing behind it goes first. */
export function keepsLine(hold: Hold): boolean {
  return hold.kind === "edit" || hold.kind === "sign-in" || hold.kind === "retry"
}

/** When a message held so goes by itself, or undefined when only someone's word releases it. */
export function holdDue(hold: Hold): number | undefined {
  return hold.kind === "retry" ? hold.retry.at : hold.kind === "until" ? hold.wake.at : undefined
}

/**
 * A held message released, whatever held it but a sign-out, which only the session's Resume releases
 * (`releaseSignIn`): queued again, its time and its edit mark gone. A retry's count stays, so a failure after it
 * waits longer (`nextRetry`).
 */
export function released<T extends LiveRequest>(request: T): T {
  if (request.status !== "held" || request.signIn) return request
  return { ...request, status: "queued", wake: undefined, editing: undefined }
}

/** The message a conversation sends next, once nothing else holds it back; undefined when none would go. */
export function nextInLine<T extends Pick<LiveRequest, "status" | "signIn" | "editing" | "retry" | "wake">>(requests: readonly T[], newestOnly: boolean): T | undefined {
  let next: T | undefined
  for (const request of requests) {
    if (request.status === "queued") {
      next = request
      if (!newestOnly) return next
      continue
    }
    const hold = holdOf(request)
    if (hold && keepsLine(hold)) return next
  }
  return next
}
