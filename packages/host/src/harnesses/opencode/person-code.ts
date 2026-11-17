import { z } from "zod"
import type { JsonValue } from "../../contracts/json.js"

/** What OpenCode's server says for the launch's folder, read here as it's parsed; a request it fails throws. */
export interface OpenCodeAsk {
  /** `plugin.list`: every plugin it loaded, built-ins and Mako's own included. */
  plugins(): Promise<object>
  /** `mcp.list`: every MCP server it runs for the folder. */
  servers(): Promise<object>
  /** `config.get`: the config documents it read for the folder. */
  config(): Promise<object>
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
/**
 * Its config, as documents and the folders they came from. OpenCode 1 ran shell commands a config named under
 * `experimental.hook` (`file_edited`, `session_completed`); OpenCode 2's schema has no such key, but one a config still
 * carries counts, in case a build honours it.
 */
const ConfigEntries = z.array(z.union([
  z.object({ type: z.literal("document"), info: z.object({ experimental: z.object({ hook: z.json().optional() }).loose().optional() }).loose() }).loose(),
  z.object({ type: z.literal("directory") }).loose(),
]))

/** What Mako itself gave this launch: its plugin, by the file OpenCode names it by, and the MCP servers it added, by name, each a process or not. */
export interface OpenCodeLaunch {
  pluginFiles: readonly string[]
  servers: readonly { name: string; process: boolean }[]
}

const HookTable = z.record(z.string(), z.json())
const HookList = z.array(z.json())

/** Whether a config's `experimental.hook` names any command: anything but nothing, or an empty table or list. */
function hasHooks(hook: JsonValue | undefined): boolean {
  if (hook === undefined || hook === null) return false
  const table = HookTable.safeParse(hook)
  if (table.success) return Object.values(table.data).some((value) => hasHooks(value))
  const list = HookList.safeParse(hook)
  return list.success ? list.data.length > 0 : true
}

/**
 * Whether the person's own code may run in an OpenCode session beside Mako's plugin, so a write could go before a
 * turn's checkpoint holds the workspace, as OpenCode itself says once its plugins are active: any plugin it loaded
 * that's neither built in nor Mako's own, or one that failed to load; an MCP server of the launch's that runs as a
 * process; an MCP server it runs that Mako didn't add (from the person's own config, of a kind Mako can't tell). A
 * config's `experimental.hook` naming a command (`config.get`). A request that fails, or an answer Mako can't read,
 * counts too. A launch where this is true holds no writes; its
 * message waits for the checkpoint (`WriteHolds.attend`).
 */
export async function openCodePersonCodeRuns(ask: OpenCodeAsk, launch: OpenCodeLaunch): Promise<boolean> {
  try {
    const plugins = PluginList.parse(await ask.plugins())
    for (const plugin of plugins.data) {
      if (plugin.state.status !== "active") return true
      if (plugin.source.type === "builtin") continue
      if (plugin.source.type === "local" && launch.pluginFiles.includes(plugin.source.path)) continue
      return true
    }
    const config = ConfigEntries.parse(await ask.config())
    if (config.some((entry) => entry.type === "document" && hasHooks(entry.info.experimental?.hook))) return true
    if (launch.servers.some((server) => server.process)) return true
    const added = new Set(launch.servers.map((server) => server.name))
    return ServerList.parse(await ask.servers()).data.some((server) => !added.has(server.name))
  } catch {
    return true
  }
}
