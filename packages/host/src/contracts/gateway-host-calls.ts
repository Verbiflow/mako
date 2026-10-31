import { problemType, type Actor, type ClientSession, type Payload, type Problem, type Reply } from "@mako/protocol"
import { deferredWhenAsleep } from "./host-call-policy.js"
import { hostCallInput, hostOperationName, hostReplyValue, toHostOperation } from "./host-operations.js"
import { CLOUD_CALL_UNCONFIRMED_MESSAGE, CLOUD_RECONNECTING_MESSAGE, OwnerUnavailableError, RuntimeDisconnectedError } from "./host-connection.js"
import { hostCallReplay } from "./host-call-policy.js"
import type { EncodedValue } from "./runtime-value.js"

export type GatewayHostCallsOptions = (
  /** The runtime whose host serves these calls, such as the laptop's. */
  | { runtimeId: string }
  /** The Thread whose runtime serves them, whichever that is now, such as a cloud Thread's machine. */
  | { threadId: string }
) & {
  actor: Actor
  history?: boolean
  /** Every call is logged; otherwise only failures and repeats. */
  trace?: boolean
  /** Made ahead of a person's message, as their harness started on a Thread made ahead (`OperationEnvelope.ahead`). */
  ahead?: boolean
  /** A window's own look, polled: it never wakes a sleeping machine, nor counts as a person (`OperationEnvelope.passive`). */
  passive?: boolean
  /** Refused at once if the Thread's machine can't start, never queued (`OperationEnvelope.whenUnstarted`). */
  refuseUnstarted?: boolean
  /** Where its lines go: a host's log, a browser's console. Nothing is said without one. */
  log?: GatewayCallLog
}

/**
 * The lines a caller's log takes: a call lost or refused (`warn`), and a call repeated or traced (`info`). A call's
 * `outcome` is `ok`, `deferred`, or the refusal's problem type in the gateway's own word (`owner-unavailable`,
 * `unavailable`, `not-found`, …), which a caller can match as it is.
 */
export type GatewayCallLog = {
  warn(message: string, fields: Record<string, string | number>): void
  info(message: string, fields: Record<string, string | number>): void
}

export type GatewayHostCalls = {
  /**
   * One host call, ready for `invokeWithRecovery`: every attempt is the same operation, with one
   * id, one correlation ID and one encoding of its arguments, so the gateway answers a repeat
   * with the first answer and the host's log shows the repeat beside the first try. Its value
   * comes as the host encoded it, for the caller to decode or forward.
   */
  call(channel: string, args: readonly unknown[]): (attempt: number) => Promise<EncodedValue>
}

/**
 * Host calls through a gateway, with what the socket gives a caller: the same values, the same
 * errors, and the same delivery state on an outage, so `invokeWithRecovery` retries by the same
 * rules on either path. A Mac's host and a browser call another host's conversations with this one piece.
 */
export function gatewayHostCalls(session: ClientSession, options: GatewayHostCallsOptions): GatewayHostCalls {
  const target = "threadId" in options
    ? { kind: "thread" as const, threadId: options.threadId }
    : { kind: "runtime" as const, runtimeId: options.runtimeId }
  return {
    call(channel, args) {
      const id = crypto.randomUUID()
      const correlationId = crypto.randomUUID()
      let input: Payload | undefined
      return async (attempt) => {
        const started = Date.now()
        input ??= hostCallInput(args, options.history ?? false)
        const operation = toHostOperation(channel, input, { id, target, actor: options.actor, correlationId, attempt })
        // A close needn't wake a cloud Thread's paused machine: it waits there for the machine's next wake.
        if (deferredWhenAsleep.has(channel)) operation.whenAsleep = "defer"
        if (options.ahead) operation.ahead = true
        if (options.passive) operation.passive = true
        if (options.refuseUnstarted) operation.whenUnstarted = "refuse"
        let reply: Reply
        try {
          reply = await session.call(operation)
        } catch (error) {
          options.log?.warn("operation lost", { op: operation.op, correlationId, attempt, error: error instanceof Error ? error.message : "unknown" })
          throw new RuntimeDisconnectedError(true)
        }
        const fields = { op: hostOperationName(channel), correlationId, attempt, outcome: reply.ok ? (reply.deferred ? "deferred" : "ok") : problemType(reply.problem), ms: Date.now() - started }
        // A passive look the gateway didn't apply because nothing runs the Thread is its answer by design (its machine
        // sleeps), not a failure: its caller says what it means once, as it changes. Every other refusal is a warning.
        if (!reply.ok && !(options.passive && passedOver(reply.problem))) options.log?.warn("operation failed", fields)
        else if (options.trace || attempt > 1) options.log?.info("operation", fields)
        return hostReplyValue(reply)
      }
    },
  }
}

/** A passive call's expected refusal: unapplied, as nothing runs its target now. */
function passedOver(problem: Problem): boolean {
  return problemType(problem) === "owner-unavailable" && problem.outcome === "not-applied"
}

/** How long a call that didn't reach its Thread is repeated before the window hears of it: a wake takes seconds. */
export const CLOUD_REPEAT_MS = 60_000
const CLOUD_REPEAT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000] as const

/**
 * The tries of one call to another host's conversation, through the gateway. A call the gateway lost on the way (its
 * machine's link changed under it) or still holds while the machine wakes is repeated, under its one id, for as long
 * as `CLOUD_REPEAT_MS`, when a repeat can't do it twice (a read, or a call the host settles by its id): the gateway
 * answers a repeat with the first answer. A device's runtime found off before the call was applied is said at once,
 * as itself (`OwnerUnavailableError`): a call doesn't wake a Mac as it does a cloud Thread's machine. Anything else
 * lost is said as a reconnect the window settles by its own ids, never by repeating here.
 */
export async function sendWithRepeats(channel: string, send: (attempt: number) => Promise<EncodedValue>, how: { threadId?: string; conversationId?: string; runtime?: string | undefined; passive?: boolean; log?: GatewayCallLog }): Promise<EncodedValue> {
  const repeatable = !how.passive && hostCallReplay(channel) !== "never"
  const began = performance.now()
  for (let attempt = 1; ; attempt++) {
    try {
      return await send(attempt)
    } catch (error) {
      if (!(error instanceof RuntimeDisconnectedError)) throw error
      if (how.runtime && error instanceof OwnerUnavailableError && !error.unconfirmed) throw error
      const waitMs = CLOUD_REPEAT_BACKOFF_MS[Math.min(attempt - 1, CLOUD_REPEAT_BACKOFF_MS.length - 1)]!
      if (repeatable && attempt < 8 && performance.now() - began + waitMs < CLOUD_REPEAT_MS) {
        const repeat = { channel, attempt, inMs: waitMs }
        how.log?.info("a call didn't reach the Thread yet; repeating it", how.threadId ? { threadId: how.threadId, ...repeat } : repeat)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }
      throw new RuntimeDisconnectedError(error.unconfirmed, how.conversationId, error.unconfirmed && !repeatable ? CLOUD_CALL_UNCONFIRMED_MESSAGE : CLOUD_RECONNECTING_MESSAGE)
    }
  }
}
