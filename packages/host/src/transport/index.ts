/**
 * How a host is reached: the socket it serves and the method table every
 * domain declares on, and the other end of the same wire, which a host uses
 * to start, find and call another. A client outside the host imports the
 * file it needs, so a desktop loads the wire's client end without the server.
 */
export { HostMethods, type HostMethodsOptions, type RoutedCall } from "./methods.js"
export { startWebHost, type HostInvoke } from "./server.js"
export { gatewayEventLine, historyChangedNotice, serveHostThroughGateway, type GatewayHostOptions } from "./gateway.js"
export { PortRelay } from "./port-relay.js"
export { gatewayHostCalls, type GatewayHostCallsOptions } from "./gateway-client.js"
export { invokeRuntime, invokeRuntimeEncoded, jsonBody, probeRuntime, runtimeInfo, runtimeRequest, settleRuntime, subscribeRuntime } from "./connection.js"
export { AGENT_VIEWS_CLIENT, appDataFolder, clientRoot, ensureRuntime, runtimeDataRoot, runtimeLocation } from "./service.js"
