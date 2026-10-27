import { randomUUID } from "node:crypto"
import { problemType, type Actor, type ClientSession, type Payload, type Problem, type Reply } from "@mako/protocol"
import { deferredWhenAsleep } from "../contracts/host-call-policy.js"
import { hostCallInput, hostOperationName, hostReplyValue, toHostOperation } from "../contracts/host-operations.js"
import { RuntimeDisconnectedError } from "../contracts/host-connection.js"
import type { EncodedValue } from "../contracts/runtime-value.js"
import { hostLog, hostWarn } from "../base/host-log.js"

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
 * rules on either path.
 */
export function gatewayHostCalls(session: ClientSession, options: GatewayHostCallsOptions): GatewayHostCalls {
  const trace = options.trace ?? process.env.MAKO_GATEWAY_TRACE === "1"
  const target = "threadId" in options
    ? { kind: "thread" as const, threadId: options.threadId }
    : { kind: "runtime" as const, runtimeId: options.runtimeId }
  return {
    call(channel, args) {
      const id = randomUUID()
      const correlationId = randomUUID()
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
          hostWarn("gateway-client", "operation lost", { op: operation.op, correlationId, attempt, error: error instanceof Error ? error.message : "unknown" })
          throw new RuntimeDisconnectedError(true)
        }
        const fields = { op: hostOperationName(channel), correlationId, attempt, outcome: reply.ok ? (reply.deferred ? "deferred" : "ok") : reply.problem.type, ms: Date.now() - started }
        // A passive look the gateway didn't apply because nothing runs the Thread is its answer by design (its machine
        // sleeps), not a failure: its caller says what it means once, as it changes. Every other refusal is a warning.
        if (!reply.ok && !(options.passive && passedOver(reply.problem))) hostWarn("gateway-client", "operation failed", fields)
        else if (trace || attempt > 1) hostLog("gateway-client", "operation", fields)
        return hostReplyValue(reply)
      }
    },
  }
}

/** A passive call's expected refusal: unapplied, as nothing runs its target now. */
function passedOver(problem: Problem): boolean {
  return problemType(problem) === "owner-unavailable" && problem.outcome === "not-applied"
}
