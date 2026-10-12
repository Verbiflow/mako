import { serveRuntime, type Actor, type Operation, type Reply, type RuntimeLink, type ServedRuntime } from "@mako/protocol"
import { fromHostOperation, hostFailure, hostOperations, hostSuccess } from "../contracts/host-operations.js"
import { runtimeFailure, type RuntimeFailure } from "../contracts/runtime.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { HostInvoke } from "./server.js"

/** Reads that take longer than this are logged even when tracing is off. */
const SLOW_MS = 1_000

export type GatewayHostOptions = {
  runtimeId: string
  build: string
  /** The host's own dispatcher, the one its socket uses. */
  invoke: HostInvoke
  /** Every operation is logged; otherwise reads are logged only when slow or failed. */
  trace?: boolean
}

/**
 * Who a remote caller is to the host: an owner key for its terminals, drafts and previews, apart
 * from every local window's.
 */
export function gatewayClientId(actor: Actor): string {
  return actor.kind === "client" ? `gateway:${actor.client}:${actor.deviceId}` : `gateway:runtime:${actor.runtimeId}`
}

/**
 * Serves this host's calls to a gateway as a runtime. Each operation runs through the same
 * `invoke` as the socket, so its arguments are checked by the same schemas, a fixture desk refuses
 * the same calls, and every line the host logs while running it carries its correlation ID. The
 * reply carries the value as `invoke` encoded it, unread.
 */
export function serveHostThroughGateway(link: RuntimeLink, options: GatewayHostOptions): Promise<ServedRuntime> {
  const trace = options.trace ?? process.env.MAKO_GATEWAY_TRACE === "1"
  const handle = async (operation: Operation): Promise<Reply> => {
    const started = Date.now()
    const request = fromHostOperation(operation)
    if (request.kind === "refused") {
      hostWarn("gateway", "refused operation", { op: operation.op, correlationId: operation.correlationId, problem: request.problem.type })
      return { v: operation.v, id: operation.id, ok: false, problem: request.problem }
    }
    const client = gatewayClientId(operation.actor)
    let reply: Reply
    let failure: RuntimeFailure | undefined
    try {
      reply = hostSuccess(operation.id, await options.invoke(request.channel, request.args, client, request.history, operation.correlationId))
    } catch (error) {
      failure = runtimeFailure(error)
      reply = hostFailure(operation.id, operation.correlationId, failure)
    }
    const ms = Date.now() - started
    const replay = hostOperations.get(operation.op)?.replay
    const fields = {
      op: operation.op,
      correlationId: operation.correlationId,
      attempt: operation.attempt,
      client,
      outcome: failure ? (failure.code ?? "failed") : "ok",
      ms,
    }
    if (failure) hostWarn("gateway", "operation failed", { ...fields, error: failure.error })
    else if (trace || replay !== "read" || operation.attempt > 1 || ms >= SLOW_MS) hostLog("gateway", "operation", fields)
    return reply
  }
  return serveRuntime(link, { runtimeId: options.runtimeId, build: options.build, handle })
}
