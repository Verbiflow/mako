import type { LayerAdapter } from "../../contracts/mako-layer.js"
import { bearerServers, spawnsRemoved } from "../mako-layer.js"

export interface OpenCodeLayerFragment {
  /** Mako's servers as `mcp.add` takes them, beside the person's own. */
  servers: Array<{ name: string; config: { type: "remote"; url: string; headers: Record<string, string>; oauth: false } }>
  /** Whether the `subagent` permission is denied last in the agents Mako runs (`configureOpenCodeRouting`), read as the server's config is built. */
  spawnsDenied(): boolean
}

export const opencodeLayer: LayerAdapter<OpenCodeLayerFragment> = {
  harness: "opencode",
  capabilities: {
    instructions: { kind: "native", via: "instructions-file", how: "a file named in `OPENCODE_CONFIG_CONTENT`'s `instructions`, which OpenCode appends. Never an agent's `prompt`, which replaces the provider's own", inUse: true },
    toolServing: { kind: "native", via: "http-mcp", how: "`mcp.add` with a remote config, the grant as a bearer header; a plugin could serve them in-process", inUse: true },
    removal: { kind: "native", via: "config-switch", how: "a deny on a permission, last in the agents Mako runs, in `OPENCODE_CONFIG_CONTENT`; today the `subagent` permission, which drops the tool; an agent's `tools` map would take out any other", inUse: true },
    interception: { kind: "native", via: "plugin", how: "a plugin of Mako's named in `OPENCODE_CONFIG_CONTENT`, posting each call to Mako", inUse: true },
    subagents: { kind: "native", via: "declared", how: "agent definitions in `OPENCODE_CONFIG_CONTENT`", inUse: false },
    hooks: { kind: "native", via: "plugin", how: "a plugin in the inline config", inUse: true },
    personSetup: "kept",
  },
  apply(layer, conversation) {
    return {
      servers: bearerServers(layer).map(({ name, url, authorization }) => ({ name, config: { type: "remote", url, headers: { Authorization: authorization }, oauth: false } })),
      spawnsDenied: () => spawnsRemoved(layer, "opencode", "subagent denied", conversation),
    }
  },
}
