import { join, relative } from "node:path"
import { DEVIN_VOCABULARY } from "@mako/sessions/harnesses"
import type { AuthoringEntry } from "../../contracts/native-authoring.js"
import {
  foldersDown,
  gitRoot,
  hookDocument,
  hookFileEdit,
  jsonDocument,
  jsonMcpRemove,
  jsonMcpSwitch,
  parseHookEntryId,
  parseMcpEntryId,
  readHooks,
  readMcpServers,
  readOnly,
  WRITABLE,
  type AuthoringSourceSpec,
  type HookDialect,
  type ProviderAuthoringCapability,
  type ProviderMcpEditing,
  type ReadSource,
} from "../../tools/index.js"

/**
 * Devin's hooks and MCP servers, as 3000.10.23 reads them.
 *
 * Hooks are Claude Code's matcher groups, read from `.devin/hooks.v1.json`
 * (the whole file is the event map), the `hooks` key of `.devin/config.json`
 * and `.devin/config.local.json` in every folder from the working folder up
 * to the repository's root, and of `~/.config/devin/config.json`, beside the
 * hooks of Claude Code's settings, which Devin imports. All of them run;
 * there is no switch for one hook or for all, only
 * `read_config_from.claude: false` to stop the Claude import. Over ACP,
 * which Mako drives, Devin ran a project's hooks in a folder it hadn't been
 * asked to trust.
 *
 * Devin's slash commands are its skills; it reads no command folder.
 *
 * MCP servers: `mcpServers` in `~/.config/devin/mcp_config.json`,
 * `.devin/mcp_config.json` and `.devin/mcp_config.local.json`, the local file
 * winning a name; `"disabled": true` turns one off, as `devin mcp disable`
 * writes it.
 */

const EVENTS = "absent" in DEVIN_VOCABULARY.concepts.hooks ? [] : [...DEVIN_VOCABULARY.concepts.hooks.events]
const CLAUDE = readOnly("Claude Code's settings, which Devin imports. Edit them under Claude Code.")
const UNTRUSTED = "Devin ran this folder's hooks over ACP without asking to trust it."

const DEVIN_HOOKS: HookDialect = {
  layout: "grouped",
  root: ["hooks"],
  typeKey: "type",
  vocabulary: { events: EVENTS, handlers: [{ type: "command", run: "command" }, { type: "prompt", run: "prompt" }], matcher: true },
  scaffold: {},
  ownsFile: false,
}

/** The dialect of one source: the event map is the whole of `hooks.v1.json`, and the `hooks` key elsewhere. */
function dialect(source: ReadSource): HookDialect {
  const root = source.spec.within ?? ["hooks"]
  return { ...DEVIN_HOOKS, root, ownsFile: root.length === 0 }
}

export function createDevinHooks(): ProviderAuthoringCapability {
  return {
    provider: "devin",
    family: "hooks",
    form: "hook",
    names: "all",
    precedence: "Hooks from every file run: each project folder from the working folder up to the repository's root, the user config, and Claude Code's settings, which Devin imports.",
    reload: "Devin reads hooks when a conversation starts.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE,
      disable: readOnly("Devin has no switch for one hook; read_config_from.claude: false in its config stops it running Claude Code's."),
      trust: readOnly(UNTRUSTED),
    },
    hooks: DEVIN_HOOKS.vocabulary,
    async sources(context) {
      const root = await gitRoot(context.cwd) ?? context.cwd
      const folders = foldersDown(root, context.cwd).reverse()
      const trust = { state: "unasked", detail: UNTRUSTED } as const
      const project = folders.flatMap((folder, index): AuthoringSourceSpec[] => {
        const where = relative(root, folder) || "the project's root"
        const base = index * 5
        return [
          { id: `project:${join(folder, ".devin", "hooks.v1.json")}`, scope: "project", path: join(folder, ".devin", "hooks.v1.json"), root: folder, label: `hooks.v1.json in ${where}`, rank: base, format: "json", within: [], writable: WRITABLE, trust },
          { id: `project:${join(folder, ".devin", "config.json")}`, scope: "project", path: join(folder, ".devin", "config.json"), root: folder, label: `Project config.json in ${where}`, rank: base + 1, format: "json", within: ["hooks"], writable: WRITABLE, trust },
          { id: `local:${join(folder, ".devin", "config.local.json")}`, scope: "local", path: join(folder, ".devin", "config.local.json"), root: folder, label: `Local config.local.json in ${where}`, rank: base + 2, format: "json", within: ["hooks"], writable: WRITABLE, trust },
          { id: `imported:${join(folder, ".claude", "settings.json")}`, scope: "imported", path: join(folder, ".claude", "settings.json"), root: folder, label: `Claude Code project settings in ${where}`, rank: base + 3, format: "json", within: ["hooks"], writable: CLAUDE },
          { id: `imported:${join(folder, ".claude", "settings.local.json")}`, scope: "imported", path: join(folder, ".claude", "settings.local.json"), root: folder, label: `Claude Code local settings in ${where}`, rank: base + 4, format: "json", within: ["hooks"], writable: CLAUDE },
        ]
      })
      const user = join(context.home, ".config", "devin", "config.json")
      const next = project.length
      return [
        ...project,
        { id: `user:${user}`, scope: "user", path: user, root: join(context.home, ".config", "devin"), label: "User config.json", rank: next, format: "json", within: ["hooks"], writable: WRITABLE },
        { id: `imported:${join(context.home, ".claude", "settings.json")}`, scope: "imported", path: join(context.home, ".claude", "settings.json"), root: context.home, label: "Claude Code user settings", rank: next + 1, format: "json", within: ["hooks"], writable: CLAUDE },
        { id: `imported:${join(context.home, ".claude", "settings.local.json")}`, scope: "imported", path: join(context.home, ".claude", "settings.local.json"), root: context.home, label: "Claude Code user local settings", rank: next + 2, format: "json", within: ["hooks"], writable: CLAUDE },
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const entries = sources.flatMap((source): AuthoringEntry[] => {
        try { return readHooks(dialect(source), source, hookDocument(source), () => true) }
        catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      const sourceId = change.kind === "create" ? change.sourceId : parseHookEntryId(change.entryId).sourceId
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Devin reads here. Reload and try again.")
      return hookFileEdit(dialect(source), source, change)
    },
  }
}

export function createDevinMcpEditing(): ProviderMcpEditing {
  const switchKey = { key: "disabled", off: true }
  return {
    provider: "devin",
    family: "mcp",
    form: "mcp",
    names: "last",
    imports: true,
    precedence: "A server in .devin/mcp_config.local.json wins over one in .devin/mcp_config.json, which wins over the user's of the same name; the winner replaces the others whole.",
    reload: "Devin starts MCP servers when a conversation starts.",
    operations: {
      create: readOnly("Copy a server in from another agent in the MCP servers section."),
      edit: readOnly("Change a server's command by copying it in again from another agent, or in your editor."),
      disable: WRITABLE, remove: WRITABLE,
      trust: readOnly("Devin starts a project's servers without asking you to approve them."),
    },
    async sources(context) {
      const user = join(context.home, ".config", "devin", "mcp_config.json")
      return [
        { id: `user:${user}`, scope: "user", path: user, root: join(context.home, ".config", "devin"), label: "User mcp_config.json", rank: 0, format: "json", writable: WRITABLE },
        { id: `project:${join(context.cwd, ".devin", "mcp_config.json")}`, scope: "project", path: join(context.cwd, ".devin", "mcp_config.json"), root: context.cwd, label: "Project mcp_config.json", rank: 1, format: "json", writable: WRITABLE },
        { id: `local:${join(context.cwd, ".devin", "mcp_config.local.json")}`, scope: "local", path: join(context.cwd, ".devin", "mcp_config.local.json"), root: context.cwd, label: "Local mcp_config.local.json", rank: 2, format: "json", writable: WRITABLE },
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const entries = sources.flatMap((source) => {
        try { return readMcpServers(source, jsonDocument(source), ["mcpServers"], switchKey, new Set()) }
        catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      if (change.kind !== "enable" && change.kind !== "remove") throw new Error("Devin's servers can be turned off and on, or removed, here.")
      const { sourceId, name } = parseMcpEntryId(change.entryId)
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Devin reads here. Reload and try again.")
      return change.kind === "remove" ? jsonMcpRemove(source, ["mcpServers"], name) : jsonMcpSwitch(source, ["mcpServers"], name, switchKey, change.enabled)
    },
  }
}
