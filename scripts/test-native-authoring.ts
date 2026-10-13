import assert from "node:assert/strict"
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { JsonObject, JsonValue } from "@mako/host/contracts/json"
import type { AuthoringChange, AuthoringPlan, AuthoringTarget, AuthoringView, NativeAuthoringFamily } from "@mako/host/contracts/native-authoring"
import { parseJsonc, parseTomlText, setTomlKey, removeTomlTables, tomlTables, redactToml, redactJson, diffLines } from "@mako/host/tools/authoring-text"
import { markShadowed } from "@mako/host/tools/native-authoring"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { HostMethods } from "@mako/host/transport/methods"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { declareAuthoringMethods } from "@mako/host/tools/index"
import { codexHookHash } from "@mako/host/harnesses/codex/authoring"
import { authoringWorld, type AuthoringWorld } from "./native-authoring-world.ts"

/**
 * Every harness's hooks, commands and MCP servers read from its recorded
 * config shapes and changed in a scratch home: what each source holds, which
 * entry wins a name, round trips that keep comments and unknown keys, turning
 * an entry off and on again, stale previews refused, backups kept out of the
 * project, credentials never in a preview, and no hook ever run.
 */

const FAMILIES: NativeAuthoringFamily[] = ["hooks", "commands", "mcp"]
const CodexState = z.object({ hooks: z.object({ state: z.record(z.string(), z.object({ enabled: z.boolean().optional(), trusted_hash: z.string().optional() })) }) }).passthrough()
const GrokConfig = z.object({ disabled_mcp_servers: z.array(z.string()), mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() }).passthrough()) }).passthrough()
const TomlServers = z.object({ mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() }).passthrough()) }).passthrough()

async function view(world: AuthoringWorld, provider: string, family: NativeAuthoringFamily): Promise<AuthoringView> {
  return world.authoring.view(world.project, { provider, family, cwd: world.project })
}

async function apply(world: AuthoringWorld, target: AuthoringTarget, change: AuthoringChange): Promise<AuthoringPlan> {
  const plan = await world.authoring.preview(world.project, target, change)
  assert.ok(!JSON.stringify(plan.lines).includes("SECRET-"), `${target.provider} ${target.family}: a preview showed a credential: ${plan.summary}`)
  await world.authoring.apply(world.project, target, change, plan.revision)
  return plan
}

function named(view: AuthoringView, name: string, sourceScope?: string) {
  const found = view.entries.filter((entry) => entry.name === name && (!sourceScope || view.sources.find((source) => source.id === entry.sourceId)?.scope === sourceScope))
  assert.equal(found.length, 1, `${view.provider} ${view.family}: one ${name}${sourceScope ? ` in ${sourceScope}` : ""}, found ${found.length}: ${view.entries.map((entry) => entry.name).join(", ")}`)
  return found[0]!
}

const sourceOf = (view: AuthoringView, id: string) => view.sources.find((source) => source.id === id)!

/** Every change a view allows on every entry, previewed only: no credential may reach a preview. */
async function previewEverything(world: AuthoringWorld, target: AuthoringTarget, current: AuthoringView): Promise<number> {
  let previews = 0
  for (const entry of current.entries) {
    const changes: AuthoringChange[] = []
    if (current.operations.disable.supported) changes.push({ kind: "enable", entryId: entry.id, enabled: !entry.enabled })
    if (current.operations.remove.supported) changes.push({ kind: "remove", entryId: entry.id })
    if (current.operations.trust.supported) changes.push({ kind: "trust", entryId: entry.id })
    for (const change of changes) {
      const plan = await world.authoring.preview(world.project, target, change).catch((error: Error) => error)
      if (plan instanceof Error) {
        assert.ok(plan.message.trim(), `${target.provider} ${target.family}: a refusal says why`)
        continue
      }
      previews += 1
      assert.ok(!JSON.stringify(plan.lines).includes("SECRET-"), `${target.provider} ${target.family} ${change.kind} ${entry.name} showed a credential`)
      assert.ok(plan.summary.trim())
    }
  }
  return previews
}

async function noHookRan(world: AuthoringWorld): Promise<void> {
  assert.deepEqual(await readdir(world.marker), [], "reading and writing hooks must never run one")
}

/** Files Mako wrote beside a config: none, since backups go to Mako's own folder. */
async function strays(folder: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(join(current, entry.name))
      else if (/mako-backup|\.tmp$|\.lock$/.test(entry.name)) found.push(join(current, entry.name))
    }
  }
  await walk(folder)
  return found
}

async function everyHarness(): Promise<void> {
  const world = await authoringWorld("claude")
  try {
    const catalog = await world.authoring.catalog(world.project)
    const providers = [...new Set(catalog.views.map((entry) => entry.provider))]
    assert.deepEqual(catalog.views.length, providers.length * FAMILIES.length)
    const absent = catalog.views.filter((entry) => entry.absent).map((entry) => `${entry.provider}:${entry.family}`).sort()
    assert.deepEqual(absent, ["codex:commands", "cursor:commands", "devin:commands"], "only harnesses with no commands of their own lack a family")
    for (const entry of catalog.views) {
      if (entry.absent) { assert.ok(entry.absent.reason.length > 20, `${entry.provider} ${entry.family} says why`); continue }
      assert.ok(entry.precedence && entry.reload, `${entry.provider} ${entry.family} declares its order and reload`)
      for (const [operation, support] of Object.entries(entry.operations))
        if (!support.supported) assert.ok(support.reason.length > 15, `${entry.provider} ${entry.family} says why it has no ${operation}`)
      assert.ok(entry.sources.length > 0)
      if (entry.family === "hooks" && entry.form === "hook") assert.ok(entry.hooks?.events.length, `${entry.provider} lists its hook events`)
    }
  } finally { await world.cleanup() }
}

async function claude(): Promise<void> {
  const world = await authoringWorld("claude")
  try {
    const hooks = await view(world, "claude", "hooks")
    assert.deepEqual(hooks.entries.map((entry) => entry.name).sort(), ["PostToolUse · Edit|Write", "PostToolUse · Edit|Write", "PreToolUse · Bash", "SessionStart"])
    const http = hooks.entries.find((entry) => entry.hook?.type === "http")
    assert.equal(http?.hook?.run, "http://127.0.0.1:9/hook")
    assert.deepEqual(hooks.entries.find((entry) => entry.hook?.run.includes("claude-post-tool"))?.hook?.other, ["statusMessage"])
    const project = hooks.sources.find((source) => source.scope === "project")!
    assert.equal(project.trust?.state, "unasked")
    const target = { provider: "claude", family: "hooks" as const, cwd: world.project }
    await assert.rejects(world.authoring.preview(world.project, target, { kind: "enable", entryId: hooks.entries[0]!.id, enabled: false }), /disableAllHooks/)
    // Create, edit and remove a hook in the user settings: everything else stays as it was.
    const settings = join("home", ".claude", "settings.json")
    const original = await world.read(settings)
    const user = hooks.sources.find((source) => source.scope === "user")!
    await apply(world, target, { kind: "create", sourceId: user.id, draft: { kind: "hook", event: "Stop", type: "command", run: "touch \"$MAKO_FIXTURE_MARKER/claude-stop\"", timeout: 5 } })
    const created = named(await view(world, "claude", "hooks"), "Stop")
    assert.equal(created.hook?.timeout, 5)
    await apply(world, target, { kind: "edit", entryId: created.id, draft: { kind: "hook", event: "Stop", matcher: "", type: "command", run: "touch \"$MAKO_FIXTURE_MARKER/claude-stop-2\"" } })
    const edited = named(await view(world, "claude", "hooks"), "Stop")
    assert.equal(edited.hook?.timeout, undefined)
    await apply(world, target, { kind: "remove", entryId: edited.id })
    assert.deepEqual(parseJsonc(await world.read(settings), settings), parseJsonc(original, settings), "create, edit and remove leave the settings as they were")
    // Editing one handler of a group keeps its sibling and its unknown keys.
    const post = (await view(world, "claude", "hooks")).entries.find((entry) => entry.hook?.run.includes("claude-post-tool"))!
    await apply(world, target, { kind: "edit", entryId: post.id, draft: { kind: "hook", event: "PostToolUse", matcher: "Edit|Write", type: "command", run: "touch \"$MAKO_FIXTURE_MARKER/claude-post-tool-2\"", timeout: 9 } })
    const after = parseJsonc(await world.read(settings), settings)
    assert.match(JSON.stringify(after), /"statusMessage":"Formatting"/)
    assert.match(JSON.stringify(after), /127\.0\.0\.1:9\/hook/)
    assert.match(JSON.stringify(after), /"enableArtifact":true/)
    // A stale preview is refused, and nothing is written.
    const before = await world.read(settings)
    const stale = await world.authoring.preview(world.project, target, { kind: "remove", entryId: post.id })
    await writeFile(join(world.root, settings), `${before}\n`)
    await assert.rejects(world.authoring.apply(world.project, target, { kind: "remove", entryId: post.id }, stale.revision), /changed after the preview/)
    assert.equal(await world.read(settings), `${before}\n`)
    // Backups sit in Mako's folder, holding the file as it was.
    const kept = await readdir(world.backups, { recursive: true })
    assert.ok(kept.some((name) => name.endsWith("settings.json")), "each write keeps the file as it was")
    assert.deepEqual(await strays(world.home), [])

    const commands = await view(world, "claude", "commands")
    assert.deepEqual(commands.entries.map((entry) => entry.name).sort(), ["/git:commit", "/review"])
    assert.equal(named(commands, "/git:commit").command?.description, "Commit the staged change")
    const commandTarget = { provider: "claude", family: "commands" as const, cwd: world.project }
    const projectCommands = commands.sources.find((source) => source.scope === "project")!
    const userCommands = commands.sources.find((source) => source.scope === "user")!
    await apply(world, commandTarget, { kind: "create", sourceId: projectCommands.id, draft: { kind: "command", invocation: "git:commit", text: "---\ndescription: Project commit\n---\nCommit.\n" } })
    const both = await view(world, "claude", "commands")
    const shadowed = both.entries.filter((entry) => entry.name === "/git:commit")
    assert.equal(shadowed.length, 2)
    assert.equal(shadowed.find((entry) => entry.sourceId === projectCommands.id)?.shadowedBy, shadowed.find((entry) => entry.sourceId === userCommands.id)?.id, "Claude Code's user command wins its name")
    await assert.rejects(world.authoring.preview(world.project, commandTarget, { kind: "create", sourceId: projectCommands.id, draft: { kind: "command", invocation: "../escape", text: "x" } }), /Name a command/)
    await apply(world, commandTarget, { kind: "remove", entryId: shadowed.find((entry) => entry.sourceId === projectCommands.id)!.id })
    assert.equal((await view(world, "claude", "commands")).entries.length, 2)

    const mcp = await view(world, "claude", "mcp")
    assert.equal(named(mcp, "docs").enabled, false, "the project's disabledMcpServers turns off a user server")
    assert.equal(named(mcp, "scratch").enabled, true)
    assert.deepEqual(named(mcp, "fixture-local-tool").mcp?.envNames, ["FIXTURE_KEY"])
    assert.ok(named(mcp, "project-tool").mcp?.args?.includes("[redacted]"))
    const mcpTarget = { provider: "claude", family: "mcp" as const, cwd: world.project }
    const claudeJson = join("home", ".claude.json")
    const json = await world.read(claudeJson)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "docs").id, enabled: true })
    assert.equal(named(await view(world, "claude", "mcp"), "docs").enabled, true)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "docs").id, enabled: false })
    assert.deepEqual(parseJsonc(await world.read(claudeJson), claudeJson), parseJsonc(json, claudeJson), "turning a server on and off again restores the project's list")
    const toggled = await world.read(claudeJson)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "scratch").id, enabled: false })
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "scratch").id, enabled: true })
    assert.equal(await world.read(claudeJson), toggled, "a server turned off and on again leaves ~/.claude.json byte for byte")
    assert.ok(await previewEverything(world, mcpTarget, await view(world, "claude", "mcp")) > 0)
    await noHookRan(world)
  } finally { await world.cleanup() }
}

async function codex(): Promise<void> {
  const world = await authoringWorld("codex")
  try {
    const hooks = await view(world, "codex", "hooks")
    assert.deepEqual(hooks.entries.map((entry) => entry.name).sort(), ["PreToolUse · Bash", "SessionStart", "Stop"])
    assert.equal(named(hooks, "Stop").enabled, false, "[hooks.state] enabled = false turns one hook off")
    assert.equal(named(hooks, "SessionStart").trust?.state, "untrusted")
    const project = hooks.sources.find((source) => source.scope === "project" && source.path.endsWith("hooks.json"))!
    assert.equal(project.trust?.state, "trusted")
    const target = { provider: "codex", family: "hooks" as const, cwd: world.project }
    const config = join("home", ".codex", "config.toml")
    const original = await world.read(config)
    await apply(world, target, { kind: "trust", entryId: named(hooks, "SessionStart").id })
    const trusted = named(await view(world, "codex", "hooks"), "SessionStart")
    assert.equal(trusted.trust?.state, "trusted")
    assert.match(await world.read(config), /trusted_hash = "sha256:[0-9a-f]{64}"/)
    await apply(world, target, { kind: "edit", entryId: trusted.id, draft: { kind: "hook", event: "SessionStart", type: "command", run: "touch \"$MAKO_FIXTURE_MARKER/codex-session-start\"", timeout: 6 } })
    assert.equal(named(await view(world, "codex", "hooks"), "SessionStart").trust?.state, "modified", "an edited hook needs trusting again")
    await apply(world, target, { kind: "enable", entryId: named(hooks, "Stop").id, enabled: true })
    assert.equal(named(await view(world, "codex", "hooks"), "Stop").enabled, true)
    assert.ok(!(await world.read(config)).includes(":stop:0:0"), "turning a hook back on removes its empty state table")
    assert.match(await world.read(config), /# Codex user configuration \(fixture\)/)
    const state = CodexState.parse(parseTomlText(await world.read(config), config))
    assert.equal(state.hooks.state[`${world.home}/.codex/hooks.json:stop:0:0`], undefined)
    assert.equal(state.hooks.state[`${world.home}/.codex/hooks.json:session_start:0:0`]?.trusted_hash, trustHash(trusted))
    const { hooks: _now, ...rest } = state
    const { hooks: _then, ...was } = CodexState.parse(parseTomlText(original, config))
    assert.deepEqual(rest, was, "trusting and switching hooks touches nothing else in config.toml")
    // A new hook goes at the end of its event, so nothing moves and no trust is lost.
    await apply(world, target, { kind: "create", sourceId: project.id, draft: { kind: "hook", event: "PreToolUse", matcher: "Edit", type: "command", run: "true" } })
    const added = (await view(world, "codex", "hooks")).entries.filter((entry) => entry.name.startsWith("PreToolUse"))
    assert.equal(added.length, 2)
    await assert.rejects(world.authoring.preview(world.project, target, { kind: "create", sourceId: project.id, draft: { kind: "hook", event: "Notification", type: "command", run: "true" } }), /isn't an event/)
    const removal = await world.authoring.preview(world.project, target, { kind: "remove", entryId: added.find((entry) => entry.name === "PreToolUse · Bash")!.id })
    assert.match(removal.summary, /trusting again/, "removing a hook that others follow says their trust will be asked again")
    const projectHooks = join("project", ".codex", "hooks.json")
    assert.equal(JSON.parse(await world.read(projectHooks)).description, "Project checks", "unknown top-level keys stay")

    const mcp = await view(world, "codex", "mcp")
    assert.equal(named(mcp, "computer-use").enabled, false)
    assert.equal(named(mcp, "project_tool").enabled, true)
    const mcpTarget = { provider: "codex", family: "mcp" as const, cwd: world.project }
    const configNow = await world.read(config)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "node_repl").id, enabled: false })
    assert.equal(TomlServers.parse(parseTomlText(await world.read(config), config)).mcp_servers.node_repl?.enabled, false)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "node_repl").id, enabled: true })
    assert.equal(await world.read(config), configNow, "a server turned off and on leaves config.toml byte for byte")
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "computer-use").id, enabled: true })
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "computer-use").id, enabled: false })
    assert.deepEqual(parseTomlText(await world.read(config), config), parseTomlText(configNow, config), "a disabled server turned on and off keeps its meaning")
    assert.match(await world.read(config), /# Turned off in Codex itself\.\n\[mcp_servers\.computer-use\]\ncommand = "\/usr\/bin\/true"\nargs = \[\n  "--mcp",\n\]/, "a multi-line array and the comment above stay")
    await apply(world, mcpTarget, { kind: "remove", entryId: named(mcp, "node_repl").id })
    assert.ok(!(await world.read(config)).includes("node_repl"), "removing a server removes its env table too")
    assert.ok(await previewEverything(world, mcpTarget, await view(world, "codex", "mcp")) > 0)
    await noHookRan(world)
  } finally { await world.cleanup() }
}

function trustHash(entry: { hook?: { event: string; matcher?: string; run: string; timeout?: number } }): string {
  const hook = entry.hook!
  const handler: JsonObject = { type: "command", command: hook.run }
  if (hook.timeout !== undefined) handler.timeout = hook.timeout
  return codexHookHash(hook.event, hook.matcher, handler) ?? ""
}

async function cursor(): Promise<void> {
  const world = await authoringWorld("cursor")
  try {
    const hooks = await view(world, "cursor", "hooks")
    assert.deepEqual(hooks.entries.map((entry) => entry.name).sort(), ["beforeShellExecution · git push", "beforeSubmitPrompt", "stop"])
    assert.deepEqual(named(hooks, "beforeShellExecution · git push").hook?.other, ["failClosed"])
    const target = { provider: "cursor", family: "hooks" as const, cwd: world.project }
    const projectFile = join("project", ".cursor", "hooks.json")
    const original = await world.read(projectFile)
    await apply(world, target, { kind: "create", sourceId: named(hooks, "beforeShellExecution · git push").sourceId, draft: { kind: "hook", event: "afterFileEdit", type: "command", run: "true" } })
    assert.match(await world.read(projectFile), /\/\/ Project hooks, JSON with comments as Cursor accepts\./, "comments in a JSONC hooks file stay")
    await apply(world, target, { kind: "remove", entryId: named(await view(world, "cursor", "hooks"), "afterFileEdit").id })
    assert.equal(await world.read(projectFile), original, "a hook added and removed leaves hooks.json byte for byte")
    // The last hook of a user file goes with its file, which held nothing else.
    const fresh = hooks.sources.find((source) => source.scope === "user")!
    for (const entry of (await view(world, "cursor", "hooks")).entries.filter((candidate) => candidate.sourceId === fresh.id))
      await apply(world, target, { kind: "remove", entryId: entry.id })
    assert.equal(sourceOf(await view(world, "cursor", "hooks"), fresh.id).exists, false)
    await apply(world, target, { kind: "create", sourceId: fresh.id, draft: { kind: "hook", event: "stop", type: "command", run: "true" } })
    assert.equal(JSON.parse(await world.read(join("home", ".cursor", "hooks.json"))).version, 1, "a new hooks.json starts with its version")

    const mcp = await view(world, "cursor", "mcp")
    assert.equal(named(mcp, "arca").enabled, false, "mcp-disabled.json turns a server off")
    assert.equal(named(mcp, "browser").enabled, true)
    const mcpTarget = { provider: "cursor", family: "mcp" as const, cwd: world.project }
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "arca").id, enabled: true })
    assert.equal(sourceOf(await view(world, "cursor", "mcp"), named(mcp, "arca").sourceId).exists, true)
    assert.equal((await view(world, "cursor", "mcp")).sources.find((source) => source.scope === "local")?.exists, false, "the list goes when it empties")
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "arca").id, enabled: false })
    assert.equal(named(await view(world, "cursor", "mcp"), "arca").enabled, false)
    assert.ok(await previewEverything(world, mcpTarget, await view(world, "cursor", "mcp")) > 0)
    // A session in a subfolder reads the repository's top level, as the SDK does (seen live with 1.0.31).
    const below = join(world.project, "packages", "app")
    await mkdir(below, { recursive: true })
    for (const family of ["hooks", "mcp"] as const) {
      const sources = (await world.authoring.view(below, { provider: "cursor", family, cwd: below })).sources
      assert.deepEqual(sources.map((source) => source.id), (await view(world, "cursor", family)).sources.map((source) => source.id), `cursor ${family}: a subfolder's sources are its repository's`)
    }
    await noHookRan(world)
  } finally { await world.cleanup() }
}

async function devin(): Promise<void> {
  const world = await authoringWorld("devin")
  try {
    const hooks = await view(world, "devin", "hooks")
    assert.deepEqual(hooks.entries.map((entry) => entry.name).sort(), ["PreToolUse · exec", "UserPromptSubmit"])
    const target = { provider: "devin", family: "hooks" as const, cwd: world.project }
    const v1 = named(hooks, "PreToolUse · exec")
    await apply(world, target, { kind: "remove", entryId: v1.id })
    assert.equal(sourceOf(await view(world, "devin", "hooks"), v1.sourceId).exists, false, "hooks.v1.json holds only hooks, so it goes with its last one")
    await apply(world, target, { kind: "create", sourceId: v1.sourceId, draft: { kind: "hook", event: "Stop", type: "prompt", run: "Check the work" } })
    assert.deepEqual(JSON.parse(await world.read(join("project", ".devin", "hooks.v1.json"))), { Stop: [{ hooks: [{ type: "prompt", prompt: "Check the work" }] }] })
    const config = join("home", ".config", "devin", "config.json")
    const user = named(hooks, "UserPromptSubmit")
    await apply(world, target, { kind: "edit", entryId: user.id, draft: { kind: "hook", event: "UserPromptSubmit", type: "command", run: "true", timeout: 3 } })
    assert.equal(JSON.parse(await world.read(config)).devin.org_id, "org-fixture", "Devin's own settings beside the hooks stay")

    const mcp = await view(world, "devin", "mcp")
    const tools = mcp.entries.filter((entry) => entry.name === "project-tool")
    assert.equal(tools.length, 1, "the local entry, with no command of its own, isn't a server")
    assert.equal(named(mcp, "linear").enabled, false)
    const mcpTarget = { provider: "devin", family: "mcp" as const, cwd: world.project }
    const file = join("home", ".config", "devin", "mcp_config.json")
    const original = await world.read(file)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "linear").id, enabled: true })
    assert.ok(!(await world.read(file)).includes("\"disabled\""))
    assert.match(await world.read(file), /disabledTools/, "per-tool switches stay")
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "linear").id, enabled: false })
    assert.deepEqual(JSON.parse(await world.read(file)), JSON.parse(original))
    assert.ok(await previewEverything(world, mcpTarget, await view(world, "devin", "mcp")) > 0)
    await noHookRan(world)
  } finally { await world.cleanup() }
}

async function grok(): Promise<void> {
  const world = await authoringWorld("grok")
  try {
    const hooks = await view(world, "grok", "hooks")
    assert.deepEqual(hooks.entries.map((entry) => `${entry.name}${entry.enabled ? "" : " (off)"}`).sort(), ["PreToolUse · Bash", "SessionStart", "Stop (off)"])
    const project = hooks.sources.find((source) => source.scope === "project")!
    assert.equal(project.trust?.state, "trusted", "a trusted Git repository's own hooks load")
    const target = { provider: "grok", family: "hooks" as const, cwd: world.project }
    const list = join("home", ".grok", "disabled-hooks")
    const original = await world.read(list)
    await apply(world, target, { kind: "enable", entryId: named(hooks, "SessionStart").id, enabled: false })
    assert.equal(await world.read(list), `${original}global/cmux-session:session_start[0].hooks[0]\n`)
    await apply(world, target, { kind: "enable", entryId: named(hooks, "SessionStart").id, enabled: true })
    assert.equal(await world.read(list), original, "a hook turned off and on leaves disabled-hooks as it was")
    await apply(world, target, { kind: "enable", entryId: named(hooks, "PreToolUse · Bash").id, enabled: false })
    assert.match(await world.read(list), /^project\/checks:pre_tool_use\[0\]\.hooks\[0\]$/m)
    // An untrusted folder's own hooks are shown with the reason Grok skips them.
    await writeFile(join(world.home, ".grok", "trusted_folders.toml"), "")
    assert.equal(sourceOf(await view(world, "grok", "hooks"), project.id).trust?.state, "untrusted")

    const commands = await view(world, "grok", "commands")
    const standups = commands.entries.filter((entry) => entry.name === "/standup")
    assert.equal(standups.length, 2)
    assert.ok(standups.find((entry) => sourceOf(commands, entry.sourceId).scope === "user")?.shadowedBy, "a project command wins over the user's")

    const mcp = await view(world, "grok", "mcp")
    assert.equal(named(mcp, "todoist").enabled, false)
    assert.equal(named(mcp, "wisprflow").enabled, true)
    const mcpTarget = { provider: "grok", family: "mcp" as const, cwd: world.project }
    const config = join("home", ".grok", "config.toml")
    const before = await world.read(config)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "wisprflow").id, enabled: false })
    const off = GrokConfig.parse(parseTomlText(await world.read(config), config))
    assert.deepEqual(off.disabled_mcp_servers, ["todoist", "wisprflow"])
    assert.equal(off.mcp_servers.wisprflow?.enabled, false, "a user server is switched off in both places, as grok mcp disable does")
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "todoist").id, enabled: true })
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "wisprflow").id, enabled: true })
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "todoist").id, enabled: false })
    assert.deepEqual(parseTomlText(await world.read(config), config), parseTomlText(before, config), "servers turned off and on again are as they were, enabled = true included, as grok mcp enable writes it")
    assert.match(await world.read(config), /\[compat\.cursor\]\nhooks = false/)
    assert.ok(await previewEverything(world, mcpTarget, await view(world, "grok", "mcp")) > 0)
    await noHookRan(world)
  } finally { await world.cleanup() }
}

async function openCode(): Promise<void> {
  const world = await authoringWorld("opencode")
  try {
    const plugins = await view(world, "opencode", "hooks")
    assert.equal(plugins.form, "module")
    assert.deepEqual(plugins.entries.map((entry) => entry.name), ["notify.js"])
    const target = { provider: "opencode", family: "hooks" as const, cwd: world.project }
    const projectPlugins = plugins.sources.find((source) => source.scope === "project" && source.path.endsWith("plugins"))!
    await apply(world, target, { kind: "create", sourceId: projectPlugins.id, draft: { kind: "module", name: "guard", text: "export default { id: \"guard\" }\n" } })
    assert.ok((await view(world, "opencode", "hooks")).entries.some((entry) => entry.name === "guard.ts"))

    const commands = await view(world, "opencode", "commands")
    assert.deepEqual(commands.entries.map((entry) => entry.name).sort(), ["/git/pr", "/hello", "/standup"])
    const commandTarget = { provider: "opencode", family: "commands" as const, cwd: world.project }
    const jsonc = join("home", ".config", "opencode", "opencode.jsonc")
    await apply(world, commandTarget, { kind: "edit", entryId: named(commands, "/hello").id, draft: { kind: "command", invocation: "hello", text: "Wave at $ARGUMENTS" } })
    const edited = await world.read(jsonc)
    assert.match(edited, /"template": "Wave at \$ARGUMENTS", "description": "Greets", "agent": "build"/, "a config command keeps its other options in place")
    assert.match(edited, /\/\/ Servers in OpenCode 2's form\./)

    const mcp = await view(world, "opencode", "mcp")
    assert.equal(named(mcp, "docs").enabled, false)
    assert.equal(named(mcp, "legacy").enabled, false, "1.x's enabled: false still reads")
    const mcpTarget = { provider: "opencode", family: "mcp" as const, cwd: world.project }
    const before = await world.read(jsonc)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "docs").id, enabled: true })
    assert.match(await world.read(jsonc), /\/\/ Servers in OpenCode 2's form\./)
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "docs").id, enabled: false })
    assert.deepEqual(parseJsonc(await world.read(jsonc), jsonc), parseJsonc(before, jsonc))
    const legacyFile = join("project", "opencode.json")
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "legacy").id, enabled: true })
    assert.ok(!(await world.read(legacyFile)).includes("\"enabled\""), "a 1.x server is turned on in its own form")
    await apply(world, mcpTarget, { kind: "enable", entryId: named(mcp, "legacy").id, enabled: false })
    assert.equal(JSON.parse(await world.read(legacyFile)).mcp.legacy.enabled, false)
    assert.ok(await previewEverything(world, mcpTarget, await view(world, "opencode", "mcp")) > 0)
    await noHookRan(world)
  } finally { await world.cleanup() }
}

/** The four channels as the socket calls them: arguments parsed with the generated schema, answers encoded. */
async function hostChannels(): Promise<void> {
  const world = await authoringWorld("devin")
  try {
    const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
    declareAuthoringMethods(methods, world.authoring, () => Promise.resolve(world.project))
    const call = async (channel: Parameters<typeof methods.invoke>[0], args: JsonValue[]) => JSON.parse(z.string().parse(await methods.invoke(channel, args, "web", true)))
    const catalog = z.object({ views: z.array(z.object({ provider: z.string() })) }).parse(await call("mako:native-authoring-catalog", []))
    assert.ok(catalog.views.length >= 18)
    const target = { provider: "devin", family: "mcp", cwd: world.project }
    const view = z.object({ entries: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(await call("mako:native-authoring-view", [target]))
    const linear = view.entries.find((entry) => entry.name === "linear")!
    const change = { kind: "enable", entryId: linear.id, enabled: true }
    const plan = z.object({ revision: z.string(), lines: z.array(z.json()) }).parse(await call("mako:native-authoring-preview", [target, change]))
    assert.ok(!JSON.stringify(plan.lines).includes("SECRET-"))
    await call("mako:native-authoring-apply", [target, change, plan.revision])
    await assert.rejects(call("mako:native-authoring-apply", [target, change, "f".repeat(64)]), /changed after the preview/)
    await assert.rejects(methods.invoke("mako:native-authoring-preview", [target, { kind: "enable", entryId: linear.id }], "web", true), "a change missing its fields is refused before the handler")
  } finally { await world.cleanup() }
}

async function safety(): Promise<void> {
  const world = await authoringWorld("claude")
  try {
    const outside = join(world.root, "outside.json")
    await writeFile(outside, "{}\n")
    await symlink(outside, join(world.project, ".mcp.json.link"))
    await mkdir(join(world.project, "elsewhere"))
    const commands = await view(world, "claude", "commands")
    const project = commands.sources.find((source) => source.scope === "project")!
    await symlink(outside, join(project.path, "linked.md"))
    const linked = (await view(world, "claude", "commands")).entries.find((entry) => entry.name === "/linked")!
    await assert.rejects(world.authoring.apply(world.project, { provider: "claude", family: "commands", cwd: world.project }, { kind: "remove", entryId: linked.id }, (await world.authoring.preview(world.project, { provider: "claude", family: "commands", cwd: world.project }, { kind: "remove", entryId: linked.id })).revision), /outside/)
    assert.equal(await readFile(outside, "utf8"), "{}\n")
    await assert.rejects(world.authoring.view(join(world.project, "elsewhere"), { provider: "claude", family: "hooks", cwd: world.project }), /project changed/)
    for (const channel of ["catalog", "view", "preview"]) assert.equal(hostCallReplay(`mako:native-authoring-${channel}`), "read")
    assert.equal(hostCallReplay("mako:native-authoring-apply"), "never", "an apply whose reply was lost is never repeated")
  } finally { await world.cleanup() }
}

function text(): void {
  const toml = "# head\nname = \"x\"\n\n[a]\nlist = [\n  \"one\", # one\n  \"two\",\n]\nkey = \"\"\"\n[not.a.table]\n\"\"\"\n\n[a.b]\nc = 1\n"
  assert.deepEqual(tomlTables(toml, ["a"]).own, { header: 3, body: 11, end: 12 })
  assert.equal(setTomlKey(toml, ["a"], "list", "[\"three\"]").split("\n").slice(3, 6).join("\n"), "[a]\nlist = [\"three\"]\nkey = \"\"\"")
  assert.deepEqual(parseTomlText(removeTomlTables(toml, ["a"]), "fixture"), { name: "x" })
  assert.equal(setTomlKey("[t]\n", [], "top", "1"), "top = 1\n\n[t]\n")
  assert.equal(setTomlKey("x = 1\n", [], "top", "1"), "x = 1\ntop = 1\n")
  assert.match(redactToml("[s.env]\nA = \"SECRET-1\"\n[s]\nheaders = { B = \"SECRET-2\" }\nrun = \"ok\"\n"), /^(?!.*SECRET).*ok/s)
  assert.ok(!redactJson("{\"env\":{\"A\":\"SECRET-3\"},\"x\":{\"apiKey\":\"SECRET-4\"}}").includes("SECRET"))
  assert.deepEqual(diffLines("a\nb\nc\n", "a\nB\nc\n").map((line) => line.kind), ["context", "remove", "add", "context"], "the final newline ends a line; it is no line of its own")
  assert.deepEqual(diffLines("x = 1\n", "x = 1\n\n[t]\ny = 2\n").map((line) => `${line.kind} ${line.text}`), ["context x = 1", "add ", "add [t]", "add y = 2"])
  const spec = (id: string, rank: number) => ({ spec: { id, scope: "user" as const, path: id, root: id, label: id, rank, format: "folder" as const, writable: { supported: true as const } }, text: null, files: [] })
  const order = [spec("u", 0), spec("p", 1)]
  const entries = [{ id: "u#x", sourceId: "u", name: "x", enabled: true }, { id: "p#x", sourceId: "p", name: "x", enabled: true }]
  assert.equal(markShadowed(entries, order, "first")[1]?.shadowedBy, "u#x")
  assert.equal(markShadowed(entries, order, "last")[0]?.shadowedBy, "p#x")
  assert.equal(markShadowed(entries, order, "all").some((entry) => entry.shadowedBy), false)
}

text()
await everyHarness()
await claude()
await codex()
await cursor()
await devin()
await grok()
await openCode()
await safety()
await hostChannels()
console.log("Native authoring: six harnesses' hooks, commands and MCP servers read in their order, changed with comments and unknown keys kept, disabled entries round-tripped, stale previews refused, backups kept out of projects, credentials redacted from every preview, and no hook run")
