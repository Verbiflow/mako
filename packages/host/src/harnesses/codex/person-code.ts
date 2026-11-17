import { z } from "zod"
import type { JsonObject, JsonValue } from "../../contracts/json.js"

/** What Codex's app-server says for a folder, one question each; a request it fails throws. */
export interface CodexAsk {
  hooks(cwd: string): Promise<JsonObject>
  config(cwd: string): Promise<JsonObject>
  plugins(cwd: string): Promise<JsonObject>
}

const HooksList = z.object({ data: z.array(z.object({ hooks: z.array(z.unknown()), errors: z.array(z.unknown()) }).loose()) }).loose()
const ConfigRead = z.object({
  config: z.object({ features: z.object({ plugins: z.boolean().nullish() }).loose().nullish() }).loose(),
  layers: z.array(z.object({ config: z.json() }).loose()),
}).loose()
const PluginsInstalled = z.object({
  marketplaces: z.array(z.object({ plugins: z.array(z.object({ installed: z.boolean(), enabled: z.boolean() }).loose()) }).loose()),
  marketplaceLoadErrors: z.array(z.unknown()).optional(),
}).loose()
const Table = z.record(z.string(), z.json())
const List = z.array(z.json())
/** An MCP server Codex starts as a process: one that names its command. */
const Process = z.object({ command: z.json() }).loose()

/** Whether an `mcp_servers` table names a server Codex starts as a process; one Mako can't read may. */
function serversStart(servers: JsonValue): boolean {
  const table = Table.safeParse(servers)
  if (!table.success) return true
  return Object.values(table.data).some((server) => !Table.safeParse(server).success || Process.safeParse(server).success)
}

/** Whether a config layer, however deeply (`[profiles.x.mcp_servers]` too), names an MCP server Codex starts as a process. */
function startsServers(value: JsonValue): boolean {
  const list = List.safeParse(value)
  if (list.success) return list.data.some(startsServers)
  const table = Table.safeParse(value)
  if (!table.success) return false
  return Object.entries(table.data).some(([key, inner]) => (key === "mcp_servers" ? serversStart(inner) : startsServers(inner)))
}

/**
 * Whether the person's own code may run in a Codex session beside Mako's hook, so a write could go before a turn's
 * checkpoint holds the workspace, as Codex itself says (its app-server, before the thread opens): any hook it would
 * run for the folder (`hooks/list`: every config layer, managed requirements and plugins), or an error loading one;
 * an MCP server it starts as a process in any config layer (`config/read`, every layer the folder resolves); an
 * installed, enabled plugin, which may bring both, unless plugins are off; a marketplace that didn't load. A request
 * that fails, or an answer Mako can't read, counts too. A launch where this is true holds no writes; its message waits
 * for the checkpoint (`WriteHolds.attend`).
 */
export async function codexPersonCodeRuns(ask: CodexAsk, cwd: string): Promise<boolean> {
  try {
    const hooks = HooksList.parse(await ask.hooks(cwd))
    if (hooks.data.some((entry) => entry.hooks.length > 0 || entry.errors.length > 0)) return true
    const config = ConfigRead.parse(await ask.config(cwd))
    if (config.layers.some((layer) => startsServers(layer.config))) return true
    if (config.config.features?.plugins === false) return false
    const plugins = PluginsInstalled.parse(await ask.plugins(cwd))
    if (plugins.marketplaceLoadErrors?.length) return true
    return plugins.marketplaces.some((market) => market.plugins.some((plugin) => plugin.installed && plugin.enabled))
  } catch {
    return true
  }
}
