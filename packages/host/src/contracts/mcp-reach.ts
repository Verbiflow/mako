import type {
  McpProvider,
  McpRegistrySnapshot,
  McpServerRecord,
  McpTransport,
} from "./mcp-skills-integrations.js"
import type { HarnessProfile } from "./providers-acp.js"

/** The per-conversation server for browser and computer use. */
export const MAKO_COMPUTER_SERVER = "mako-computer"
/** The per-conversation server for the Thread's worktree, app and recipe. */
export const MAKO_THREAD_SERVER = "mako"

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

const SCOPE_ORDER = { managed: 0, user: 1, workspace: 2, effective: 3 } as const

/** The most specific native source decides; disabled definitions still reserve their name. */
function ownServerEnabled(server: McpServerRecord, provider: McpProvider): boolean {
  let selected: McpServerRecord["origins"][number] | undefined
  for (const origin of server.origins) {
    if (origin.provider !== provider) continue
    if (!selected || SCOPE_ORDER[origin.scope] >= SCOPE_ORDER[selected.scope]) selected = origin
  }
  return selected !== undefined && selected.enabled !== false
}

function enabledSomewhere(server: McpServerRecord): boolean {
  return server.origins.some((origin) => ownServerEnabled(server, origin.provider))
}

function ownServerNames(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider
): Set<string> {
  return new Set(
    snapshot.servers
      .filter(
        (server) =>
          server.origins.some((origin) => origin.provider === provider)
      )
      .map((server) => server.name)
  )
}

/**
 * Servers the host adds to a launch beyond the provider's own configuration.
 *
 * A provider loads its own configuration natively. On top of that the host
 * projects portable definitions from other providers into every launch
 * (`acpMcpServers`, `codexMcpConfig`, Claude's SDK options). The composer's
 * `/` and `$` menu lists the union, so both the launch and the menu read this
 * one predicate. Conflicts and servers observed unavailable are never
 * projected.
 */
export function projectedMcpServers(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerRecord[] {
  const own = ownServerNames(snapshot, provider)
  return snapshot.servers.filter((server) => {
    return (
      server.portable &&
      !server.conflict &&
      server.availability !== "unavailable" &&
      enabledSomewhere(server) &&
      transports.includes(server.transport) &&
      !own.has(server.name) &&
      !isMakoManagedServer(server)
    )
  })
}

/** The provider's own servers plus everything the host projects, in snapshot order. */
export function reachableMcpServers(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerRecord[] {
  const projected = new Set(
    projectedMcpServers(snapshot, provider, transports).map(
      (server) => server.name
    )
  )
  return snapshot.servers.filter(
    (server) => (server.availability !== "unavailable" && ownServerEnabled(server, provider)) || projected.has(server.name)
  )
}
