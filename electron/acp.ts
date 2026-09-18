import { z } from "zod"
import { randomUUID } from "node:crypto"
import type { ProviderStartOptions, ProviderSteerInput, ProviderSteerResult } from "./providers/live-driver.js"
import { createLiveEngine } from "./live-engine.js"
import { AcpPromptTurn } from "./acp-prompt-turn.js"
import { AcpCompaction } from "./acp-compaction.js"
import { turnVerdict } from "./acp-turn-verdict.js"
import { openAuthenticatedSession } from "./acp-authentication.js"
import { acpDefaultMode, acpInitialSelection, acpModeChange, acpNativeModes, acpSessionModes } from "./acp-access.js"
import type { AcpLaunchOptions } from "./providers/acp-source.js"
import { accessTierOfModeId, hostAccessDecision, type AccessTier } from "./contracts/access.js"
/**
 * Interactive foreign agents, over ACP.
 *
 * The reply drivers run a harness's CLI headlessly — fine for one more turn,
 * blind for real work: no streaming, no steering, and tool approvals decided
 * in advance. ACP (the Agent Client Protocol) is the other mode: the agent
 * runs as a subprocess speaking JSON-RPC over stdio, streams every thought
 * and tool call as it happens, and *asks* before doing anything its mode
 * does not already allow — which is exactly the part headless running gives
 * up. Claude Code ships an official adapter; Grok, Devin and OpenCode speak
 * it natively.
 *
 * This host keeps the protocol entirely on this side of the IPC boundary.
 * The renderer sees three things: a session (status, modes), a stream of
 * updates (text, thinking, tool calls, plan), and the occasional permission
 * or structured-input request it must answer. Everything else — handshakes, schema versions,
 * process lifecycle — stays here.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { acpReadable, acpWritable } from "./acp-stream.js"
import { app } from "electron"
import {
  ClientSideConnection,
  CreateElicitationRequest as ElicitationRequest,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ClientSideConnection as Connection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import { accountEnv } from "./accounts.js"
import { AcpStartupWatch, stderrDetail } from "./acp-startup.js"
import { hostLog, hostWarn } from "./host-log.js"
import { trackProviderChild } from "./provider-children.js"
import { errorMessage } from "./live-runtime.js"
import { basename } from "node:path"
import { acpObservedSettings, applyAcpSettings } from "./acp-config.js"
import { elicitationContent, elicitationQuestion } from "./acp-elicitation.js"
import { forward } from "./acp-notifications.js"
import { normalizeAcpOptions } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import type { AcpTuning } from "./providers/acp-source.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { environmentForExecutable, resolveExecutable } from "./executable.js"
import { acpMcpServers } from "./mcp-runtime.js"
import type { McpTransport } from "./shared.js"
import type {
  LiveInputQuestion,
  LivePermissionRequest,
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveDriverEvent,
} from "./shared.js"

interface OpenedAcpSession {
  sessionId: string
  modes: SessionModeState | null
  model?: string
  configOptions: SessionConfigOption[]
}

interface LegacySessionModelRequest {
  sessionId: string
  modelId: string
}

interface Live {
  compaction?: AcpCompaction
  id: string
  harness: string
  cwd: string
  emit(event: LiveDriverEvent): void
  child: ChildProcessWithoutNullStreams
  connection: Connection | null
  sessionId: string | null
  state: LiveSessionState
  pendingPermissions: Map<string, (response: LivePermissionResponse) => void>
  startup: AbortController
  promptCapabilities: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  configOptions: SessionConfigOption[]
  mcpServers: McpServer[]
  turn: AcpPromptTurn | null
  /** The tier the host enforces by answering permission requests. */
  hostAccess: AccessTier | null
  /** The tier the process was launched with, for providers that read it at start. */
  launchAccess: AccessTier | null
  /** The provider's own current mode, as it last reported it. */
  nativeMode: string | null
}

const engine = createLiveEngine<Live>()
const sessions = engine.sessions
let emit: (event: LiveDriverEvent) => void = () => {}


export function bindAcp(send: (event: LiveDriverEvent) => void): void {
  emit = send
}

async function requestElicitation(
  live: Live,
  params: CreateElicitationRequest
): Promise<CreateElicitationResponse> {
  if (!ElicitationRequest.isForm(params)) return { action: "cancel" }
  const required = new Set(params.requestedSchema.required ?? [])
  const questions = Object.entries(params.requestedSchema.properties ?? {})
    .map(([id, property]) =>
      elicitationQuestion(id, property, required.has(id))
    )
    .filter((question) => question !== null)
  if (
    questions.length !==
    Object.keys(params.requestedSchema.properties ?? {}).length
  )
    return { action: "cancel" }
  const response = await askUser(live, params.message, questions)
  if (response.kind !== "answers") return { action: "decline" }
  const content = elicitationContent(questions, response.answers)
  return content ? { action: "accept", content } : { action: "decline" }
}

/**
 * Put questions to the user on the conversation's question card and wait.
 * A closed session answers every open question with a dismissal.
 */
async function askUser(
  live: Live,
  title: string,
  questions: LiveInputQuestion[]
): Promise<LivePermissionResponse> {
  const requestId = `${live.id}-input-${live.pendingPermissions.size}-${Date.now()}`
  const request: LivePermissionRequest = {
    id: requestId,
    sessionId: live.id,
    title,
    options: [],
    questions,
  }
  return engine.ask(live, request)
}

export function acpState(id: string): LiveSessionState | null {
  return engine.state(id)
}

/**
 * Start an interactive agent in `cwd`. With `resume`, the agent loads that
 * native session instead of starting empty — Claude Code's adapter supports
 * this, which makes "keep working on this exact session, interactively" real
 * rather than a transcript hand-off.
 */
export async function liveStart(
  harness: string,
  cwd: string,
  options: ProviderStartOptions
): Promise<LiveSessionState> {
  const source = providerHost.acpSources.get(harness)
  const policy = source?.access
  const requestedAccess = options.modeId ? accessTierOfModeId(options.modeId) : null
  // A chosen launch tier wins; a stale one falls back to the provider's
  // declared default so the process always launches at the level the desk
  // will report, never at a leftover configuration the user cannot see.
  const launchTier =
    requestedAccess && policy?.launch?.includes(requestedAccess)
      ? requestedAccess
      : policy?.default
  const launchAccess =
    launchTier && policy?.launch?.includes(launchTier) ? launchTier : null
  const launchOptions: AcpLaunchOptions = {
    appPath: app.getAppPath(),
    execPath: process.execPath,
    resume: options.resume,
    tuning: options.tuning,
  }
  if (launchAccess) launchOptions.access = launchAccess
  const spec = await source?.launch(launchOptions)
  if (!spec) throw new Error(`${harness} does not speak ACP here yet`)

  const id = options.conversationId
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
  const mcpSnapshot = await (options.mcpSnapshot?.() ?? discoverMcpRegistry(workingDir, app.getAppPath()))

  // The nested-session guard: Claude Code refuses to start inside another
  // Claude Code. Mako is not one, but it may have been *launched from* one,
  // and the variable would be inherited. The selected account's config home
  // rides in the same way it does for headless runs.
  const env = await accountEnv(harness, process.env)
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  spec.configureEnvironment(env)
  const executable = resolveExecutable(spec.command, env)
  if (!executable) throw new Error(`${harness} is not installed`)

  const conversationMcp: McpServer | null = options.conversationTools ? {
    type: "http",
    name: "mako-conversations",
    url: options.conversationTools.url,
    headers: [{ name: "Authorization", value: `Bearer ${options.conversationTools.token}` }],
  } : null
  const preparedServers = acpMcpServers(mcpSnapshot, harness, ["stdio", "http", "sse"], options.conversationTools?.control, id)
  if (conversationMcp) preparedServers.push(conversationMcp)
  const disposeMcp = await spec.prepareMcp?.(preparedServers, env)
  const child = spawn(executable, spec.args, {
    cwd: workingDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: environmentForExecutable(executable, env),
  })

  child.once("close", () => {
    void disposeMcp?.().catch(() => console.error("Provider MCP configuration cleanup failed"))
  })

  const live: Live = {
    id,
    harness,
    cwd: workingDir,
    child,
    connection: null,
    sessionId: null,
    state: {
      id,
      harness,
      cwd: workingDir,
      title: options.title,
      status: "starting",
      connection: "starting",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    pendingPermissions: new Map(),
    startup: new AbortController(),
    promptCapabilities: {},
    configOptions: [],
    mcpServers: [],
    turn: null,
    hostAccess: null,
    launchAccess,
    nativeMode: null,
    emit: (event) => emit(event),
  }
  sessions.set(id, live)

  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  const watch = new AcpStartupWatch(child, { harness, stderr: () => stderr })
  trackProviderChild(child, { kind: `acp:${harness}`, owner: id })
  hostLog("acp", "spawned", {
    harness,
    conversation: id,
    pid: child.pid,
    command: basename(executable),
    args: spec.args.join(" "),
    cwd: workingDir,
    resume: options.resume,
    mcpServers: preparedServers.length,
  })
  child.on("exit", (code, signal) => {
    live.compaction?.dispose()
    live.startup.abort()
    hostLog("acp", "exited", {
      harness,
      conversation: id,
      pid: child.pid,
      code,
      signal,
      status: live.state.status,
      stderr: stderrDetail(stderr),
    })
    engine.release(live)
    if (live.state.status === "closed") return
    update(live, {
      status: "failed",
      connection: "disconnected",
      error:
        stderrDetail(stderr) ||
        `${spec.command} exited${signal ? ` on ${signal}` : code === null ? "" : ` with code ${code}`}`,
    })
  })

  const client: Client = {
    async requestPermission(params: RequestPermissionRequest) {
      // The selected access tier answers first. It never answers a question
      // (options outside allow/reject) and prefers once-scoped grants, so a
      // stricter tier chosen later is honoured by the agent's next ask.
      const decided = hostAccessDecision(live.hostAccess, {
        toolKind: params.toolCall?.kind ?? undefined,
        options: params.options,
      })
      if (decided !== null)
        return { outcome: { outcome: "selected" as const, optionId: decided } }
      const requestId = `${id}-perm-${live.pendingPermissions.size}-${Date.now()}`
      const request: LivePermissionRequest = {
        id: requestId,
        sessionId: id,
        title:
          params.toolCall?.title ??
          spec.permissionTitle?.(params) ??
          "The agent wants to use a tool",
        kind: params.toolCall?.kind ?? undefined,
        options: params.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
        })),
      }
      const response = await engine.ask(live, request)
      const chosen = response.kind === "choice" ? response.optionId : null
      if (chosen === null) return { outcome: { outcome: "cancelled" as const } }
      return { outcome: { outcome: "selected" as const, optionId: chosen } }
    },
    async unstable_createElicitation(params: CreateElicitationRequest) {
      return requestElicitation(live, params)
    },
    async sessionUpdate(params: SessionNotification) {
      if (live.sessionId && params.sessionId !== live.sessionId) return
      live.compaction?.observe(params.update)
      if (params.update.sessionUpdate === "config_option_update") live.configOptions = params.update.configOptions
      if (params.update.sessionUpdate === "current_mode_update") {
        acpObserveNativeMode(id, params.update.currentModeId)
        return
      }
      if (params.update.sessionUpdate === "usage_update") {
        const reading = params.update
        update(live, {
          usage: {
            used: reading.used,
            size: reading.size,
            cost: reading.cost
              ? { amount: reading.cost.amount, currency: reading.cost.currency }
              : undefined,
          },
        })
        return
      }
      if (params.update.sessionUpdate === "available_commands_update") {
        update(live, {
          commands: params.update.availableCommands.map((command) => ({
            name: command.name,
            description: command.description || undefined,
            hint: command.input?.hint ? String(command.input.hint) : undefined,
          })),
        })
        return
      }
      forward(live, params, emit, update, live.state.settings)
    },
  }

  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout))
  )
  live.connection = connection

  try {
    const initialized = await watch.step("initialize", connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          session: { configOptions: { boolean: {} } },
          elicitation: { form: {} },
          ...providerHost.acpSources.get(harness)?.clientCapabilities,
        },
      }))
    live.promptCapabilities =
      initialized.agentCapabilities?.promptCapabilities ?? {}
    const mcpCapabilities = initialized.agentCapabilities?.mcpCapabilities
    const transports: McpTransport[] = ["stdio"]
    if (mcpCapabilities?.http) transports.push("http")
    if (mcpCapabilities?.sse) transports.push("sse")
    live.mcpServers = providerHost.mcpSources.get(harness)
      ? acpMcpServers(
          mcpSnapshot,
          harness,
          transports,
          options.conversationTools?.control,
          id
        )
      : []
    if (conversationMcp && mcpCapabilities?.http) live.mcpServers.push(conversationMcp)
    const session = await openAuthenticatedSession({
      methods: initialized.authMethods ?? [],
      signal: live.startup.signal,
      select: async (methods) => {
        const requestId = `${id}-authenticate-${Date.now()}`
        const request: LivePermissionRequest = {
          id: requestId, sessionId: id, kind: "authentication",
          title: `${harness} requires sign-in before opening this session. Choose the provider's sign-in method to continue.`,
          options: methods.map((method) => ({ optionId: method.id, name: method.name, kind: "allow_once" })),
        }
        const response = await engine.ask(live, request)
        return response.kind === "choice" ? response.optionId : null
      },
      authenticate: async (methodId) => {
        await connection.authenticate({ methodId })
      },
      open: async () => options.resume
        ? parseLoadedAcpSession(
            await watch.step("session/load", connection.loadSession(
                loadSessionRequest(
                  options.resume,
                  workingDir,
                  harness,
                  options.tuning,
                  live.mcpServers
                )
              )),
            options.resume
          )
        : parseNewAcpSession(
            await watch.step("session/new", connection.newSession(
                newSessionRequest(
                  workingDir,
                  harness,
                  options.tuning,
                  live.mcpServers
                )
              ))
          ),
    })
    live.sessionId = session.sessionId
    live.configOptions = session.configOptions
    live.state.settings = acpObservedSettings(live.configOptions, session.model)
    const applied = await applyTuning(live, options.tuning, true)
    // Providers that moved their mode vocabulary to a config option send no
    // session.modes; the option is the same fact in another field.
    const sessionModes = session.modes ?? acpNativeModes(live.configOptions)
    const modes = acpSessionModes(policy, sessionModes)
    const effectiveModeId =
      options.modeId && modes.some((mode) => mode.id === options.modeId)
        ? options.modeId
        : acpDefaultMode(policy)
    const selection = acpInitialSelection(policy, modes, sessionModes, effectiveModeId)
    live.nativeMode = sessionModes?.currentModeId ?? null
    live.hostAccess = selection.hostTier
    // A host-enforced tier runs on the provider's base mode; a session that
    // opened elsewhere (a resumed plan-mode session, say) is moved there first.
    if (selection.hostTier && policy?.base && live.nativeMode !== policy.base) {
      await connection.setSessionMode({ sessionId: session.sessionId, modeId: policy.base })
      live.nativeMode = policy.base
    }
    update(live, {
      nativeId: session.sessionId,
      status: "ready",
      connection: "connected",
      modes,
      currentMode: selection.currentMode,
      configOptions: normalizeAcpOptions(applied.options),
      settings: applied.settings,
    })
    watch.dispose()
    hostLog("acp", "ready", {
      harness,
      conversation: id,
      pid: child.pid,
      nativeId: session.sessionId,
      steps: watch.summary(),
      model: applied.settings.model,
      mode: selection.currentMode,
    })
    return live.state
  } catch (error) {
    // The agent's stderr explains a death; it does not explain a refusal
    // raised on this side. Devin traces every dispatch to stderr at INFO, so
    // preferring stderr here once replaced "cannot change effort" with a
    // timing line and the real cause was invisible.
    const died = child.exitCode !== null || child.signalCode !== null
    watch.dispose()
    const message =
      error instanceof Error ? errorMessage({ error }) : `The ${harness} agent failed to start`
    const surfaced = (died && stderrDetail(stderr)) || message
    hostWarn("acp", "start failed", {
      harness,
      conversation: id,
      pid: child.pid,
      error: surfaced,
      steps: watch.summary(),
      exited: died,
      code: child.exitCode,
      signal: child.signalCode,
      stderr: stderr.slice(-600),
    })
    await liveClose(id)
    throw new Error(surfaced, { cause: error })
  }
}

function newSessionRequest(
  cwd: string,
  harness: string,
  tuning: AcpTuning | undefined,
  mcpServers: NewSessionRequest["mcpServers"]
): NewSessionRequest {
  const request: NewSessionRequest = { cwd, mcpServers }
  if (tuning) request._meta = providerHost.acpSources.get(harness)?.sessionMetadata?.(tuning)
  return request
}

function loadSessionRequest(
  sessionId: string,
  cwd: string,
  harness: string,
  tuning: AcpTuning | undefined,
  mcpServers: LoadSessionRequest["mcpServers"]
): LoadSessionRequest {
  const request: LoadSessionRequest = { sessionId, cwd, mcpServers }
  if (tuning) request._meta = providerHost.acpSources.get(harness)?.sessionMetadata?.(tuning)
  return request
}

const LegacyAcpModelsSchema = z.object({ models: z.object({ currentModelId: z.string() }).nullish() })

function legacyAcpModel(response: NewSessionResponse | LoadSessionResponse): string | undefined {
  const parsed = LegacyAcpModelsSchema.safeParse(response)
  return parsed.success ? parsed.data.models?.currentModelId : undefined
}

function parseNewAcpSession(response: NewSessionResponse): OpenedAcpSession {
  return {
    sessionId: response.sessionId,
    modes: response.modes ?? null,
    model: legacyAcpModel(response),
    configOptions: response.configOptions ?? [],
  }
}

function parseLoadedAcpSession(
  response: LoadSessionResponse,
  sessionId: string
): OpenedAcpSession {
  return {
    sessionId,
    modes: response.modes ?? null,
    model: legacyAcpModel(response),
    configOptions: response.configOptions ?? [],
  }
}

async function applyTuning(live: Live, tuning?: AcpTuning, initial = false) {
  const connection = live.connection
  const sessionId = live.sessionId
  if (!connection || !sessionId) throw new Error("This provider session is not connected")
  const source = providerHost.acpSources.get(live.harness)
  const result = await applyAcpSettings({
    settings: tuning ?? {},
    observed: live.state.settings ?? {},
    options: live.configOptions,
    launchOptionIds: initial ? source?.launchOptionIds : undefined,
    setModel: (model) => setLegacySessionModel(live, model),
    setOption: async (option, value) => {
      const response = value === true || value === false
        ? await connection.setSessionConfigOption({ sessionId, configId: option.id, type: "boolean", value })
        : await connection.setSessionConfigOption({ sessionId, configId: option.id, value })
      return response.configOptions
    },
  })
  live.configOptions = result.options
  return result
}

async function setLegacySessionModel(
  live: Live,
  modelId: string
): Promise<void> {
  const connection = live.connection
  const sessionId = live.sessionId
  if (!connection || !sessionId) return
  await connection.request<void, LegacySessionModelRequest>(
    "session/set_model",
    {
      sessionId,
      modelId,
    }
  )
}

/** Send the next message. Resolves when the provider accepts the turn. */
export async function livePrompt(
  id: string,
  text: string,
  attachments: PromptAttachment[] = [],
  tuning?: AcpTuning
): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection)
    throw new Error("This interactive session is not running")
  if (live.state.status === "running")
    throw new Error("The agent is already working")
  if (live.compaction)
    throw new Error("Compaction is unconfirmed. End the live session before sending again.")
  const compact = providerHost.acpSources.get(live.harness)?.compaction
  if (compact?.kind === "supported" && text.trim() === compact.command && attachments.length === 0) {
    await liveCompact(id, randomUUID())
    return
  }
  const connection = live.connection
  const sessionId = live.sessionId
  let applied: Awaited<ReturnType<typeof applyTuning>>
  try {
    applied = await applyTuning(live, tuning)
  } catch (error) {
    hostWarn("acp", "settings refused", { harness: live.harness, conversation: id, error: errorMessage({ error }) })
    throw error
  }
  if (live.state.status === "closed" || live.turn?.acceptsSteering)
    throw new Error("The session changed while preparing the prompt")
  const turn = new AcpPromptTurn((result) => {
    if (live.turn !== turn || live.state.status === "closed" || live.state.connection === "disconnected") return
    const verdict = turnVerdict(result)
    if (verdict.status === "failed")
      hostWarn("acp", "prompt failed", {
        harness: live.harness,
        conversation: id,
        stop: verdict.lastStop,
        error: verdict.error,
      })
    update(live, verdict)
  })
  live.turn = turn
  update(live, { status: "running", nativeRunId: turn.id, error: undefined, lastStop: undefined, settings: applied.settings, configOptions: normalizeAcpOptions(applied.options) })
  engine.emitUpdate(live, { kind: "user", text })
  const prompt = acpPromptBlocks(text, attachments, live.promptCapabilities)
  void turn.send(() => connection.prompt({ sessionId, prompt })).catch(() => {})
  await Promise.resolve()
}

export async function liveCompact(id: string, actionId: string): Promise<void> {
  const live = sessions.get(id)
  const spec = live && providerHost.acpSources.get(live.harness)?.compaction
  if (!live?.sessionId || !live.connection || spec?.kind !== "supported")
    throw new Error("This connection does not support verified compaction")
  if (live.state.status === "running" || live.compaction)
    throw new Error("Wait for the current operation to finish")
  const connection = live.connection
  const sessionId = live.sessionId
  const operation = new AcpCompaction(spec, (result) => {
    if (live.compaction !== operation || live.state.connection !== "connected") return
    if (result.kind !== "uncertain") live.compaction = undefined
    update(live, { status: result.kind === "completed" ? "ready" : "failed",
      lastStop: result.kind === "completed" ? "completed" : "failed",
      error: result.kind === "completed" ? undefined : result.reason })
    live.emit({ type: "live-action-result", id, actionId, result })
  })
  live.compaction = operation
  update(live, { status: "running", nativeRunId: actionId, lastStop: undefined, error: undefined })
  operation.start(() => connection.prompt({ sessionId, prompt: [{ type: "text", text: spec.command }] }))
}

export async function liveSteer(id: string, input: ProviderSteerInput): Promise<ProviderSteerResult> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection)
    throw new Error("This interactive session is not connected")
  const turn = live.turn
  if (!providerHost.acpSources.get(live.harness)?.steering ||
    live.state.status !== "running" || turn?.id !== input.expectedRunId || !turn.acceptsSteering)
    return { kind: "not-accepted", reason: "The provider turn has already changed or does not support steering" }
  const connection = live.connection
  const sessionId = live.sessionId
  const prompt = acpPromptBlocks(input.text, input.attachments, live.promptCapabilities)
  await turn.send(() => connection.prompt({ sessionId, prompt }), "steer")
  return { kind: "accepted" }
}

function acpPromptBlocks(text: string, attachments: PromptAttachment[], capabilities: Live["promptCapabilities"]): ContentBlock[] {
  const prompt: ContentBlock[] = [{ type: "text", text }]
  for (const attachment of attachments) {
    if (attachment.data && attachment.mimeType.startsWith("image/") && capabilities.image) {
      prompt.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType })
    } else if (attachment.path) {
      prompt.push({
        type: "resource_link", name: attachment.name, uri: pathToFileURL(attachment.path).href,
        mimeType: attachment.mimeType, size: attachment.size,
      })
    }
  }
  return prompt
}

export function acpRespondPermission(
  id: string,
  requestId: string,
  response: LivePermissionResponse
): void {
  engine.respondPermission(id, requestId, response)
}

export async function liveSetMode(id: string, modeId: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection) return
  const policy = providerHost.acpSources.get(live.harness)?.access
  const change = acpModeChange(policy, live.state.modes, modeId, live.launchAccess, live.nativeMode, live.harness)
  if (change.kind === "unchanged") {
    // Back on the tier the process was launched with: the provider enforces
    // it alone again, so the host stops answering on the user's behalf.
    live.hostAccess = null
    update(live, { currentMode: change.modeId })
    return
  }
  const nativeMode = change.kind === "native" ? change.modeId : change.baseMode
  if (nativeMode) {
    await live.connection.setSessionMode({ sessionId: live.sessionId, modeId: nativeMode })
    live.nativeMode = nativeMode
    live.configOptions = live.configOptions.map((option) =>
      option.type === "select" && (option.category === "mode" || option.id === "mode")
        ? { ...option, currentValue: nativeMode } : option
    )
  }
  live.hostAccess = change.hostTier
  update(live, { currentMode: change.modeId, configOptions: normalizeAcpOptions(live.configOptions), settings: acpObservedSettings(live.configOptions, live.state.settings?.model) })
}

/**
 * The agent reported its own mode. While the host enforces a tier on top of
 * the provider's base mode that report is the base and the shown mode stays;
 * any other native switch (the agent entered plan mode, say) ends the host's
 * tier so the picker never shows an access level nobody enforces.
 */
export function acpObserveNativeMode(id: string, nativeMode: string): void {
  const live = sessions.get(id)
  if (!live) return
  live.nativeMode = nativeMode
  const base = providerHost.acpSources.get(live.harness)?.access?.base
  if (live.hostAccess && nativeMode === base) return
  live.hostAccess = null
  update(live, { currentMode: nativeMode })
}

export async function liveCancel(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection) return
  live.turn?.cancel()
  // The protocol requires pending permission requests to settle as cancelled
  // once the client cancels; an agent may otherwise wait on them forever.
  engine.release(live)
  await live.connection.cancel({ sessionId: live.sessionId })
}

const closingSessions = new Map<string, Promise<void>>()

export async function liveClose(id: string): Promise<void> {
  const closing = closingSessions.get(id)
  if (closing) return closing
  const live = sessions.get(id)
  if (!live) return
  const operation = (async () => {
    live.compaction?.dispose()
    update(live, { status: "closed" })
    live.startup.abort()
    engine.release(live)
    live.child.kill()
    if (live.child.exitCode === null && live.child.signalCode === null)
      await new Promise<void>((resolve) => {
        live.child.once("exit", () => resolve())
      })
    if (sessions.get(id) === live) sessions.delete(id)
  })()
  closingSessions.set(id, operation)
  try {
    await operation
  } finally {
    if (closingSessions.get(id) === operation)
      closingSessions.delete(id)
  }
}

export function stopAcp(): void {
  for (const id of sessions.keys()) void liveClose(id)
}

function update(live: Live, patch: Partial<LiveSessionState>): void {
  if (patch.configOptions && !patch.settings) {
    patch.settings = acpObservedSettings(live.configOptions, live.state.settings?.model)
  }
  engine.patch(live, patch)
}
