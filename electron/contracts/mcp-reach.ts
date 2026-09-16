import type {
  McpProvider,
  McpRegistrySnapshot,
  McpServerRecord,
  McpTransport,
} from "./mcp-skills-integrations.js"
import type { HarnessProfile } from "./providers-acp.js"

/**
 * Which MCP servers a provider has when Mako launches it.
 *
 * A provider loads its own configuration natively. On top of that the host
 * projects portable definitions from other providers and Mako's managed
 * runtime servers into every launch (`acpMcpServers`, `codexMcpConfig`,
 * Claude's SDK options). The composer's `/` and `$` menu lists the union, so
 * both the launch and the menu read this one predicate. Conflicts and servers
 * observed unavailable are never projected.
 */
export const MAKO_RUNTIME_SERVERS: ReadonlySet<string> = new Set([
  "mako-control",
  "mako-backend",
])

/** Every provider also receives Mako's conversation tools at launch. */
export const MAKO_CONVERSATIONS_SERVER = "mako-conversations"

const ALL_TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"]
const LOCAL_AND_HTTP: readonly McpTransport[] = ["stdio", "http"]

/**
 * The MCP transports a provider can open, by how Mako drives it. ACP launches
 * pass every transport through; Codex's app-server and Claude's SDK accept
 * stdio and streamable HTTP. Unknown or remote drivers are read permissively
 * so a menu never hides a server the provider might well have.
 */
export function mcpTransportsFor(
  transport: HarnessProfile["transport"] | undefined
): readonly McpTransport[] {
  return transport === "app-server" || transport === "sdk"
    ? LOCAL_AND_HTTP
    : ALL_TRANSPORTS
}

export function isMakoManagedServer(server: McpServerRecord): boolean {
  return server.origins.some((origin) => origin.provider === "mako")
}

function ownServerNames(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider
): Set<string> {
  return new Set(
    snapshot.servers
      .filter(
        (server) =>
          server.availability !== "unavailable" &&
          server.origins.some((origin) => origin.provider === provider)
      )
      .map((server) => server.name)
  )
}

/** Servers the host adds to a launch beyond the provider's own configuration. */
export function projectedMcpServers(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerRecord[] {
  const own = ownServerNames(snapshot, provider)
  return snapshot.servers.filter((server) => {
    const managed = isMakoManagedServer(server)
    const managedRuntime =
      MAKO_RUNTIME_SERVERS.has(server.name) && !server.blockReason
    return (
      (server.portable || managedRuntime) &&
      !server.conflict &&
      server.availability !== "unavailable" &&
      transports.includes(server.transport) &&
      !own.has(server.name) &&
      (!managed || managedRuntime)
    )
  })
}

/** The provider's own servers plus everything the host projects, in snapshot order. */
export function reachableMcpServers(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerRecord[] {
  const own = ownServerNames(snapshot, provider)
  const projected = new Set(
    projectedMcpServers(snapshot, provider, transports).map(
      (server) => server.name
    )
  )
  return snapshot.servers.filter(
    (server) => own.has(server.name) || projected.has(server.name)
  )
}
