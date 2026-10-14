import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { CODEX_VOCABULARY } from "@mako/sessions/harnesses"
import { z } from "zod"
import type { AuthoringChange, AuthoringEntry, AuthoringTrust, EntryTrust } from "../../contracts/native-authoring.js"
import type { JsonObject, JsonValue } from "../../contracts/json.js"
import { hostPlatform } from "../../base/platform.js"
import {
  boundedRead,
  ensureTomlTable,
  foldersDown,
  gitRoot,
  hookDocument,
  hookFileEdit,
  mainCheckout,
  parseHookEntryId,
  parseMcpEntryId,
  parseTomlText,
  readHooks,
  readOnly,
  realOr,
  removeTomlTables,
  setTomlKey,
  tomlDocument,
  tomlMcpRemove,
  tomlMcpServers,
  tomlMcpSwitch,
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

/**
 * Codex's hooks and MCP servers, as 0.159.3 reads them.
 *
 * Hooks come from `hooks.json` and the `[hooks]` table of `config.toml`, in
 * `~/.codex`, in `.codex/` of every folder from the project's root down to
 * the working folder, and in `/etc/codex`; every layer's run. A project's
 * layers load only once `[projects."<path>"] trust_level = "trusted"` is in
 * the user config, and a linked worktree reads its hooks from the main
 * checkout's matching folder. Each hook outside the managed layer also needs
 * the person's trust: Codex runs it only while
 * `[hooks.state."<file>:<event>:<group>:<handler>"] trusted_hash` in the user
 * config matches a hash of the hook, which is what its `/hooks` review
 * writes, and `enabled = false` there turns one hook off. Mako writes hooks
 * to `hooks.json` only.
 *
 * Codex 0.159 reads no custom prompt files: `~/.codex/prompts` is gone and
 * commands are skills, so there is no commands family.
 *
 * MCP servers are `[mcp_servers.<name>]` in the user and trusted project
 * `config.toml`, merged key by key, project over user; `enabled = false`
 * turns one off.
 */

const EVENTS = "absent" in CODEX_VOCABULARY.concepts.hooks ? [] : [...CODEX_VOCABULARY.concepts.hooks.events]

/** Events whose matcher Codex reads; the others' matchers are ignored, and left out of a hook's trust hash. */
const MATCHED = new Set(["PreToolUse", "PermissionRequest", "PostToolUse", "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact"])

export const CODEX_HOOKS: HookDialect = {
  layout: "grouped",
  root: ["hooks"],
  typeKey: "type",
  vocabulary: { events: EVENTS, handlers: [{ type: "command", run: "command" }], matcher: true, matchers: [...MATCHED] },
  scaffold: {},
  ownsFile: true,
}

const codexDir = (context: AuthoringContext) => context.env.CODEX_HOME || join(context.home, ".codex")
const snake = (event: string) => event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()

const ObjectSchema = z.record(z.string(), z.json())
const asObject = (value: JsonValue | undefined): JsonObject | null => { const parsed = ObjectSchema.safeParse(value); return parsed.success ? parsed.data : null }
const TrustLevels = z.object({ projects: z.record(z.string(), z.object({ trust_level: z.enum(["trusted", "untrusted"]).optional() }).passthrough()) }).partial()

/** Where Codex keeps a project's trust: `[projects."<path>"]` in the user config, by the folder, the project's root or the repository's. */
function trustLevels(userConfig: string | null): z.infer<typeof TrustLevels>["projects"] {
  try { return TrustLevels.parse(userConfig ? parseTomlText(userConfig, "config.toml") : {}).projects }
  catch { return {} }
}

async function projectTrust(userConfig: string | null, candidates: readonly string[]): Promise<AuthoringTrust> {
  const projects = trustLevels(userConfig) ?? {}
  for (const candidate of candidates) {
    for (const key of new Set([candidate, await realOr(candidate)])) {
      const level = projects[key]?.trust_level
      if (level === "trusted") return { state: "trusted", detail: `Codex trusts ${key}.` }
      if (level === "untrusted") return { state: "untrusted", detail: `Codex has ${key} marked untrusted, so it skips this folder's hooks and settings. Change it in Codex.` }
    }
  }
  return { state: "untrusted", detail: "Codex skips this folder's hooks and settings until you trust the project in Codex." }
}

/** Codex's layers for a project, outermost first, with the folder hooks come from in a linked worktree. */
async function projectLayers(context: AuthoringContext): Promise<{ folder: string; hooks: string; trust: AuthoringTrust }[]> {
  const root = await gitRoot(context.cwd)
  const main = root ? await mainCheckout(root) : null
  const config = await boundedRead(join(codexDir(context), "config.toml")).catch(() => null)
  return Promise.all(foldersDown(root ?? context.cwd, context.cwd).map(async (folder) => ({
    folder,
    hooks: main && root ? join(main, relative(root, folder)) : folder,
    trust: await projectTrust(config, [folder, root ?? folder, main ?? root ?? folder]),
  })))
}

/** The managed layer: `/etc/codex` on macOS and Linux. */
function managed(rank: number): AuthoringSourceSpec[] {
  const platform = hostPlatform()
  if (platform !== "darwin" && platform !== "linux") return []
  const reason = readOnly("Your administrator manages this file.")
  return [
    { id: "managed:/etc/codex/hooks.json", scope: "managed", path: "/etc/codex/hooks.json", root: "/etc/codex", label: "Managed hooks.json", rank, format: "json", writable: reason },
    { id: "managed:/etc/codex/config.toml", scope: "managed", path: "/etc/codex/config.toml", root: "/etc/codex", label: "Managed config.toml", rank: rank + 1, format: "toml", writable: reason },
  ]
}

const TOML_HOOKS = readOnly("Mako writes Codex hooks to hooks.json. Edit the [hooks] table of config.toml in your editor.")

const userConfigSource = (sources: readonly ReadSource[]) => sources.find((source) => source.spec.scope === "user" && source.spec.format === "toml")

/** The handler as Codex hashes it for trust: its defaults filled in, its Windows command left out. */
function normalizedHandler(event: string, handler: JsonObject): JsonObject | null {
  const timeout = z.number().int().nonnegative().safeParse(handler.timeout).data
  const short = event === "SessionEnd" || event === "Interrupt"
  const seconds = short ? Math.min(Math.max(timeout ?? 1, 1), 3) : Math.max(timeout ?? 600, 1)
  const status = z.string().safeParse(handler.statusMessage).data
  if (handler.type === "command") {
    const command = z.string().safeParse(handler.command).data
    if (command === undefined) return null
    const result: JsonObject = { type: "command", command, timeout: seconds, async: handler.async === true }
    if (status !== undefined) result.statusMessage = status
    const limit = z.number().int().nonnegative().safeParse(handler.additionalContextLimit).data
    if (limit !== undefined && limit !== 2500 && ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"].includes(event)) result.additionalContextLimit = limit
    return result
  }
  if (handler.type === "mcp_tool") {
    const server = z.string().safeParse(handler.server).data
    const tool = z.string().safeParse(handler.tool).data
    if (!server || !tool) return null
    const result: JsonObject = { type: "mcp_tool", server, tool, input: asObject(handler.input) ?? {}, timeout: seconds }
    if (status !== undefined) result.statusMessage = status
    return result
  }
  return null
}

function sortKeys(value: JsonValue): JsonValue {
  const object = asObject(value)
  if (object) return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortKeys(object[key] ?? null)]))
  const list = z.array(z.json()).safeParse(value)
  return list.success ? list.data.map(sortKeys) : value
}

/** Codex's trust hash of one hook: SHA-256 of its normalized identity as sorted JSON. */
export function codexHookHash(event: string, matcher: string | undefined, handler: JsonObject): string | null {
  const normalized = normalizedHandler(event, handler)
  if (!normalized) return null
  const identity: JsonObject = { event_name: snake(event), hooks: [normalized] }
  if (matcher !== undefined && MATCHED.has(event)) identity.matcher = matcher
  return `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(identity))).digest("hex")}`
}

/** The key Codex files a hook's state under: its source file, event, group and handler. */
export function codexHookKey(path: string, address: HookAddress): string {
  return `${path}:${snake(address.event)}:${address.group}:${address.handler}`
}

const HookState = z.object({ enabled: z.boolean().optional(), trusted_hash: z.string().optional() }).passthrough()

function hookStates(sources: readonly ReadSource[]): Map<string, z.infer<typeof HookState>> {
  const config = userConfigSource(sources)
  const value = config?.text ? asObject(asObject(asObject(parseTomlText(config.text, config.spec.path))?.hooks)?.state) ?? {} : {}
  return new Map(Object.entries(value).flatMap(([key, state]) => { const parsed = HookState.safeParse(state); return parsed.success ? [[key, parsed.data]] : [] }))
}

function handlerAt(source: ReadSource, address: HookAddress): { matcher: string | undefined; handler: JsonObject } | null {
  const events = asObject(asObject(hookDocument(source))?.hooks)
  const group = asObject(z.array(z.json()).safeParse(events?.[address.event]).data?.[address.group])
  const handler = asObject(z.array(z.json()).safeParse(group?.hooks).data?.[address.handler])
  return handler ? { matcher: z.string().safeParse(group?.matcher).data, handler } : null
}

function entryTrust(managedSource: boolean, hash: string | null, trusted: string | undefined): EntryTrust {
  if (managedSource) return { state: "managed", detail: "Codex runs managed hooks without asking." }
  if (hash && trusted === hash) return { state: "trusted", detail: "You trusted this hook as it is now." }
  if (trusted) return { state: "modified", detail: "This hook changed since you trusted it, so Codex won't run it until you trust it again." }
  return { state: "untrusted", detail: "Codex won't run this hook until you trust it, here or in Codex's /hooks." }
}

/** One hook's state table in the user config, with `key` set to `value` (TOML) or removed, and the table removed when empty. */
function stateEdit(config: ReadSource, key: string, field: "enabled" | "trusted_hash", value: string | null, summary: string): AuthoringEdit {
  if (config.problem) throw new Error(config.problem)
  const path = ["hooks", "state", key]
  let after = config.text ?? ""
  if (value !== null) after = setTomlKey(ensureTomlTable(after, path), path, field, value)
  else if (tomlTables(after, path).own) {
    after = setTomlKey(after, path, field, null)
    const state = asObject(asObject(asObject(asObject(parseTomlText(after, config.spec.path))?.hooks)?.state)?.[key])
    if (state && !Object.keys(state).length) after = removeTomlTables(after, path)
  }
  const verified = verifyToml(config, after, (document) => {
    const hooks = asObject(document.hooks) ?? {}
    const states = asObject(hooks.state) ?? {}
    const state = asObject(states[key]) ?? {}
    if (value === null) delete state[field]
    else state[field] = field === "enabled" ? false : z.string().parse(JSON.parse(value))
    states[key] = state
    hooks.state = states
    document.hooks = hooks
  })
  return { path: config.spec.path, root: config.spec.root, scope: "user", format: "toml", before: config.text, after: verified, summary }
}

export function createCodexHooks(): ProviderAuthoringCapability {
  return {
    provider: "codex",
    family: "hooks",
    form: "hook",
    names: "all",
    precedence: "Hooks from every layer run: user, each project folder from the root down, and managed. A project's hooks load only once Codex trusts the project, and each hook outside the managed layer runs only once you've trusted it.",
    reload: "Codex reads hooks when a conversation starts.",
    operations: { create: WRITABLE, edit: WRITABLE, remove: WRITABLE, disable: WRITABLE, trust: WRITABLE },
    hooks: CODEX_HOOKS.vocabulary,
    async sources(context) {
      const dir = codexDir(context)
      const layers = await projectLayers(context)
      return [
        { id: `user:${join(dir, "hooks.json")}`, scope: "user", path: join(dir, "hooks.json"), root: dir, label: "User hooks.json", rank: 0, format: "json", writable: WRITABLE },
        { id: `user:${join(dir, "config.toml")}`, scope: "user", path: join(dir, "config.toml"), root: dir, label: "User config.toml", rank: 1, format: "toml", writable: TOML_HOOKS },
        ...layers.flatMap(({ folder, hooks, trust }, index): AuthoringSourceSpec[] => {
          const where = relative(layers[0]?.folder ?? folder, folder) || "the project's root"
          return [
            { id: `project:${join(hooks, ".codex", "hooks.json")}`, scope: "project", path: join(hooks, ".codex", "hooks.json"), root: hooks, label: `Project hooks.json in ${where}`, rank: 2 + index * 2, format: "json", writable: WRITABLE, trust },
            { id: `project:${join(hooks, ".codex", "config.toml")}`, scope: "project", path: join(hooks, ".codex", "config.toml"), root: hooks, label: `Project config.toml in ${where}`, rank: 3 + index * 2, format: "toml", writable: TOML_HOOKS, trust },
          ]
        }),
        ...managed(100),
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      let states = new Map<string, z.infer<typeof HookState>>()
      try { states = hookStates(sources) } catch (error) { problems.push({ sourceId: userConfigSource(sources)?.spec.id ?? "", problem: error instanceof Error ? error.message : "Unreadable" }) }
      const entries = sources.flatMap((source): AuthoringEntry[] => {
        let value: JsonValue
        try { value = hookDocument(source) } catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
        const managedSource = source.spec.scope === "managed"
        return readHooks(CODEX_HOOKS, source, value, (address) => managedSource || states.get(codexHookKey(source.spec.path, address))?.enabled !== false).map((entry) => {
          const address = parseHookEntryId(entry.id)
          const found = handlerAt(source, address)
          const hash = found ? codexHookHash(address.event, found.matcher, found.handler) : null
          return { ...entry, trust: entryTrust(managedSource, hash, states.get(codexHookKey(source.spec.path, address))?.trusted_hash) }
        })
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      const sourceId = change.kind === "create" ? change.sourceId : parseHookEntryId(change.entryId).sourceId
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Codex reads here. Reload and try again.")
      if (change.kind === "create" || change.kind === "edit") return hookFileEdit(CODEX_HOOKS, source, change)
      const address = parseHookEntryId(change.entryId)
      if (change.kind === "remove") return removal(source, address, change)
      if (source.spec.scope === "managed") throw new Error("Codex always runs managed hooks.")
      const config = userConfigSource(sources)
      if (!config) throw new Error("Codex keeps hook switches in its user config.toml, which Mako couldn't find.")
      const key = codexHookKey(source.spec.path, address)
      if (change.kind === "enable") return stateEdit(config, key, "enabled", change.enabled ? null : "false", `${change.enabled ? "Turn on" : "Turn off"} a ${address.event} hook from ${source.spec.label}, in the user config.toml`)
      const found = handlerAt(source, address)
      const hash = found ? codexHookHash(address.event, found.matcher, found.handler) : null
      if (!hash) throw new Error("Codex doesn't run this kind of hook, so there's nothing to trust.")
      return stateEdit(config, key, "trusted_hash", tomlString(hash), `Trust a ${address.event} hook from ${source.spec.label}, as Codex's /hooks review does`)
    },
  }
}

/** A removal, saying when the hooks after it move to positions whose trust and switches were recorded for others. */
function removal(source: ReadSource, address: HookAddress, change: AuthoringChange): AuthoringEdit {
  const edit = hookFileEdit(CODEX_HOOKS, source, change)
  const events = asObject(asObject(hookDocument(source))?.hooks)
  const groups = z.array(z.json()).safeParse(events?.[address.event]).data ?? []
  const sizes = groups.slice(address.group).map((group) => z.array(z.json()).safeParse(asObject(group)?.hooks).data?.length ?? 0)
  const later = sizes.reduce((count, size) => count + size, 0) - address.handler - 1
  return later > 0 ? { ...edit, summary: `${edit.summary}. Codex files trust by position, so the ${later} ${address.event} ${later === 1 ? "hook" : "hooks"} after it will need trusting again` } : edit
}

export function createCodexMcpEditing(): ProviderMcpEditing {
  const table = "mcp_servers"
  return {
    provider: "codex",
    family: "mcp",
    form: "mcp",
    names: "last",
    imports: true,
    precedence: "A trusted project's config.toml is merged over the user's key by key, so a project can turn a user server on or off; an untrusted project's servers aren't read.",
    reload: "Codex starts MCP servers when a conversation starts.",
    operations: {
      create: readOnly("Copy a server in from another agent in the MCP servers section."),
      edit: readOnly("Change a server's command by copying it in again from another agent, or in your editor."),
      disable: WRITABLE, remove: WRITABLE,
      trust: readOnly("Codex reads a project's servers once the project is trusted; there's no trust for one server."),
    },
    async sources(context) {
      const dir = codexDir(context)
      const layers = await projectLayers(context)
      return [
        { id: `user:${join(dir, "config.toml")}`, scope: "user", path: join(dir, "config.toml"), root: dir, label: "User config.toml", rank: 0, format: "toml", writable: WRITABLE },
        ...layers.map(({ folder, trust }, index): AuthoringSourceSpec => ({
          id: `project:${join(folder, ".codex", "config.toml")}`, scope: "project", path: join(folder, ".codex", "config.toml"), root: folder,
          label: `Project config.toml in ${relative(layers[0]?.folder ?? folder, folder) || "the project's root"}`, rank: 1 + index, format: "toml", writable: WRITABLE, trust,
        })),
      ]
    },
    read(sources) {
      const problems: { sourceId: string; problem: string }[] = []
      const entries = sources.flatMap((source) => {
        try { tomlDocument(source); return tomlMcpServers(source, table, new Set()) }
        catch (error) { problems.push({ sourceId: source.spec.id, problem: error instanceof Error ? error.message : "Unreadable" }); return [] }
      })
      return { entries, off: [], problems }
    },
    change(sources, change) {
      if (change.kind !== "enable" && change.kind !== "remove") throw new Error("Codex's servers can be turned off and on, or removed, here.")
      const { sourceId, name } = parseMcpEntryId(change.entryId)
      const source = sources.find((entry) => entry.spec.id === sourceId)
      if (!source) throw new Error("That file is no longer one Codex reads here. Reload and try again.")
      return change.kind === "remove" ? tomlMcpRemove(source, table, name) : tomlMcpSwitch(source, table, name, change.enabled)
    },
  }
}
