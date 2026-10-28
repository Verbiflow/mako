import type { ClientSession } from "@mako/protocol"
import { gatewayHostCalls as callsThroughGateway, type GatewayHostCalls, type GatewayHostCallsOptions } from "../contracts/gateway-host-calls.js"
import { hostLog, hostWarn } from "../base/host-log.js"

export type { GatewayHostCalls, GatewayHostCallsOptions }

/** `gatewayHostCalls` for this host: its lines in the host's log, every call traced with `MAKO_GATEWAY_TRACE=1`. */
export function gatewayHostCalls(session: ClientSession, options: GatewayHostCallsOptions): GatewayHostCalls {
  return callsThroughGateway(session, {
    trace: process.env.MAKO_GATEWAY_TRACE === "1",
    log: { warn: (message, fields) => hostWarn("gateway-client", message, fields), info: (message, fields) => hostLog("gateway-client", message, fields) },
    ...options,
  })
}
