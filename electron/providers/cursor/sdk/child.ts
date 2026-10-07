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
import { crashSummary, cursorBusyRefusal, cursorSdkWireError } from "./errors.js"
import { guardShellFolder } from "./shell-folder.js"
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
// Narrow entries: the package root loads every harness's reader into each Cursor child.
import { CURSOR_SDK_IMPORT_METADATA_KEY, readCursorSdkRunResults } from "@mako/sessions/cursor-sdk-index"
import { z } from "zod"
import {
  copyLegacyStore,
  CursorImportError,
  importedAgentDocument,
  verifyImportRevision,
  resolveImportAgentId,
  type KnownAgent,
} from "./import.js"
import { readLegacyStoreSnapshot } from "../legacy-store.js"
import { lostCursorRun, recordCursorRun, settleCursorRun } from "./run-records.js"
import type { CursorSdkModelSelection } from "@mako/sessions/cursor-sdk-content"
import {
  CURSOR_SDK_EXIT,
  CURSOR_SDK_HEADLESS,
  CURSOR_SDK_WIRE_VERSION,
  SdkHeadlessSpecSchema,
  type SdkHeadlessSpec,
  JsonValueSchema,
  SdkRequestSchema,
  type JsonValue,
  type SdkChildLine,
  type SdkImportSource,
  type SdkMcpServer,
  type SdkRequest,
  type SdkResult,
  type SdkRunResult,
} from "./wire.js"

const PackageSchema = z.object({ name: z.string(), version: z.string() })

interface OpenAgent {
  agentId: string
  cwd: string
  stateRoot: string
  store: SqliteLocalAgentStore
  handle: SDKAgent
  model: CursorSdkModelSelection | undefined
  mcpServers: Record<string, McpServerConfig> | undefined
  name: string | undefined
  /** Exact origin revision admitted by this child, checked again before send. */
  sourceImport?: { path: string; nativeId: string; revision: string }
}

interface ActiveTurn {
  turn: string
  run: Run
  /** Native stream and terminal result must drain before cancel acknowledges. */
  finished: Promise<void>
  /** What the host was sent of this turn, so a host that lost track of it can be shown it again (`active`). */
  replay: string[]
  replayCharacters: number
  replayTruncated: boolean
  /** The next message's `seq`. */
  messages: number
}

/** A turn's replay keeps its latest lines within this budget; text streamed as deltas is also in its messages. */
const MAX_REPLAY_CHARACTERS = 16 * 1024 * 1024

let agent: OpenAgent | undefined
let active: ActiveTurn | undefined
/** The turn whose `send` has not returned yet: the SDK may still start its run. */
let sending: string | undefined
/** Stop arrived while `sending`: the run is cancelled the moment it exists. */
let cancelWhileSending = false
let closing = false
/** One-shot mode: stdout carries the reply's text, so protocol lines have no reader. */
let headless = false

/**
 * The account's key arrives in `CURSOR_API_KEY` and leaves the environment
 * here, before any agent opens: the agent's shell, MCP servers and other
 * tools are this process's children and would inherit it. Every SDK call
 * names the key instead.
 */
const apiKey = process.env.CURSOR_API_KEY || undefined
delete process.env.CURSOR_API_KEY

function write(line: SdkChildLine): void {
  writeText(JSON.stringify(line))
}

function writeText(text: string): void {
  if (headless) return
  process.stdout.write(`${text}\n`)
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

const SpawnFailureSchema = z.object({ syscall: z.string().startsWith("spawn") })

/**
 * Rejections the SDK leaves unobserved that say nothing about this process's
 * state. SDK 1.0.31 aborts an internal controller when a run is cancelled
 * (`AbortError code 20` right after Stop) and its shell tool rejects a
 * second promise when a command cannot start (`ENOENT` from a deleted
 * folder); in both the owning run or tool call settles on its own. Ending
 * the process for either ended the turn with it.
 */
function containedRejection(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  return cause.name === "AbortError" || SpawnFailureSchema.safeParse(cause).success
}

function fatal(kind: string, cause: unknown): void {
  if (kind === "rejection" && containedRejection(cause)) {
    log("warn", `ignored an unobserved SDK rejection: ${crashSummary(cause)}`)
    return
  }
  if (exiting) return
  exiting = true
  const deadline = setTimeout(() => process.exit(CURSOR_SDK_EXIT.fatal), 1_000)
  deadline.unref()
  try {
    if (headless) process.stderr.write(`Cursor's SDK stopped on an uncaught error: ${crashSummary(cause)}\n`, () => process.exit(CURSOR_SDK_EXIT.fatal))
    else process.stdout.write(`${JSON.stringify({ event: "log", level: "warn", message: `fatal ${kind}: ${crashSummary(cause)}` } satisfies SdkChildLine)}\n`, () => process.exit(CURSOR_SDK_EXIT.fatal))
  } catch {
    process.exit(CURSOR_SDK_EXIT.fatal)
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
    apiKey,
    model: open.model,
    // Agent with the full toolset: no `tools` allowlist, and never
    // `autoReview`, whose classifier refuses calls nobody at the desk can
    // approve (`modes.ts`). A planning turn asks for `plan` on its send.
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
  [CURSOR_SDK_IMPORT_METADATA_KEY]: z.object({ path: z.string(), revision: z.string().min(1).optional() }).optional(),
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
      const record = metadata.success ? metadata.data[CURSOR_SDK_IMPORT_METADATA_KEY] : undefined
      if (record) {
        entry.importedFrom = record.path
        entry.importRevision = record.revision
      }
      known.push(entry)
    }
    cursor = page.nextCursor
  } while (cursor)
  return known
}

/**
 * Make a `cursor-agent` store an SDK agent, once. Returns the id to resume
 * and whether this call made the copy. The copy lands before the index row,
 * so a crash between the two leaves an unindexed store, never a row pointing
 * at missing bytes. Existing destinations are preserved, not overwritten.
 */
async function importLegacyStore(
  store: SqliteLocalAgentStore,
  params: OpenParams,
  source: SdkImportSource
): Promise<{ agentId: string; imported: boolean; revision: string }> {
  const resolved = resolveImportAgentId(params.agentId, source.path, await knownAgents(store))
  if (resolved.existing) {
    const current = readLegacyStoreSnapshot(source.path, params.agentId)
    const revision = verifyImportRevision(resolved.revision, current.revision)
    return { agentId: resolved.agentId, imported: false, revision }
  }
  const copied = copyLegacyStore(source.path, params.stateRoot, resolved.agentId)
  // Read the copied snapshot, never an earlier/later head from the live source.
  const snapshot = readLegacyStoreSnapshot(copied, params.agentId)
  verifyImportRevision(snapshot.revision, readLegacyStoreSnapshot(source.path, params.agentId).revision)
  const document = importedAgentDocument({ agentId: resolved.agentId, source, snapshot, now: Date.now() })
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
  return { agentId: document.agentId, imported: true, revision: snapshot.revision }
}

async function openAgent(params: OpenParams): Promise<SdkResult<"open">> {
  if (agent) throw new ConfigurationError("This child already has an agent open")
  const store = await SqliteLocalAgentStore.open({ workspaceRef: params.cwd, stateRoot: params.stateRoot })
  // `send` persists the active run before loading its checkpoint, and can
  // die during that load before returning a Run. Record its owner before
  // the SDK writes the run, so a crash there is recoverable too.
  const createRun = store.runs.create.bind(store.runs)
  store.runs.create = async (input) => {
    const failure = recordCursorRun(params.stateRoot, input.run.agentId, {
      runId: input.run.runId, pid: process.pid, startedAt: performance.timeOrigin,
    })
    if (failure) throw new ConfigurationError(`The Cursor run's owner could not be recorded: ${failure}`)
    return createRun(input)
  }
  // HTTP/1.1 unless asked otherwise. Over HTTP/2 (SDK 1.0.31), a large
  // conversation's stream closes ("Premature close") right after the turn
  // ends and before its checkpoint arrives, so the SDK re-runs the whole
  // message until it gives up; over HTTP/1.1 the same turn finishes once.
  Cursor.configure({ local: { store, useHttp1ForAgent: params.http1 ?? true } })
  let agentId = params.agentId
  let imported = false
  let importRevision: string | undefined
  try {
    if (!params.create && params.importFrom) {
      const result = await importLegacyStore(store, params, params.importFrom)
      agentId = result.agentId
      imported = result.imported
      importRevision = result.revision
    }
  } catch (cause) {
    await store.dispose().catch(() => undefined)
    if (cause instanceof CursorImportError) throw new ConfigurationError(cause.message)
    throw cause
  }
  const base: Omit<OpenAgent, "handle"> = {
    agentId,
    cwd: params.cwd,
    stateRoot: params.stateRoot,
    store,
    model: params.model,
    mcpServers: mcpConfig(params.mcpServers),
    name: params.name,
  }
  if (params.importFrom && importRevision)
    base.sourceImport = { path: params.importFrom.path, nativeId: params.agentId, revision: importRevision }
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
  return { agentId: handle.agentId, model: handle.model, importRevision, imported: imported || undefined, importSource: !params.create ? params.importFrom?.path : undefined }
}

/** Keeps a written line of `turn` for `activeTurn`, as the text that was written. */
function remember(turn: string, text: string): void {
  const current = active
  if (current?.turn !== turn) return
  current.replay.push(text)
  current.replayCharacters += text.length
  while (current.replayCharacters > MAX_REPLAY_CHARACTERS && current.replay.length > 1) {
    current.replayCharacters -= current.replay.shift()!.length
    current.replayTruncated = true
  }
}

/**
 * Serialized once, as the SDK made it. The host checks the line against
 * `SdkMessageSchema` after it is JSON, which drops the `undefined` fields
 * the SDK's objects hold, and drops a message the wire does not describe.
 */
function forwardMessage(turn: string, message: SDKMessage): void {
  const seq = active?.turn === turn ? active.messages++ : undefined
  const text = JSON.stringify(seq === undefined ? { event: "message", turn, message } : { event: "message", turn, seq, message })
  writeText(text)
  remember(turn, text)
}

/** How often a run looks for the result of a call it moved past, until the call settles or the stream ends. */
const SETTLE_POLL_MS = 250

async function pump(open: OpenAgent, turn: string, run: Run): Promise<void> {
  const unended = new Set<string>()
  // Open calls the model went on past: a call's own stream may never end it
  // (a read of a missing file, with SDK 1.0.31), but the step's checkpoint
  // keeps its result.
  const passed = new Set<string>()
  const checkpoints = new CursorSdkRunCheckpoints(open.stateRoot, open.agentId, run.id)
  let poll: NodeJS.Timeout | undefined
  const settle = () => {
    poll = undefined
    const results = checkpoints.results(passed)
    if (results.size) {
      for (const callId of results.keys()) {
        unended.delete(callId)
        passed.delete(callId)
      }
      const text = JSON.stringify({ event: "settled", turn, calls: settledCalls(results) } satisfies SdkEvent)
      writeText(text)
      remember(turn, text)
    }
    if (passed.size) poll = setTimeout(settle, SETTLE_POLL_MS)
  }
  try {
    for await (const message of run.stream()) {
      if (message.type === "tool_call") {
        if (message.status !== "running") {
          unended.delete(message.call_id)
          passed.delete(message.call_id)
        } else if (!unended.has(message.call_id)) {
          for (const callId of unended) passed.add(callId)
          unended.add(message.call_id)
        }
      } else if (message.type === "assistant" || message.type === "thinking") {
        for (const callId of unended) passed.add(callId)
      }
      forwardMessage(turn, message)
      if (passed.size && !poll) settle()
    }
  } catch (cause) {
    if (!closing) log("warn", `run stream ended early: ${cursorSdkWireError(cause).message}`)
  }
  clearTimeout(poll)
  if (shellOutput?.turn === turn) {
    clearTimeout(shellOutput.timer)
    shellOutput = undefined
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
  settleRun(open, run.id)
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
      settled: checkpointedResults(open, run.id, unended),
    },
  })
}

/** What the run's checkpoint kept for calls its stream never ended; undefined when it kept none. */
function checkpointedResults(open: OpenAgent, runId: string, callIds: ReadonlySet<string>): SdkRunResult["settled"] {
  const results = readCursorSdkRunResults(open.stateRoot, open.agentId, runId, callIds)
  return results.size ? [...results].map(([callId, result]) => ({ callId, ...result })) : undefined
}

const unknownDeltas = new Set<string>()

/**
 * A running command's output reaches the host at most this often, as the
 * tail of what it printed since. Its completed call carries the whole.
 */
const SHELL_OUTPUT_INTERVAL_MS = 100
const SHELL_OUTPUT_TAIL = 16 * 1024

const ShellChunkSchema = z.object({
  case: z.enum(["stdout", "stderr"]),
  value: z.object({ data: z.string() }),
})

let shellOutput: { turn: string; text: string; timer: NodeJS.Timeout } | undefined

function bufferShellOutput(turn: string, printed: string): void {
  if (!printed) return
  if (shellOutput && shellOutput.turn !== turn) flushShellOutput()
  if (!shellOutput) shellOutput = { turn, text: "", timer: setTimeout(flushShellOutput, SHELL_OUTPUT_INTERVAL_MS) }
  const text = shellOutput.text + printed
  shellOutput.text = text.length > SHELL_OUTPUT_TAIL ? text.slice(-SHELL_OUTPUT_TAIL) : text
}

function flushShellOutput(): void {
  const pending = shellOutput
  if (!pending) return
  shellOutput = undefined
  clearTimeout(pending.timer)
  write({ event: "delta", turn: pending.turn, delta: { type: "shell-output", text: pending.text } })
}

type SendOptions = NonNullable<Parameters<SDKAgent["send"]>[1]>

/** A native busy refusal is final for this attempt. A Mako reservation cannot
 * authorize force-taking a run an independent executor may have just started.
 * The one exception is proof the run is dead: the agent's active run is the
 * exact run a Mako child recorded and that child is gone (`run-records.ts`).
 */
async function startRun(open: OpenAgent, message: Parameters<SDKAgent["send"]>[0], options: SendOptions): Promise<Run> {
  const receipt = open.sourceImport
  if (receipt)
    verifyImportRevision(receipt.revision, readLegacyStoreSnapshot(receipt.path, receipt.nativeId).revision)
  const lost = await lostCursorRun(open.stateRoot, open.agentId)
  const stuck = lost !== undefined && (await open.store.agents.get({ agentId: open.agentId }))?.activeRunId === lost
  if (stuck) log("info", "expiring the run a child that is gone left active")
  const run = await open.handle.send(message, stuck ? { ...options, local: { force: true } } : options)
    .catch((cause: unknown) => { throw cursorBusyRefusal(cause, open.agentId) ?? cause })
  const unrecorded = recordCursorRun(open.stateRoot, open.agentId, { runId: run.id, pid: process.pid, startedAt: performance.timeOrigin })
  if (unrecorded) log("warn", `the run is not recorded, so a later child cannot expire it if this one dies: ${unrecorded}`)
  return run
}

/** A run that ended in this child; one whose end is unknown stays recorded. */
function settleRun(open: OpenAgent, runId: string): void {
  try {
    settleCursorRun(open.stateRoot, open.agentId, runId)
  } catch (cause) {
    log("warn", `the ended run's record was kept: ${cursorSdkWireError(cause).message}`)
  }
}

async function send(params: SendParams): Promise<SdkResult<"send">> {
  const open = agent
  if (!open) throw new ConfigurationError("No agent is open in this child")
  if (active || sending) throw new AgentBusyError("A turn is already running in this session")
  if (closing) throw new ConfigurationError("This session is closing")
  if (params.model) open.model = params.model
  const message = { text: params.text, images: params.images }
  const onDelta = ({ update }: { update: { type: string; text?: string; event?: unknown } }) => {
    switch (update.type) {
      case "text-delta":
      case "thinking-delta":
        write({ event: "delta", turn: params.turn, delta: { type: update.type, text: update.text ?? "" } })
        return
      case "thinking-completed":
      case "turn-ended": {
        const text = JSON.stringify({ event: "delta", turn: params.turn, delta: { type: update.type } } satisfies SdkChildLine)
        writeText(text)
        remember(params.turn, text)
        return
      }
      case "summary-started":
      case "summary-completed":
        write({ event: "delta", turn: params.turn, delta: { type: update.type } })
        return
      case "shell-output-delta": {
        const chunk = ShellChunkSchema.safeParse(update.event)
        if (chunk.success) bufferShellOutput(params.turn, chunk.data.value.data)
        return
      }
      // Tool calls, steps, usage and the compaction summary (a `task`
      // message) arrive whole on the run's message stream. A subagent's own
      // progress rides `tool-call-delta` and is not shown until its call completes.
      case "summary":
      case "tool-call-started":
      case "tool-call-delta":
      case "tool-call-completed":
      case "partial-tool-call":
      case "token-delta":
      case "step-started":
      case "step-completed":
      case "user-message-appended":
        return
      default:
        if (unknownDeltas.has(update.type)) return
        unknownDeltas.add(update.type)
        write({ event: "delta", turn: params.turn, delta: { type: "unhandled", kind: update.type } })
    }
  }
  const options = { model: params.model, mode: params.plan ? ("plan" as const) : ("agent" as const), onDelta }
  sending = params.turn
  cancelWhileSending = false
  try {
    const run = await startRun(open, message, options)
    let finish = () => {}
    const finished = new Promise<void>(resolve => { finish = resolve })
    active = { turn: params.turn, run, finished, replay: [], replayCharacters: 0, replayTruncated: false, messages: 0 }
    void pump(open, params.turn, run).then(finish, cause => {
      log("warn", `run projection ended early: ${cursorSdkWireError(cause).message}`)
      finish()
    })
    if (cancelWhileSending) await run.cancel().catch((cause) => log("warn", `could not stop a run Stop asked for while it started: ${cursorSdkWireError(cause).message}`))
    return { runId: run.id }
  } finally {
    sending = undefined
    cancelWhileSending = false
  }
}

/**
 * What this child is running, for a host that may have lost track of it.
 * The turn's remembered lines are written again first, so the host sees the
 * turn from its start before anything new arrives.
 */
function activeTurn(): SdkResult<"active"> {
  if (active) {
    for (const text of active.replay) writeText(text)
    return { turn: active.turn, runId: active.run.id, truncated: active.replayTruncated || undefined }
  }
  if (sending) return { turn: sending, starting: true }
  return {}
}

async function steer(text: string): Promise<SdkResult<"steer">> {
  if (!active) throw new ConfigurationError("No turn is running to steer")
  if (!active.run.steer) throw new ConfigurationError("This run cannot be steered")
  return { outcome: await active.run.steer(text) }
}

async function cancel(): Promise<SdkResult<"cancel">> {
  const current = active
  if (current) {
    await current.run.cancel()
    await current.finished
  }
  else if (sending) cancelWhileSending = true
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
  // `auth.status()` reads only the SDK's own key store. The key Mako hands
  // in signs every request just the same, so it is checked against the
  // account it names before the host is told "signed out".
  if (apiKey) {
    try {
      const user = await Cursor.me({ apiKey })
      return { status: "logged-in", email: user.userEmail }
    } catch (error) {
      log("warn", `CURSOR_API_KEY was rejected: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { status: "logged-out" }
}

async function me(): Promise<SdkResult<"me">> {
  const user = await Cursor.me({ apiKey })
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
    case "active":
      return activeTurn()
    case "close":
      return close()
    case "models":
      return { models: await Cursor.models.list({ apiKey }) }
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
  if (request.data.method === "close") process.exit(CURSOR_SDK_EXIT.closed)
}

/** `--headless`: one prompt, its reply's text on stdout, and an exit code that says how the run ended. */
async function runHeadless(spec: SdkHeadlessSpec): Promise<number | "stopped"> {
  let stopped = false
  let run: Run | undefined
  let cancellation: Promise<void> | undefined
  const stop = () => {
    if (!stopped) process.stderr.write("Cursor headless Stop requested; awaiting owned native cleanup.\n")
    stopped = true
    if (run && !cancellation) {
      cancellation = run.cancel()
      // Keep the rejection for the awaited verdict without an unhandled
      // rejection while the native terminal result is still pending.
      void cancellation.catch(() => undefined)
    }
  }
  // Install before open/send: either await can still create native work.
  process.on("SIGTERM", stop)
  try {
    await openAgent({ ...spec, cwd: process.cwd() })
    const open = agent!
    if (stopped) return "stopped"
    run = await startRun(open, { text: spec.prompt }, {
      model: spec.model,
      mode: "agent",
      onDelta: ({ update }) => {
        if (update.type === "text-delta" && update.text) process.stdout.write(update.text)
      },
    })
    if (stopped) stop()
    const result = await run.wait()
    settleRun(open, run.id)
    await cancellation
    if (stopped) return "stopped"
    if (result.status === "finished") return 0
    process.stderr.write(`\n${result.error?.message ?? `Cursor's run ended ${result.status}`}\n`)
    return 1
  } finally {
    await close()
    process.off("SIGTERM", stop)
  }
}

function headlessMain(raw: string | undefined): void {
  headless = true
  const spec = SdkHeadlessSpecSchema.safeParse(parseLine(raw ?? ""))
  if (!spec.success) {
    process.stderr.write("Cursor's headless run was started without a readable spec\n")
    process.exit(CURSOR_SDK_EXIT.fatal)
  }
  process.on("uncaughtException", (cause) => fatal("exception", cause))
  process.on("unhandledRejection", (cause) => fatal("rejection", cause))
  configureRipgrep()
  guardShellFolder(() => agent?.cwd, () => undefined)
  void runHeadless(spec.data).then((code) => {
    // Signal after cleanup, without racing a synchronous process.exit(0).
    // Failed cancellation remains failed rather than claiming a clean Stop.
    if (code === "stopped") process.kill(process.pid, "SIGTERM")
    else process.exit(code)
  }, (cause) => {
    process.stderr.write(`\n${cursorSdkWireError(cause).message}\n`)
    process.exit(1)
  })
}

function main(): void {
  process.title = "mako-cursor-sdk"
  // Anything the SDK prints belongs on stderr; stdout is the protocol.
  console.log = (...args) => console.error(...args)
  console.info = (...args) => console.error(...args)
  console.debug = (...args) => console.error(...args)
  if (process.argv[2] === CURSOR_SDK_HEADLESS) return headlessMain(process.argv[3])
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    if (!line.trim()) return
    void handle(line)
  })
  lines.on("close", () => {
    // The host is gone; SDK cancellation or store disposal must not retain us.
    const deadline = setTimeout(() => process.exit(CURSOR_SDK_EXIT.closeTimedOut), 5_000)
    deadline.unref()
    void close().finally(() => process.exit(CURSOR_SDK_EXIT.closed))
  })
  // Never report a broken protocol pipe through that same pipe: doing so from
  // uncaughtException produces an endless EPIPE/error/log loop after host exit.
  // Request-level errors are handled above; an uncaught failure is fatal and
  // reported at most once, so a broken stdout cannot feed its own report.
  process.stdin.on("error", () => process.exit(CURSOR_SDK_EXIT.stdinError))
  process.stdout.on("error", () => process.exit(CURSOR_SDK_EXIT.stdoutError))
  process.stderr.on("error", () => process.exit(CURSOR_SDK_EXIT.stderrError))
  process.on("uncaughtException", (cause) => fatal("exception", cause))
  process.on("unhandledRejection", (cause) => fatal("rejection", cause))
  configureRipgrep()
  guardShellFolder(() => agent?.cwd, (message) => log("warn", message))
}

main()
