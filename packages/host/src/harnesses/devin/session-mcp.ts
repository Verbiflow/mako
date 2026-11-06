import { z } from "zod"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { publishFile } from "../../base/published-files.js"
import type { McpServer } from "@agentclientprotocol/sdk"
import { removeRetiredMakoMcp } from "../../tools/index.js"
import { MAKO_THREAD_SERVER } from "../../contracts/mcp-reach.js"

const DevinSettings = z.record(z.string(), z.json())

/** A file of the person's Devin config, `{}` when they have none. */
const nativeFile = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return "{}"
  throw error
})

/**
 * Devin's ACP tool router currently reads file configuration, not session MCP
 * additions, so each launch gets a config folder of its own: the person's
 * files linked, with `mcp_config.json` written as theirs plus Mako's servers.
 * With `subagentsOff`, `config.json` is written too, as theirs with
 * `subagents_enabled: false`: Devin reads one user config, so a file of
 * Mako's own in its place (`--config`) would drop the person's settings.
 */
export async function prepareDevinMcp(
  servers: readonly McpServer[],
  env: NodeJS.ProcessEnv,
  subagentsOff = false,
  routesCalls = false
) {
  const gate = routesCalls ? devinCallGate(servers) : undefined
  const ownConfig = subagentsOff || gate !== undefined
  const root = await mkdtemp(join(tmpdir(), "mako-devin-mcp-"))
  const source = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  try {
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name !== "devin")
        await symlink(join(source, entry.name), join(root, entry.name))
    }
    const directory = join(root, "devin")
    await mkdir(directory, { mode: 0o700 })
    const nativeEntries = await readdir(join(source, "devin"), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const written = new Set(["mcp_config.json", ...ownConfig ? ["config.json"] : []])
    for (const entry of nativeEntries) {
      if (!written.has(entry.name))
        await symlink(
          join(source, "devin", entry.name),
          join(directory, entry.name)
        )
    }
    const nativeText = await nativeFile(join(source, "devin", "mcp_config.json"))
    const config = z
      .object({ mcpServers: z.record(z.string(), z.json()).default({}) })
      .catchall(z.json())
      .parse(JSON.parse(nativeText))
    removeRetiredMakoMcp(config.mcpServers)
    for (const server of servers) {
      if ("command" in server) {
        config.mcpServers[server.name] = {
          command: server.command,
          args: server.args,
          env: Object.fromEntries(
            server.env.map(({ name, value }) => [name, value])
          ),
        }
      } else if (server.type === "http" || server.type === "sse") {
        config.mcpServers[server.name] = {
          url: server.url,
          headers: Object.fromEntries(
            server.headers.map(({ name, value }) => [name, value])
          ),
        }
      } else {
        throw new Error("Devin does not support ACP-routed MCP servers")
      }
    }
    await publishFile(join(directory, "mcp_config.json"), JSON.stringify(config), { mode: 0o600 })
    if (ownConfig) {
      const settings = DevinSettings.parse(JSON.parse(await nativeFile(join(source, "devin", "config.json"))))
      const config = { ...settings, ...subagentsOff && { subagents_enabled: false }, ...gate && { hooks: withDevinGate(settings.hooks, gate) } }
      await publishFile(join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 })
    }
    env.XDG_CONFIG_HOME = root
    return () => rm(root, { recursive: true, force: true })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** Devin's shell tool, the one its hooks are registered for. */
const DEVIN_SHELL = "exec"

/**
 * Mako's gate for Devin's tool calls: the `mako` server's own address and
 * grant, at the path the conversation server answers hooks on (`/calls`).
 * Absent when the launch has no `mako` server.
 */
function devinCallGate(servers: readonly McpServer[]): { url: string; authorization: string } | undefined {
  for (const server of servers) {
    if (!("type" in server) || server.type !== "http" || server.name !== MAKO_THREAD_SERVER) continue
    const authorization = server.headers.find(({ name }) => name.toLowerCase() === "authorization")?.value
    const url = new URL(server.url)
    url.pathname = url.pathname.replace(/\/mako$/, "/calls")
    url.search = ""
    if (authorization) return { url: url.toString(), authorization }
  }
  return undefined
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/**
 * The person's hooks with Mako's appended, as 3000.10.23 reads them (proven
 * against a scripted model, 2026-11-03): a PreToolUse command hook gets the
 * call on stdin and its `{decision: "block", reason}` is what the model reads
 * (`Tool rejected: …`) with the command not run; a pre-tool note is dropped,
 * so a warn is PostToolUse's `additionalContext`, the model's next message.
 * A gate that can't be reached prints nothing, and the call goes on.
 */
function withDevinGate(hooks: z.infer<typeof DevinSettings>[string] | undefined, gate: { url: string; authorization: string }) {
  const own = z.record(z.string(), z.array(z.json())).catch({}).parse(hooks ?? {})
  const hook = (event: "pre" | "post") => ({
    matcher: `^${DEVIN_SHELL}$`,
    hooks: [{ type: "command", command: `curl -s -m 8 -X POST --data-binary @- -H ${quote(`Authorization: ${gate.authorization}`)} ${quote(`${gate.url}/${event}`)}`, timeout: 10 }],
  })
  return { ...own, PreToolUse: [...own.PreToolUse ?? [], hook("pre")], PostToolUse: [...own.PostToolUse ?? [], hook("post")] }
}
