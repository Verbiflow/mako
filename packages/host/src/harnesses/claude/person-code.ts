import type { ResolvedSettings } from "@anthropic-ai/claude-agent-sdk"

/**
 * Whether Claude Code runs an MCP server's code as it takes `text`, before any tool: the two ways a message reaches
 * a server with no tool call, and so with no PreToolUse callback to hold it.
 *
 * A message that begins `/` is a command. `/mcp__…` is a server's prompt, fetched from the server as the command is
 * dispatched, and a command of the person's own (`.claude/commands`) may run a shell line as it expands. Which
 * commands exist and what each runs is Claude Code's to know, so every one waits.
 *
 * A word with `@`, at least one character and then `:` may be a resource mention, `@server:uri`, which Claude Code
 * reads from the server as the turn starts. Claude Code 2.1 takes a mention from each word at an `@` that begins it
 * or follows an opening mark, and only for a connected server and a resource it lists; Mako knows neither list, so
 * every such word counts, a `git@host:path` included. A wrong yes costs the wait for the checkpoint; a wrong no
 * would let the server's code run ahead of it. An `@` with a space before its colon ("at @ noon: lunch") is no
 * mention to Claude Code and none here.
 */
export function claudeSubmitRunsServer(text: string): boolean {
  return text.trimStart().startsWith("/") || /@\S+:/.test(text)
}

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
 *
 * The person's own MCP servers, stdio ones included, don't count, wherever they are configured: a server's tool is
 * called only after Mako's PreToolUse callback answers, and that holds it (`claudeCallHooks`). Servers an admin
 * manages stay counted with the rest of what a managed source may bring.
 */
export function settingsRunCode(resolved: ResolvedSettings): boolean {
  if (resolved.machinePolicy && resolved.machinePolicy.didNotLoad !== false) return true
  return resolved.sources.some((source) => sourceRunsCode(source.settings))
}
