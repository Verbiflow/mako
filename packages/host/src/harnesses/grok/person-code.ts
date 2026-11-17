import { z } from "zod"
import { hostCommand } from "../../base/host-command.js"

/**
 * What `grok inspect --json` says Grok will load for a folder (1.0.70). Hooks, plugins and repo-local MCP and LSP
 * servers all load only in a trusted folder, the person's own hooks too (`~/.grok/hooks`, `~/.grok/config.toml`,
 * `~/.claude/settings.json`), so in an untrusted folder `hooks` is `[]` whatever would run once it's trusted: it says
 * nothing there, and Mako reads it only when `projectTrusted` is true.
 */
const Inspect = z.object({
  projectTrusted: z.boolean(),
  hooks: z.array(z.json()),
  plugins: z.array(z.json()),
  mcpServers: z.array(z.json()),
  lspServers: z.array(z.json()),
}).loose()

/** How long Grok has to say what it loads before the launch goes on without a hold. */
const INSPECT_MS = 10_000

/** What Mako itself gave this launch: the MCP servers it passes Grok over ACP, by name, each a process or not, Mako's own told apart. */
export interface GrokLaunch {
  servers: readonly { name: string; process: boolean }[]
}

/** Grok's own account of a folder, as `grok inspect --json` prints it: the launch's executable, environment and folder. */
export function grokInspect(executable: string, env: NodeJS.ProcessEnv, cwd: string): () => Promise<string> {
  return async () => (await hostCommand(executable, ["inspect", "--json"], { cwd, env, timeout: INSPECT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout
}

/**
 * Whether the person's own code may run in a Grok session beside Mako's hook, so a write could go before a turn's
 * checkpoint holds the workspace, as Grok itself says (`grok inspect --json`): a folder it doesn't trust, where it
 * reports nothing of what would load once trusted; any hook, plugin, MCP server or LSP server it loads there. An MCP
 * server of the launch's that's the person's and runs as a process counts too, and so does an answer that fails or
 * that Mako can't read. A launch where this is true holds no writes; its message waits for the checkpoint
 * (`WriteHolds.attend`).
 */
export async function grokPersonCodeRuns(inspect: () => Promise<string>, launch: GrokLaunch): Promise<boolean> {
  if (launch.servers.some((server) => server.process)) return true
  try {
    const said = Inspect.parse(JSON.parse(await inspect()))
    if (!said.projectTrusted) return true
    return said.hooks.length > 0 || said.plugins.length > 0 || said.mcpServers.length > 0 || said.lspServers.length > 0
  } catch {
    return true
  }
}
