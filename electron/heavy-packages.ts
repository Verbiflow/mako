import { lazyPackage, onPackageLoad } from "@mako/lazy"
import { heavy as controlRuntime } from "@mako/control-runtime/heavy-packages"
import { hostLog, hostWarn } from "./host-log.js"

onPackageLoad((load) => {
  if (load.state === "ready") hostLog("packages", `loaded ${load.name}`, { ms: load.ms, for: load.reason })
  if (load.state === "failed") hostWarn("packages", `could not load ${load.name}`, { ms: load.ms, for: load.reason, error: load.error })
})

/**
 * Every heavy package the host uses, each loaded the first time a feature
 * needs it rather than with the host, which answers its first client without
 * any of them. Nothing else in the host imports them, or the adapter modules
 * that use them: the `mako/heavy-packages` lint rule holds that, from the list
 * in scripts/heavy-packages.json.
 *
 * What has loaded, when, for what and in how long is in host.log and at the
 * web host's `/packages`.
 */
export const heavy = {
  ...controlRuntime,
  claudeAgentSdk: lazyPackage("@anthropic-ai/claude-agent-sdk", () => import("@anthropic-ai/claude-agent-sdk")),
  acpSdk: lazyPackage("@agentclientprotocol/sdk", () => import("@agentclientprotocol/sdk")),
  /** ACP's form schemas, read into Mako's questions. */
  acpElicitation: lazyPackage("@agentclientprotocol/sdk (acp-elicitation.ts)", () => import("./acp-elicitation.js")),
  devinApprovals: lazyPackage("@agentclientprotocol/sdk (providers/devin/approval-observer.ts)", () =>
    import("./providers/devin/approval-observer.js")),
  /** MCP's server SDK and Local Control's server, for the agents' `mako` and `computer` servers. */
  mcpServer: lazyPackage("@modelcontextprotocol/sdk server (@mako/control-runtime/mcp)", () =>
    Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("@mako/control-runtime/mcp"),
    ]).then(([{ McpServer }, { StreamableHTTPServerTransport }, { createControlMcpServer }]) =>
      ({ McpServer, StreamableHTTPServerTransport, createControlMcpServer }))),
  /** The AI SDK and its providers, for utility models. */
  utilityLanguage: lazyPackage("ai, @ai-sdk/* (utility-language.ts)", () => import("./utility-language.js")),
  /** The keychain from this process, a native addon: see keychain.ts. */
  keyring: lazyPackage("@napi-rs/keyring", () => import("@napi-rs/keyring")),
  yaml: lazyPackage("yaml", () => import("yaml")),
  fileType: lazyPackage("file-type", () => import("file-type")),
}
