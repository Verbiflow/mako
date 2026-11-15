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
 *   at `at`, first: nothing goes ahead of it. New input keeps provider waits; other retries become due now.
 * - `resting`: a digest no model heard, past what Mako retries. It goes with the next turn that can run, first: a new
 *   message, a switch or a Resume, and where a limit holds it, by itself once an hour (`at`). Its limit outlasting the
 *   retries is no proof it was heard.
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
  | { kind: "resting"; at?: number }
  | { kind: "until"; wake: RequestWake }
  | { kind: "paused"; by: "stop" | "mako" }

/** The hold a held request is under, or undefined for one that isn't held. */
export function holdOf(request: Pick<LiveRequest, "status" | "signIn" | "editing" | "retry" | "wake" | "pause" | "digest">): Hold | undefined {
  if (request.status !== "held") return undefined
  if (request.signIn) return { kind: "sign-in", hold: request.signIn }
  if (request.editing) return { kind: "edit" }
  // A Stop overrides every hold that would go by itself: nothing it paused goes until a deliberate resume.
  if (request.pause === "stop") return { kind: "paused", by: "stop" }
  if (request.retry) return { kind: "retry", retry: request.retry }
  if (request.digest?.resting) return { kind: "resting", ...(request.digest.nextTry !== undefined && { at: request.digest.nextTry }) }
  if (request.wake) return { kind: "until", wake: request.wake }
  return { kind: "paused", by: "mako" }
}

/** Capacity and service waits belong to the provider; new messages cannot make either clear sooner. */
export function waitsForProvider(request: Pick<LiveRequest, "retry">): boolean {
  return request.retry?.cause === "provider-unavailable" || request.retry?.cause === "rate-limited"
}

/** Whether new input releases a retry/resting digest. Provider waits keep their time; an explicit move can go now. */
export function goesNext(request: Parameters<typeof holdOf>[0], keepProviderWait = false): boolean {
  if (keepProviderWait && waitsForProvider(request)) return false
  const kind = holdOf(request)?.kind
  return kind === "retry" || kind === "resting"
}

/** Whether a message held so keeps its place in line: nothing behind it goes first. */
export function keepsLine(hold: Hold): boolean {
  return hold.kind === "edit" || hold.kind === "sign-in" || hold.kind === "retry" || hold.kind === "resting" || (hold.kind === "paused" && hold.by === "mako")
}

/** When a message held so goes by itself, or undefined when only someone's word releases it. */
export function holdDue(hold: Hold): number | undefined {
  return hold.kind === "retry" ? hold.retry.at : hold.kind === "until" ? hold.wake.at : hold.kind === "resting" ? hold.at : undefined
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

/** Where a row goes first among those waiting: ahead of what waits, after the last message someone is editing, which nothing goes ahead of. */
export function goingFirst<T extends Pick<LiveRequest, "id" | "status" | "editing">>(requests: readonly T[], first: string): readonly T[] {
  const own = requests.find((request) => request.id === first && request.status === "queued")
  if (!own) return requests
  const rest = requests.filter((request) => request !== own)
  let barrier = -1
  rest.forEach((request, index) => { if (request.status === "held" && request.editing) barrier = index })
  const ahead = rest.findIndex((request, index) => index > barrier && (request.status === "queued" || request.status === "held"))
  return ahead === -1 ? requests : [...rest.slice(0, ahead), own, ...rest.slice(ahead)]
}

/** Where a Thread lands: its harness, the account if it names one, and the model its waiting messages go on. */
export interface Landing {
  harness: string
  account?: string | undefined
  tuning?: LiveRequest["tuning"]
}

/**
 * The queue as a switch lands on another place, a harness or an account, whoever asked (`docs/delivery-queue.md`): a
 * hold about the source's account goes, and a hold about the person doesn't. What waited for a limit or a sign-in goes on
 * the target in its order, and that sign-out's notice goes with it, which `signInPause` reads from these marks; a
 * sign-in of the very account it lands on still stands. A Stop and an edit stay as they are, and a row a Stop paused
 * keeps waiting for its Resume with the sign-in gone. `first` goes ahead of what waited longer, as a digest the landing
 * freed does by itself. `leaving` says the model a row chose was its harness's, so it runs on the target's.
 */
export function arriving(requests: readonly LiveRequest[], to: Landing, leaving: boolean, first?: string): LiveRequest[] {
  const landed = requests.map((request) => {
    if (request.signIn && (request.signIn.harness !== to.harness || (to.account !== undefined && request.signIn.account !== to.account))) {
      const rest = { ...request }
      delete rest.signIn
      return retuned({ ...rest, status: request.status === "held" && !request.editing && request.pause !== "stop" ? "queued" as const : request.status }, to, leaving)
    }
    return retuned(goesNext(request) ? { ...request, status: "queued" as const, retry: undefined } : request, to, leaving)
  })
  const ahead = first ?? landed.find((request, index) => request.digest && request.status === "queued" && requests[index]?.status === "held")?.id
  return [...(ahead === undefined ? landed : goingFirst(landed, ahead))]
}

function retuned(request: LiveRequest, to: Landing, leaving: boolean): LiveRequest {
  if (request.status !== "queued" && request.status !== "held") return request
  if (to.tuning) return { ...request, tuning: to.tuning }
  return leaving && request.tuning ? { ...request, tuning: undefined } : request
}

/**
 * The queue as it was before a landing that was taken back. What the landing freed waits again as it did, and its order
 * goes back, but only rows still as the landing left them are the landing's to touch: `landed` is what it made, by
 * identity, so a Resume, an edit or a Stop since stands, and such a row keeps the place it has.
 */
export function departing(requests: readonly LiveRequest[], before: readonly LiveRequest[], landed: readonly LiveRequest[]): LiveRequest[] {
  const was = new Map(before.map((request) => [request.id, request]))
  const owned = new Set(landed)
  const back = requests.map((request) => (owned.has(request) ? was.get(request.id) ?? request : request))
  const untouched = landed.every((request) => requests.includes(request))
  if (!untouched || before.every((request, index) => landed[index]?.id === request.id)) return back
  const place = new Map(before.map((request, index) => [request.id, index]))
  return back.map((request, index) => ({ request, index })).sort((left, right) => (place.get(left.request.id) ?? before.length + left.index) - (place.get(right.request.id) ?? before.length + right.index)).map(({ request }) => request)
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
