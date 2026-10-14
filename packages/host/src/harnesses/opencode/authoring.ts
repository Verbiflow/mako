import { join, relative } from "node:path"
import { z } from "zod"
import type { AuthoringEntry } from "../../contracts/native-authoring.js"
import type { JsonObject, JsonValue } from "../../contracts/json.js"
import {
  commandFolderEdit,
  commandSource,
  configCommandEdit,
  foldersDown,
  gitRoot,
  jsonDocument,
  jsonMcpRemove,
  jsonMcpSwitch,
  moduleFolderEdit,
  parseMcpEntryId,
  readCommandFolder,
  readConfigCommands,
  readMcpServers,
  readModuleFolder,
  readOnly,
  WRITABLE,
  type AuthoringContext,
  type AuthoringSourceSpec,
  type ProviderAuthoringCapability,
  type ProviderMcpEditing,
  type ReadSource,
} from "../../tools/index.js"

/**
 * OpenCode's plugins, commands and MCP servers, as 2.x reads them.
 *
 * OpenCode has no shell hooks: its hooks are plugins, code files in the
 * `plugin/` or `plugins/` folder of its config folder and of the project's
 * `.opencode/`, plus npm packages named in the `plugins` key. Every plugin
 * loads; `"-<id>"` in `plugins` turns one off by the id its code declares.
 *
 * Commands are Markdown files under `command/` or `commands/` of those same
 * folders, a nested file named with `/`, and entries of the `commands` key
 * (`command` before 2.x) in each config file.
 *
 * Config files: `opencode.json` and `opencode.jsonc` in the config folder,
 * in the project's folders from its root down, and in `.opencode/`, read in
 * that order with a later one winning a name. JSON with comments throughout,
 * so every edit keeps them. MCP servers sit under `mcp.servers` with
 * `"disabled": true` to turn one off; 1.x's `mcp.<name>` with
 * `"enabled": false` is still read and edited in place.
 */

const configDir = (context: AuthoringContext) => context.env.OPENCODE_CONFIG_DIR || join(context.env.XDG_CONFIG_HOME || join(context.home, ".config"), "opencode")

/** Every config file OpenCode reads for the project, in its order. */
async function configFiles(context: AuthoringContext, first: number): Promise<AuthoringSourceSpec[]> {
  const dir = configDir(context)
  const root = await gitRoot(context.cwd) ?? context.cwd
  const files: AuthoringSourceSpec[] = ["opencode.json", "opencode.jsonc"].map((name, index) => ({
    id: `user:${join(dir, name)}`, scope: "user", path: join(dir, name), root: dir, label: `User ${name}`, rank: first + index, format: "json", writable: WRITABLE,
  }))
  for (const folder of foldersDown(root, context.cwd)) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      files.push({ id: `project:${join(folder, name)}`, scope: "project", path: join(folder, name), root: folder, label: `${name} in ${relative(root, folder) || "the project's root"}`, rank: first + files.length, format: "json", writable: WRITABLE })
    }
  }
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    files.push({ id: `project:${join(context.cwd, ".opencode", name)}`, scope: "project", path: join(context.cwd, ".opencode", name), root: context.cwd, label: `.opencode/${name}`, rank: first + files.length, format: "json", writable: WRITABLE })
  }
  return files
}

/** The `plugin`/`plugins` or `command`/`commands` folders of the config folder and the project's `.opencode/`. */
function folders(context: AuthoringContext, names: readonly string[], endings: string[], depth: number, label: string): AuthoringSourceSpec[] {
  const dir = configDir(context)
  return [
    ...names.map((name, index): AuthoringSourceSpec => ({ id: `user:${join(dir, name)}`, scope: "user", path: join(dir, name), root: dir, label: `User ${label} (${name}/)`, rank: index, format: "folder", entries: { endings, depth }, writable: WRITABLE })),
    ...names.map((name, index): AuthoringSourceSpec => ({ id: `project:${join(context.cwd, ".opencode", name)}`, scope: "project", path: join(context.cwd, ".opencode", name), root: context.cwd, label: `Project ${label} (.opencode/${name}/)`, rank: 50 + index, format: "folder", entries: { endings, depth }, writable: WRITABLE })),
  ]
}

const problemOf = (source: ReadSource, error: Error | null) => ({ sourceId: source.spec.id, problem: error?.message ?? "Unreadable" })

export function createOpenCodePlugins(): ProviderAuthoringCapability {
  return {
    provider: "opencode",
    family: "hooks",
    form: "module",
    names: "all",
    precedence: "Every plugin file in these folders loads, the user's and the project's, beside the npm packages named in plugins.",
    reload: "OpenCode loads plugins when its server starts, which Mako does for each new connection.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE,
      disable: readOnly("OpenCode turns a plugin off by the id its code declares, with \"-<id>\" in plugins; Mako doesn't run a plugin's code to read its id."),
      trust: readOnly("OpenCode loads a project's plugins without asking you to trust the folder."),
    },
    sources: (context) => Promise.resolve(folders(context, ["plugins", "plugin"], [".ts", ".js"], 0, "plugins")),
    read: (sources) => ({ entries: sources.flatMap(readModuleFolder), off: [], problems: [] }),
    change(sources, change) {
      const source = commandSource(sources, change)
      if (!source.spec.writable.supported) throw new Error(source.spec.writable.reason)
      return moduleFolderEdit(source, change)
    },
  }
}

export function createOpenCodeCommands(): ProviderAuthoringCapability {
  const folder = { separator: "/" } as const
  const keys = ["commands", "command"]
  return {
    provider: "opencode",
    family: "commands",
    form: "command",
    names: "last",
    precedence: "Files in command/ and commands/ and entries of the commands key are all read; a project's command replaces a user's of the same name. A file in a folder is named with the folder, as /folder/name.",
    reload: "OpenCode reads commands when its server starts, which Mako does for each new connection.",
    operations: {
      create: WRITABLE, edit: WRITABLE, remove: WRITABLE,
      disable: readOnly("OpenCode reads a command while it exists; there's no switch for one."),
      trust: readOnly("OpenCode reads a project's commands without asking you to trust the folder."),
    },
    async sources(context) {
      return [...folders(context, ["commands", "command"], [".md"], 4, "commands"), ...await configFiles(context, 10)]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const entries = sources.flatMap((source): AuthoringEntry[] => {
        if (source.spec.format === "folder") return readCommandFolder(folder, source)
        try { return readConfigCommands(source, keys) } catch (error) { problems.push(problemOf(source, error instanceof Error ? error : null)); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      const source = commandSource(sources, change)
      return source.spec.format === "folder" ? commandFolderEdit(folder, source, change) : configCommandEdit(source, change)
    },
  }
}

const ObjectSchema = z.record(z.string(), z.json())
const asObject = (value: JsonValue | undefined): JsonObject | null => { const parsed = ObjectSchema.safeParse(value); return parsed.success ? parsed.data : null }
const CURRENT = { root: ["mcp", "servers"], switchKey: { key: "disabled", off: true } }
const LEGACY = { root: ["mcp"], switchKey: { key: "enabled", off: false } }

/** Which form a server is written in: 2.x's `mcp.servers.<name>`, or 1.x's `mcp.<name>`. */
function form(source: ReadSource, name: string): typeof CURRENT {
  const mcp = asObject(asObject(jsonDocument(source))?.mcp)
  return asObject(asObject(mcp?.servers)?.[name]) ? CURRENT : LEGACY
}

export function createOpenCodeMcpEditing(): ProviderMcpEditing {
  return {
    provider: "opencode",
    family: "mcp",
    form: "mcp",
    names: "last",
    imports: true,
    precedence: "Config files are read user first, then the project's from its root down, then .opencode/; the last server of a name replaces the others whole.",
    reload: "OpenCode starts MCP servers when its server starts, which Mako does for each new connection.",
    operations: {
      create: readOnly("Copy a server in from another agent in the MCP servers section."),
      edit: readOnly("Change a server's command by copying it in again from another agent, or in your editor."),
      disable: WRITABLE, remove: WRITABLE,
      trust: readOnly("OpenCode starts a project's servers without asking you to approve them."),
    },
    sources: (context) => configFiles(context, 0),
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const entries = sources.flatMap((source) => {
        try {
          const document = jsonDocument(source)
          return [
            ...readMcpServers(source, document, CURRENT.root, CURRENT.switchKey, new Set()),
            ...readMcpServers(source, document, LEGACY.root, LEGACY.switchKey, new Set(), ["servers", "timeout"]),
          ]
        } catch (error) { problems.push(problemOf(source, error instanceof Error ? error : null)); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      if (change.kind !== "enable" && change.kind !== "remove") throw new Error("OpenCode's servers can be turned off and on, or removed, here.")
      const { sourceId, name } = parseMcpEntryId(change.entryId)
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one OpenCode reads here. Reload and try again.")
      const written = form(source, name)
      return change.kind === "remove" ? jsonMcpRemove(source, written.root, name) : jsonMcpSwitch(source, written.root, name, written.switchKey, change.enabled)
    },
  }
}
