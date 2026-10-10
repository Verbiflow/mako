import type { LiveRequest, SignInHold } from "./live-conversations.js"

/**
 * Work paused because the provider's account signed out.
 *
 * The pause belongs to the session: what the sign-out cut short and every
 * message behind it carry one `SignInHold`, and nothing sends until the user
 * resumes. Resume releases them in order. The cut-short turn is continued
 * when the provider had accepted it; one whose outcome is unknown is left
 * with its own recovery notice and never sent again on its own.
 *
 * Kept free of host imports so the renderer reads the same pause.
 */
export interface SignInPause {
  hold: SignInHold
  /** Unsent messages that go on Resume, oldest first. */
  waiting: string[]
  /** The turn the sign-out cut short. `continue`: Resume picks it up. `review`: its outcome is unknown; it stays the user's call. */
  cut?: { requestId: string; outcome: "continue" | "review" }
}

export function signInPause(requests: readonly LiveRequest[]): SignInPause | undefined {
  let hold: SignInHold | undefined
  const waiting: string[] = []
  let cut: SignInPause["cut"]
  for (const request of requests) {
    if (!request.signIn || request.status === "canceled") continue
    hold ??= request.signIn
    if (request.status === "held") waiting.push(request.id)
    else cut = { requestId: request.id, outcome: request.status === "interrupted" ? "continue" : "review" }
  }
  return hold && { hold, waiting, cut }
}

/**
 * The requests once the session's account signed out. Queued messages wait;
 * the request whose turn just `ended` keeps its outcome, except that one the
 * provider refused unsent waits like the rest, and one it had accepted is a
 * turn cut short rather than failed. Messages the user paused stay theirs.
 */
export function holdForSignIn(requests: readonly LiveRequest[], hold: SignInHold, ended?: string): LiveRequest[] {
  return requests.map((request) => {
    if (request.status === "queued")
      return { ...request, status: "held", signIn: hold, accountSwitch: undefined }
    if (request.id !== ended || request.signIn) return request
    const evidence = request.nativeDelivery?.evidence.kind
    if (request.status === "failed" && evidence === "not-accepted")
      return { ...request, status: "held", signIn: hold, error: undefined, failure: undefined, snapshots: undefined }
    if (request.status === "failed" && evidence === "accepted")
      return { ...request, status: "interrupted", failure: "auth", signIn: hold, interruption: { reason: "signed-out", at: hold.at } }
    if (request.status === "failed" || request.status === "interrupted" || request.status === "uncertain")
      return { ...request, signIn: hold }
    return request
  })
}

/**
 * The requests once the user resumes: waiting messages queue again in their
 * order, behind `continuation` when the cut-short turn is picked up, and
 * every marker of the pause is gone.
 */
export function releaseSignIn(requests: readonly LiveRequest[], continuation?: LiveRequest): LiveRequest[] {
  const released: LiveRequest[] = []
  let placed = !continuation
  for (const request of requests) {
    if (!request.signIn) {
      released.push(request)
      continue
    }
    const rest = { ...request }
    delete rest.signIn
    if (request.status === "held") {
      if (!placed && continuation) released.push(continuation)
      placed = true
      released.push({ ...rest, status: "queued" })
    } else released.push(rest)
  }
  if (!placed && continuation) released.push(continuation)
  return released
}
