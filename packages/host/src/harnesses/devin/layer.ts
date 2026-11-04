import type { LayerCapabilities } from "../../contracts/mako-layer.js"

/** How Devin takes the Mako layer, through Mako's ACP driver (`acpLayer`). */
export const DEVIN_LAYER: LayerCapabilities = {
  instructions: { kind: "fallback", via: "prompt-note", loses: "a turn reads them with each message rather than once: ACP has no slot of its own for them" },
  toolServing: { kind: "native", via: "http-mcp", how: "MCP servers in the launch's own `mcp_config.json`, the grant as a bearer header", inUse: true },
  removal: { kind: "native", via: "config-switch", how: "`subagents_enabled: false` in the launch's copy of the person's `config.json`, which takes out spawning only; any other native tool falls back to interception", inUse: true },
  interception: { kind: "native", via: "pre-tool-hook", how: "hooks appended to the person's own in the launch's copy of `config.json`, posting each call to Mako", inUse: true },
  subagents: { kind: "fallback", via: "words", loses: "Devin declares no agents Mako can define; the instructions say when to start a Fin" },
  hooks: { kind: "native", via: "config-hooks", how: "hooks in the launch's own config folder", inUse: true },
  modelRoute: {
    "native-login": { kind: "native", via: "login", how: "the person's Devin account", inUse: true },
    anthropic: { kind: "absent", reason: "Devin runs only the models its account serves" },
    "openai-chat": { kind: "absent", reason: "Devin runs only the models its account serves" },
    "openai-responses": { kind: "absent", reason: "Devin runs only the models its account serves" },
  },
  personSetup: "kept",
}
