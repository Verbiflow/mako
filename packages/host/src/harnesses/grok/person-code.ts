import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { hostCommand } from "../../base/host-command.js"
import { hostLog } from "../../base/host-log.js"

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
 * What Grok reads to say what loads, so what can change its answer, by place (its hooks guide, 1.0.70): its home's
 * config, hooks, plugins, trust and policy files, the Claude and Cursor files it also reads, `/etc/grok`, and the
 * project files of the folder and of every folder above it, up to the home folder or the filesystem's root, whichever
 * comes first (a repository's root among them, which Grok takes the project's from). A hooks folder counts by each
 * file in it, since editing one moves only its own time.
 */
function readPlaces(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const home = env.HOME || homedir()
  const grok = env.GROK_HOME || join(home, ".grok")
  const places = [
    grok, join(grok, "config.toml"), join(grok, "hooks"), join(grok, "plugins"), join(grok, "trusted_folders.toml"),
    join(grok, "requirements.toml"), join(grok, "managed_config.toml"), "/etc/grok", "/etc/grok/requirements.toml",
    "/etc/grok/managed_config.toml", join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json"),
    join(home, ".claude.json"), join(home, ".cursor", "hooks.json"), join(home, ".cursor", "mcp.json"),
  ]
  for (let folder = cwd; ; folder = dirname(folder)) {
    places.push(join(folder, ".grok"), join(folder, ".grok", "config.toml"), join(folder, ".grok", "hooks"),
      join(folder, ".claude", "settings.json"), join(folder, ".claude", "settings.local.json"), join(folder, ".cursor", "hooks.json"),
      join(folder, ".cursor", "mcp.json"), join(folder, ".mcp.json"), join(folder, ".git"))
    if (dirname(folder) === folder || folder === home) break
  }
  return places
}

/** Each place's kind, size and time, or that it isn't there; a folder's own files too: what Grok's answer is held to. */
async function configStamp(env: NodeJS.ProcessEnv, cwd: string, executable: string): Promise<string> {
  const seen = async (path: string): Promise<string> => {
    const info = await stat(path).catch(() => undefined)
    if (!info) return "-"
    if (!info.isDirectory()) return `${info.size}:${info.mtimeMs}`
    const files = await readdir(path).catch(() => [])
    const inside = await Promise.all(files.sort().slice(0, 256).map(async (file) => `${file}=${(await stat(join(path, file)).catch(() => undefined))?.mtimeMs ?? "-"}`))
    return `d${info.mtimeMs}[${inside.join(",")}]`
  }
  const places = [executable, ...readPlaces(env, cwd)]
  const settings = ["GROK_HOME", "GROK_FOLDER_TRUST", "GROK_DISABLE_EXPERIMENTS"].map((name) => `${name}=${env[name] ?? ""}`)
  return [...settings, ...await Promise.all(places.map(async (place) => `${place}:${await seen(place)}`))].join("\n")
}

/** A Grok's answers for a folder, kept while what it read stands: by its executable, the folder and `configStamp`. */
export type GrokAnswers = Map<string, boolean>

/**
 * `grokPersonCodeRuns` for a launch, asking Grok only when what it reads changed since it last answered for that
 * folder (`answers`, kept by the engine). Only a definite answer is kept: one that failed is asked again next launch.
 */
export async function grokPersonCode(launch: { executable: string; env: NodeJS.ProcessEnv; cwd: string; servers: GrokLaunch["servers"] }, answers: GrokAnswers): Promise<boolean> {
  if (launch.servers.some((server) => server.process)) return true
  const began = performance.now()
  const stamp = await configStamp(launch.env, launch.cwd, launch.executable).catch(() => undefined)
  const key = stamp && `${launch.executable}\0${launch.cwd}\0${stamp}`
  const kept = key ? answers.get(key) : undefined
  if (kept !== undefined) {
    hostLog("grok", "person code read from Grok's last answer", { ms: Math.round(performance.now() - began), runs: kept })
    return kept
  }
  let sure = true
  const runs = await grokPersonCodeRuns(grokInspect(launch.executable, launch.env, launch.cwd), { servers: [] }, () => { sure = false })
  if (key && sure) {
    answers.set(key, runs)
    // A few folders' answers at once; the oldest goes first.
    for (const old of answers.keys()) if (answers.size > 64) answers.delete(old)
  }
  hostLog("grok", "person code asked of Grok", { ms: Math.round(performance.now() - began), runs, sure })
  return runs
}

/**
 * Whether the person's own code may run in a Grok session beside Mako's hook, so a write could go before a turn's
 * checkpoint holds the workspace, as Grok itself says (`grok inspect --json`): a folder it doesn't trust, where it
 * reports nothing of what would load once trusted; any hook, plugin, MCP server or LSP server it loads there. An MCP
 * server of the launch's that's the person's and runs as a process counts too, and so does an answer that fails or
 * that Mako can't read. A launch where this is true holds no writes; its message waits for the checkpoint
 * (`WriteHolds.attend`).
 */
export async function grokPersonCodeRuns(inspect: () => Promise<string>, launch: GrokLaunch, unsure?: () => void): Promise<boolean> {
  if (launch.servers.some((server) => server.process)) return true
  try {
    const said = Inspect.parse(JSON.parse(await inspect()))
    if (!said.projectTrusted) return true
    return said.hooks.length > 0 || said.plugins.length > 0 || said.mcpServers.length > 0 || said.lspServers.length > 0
  } catch {
    unsure?.()
    return true
  }
}
