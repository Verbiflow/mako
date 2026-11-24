import { homedir } from "node:os"
import { join } from "node:path"
import { resolveExecutable } from "../../base/executable.js"
import { jsonDocument, jsonMcpRemove, jsonMcpSwitch, parseMcpEntryId, readMcpServers, readOnly, WRITABLE,
  type ProviderMcpEditing, type ProviderMcpSource } from "../../tools/index.js"

const config = (home: string) => join(home, "config", "mcp_config.json")
const disabled = { key: "disabled", off: true }

export const antigravityMcp: ProviderMcpSource = {
  provider: "antigravity", readFormat: "named-map", command: (env) => resolveExecutable("agy", env),
  userFiles: () => [config(process.env.GEMINI_HOME || join(homedir(), ".gemini"))],
  workspaceFiles: () => [], cliList: null,
  write: { kind: "cli", scopes: "user", args(server, _scope, environment) {
    const variables = Object.entries(environment).flatMap(([name, value]) => ["--env", name + "=" + value])
    if (server.transport === "stdio") return ["mcp", "add", ...variables, server.name, server.command!, ...server.args ?? []]
    if (server.transport !== "http") throw new Error("Antigravity imports HTTP and stdio servers.")
    return ["mcp", "add", "--type", "http", server.name, server.url!]
  } },
}

export const antigravityMcpEditing: ProviderMcpEditing = {
  provider: "antigravity", family: "mcp", form: "mcp", names: "last", imports: true,
  precedence: "Antigravity reads the user's MCP configuration.", reload: "New sessions load the saved servers.",
  operations: { create: readOnly("Use agy mcp add or import a server."), edit: readOnly("Use agy mcp add to update a server."),
    disable: WRITABLE, remove: WRITABLE, trust: readOnly("This file belongs to the user.") },
  async sources({ home }) {
    const root = process.env.GEMINI_HOME || join(home, ".gemini")
    const path = config(root)
    return [{ id: `user:${path}`, scope: "user", path, root, label: "User mcp_config.json", rank: 0, format: "json", writable: WRITABLE }]
  },
  read(sources) {
    return { entries: sources.flatMap(source => readMcpServers(source, jsonDocument(source), ["mcpServers"], disabled, new Set())), off: [], problems: [] }
  },
  change(sources, change) {
    if (change.kind !== "enable" && change.kind !== "remove") throw new Error("Choose a server to enable, disable or remove.")
    const { sourceId, name } = parseMcpEntryId(change.entryId)
    const source = sources.find(entry => entry.spec.id === sourceId)
    if (!source) throw new Error("Reload the MCP configuration and try again.")
    return change.kind === "remove" ? jsonMcpRemove(source, ["mcpServers"], name) : jsonMcpSwitch(source, ["mcpServers"], name, disabled, change.enabled)
  },
}
