import type { LiveAction } from "./live-actions.js"
import type { LiveBatch } from "./live-conversations.js"
import type { Actor } from "./thread-identity.js"

/** A request as `personPromptedAt` reads it: who sent it, and when it was admitted. */
export type PromptedRequest = { actor?: Pick<Actor, "kind">; createdAt?: number }

/**
 * When the person last sent a conversation a message (epoch ms): the newest of their requests' admissions and their
 * steers into a running turn. Whatever device they typed it on (a window, a phone, a browser), it reaches the
 * conversation's host, so its host is the one that knows, and every device reads its word (`ReportedSession.promptedAt`).
 * A request Mako or an agent sent (a goal's next turn, a continued one, a handoff's) isn't theirs; one from a host
 * without a Thread store names no actor, and is. Undefined while they've sent none, or for a journal that kept no times.
 */
export function personPromptedAt(
  requests: readonly PromptedRequest[] | undefined,
  actions?: readonly Pick<LiveAction, "input" | "createdAt">[]
): number | undefined {
  let latest: number | undefined
  for (const request of requests ?? []) {
    if (request.createdAt === undefined || (request.actor && request.actor.kind !== "person")) continue
    if (latest === undefined || request.createdAt > latest) latest = request.createdAt
  }
  for (const action of actions ?? []) {
    if (action.input.kind === "compact") continue
    if (latest === undefined || action.createdAt > latest) latest = action.createdAt
  }
  return latest
}

/** The later of two times a person last sent a message, either unknown. */
export function laterPrompt(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined ? right : right === undefined || left >= right ? left : right
}

/**
 * When the person last sent a conversation a message, after one of its batches: a request or steer of theirs the batch
 * carries is the newer word. A conversation's requests and steers are only ever added to, so the time never goes back.
 */
export function promptedAfter(promptedAt: number | undefined, batch: Pick<LiveBatch, "requests" | "requestChanges" | "control">): number | undefined {
  if (!batch.requests && !batch.requestChanges && !batch.control) return promptedAt
  return laterPrompt(promptedAt, personPromptedAt(batch.requests ?? batch.requestChanges, batch.control?.actions))
}

/**
 * When a session a harness keeps started, as the account's list says it (`ReportedSession.createdAt`): its first
 * record's time, or its last one's where that's earlier or the first's unknown. Undefined without a readable time.
 */
export function nativeStartedAt(ref: { startedAt?: string; updatedAt?: string }): number | undefined {
  const moved = Date.parse(ref.updatedAt ?? "")
  if (!Number.isFinite(moved)) return undefined
  const started = Date.parse(ref.startedAt ?? "")
  return Number.isFinite(started) ? Math.min(started, moved) : moved
}

/**
 * When the person last worked in a Session, as every rail ranks its project by: their last message to it, or its start
 * while they've sent none (a Thread started there counts as working there).
 */
export function workedAt(session: { promptedAt?: number; createdAt: number }): number {
  return session.promptedAt ?? session.createdAt
}
