import { randomUUID } from "node:crypto"
import type { Actor, ClientSession, Reply } from "@mako/protocol"
import { hostOperationName, toHostOperation, toRuntimeReply } from "./contracts/host-operations.js"
import { RuntimeDisconnectedError } from "./contracts/host-connection.js"
import { encodeRuntimeCall, runtimeReplyValue, type RuntimeValue } from "./contracts/runtime.js"
import { hostLog, hostWarn } from "./host-log.js"

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
   * id and one correlation ID, so the gateway answers a repeat with the first answer and the
   * host's log shows the repeat beside the first try.
   */
  call(channel: string, args: readonly unknown[]): (attempt: number) => Promise<RuntimeValue>
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
      return async (attempt) => {
        const started = Date.now()
        const operation = toHostOperation(encodeRuntimeCall(channel, args, attempt), {
          id, target, actor: options.actor, correlationId, history: options.history,
        })
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
        return runtimeReplyValue(toRuntimeReply(reply))
      }
    },
  }
}
