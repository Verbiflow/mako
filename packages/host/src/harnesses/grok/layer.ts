import type { LayerCapabilities } from "../../contracts/mako-layer.js"

/** How Grok takes the Mako layer, through Mako's ACP driver (`acpLayer`). */
export const GROK_LAYER: LayerCapabilities = {
  instructions: { kind: "fallback", via: "prompt-note", loses: "a turn reads them with each message rather than once: ACP has no slot of its own for them" },
  toolServing: { kind: "native", via: "http-mcp", how: "`session/new` MCP servers, the grant as a bearer header", inUse: true },
  removal: { kind: "native", via: "environment-switch", how: "`GROK_SUBAGENTS=0` and `GROK_WORKFLOWS=0`, which take out spawning only; any other native tool falls back to interception", inUse: true },
  interception: { kind: "fallback", via: "words", loses: "nothing refuses a native call yet; ACP client hooks in the session's `_meta` would" },
  subagents: { kind: "fallback", via: "words", loses: "Grok declares no agents Mako can define; the instructions say when to start a Fin" },
  hooks: { kind: "native", via: "client-hooks", how: "ACP client hooks Mako answers", inUse: true },
  modelRoute: {
    "native-login": { kind: "native", via: "login", how: "the person's xAI account", inUse: true },
    anthropic: { kind: "absent", reason: "not yet known whether the Grok CLI takes another endpoint" },
    "openai-chat": { kind: "absent", reason: "not yet known whether the Grok CLI takes another endpoint" },
    "openai-responses": { kind: "absent", reason: "not yet known whether the Grok CLI takes another endpoint" },
  },
  personSetup: "kept",
}
