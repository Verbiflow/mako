import { z } from "zod"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@agentclientprotocol/sdk"
import { removeRetiredMakoMcp } from "../../tools/index.js"

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
  subagentsOff = false
) {
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
    const written = new Set(["mcp_config.json", ...subagentsOff ? ["config.json"] : []])
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
    await writeFile(
      join(directory, "mcp_config.json"),
      JSON.stringify(config),
      { mode: 0o600 }
    )
    if (subagentsOff) {
      const settings = DevinSettings.parse(JSON.parse(await nativeFile(join(source, "devin", "config.json"))))
      await writeFile(join(directory, "config.json"), JSON.stringify({ ...settings, subagents_enabled: false }), { mode: 0o600 })
    }
    env.XDG_CONFIG_HOME = root
    return () => rm(root, { recursive: true, force: true })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
