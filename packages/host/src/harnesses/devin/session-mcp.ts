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
import { devinPersonCodeRuns } from "./person-code.js"
import { DEVIN_VOCABULARY, type NativeTool } from "@mako/sessions/harnesses"
import type { ToolKind } from "@mako/sessions/tool-identity"

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
  routesCalls = false,
  holdsWrites = false
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
      const config = { ...settings, ...subagentsOff && { subagents_enabled: false }, ...gate && { hooks: withDevinGate(settings.hooks, gate, holdsWrites) } }
      await publishFile(join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 })
    }
    env.XDG_CONFIG_HOME = root
    return () => rm(root, { recursive: true, force: true })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/**
 * Whether a launch of Devin holds its agent's writes: it routes calls, the conversation server whose address the hook
 * posts to is among its servers, and nothing the person set up runs beside the hook (`devinPersonCodeRuns`).
 */
export async function devinHoldsWrites(launch: { env: NodeJS.ProcessEnv; cwd: string; servers: readonly { name: string; process: boolean }[] }): Promise<boolean> {
  return launch.servers.some((server) => server.name === MAKO_THREAD_SERVER && !server.process) && !await devinPersonCodeRuns(launch)
}

/**
 * The kinds of Devin's tools that only read: a read, a search, a fetch, a command's output, a subagent's or the todo
 * list's state, a question, leaving plan mode, a listing of MCP tools. None changes a file, runs a command or starts
 * anything that could, so a turn's checkpoint has nothing of theirs to wait for.
 */
const DEVIN_READING_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["read", "list", "search", "find", "web-fetch", "web-search", "shell-output", "agent-wait", "todo", "plan-exit", "question", "tool-search"])

/**
 * Devin's tools that may change the workspace, by the names its hooks see: every tool of its vocabulary that isn't of
 * a reading kind, so one added there with any other kind is held without being listed here. Today the shell (`exec`),
 * input to and the end of a running command (`write_to_process`, `kill_shell`), the file tools (`write`, `edit`,
 * `notebook_edit`), `write_plan`, `skill`, `run_subagent`, `mcp_call_tool` and `request_scope`.
 */
export const DEVIN_WRITING_TOOLS: readonly string[] = Object.entries<NativeTool>(DEVIN_VOCABULARY.tools)
  .filter(([, tool]) => !DEVIN_READING_KINDS.has(tool.kind))
  .flatMap(([name, tool]) => [name, ...(tool.aliases ?? [])])

/**
 * What the hook before a tool matches on a launch that holds writes: Devin's writing tools and every MCP tool, which
 * its hooks see as `mcp__<server>__<tool>`. Its reads don't run the hook at all: registered for every tool, the
 * hook's `curl` added 14 ms to each call (measured 2026-11-18 against 3000.10.23, 20 reads a turn: 31.0 ms a call
 * against 17.0 ms). Proven against that build with a scripted model: a matcher is a regular expression on the tool's
 * name, the hook fires for `write`, `edit`, `exec`, `write_to_process`, `kill_shell`, `run_subagent`, a subagent's own
 * tools and an MCP tool, and Devin runs none of them before the hook's command exits. A tool a later Devin adds is
 * matched only once the vocabulary names it: `scripts/test-devin-session-mcp.ts` fails on a recorded tool list
 * (`scripts/fixtures/native-tools`) that has one this neither matches nor knows as reading.
 */
export const DEVIN_WRITE_MATCHER = `^(${DEVIN_WRITING_TOOLS.join("|")}|mcp__.*)$`

/** Whether Devin's tool `name` is one of a reading kind, which a launch's hook never runs for. */
export function devinToolReads(name: string): boolean {
  return Object.entries<NativeTool>(DEVIN_VOCABULARY.tools).some(([known, tool]) => (known === name || tool.aliases?.includes(name) === true) && DEVIN_READING_KINDS.has(tool.kind))
}

/** Devin's shell tool, the one its hooks are registered for where a launch holds no writes. */
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
 *
 * `holdsWrites`: the launch holds its writes (`devinHoldsWrites`), so the hook before a tool is registered for every
 * tool that may write (`DEVIN_WRITE_MATCHER`), and which of those calls wait is the gate's to say (`hookMayWrite`).
 */
function withDevinGate(hooks: z.infer<typeof DevinSettings>[string] | undefined, gate: { url: string; authorization: string }, holdsWrites: boolean) {
  const own = z.record(z.string(), z.array(z.json())).catch({}).parse(hooks ?? {})
  const hook = (event: "pre" | "post") => ({
    matcher: holdsWrites && event === "pre" ? DEVIN_WRITE_MATCHER : `^${DEVIN_SHELL}$`,
    hooks: [{ type: "command", command: `curl -s -m 8 -X POST --data-binary @- -H ${quote(`Authorization: ${gate.authorization}`)} ${quote(`${gate.url}/${event}`)}`, timeout: 10 }],
  })
  return { ...own, PreToolUse: [...own.PreToolUse ?? [], hook("pre")], PostToolUse: [...own.PostToolUse ?? [], hook("post")] }
}
