import type { Options, ResolvedSettings } from "@anthropic-ai/claude-agent-sdk"

/**
 * Settings that run the person's own commands in a Claude Code session beside Mako's hook: helpers it runs at
 * launch or as it goes (credentials, telemetry headers, a proxy's auth, the status line) and the admin's
 * `policyHelper`, which `resolveSettings` doesn't run, so whatever it would add is unknown.
 */
const COMMANDS = ["policyHelper", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper", "proxyAuthHelper", "statusLine"] as const

/** One settings source, as `resolveSettings` lists it, read as the keys that run code. */
type SourceSettings = ResolvedSettings["sources"][number]["settings"]

/** Whether one settings source runs the person's code: hooks, an enabled plugin, a command it runs, managed MCP servers. */
function sourceRunsCode(settings: SourceSettings): boolean {
  if (settings.hooks && Object.keys(settings.hooks).length > 0) return true
  if (settings.enabledPlugins && Object.values(settings.enabledPlugins).some((enabled) => enabled !== false)) return true
  if (COMMANDS.some((key) => settings[key] !== undefined)) return true
  return Boolean(settings.managedMcpServers && Object.keys(settings.managedMcpServers).length > 0)
}

/**
 * Whether the person's own code may run in a Claude Code session beside Mako's hook, so a write could go before a
 * turn's checkpoint holds the workspace, as Claude Code itself resolves its settings (`resolveSettings`: every tier,
 * the policy tier's remote-cached, MDM and `managedSettings` sources included): any source with hooks, an enabled
 * plugin, a command it runs or managed MCP servers, or a machine policy source that didn't load (it may hold any of
 * them). A launch where this is true holds no writes; its message waits for the checkpoint (`WriteHolds.attend`).
 */
export function settingsRunCode(resolved: ResolvedSettings): boolean {
  if (resolved.machinePolicy && resolved.machinePolicy.didNotLoad !== false) return true
  return resolved.sources.some((source) => sourceRunsCode(source.settings))
}

/** Whether a launch's own MCP servers start a process of the person's: any stdio server, which Mako's never are. */
export function launchRunsServers(config: Pick<Options, "mcpServers">): boolean {
  return Object.values(config.mcpServers ?? {}).some((server) => !("type" in server) || server.type === undefined || server.type === "stdio")
}
