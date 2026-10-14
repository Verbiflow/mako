import { basename, join, relative, sep } from "node:path"
import { grokHome } from "@mako/sessions"
import { GROK_VOCABULARY } from "@mako/sessions/harnesses"
import { z } from "zod"
import type { AuthoringEntry, AuthoringTrust } from "../../contracts/native-authoring.js"
import type { JsonObject, JsonValue } from "../../contracts/json.js"
import {
  commandFolderEdit,
  commandSource,
  foldersDown,
  gitRoot,
  hookDocument,
  hookFileEdit,
  jsonDocument,
  listFiles,
  parseHookEntryId,
  parseMcpEntryId,
  parseTomlText,
  readCommandFolder,
  readHooks,
  readMcpServers,
  readOnly,
  setTomlKey,
  tomlDocument,
  tomlMcpRemove,
  tomlString,
  tomlTables,
  verifyToml,
  WRITABLE,
  type AuthoringContext,
  type AuthoringEdit,
  type AuthoringSourceSpec,
  type HookAddress,
  type HookDialect,
  type ProviderAuthoringCapability,
  type ProviderMcpEditing,
  type ReadSource,
} from "../../tools/index.js"
import { grokTrustsProject } from "./permission-policy.js"

/**
 * Grok's hooks, commands and MCP servers, as 1.0.46 reads them, verified
 * against a scratch home with `_x.ai/hooks/list` and `grok inspect --json`.
 *
 * Hooks are Claude Code's matcher groups, one file each in `~/.grok/hooks/`
 * and in the project's `.grok/hooks/`, plus `[[hooks.<Event>]]` in
 * `~/.grok/config.toml` and the hooks of Claude Code's and Cursor's files,
 * which Grok imports; all of them run. A project's own hooks load only in a
 * Git repository Grok trusts (`[folders."<real path>"] trusted = true` in
 * `~/.grok/trusted_folders.toml`, written when the person answers Grok's
 * trust prompt). One hook is turned off by its name on a line of
 * `~/.grok/disabled-hooks`: `global/<file>:<event>[group].hooks[handler]`
 * for the user's, `project/<file>:…` for a project's, which every project
 * with a file of that name shares.
 *
 * Commands are Markdown files directly in a `commands/` folder (subfolders
 * aren't read): the project's `.grok`, `.agents`, `.claude` and `.cursor`
 * folders from the working folder up, then the user's. The first one of a
 * name wins, and a project's are read only once it's trusted.
 *
 * MCP servers are `[mcp_servers.<name>]` in a trusted project's
 * `.grok/config.toml` (nearest first), then `~/.grok/config.toml`, then the
 * servers of `~/.claude.json`, Cursor's `mcp.json` and `.mcp.json`; the first
 * of a name replaces the rest. Any of them is turned off by name in
 * `disabled_mcp_servers` at the top of `~/.grok/config.toml`, and a user
 * server also gets `enabled = false` (`true` when turned back on), as
 * `grok mcp disable` and `enable` write them.
 */

const EVENTS = "absent" in GROK_VOCABULARY.concepts.hooks ? [] : [...GROK_VOCABULARY.concepts.hooks.events]
const IMPORTED = (owner: string) => readOnly(`${owner}'s file, which Grok also reads. Edit it under ${owner}.`)

export const GROK_HOOKS: HookDialect = {
  layout: "grouped",
  root: ["hooks"],
  typeKey: "type",
  vocabulary: { events: EVENTS, handlers: [{ type: "command", run: "command" }, { type: "http", run: "url" }], matcher: true },
  scaffold: {},
  ownsFile: true,
}

const home = (context: AuthoringContext) => grokHome(context.env, context.home)
const TABLE = "mcp_servers"
const snake = (event: string) => event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()

/** Whether Grok reads the project's own files here, and why not when it doesn't. */
async function projectTrust(context: AuthoringContext): Promise<{ root: string | null; trust: AuthoringTrust }> {
  const root = await gitRoot(context.cwd)
  if (!root) return { root, trust: { state: "untrusted", detail: "Grok reads a project's own hooks, commands and servers only inside a Git repository." } }
  return grokTrustsProject({ cwd: context.cwd, home: context.home, grokHome: home(context) })
    ? { root, trust: { state: "trusted", detail: "Grok trusts this project." } }
    : { root, trust: { state: "untrusted", detail: "Grok skips this project's own hooks, commands and servers until you trust the folder when Grok asks." } }
}

/** One source per hook file in a folder, or the file a first hook would go in. */
async function hookFiles(folder: string, scope: "user" | "project", root: string, rank: number, trust?: AuthoringTrust): Promise<AuthoringSourceSpec[]> {
  const names = await listFiles(folder, [".json"]).catch(() => [])
  const files = names.length ? names : ["hooks.json"]
  return files.map((name, index) => {
    const spec: AuthoringSourceSpec = { id: `${scope}:${join(folder, name)}`, scope, path: join(folder, name), root, label: `${scope === "user" ? "User" : "Project"} hooks/${name}`, rank: rank + index, format: "json", writable: WRITABLE }
    if (trust) spec.trust = trust
    return spec
  })
}

/** The name Grok gives a hook in `disabled-hooks`. */
export function grokHookName(source: ReadSource, address: HookAddress): string {
  const index = `${snake(address.event)}[${address.group}].hooks[${address.handler}]`
  if (source.spec.format === "toml") return `user:${index}`
  const project = source.spec.scope === "project" || source.spec.id.startsWith("imported:project:")
  return `${project ? "project" : "global"}/${basename(source.spec.path).replace(/\.json$/, "")}:${index}`
}

const disabledHooks = (sources: readonly ReadSource[]) => sources.find((source) => source.spec.format === "text")

const Compat = z.object({ compat: z.record(z.string(), z.object({ hooks: z.boolean().optional(), mcps: z.boolean().optional() }).passthrough()) }).partial().passthrough()

/**
 * The imported sources `[compat.<agent>] hooks` or `mcps = false` in the
 * user config turns off: Claude Code's files, Cursor's, or both.
 */
function importsOff(sources: readonly ReadSource[], key: "hooks" | "mcps"): { sourceId: string; key: string; detail: string }[] {
  const config = sources.find((source) => source.spec.scope === "user" && source.spec.format === "toml")
  let compat: z.infer<typeof Compat>["compat"] = {}
  try { compat = Compat.parse(config?.text ? parseTomlText(config.text, config.spec.path) : {}).compat ?? {} } catch { compat = {} }
  return sources.flatMap((source) => {
    if (source.spec.scope !== "imported") return []
    const agent = source.spec.path.includes(`${sep}.cursor${sep}`) ? "cursor" : source.spec.path.includes(".claude") || source.spec.path.endsWith(".mcp.json") ? "claude" : null
    if (!agent || compat[agent]?.[key] !== false) return []
    return [{ sourceId: source.spec.id, key: `compat.${agent}.${key}`, detail: `Grok doesn't read these while [compat.${agent}] ${key} = false is in ~/.grok/config.toml.` }]
  })
}

export function createGrokHooks(): ProviderAuthoringCapability {
  return {
    provider: "grok",
    family: "hooks",
    form: "hook",
    names: "all",
    precedence: "Hooks from every file run, Grok's own and the Claude Code and Cursor files it imports; one of the same command in two files runs once. A project's own hooks load only in a Git repository Grok trusts.",
    reload: "Grok reads hooks when a conversation starts; a project trusted mid-conversation adds its hooks from the next one.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE, disable: WRITABLE,
      trust: readOnly("Grok trusts a whole folder, when you answer its trust prompt; there's no trust for one hook."),
    },
    hooks: GROK_HOOKS.vocabulary,
    async sources(context) {
      const dir = home(context)
      const { root, trust } = await projectTrust(context)
      const project = root ?? context.cwd
      const user = await hookFiles(join(dir, "hooks"), "user", dir, 0)
      const own = await hookFiles(join(project, ".grok", "hooks"), "project", project, 20, trust)
      const imported = (id: string, path: string, label: string, owner: string, rank: number, fileRoot: string, gate?: AuthoringTrust): AuthoringSourceSpec => {
        const spec: AuthoringSourceSpec = { id: `imported:${id}:${path}`, scope: "imported", path, root: fileRoot, label, rank, format: "json", writable: IMPORTED(owner) }
        if (gate) spec.trust = gate
        return spec
      }
      return [
        ...user,
        { id: `user:${join(dir, "config.toml")}`, scope: "user", path: join(dir, "config.toml"), root: dir, label: "User config.toml", rank: 10, format: "toml", writable: readOnly("Mako writes Grok hooks to files in ~/.grok/hooks. Edit [[hooks]] in config.toml in your editor.") },
        imported("user", join(context.home, ".claude", "settings.json"), "Claude Code user settings", "Claude Code", 11, context.home),
        imported("user", join(context.home, ".claude", "settings.local.json"), "Claude Code user local settings", "Claude Code", 12, context.home),
        imported("user", join(context.home, ".cursor", "hooks.json"), "Cursor user hooks.json", "Cursor", 13, context.home),
        ...own,
        imported("project", join(project, ".claude", "settings.json"), "Claude Code project settings", "Claude Code", 40, project, trust),
        imported("project", join(project, ".claude", "settings.local.json"), "Claude Code local settings", "Claude Code", 41, project, trust),
        imported("project", join(project, ".cursor", "hooks.json"), "Cursor project hooks.json", "Cursor", 42, project, trust),
        { id: `user:${join(dir, "disabled-hooks")}`, scope: "user", path: join(dir, "disabled-hooks"), root: dir, label: "Hooks turned off (~/.grok/disabled-hooks)", rank: 50, format: "text", writable: WRITABLE, switches: true },
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const off = new Set((disabledHooks(sources)?.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean))
      const imports = importsOff(sources, "hooks")
      const entries = sources.filter((source) => source.spec.format !== "text").flatMap((source): AuthoringEntry[] => {
        let value: JsonValue
        try { value = hookDocument(source) } catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
        const ignored = imports.some((entry) => entry.sourceId === source.spec.id)
        return readHooks(GROK_HOOKS, source, value, (address) => !ignored && !off.has(grokHookName(source, address)))
      })
      return { entries, off: imports, problems }
    },
    change(sources, change) {
      const sourceId = change.kind === "create" ? change.sourceId : parseHookEntryId(change.entryId).sourceId
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Grok reads here. Reload and try again.")
      if (change.kind !== "enable") return hookFileEdit(GROK_HOOKS, source, change)
      const list = disabledHooks(sources)
      if (!list) throw new Error("Grok keeps hook switches in ~/.grok/disabled-hooks, which Mako couldn't place.")
      const name = grokHookName(source, parseHookEntryId(change.entryId))
      const lines = (list.text ?? "").split("\n").filter((line) => line.trim() && line.trim() !== name)
      if (!change.enabled) lines.push(name)
      const after = lines.length ? `${lines.join("\n")}\n` : null
      return { path: list.spec.path, root: list.spec.root, scope: "user", format: "text", before: list.text, after: after === null && list.text === null ? null : after, summary: `${change.enabled ? "Turn on" : "Turn off"} ${name} in ~/.grok/disabled-hooks` }
    },
  }
}

export function createGrokCommands(): ProviderAuthoringCapability {
  const folder = { separator: "/" } as const
  return {
    provider: "grok",
    family: "commands",
    form: "command",
    names: "first",
    precedence: "The first command of a name wins: the project's .grok, .agents, .claude and .cursor folders from the working folder up, then the user's. Subfolders aren't read.",
    reload: "Grok reads commands when a conversation starts.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE,
      disable: readOnly("Grok reads a command file while it exists; there's no switch for one."),
      trust: readOnly("Grok trusts a whole folder, when you answer its trust prompt."),
    },
    async sources(context) {
      const dir = home(context)
      const { root, trust } = await projectTrust(context)
      const folders = foldersDown(root ?? context.cwd, context.cwd).reverse()
      const owners = [[".grok", "Grok"], [".agents", "every agent that reads .agents"], [".claude", "Claude Code"], [".cursor", "Cursor"]] as const
      const project = folders.flatMap((base, depth) => owners.map(([name, owner], index): AuthoringSourceSpec => ({
        id: `project:${join(base, name, "commands")}`, scope: name === ".grok" ? "project" : "imported", path: join(base, name, "commands"), root: base,
        label: `${name}/commands in ${relative(root ?? context.cwd, base) || "the project's root"}`, rank: depth * owners.length + index,
        format: "folder", entries: { endings: [".md"], depth: 0 }, trust,
        writable: name === ".grok" && depth === folders.length - 1 ? WRITABLE : name === ".grok" ? readOnly("Mako writes project commands at the project's root.") : IMPORTED(owner),
      })))
      const user = owners.map(([name, owner], index): AuthoringSourceSpec => {
        const path = name === ".grok" ? join(dir, "commands") : join(context.home, name, "commands")
        return {
          id: `user:${path}`, scope: name === ".grok" ? "user" : "imported", path, root: name === ".grok" ? dir : context.home, label: `~/${name}/commands`,
          rank: 100 + index, format: "folder", entries: { endings: [".md"], depth: 0 }, writable: name === ".grok" ? WRITABLE : IMPORTED(owner),
        }
      })
      return [...project, ...user]
    },
    read: (sources) => ({ entries: sources.flatMap((source) => readCommandFolder(folder, source)), off: [], problems: [] }),
    change: (sources, change) => commandFolderEdit(folder, commandSource(sources, change), change),
  }
}

const ObjectSchema = z.record(z.string(), z.json())
const asObject = (value: JsonValue | undefined): JsonObject | null => { const parsed = ObjectSchema.safeParse(value); return parsed.success ? parsed.data : null }
const Names = z.array(z.string())

export function createGrokMcpEditing(): ProviderMcpEditing {
  const userConfig = (sources: readonly ReadSource[]) => sources.find((source) => source.spec.scope === "user")
  return {
    provider: "grok",
    family: "mcp",
    form: "mcp",
    names: "first",
    imports: true,
    precedence: "The first server of a name replaces the rest: a trusted project's .grok/config.toml, nearest first, then ~/.grok/config.toml, then ~/.claude.json, Cursor's mcp.json and .mcp.json.",
    reload: "Grok starts MCP servers when a conversation starts.",
    operations: {
      create: readOnly("Copy a server in from another agent in the MCP servers section."),
      edit: readOnly("Change a server's command by copying it in again from another agent, or in your editor."),
      disable: WRITABLE, remove: WRITABLE,
      trust: readOnly("Grok trusts a whole folder, when you answer its trust prompt."),
    },
    async sources(context) {
      const dir = home(context)
      const { root, trust } = await projectTrust(context)
      const folders = foldersDown(root ?? context.cwd, context.cwd).reverse()
      return [
        ...folders.map((base, index): AuthoringSourceSpec => ({
          id: `project:${join(base, ".grok", "config.toml")}`, scope: "project", path: join(base, ".grok", "config.toml"), root: base,
          label: `Project config.toml in ${relative(root ?? context.cwd, base) || "the project's root"}`, rank: index, format: "toml", writable: WRITABLE, trust,
        })),
        { id: `user:${join(dir, "config.toml")}`, scope: "user", path: join(dir, "config.toml"), root: dir, label: "User config.toml", rank: 20, format: "toml", writable: WRITABLE },
        { id: `imported:${join(context.home, ".claude.json")}`, scope: "imported", path: join(context.home, ".claude.json"), root: context.home, label: "Claude Code's ~/.claude.json", rank: 21, format: "json", within: ["mcpServers"], writable: IMPORTED("Claude Code") },
        { id: `imported:${join(context.home, ".cursor", "mcp.json")}`, scope: "imported", path: join(context.home, ".cursor", "mcp.json"), root: context.home, label: "Cursor's user mcp.json", rank: 22, format: "json", within: ["mcpServers"], writable: IMPORTED("Cursor") },
        { id: `imported:${join(context.cwd, ".cursor", "mcp.json")}`, scope: "imported", path: join(context.cwd, ".cursor", "mcp.json"), root: context.cwd, label: "Cursor's project mcp.json", rank: 23, format: "json", within: ["mcpServers"], writable: IMPORTED("Cursor"), trust },
        { id: `imported:${join(context.cwd, ".mcp.json")}`, scope: "imported", path: join(context.cwd, ".mcp.json"), root: context.cwd, label: "The project's .mcp.json", rank: 24, format: "json", within: ["mcpServers"], writable: IMPORTED("Claude Code"), trust },
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const config = userConfig(sources)
      let off = new Set<string>()
      try { off = new Set(Names.safeParse(asObject(config ? tomlDocument(config) : {})?.disabled_mcp_servers).data ?? []) }
      catch (error) { if (config) problems.push({ sourceId: config.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }) }
      const imports = importsOff(sources, "mcps")
      const entries = sources.flatMap((source) => {
        try {
          if (source.spec.format === "toml") return readMcpServers(source, tomlDocument(source), [TABLE], { key: "enabled", off: false }, off)
          const servers = readMcpServers(source, jsonDocument(source), source.spec.within ?? ["mcpServers"], null, off)
          return imports.some((entry) => entry.sourceId === source.spec.id) ? servers.map((server) => ({ ...server, enabled: false })) : servers
        } catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
      })
      return { entries, off: imports, problems }
    },
    change(sources, change) {
      if (change.kind !== "enable" && change.kind !== "remove") throw new Error("Grok's servers can be turned off and on, or removed, here.")
      const { sourceId, name } = parseMcpEntryId(change.entryId)
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Grok reads here. Reload and try again.")
      if (change.kind === "remove") {
        if (source.spec.format !== "toml") throw new Error(source.spec.writable.supported ? "Remove it where it's declared." : source.spec.writable.reason)
        return tomlMcpRemove(source, TABLE, name)
      }
      const config = userConfig(sources)
      if (!config) throw new Error("Grok keeps its switches in ~/.grok/config.toml, which Mako couldn't place.")
      return grokSwitch(config, name, change.enabled, source === config)
    },
  }
}

/** `disabled_mcp_servers` at the top of the user config, and `enabled` on the server itself when it's the user's, as `grok mcp disable` and `enable` write them. */
function grokSwitch(config: ReadSource, name: string, enabled: boolean, own: boolean): AuthoringEdit {
  if (config.problem) throw new Error(config.problem)
  const before = config.text ?? ""
  const current = Names.safeParse(asObject(parseTomlText(before, config.spec.path))?.disabled_mcp_servers).data ?? []
  const names = enabled ? current.filter((entry) => entry !== name) : current.includes(name) ? current : [...current, name]
  let after = setTomlKey(before, [], "disabled_mcp_servers", names.length ? `[${names.map(tomlString).join(", ")}]` : null)
  if (own && tomlTables(after, [TABLE, name]).own) after = setTomlKey(after, [TABLE, name], "enabled", enabled ? "true" : "false")
  const verified = verifyToml(config, after, (document) => {
    if (names.length) document.disabled_mcp_servers = names
    else delete document.disabled_mcp_servers
    const servers = asObject(document[TABLE])
    const server = own ? asObject(servers?.[name]) : null
    if (!servers || !server) return
    server.enabled = enabled
    document[TABLE] = { ...servers, [name]: server }
  })
  return { path: config.spec.path, root: config.spec.root, scope: "user", format: "toml", before: config.text, after: verified, summary: `${enabled ? "Turn on" : "Turn off"} ${name} in ~/.grok/config.toml` }
}

