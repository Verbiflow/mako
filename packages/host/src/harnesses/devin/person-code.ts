import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { foldersDown, gitRoot } from "../../tools/index.js"

/** A config file's hooks: the event map itself, each event a list of matcher groups. */
const HookEvents = z.record(z.string(), z.array(z.json()))
/** A file whose `hooks` key holds them, as Devin's configs and Claude Code's settings do. */
const WithHooks = z.object({ hooks: HookEvents.optional() }).loose()
/** An MCP config: servers by name, one with a `command` run as a process. */
const McpConfig = z.object({ mcpServers: z.record(z.string(), z.object({ command: z.string().optional() }).loose()).optional() }).loose()

/** A file read as `schema`; undefined when it isn't there, which says nothing runs from it. Any other failure throws. */
async function read<Read>(path: string, schema: z.ZodType<Read>): Promise<Read | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined
    throw error
  }
  return schema.parse(JSON.parse(text))
}

const anyHook = (events: z.infer<typeof HookEvents> | undefined) => Object.values(events ?? {}).some((groups) => groups.length > 0)

/**
 * Whether the person's own code may run in a Devin session beside Mako's hook, so a write could go before a turn's
 * checkpoint holds the workspace. Devin says nothing of what it loads, so this reads the files Mako knows it reads
 * (`createDevinHooks`, `devinMcpSource`), before the launch's own config folder replaces the person's in `env`:
 *
 * - a hook of any event in any file Devin runs hooks from: `.devin/hooks.v1.json`, `.devin/config.json`,
 *   `.devin/config.local.json` and Claude Code's `.claude/settings.json` and `settings.local.json` in each folder from
 *   the repository's root down to `cwd`, the user's `devin/config.json` and Claude Code's user settings. Devin runs
 *   every file's hooks, the person's ahead of the one Mako appends, and one on a prompt runs with no tool call between;
 * - an MCP server run as a process: one Mako passes the launch that isn't its own (`servers`), or one in the person's
 *   `mcp_config.json` or the folder's `.devin/mcp_config.json` and `mcp_config.local.json`.
 *
 * A file that can't be read or isn't what it should be counts too. A launch where this is true holds no writes; its
 * message waits for the checkpoint (`WriteHolds.attend`).
 */
export async function devinPersonCodeRuns(launch: { env: NodeJS.ProcessEnv; cwd: string; servers: readonly { name: string; process: boolean }[] }): Promise<boolean> {
  if (launch.servers.some((server) => server.process)) return true
  const home = launch.env.HOME || homedir()
  const config = join(launch.env.XDG_CONFIG_HOME || join(home, ".config"), "devin")
  try {
    const root = await gitRoot(launch.cwd) ?? launch.cwd
    const whole: string[] = []
    const keyed = [join(config, "config.json"), join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json")]
    for (const folder of foldersDown(root, launch.cwd)) {
      whole.push(join(folder, ".devin", "hooks.v1.json"))
      keyed.push(join(folder, ".devin", "config.json"), join(folder, ".devin", "config.local.json"), join(folder, ".claude", "settings.json"), join(folder, ".claude", "settings.local.json"))
    }
    for (const path of whole) if (anyHook(await read(path, HookEvents))) return true
    for (const path of keyed) if (anyHook((await read(path, WithHooks))?.hooks)) return true
    for (const path of [join(config, "mcp_config.json"), join(launch.cwd, ".devin", "mcp_config.json"), join(launch.cwd, ".devin", "mcp_config.local.json")])
      if (Object.values((await read(path, McpConfig))?.mcpServers ?? {}).some((server) => server.command !== undefined)) return true
    return false
  } catch {
    return true
  }
}
