import { join } from "node:path"
import { CLAUDE_HOOK_EVENTS } from "@mako/sessions/harnesses"
import { z } from "zod"
import type { AuthoringEntry } from "../../contracts/native-authoring.js"
import type { JsonValue } from "../../contracts/json.js"
import { hostPlatform } from "../../base/platform.js"
import {
  commandFolderEdit,
  commandSource,
  gitRoot,
  hookDocument,
  hookFileEdit,
  jsonDocument,
  jsonMcpRemove,
  nameListSwitch,
  namesAt,
  parseHookEntryId,
  parseMcpEntryId,
  readCommandFolder,
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
  type ReadSource,
} from "../../tools/index.js"

/**
 * Claude Code's hooks, commands and MCP servers, as 2.1.283 reads them.
 *
 * Hooks sit under `hooks` in each settings file and every file's run: user,
 * project, local (at the repository's root) and managed. `disableAllHooks`
 * in any file but managed turns them all off; there is no switch for one
 * hook. The SDK Mako runs skips the trust dialog, so project hooks run in
 * any folder. Commands are Markdown files under `commands/`, a nested file
 * named with `:`, and a user command wins over a project one of the same
 * name. MCP servers sit in `~/.claude.json` (user, and each project's
 * `local` servers under `projects.<real path>`) and `.mcp.json`; any of
 * them is turned off by name in that project's `disabledMcpServers`, which
 * is what Claude's own `/mcp` toggle writes.
 */

const MANAGED = { darwin: "/Library/Application Support/ClaudeCode/managed-settings.json", linux: "/etc/claude-code/managed-settings.json", win32: "C:\\ProgramData\\ClaudeCode\\managed-settings.json" } as const

/** Claude Code's folder for the selected account: its own folder, `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
function configDir(context: AuthoringContext): string | undefined {
  return context.accountDir ?? (context.env.CLAUDE_CONFIG_DIR || undefined)
}

function settingsFiles(context: AuthoringContext, root: string): AuthoringSourceSpec[] {
  const dir = configDir(context)
  const user = dir ? join(dir, "settings.json") : join(context.home, ".claude", "settings.json")
  const platform = hostPlatform()
  const files: AuthoringSourceSpec[] = [
    { id: `user:${user}`, scope: "user", path: user, root: dir ?? context.home, label: "User settings", rank: 0, format: "json", writable: WRITABLE },
    { id: `project:${join(context.cwd, ".claude", "settings.json")}`, scope: "project", path: join(context.cwd, ".claude", "settings.json"), root: context.cwd, label: "Project settings", rank: 1, format: "json", writable: WRITABLE },
    { id: `local:${join(root, ".claude", "settings.local.json")}`, scope: "local", path: join(root, ".claude", "settings.local.json"), root, label: "Local project settings", rank: 2, format: "json", writable: WRITABLE },
  ]
  if (platform !== "other") files.push({ id: `managed:${MANAGED[platform]}`, scope: "managed", path: MANAGED[platform], root: MANAGED[platform], label: "Managed settings", rank: 3, format: "json", writable: readOnly("Your administrator manages this file.") })
  return files
}

const SDK_TRUST = "Claude Code's SDK, which Mako runs, reads this folder's settings without asking you to trust it."

export const CLAUDE_HOOKS: HookDialect = {
  layout: "grouped",
  root: ["hooks"],
  typeKey: "type",
  vocabulary: {
    events: [...CLAUDE_HOOK_EVENTS],
    handlers: [{ type: "command", run: "command" }, { type: "http", run: "url" }, { type: "prompt", run: "prompt" }, { type: "agent", run: "prompt" }],
    matcher: true,
  },
  scaffold: {},
  ownsFile: false,
}

const disablesAll = (value: JsonValue) => z.object({ disableAllHooks: z.literal(true) }).safeParse(value).success

export function createClaudeHooks(): ProviderAuthoringCapability {
  return {
    provider: "claude",
    family: "hooks",
    form: "hook",
    names: "all",
    precedence: "Hooks from every settings file run, user, project, local and managed alike. disableAllHooks in any file but the managed one turns them all off.",
    reload: "Claude Code reads hooks when a conversation starts.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE,
      disable: readOnly("Claude Code has no switch for one hook; disableAllHooks in a settings file turns every hook off at once."),
      trust: readOnly(SDK_TRUST),
    },
    hooks: CLAUDE_HOOKS.vocabulary,
    async sources(context) {
      const root = await gitRoot(context.cwd) ?? context.cwd
      return settingsFiles(context, root).map((spec) => spec.scope === "project" || spec.scope === "local" ? { ...spec, trust: { state: "unasked", detail: SDK_TRUST } } : spec)
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const documents = sources.map((source) => {
        try { return { source, value: hookDocument(source) } }
        catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return { source, value: null } }
      })
      const off = documents.flatMap(({ source, value }) => value !== null && source.spec.scope !== "managed" && disablesAll(value)
        ? [{ sourceId: source.spec.id, key: "disableAllHooks", detail: "Every hook but the managed ones is off while this file sets disableAllHooks." }] : [])
      const entries: AuthoringEntry[] = documents.flatMap(({ source, value }) => value === null ? [] :
        readHooks(CLAUDE_HOOKS, source, value, () => source.spec.scope === "managed" || !off.length))
      return { entries, off, problems }
    },
    change(sources, change) {
      const sourceId = change.kind === "create" ? change.sourceId : parseHookEntryId(change.entryId).sourceId
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That settings file is no longer one Claude Code reads here. Reload and try again.")
      return hookFileEdit(CLAUDE_HOOKS, source, change)
    },
  }
}

export function createClaudeCommands(): ProviderAuthoringCapability {
  const folder = { separator: ":" } as const
  return {
    provider: "claude",
    family: "commands",
    form: "command",
    names: "first",
    precedence: "A user command wins over a project command of the same name. A file in a folder is named with the folder, as /folder:name.",
    reload: "Claude Code reads commands when a conversation starts.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE,
      disable: readOnly("Claude Code reads a command file while it exists; there's no switch for one."),
      trust: readOnly(SDK_TRUST),
    },
    async sources(context) {
      const dir = configDir(context) ?? join(context.home, ".claude")
      return [
        { id: `user:${join(dir, "commands")}`, scope: "user", path: join(dir, "commands"), root: dir, label: "User commands", rank: 0, format: "folder", entries: { endings: [".md"], depth: 4 }, writable: WRITABLE },
        { id: `project:${join(context.cwd, ".claude", "commands")}`, scope: "project", path: join(context.cwd, ".claude", "commands"), root: context.cwd, label: "Project commands", rank: 1, format: "folder", entries: { endings: [".md"], depth: 4 }, writable: WRITABLE, trust: { state: "unasked", detail: SDK_TRUST } },
      ]
    },
    read: (sources) => ({ entries: sources.flatMap((source) => readCommandFolder(folder, source)), off: [], problems: [] }),
    change: (sources, change) => commandFolderEdit(folder, commandSource(sources, change), change),
  }
}

/** The part of `~/.claude.json` that is this project's, keyed by its real path as Claude Code keys it. */
const PROJECT = (key: string) => ["projects", key]

export function createClaudeMcpEditing(): ProviderMcpEditing {
  const state = (sources: readonly ReadSource[]) => sources.find((source) => source.spec.scope === "local")
  return {
    provider: "claude",
    family: "mcp",
    form: "mcp",
    names: "last",
    imports: true,
    precedence: "A local server (this project, this Mac) wins over a project server in .mcp.json, which wins over a user server of the same name.",
    reload: "Claude Code starts MCP servers when a conversation starts.",
    operations: {
      create: readOnly("Copy a server in from another agent in the MCP servers section."),
      edit: readOnly("Change a server's command by copying it in again from another agent, or in your editor."),
      disable: WRITABLE, remove: WRITABLE,
      trust: readOnly("Claude Code's SDK starts a project's .mcp.json servers without asking you to approve them."),
    },
    async sources(context) {
      const dir = context.env.CLAUDE_CONFIG_DIR || undefined
      const file = dir ? join(dir, ".claude.json") : join(context.home, ".claude.json")
      const key = await realOr(context.cwd)
      return [
        { id: `user:${file}`, scope: "user", path: file, root: dir ?? context.home, label: "User servers in ~/.claude.json", rank: 0, format: "json", within: ["mcpServers"], writable: WRITABLE },
        { id: `project:${join(context.cwd, ".mcp.json")}`, scope: "project", path: join(context.cwd, ".mcp.json"), root: context.cwd, label: "Project servers in .mcp.json", rank: 1, format: "json", within: ["mcpServers"], writable: WRITABLE },
        { id: `local:${file}`, scope: "local", path: file, root: dir ?? context.home, label: "This project's servers in ~/.claude.json", rank: 2, format: "json", within: [...PROJECT(key), "mcpServers"], writable: WRITABLE },
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const local = state(sources)
      let disabled = new Set<string>()
      try { if (local) disabled = namesAt(jsonDocument(local), [...(local.spec.within ?? []).slice(0, -1), "disabledMcpServers"]) }
      catch (error) { if (local) problems.push({ sourceId: local.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }) }
      const entries = sources.flatMap((source) => {
        try { return readMcpServers(source, jsonDocument(source), source.spec.within ?? ["mcpServers"], null, disabled) }
        catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      if (change.kind !== "enable" && change.kind !== "remove") throw new Error("Claude Code's servers can be turned off and on, or removed, here.")
      const { sourceId, name } = parseMcpEntryId(change.entryId)
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Claude Code reads here. Reload and try again.")
      if (change.kind === "remove") return jsonMcpRemove(source, source.spec.within ?? ["mcpServers"], name)
      const local = state(sources)
      if (!local) throw new Error("Claude Code keeps this project's switches in ~/.claude.json, which Mako couldn't find.")
      return nameListSwitch(local, [...(local.spec.within ?? []).slice(0, -1), "disabledMcpServers"], name, change.enabled, name)
    },
  }
}
