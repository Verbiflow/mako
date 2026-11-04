import type { LayerAdapter } from "../../contracts/mako-layer.js"
import { bearerServers, spawnsRemoved } from "../mako-layer.js"

export interface CursorLayerFragment {
  /** Mako's servers for the agent's `mcpServers`, beside the person's own. */
  servers: Record<string, { type: "http"; url: string; headers: Record<string, string> }>
  /** `disallowedTools: ["task"]` on every create and resume, read as the agent opens; the SDK keeps no exclusion on the agent. */
  noTask(): true | undefined
}

export const cursorLayer: LayerAdapter<CursorLayerFragment> = {
  harness: "cursor",
  capabilities: {
    instructions: { kind: "fallback", via: "prompt-note", loses: "a turn reads them with each message rather than once; the SDK's `systemPrompt` replaces Cursor's own prompt, so Mako never uses it" },
    toolServing: { kind: "native", via: "http-mcp", how: "the agent's `mcpServers`, the grant as a bearer header", inUse: true },
    removal: { kind: "native", via: "tool-list", how: "`disallowedTools` (deny wins over `tools`; main loop only); today only `task`, for a lead", inUse: true },
    interception: { kind: "fallback", via: "words", loses: "nothing refuses a native call yet; the instructions name Mako's tools" },
    subagents: { kind: "fallback", via: "words", loses: "Cursor curates its own `task` subagents; the instructions say when to start a Fin" },
    hooks: { kind: "native", via: "config-hooks", how: "the SDK's run events, and the project's `.cursor/hooks.json` through `settingSources`", inUse: true },
    modelRoute: {
      "native-login": { kind: "native", via: "login", how: "the person's Cursor account or key", inUse: true },
      anthropic: { kind: "fallback", via: "other-harness", loses: "Cursor runs only its own catalog" },
      "openai-chat": { kind: "fallback", via: "other-harness", loses: "Cursor runs only its own catalog" },
      "openai-responses": { kind: "fallback", via: "other-harness", loses: "Cursor runs only its own catalog" },
    },
    personSetup: "kept",
  },
  apply(layer, conversation) {
    const servers: CursorLayerFragment["servers"] = {}
    for (const { name, url, authorization } of bearerServers(layer))
      servers[name] = { type: "http", url, headers: { Authorization: authorization } }
    return {
      servers,
      noTask: () => spawnsRemoved(layer, "cursor", "disallowedTools task", conversation) || undefined,
    }
  },
}
