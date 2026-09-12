import { CodexAgents } from "./providers/codex/agents.js"
import { codexServiceTier } from "@mako/sessions/model-catalog"
import type { SessionSettings } from "@mako/sessions/settings"
import { codexWireSettings } from "./providers/codex/settings.js"
import { codexInput } from "./providers/codex/input.js"
import type {
  ProviderSteerInput,
  ProviderSteerResult,
} from "./providers/live-driver.js"
import { resolveCodexExecutable } from "./providers/codex/executable.js"
import type { ConversationTools, ProviderStartOptions } from "./providers/live-driver.js"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { StringDecoder } from "node:string_decoder"
import { app } from "electron"
import { accountEnv } from "./accounts.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { environmentForExecutable } from "./executable.js"
import { codexMcpConfig, mergeCodexConfig } from "./mcp-runtime.js"
import {
  clearTurnServerRequests,
  handleServerRequest,
  resolvePermission,
  resolveServerRequest,
  type PendingServerRequest,
  type PermissionCallbacks,
} from "./codex-app-permissions.js"
import { codexAccessModes, codexAccessTier, codexTurnAccess } from "./providers/codex/access.js"
import type { AccessTier } from "./contracts/access.js"
import { boundedText, type JsonObject } from "./codex-app-json.js"
import {
  consumeStdout,
  replayHistory,
  rpcRequest,
  sendRpc,
  sendRpcError,
  sendRpcResult,
} from "./codex-app-protocol.js"
import type {
  ItemTracker,
  PendingRpc,
  ProtocolCallbacks,
  RpcParams,
  ThreadResponse,
  Tuning,
} from "./codex-app-types.js"
import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveUpdate,
  LiveDriverEvent,
  McpRegistrySnapshot,
} from "./shared.js"
import { trackProviderChild } from "./provider-children.js"

type Live = {
  id: string
  cwd: string
  child: ChildProcessWithoutNullStreams
  threadId: string | null
  promptSequence: number
  currentTurnId: string | null
  /** The chosen tier; sent with every turn/start and kept by Codex afterwards. */
  access: AccessTier | null
  state: LiveSessionState
  tuning?: Tuning
  conversationToolsUrl?: string
  control?: ConversationTools["control"]
  mcpSnapshot: McpRegistrySnapshot
  nextRequestId: number
  pending: Map<string, PendingRpc>
  serverRequests: Map<string, PendingServerRequest>
  items: Map<string, ItemTracker>
  stdoutBuffer: string
  stderrBuffer: string
  decoder: StringDecoder
  agents: CodexAgents
  protocol: ProtocolCallbacks
  startupTimer: ReturnType<typeof setTimeout> | null
  replayUpdates: LiveUpdate[] | null
  exited: boolean
}

const STARTUP_TIMEOUT_MS = 10_000
const MAX_STDERR_BUFFER = 16 * 1024
const MAX_PROMPT_CHARS = 1_000_000
const sessions = new Map<string, Live>()
let sendEvent: (event: LiveDriverEvent) => void = () => {}

const permissionCallbacks: PermissionCallbacks<Live> = {
  emit: (_live, event) => emit(event),
  sendResult: (live, id, result) => sendRpcResult(live, id, result),
  sendError: (live, id, code, message) => sendRpcError(live, id, code, message),
}

export function bindCodexApp(send: (event: LiveDriverEvent) => void): void {
  sendEvent = send
}

export function codexAppState(id: string): LiveSessionState | null {
  return sessions.get(id)?.state ?? null
}

export async function codexAppStart(
  cwd: string,
  options: ProviderStartOptions
): Promise<LiveSessionState> {
  const id = options.conversationId
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
  const mcpSnapshot = await (options.mcpSnapshot?.() ?? discoverMcpRegistry(workingDir, app.getAppPath()))
  const env = await accountEnv("codex", process.env)
  if (options.conversationTools)
    env.MAKO_CONVERSATIONS_TOKEN = options.conversationTools.token
  const executable = await resolveCodexExecutable(env)
  if (!executable) throw new Error("Codex is not installed")
  const child = spawn(executable, ["app-server"], {
    cwd: workingDir,
    env: environmentForExecutable(executable, env),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  trackProviderChild(child, { kind: "codex:app-server", owner: id })
  const live: Live = {
    id,
    cwd: workingDir,
    child,
    threadId: null,
    promptSequence: 0,
    currentTurnId: null,
    access: null,
    state: {
      id,
      harness: "codex",
      cwd: workingDir,
      title: options.title,
      status: "starting",
      connection: "starting",
      modes: codexAccessModes(),
      currentMode: null,
      configOptions: [],
    },
    tuning: options.tuning,
    conversationToolsUrl: options.conversationTools?.url,
    control: options.conversationTools?.control,
    mcpSnapshot,
    nextRequestId: 0,
    pending: new Map(),
    serverRequests: new Map(),
    items: new Map(),
    stdoutBuffer: "",
    stderrBuffer: "",
    decoder: new StringDecoder("utf8"),
    agents: new CodexAgents(),
    protocol: {
      handleFatal: (message) => protocolFatal(live, message),
      updateState: (patch) => updateState(live, patch),
      emitUpdate: (update) => emitUpdate(live, update),
      observeAgents: (item, replay) => {
        for (const agent of live.agents.project(item, replay))
          emit({ type: "acp-agent", id: live.id, agent })
      },
      handleServerRequest: (rpcId, method, params) =>
        handleServerRequest(live, permissionCallbacks, rpcId, method, params),
      resolveServerRequest: (rpcId) => resolveServerRequest(live, rpcId),
      clearTurnServerRequests: (turnId) =>
        clearTurnServerRequests(live, turnId),
    },
    startupTimer: null,
    replayUpdates: null,
    exited: false,
  }
  sessions.set(id, live)
  bindProcess(live)

  const startup = new Promise<never>((_, reject) => {
    live.startupTimer = setTimeout(
      () =>
        reject(new Error("Codex app-server did not start within 10 seconds")),
      STARTUP_TIMEOUT_MS
    )
  })
  try {
    const response = await Promise.race([
      openThread(live, options.resume, options.fork),
      startup,
    ])
    clearStartupTimer(live)
    live.threadId = response.thread.id
    if (response.thread.cwd !== undefined) live.cwd = response.thread.cwd
    const replayUpdates: LiveUpdate[] = []
    live.replayUpdates = replayUpdates
    try {
      replayHistory(live, response.thread.turns ?? [])
    } finally {
      live.replayUpdates = null
    }
    if (replayUpdates.length > 0)
      emit({ type: "acp-updates", id: live.id, updates: replayUpdates })
    const settings: SessionSettings = { model: response.model, options: {} }
    if (response.reasoningEffort)
      settings.options!.effort = response.reasoningEffort
    if (response.serviceTier !== undefined)
      settings.options!.serviceTier = codexServiceTier(
        response.serviceTier ?? "default"
      )
    updateState(live, {
      nativeId: response.thread.id,
      settings,
      status: "ready",
      connection: "connected",
      cwd: live.cwd,
      error: undefined,
    })
    return live.state
  } catch (error) {
    clearStartupTimer(live)
    const fallback =
      lastLine(live.stderrBuffer) || "Codex app-server failed to start"
    const message =
      error instanceof Error && error.message ? error.message : fallback
    failLive(live, message)
    sessions.delete(id)
    if (!child.killed) child.kill()
    throw new Error(message, { cause: error })
  }
}

export async function codexAppPrompt(
  id: string,
  text: string,
  attachments: PromptAttachment[] = [],
  tuning?: Tuning
): Promise<void> {
  const live = sessions.get(id)
  if (!live?.threadId || live.exited)
    throw new Error("This Codex session is not running")
  if (live.state.status === "running")
    throw new Error("Codex is already working")
  if (!text.trim() && !attachments.length)
    throw new Error("A prompt cannot be empty")
  if (text.length > MAX_PROMPT_CHARS)
    throw new Error("The prompt is too large for the Codex app-server adapter")

  const sequence = ++live.promptSequence
  updateState(live, {
    status: "running",
    nativeRunId: undefined,
    error: undefined,
    lastStop: undefined,
  })
  emitUpdate(live, { kind: "user", text })
  try {
    const result = await rpcRequest(live, "turn/start", {
      threadId: live.threadId,
      input: codexInput(text, attachments),
      cwd: live.cwd,
      ...codexWireSettings(tuning),
      ...codexTurnAccess(live.access),
    })
    if (live.promptSequence === sequence) {
      const settings: SessionSettings = {
        ...live.state.settings,
        options: { ...live.state.settings?.options, ...tuning?.options },
      }
      if (tuning?.model) settings.model = tuning.model
      updateState(live, { settings })
      if (isRunning(live)) {
        live.currentTurnId = result.turn.id
        updateState(live, { nativeRunId: result.turn.id })
      }
    }
  } catch (error) {
    if (live.promptSequence !== sequence) return
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Codex rejected the turn"
    updateState(live, { status: "failed", error: message, lastStop: "failed" })
    throw new Error(message, { cause: error })
  }
}

/** Takes effect on the next turn/start; Codex has no mid-turn policy switch. */
export function codexAppSetMode(id: string, modeId: string): void {
  const live = sessions.get(id)
  if (!live || live.exited) throw new Error("This Codex session is not running")
  live.access = codexAccessTier(modeId)
  updateState(live, { currentMode: modeId })
}

export function codexAppPermission(
  id: string,
  requestId: string,
  response: LivePermissionResponse
): void {
  const live = sessions.get(id)
  if (!live) return
  resolvePermission(live, permissionCallbacks, requestId, response)
}

export async function codexAppCancel(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.threadId || !live.currentTurnId || live.exited) return
  await rpcRequest(live, "turn/interrupt", {
    threadId: live.threadId,
    turnId: live.currentTurnId,
  })
}

export async function codexAppSteer(
  id: string,
  input: ProviderSteerInput
): Promise<ProviderSteerResult> {
  const live = sessions.get(id)
  if (
    !live?.threadId ||
    live.exited ||
    live.state.status !== "running" ||
    live.currentTurnId !== input.expectedRunId
  )
    return {
      kind: "not-accepted",
      reason: "The selected Codex turn is no longer active",
    }
  const result = await rpcRequest(live, "turn/steer", {
    threadId: live.threadId,
    expectedTurnId: input.expectedRunId,
    clientUserMessageId: input.id,
    input: codexInput(input.text, input.attachments),
  })
  if (result.turnId !== input.expectedRunId)
    throw new Error("Codex acknowledged steering for a different turn")
  return { kind: "accepted" }
}

export async function codexAppCompact(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.threadId || live.exited || live.state.status !== "ready")
    throw new Error("Wait for Codex to become idle before compacting")
  updateState(live, {
    status: "running",
    nativeRunId: undefined,
    lastStop: undefined,
    error: undefined,
  })
  await rpcRequest(live, "thread/compact/start", { threadId: live.threadId })
}

export function codexAppClose(id: string): void {
  const live = sessions.get(id)
  if (!live) return
  updateState(live, { status: "closed" })
  sessions.delete(id)
  disposeLive(live, new Error("Codex session closed"))
  if (!live.child.killed) live.child.kill()
}

export function stopCodexApps(): void {
  for (const id of sessions.keys()) codexAppClose(id)
}

async function openThread(
  live: Live,
  resume?: string,
  fork?: { nativeId: string; runId: string }
): Promise<ThreadResponse> {
  await rpcRequest(live, "initialize", {
    clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  sendRpc(live, { jsonrpc: "2.0", method: "initialized" })
  const tuning = threadTuning(
    live.tuning,
    codexMcpConfig(
      live.mcpSnapshot,
      live.conversationToolsUrl,
      live.control,
      live.id
    )
  )
  if (fork)
    return rpcRequest(live, "thread/fork", {
      threadId: fork.nativeId,
      lastTurnId: fork.runId,
      cwd: live.cwd,
      ...tuning,
    })
  return resume
    ? rpcRequest(live, "thread/resume", {
        threadId: resume,
        cwd: live.cwd,
        ...tuning,
      })
    : rpcRequest(live, "thread/start", { cwd: live.cwd, ...tuning })
}

function threadTuning(
  tuning: Tuning | undefined,
  mcpConfig: JsonObject
): Omit<RpcParams["thread/start"], "cwd"> {
  const result: Omit<RpcParams["thread/start"], "cwd"> = {}
  const selected = codexWireSettings(tuning)
  const base = selected.effort
    ? { model_reasoning_effort: selected.effort }
    : undefined
  const config = mergeCodexConfig(base, mcpConfig)
  if (selected.model) result.model = selected.model
  if (selected.serviceTier !== undefined)
    result.serviceTier = selected.serviceTier
  if (config) result.config = config
  return result
}

function bindProcess(live: Live): void {
  live.child.stdin.on("error", (error) => handleProcessEnd(live, error.message))
  live.child.stdout.on("data", (chunk: Buffer) => consumeStdout(live, chunk))
  live.child.stderr.on("data", (chunk: Buffer) => {
    live.stderrBuffer = tail(
      live.stderrBuffer + chunk.toString("utf8"),
      MAX_STDERR_BUFFER
    )
  })
  live.child.on("error", (error) => handleProcessEnd(live, error.message))
  live.child.on("exit", (code, signal) => {
    const detail = lastLine(live.stderrBuffer)
    const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
    handleProcessEnd(live, detail || `codex app-server exited with ${suffix}`)
  })
}

function protocolFatal(live: Live, message: string): void {
  handleProcessEnd(live, message)
  if (!live.child.killed) live.child.kill()
}

function handleProcessEnd(live: Live, message: string): void {
  if (live.exited) return
  const wasClosed = live.state.status === "closed"
  disposeLive(live, new Error(message))
  if (!wasClosed)
    updateState(live, {
      status: "failed",
      connection: "disconnected",
      error: message,
    })
}

function failLive(live: Live, message: string): void {
  if (!live.exited) disposeLive(live, new Error(message))
  if (live.state.status !== "closed")
    updateState(live, {
      status: "failed",
      connection: "disconnected",
      error: message,
    })
}

function disposeLive(live: Live, error: Error): void {
  if (live.exited) return
  live.exited = true
  clearStartupTimer(live)
  for (const pending of live.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  live.pending.clear()
  live.serverRequests.clear()
  live.items.clear()
  live.stdoutBuffer = ""
  live.decoder.end()
}

function clearStartupTimer(live: Live): void {
  if (live.startupTimer) clearTimeout(live.startupTimer)
  live.startupTimer = null
}

function updateState(live: Live, patch: Partial<LiveSessionState>): void {
  live.state = { ...live.state, ...patch }
  emit({ type: "acp-session", session: live.state })
}

function emitUpdate(live: Live, update: LiveUpdate): void {
  if (
    (update.kind === "text" ||
      update.kind === "thinking" ||
      update.kind === "user") &&
    !update.text
  )
    return
  if (live.replayUpdates) {
    live.replayUpdates.push(update)
    return
  }
  emit({ type: "acp-update", id: live.id, update })
}

function emit(event: LiveDriverEvent): void {
  try {
    sendEvent(event)
  } catch {
    return
  }
}

function isRunning(live: Live): boolean {
  return live.state.status === "running"
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean)
  return boundedText(lines[lines.length - 1] ?? "", 500)
}
