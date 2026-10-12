import { randomUUID } from "node:crypto"
import type { Actor, ClientSession, Payload, Reply } from "@mako/protocol"
import { hostCallInput, hostOperationName, hostReplyValue, toHostOperation } from "../contracts/host-operations.js"
import { RuntimeDisconnectedError } from "../contracts/host-connection.js"
import type { EncodedValue } from "../contracts/runtime-value.js"
import { hostLog, hostWarn } from "../base/host-log.js"

export type GatewayHostCallsOptions = {
  /** The runtime whose host serves these calls, such as the laptop's. */
  runtimeId: string
  actor: Actor
  history?: boolean
  /** Every call is logged; otherwise only failures and repeats. */
  trace?: boolean
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
  const target = { kind: "runtime" as const, runtimeId: options.runtimeId }
  return {
    call(channel, args) {
      const id = randomUUID()
      const correlationId = randomUUID()
      let input: Payload | undefined
      return async (attempt) => {
        const started = Date.now()
        input ??= hostCallInput(args, options.history ?? false)
        const operation = toHostOperation(channel, input, { id, target, actor: options.actor, correlationId, attempt })
        let reply: Reply
        try {
          reply = await session.call(operation)
        } catch (error) {
          hostWarn("gateway-client", "operation lost", { op: operation.op, correlationId, attempt, error: error instanceof Error ? error.message : "unknown" })
          throw new RuntimeDisconnectedError(true)
        }
        const fields = { op: hostOperationName(channel), correlationId, attempt, outcome: reply.ok ? "ok" : reply.problem.type, ms: Date.now() - started }
        if (!reply.ok) hostWarn("gateway-client", "operation failed", fields)
        else if (trace || attempt > 1) hostLog("gateway-client", "operation", fields)
        return hostReplyValue(reply)
      }
    },
  }
}
