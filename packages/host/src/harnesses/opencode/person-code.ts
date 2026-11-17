import { z } from "zod"

/** What OpenCode's server says for the launch's folder, read here as it's parsed; a request it fails throws. */
export interface OpenCodeAsk {
  /** `plugin.list`: every plugin it loaded, built-ins and Mako's own included. */
  plugins(): Promise<object>
  /** `mcp.list`: every MCP server it runs for the folder. */
  servers(): Promise<object>
}

const PluginList = z.object({
  data: z.array(z.object({
    source: z.union([
      z.object({ type: z.literal("builtin") }).loose(),
      z.object({ type: z.literal("local"), path: z.string() }).loose(),
      z.object({ type: z.enum(["package", "sdk"]) }).loose(),
    ]),
    state: z.object({ status: z.string() }).loose(),
  }).loose()),
}).loose()
const ServerList = z.object({ data: z.array(z.object({ name: z.string() }).loose()) }).loose()

/** What Mako itself gave this launch: its plugin's folder, and the MCP servers it added, by name, each a process or not. */
export interface OpenCodeLaunch {
  pluginFolder: string
  servers: readonly { name: string; process: boolean }[]
}

/**
 * Whether the person's own code may run in an OpenCode session beside Mako's plugin, so a write could go before a
 * turn's checkpoint holds the workspace, as OpenCode itself says once its plugins are active: any plugin it loaded
 * that's neither built in nor Mako's own, or one that failed to load; an MCP server of the launch's that runs as a
 * process; an MCP server it runs that Mako didn't add (from the person's own config, of a kind Mako can't tell). A
 * request that fails, or an answer Mako can't read, counts too. A launch where this is true holds no writes; its
 * message waits for the checkpoint (`WriteHolds.attend`).
 */
export async function openCodePersonCodeRuns(ask: OpenCodeAsk, launch: OpenCodeLaunch): Promise<boolean> {
  try {
    const plugins = PluginList.parse(await ask.plugins())
    for (const plugin of plugins.data) {
      if (plugin.state.status !== "active") return true
      if (plugin.source.type === "builtin") continue
      if (plugin.source.type === "local" && plugin.source.path.includes(launch.pluginFolder)) continue
      return true
    }
    if (launch.servers.some((server) => server.process)) return true
    const added = new Set(launch.servers.map((server) => server.name))
    return ServerList.parse(await ask.servers()).data.some((server) => !added.has(server.name))
  } catch {
    return true
  }
}
