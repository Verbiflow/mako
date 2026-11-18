import type { JsonObject } from "../../contracts/json.js"
import { instructionText, type LayerAdapter, type MakoLayer } from "../../contracts/mako-layer.js"
import { MAKO_THREAD_SERVER, withoutInstructions } from "../../contracts/mcp-reach.js"
import { serverBlock } from "../../contracts/primer.js"
import { spawnsRemoved } from "../mako-layer.js"

export interface CodexLayerFragment {
  /** Handed to each turn as an application entry, which Codex gives the model as developer context. */
  instructions?: string
  /** Mako's servers for `mcp_servers`; the grant rides in `MAKO_CONVERSATIONS_TOKEN`. */
  servers: Array<{ name: string; url: string }>
  /** What `thread/start`, `thread/resume` and `thread/fork` carry in `config` for the layer, read as the thread opens. */
  config(): JsonObject
}

/**
 * Codex resolves its multi-agent tools from the config's override first,
 * then the model's own `multi_agent_version`, then the features, so
 * `features.multi_agent = false` leaves a bundled model's `spawn_agent` in
 * place: only `agents.enabled = false` removes it. An enabled
 * `features.multi_agent_v2` would win over that, so it's off too.
 */
const SPAWNS_OFF = { "agents.enabled": false, "features.multi_agent_v2": false }

/**
 * Codex 0.164 copies a server's whole instructions into every `ALL_TOOLS`
 * entry of that server's tools, so a lookup of six Mako tools read them six
 * times. Where the launch carries Mako's primer, the `mako` server goes
 * without them and its text rides once in the developer context as the
 * `server` block. With no primer (the eval's off arm) the server keeps them.
 */
function carriesServer(layer: MakoLayer): boolean {
  return layer.instructions.some((block) => block.id === "routes") && layer.servers.some((server) => server.name === MAKO_THREAD_SERVER)
}

export const codexLayer: LayerAdapter<CodexLayerFragment> = {
  harness: "codex",
  capabilities: {
    instructions: { kind: "native", via: "developer-context", how: "`turn/start` `additionalContext` as an application entry; `developerInstructions` on the thread would carry it once. Never `baseInstructions`, which replaces Codex's own", inUse: true },
    toolServing: { kind: "native", via: "http-mcp", how: "`config.mcp_servers` on the thread, the grant read from the environment; `mako` without its instructions (`?instructions=0`) when the primer carries them", inUse: true },
    removal: { kind: "native", via: "config-switch", how: "`config` switches on the thread; today `agents.enabled` and `features.multi_agent_v2`, which take spawning out", inUse: true },
    interception: { kind: "native", via: "pre-tool-hook", how: "`PreToolUse` command hooks in the thread's config, trusted in the same layer, posting each shell or browser call to Mako (`codexCallsConfig`)", inUse: true },
    subagents: { kind: "fallback", via: "words", loses: "Codex declares no agents Mako can define; the instructions say when to start a Fin" },
    hooks: { kind: "native", via: "config-hooks", how: "app-server events, and hooks in the thread's config", inUse: true },
    personSetup: "kept",
  },
  apply(layer, conversation) {
    const carried = carriesServer(layer)
    const instructions = instructionText(carried ? { ...layer, instructions: [...layer.instructions, serverBlock()] } : layer)
    return {
      ...instructions !== undefined && { instructions },
      servers: layer.servers.map(({ name, url }) => ({ name, url: carried && name === MAKO_THREAD_SERVER ? withoutInstructions(url) : url })),
      config: () => spawnsRemoved(layer, "codex", "agents.enabled", conversation) ? SPAWNS_OFF : {},
    }
  },
}
