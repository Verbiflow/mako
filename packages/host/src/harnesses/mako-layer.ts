import { hostLog } from "../base/host-log.js"
import { TOOL_FAMILIES, replacement, type LayerServer, type MakoLayer, type Replacement, type ToolFamily } from "../contracts/mako-layer.js"
import { nativeSpawnsOff } from "../contracts/native-routing.js"
import { conversationServers, launchBlocks, type ProviderStartOptions } from "./live-driver.js"

/**
 * The layer for one launch, from what the host already decides for it: its
 * servers and their grant, its instructions, and what native routing takes
 * from the harness. Read where a driver reads its launch options, so a
 * Thread that becomes an Apex mid-session has its layer from its next launch.
 */
export function layerOf(options: Pick<ProviderStartOptions, "conversationTools" | "nativeRouting" | "primer" | "nativeCalls" | "threadEnvironment">): MakoLayer {
  const thread = options.nativeRouting?.()
  const tools = options.conversationTools
  const replaces: Replacement[] = []
  if (thread) {
    replaces.push({ native: "spawn-subagent", strength: nativeSpawnsOff(thread) ? "remove" : "intercept" })
    if (thread.role === "apex") replaces.push({ native: "agent-team", strength: "remove" })
  }
  return {
    role: thread?.role ?? "thread",
    instructions: launchBlocks(options),
    servers: tools ? conversationServers(tools).map(({ name, url }) => ({ name, url, token: tools.token, families: familiesOf(name) })) : [],
    replaces,
    keepsPersonSetup: true,
  }
}

function familiesOf(server: string): ToolFamily[] {
  // SAFETY: TOOL_FAMILIES is a const object literal, so its own keys are exactly ToolFamily.
  return (Object.keys(TOOL_FAMILIES) as ToolFamily[]).filter((family) => TOOL_FAMILIES[family].server === server)
}

/**
 * Whether the launch takes the harness's own spawning out, each switch
 * logged with the Thread's role: `via` names the harness's switch.
 */
export function spawnsRemoved(layer: MakoLayer, harness: string, via: string, conversation: string): boolean {
  if (replacement(layer, "spawn-subagent") !== "remove") return false
  hostLog("routing", "native spawns off", { harness, via, role: layer.role, conversation })
  return true
}

/** Mako's servers as an HTTP MCP client takes them, the grant as a bearer header. */
export function bearerServers(layer: MakoLayer): Array<LayerServer & { authorization: string }> {
  return layer.servers.map((server) => ({ ...server, authorization: `Bearer ${server.token}` }))
}
