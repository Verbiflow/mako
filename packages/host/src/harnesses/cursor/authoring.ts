import { join } from "node:path"
import { CURSOR_VOCABULARY } from "@mako/sessions/harnesses"
import type { AuthoringEntry } from "../../contracts/native-authoring.js"
import { hostPlatform } from "../../base/platform.js"
import {
  gitRoot,
  hookDocument,
  hookFileEdit,
  jsonDocument,
  jsonMcpRemove,
  nameListSwitch,
  namesAt,
  parseHookEntryId,
  parseMcpEntryId,
  readHooks,
  readMcpServers,
  readOnly,
  realOr,
  WRITABLE,
  type AuthoringContext,
  type AuthoringSourceSpec,
  type HookDialect,
  type ProviderAuthoringCapability,
  type ProviderMcpEditing,
} from "../../tools/index.js"

/**
 * Cursor's hooks and MCP servers, as SDK 1.0.31 reads them with the
 * `settingSources: ["project", "user"]` Mako's child passes.
 *
 * Hooks: `{ version, hooks: { <event>: [handler] } }` in `~/.cursor/hooks.json`
 * and `.cursor/hooks.json`, each handler with its own `matcher`, plus the
 * MDM file, plus the hooks in Claude Code's settings files, which the SDK
 * converts and runs too. An unknown event makes Cursor drop the whole file.
 * There is no switch for one hook and no trust prompt.
 *
 * The SDK loads no command folder: Cursor moved commands into skills.
 *
 * MCP servers: `mcpServers` in `~/.cursor/mcp.json` and `.cursor/mcp.json`,
 * the project's winning a name. A `disabled` key is ignored; a server is
 * turned off by name in `~/.cursor/projects/<project>/mcp-disabled.json`,
 * the list Cursor's own toggle and `cursor-agent` keep.
 */

const EVENTS = "absent" in CURSOR_VOCABULARY.concepts.hooks ? [] : [...CURSOR_VOCABULARY.concepts.hooks.events]
const CLAUDE = readOnly("Claude Code's settings, which Cursor also runs hooks from. Edit them under Claude Code.")

export const CURSOR_HOOKS: HookDialect = {
  layout: "flat",
  root: ["hooks"],
  typeKey: "type",
  vocabulary: { events: EVENTS, handlers: [{ type: "command", run: "command" }, { type: "prompt", run: "prompt" }], matcher: true },
  scaffold: { version: 1 },
  ownsFile: true,
}

/** Claude Code's settings files as Cursor converts them: matcher groups under `hooks`. */
const CLAUDE_SETTINGS: HookDialect = {
  layout: "grouped",
  root: ["hooks"],
  typeKey: "type",
  vocabulary: { events: [], handlers: [{ type: "command", run: "command" }, { type: "http", run: "url" }, { type: "prompt", run: "prompt" }, { type: "agent", run: "prompt" }], matcher: true },
  scaffold: {},
  ownsFile: false,
}

const MDM = { darwin: "/Library/Application Support/Cursor/hooks.json", linux: "/etc/cursor/hooks.json", win32: "C:\\ProgramData\\Cursor\\hooks.json" } as const

/** Cursor's own folder: `CURSOR_DATA_DIR`, or `~/.cursor`. */
const cursorDir = (context: AuthoringContext) => context.env.CURSOR_DATA_DIR?.trim() || join(context.home, ".cursor")

/**
 * The folder the SDK reads a project's `.cursor/hooks.json`, `.cursor/mcp.json`
 * and `.claude/settings*.json` from, and keys `~/.cursor/projects/<slug>` by:
 * the repository's top level as `git rev-parse --show-toplevel` gives it (a
 * real path), or the working folder outside a repository. Seen live with SDK
 * 1.0.31: a session opened in a subfolder ran the top level's hooks and servers.
 */
async function cursorProjectRoot(cwd: string): Promise<string> {
  const root = await gitRoot(cwd)
  return root ? realOr(root) : cwd
}

/** The folder Cursor keeps a project's state in: its path with every run of other characters made one dash. */
export function cursorProjectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
}

export function createCursorHooks(): ProviderAuthoringCapability {
  return {
    provider: "cursor",
    family: "hooks",
    form: "hook",
    names: "all",
    precedence: "Hooks from every file run: MDM, user, project, and Claude Code's settings, which Cursor converts. Where hooks answer differently, deny wins over ask, and ask over allow.",
    reload: "Cursor reads hooks when a conversation starts.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE,
      disable: readOnly("Cursor has no switch for one hook; a hook runs while it's in hooks.json."),
      trust: readOnly("Cursor runs a project's hooks without asking you to trust the folder."),
    },
    hooks: CURSOR_HOOKS.vocabulary,
    async sources(context) {
      const platform = hostPlatform()
      const root = await cursorProjectRoot(context.cwd)
      const user = join(context.home, ".cursor", "hooks.json")
      const project = join(root, ".cursor", "hooks.json")
      const sources: AuthoringSourceSpec[] = [
        { id: `user:${user}`, scope: "user", path: user, root: join(context.home, ".cursor"), label: "User hooks.json", rank: 1, format: "json", writable: WRITABLE },
        { id: `project:${project}`, scope: "project", path: project, root, label: "Project hooks.json", rank: 2, format: "json", writable: WRITABLE },
        { id: `imported:${join(context.home, ".claude", "settings.json")}`, scope: "imported", path: join(context.home, ".claude", "settings.json"), root: context.home, label: "Claude Code user settings", rank: 3, format: "json", writable: CLAUDE },
        { id: `imported:${join(root, ".claude", "settings.json")}`, scope: "imported", path: join(root, ".claude", "settings.json"), root, label: "Claude Code project settings", rank: 4, format: "json", writable: CLAUDE },
        { id: `imported:${join(root, ".claude", "settings.local.json")}`, scope: "imported", path: join(root, ".claude", "settings.local.json"), root, label: "Claude Code local settings", rank: 5, format: "json", writable: CLAUDE },
      ]
      if (platform !== "other") sources.unshift({ id: `managed:${MDM[platform]}`, scope: "managed", path: MDM[platform], root: MDM[platform], label: "MDM hooks.json", rank: 0, format: "json", writable: readOnly("Your administrator manages this file.") })
      return sources
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const entries = sources.flatMap((source): AuthoringEntry[] => {
        try { return readHooks(source.spec.scope === "imported" ? CLAUDE_SETTINGS : CURSOR_HOOKS, source, hookDocument(source), () => true) }
        catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      const sourceId = change.kind === "create" ? change.sourceId : parseHookEntryId(change.entryId).sourceId
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Cursor reads here. Reload and try again.")
      return hookFileEdit(CURSOR_HOOKS, source, change)
    },
  }
}

export function createCursorMcpEditing(): ProviderMcpEditing {
  return {
    provider: "cursor",
    family: "mcp",
    form: "mcp",
    names: "last",
    imports: true,
    precedence: "A project server in .cursor/mcp.json wins over a user server of the same name.",
    reload: "Cursor starts MCP servers when a conversation starts.",
    operations: {
      create: readOnly("Copy a server in from another agent in the MCP servers section."),
      edit: readOnly("Change a server's command by copying it in again from another agent, or in your editor."),
      disable: WRITABLE, remove: WRITABLE,
      trust: readOnly("Cursor's SDK starts a project's servers without asking you to approve them."),
    },
    async sources(context) {
      const root = await cursorProjectRoot(context.cwd)
      const user = join(context.home, ".cursor", "mcp.json")
      const project = join(root, ".cursor", "mcp.json")
      const state = join(cursorDir(context), "projects", cursorProjectSlug(root), "mcp-disabled.json")
      return [
        { id: `user:${user}`, scope: "user", path: user, root: join(context.home, ".cursor"), label: "User mcp.json", rank: 0, format: "json", within: ["mcpServers"], writable: WRITABLE },
        { id: `project:${project}`, scope: "project", path: project, root, label: "Project mcp.json", rank: 1, format: "json", within: ["mcpServers"], writable: WRITABLE },
        { id: `local:${state}`, scope: "local", path: state, root: cursorDir(context), label: "Servers turned off in this project", rank: 2, format: "json", within: [], writable: WRITABLE, switches: true },
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const state = sources.find((source) => source.spec.scope === "local")
      let disabled = new Set<string>()
      try { if (state) disabled = namesAt(jsonDocument(state), []) } catch (error) { if (state) problems.push({ sourceId: state.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }) }
      const entries = sources.filter((source) => source.spec.scope !== "local").flatMap((source) => {
        try { return readMcpServers(source, jsonDocument(source), ["mcpServers"], null, disabled) }
        catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      if (change.kind !== "enable" && change.kind !== "remove") throw new Error("Cursor's servers can be turned off and on, or removed, here.")
      const { sourceId, name } = parseMcpEntryId(change.entryId)
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Cursor reads here. Reload and try again.")
      if (change.kind === "remove") return jsonMcpRemove(source, ["mcpServers"], name)
      const state = sources.find((entry) => entry.spec.scope === "local")
      if (!state) throw new Error("Cursor keeps this project's switches in mcp-disabled.json, which Mako couldn't place.")
      return nameListSwitch(state, [], name, change.enabled, name)
    },
  }
}
