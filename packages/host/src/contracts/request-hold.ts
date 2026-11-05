import type { RequestRetry } from "./delivery-retry.js"
import type { ConversationControl } from "./conversation-control.js"
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
 * - `paused`: a Stop (`by: "stop"`, the person's or an Apex's of its Fin)
 *   paused it, and what's sent after goes ahead; or Mako did, on its exit, a
 *   crash or a lost steer (`by: "mako"`), and it keeps its place, since
 *   nobody chose to put it off. Resume sends it, and a Fin's next message
 *   sends a Fin's on.
 */
export type Hold =
  | { kind: "edit" }
  | { kind: "sign-in"; hold: SignInHold }
  | { kind: "retry"; retry: RequestRetry }
  | { kind: "until"; wake: RequestWake }
  | { kind: "paused"; by: "stop" | "mako" }

/** The hold a held request is under, or undefined for one that isn't held. */
export function holdOf(request: Pick<LiveRequest, "status" | "signIn" | "editing" | "retry" | "wake" | "pause">): Hold | undefined {
  if (request.status !== "held") return undefined
  if (request.signIn) return { kind: "sign-in", hold: request.signIn }
  if (request.editing) return { kind: "edit" }
  // A Stop overrides every hold that would go by itself: nothing it paused goes until a deliberate resume.
  if (request.pause === "stop") return { kind: "paused", by: "stop" }
  if (request.retry) return { kind: "retry", retry: request.retry }
  if (request.wake) return { kind: "until", wake: request.wake }
  return { kind: "paused", by: "mako" }
}

/** Whether a message held so keeps its place in line: nothing behind it goes first. */
export function keepsLine(hold: Hold): boolean {
  return hold.kind === "edit" || hold.kind === "sign-in" || hold.kind === "retry" || (hold.kind === "paused" && hold.by === "mako")
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
  return { ...request, status: "queued", wake: undefined, editing: undefined, pause: undefined }
}

/** The message a conversation sends next, once nothing else holds it back; undefined when none would go. */
export function nextInLine<T extends Pick<LiveRequest, "status" | "signIn" | "editing" | "retry" | "wake" | "pause">>(requests: readonly T[], newestOnly: boolean): T | undefined {
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

/** When a reconnect waiting to go again (`ContextTransfer.retry`) is due, for the one timer and the listing. */
export function transferDue(control: Pick<ConversationControl, "transfers"> | undefined): number | undefined {
  let soonest: number | undefined
  for (const transfer of control?.transfers ?? [])
    if (transfer.state.kind === "queued" && transfer.retry && (soonest === undefined || transfer.retry.at < soonest)) soonest = transfer.retry.at
  return soonest
}

/** The sooner of two times, either of which may be missing. */
export function sooner(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.min(left, right)
}
