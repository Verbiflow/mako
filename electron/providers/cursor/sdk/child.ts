/**
 * The Cursor SDK child: one process per live session, spoken to over stdio
 * with the contract in `wire.ts`.
 *
 * The SDK runs Cursor's agent loop in-process — the same loop `cursor-agent`
 * runs, with transport retries enabled — so this process is the provider's
 * process, spawned from the host's own executable under
 * `ELECTRON_RUN_AS_NODE`. It never imports Electron. Its stdout carries only
 * protocol lines; anything the SDK prints goes to stderr, which the host
 * drains without logging because it can carry provider input.
 */
import { crashSummary, cursorSdkWireError } from "./errors.js"
import { createInterface } from "node:readline"
import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  Agent,
  AgentBusyError,
  ConfigurationError,
  Cursor,
  type AgentOptions,
  type McpServerConfig,
  type Run,
  type SDKAgent,
  type SDKMessage,
} from "@cursor/sdk"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { unpackedPath } from "../../../asar-unpacked.js"
import { CURSOR_SDK_IMPORT_METADATA_KEY } from "@mako/sessions"
import { z } from "zod"
import {
  copyLegacyStore,
  CursorImportError,
  importedAgentDocument,
  readLegacyStoreMeta,
  resolveImportAgentId,
  type KnownAgent,
} from "./import.js"
import {
  CURSOR_SDK_WIRE_VERSION,
  JsonValueSchema,
  SdkRequestSchema,
  sdkMessageForWire,
  type JsonValue,
  type SdkChildLine,
  type SdkImportSource,
  type SdkMcpServer,
  type SdkModelSelection,
  type SdkRequest,
  type SdkResult,
} from "./wire.js"

const PackageSchema = z.object({ name: z.string(), version: z.string() })

interface OpenAgent {
  agentId: string
  cwd: string
  store: SqliteLocalAgentStore
  handle: SDKAgent
  model: SdkModelSelection | undefined
  mcpServers: Record<string, McpServerConfig> | undefined
  name: string | undefined
}

interface ActiveTurn {
  turn: string
  run: Run
}

let agent: OpenAgent | undefined
let active: ActiveTurn | undefined
let sending = false
let closing = false

function write(line: SdkChildLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

function log(level: "info" | "warn", message: string): void {
  write({ event: "log", level, message })
}


/**
 * The SDK looks for its `rg` by walking up from this entry. In a package that
 * walk stays inside `app.asar`, where the binary reads as non-executable, so
 * Grep and Glob fail with "Ripgrep path not configured" unless the unpacked
 * copy is named here before any agent opens.
 */
function configureRipgrep(): void {
  if (process.env.CURSOR_RIPGREP_PATH) return
  try {
    const require = createRequire(import.meta.url)
    const platform = dirname(require.resolve(`@cursor/sdk-${process.platform}-${process.arch}/package.json`))
    const binary = unpackedPath(join(platform, "bin", process.platform === "win32" ? "rg.exe" : "rg"))
    if (existsSync(binary)) process.env.CURSOR_RIPGREP_PATH = binary
    else log("warn", "the platform package has no ripgrep binary")
  } catch {
    log("warn", "the platform package is not installed; the SDK looks for ripgrep on PATH")
  }
}

let exiting = false

function fatal(kind: string, cause: unknown): void {
  if (exiting) return
  exiting = true
  const deadline = setTimeout(() => process.exit(1), 1_000)
  deadline.unref()
  try {
    process.stdout.write(`${JSON.stringify({ event: "log", level: "warn", message: `fatal ${kind}: ${crashSummary(cause)}` } satisfies SdkChildLine)}\n`, () => process.exit(1))
  } catch {
    process.exit(1)
  }
}

function sdkVersion(): string {
  const require = createRequire(import.meta.url)
  try {
    // The export map hides package.json from `resolve`; walk up from the
    // entry it does expose until the package's own manifest appears.
    let directory = dirname(require.resolve("@cursor/sdk"))
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = join(directory, "package.json")
      if (existsSync(candidate)) {
        const manifest = PackageSchema.safeParse(JSON.parse(readFileSync(candidate, "utf8")))
        if (manifest.success && manifest.data.name === "@cursor/sdk") return manifest.data.version
      }
      directory = dirname(directory)
    }
  } catch {
    // Fall through: the version is diagnostic, never load-bearing.
  }
  return "unknown"
}

function mcpConfig(servers: Record<string, SdkMcpServer> | undefined): Record<string, McpServerConfig> | undefined {
  if (!servers) return undefined
  const config: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(servers)) {
    config[name] =
      server.type === "stdio"
        ? { type: "stdio", command: server.command, args: server.args, env: server.env, cwd: server.cwd }
        : { type: server.type, url: server.url, headers: server.headers }
  }
  return config
}

function handleOptions(open: Omit<OpenAgent, "handle">): Partial<AgentOptions> {
  return {
    model: open.model,
    // Agent with the full toolset and nothing else: no `plan`, no `tools`
    // allowlist, and never `autoReview`, whose classifier refuses calls
    // nobody at the desk can approve (`modes.ts`).
    mode: "agent",
    mcpServers: open.mcpServers,
    local: {
      cwd: open.cwd,
      store: open.store,
      // Without `settingSources` the SDK loads no on-disk config: the
      // workspace's `.cursor/hooks.json` (the one way to deny a call by
      // policy), Cursor's own `.cursor/mcp.json` and
      // `~/.cursor/mcp.json` (which Mako never projects, because the reach
      // predicate treats a provider's own servers as reached natively) and
      // the project's rules. Verified with SDK 1.0.31: a `beforeShellExecution`
      // hook ran only once `"project"` was listed.
      settingSources: ["project", "user"],
      enableAgentRetries: true,
    },
  }
}

type OpenParams = Extract<SdkRequest, { method: "open" }>["params"]
type SendParams = Extract<SdkRequest, { method: "send" }>["params"]

const ImportRecordSchema = z.object({
  [CURSOR_SDK_IMPORT_METADATA_KEY]: z.object({ path: z.string() }).optional(),
})

/** Every agent the index knows, with the legacy store each was imported from. */
async function knownAgents(store: SqliteLocalAgentStore): Promise<KnownAgent[]> {
  const known: KnownAgent[] = []
  let cursor: string | undefined
  do {
    const page = await store.agents.list({ filter: { cursor, limit: 200 } })
    for (const document of page.items) {
      const entry: KnownAgent = { agentId: document.agentId }
      const metadata = ImportRecordSchema.safeParse(document.sdkMetadata ?? {})
      const path = metadata.success ? metadata.data[CURSOR_SDK_IMPORT_METADATA_KEY]?.path : undefined
      if (path) entry.importedFrom = path
      known.push(entry)
    }
    cursor = page.nextCursor
  } while (cursor)
  return known
}

/**
 * Make a `cursor-agent` store an SDK agent, once. Returns the id to resume
 * and whether this call made the copy. The copy lands before the index row,
 * so a crash between the two leaves a store the next attempt replaces, never
 * a row that points at nothing.
 */
async function importLegacyStore(
  store: SqliteLocalAgentStore,
  params: OpenParams,
  source: SdkImportSource
): Promise<{ agentId: string; imported: boolean }> {
  const resolved = resolveImportAgentId(params.agentId, source.path, await knownAgents(store))
  if (resolved.existing) return { agentId: resolved.agentId, imported: false }
  const meta = readLegacyStoreMeta(source.path)
  copyLegacyStore(source.path, params.stateRoot, resolved.agentId)
  const document = importedAgentDocument({ agentId: resolved.agentId, source, meta, now: Date.now() })
  await store.agents.create({
    agent: {
      agentId: document.agentId,
      cwd: document.cwd || params.cwd,
      status: "idle",
      name: document.name,
      createdAt: document.createdAt,
      updatedAt: Date.now(),
      latestCheckpoint: { schemaVersion: 1, rootBlobId: document.latestRootBlobId },
      sdkMetadata: document.sdkMetadata,
    },
  })
  log("info", `imported a cursor-agent store as agent ${document.agentId}`)
  return { agentId: document.agentId, imported: true }
}

async function openAgent(params: OpenParams): Promise<SdkResult<"open">> {
  if (agent) throw new ConfigurationError("This child already has an agent open")
  const store = await SqliteLocalAgentStore.open({ workspaceRef: params.cwd, stateRoot: params.stateRoot })
  Cursor.configure({ local: { store, useHttp1ForAgent: params.http1 ?? null } })
  let agentId = params.agentId
  let imported = false
  try {
    if (!params.create && params.importFrom) {
      const result = await importLegacyStore(store, params, params.importFrom)
      agentId = result.agentId
      imported = result.imported
    }
  } catch (cause) {
    await store.dispose().catch(() => undefined)
    if (cause instanceof CursorImportError) throw new ConfigurationError(cause.message)
    throw cause
  }
  const base: Omit<OpenAgent, "handle"> = {
    agentId,
    cwd: params.cwd,
    store,
    model: params.model,
    mcpServers: mcpConfig(params.mcpServers),
    name: params.name,
  }
  const options = handleOptions(base)
  let handle: SDKAgent
  try {
    handle = params.create
      ? await Agent.create({ ...options, agentId, name: params.name })
      : await Agent.resume(agentId, options)
  } catch (cause) {
    await store.dispose().catch(() => undefined)
    throw cause
  }
  agent = { ...base, handle }
  return { agentId: handle.agentId, model: handle.model, imported: imported || undefined }
}

function forwardMessage(turn: string, message: SDKMessage): void {
  const wire = sdkMessageForWire(message)
  if ("refused" in wire) {
    log("warn", `dropped an SDK message of type ${message.type} the wire does not describe (${wire.refused})`)
    return
  }
  write({ event: "message", turn, message: wire.message })
}

async function pump(turn: string, run: Run): Promise<void> {
  try {
    for await (const message of run.stream()) forwardMessage(turn, message)
  } catch (cause) {
    if (!closing) log("warn", `run stream ended early: ${cursorSdkWireError(cause).message}`)
  }
  let result
  try {
    result = await run.wait()
  } catch (cause) {
    const error = cursorSdkWireError(cause)
    write({ event: "result", turn, result: { runId: run.id, status: "error", error: { message: error.message, code: error.code } } })
    return
  } finally {
    if (active?.turn === turn) active = undefined
  }
  write({
    event: "result",
    turn,
    result: {
      runId: result.id,
      status: result.status,
      error: result.error ? { message: result.error.message, code: result.error.code } : undefined,
      model: result.model,
      durationMs: result.durationMs,
      usage: result.usage,
    },
  })
}

async function send(params: SendParams): Promise<SdkResult<"send">> {
  const open = agent
  if (!open) throw new ConfigurationError("No agent is open in this child")
  if (active || sending) throw new AgentBusyError("A turn is already running in this session")
  if (closing) throw new ConfigurationError("This session is closing")
  if (params.model) open.model = params.model
  const message = { text: params.text, images: params.images }
  const onDelta = ({ update }: { update: { type: string; text?: string } }) => {
    switch (update.type) {
      case "text-delta":
      case "thinking-delta":
        write({ event: "delta", turn: params.turn, delta: { type: update.type, text: update.text ?? "" } })
        return
      case "thinking-completed":
      case "turn-ended":
        write({ event: "delta", turn: params.turn, delta: { type: update.type } })
        return
      default:
        return
    }
  }
  const options = { model: params.model, mode: "agent" as const, onDelta }
  sending = true
  try {
    let run: Run
    try {
      run = await open.handle.send(message, options)
    } catch (cause) {
      // SDK 1.0.31 wraps this SQLite preflight refusal as UnknownAgentError,
      // not AgentBusyError. Match only this agent's persisted-run refusal:
      // other failures may follow delivery and must never resend a prompt.
      // Mako acquires the native-session hold before opening this child;
      // active/sending exclude a run belonging to this process.
      if (!(cause instanceof Error) || cause.message !== `Agent ${open.agentId} already has active run`) throw cause
      run = await open.handle.send(message, { ...options, local: { force: true } })
      log("warn", "recovered a run left active by an earlier process")
    }
    active = { turn: params.turn, run }
    void pump(params.turn, run)
    return { runId: run.id }
  } finally {
    sending = false
  }
}

async function steer(text: string): Promise<SdkResult<"steer">> {
  if (!active) throw new ConfigurationError("No turn is running to steer")
  if (!active.run.steer) throw new ConfigurationError("This run cannot be steered")
  return { outcome: await active.run.steer(text) }
}

async function cancel(): Promise<SdkResult<"cancel">> {
  if (active) await active.run.cancel()
  return {}
}

async function close(): Promise<SdkResult<"close">> {
  closing = true
  const open = agent
  agent = undefined
  if (open) {
    if (active) await active.run.cancel().catch(() => undefined)
    open.handle.close()
    await open.store.dispose().catch(() => undefined)
  }
  return {}
}

async function login(): Promise<SdkResult<"login">> {
  const result = await Cursor.auth.login({
    openBrowser: false,
    onLoginUrl: (url) => write({ event: "login-url", url }),
    apiKeyName: "Mako",
    // Mako keeps the key, encrypted with the OS keychain, and hands it to
    // each child through its environment; the SDK's plain-text
    // `~/.cursor/sdk/auth.json` is never written by Mako.
    store: null,
  })
  return { apiKey: result.apiKey, email: result.email, apiKeyExpiresAtMs: result.apiKeyExpiresAtMs }
}

async function authStatus(): Promise<SdkResult<"authStatus">> {
  const status = await Cursor.auth.status()
  if (status.status === "logged-in")
    return { status: "logged-in", email: status.email, apiKeyExpiresAtMs: status.apiKeyExpiresAtMs }
  // `auth.status()` reads only the SDK's own key store. A key handed in
  // through the environment signs every request just the same, so it is
  // checked against the account it names before the host is told "signed out".
  if (process.env.CURSOR_API_KEY) {
    try {
      const user = await Cursor.me()
      return { status: "logged-in", email: user.userEmail }
    } catch (error) {
      log("warn", `CURSOR_API_KEY was rejected: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { status: "logged-out" }
}

async function me(): Promise<SdkResult<"me">> {
  const user = await Cursor.me()
  const name = [user.userFirstName, user.userLastName].filter(Boolean).join(" ")
  return {
    email: user.userEmail,
    name: name || undefined,
    apiKeyName: user.apiKeyName,
    createdAt: user.createdAt,
  }
}

async function dispatch(request: SdkRequest): Promise<SdkResult<SdkRequest["method"]>> {
  switch (request.method) {
    case "hello":
      return { wire: CURSOR_SDK_WIRE_VERSION, sdkVersion: sdkVersion(), node: process.versions.node, ripgrep: Boolean(process.env.CURSOR_RIPGREP_PATH) }
    case "open":
      return openAgent(request.params)
    case "send":
      return send(request.params)
    case "steer":
      return steer(request.params.text)
    case "cancel":
      return cancel()
    case "close":
      return close()
    case "models":
      return { models: await Cursor.models.list() }
    case "authStatus":
      return authStatus()
    case "login":
      return login()
    case "logout":
      await Cursor.auth.logout()
      return {}
    case "me":
      return me()
  }
}

const IdSchema = z.object({ id: z.number() })

function parseLine(line: string): JsonValue | undefined {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function handle(line: string): Promise<void> {
  const raw = parseLine(line)
  if (raw === undefined) {
    log("warn", "dropped a request line that was not JSON")
    return
  }
  const request = SdkRequestSchema.safeParse(raw)
  if (!request.success) {
    const id = IdSchema.safeParse(raw)
    if (id.success)
      write({ id: id.data.id, ok: false, error: { message: "The request does not match the wire contract", kind: "configuration" } })
    else log("warn", "dropped a request without an id")
    return
  }
  try {
    const result = await dispatch(request.data)
    write({ id: request.data.id, ok: true, result })
  } catch (cause) {
    write({ id: request.data.id, ok: false, error: cursorSdkWireError(cause) })
  }
  if (request.data.method === "close") process.exit(0)
}

function main(): void {
  process.title = "mako-cursor-sdk"
  // Anything the SDK prints belongs on stderr; stdout is the protocol.
  console.log = (...args) => console.error(...args)
  console.info = (...args) => console.error(...args)
  console.debug = (...args) => console.error(...args)
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    if (!line.trim()) return
    void handle(line)
  })
  lines.on("close", () => {
    // The host is gone; SDK cancellation or store disposal must not retain us.
    const deadline = setTimeout(() => process.exit(1), 5_000)
    deadline.unref()
    void close().finally(() => process.exit(0))
  })
  // Never report a broken protocol pipe through that same pipe: doing so from
  // uncaughtException produces an endless EPIPE/error/log loop after host exit.
  // Request-level errors are handled above; an uncaught failure is fatal and
  // reported at most once, so a broken stdout cannot feed its own report.
  process.stdin.on("error", () => process.exit(1))
  process.stdout.on("error", () => process.exit(1))
  process.stderr.on("error", () => process.exit(1))
  process.on("uncaughtException", (cause) => fatal("exception", cause))
  process.on("unhandledRejection", (cause) => fatal("rejection", cause))
  configureRipgrep()
}

main()
