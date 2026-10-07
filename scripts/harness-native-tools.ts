import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import type { Duplex } from "node:stream"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"
import { z } from "zod"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { resolveExecutable } from "../electron/executable.ts"
import { ProviderLaunchTrace } from "../electron/provider-launch.ts"
import { providerHost } from "../electron/providers/index.ts"
import { claudeSdkOptions } from "../electron/providers/claude/sdk-options.ts"
import { resolveCodexExecutable } from "../electron/providers/codex/executable.ts"
import { codexCollaborationMode, codexInteractiveConfig } from "../electron/providers/codex/settings.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { openCodeAgentForMode, openCodeLaunchAccess } from "../electron/providers/opencode/access.ts"
import { resolveOpenCodeInstallation } from "../electron/providers/opencode/installation.ts"
import { openCodeMessageId } from "../electron/providers/opencode/live-driver.ts"
import { startOpenCodeApi } from "../electron/providers/opencode/native-api.ts"
import { configureOpenCodePermissions } from "../electron/providers/opencode/permissions.ts"
import {
  compareVersions, definedTools, definitionsPath, diffDefinitions, NativeDefinitions, storedDefinitions,
  NATIVE_TOOLS_DIR, type Configuration, type DefinedTools, type Parameter, type Wire,
} from "./native-tools.ts"
import { RpcMessage, rpcPeer, sandboxed as sandboxedIn, stop, strayStores, type Sandbox } from "./harness-sandbox.ts"

/**
 * Records each harness's tools as it defines them to its model.
 *
 *   npm run harness:native-tools -- claude codex grok opencode
 *   npm run harness:native-tools -- --diff codex 0.159.3 0.160.0
 *   npm run harness:native-tools -- --keep /tmp/requests claude
 *
 * Each harness runs the way Mako launches it, through Mako's own option
 * builders and launch arguments, once per mode (and for Codex, per model),
 * sealed in a throwaway home with its model endpoint pointed at a local
 * server that keeps every request and refuses it. No account is used and no
 * model is called; a harness that answers anyway reached a real model, and
 * the run stops without writing. The tools of the first request that carries
 * them are written to `fixtures/native-tools/<harness>-<version>.json`
 * with what changed since the previous stored version. `--keep <dir>` also
 * writes every request the endpoint received, whole, for reading what else
 * the harness sent.
 *
 * Cursor's model sits behind its own service, so its tools come from the
 * tool-call schema its SDK reports them in: the arguments Mako receives, not
 * the definitions its model sees. Devin's requests are protobuf to the
 * Windsurf API, and it sends none to its model until its account and model
 * configuration calls are answered, so it has no source here yet.
 */

const run = promisify(execFile)
const CAPTURE_KEY = "mako-native-tools-capture"
const REFUSAL = "Mako's native-tools capture refuses every model request"
const CAPTURE_MS = 60_000

const args = process.argv.slice(2)
const keepAt = args.indexOf("--keep")
const keepDir = keepAt === -1 ? undefined : args.splice(keepAt, 2)[1]
let kept = 0

class ReachedRealModel extends Error {
  constructor(harness: string) {
    super(`${harness} answered, so it reached a real model instead of the capture endpoint; nothing was written`)
  }
}

/** A model request's body, as far as finding its tools needs. */
const RequestBody = z.object({ tools: z.array(z.unknown()).optional(), input: z.array(z.unknown()).optional(), messages: z.array(z.unknown()).optional() }).loose()
type RequestBody = z.infer<typeof RequestBody>

/** Every request the endpoint received; `body` when it was a JSON object. */
interface Captured { path: string; text: string; body?: RequestBody }
interface ToolRequest { tools: unknown[]; body: RequestBody }

const AdditionalTools = z.object({ type: z.literal("additional_tools"), tools: z.array(z.unknown()) }).loose()

/** A model request's tools: the `tools` field, or Codex's `additional_tools` input item. A request with one tool, counted inside namespaces, is a title or summary call. */
function requestTools(body: RequestBody): unknown[] | undefined {
  const extra = (body.input ?? []).flatMap((item) => {
    const tools = AdditionalTools.safeParse(item)
    return tools.success ? tools.data.tools : []
  })
  const tools = [...body.tools ?? [], ...extra]
  return leafCount(tools) > 1 ? tools : undefined
}

const Grouped = z.object({ tools: z.array(z.unknown()) }).loose()
/** Tools counted inside the namespace groups that hold them. */
const leafCount = (tools: unknown[]): number => tools.reduce<number>((count, tool) => {
  const group = Grouped.safeParse(tool)
  return count + (group.success ? leafCount(group.data.tools) : 1)
}, 0)

/** A request's path and shape, without its content. */
function outline({ path, text, body }: Captured): string {
  if (!body) return `${path} (not a JSON object, ${text.length} characters)`
  const items = (body.input ?? []).map((item) => {
    const extra = AdditionalTools.safeParse(item)
    return extra.success ? `additional_tools of ${leafCount(extra.data.tools)}` : z.object({ type: z.string() }).loose().safeParse(item).data?.type ?? "?"
  })
  return `${path} {${Object.keys(body).join(", ")}}${items.length ? ` input [${items.join(", ")}]` : ""}`
}

/** The first complete text message on a WebSocket, then a policy-violation close. */
function firstWebSocketMessage(request: IncomingMessage, socket: Duplex, keep: (text: string) => void): void {
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  let buffer = Buffer.alloc(0)
  const parts: Buffer[] = []
  socket.on("error", () => socket.destroy())
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const final = (buffer[0]! & 0x80) !== 0
      const opcode = buffer[0]! & 0x0f
      let length = buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (buffer[1]! & 0x80) !== 0
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (mask) for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!
      buffer = buffer.subarray(offset + length)
      if (opcode === 8) return void socket.destroy()
      if (opcode !== 0 && opcode !== 1) continue
      parts.push(payload)
      if (!final) continue
      keep(Buffer.concat(parts).toString("utf8"))
      const reason = Buffer.from(REFUSAL.slice(0, 120))
      socket.end(Buffer.concat([Buffer.from([0x88, reason.length + 2, 0x03, 0xf0]), reason]))
      return
    }
  })
}

/** A stand-in for a model provider: keeps every request and refuses it, except GETs whose path starts with a key of `answers`, answered with its JSON. */
async function modelEndpoint(answers: ReadonlyMap<string, string> = new Map()) {
  const requests: Captured[] = []
  const listeners = new Set<() => void>()
  const keep = (path: string, text: string) => {
    let json: unknown
    try { json = JSON.parse(text) } catch { json = undefined }
    requests.push({ path, text, body: RequestBody.safeParse(json).data })
    if (keepDir) void mkdir(keepDir, { recursive: true }).then(() => writeFile(join(keepDir, `${String(++kept).padStart(3, "0")}.json`), JSON.stringify({ path, body: json ?? text }, null, 2)))
    for (const listener of listeners) listener()
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const path = request.url ?? "/"
      const answer = request.method === "GET" ? [...answers].find(([prefix]) => path.startsWith(prefix))?.[1] : undefined
      response.setHeader("content-type", "application/json")
      if (answer !== undefined) return void response.end(answer)
      const raw = Buffer.concat(chunks)
      keep(`${request.method} ${path}`, (request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"))
      response.statusCode = 400
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: REFUSAL } }))
    })
  })
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => firstWebSocketMessage(request, socket, (text) => keep(`WS ${request.url}`, text)))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port reports its address as an AddressInfo.
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    /** The first request that carries tools, and its tools. */
    tools: () => new Promise<ToolRequest>((resolve, reject) => {
      const check = () => {
        for (const { body } of requests) {
          const tools = body && requestTools(body)
          if (tools && body) return void (done(), resolve({ tools, body }))
        }
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`no model request with tools within ${CAPTURE_MS / 1000}s; ${requests.length} other requests: ${requests.map(outline).join("; ")}`))
      }, CAPTURE_MS)
      const done = () => { clearTimeout(timer); listeners.delete(check) }
      listeners.add(check)
      check()
    }),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
type ModelEndpoint = Awaited<ReturnType<typeof modelEndpoint>>

const SANDBOX = "mako-native-tools"
const sandboxed = <T>(harness: string, work: (sandbox: Sandbox) => Promise<T>) => sandboxedIn(SANDBOX, harness, work)

const emptyMcp = (cwd: string) => async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] })
const trace = (provider: string) => new ProviderLaunchTrace({ provider, conversation: "native-tools" })

/** A peer that refuses every request the child makes and hears its notifications. */
const refusingPeer = (child: ChildProcessWithoutNullStreams, jsonrpc: boolean, notified: (message: RpcMessage) => void) =>
  rpcPeer(child, { jsonrpc, timeoutMs: CAPTURE_MS, refusal: REFUSAL, received: (message) => { if (message.id === undefined) notified(message) } })

/** The model request's tools, unless the harness reaches a real model or gives up first. */
async function captured(harness: string, endpoint: ModelEndpoint, running: Promise<unknown>): Promise<ToolRequest> {
  return Promise.race([
    endpoint.tools(),
    running.then(() => { throw new Error(`${harness} stopped before calling the model`) }),
  ])
}

interface Captures {
  version: string
  source: string
  configurations: Configuration[]
}

const ClaudeMessages = z.array(z.object({
  content: z.union([z.string().transform((text) => [{ text }]), z.array(z.object({ text: z.string().optional() }).loose())]),
}).loose())
const DEFERRED_LIST = /The following deferred tools are now available via ToolSearch\.[^\n]*:\n((?:[^\s\n]+\n)+)/

/** The tools Claude Code names to its model for loading through ToolSearch, without their schemas. */
function deferredTools(body: RequestBody): string[] {
  const text = ClaudeMessages.parse(body.messages)
    .flatMap((message) => message.content.map((block) => block.text ?? ""))
    .join("\n")
  const list = DEFERRED_LIST.exec(text)?.[1]
  if (!list) throw new Error("Claude Code deferred tools, but its request no longer lists them in the words this capture reads")
  return list.trim().split("\n")
}

/** One Claude Code request, launched as Mako's SDK driver launches it in `modeId`. */
async function claudeRequest(modeId: string, toolSearch: boolean, reported: (version: string) => void) {
  return sandboxed("claude", async (sandbox) => {
    const endpoint = await modelEndpoint()
    // The SDK's build finds its config folder without HOME, and with it the person's login: the folder is named outright.
    const env = {
      ...sandbox.env, CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: endpoint.url, ANTHROPIC_API_KEY: CAPTURE_KEY,
      ENABLE_TOOL_SEARCH: String(toolSearch),
    }
    const { options } = await claudeSdkOptions(sandbox.project, {
      conversationId: randomUUID(), modeId, mcpSnapshot: emptyMcp(sandbox.project),
      accountLaunch: { env, account: { name: "default" }, selection: { kind: "unavailable" } },
    }, trace("claude"))
    const abort = new AbortController()
    const running = (async () => {
      // Like Mako's driver: input streamed, and a permission and elicitation handler, without which Claude Code leaves out the tools that ask.
      const prompt = (async function* () {
        yield { type: "user" as const, message: { role: "user" as const, content: "hi" }, parent_tool_use_id: null }
        await new Promise((resolve) => abort.signal.addEventListener("abort", resolve))
      })()
      const refuse = { canUseTool: async () => ({ behavior: "deny" as const, message: REFUSAL }), onElicitation: async () => ({ action: "decline" as const }) }
      for await (const message of query({ prompt, options: { ...options, ...refuse, abortController: abort } })) {
        if (message.type === "system" && message.subtype === "init") reported(message.claude_code_version)
        if (message.type === "assistant" && message.error === undefined && !JSON.stringify(message.message.content).includes(REFUSAL))
          throw new ReachedRealModel("Claude Code")
      }
    })()
    try {
      const { tools, body } = await captured("Claude Code", endpoint, running)
      return { tools: definedTools("anthropic", tools, sandbox.scrub), body }
    } finally {
      abort.abort()
      await running.catch(() => {})
      await endpoint.close()
    }
  })
}

/**
 * Against Anthropic's own host, as Mako's sessions run, tool search is on:
 * the request carries some tools whole and names the rest, whose schemas
 * load through ToolSearch. A second run with it off carries every schema.
 */
async function claudeDefinitions(): Promise<Captures> {
  const driver = providerHost.liveDrivers.get("claude")!
  const configurations: Configuration[] = []
  let version: string | undefined
  const reported = (reportedVersion: string) => { version = reportedVersion }
  for (const mode of driver.modes ?? []) {
    const searching = await claudeRequest(mode.id, true, reported)
    const whole = await claudeRequest(mode.id, false, reported)
    const deferred = new Set(deferredTools(searching.body))
    const tools = Object.fromEntries(Object.entries(searching.tools).filter(([, tool]) => !tool.placeholder))
    for (const name of deferred) {
      const tool = whole.tools[name]
      if (!tool) throw new Error(`Claude Code deferred ${name} but defined no such tool with tool search off`)
      tools[name] = { ...tool, deferred: true }
    }
    configurations.push({ name: mode.id, tools })
  }
  if (!version) throw new Error("Claude Code reported no version")
  return { version, source: "the tools in the model request of Claude Code as Mako's SDK driver launches it (claudeSdkOptions), once per Mako mode; deferred tools' schemas from a second run with tool search off", configurations }
}

const CodexModels = z.object({ models: z.array(z.object({ slug: z.string(), visibility: z.string() }).loose()) })

async function codexDefinitions(): Promise<Captures> {
  const executable = await resolveCodexExecutable()
  if (!executable) throw new Error("Codex is not installed")
  const version = /\d+(?:\.\d+)+/.exec((await run(executable, ["--version"])).stdout)?.[0]
  if (!version) throw new Error("Codex reported no version")
  const seal = async (sandbox: Sandbox, endpoint: string) => {
    const codexHome = join(sandbox.home, ".codex")
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, "config.toml"), `openai_base_url = "${endpoint}/v1"\nchatgpt_base_url = "${endpoint}/backend-api"\n`)
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: CAPTURE_KEY }))
    return { ...sandbox.env, CODEX_HOME: codexHome }
  }
  const models = await sandboxed("codex", async (sandbox) => {
    const env = await seal(sandbox, "http://127.0.0.1:9")
    const listed = CodexModels.parse(JSON.parse((await run(executable, ["debug", "models"], { env, cwd: sandbox.project })).stdout))
    return listed.models.filter((model) => model.visibility === "list").map((model) => model.slug)
  })
  const configurations: Configuration[] = []
  for (const model of models) for (const plan of [false, true]) {
    configurations.push(await sandboxed("codex", async (sandbox) => {
      const endpoint = await modelEndpoint()
      const env = await seal(sandbox, endpoint.url)
      const child = spawn(executable, ["app-server"], { cwd: sandbox.project, env, stdio: ["pipe", "pipe", "pipe"] })
      let reached: (() => void) | undefined
      const replied = new Promise<void>((_, reject) => { reached = () => reject(new ReachedRealModel("Codex")) })
      const peer = refusingPeer(child, false, ({ method }) => { if (method === "item/agentMessage/delta") reached?.() })
      try {
        await peer.call("initialize", { clientInfo: { name: "mako-native-tools", version: "0" } })
        peer.notify("initialized")
        const thread = z.object({ thread: z.object({ id: z.string() }) }).parse(await peer.call("thread/start", { cwd: sandbox.project, model, config: codexInteractiveConfig() }))
        const turn = peer.call("turn/start", {
          threadId: thread.thread.id,
          input: [{ type: "text", text: "hi", text_elements: [] }],
          ...codexCollaborationMode({ model, options: { plan } }, model),
        })
        void turn.catch(() => {})
        const { tools } = await captured("Codex", endpoint, Promise.race([replied, new Promise((resolve) => child.once("exit", resolve))]))
        return { name: plan ? `${model}, plan` : model, tools: definedTools("responses", tools, sandbox.scrub) }
      } finally {
        peer.close()
        await stop(child)
        await endpoint.close()
      }
    }))
  }
  return { version, source: "the tools in the model request of Codex's app-server with Mako's thread config (codexInteractiveConfig, codexCollaborationMode), per listed model, with and without plan", configurations }
}

/** The ACP session's prompt, with Mako's launch arguments for the mode. */
async function acpCapture(input: {
  harness: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  mode?: string
  endpoint: ModelEndpoint
}): Promise<unknown[]> {
  const executable = resolveExecutable(input.command, input.env)
  if (!executable) throw new Error(`${input.harness} is not installed`)
  const child = spawn(executable, input.args, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] })
  let reached: (() => void) | undefined
  const replied = new Promise<void>((_, reject) => { reached = () => reject(new ReachedRealModel(input.harness)) })
  const Update = z.object({ update: z.object({ sessionUpdate: z.string() }).loose() }).loose()
  const peer = refusingPeer(child, true, ({ method, params }) => {
    if (method === "session/update" && Update.safeParse(params).data?.update.sessionUpdate === "agent_message_chunk") reached?.()
  })
  try {
    await peer.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    const session = z.object({ sessionId: z.string() }).parse(await peer.call("session/new", { cwd: input.cwd, mcpServers: [] }))
    if (input.mode) await peer.call("session/set_mode", { sessionId: session.sessionId, modeId: input.mode })
    void peer.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] }).catch(() => {})
    return (await captured(input.harness, input.endpoint, Promise.race([replied, new Promise((resolve) => child.once("exit", resolve))]))).tools
  } finally {
    peer.close()
    await stop(child)
  }
}

async function grokDefinitions(): Promise<Captures> {
  const driver = providerHost.liveDrivers.get("grok")!
  const executable = resolveExecutable("grok", process.env)
  if (!executable) throw new Error("Grok is not installed")
  const version = /\d+(?:\.\d+)+/.exec((await run(executable, ["--version"])).stdout)?.[0]
  if (!version) throw new Error("Grok reported no version")
  const configurations: Configuration[] = []
  for (const mode of driver.modes ?? []) {
    const access = grokAcpSource.access?.launch?.find((level) => mode.id === `access:${level}`) ?? grokAcpSource.access?.default
    const native = Object.entries(grokAcpSource.access?.native ?? {}).find(([id]) => id === mode.id)?.[1]
    configurations.push(await sandboxed("grok", async (sandbox) => {
      // Grok checks its key and lists models before the first prompt; those two are answered, the prompt is refused.
      const endpoint = await modelEndpoint(new Map([
        ["/v1/api-key", JSON.stringify({ redacted_api_key: "xai-...ture", user_id: "capture", name: "capture", acls: ["api-key:model:*", "api-key:endpoint:*"], api_key_blocked: false, api_key_disabled: false, team_blocked: false })],
        ["/v1/models", JSON.stringify({ object: "list", data: [] })],
      ]))
      const env: NodeJS.ProcessEnv = {
        ...sandbox.env, GROK_HOME: join(sandbox.home, ".grok"), XAI_API_KEY: CAPTURE_KEY,
        GROK_XAI_API_BASE_URL: `${endpoint.url}/v1`, GROK_CLI_CHAT_PROXY_BASE_URL: `${endpoint.url}/v1`, GROK_MODELS_BASE_URL: `${endpoint.url}/v1`,
      }
      try {
        const launch = await grokAcpSource.launch({ appPath: process.cwd(), execPath: process.execPath, cwd: sandbox.project, env, access })
        if (!launch) throw new Error("Grok's ACP source declined to launch")
        launch.configureEnvironment?.(env)
        const tools = await acpCapture({ harness: "Grok", command: launch.command, args: launch.args, env, cwd: sandbox.project, mode: native, endpoint })
        return { name: mode.id, tools: definedTools("chat", tools, sandbox.scrub) }
      } finally {
        await endpoint.close()
      }
    }))
  }
  return { version, source: "the tools in the model request of grok agent stdio as Mako's ACP source launches it, once per Mako mode", configurations }
}

/** The model families OpenCode gives different tools: Anthropic's Messages API and OpenAI's Responses API. */
const OPENCODE_PROVIDERS = [{ providerID: "anthropic", wire: "anthropic" }, { providerID: "openai", wire: "responses" }] as const satisfies readonly { providerID: string; wire: Wire }[]

async function openCodeDefinitions(): Promise<Captures> {
  const driver = providerHost.liveDrivers.get("opencode")!
  const installation = await resolveOpenCodeInstallation(process.env)
  let version: string | undefined
  const configurations: Configuration[] = []
  for (const { providerID, wire } of OPENCODE_PROVIDERS) {
    const agents = new Map<string, string>()
    for (const mode of driver.modes ?? []) {
      const agent = openCodeAgentForMode(mode.id, openCodeLaunchAccess(mode.id))
      if (!agents.has(agent)) agents.set(agent, mode.id)
    }
    for (const [agent, mode] of agents) {
      configurations.push(await sandboxed("opencode", async (sandbox) => {
        const endpoint = await modelEndpoint()
        const env: NodeJS.ProcessEnv = {
          ...sandbox.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [providerID]: { options: { baseURL: `${endpoint.url}/v1`, apiKey: CAPTURE_KEY } } } }),
        }
        configureOpenCodePermissions(env, openCodeLaunchAccess(mode))
        const api = await startOpenCodeApi({ command: installation.command, cwd: sandbox.project, env, conversationId: randomUUID(), trace: trace("opencode") })
        try {
          version = api.health.version
          const location = { directory: sandbox.project }
          await api.client.plugin.awaitActivation({ location })
          const models = await api.client.model.list({ location })
          const model = models.data.find((entry) => entry.providerID === providerID && entry.enabled && entry.status !== "deprecated")
          if (!model) throw new Error(`OpenCode offers no ${providerID} model with the capture key`)
          const session = await api.client.session.create({ location, agent, model: { id: model.id, providerID } })
          if (session.model?.providerID !== providerID) throw new Error(`OpenCode opened the session on ${session.model?.providerID ?? "no provider"}, not ${providerID}`)
          const prompt = api.client.session.prompt({ sessionID: session.id, id: openCodeMessageId(), text: "hi" })
          void prompt.catch(() => {})
          const { tools } = await captured("OpenCode", endpoint, api.exited)
          return { name: `${providerID}, ${agent}`, tools: definedTools(wire, tools, sandbox.scrub) }
        } finally {
          await api.close()
          await endpoint.close()
        }
      }))
    }
  }
  if (!version) throw new Error("OpenCode reported no version")
  return { version, source: "the tools in the model request of OpenCode's native API as Mako starts it (startOpenCodeApi), per agent Mako's modes use, on an Anthropic and an OpenAI model", configurations }
}

/** Zod 3 keeps an object schema's fields under this name. */
const ZOD3_FIELDS = "shape"

/** A zod 3 schema, as the Cursor SDK builds its own, read through its definition. */
const Zod3 = z.looseObject({
  get _def() {
    return z.looseObject({
      typeName: z.string(),
      get innerType() { return Zod3.optional() },
      get schema() { return Zod3.optional() },
      get options() { return z.array(Zod3).optional() },
      value: z.unknown().optional(),
    })
  },
  get [ZOD3_FIELDS]() { return z.record(z.string(), Zod3).optional() },
})
type Zod3 = z.infer<typeof Zod3>

const ZOD3_TYPES = new Map([
  ["ZodString", "string"], ["ZodNumber", "number"], ["ZodBoolean", "boolean"], ["ZodArray", "array"],
  ["ZodObject", "object"], ["ZodRecord", "object"], ["ZodEnum", "enum"], ["ZodLiteral", "const"],
])

function zod3Parameter({ _def }: Zod3): Parameter {
  const inner = _def.innerType ?? _def.schema
  if ((_def.typeName === "ZodOptional" || _def.typeName === "ZodDefault") && inner) return { type: zod3Parameter(inner).type, required: false }
  if ((_def.typeName === "ZodNullable" || _def.typeName === "ZodEffects") && inner) return zod3Parameter(inner)
  if (_def.typeName === "ZodUnion") return { type: [...new Set((_def.options ?? []).map((option) => zod3Parameter(option).type))].join("|"), required: true }
  return { type: ZOD3_TYPES.get(_def.typeName) ?? "any", required: true }
}

const zod3Fields = (schema: Zod3 | undefined) => schema?.[ZOD3_FIELDS] ?? {}
const zod3Literal = (schema: Zod3 | undefined) => String(schema?._def.value)

async function cursorDefinitions(): Promise<Captures> {
  const { ConversationStepSchema } = await import("@cursor/sdk")
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL("../node_modules/@cursor/sdk/package.json", import.meta.url), "utf8")))
  const step = Zod3.parse(ConversationStepSchema)._def.options?.find((option) => zod3Literal(zod3Fields(option).type) === "toolCall")
  const message = zod3Fields(step).message
  if (!message) throw new Error(`@cursor/sdk ${version} has no toolCall step in ConversationStepSchema`)
  const tools: DefinedTools = {}
  for (const option of message._def.options ?? []) {
    const fields = zod3Fields(option)
    const args = fields.args?._def.typeName === "ZodOptional" ? fields.args._def.innerType : fields.args
    tools[zod3Literal(fields.type)] = { form: "function", parameters: Object.fromEntries(Object.entries(zod3Fields(args)).map(([name, value]) => [name, zod3Parameter(value)])) }
  }
  return { version, source: "the tool-call schema in @cursor/sdk (ConversationStepSchema's toolCall message): the arguments Cursor reports each tool with, not its model's definitions", configurations: [{ name: "sdk", tools }] }
}

const CAPTURES = new Map([
  ["claude", claudeDefinitions],
  ["codex", codexDefinitions],
  ["cursor", cursorDefinitions],
  ["grok", grokDefinitions],
  ["opencode", openCodeDefinitions],
])

function printDiff(before: NativeDefinitions | undefined, after: NativeDefinitions): void {
  if (!before) return void console.log(`  first stored version of ${after.harness}`)
  const since = before.version === after.version ? `the stored ${before.version} capture of ${before.on}` : before.version
  const lines = diffDefinitions(before, after)
  console.log(lines.length ? `  since ${since}:\n${lines.map((line) => `    ${line}`).join("\n")}` : `  no change since ${since}`)
}

if (args[0] === "--diff") {
  const [harness, from, to] = args.slice(1)
  const stored = storedDefinitions(harness ?? "")
  const pick = (version: string | undefined) => stored.find((definitions) => definitions.version === version)
  if (!pick(from) || !pick(to)) throw new Error(`Stored ${harness} versions: ${stored.map((definitions) => definitions.version).join(", ") || "none"}`)
  printDiff(pick(from), pick(to)!)
} else {
  const harnesses = args.length ? args : [...CAPTURES.keys()]
  for (const harness of harnesses) if (!CAPTURES.has(harness)) throw new Error(`${harness} has no native-tools capture; capturable: ${[...CAPTURES.keys()].join(", ")}`)
  await mkdir(NATIVE_TOOLS_DIR, { recursive: true })
  for (const [harness, capture] of [...CAPTURES].filter(([name]) => harnesses.includes(name))) {
    const captures = await capture()
    const stray = await strayStores(SANDBOX)
    if (stray.length) throw new Error(`${harness} wrote outside its sandbox, into ${stray.join(", ")}; nothing was written`)
    const definitions = NativeDefinitions.parse({ harness, ...captures, on: new Date().toISOString().slice(0, 10) })
    const previous = storedDefinitions(harness).filter((stored) => compareVersions(stored.version, definitions.version) <= 0).at(-1)
    await writeFile(definitionsPath(harness, definitions.version), `${JSON.stringify(definitions, null, 2)}\n`)
    const tools = new Set(definitions.configurations.flatMap((configuration) => Object.keys(configuration.tools)))
    const configurations = definitions.configurations.length
    console.log(`${harness} ${definitions.version}: ${tools.size} tools across ${configurations} configuration${configurations === 1 ? "" : "s"}`)
    printDiff(previous, definitions)
  }
}
