import type { JsonObject } from "../../contracts/json.js"
import { instructionText, type LayerAdapter } from "../../contracts/mako-layer.js"
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

export const codexLayer: LayerAdapter<CodexLayerFragment> = {
  harness: "codex",
  capabilities: {
    instructions: { kind: "native", via: "developer-context", how: "`turn/start` `additionalContext` as an application entry; `developerInstructions` on the thread would carry it once. Never `baseInstructions`, which replaces Codex's own", inUse: true },
    toolServing: { kind: "native", via: "http-mcp", how: "`config.mcp_servers` on the thread, the grant read from the environment", inUse: true },
    removal: { kind: "native", via: "config-switch", how: "`config` switches on the thread; today `agents.enabled` and `features.multi_agent_v2`, which take spawning out", inUse: true },
    interception: { kind: "native", via: "pre-tool-hook", how: "`PreToolUse` command hooks in the thread's config, trusted in the same layer, posting each shell or browser call to Mako (`codexCallsConfig`)", inUse: true },
    subagents: { kind: "fallback", via: "words", loses: "Codex declares no agents Mako can define; the instructions say when to start a Fin" },
    hooks: { kind: "native", via: "config-hooks", how: "app-server events, and hooks in the thread's config", inUse: true },
    modelRoute: {
      "native-login": { kind: "native", via: "login", how: "the person's own ChatGPT or API login, one of their accounts", inUse: true },
      anthropic: { kind: "fallback", via: "other-harness", loses: "Codex speaks only OpenAI's APIs" },
      "openai-chat": { kind: "native", via: "provider-config", how: "`config.model_providers` with `base_url`, `env_key` and `wire_api`, and `modelProvider` on the thread", inUse: false },
      "openai-responses": { kind: "native", via: "provider-config", how: "`config.model_providers` with `wire_api = \"responses\"`, and `modelProvider` on the thread", inUse: false },
    },
    personSetup: "kept",
  },
  apply(layer, conversation) {
    const instructions = instructionText(layer)
    return {
      ...instructions !== undefined && { instructions },
      servers: layer.servers.map(({ name, url }) => ({ name, url })),
      config: () => spawnsRemoved(layer, "codex", "agents.enabled", conversation) ? SPAWNS_OFF : {},
    }
  },
}
