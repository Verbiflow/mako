import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk"
import { z } from "zod"
import type { AuthoringChange, AuthoringTarget, AuthoringView, NativeAuthoringFamily } from "@mako/host/contracts/native-authoring"
import type { JsonObject } from "@mako/host/contracts/json"
import { parseJsonc, parseTomlText } from "@mako/host/tools/authoring-text"
import { acpClientCapabilities } from "@mako/host/harnesses/acp-source"
import { acpReadable, acpWritable } from "@mako/host/harnesses/acp-stream"
import { createGrokAcpSource } from "@mako/host/harnesses/grok/acp"
import { codexHookHash, codexHookKey } from "@mako/host/harnesses/codex/authoring"
import { parseHookEntryId } from "@mako/host/tools/authoring-hooks"
import { devinExecutable } from "@mako/host/harnesses/devin/executable"
import { resolveExecutable } from "@mako/host/base/executable"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"
import { openTools } from "@mako/host/tools/index"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { toolHarnesses } from "@mako/host/harnesses/tool-harnesses"
import { cursorProjectSlug } from "@mako/host/harnesses/cursor/authoring"
import { resolveOpenCodeInstallation } from "@mako/host/harnesses/opencode/installation"
import { startOpenCodeApi } from "@mako/host/harnesses/opencode/native-api"
import { awaitOpenCodePlugins } from "@mako/host/harnesses/opencode/catalog"
import { openCodePluginsActivated } from "@mako/host/harnesses/opencode/decoder"
import { OpenCodeServers } from "@mako/host/harnesses/opencode/servers"
import { ProviderLaunchTrace } from "@mako/host/harnesses/provider-launch"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { codexBinary } from "./harness-binaries.ts"
import { authoringWorld, type AuthoringWorld } from "./native-authoring-world.ts"

/**
 * What Mako writes, read back by the harness itself, in scratch homes with
 * no account and no model request:
 *
 * - Codex 0.159: `codex mcp list --json` reads each server's switch as Mako
 *   set it, and the app-server's `hooks/list` gives every hook the key, hash,
 *   trust and switch Mako computed.
 * - Grok 1.0.46: `grok mcp disable` and `enable` write what Mako writes;
 *   `_x.ai/hooks/list` names and switches each hook as Mako does, and a
 *   SessionStart hook Mako adds to a trusted repository runs when a session
 *   opens.
 * - Devin 3000.10: `devin mcp disable` and `enable` write what Mako writes.
 *
 * - Cursor SDK 1.0.31, when `MAKO_LIVE_PROFILE` names a running profile
 *   host (`MAKO_PROFILE=<name> node electron/start.mjs --web`): a real agent
 *   through Mako's Cursor driver, which hands the SDK child the person's API
 *   key as `CURSOR_API_KEY`. Hooks and servers load when an agent's turn
 *   starts, so the leg runs two tiny turns through the host, which holds the
 *   key (`~/.mako/secrets`, opened by the keychain item every profile host
 *   shares), in a scratch repository in the real home: the person's own
 *   `~/.cursor/hooks.json` runs too, and the SDK's `~/.cursor/projects/<slug>`
 *   for the scratch repository is removed after. The project hooks Mako added
 *   run, the server Mako copied into `.cursor/mcp.json` answers, and once Mako
 *   turns it off the SDK never starts it.
 *
 * - OpenCode 2, as installed, in a scratch home: see `opencode()`.
 *
 * Claude Code's discovery and execution of what Mako writes are
 * `test-native-authoring-claude.ts`.
 */

const run = promisify(execFile)

async function view(world: AuthoringWorld, provider: string, family: NativeAuthoringFamily): Promise<AuthoringView> {
  return world.authoring.view(world.project, { provider, family, cwd: world.project })
}

async function apply(world: AuthoringWorld, target: AuthoringTarget, change: AuthoringChange): Promise<void> {
  const plan = await world.authoring.preview(world.project, target, change)
  await world.authoring.apply(world.project, target, change, plan.revision)
}

function entry(current: AuthoringView, name: string, scope?: string) {
  const found = current.entries.find((candidate) => candidate.name === name && (!scope || current.sources.find((source) => source.id === candidate.sourceId)?.scope === scope))
  assert.ok(found, `${current.provider} ${current.family} has ${name}`)
  return found
}

const CodexServers = z.array(z.object({ name: z.string(), enabled: z.boolean() }))
const CodexHooks = z.object({ data: z.array(z.object({ hooks: z.array(z.object({ key: z.string(), currentHash: z.string(), trustStatus: z.string(), enabled: z.boolean(), sourcePath: z.string() })) })) })

/** One JSON-RPC exchange with `codex app-server`, in the scratch home. */
async function codexAppServer(binary: string, world: AuthoringWorld, method: string, params: JsonObject): Promise<JsonObject> {
  const child = spawn(binary, ["app-server"], { cwd: world.project, env: { PATH: process.env.PATH, HOME: world.home, CODEX_HOME: join(world.home, ".codex") }, stdio: ["pipe", "pipe", "ignore"] })
  const replies = new Map<number, (value: JsonObject) => void>()
  let buffer = ""
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const message = z.object({ id: z.number().optional(), result: z.record(z.string(), z.json()).optional(), error: z.json().optional() }).safeParse(JSON.parse(line))
      if (message.success && message.data.id !== undefined) replies.get(message.data.id)?.(message.data.result ?? { error: message.data.error ?? null })
    }
  })
  const call = (id: number, name: string, body: JsonObject) => new Promise<JsonObject>((resolve, reject) => {
    replies.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ id, method: name, params: body })}\n`)
    setTimeout(() => reject(new Error(`codex app-server didn't answer ${name}`)), 20_000).unref()
  })
  try {
    await call(1, "initialize", { clientInfo: { name: "mako-authoring-test", version: "0" }, capabilities: { experimentalApi: true } })
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
    return await call(2, method, params)
  } finally { child.kill("SIGTERM") }
}

async function codex(): Promise<string> {
  const binary = await codexBinary()
  if (!binary) return "Codex: skipped, codex is not installed"
  const world = await authoringWorld("codex")
  try {
    const hooks = { provider: "codex", family: "hooks" as const, cwd: world.project }
    const mcp = { provider: "codex", family: "mcp" as const, cwd: world.project }
    await apply(world, hooks, { kind: "trust", entryId: entry(await view(world, "codex", "hooks"), "SessionStart").id })
    await apply(world, hooks, { kind: "enable", entryId: entry(await view(world, "codex", "hooks"), "PreToolUse · Bash").id, enabled: false })
    await apply(world, hooks, { kind: "create", sourceId: (await view(world, "codex", "hooks")).sources[0]!.id, draft: { kind: "hook", event: "Stop", matcher: "x", type: "command", run: "true", timeout: 7 } })
    await apply(world, mcp, { kind: "enable", entryId: entry(await view(world, "codex", "mcp"), "node_repl").id, enabled: false })
    await apply(world, mcp, { kind: "enable", entryId: entry(await view(world, "codex", "mcp"), "computer-use").id, enabled: true })

    const listed = CodexServers.parse(JSON.parse((await run(binary, ["mcp", "list", "--json"], { cwd: world.project, env: { PATH: process.env.PATH, HOME: world.home, CODEX_HOME: join(world.home, ".codex") } })).stdout))
    const mine = await view(world, "codex", "mcp")
    for (const server of listed) {
      const own = mine.entries.filter((candidate) => candidate.name === server.name)
      assert.ok(own.length, `Mako reads ${server.name}`)
      assert.equal(own.at(-1)?.enabled, server.enabled, `Codex and Mako agree whether ${server.name} is on`)
    }
    assert.deepEqual(new Set(listed.map((server) => server.name)), new Set(mine.entries.map((candidate) => candidate.name)))

    const native = CodexHooks.parse(await codexAppServer(binary, world, "hooks/list", { cwds: [world.project] })).data.flatMap((group) => group.hooks)
    const current = await view(world, "codex", "hooks")
    const ours = current.entries.filter((candidate) => current.sources.find((source) => source.id === candidate.sourceId)?.scope !== "managed")
    assert.equal(native.length, ours.length, "Codex lists every hook Mako reads")
    for (const hook of native) {
      const match = ours.find((candidate) => {
        const address = parseHookEntryId(candidate.id)
        return codexHookKey(current.sources.find((source) => source.id === candidate.sourceId)!.path, address) === hook.key
      })
      assert.ok(match, `Mako files ${hook.key} under the key Codex uses`)
      const raw: JsonObject = { type: "command", command: match.hook!.run }
      if (match.hook!.timeout !== undefined) raw.timeout = match.hook!.timeout
      if (match.hook!.other.length) continue
      assert.equal(codexHookHash(match.hook!.event, match.hook!.matcher, raw), hook.currentHash, `Mako hashes ${hook.key} as Codex does`)
      assert.equal(match.trust?.state, hook.trustStatus, `Codex and Mako agree on ${hook.key}'s trust`)
      assert.equal(match.enabled, hook.enabled, `Codex and Mako agree whether ${hook.key} is on`)
    }
    return `Codex: mcp list reads ${listed.length} servers' switches as Mako wrote them; hooks/list agrees on the key, hash, trust and switch of ${native.length} hooks`
  } finally { await world.cleanup() }
}

/** `grok mcp <verb>` in a world, as the person would run it. */
async function grokCli(world: AuthoringWorld, args: string[]): Promise<void> {
  await run("grok", args, { cwd: world.project, env: { PATH: process.env.PATH, HOME: world.home, GROK_HOME: join(world.home, ".grok"), GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1" } })
}

const HookList = z.object({ result: z.object({ hooks: z.array(z.object({ name: z.string(), disabled: z.boolean(), sourceDir: z.string().nullable() })), projectTrusted: z.boolean() }) })

async function grokHooks(world: AuthoringWorld): Promise<z.infer<typeof HookList>["result"]> {
  const source = createGrokAcpSource()
  const models = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
  })
  await new Promise<void>((listening) => models.listen(0, "127.0.0.1", listening))
  const port = z.object({ port: z.number() }).parse(models.address()).port
  const config = join(world.home, ".grok", "config.toml")
  const original = await readFile(config, "utf8")
  await writeFile(config, `[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n\n${original}`)
  const env = { PATH: process.env.PATH, HOME: world.home, GROK_HOME: join(world.home, ".grok"), GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1", MAKO_FIXTURE_MARKER: world.marker }
  const launch = await source.launch({ appPath: "/app", execPath: process.execPath, cwd: world.project, env, access: "ask" })
  assert.ok(launch)
  const child = spawn(launch.command, launch.args, { cwd: world.project, env, stdio: ["pipe", "pipe", "ignore"] })
  const client: Client = {
    requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: () => Promise.resolve(),
    extNotification: () => Promise.resolve(),
    extMethod: () => Promise.resolve({ outcome: "cancelled" }),
  }
  const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(source) })
    const session = await connection.newSession({ cwd: world.project, mcpServers: [] })
    await delay(1_500)
    return HookList.parse(await connection.extMethod("_x.ai/hooks/list", { sessionId: session.sessionId })).result
  } finally {
    child.kill("SIGTERM")
    models.close()
    await writeFile(config, original)
  }
}

async function grok(): Promise<string> {
  if (!resolveExecutable("grok", process.env)) return "Grok: skipped, grok is not installed"
  const ours = await authoringWorld("grok")
  const theirs = await authoringWorld("grok")
  try {
    const mcp = { provider: "grok", family: "mcp" as const, cwd: ours.project }
    await apply(ours, mcp, { kind: "enable", entryId: entry(await view(ours, "grok", "mcp"), "wisprflow").id, enabled: false })
    await apply(ours, mcp, { kind: "enable", entryId: entry(await view(ours, "grok", "mcp"), "todoist").id, enabled: true })
    await grokCli(theirs, ["mcp", "disable", "wisprflow"])
    await grokCli(theirs, ["mcp", "enable", "todoist"])
    const config = join("home", ".grok", "config.toml")
    assert.deepEqual(parseTomlText(await ours.read(config), config), parseTomlText(await theirs.read(config), config), "Mako's switches write what grok mcp disable and enable write")

    const hooks = { provider: "grok", family: "hooks" as const, cwd: ours.project }
    await apply(ours, hooks, { kind: "enable", entryId: entry(await view(ours, "grok", "hooks"), "PreToolUse · Bash").id, enabled: false })
    const project = (await view(ours, "grok", "hooks")).sources.find((source) => source.scope === "project")!
    await apply(ours, hooks, { kind: "create", sourceId: project.id, draft: { kind: "hook", event: "SessionStart", type: "command", run: "touch \"$MAKO_FIXTURE_MARKER/grok-authored-session-start\"" } })
    assert.deepEqual(await readdir(ours.marker), [], "nothing Mako did ran a hook")
    const listed = await grokHooks(ours)
    assert.equal(listed.projectTrusted, true)
    const mine = await view(ours, "grok", "hooks")
    for (const hook of listed.hooks) {
      const off = mine.entries.find((candidate) => !candidate.enabled && hook.name.includes(candidate.hook!.event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()) && hook.name.startsWith(candidate.sourceId.startsWith("project:") ? "project/" : "global/"))
      assert.equal(hook.disabled, Boolean(off), `Grok and Mako agree whether ${hook.name} is on`)
    }
    assert.ok(listed.hooks.some((hook) => hook.name === "project/checks:pre_tool_use[0].hooks[0]" && hook.disabled), "the hook Mako turned off is off by the name Mako wrote")
    assert.ok((await readdir(ours.marker)).includes("grok-authored-session-start"), "Grok ran the SessionStart hook Mako added to the trusted repository")
    return `Grok: mcp disable/enable write what Mako writes; _x.ai/hooks/list agrees on ${listed.hooks.length} hooks' names and switches, and ran the hook Mako added`
  } finally { await ours.cleanup(); await theirs.cleanup() }
}

async function devin(): Promise<string> {
  const binary = devinExecutable()
  if (!binary) return "Devin: skipped, Devin is not installed"
  const ours = await authoringWorld("devin")
  const theirs = await authoringWorld("devin")
  try {
    const mcp = { provider: "devin", family: "mcp" as const, cwd: ours.project }
    await apply(ours, mcp, { kind: "enable", entryId: entry(await view(ours, "devin", "mcp"), "linear").id, enabled: true })
    await apply(ours, mcp, { kind: "enable", entryId: entry(await view(ours, "devin", "mcp"), "project-tool", "project").id, enabled: false })
    const env = { PATH: process.env.PATH, HOME: theirs.home }
    await run(binary, ["mcp", "enable", "-s", "user", "linear"], { cwd: theirs.project, env })
    await run(binary, ["mcp", "disable", "-s", "project", "project-tool"], { cwd: theirs.project, env })
    for (const file of [join("home", ".config", "devin", "mcp_config.json"), join("project", ".devin", "mcp_config.json")])
      assert.deepEqual(parseJsonc(await ours.read(file), file), parseJsonc(await theirs.read(file), file), `Mako's switch in ${file} is what devin mcp writes`)
    return "Devin: mcp enable and disable write what Mako writes, in the user and the project file"
  } finally { await ours.cleanup(); await theirs.cleanup() }
}

const CursorBlock = z.object({ type: z.string(), title: z.string().optional(), output: z.json().optional(), text: z.string().optional() })
type CursorBlock = z.infer<typeof CursorBlock>
const CursorSnapshot = z.object({
  session: z.object({ status: z.string(), error: z.string().optional() }),
  requests: z.array(z.object({ id: z.string(), status: z.string() })),
  blocks: z.array(CursorBlock),
})
const CursorModels = z.object({ models: z.array(z.object({ id: z.string() })) })

/** An MCP server whose one tool answers `token`; each start adds a line to `starts`, its first argument or "started". */
async function writeProbeServer(path: string, starts: string, token: string): Promise<void> {
  await writeFile(path, [
    `import { appendFileSync } from "node:fs"`,
    `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))}`,
    `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))}`,
    `appendFileSync(${JSON.stringify(starts)}, (process.argv[2] ?? "started") + "\\n")`,
    `const server = new McpServer({ name: "makoprobe", version: "1.0.0" })`,
    `server.registerTool("mako_probe", { description: "Returns a fixed marker.", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async () => ({ content: [{ type: "text", text: ${JSON.stringify(token)} }] }))`,
    `await server.connect(new StdioServerTransport())`,
  ].join("\n"))
}

/**
 * OpenCode 2, as installed, against its recorded config shapes in a scratch
 * home whose own servers are all off. Mako removes the recorded plugin and
 * adds one that marks its loading, adds a project command, and of three
 * project servers turns one off and removes another. The server Mako's driver
 * starts (`startOpenCodeApi`) then loads that plugin, lists every command
 * Mako reads, and connects only the server Mako left on, each of the others
 * named off as Mako names it.
 */
async function opencode(): Promise<string> {
  const installation = await resolveOpenCodeInstallation(process.env).catch(() => undefined)
  if (!installation) return "OpenCode: skipped, OpenCode 2 is not installed"
  const world = await authoringWorld("opencode")
  const starts = join(world.marker, "server-starts"), loaded = join(world.marker, "plugin-loaded")
  const server = join(world.root, "probe.mjs")
  await writeProbeServer(server, starts, "MAKO-AUTHORING-OPENCODE")
  const local = (name: string) => ({ type: "local", command: [process.execPath, server, name] })
  await writeFile(join(world.project, ".opencode", "opencode.jsonc"), JSON.stringify({ mcp: { servers: { kept: local("kept"), switched: local("switched"), removed: local("removed") } } }, null, 2))
  const env = {
    PATH: process.env.PATH, HOME: world.home, XDG_CONFIG_HOME: join(world.home, ".config"), XDG_DATA_HOME: join(world.home, ".local", "share"),
    XDG_STATE_HOME: join(world.home, ".local", "state"), XDG_CACHE_HOME: join(world.home, ".cache"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
  try {
    const hooks = { provider: "opencode", family: "hooks" as const, cwd: world.project }
    const commands = { provider: "opencode", family: "commands" as const, cwd: world.project }
    const mcp = { provider: "opencode", family: "mcp" as const, cwd: world.project }
    await apply(world, hooks, { kind: "remove", entryId: entry(await view(world, "opencode", "hooks"), "notify.js").id })
    const plugins = (await view(world, "opencode", "hooks")).sources.find((source) => source.scope === "project" && source.path.endsWith("plugins"))!
    await apply(world, hooks, { kind: "create", sourceId: plugins.id, draft: { kind: "module", name: "mako-probe.js", text: `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(loaded)}, "loaded\\n")\nexport const MakoProbe = async () => ({})\n` } })
    const folder = (await view(world, "opencode", "commands")).sources.find((source) => source.scope === "project" && source.path.endsWith(join(".opencode", "commands")))!
    await apply(world, commands, { kind: "create", sourceId: folder.id, draft: { kind: "command", invocation: "mako-live", text: "---\ndescription: Written by Mako\n---\nSummarize $ARGUMENTS.\n" } })
    await apply(world, mcp, { kind: "enable", entryId: entry(await view(world, "opencode", "mcp"), "switched").id, enabled: false })
    await apply(world, mcp, { kind: "remove", entryId: entry(await view(world, "opencode", "mcp"), "removed").id })
    assert.deepEqual(await readdir(world.marker), [], "nothing Mako did loaded a plugin or started a server")

    const api = await startOpenCodeApi({ servers: new OpenCodeServers(), command: installation.command, cwd: world.project, env, conversationId: randomUUID(),
      trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "native-authoring-live" }, { report() {} }) })
    const stream = new AbortController()
    try {
      const location = { directory: world.project }
      // As the driver does: the folder's config is read once its plugins are active.
      const events = api.client.event.subscribe({ signal: AbortSignal.any([stream.signal, api.signal]) })[Symbol.asyncIterator]()
      assert.equal((await events.next()).value?.type, "server.connected")
      const activated = (async () => {
        for (let next = await events.next(); !next.done; next = await events.next()) if (openCodePluginsActivated(next.value, world.project)) return
      })()
      await awaitOpenCodePlugins(api.client, world.project, activated, api.signal)
      let servers = (await api.client.mcp.list({ location })).data
      for (const deadline = Date.now() + 30_000; servers.some((listed) => listed.status.status === "pending"); await delay(200)) {
        assert.ok(Date.now() < deadline, "OpenCode settled its servers within 30 seconds")
        servers = (await api.client.mcp.list({ location })).data
      }
      const mine = await view(world, "opencode", "mcp")
      assert.deepEqual(new Set(servers.map((listed) => listed.name)), new Set(mine.entries.map((candidate) => candidate.name)), "OpenCode lists the servers Mako reads")
      for (const listed of servers) {
        const own = mine.entries.filter((candidate) => candidate.name === listed.name).at(-1)!
        assert.equal(listed.status.status === "disabled", !own.enabled, `OpenCode and Mako agree whether ${listed.name} is on`)
      }
      assert.equal(servers.find((listed) => listed.name === "kept")?.status.status, "connected")
      assert.deepEqual((await readFile(starts, "utf8")).split("\n").filter(Boolean), ["kept"], "OpenCode started only the server Mako left on")

      const listed = (await api.client.command.list({ location })).data
      const written = (await view(world, "opencode", "commands")).entries
      for (const command of written) assert.ok(listed.some((native) => native.name === command.name.replace(/^\//, "")), `OpenCode lists ${command.name}`)
      assert.equal(listed.find((native) => native.name === "mako-live")?.description, "Written by Mako")
      assert.ok(existsSync(loaded), "OpenCode loaded the plugin Mako added")
      return `OpenCode ${api.info.version}: loaded the plugin Mako added, lists the ${written.length} commands Mako reads, and of ${servers.length} servers connected only the one Mako left on, agreeing on each switch`
    } finally { stream.abort(); await api.close() }
  } finally { await world.cleanup() }
}

/** A running profile host, called as the renderer calls it; each answer is parsed where it arrives. */
function profileHost(socket: string) {
  const client = randomUUID()
  return {
    send: async (channel: string, ...args: unknown[]): Promise<void> => { await invokeRuntime(socket, client, channel, args) },
    read: async <T>(schema: z.ZodType<T>, channel: string, ...args: unknown[]): Promise<T> => schema.parse(await invokeRuntime(socket, client, channel, args)),
  }
}
type ProfileHost = ReturnType<typeof profileHost>

interface LiveStart { conversationId: string; title: string; tuning?: { model: string } }

/** One conversation's one turn through the profile host, closed after; its blocks. */
async function cursorTurn(host: ProfileHost, cwd: string, model: string | undefined, text: string): Promise<CursorBlock[]> {
  const id = randomUUID(), request = randomUUID()
  const start: LiveStart = { conversationId: id, title: "Native authoring live check" }
  if (model) start.tuning = { model }
  await host.send("mako:live-start", "cursor", cwd, start)
  try {
    let sent = false
    for (const deadline = Date.now() + 240_000; ; await delay(300)) {
      assert.ok(Date.now() < deadline, "Cursor answered within four minutes")
      const state = await host.read(CursorSnapshot, "mako:live-snapshot", id)
      assert.notEqual(state.session.status, "error", state.session.error)
      if (!sent && state.session.status === "ready") {
        await host.send("mako:live-prompt", id, request, text)
        sent = true
      }
      const item = state.requests.find((candidate) => candidate.id === request)
      if (item && !["queued", "held", "dispatching"].includes(item.status)) {
        assert.equal(item.status, "completed", `the Cursor turn ended ${item.status}`)
        return state.blocks
      }
    }
  } finally { await host.send("mako:live-close", id) }
}

async function cursor(): Promise<string> {
  const profile = process.env.MAKO_LIVE_PROFILE
  if (!profile) return "Cursor: skipped, MAKO_LIVE_PROFILE doesn't name a running profile host, which holds the Cursor API key the agent runs under"
  const { socket } = runtimeLocation(runtimeDataRoot(appDataFolder(), { MAKO_PROFILE: profile }))
  if (!existsSync(socket)) return `Cursor: skipped, profile ${profile} has no running host`
  const host = profileHost(socket)
  const models = (await host.read(CursorModels, "mako:harness-tuning", "cursor")).models.map((candidate) => candidate.id)
  const model = process.env.MAKO_LIVE_CURSOR_MODEL ?? ["gemini-3.8-flash", "composer-2.5"].find((id) => models.includes(id))
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-authoring-cursor-live-")))
  const project = join(root, "project"), marker = join(root, "marker"), state = join(homedir(), ".cursor", "projects", cursorProjectSlug(project))
  await Promise.all([mkdir(project), mkdir(marker)])
  await run("git", ["init", "-q", project])
  const token = `MAKO-AUTHORING-${randomUUID().slice(0, 8)}`
  const server = join(root, "probe.mjs")
  await writeProbeServer(server, join(marker, "server-starts"), token)
  // The real home, as Mako's host reads it, with backups kept in the scratch folder.
  const tools = openTools(toolHarnesses(createHarnessHost(detachedHarnessContext(new NativeStores(false)))), join(root, "backups"))
  const act = async (target: AuthoringTarget, change: AuthoringChange) => tools.authoring.apply(project, target, change, (await tools.authoring.preview(project, target, change)).revision)
  try {
    const hooks = { provider: "cursor", family: "hooks" as const, cwd: project }
    const source = (await tools.authoring.view(project, hooks)).sources.find((candidate) => candidate.scope === "project")!
    assert.equal(source.path, join(project, ".cursor", "hooks.json"))
    for (const event of ["sessionStart", "beforeMCPExecution", "stop"])
      await act(hooks, { kind: "create", sourceId: source.id, draft: { kind: "hook", event, type: "command", run: `touch ${JSON.stringify(join(marker, event))}${event.startsWith("before") ? ` && echo '{"permission":"allow"}'` : ""}` } })
    // Cursor's family copies a server in from another agent: here from the project's Claude Code `.mcp.json`, which then goes.
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { makoprobe: { command: process.execPath, args: [server] } } }))
    const snapshot = await tools.mcp.discover(project)
    const probe = snapshot.servers.find((candidate) => candidate.name === "makoprobe")!
    const target = { provider: "cursor" as const, account: snapshot.providers.find((candidate) => candidate.id === "cursor")!.account, scope: "workspace" as const }
    assert.equal((await tools.mcpSync.preview(snapshot, probe.id, target)).action, "add")
    await tools.mcpSync.apply(snapshot, probe.id, target)
    await rm(join(project, ".mcp.json"))
    assert.ok(existsSync(join(project, ".cursor", "mcp.json")))
    assert.deepEqual(await readdir(marker), [], "nothing Mako did ran a hook or started the server")

    const blocks = await cursorTurn(host, project, model, "Call the MCP tool mako_probe from the makoprobe server once, then reply with only the exact text it returned.")
    const used = blocks.find((block) => block.type === "tool" && block.title === "makoprobe: mako_probe")
    assert.equal(used?.output, token, "the server Mako copied into .cursor/mcp.json answered")
    assert.deepEqual((await readdir(marker)).sort(), ["beforeMCPExecution", "server-starts", "sessionStart", "stop"], "Cursor ran the project hooks Mako added")

    const mcp = { provider: "cursor", family: "mcp" as const, cwd: project }
    await act(mcp, { kind: "enable", entryId: entry(await tools.authoring.view(project, mcp), "makoprobe", "project").id, enabled: false })
    assert.deepEqual(JSON.parse(await readFile(join(state, "mcp-disabled.json"), "utf8")), ["makoprobe"])
    const after = await cursorTurn(host, project, model, "If an MCP tool named mako_probe is available, call it once and reply with its output. Otherwise call no tool and reply with exactly: NO_MAKO_PROBE")
    assert.ok(!after.some((block) => block.type === "tool" && block.title?.startsWith("makoprobe")), "a server Mako turned off isn't offered")
    assert.equal((await readFile(join(marker, "server-starts"), "utf8")).split("\n").filter(Boolean).length, 1, "Cursor didn't start the server Mako turned off")
    return `Cursor: with ${model ?? "the host's default model"}, the SDK ran the project hooks Mako added, called the server Mako copied into .cursor/mcp.json, and left it unstarted once Mako turned it off`
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  }
}

// `tsx scripts/test-native-authoring-live.ts opencode cursor` runs only those legs.
const chosen = process.argv.slice(2)
for (const check of [codex, grok, devin, opencode, cursor]) if (!chosen.length || chosen.includes(check.name)) console.log(await check())
