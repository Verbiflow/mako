import type { McpServer } from "@agentclientprotocol/sdk"
import { isMakoNodeServer, projectRuntimeDefinitions } from "./mcp-registry.js"
import type {
  McpProvider,
  McpRegistrySnapshot,
  McpServerDefinition,
  McpTransport,
} from "./shared.js"
import type { JsonObject } from "./codex-app-json.js"
import { backendConnectionCredentials } from "./backend-connection.js"
import type { ControlCredentials } from "./control-service.js"

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

function localEnvironment(
  definition: McpServerDefinition,
  control?: ControlCredentials,
  taskId?: string
): Array<{
  name: string
  value: string
}> {
  const environment = isMakoNodeServer(definition.name)
    ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]
    : []
  const controlServer = definition.name === "mako-control"
  if (controlServer && control)
    environment.push(
      { name: "MAKO_CONTROL_URL", value: control.url },
      { name: "MAKO_CONTROL_TOKEN", value: control.token }
    )
  // The task id names the driver session and the artifact directory that
  // oversized program results are written to.
  if (controlServer && taskId)
    environment.push({ name: "MAKO_TASK_ID", value: taskId })
  return environment
}

export function acpMcpServers(
  snapshot: McpRegistrySnapshot,
  provider: Exclude<McpProvider, "mako">,
  transports: readonly McpTransport[],
  control?: ControlCredentials,
  taskId?: string
): McpServer[] {
  return projectRuntimeDefinitions(snapshot, provider, transports).flatMap(
    (definition): McpServer[] => {
      if (definition.transport === "stdio" && definition.command) {
        return [
          {
            name: definition.name,
            command: definition.command,
            args: definition.args ?? [],
            env: localEnvironment(definition, control, taskId),
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
  definition: McpServerDefinition,
  control?: ControlCredentials,
  taskId?: string
): JsonObject | null {
  if (definition.transport === "stdio" && definition.command) {
    const result: JsonObject = {
      command: definition.command,
      args: definition.args ?? [],
    }
    const environment = localEnvironment(definition, control, taskId)
    if (environment.length > 0) {
      result.env = Object.fromEntries(
        environment.map(({ name, value }) => [name, value])
      )
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

export function codexMcpConfig(
  snapshot: McpRegistrySnapshot,
  conversationToolsUrl?: string,
  control?: ControlCredentials,
  taskId?: string
): JsonObject {
  const servers: JsonObject = {}
  for (const definition of projectRuntimeDefinitions(snapshot, "codex", [
    "stdio",
    "http",
  ])) {
    const projected = codexDefinition(definition, control, taskId)
    if (projected) servers[definition.name] = projected
  }
  if (conversationToolsUrl)
    servers["mako-conversations"] = {
      url: conversationToolsUrl,
      bearer_token_env_var: "MAKO_CONVERSATIONS_TOKEN",
    }
  return Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}
}

export function mergeCodexConfig(
  base: JsonObject | undefined,
  injected: JsonObject
): JsonObject | undefined {
  if (!base && Object.keys(injected).length === 0) return undefined
  return base ? { ...injected, ...base } : { ...injected }
}
