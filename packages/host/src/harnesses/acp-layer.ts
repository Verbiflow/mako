import type { McpServer } from "@agentclientprotocol/sdk"
import type { LayerAdapter, LayerCapabilities } from "../contracts/mako-layer.js"
import type { NativeRoutingCapability } from "../contracts/native-routing.js"
import { bearerServers, spawnsRemoved } from "./mako-layer.js"

export interface AcpLayerFragment {
  /** Mako's servers for `session/new`, beside the person's own. */
  servers: McpServer[]
  /** The source's switch for its own spawning (`AcpLaunchOptions.nativeSpawnsOff`), read as the agent launches. */
  spawnsOff(): boolean
}

/** The adapter of an agent Mako speaks ACP to: its capabilities as its source declares them, and its spawn switch by `routing`. */
export function acpLayer(harness: string, capabilities: LayerCapabilities, routing: NativeRoutingCapability): LayerAdapter<AcpLayerFragment> {
  return {
    harness,
    capabilities,
    apply(layer, conversation) {
      return {
        servers: bearerServers(layer).map(({ name, url, authorization }) => ({ type: "http", name, url, headers: [{ name: "Authorization", value: authorization }] })),
        spawnsOff: () => routing.kind !== "words" && spawnsRemoved(layer, harness, routing.via, conversation),
      }
    },
  }
}
