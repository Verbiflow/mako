import type { McpServer } from "@agentclientprotocol/sdk"
import { projectRuntimeDefinitions } from "./mcp-registry.js"
import type {
  McpProvider,
  McpRegistrySnapshot,
  McpServerDefinition,
  McpTransport,
} from "./shared.js"
import type { JsonObject } from "./codex-app-json.js"
import { backendConnectionCredentials } from "./backend-connection.js"

function backendHeaders(definition: McpServerDefinition): Array<{
  name: string
  value: string
}> {
  const credentials = backendConnectionCredentials()
  if (definition.name !== "mako-backend" || !credentials) return []
  return [
    {
      name: "Authorization",
      value: `Bearer ${credentials.token}`,
    },
  ]
}

export function acpMcpServers(
  snapshot: McpRegistrySnapshot,
  provider: Exclude<McpProvider, "mako">,
  transports: readonly McpTransport[]
): McpServer[] {
  return projectRuntimeDefinitions(snapshot, provider, transports).flatMap(
    (definition): McpServer[] => {
      if (definition.transport === "stdio" && definition.command) {
        return [
          {
            name: definition.name,
            command: definition.command,
            args: definition.args ?? [],
            env: [],
          },
        ]
      }
      if (
        (definition.transport === "http" || definition.transport === "sse") &&
        definition.url
      ) {
        const headers = backendHeaders(definition)
        if (definition.headerNames.length > 0 && headers.length === 0) return []
        return [
          {
            type: definition.transport,
            name: definition.name,
            url: definition.url,
            headers,
          },
        ]
      }
      return []
    }
  )
}

function codexDefinition(
  definition: McpServerDefinition
): JsonObject | null {
  if (definition.transport === "stdio" && definition.command) {
    const result: JsonObject = {
      command: definition.command,
      args: definition.args ?? [],
    }
    return result
  }
  if (definition.transport === "http" && definition.url) {
    const headers = backendHeaders(definition)
    if (definition.headerNames.length > 0 && headers.length === 0) return null
    const result: JsonObject = { url: definition.url }
    if (headers.length > 0) {
      result.http_headers = Object.fromEntries(
        headers.map(({ name, value }) => [name, value])
      )
    }
    return result
  }
  return null
}

/**
 * How long a harness lets a call to Mako's own servers run: past app_check's
 * ten-minute wait. Codex and Claude Code each end an MCP call after 60
 * seconds unless the server's entry says otherwise.
 */
export const MAKO_TOOL_TIMEOUT_MS = 15 * 60_000

export function codexMcpConfig(
  snapshot: McpRegistrySnapshot,
  makoServers: ReadonlyArray<{ name: string; url: string }> = []
): JsonObject {
  const servers: JsonObject = {}
  for (const definition of projectRuntimeDefinitions(snapshot, "codex", [
    "stdio",
    "http",
  ])) {
    const projected = codexDefinition(definition)
    if (projected) servers[definition.name] = projected
  }
  for (const { name, url } of makoServers)
    servers[name] = { url, bearer_token_env_var: "MAKO_CONVERSATIONS_TOKEN", tool_timeout_sec: MAKO_TOOL_TIMEOUT_MS / 1000 }
  return Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}
}

export function mergeCodexConfig(
  base: JsonObject | undefined,
  injected: JsonObject
): JsonObject | undefined {
  if (!base && Object.keys(injected).length === 0) return undefined
  return base ? { ...injected, ...base } : { ...injected }
}
