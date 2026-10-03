import { applyControlEnvironment } from "./control-launch.js"
import { applyThreadEnvironment } from "./thread-environment.js"
import type { ApprovalSubmission, NativeApprovalIdentity } from "./contracts/approval-response.js"
import { traceProviderLaunch, type ProviderLaunchTrace } from "./provider-launch.js"
import { preparePrompt, preparePromptAsync, type PromptDispatch } from "./providers/prompt-dispatch.js"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { SHUTDOWN_GRACE_MS, conversationServers, type ProviderStartOptions, type ProviderSteerInput, type ProviderSteerResult } from "./providers/live-driver.js"
import { createLiveEngine } from "./live-engine.js"
import { AcpPromptTurn } from "./acp-prompt-turn.js"
import { AcpCompaction } from "./acp-compaction.js"
import { COMPACTION_FAILED, CONTEXT_COMPACTED } from "@mako/sessions/events"
import type { NativeNotice } from "./contracts/native-activity.js"
import { turnVerdict } from "./acp-turn-verdict.js"
import { openAuthenticatedSession } from "./acp-authentication.js"
import { acpDefaultMode, acpInitialSelection, acpModeChange, acpNativeModes, acpReportedMode, acpSessionModes } from "./acp-access.js"
import type { AcpLaunchOptions, AcpAgentObserver } from "./providers/acp-source.js"
import { accessModeId, accessTierOfModeId, type AccessTier } from "./contracts/access.js"
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

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawnProviderProcess } from "./providers/provider-process.js"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { acpReadable, acpWritable, screenSessionUpdates, type LossySessionUpdate, type RefusedSessionUpdate } from "./acp-stream.js"
import { app } from "electron"
import {
  ClientSideConnection,
  CreateElicitationRequest as ElicitationRequest,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
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
import { ProviderStartupWatch, stderrDetail } from "./provider-startup.js"
import { hostLog, hostWarn } from "./host-log.js"
import { errorMessage } from "./live-runtime.js"
import { basename, join } from "node:path"
import { acpObservedSettings, applyAcpSettings } from "./acp-config.js"
import { elicitationContent, elicitationQuestion } from "./acp-elicitation.js"
import { AcpDecoder, acpAnswer, type AcpNotificationRecord, type AcpRequestRecord } from "./acp-decoder.js"
import { nativeCapture } from "./native-capture.js"
import { deliverDecoded } from "./contracts/native-decoding.js"
import { normalizeAcpOptions } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import type { AcpBackgroundObserver, AcpBackgroundReport, AcpNotificationDecoding, AcpTuning } from "./providers/acp-source.js"
import { SessionUsage, type UsageObservation } from "./session-usage.js"
import type { JsonObject } from "./codex-app-json.js"
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
  agents?: AcpAgentObserver
  compaction?: AcpCompaction
  usage: SessionUsage
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
  /**
   * Reports the running prompt accepted. ACP answers `session/prompt` only
   * when the turn ends, so the agent's first output for the turn is the
   * receipt; a process that dies mid-turn then leaves a turn its saved
   * session holds, which Mako continues rather than sends again.
   */
  turnReceipt?: () => void
  /** A turn the agent started itself is running; the agent's own notification ends it. */
  providerTurn?: boolean
  /**
   * The agent announced a turn it will start itself. Only an announced turn
   * opens: output after the agent ended a turn, such as a thought chunk
   * trailing a cancel, stays with the turn it came from.
   */
  providerTurnCause?: string
  /** The agent advertised `session/close`. */
  closesSession?: boolean
  background?: AcpBackgroundObserver
  /** Waiting for the running turn to settle, or for the session to end. */
  settling: Array<() => void>
  /** Stop is closing and resuming the session to end its background work; a prompt waits for it. */
  reopening?: Promise<void>
  /** Only one native mode request may own the acknowledgment at a time. */
  changingMode?: boolean
  /** The tier the process was launched with, for providers that read it at start. */
  launchAccess: AccessTier | null
}

/** Output that begins a turn. A tool update can still belong to the turn before. */
const TURN_CONTENT = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "plan"])

const engine = createLiveEngine<Live>()
const sessions = engine.sessions
let emit: (event: LiveDriverEvent) => void = () => {}


export function bindAcp(send: (event: LiveDriverEvent) => void): void {
  emit = send
}

async function requestElicitation(
  live: Live,
  params: CreateElicitationRequest,
  native?: NativeApprovalIdentity
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
  const response = await askUser(live, params.message, questions, native)
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
  questions: LiveInputQuestion[],
  native?: NativeApprovalIdentity
): Promise<LivePermissionResponse> {
  const requestId = `${live.id}-input-${live.pendingPermissions.size}-${Date.now()}`
  const request: LivePermissionRequest = {
    id: requestId,
    native,
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
export function liveStart(
  harness: string,
  cwd: string,
  options: ProviderStartOptions
): Promise<LiveSessionState> {
  return traceProviderLaunch(harness, options.conversationId, trace => startAcp(harness, cwd, options, trace))
}

async function startAcp(
  harness: string,
  cwd: string,
  options: ProviderStartOptions,
  trace: ProviderLaunchTrace
): Promise<LiveSessionState> {
  const source = providerHost.acpSources.get(harness)
  const policy = source?.access
  // A chosen launch tier wins, from the mode or, when the mode is a native one
  // such as Plan, from the level beside it; a stale one falls back to the
  // provider's declared default so the process always launches at the level
  // the desk will report, never at a leftover configuration the user cannot see.
  const requestedAccess = [options.modeId, options.launchModeId]
    .map((modeId) => (modeId ? accessTierOfModeId(modeId) : null))
    .find((tier) => tier && policy?.launch?.includes(tier))
  const launchTier = requestedAccess ?? policy?.default
  const launchAccess =
    launchTier && policy?.launch?.includes(launchTier) ? launchTier : null
  const env = await trace.step("account", () => accountEnv(harness, process.env))
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
  const launchOptions: AcpLaunchOptions = {
    cwd: workingDir,
    appPath: app.getAppPath(),
    execPath: process.execPath,
    resume: options.resume,
    nativePath: options.threadPath,
    env,
    tuning: options.tuning,
  }
  if (launchAccess) launchOptions.access = launchAccess
  const spec = await trace.step("runtime-discovery", () => source?.launch(launchOptions))
  if (!spec) throw new Error(`${harness} does not speak ACP here yet`)
  const runAccess = spec.access ?? launchAccess

  const id = options.conversationId
  // The owner supplies a generation-fenced sink. Old connection events must
  // not mutate a replacement owner or undo deliberate hibernation.
  const send = options.emit ?? ((event: LiveDriverEvent) => emit(event))
  const mcpSnapshot = await trace.step("mcp-preparation", () => options.mcpSnapshot?.() ?? discoverMcpRegistry(workingDir))

  // The nested-session guard: Claude Code refuses to start inside another
  // Claude Code. Mako is not one, but it may have been *launched from* one,
  // and the variable would be inherited. The selected account's config home
  // rides in the same way it does for headless runs.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  spec.configureEnvironment(env)
  applyControlEnvironment(env, options.conversationTools?.control)
  applyThreadEnvironment(env, options.threadEnvironment)
  const executable = resolveExecutable(spec.command, env)
  if (!executable) throw new Error(`${harness} is not installed`)

  const preparedServers = acpMcpServers(mcpSnapshot, harness, ["stdio", "http", "sse"])
  const tools = options.conversationTools
  const makoMcp: McpServer[] = tools
    ? conversationServers(tools).map(({ name, url }) => ({ type: "http", name, url, headers: [{ name: "Authorization", value: `Bearer ${tools.token}` }] }))
    : []
  preparedServers.push(...makoMcp)
  const disposeMcp = await trace.step("mcp-preparation", () => spec.prepareMcp?.(preparedServers, env))
  const approvals = await trace.step("observation", () => spec.prepareApprovals?.({
    root: join(app.getPath("userData"), "approval-evidence"), env,
    previous: options.observedApprovals ?? [],
    publish: decision => send({ type: "live-approval-decision", id, decision }),
  }))
  const child = trace.sync("spawn", () => spawnProviderProcess(executable, spec.args, {
    cwd: workingDir,
    env: environmentForExecutable(executable, env),
  }, { kind: `acp:${harness}`, owner: id }))

  child.once("close", () => {
    void approvals?.dispose().catch(() => hostWarn("acp", "Approval observation cleanup failed", { harness, conversation: id }))
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
    usage: new SessionUsage(),
    settling: [],
    startup: new AbortController(),
    promptCapabilities: {},
    configOptions: [],
    mcpServers: [],
    turn: null,
    launchAccess: runAccess,
    emit: send,
  }
  sessions.set(id, live)

  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  const watch = new ProviderStartupWatch(child, { harness, stderr: () => stderr })
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
  const located = () =>
    live.sessionId
      ? (source?.locateSession?.({ nativeId: live.sessionId, cwd: workingDir, env }) ?? live.state.nativePath)
      : live.state.nativePath
  child.on("exit", (code, signal) => {
    live.agents?.dispose()
    live.compaction?.dispose()
    live.startup.abort()
    hostLog("acp", "exited", {
      harness,
      conversation: id,
      pid: child.pid,
      code,
      signal,
      status: live.state.status,
      // Durable logs carry no native output; a failure says it on the session.
      stderrBytes: stderr.length,
    })
    engine.release(live)
    if (live.state.status === "closed") return
    update(live, {
      status: "failed",
      connection: "disconnected",
      nativePath: located(),
      backgroundTasks: 0,
      error:
        stderrDetail(stderr) ||
        `${spec.command} exited${signal ? ` on ${signal}` : code === null ? "" : ` with code ${code}`}`,
    })
  })

  const decoder = new AcpDecoder(source, () => live.state.settings)
  const capture = nativeCapture(harness, id, () => ({ settings: { model: live.state.settings?.model ?? null } }))
  /** Records a message as `acpDecoderSource` reads it: `{ method, params }`, or `{ request, params }` for one the agent waits on. */
  const record = (message: AcpNotificationRecord | AcpRequestRecord) => {
    if (capture) capture.record(JSON.parse(JSON.stringify(message)))
  }
  // A state patch goes through `update`, which settles waiters once the turn ends.
  const sink = { ...engine.sink<never>(live, { effect: () => undefined }), patch: (patch: Partial<LiveSessionState>) => update(live, patch) }
  const client: Client = {
    async requestPermission(params: RequestPermissionRequest) {
      record({ request: "session/request_permission", params })
      const request: LivePermissionRequest = {
        id: `${id}-perm-${live.pendingPermissions.size}-${Date.now()}`,
        native: await approvals?.identify(params).catch(() => undefined),
        sessionId: id,
        ...decoder.permission(params).request,
      }
      const response = await engine.ask(live, request)
      const chosen = response.kind === "choice" ? response.optionId : null
      if (chosen === null) return { outcome: { outcome: "cancelled" as const } }
      return { outcome: { outcome: "selected" as const, optionId: chosen } }
    },
    async extMethod(method: string, params: JsonObject) {
      record({ request: method, params })
      const vendor = decoder.request(method, params)
      if (!vendor || vendor.sessionId !== live.sessionId) {
        engine.unknown(live, method, vendor ? "unreadable" : "unknown", params)
        throw RequestError.methodNotFound(method)
      }
      engine.emitUpdates(live, vendor.updates)
      const response = await engine.ask(live, {
        id: `${id}-request-${live.pendingPermissions.size}-${Date.now()}`,
        sessionId: id,
        ...vendor.ask.request,
      })
      return acpAnswer(vendor.ask, response.kind === "choice" ? response.optionId : null)
    },
    async unstable_createElicitation(params: CreateElicitationRequest) {
      return requestElicitation(live, params, approvals?.identifyElicitation?.(params))
    },
    async sessionUpdate(params: SessionNotification) {
      if (live.sessionId && params.sessionId !== live.sessionId) return
      record({ method: "session/update", params })
      reportBackground(background?.sessionUpdate?.(params))
      announceProviderTurn(providerTurns?.updateCause?.(params))
      if (live.agents?.observe(params) === "child") return
      approvals?.observe?.(params)
      live.compaction?.observe(params.update)
      if (params.update.sessionUpdate === "config_option_update") {
        live.configOptions = params.update.configOptions
        const native = acpNativeModes(live.configOptions)
        if (native) acpObserveNativeMode(id, native.currentModeId)
      }
      if (params.update.sessionUpdate === "current_mode_update") {
        acpObserveNativeMode(id, params.update.currentModeId)
        return
      }
      if (params.update.sessionUpdate === "usage_update") {
        const reading = params.update
        const extra = source?.usageUpdate ? source.usageUpdate(UsageMetaSchema.safeParse(reading._meta).data) : []
        if (extra === null) return
        const observations: UsageObservation[] = [{ kind: "context", used: reading.used, size: reading.size }, ...extra]
        if (reading.cost) observations.push({ kind: "cost", amount: reading.cost.amount, currency: reading.cost.currency })
        observeUsage(observations)
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
      if (live.providerTurnCause !== undefined && !live.compaction && TURN_CONTENT.has(params.update.sessionUpdate) &&
        (live.state.status === "ready" || live.state.status === "failed")) {
        live.providerTurn = true
        update(live, { status: "running", nativeRunId: undefined, error: undefined, lastStop: undefined })
        engine.emitUpdate(live, { kind: "provider-turn", reason: live.providerTurnCause })
        live.providerTurnCause = undefined
      }
      if (live.turn && !live.providerTurn && !live.compaction && TURN_CONTENT.has(params.update.sessionUpdate))
        live.turnReceipt?.()
      deliverDecoded(decoder.update(params), sink)
    },
    async extNotification(method: string, params: JsonObject) {
      record({ method, params })
      const report = background?.extension?.(method, params)
      reportBackground(report)
      const observed = observeProviderTurn(method, params)
      const startup = mcpStartup?.decode(method, params)
      const native = startup ?? source?.decodeNotification?.(method, params)
      const decoded = native && (startup || native.connectionWide) ? { ...native, sessionId: native.sessionId ?? live.sessionId ?? undefined } : native
      if (decoded) applyNotification(decoded, { method, params })
      else if (!observed && !report) engine.unknown(live, method, "unknown", { method, params })
    },
  }
  /**
   * A notification for another session is not this conversation's; an unknown one is logged either way.
   * Notices said while the session is still opening (MCP servers failing to start) wait for its id.
   */
  function applyNotification(decoded: AcpNotificationDecoding, raw?: JsonObject): void {
    const { sessionId, kind, notices, state, id: source } = decoded
    if ((notices?.length || decoded.usage?.length) && !live.sessionId) {
      opening.push(decoded)
      return
    }
    if (notices && sessionId !== live.sessionId) return
    if (notices === undefined && raw) {
      engine.unknown(live, kind, "unknown", raw)
      return
    }
    const marked = live.compaction ? notices?.map(asManualCompaction) : notices
    engine.observe(live, kind, marked, source)
    if (notices && state) update(live, state)
    const compacted = notices?.flatMap((notice) => notice.kind === "compacted" ? [{ kind: "compacted" as const, after: notice.compaction?.tokensAfter }] : []) ?? []
    if (notices && (decoded.usage?.length || compacted.length)) observeUsage([...compacted, ...decoded.usage ?? []])
    if (live.compaction && notices) {
      const failed = notices.find((notice) => notice.kind === "event" && notice.event.label === COMPACTION_FAILED)
      if (failed?.kind === "event") live.compaction.confirm({ kind: "failed", reason: failed.event.detail ?? "Compaction failed" })
      else if (compacted.length || decoded.usage?.some((observation) => observation.kind === "compacted"))
        live.compaction.confirm({ kind: "completed" })
    }
  }
  /** Spend reported before the session opened is history `session/load` replays, already counted when it happened. */
  function observeUsage(observations: UsageObservation[]): void {
    const usage = live.usage.observe(...live.sessionId ? observations : observations.filter((observation) => observation.kind !== "spent" && observation.kind !== "costSpent"))
    if (usage) update(live, { usage })
  }
  /**
   * An update the SDK would have dropped. The provider's decoder reads a kind
   * of its own; anything else is logged, a malformed known kind under its own name.
   */
  function refusedUpdate({ params, kind, known }: RefusedSessionUpdate): void {
    const decoded = known ? undefined : source?.decodeNotification?.("session/update", params)
    if (decoded) applyNotification(decoded, { method: "session/update", params })
    else engine.unknown(live, known ? `session/update/${kind}/invalid` : `session/update/${kind}`, "unreadable", { method: "session/update", params })
  }
  /** The SDK kept this update but not all of it; each lost place is logged once. */
  function lossyUpdate({ params, kind, paths }: LossySessionUpdate): void {
    for (const path of paths) engine.unknown(live, `session/update/${kind}/lost/${path}`, "unreadable", { method: "session/update", params })
  }
  const mcpStartup = source?.mcpStartup?.()
  const opening: AcpNotificationDecoding[] = []
  const background = source?.observeBackground?.()
  live.background = background
  const providerTurns = source?.providerTurns?.()
  function announceProviderTurn(cause: { sessionId: string; reason: string } | undefined): void {
    if (cause && cause.sessionId === live.sessionId && live.state.status !== "running")
      live.providerTurnCause = cause.reason
  }
  /** Whether the notification is one the provider-turn observer knows. */
  function observeProviderTurn(method: string, params: JsonObject): boolean {
    if (!providerTurns || !live.sessionId) return false
    const cause = providerTurns.cause?.(method, params)
    announceProviderTurn(cause)
    const ended = providerTurns.ended(method, params)
    if (ended?.sessionId !== live.sessionId) return Boolean(cause || ended)
    live.providerTurnCause = undefined
    if (!live.providerTurn) return true
    live.providerTurn = false
    if (live.state.status === "running")
      update(live, { status: "ready", lastStop: ended.interrupted ? "interrupted" : "completed" })
    return true
  }
  function reportBackground(report: AcpBackgroundReport | undefined): void {
    if (!report || !live.sessionId || report.sessionId !== live.sessionId) return
    if (report.running !== (live.state.backgroundTasks ?? 0))
      update(live, { backgroundTasks: report.running })
  }

  const connection = new ClientSideConnection(
    () => client,
    await screenSessionUpdates(ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)), refusedUpdate, lossyUpdate)
  )
  live.connection = connection

  try {
    const initialized = await trace.step("handshake", () => watch.step("initialize", connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          session: { configOptions: { boolean: {} } },
          elicitation: { form: {} },
          ...providerHost.acpSources.get(harness)?.clientCapabilities,
        },
      })))
    live.promptCapabilities =
      initialized.agentCapabilities?.promptCapabilities ?? {}
    live.closesSession = Boolean(initialized.agentCapabilities?.sessionCapabilities?.close)
    const mcpCapabilities = initialized.agentCapabilities?.mcpCapabilities
    const transports: McpTransport[] = ["stdio"]
    if (mcpCapabilities?.http) transports.push("http")
    if (mcpCapabilities?.sse) transports.push("sse")
    live.mcpServers = providerHost.mcpSources.get(harness)
      ? acpMcpServers(
          mcpSnapshot,
          harness,
          transports
        )
      : []
    if (mcpCapabilities?.http) live.mcpServers.push(...makoMcp)
    const resume = options.resume
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
        const response = await trace.step("human-sign-in", () => engine.ask(live, request))
        return response.kind === "choice" ? response.optionId : null
      },
      authenticate: async (methodId) => {
        await trace.step("human-sign-in", () => connection.authenticate({ methodId }))
      },
      open: async () => resume
        ? parseLoadedAcpSession(
            await trace.step("session-resume", () => watch.step("session/load", connection.loadSession(
                loadSessionRequest(
                  resume,
                  workingDir,
                  harness,
                  options.tuning,
                  live.mcpServers
                )
              ))),
            resume
          )
        : parseNewAcpSession(
            await trace.step("session-open", () => watch.step("session/new", connection.newSession(
                newSessionRequest(
                  workingDir,
                  harness,
                  options.tuning,
                  live.mcpServers
                )
              )))
          ),
    })
    live.sessionId = session.sessionId
    for (const decoded of opening.splice(0))
      if ((decoded.sessionId ?? session.sessionId) === session.sessionId)
        applyNotification({ ...decoded, sessionId: session.sessionId, usage: decoded.usage?.filter((observation) => observation.kind !== "spent" && observation.kind !== "costSpent") })
    live.agents = await trace.step("observation", () => source?.observeAgents?.({
      nativeId: session.sessionId, cwd: workingDir, env, observedAgents: options.observedAgents,
      publish: (agent) => {
        if (!live.startup.signal.aborted) engine.emitAgent(live, agent)
      },
    }))
    if (live.startup.signal.aborted) {
      live.agents?.dispose()
      throw new Error("Provider disconnected while restoring child observations")
    }
    live.configOptions = session.configOptions
    live.state.settings = acpObservedSettings(live.configOptions, session.model)
    const applied = await trace.step("settings", () => applyTuning(live, options.tuning, true))
    // Providers that moved their mode vocabulary to a config option send no
    // session.modes; the option is the same fact in another field.
    const sessionModes = session.modes ?? acpNativeModes(live.configOptions)
    const modes = acpSessionModes(policy, sessionModes)
    const requestedModeId =
      options.modeId && modes.some((mode) => mode.id === options.modeId)
        ? options.modeId
        : acpDefaultMode(policy)
    // A tier the provider's own settings overrode is reported as the tier it runs at.
    const effectiveModeId =
      spec.access && requestedModeId && accessTierOfModeId(requestedModeId)
        ? accessModeId(spec.access)
        : requestedModeId
    if (effectiveModeId) {
      const change = acpModeChange(policy, modes, effectiveModeId, runAccess, harness)
      if (change.kind === "native" && change.nativeModeId !== sessionModes?.currentModeId) {
        await trace.step("settings", () => watch.step("session/set_mode", connection.setSessionMode({ sessionId: session.sessionId, modeId: change.nativeModeId })))
        if (sessionModes) sessionModes.currentModeId = change.nativeModeId
        live.configOptions = live.configOptions.map(option =>
          option.type === "select" && (option.category === "mode" || option.id === "mode")
            ? { ...option, currentValue: change.nativeModeId } : option)
      }
    }
    const selection = acpInitialSelection(policy, modes, sessionModes, effectiveModeId)
    update(live, {
      nativeId: session.sessionId,
      nativePath: located(),
      status: "ready",
      connection: "connected",
      modes,
      currentMode: selection.currentMode,
      launchMode: runAccess ? accessModeId(runAccess) : undefined,
      configOptions: normalizeAcpOptions(live.configOptions),
      settings: { ...applied.settings, options: { ...applied.settings.options, ...acpObservedSettings(live.configOptions).options } },
    })
    for (const notice of spec.notices ?? []) engine.event(live, notice, `launch:${notice.label}`)
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

/** A `usage_update`'s `_meta`, as the harness's own reader takes it. */
const UsageMetaSchema = z.record(z.string(), z.json())
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

/** Begin dispatch; the correlated ACP response reports delivery asynchronously. */
export async function livePrompt(
  id: string,
  text: string,
  attachments: PromptAttachment[],
  tuning: AcpTuning | undefined,
  dispatch: PromptDispatch
): Promise<void> {
  const { live, connection, sessionId } = preparePrompt(dispatch, () => {
    const live = sessions.get(id)
    if (!live?.sessionId || !live.connection)
      throw new Error("This interactive session is not running")
    if (live.state.status === "running")
      throw new Error("The agent is already working")
    if (live.compaction)
      throw new Error("The agent has not confirmed compaction yet. Wait for it, or press Stop, before sending again.")
    return { live, connection: live.connection, sessionId: live.sessionId }
  })
  const compact = providerHost.acpSources.get(live.harness)?.compaction
  if (compact?.kind === "supported" && text.trim() === compact.command && attachments.length === 0) {
    dispatch.report({ kind: "submitted", source: "transport-call" })
    await liveCompact(id, randomUUID())
    return
  }
  let applied: Awaited<ReturnType<typeof applyTuning>>
  try {
    applied = await preparePromptAsync(dispatch, async () => {
      await live.reopening
      return applyTuning(live, tuning)
    })
  } catch (error) {
    hostWarn("acp", "settings refused", { harness: live.harness, conversation: id, error: errorMessage({ error }) })
    throw error
  }
  preparePrompt(dispatch, () => {
    if (live.state.status === "closed" || live.turn?.acceptsSteering)
      throw new Error("The session changed while preparing the prompt")
  })
  const turn = new AcpPromptTurn((result) => {
    if (live.turn !== turn || live.state.status === "closed" || live.state.connection === "disconnected") return
    const verdict = turnVerdict(result)
    // A prompt that failed because the connection closed is the process
    // ending, and its exit reports the turn with the disconnect in one
    // update. A process that closed its pipes without exiting is ended so
    // that exit comes.
    if (verdict.status === "failed" && connection.signal.aborted) {
      if (live.child.exitCode === null && live.child.signalCode === null) live.child.kill()
      return
    }
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
  live.turnReceipt = () => {
    if (live.turn !== turn) return
    live.turnReceipt = undefined
    dispatch.report({ kind: "accepted", source: "native-echo", referenceId: turn.id })
  }
  live.providerTurn = false
  live.providerTurnCause = undefined
  update(live, { status: "running", nativeRunId: turn.id, error: undefined, lastStop: undefined, settings: applied.settings, configOptions: normalizeAcpOptions(applied.options) })
  engine.emitUpdate(live, { kind: "user", text })
  const prompt = acpPromptBlocks(text, attachments, live.promptCapabilities)
  dispatch.report({ kind: "submitted", source: "transport-call", correlationId: turn.id })
  void turn.send(() => connection.prompt({ sessionId, prompt })).then(
    () => dispatch.report({ kind: "accepted", source: "native-response" }),
    (error: Error) => dispatch.report({ kind: "uncertain", reason: error.message })
  )
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
    // Unconfirmed is not over: the provider may still be compacting, and its
    // confirmation or a Stop settles it.
    if (result.kind !== "uncertain") {
      live.compaction = undefined
      update(live, { status: result.kind === "completed" ? "ready" : "failed",
        lastStop: result.kind === "completed" ? "completed" : "failed",
        error: result.kind === "completed" ? undefined : result.reason })
    }
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
): ApprovalSubmission {
  return engine.respondPermission(id, requestId, response)
}

export async function liveSetMode(id: string, modeId: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection || live.state.status === "closed" || live.state.connection === "disconnected" || live.startup.signal.aborted)
    throw new Error("This session is no longer connected. Reconnect before changing its mode.")
  if (live.changingMode) throw new Error("A mode change is already waiting for the agent. Wait for its acknowledgment.")
  if (live.reopening) throw new Error("This session is reconnecting. Wait before changing its mode.")
  const policy = providerHost.acpSources.get(live.harness)?.access
  const change = acpModeChange(policy, live.state.modes, modeId, live.launchAccess, live.harness, live.state.currentMode)
  if (change.kind === "unchanged") {
    update(live, { currentMode: change.modeId })
    return
  }
  const connection = live.connection
  const sessionId = live.sessionId
  const nativeMode = change.nativeModeId
  live.changingMode = true
  try {
    await connection.setSessionMode({ sessionId, modeId: nativeMode })
    if (sessions.get(id) !== live || live.connection !== connection || live.sessionId !== sessionId || live.startup.signal.aborted)
      throw new Error("The session ended before its mode change was acknowledged.")
    live.configOptions = live.configOptions.map((option) =>
      option.type === "select" && (option.category === "mode" || option.id === "mode")
        ? { ...option, currentValue: nativeMode } : option
    )
    update(live, { currentMode: change.modeId, configOptions: normalizeAcpOptions(live.configOptions), settings: acpObservedSettings(live.configOptions, live.state.settings?.model) })
  } finally {
    live.changingMode = false
  }
}

/** Project the mode reported by the native runtime. */
export function acpObserveNativeMode(id: string, nativeMode: string): void {
  const live = sessions.get(id)
  if (!live) return
  const policy = providerHost.acpSources.get(live.harness)?.access
  update(live, { currentMode: acpReportedMode(policy, nativeMode, live.launchAccess) })
}

export async function liveCancel(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection) return
  live.turn?.cancel()
  // The protocol requires pending permission requests to settle as cancelled
  // once the client cancels; an agent may otherwise wait on them forever.
  engine.release(live)
  const end = () => void endBackground(live)
  if (live.state.status === "running") live.settling.push(end)
  else end()
  try {
    await live.connection.cancel({ sessionId: live.sessionId })
  } catch (error) {
    live.settling = live.settling.filter((settle) => settle !== end)
    throw error
  }
}

/** Stop ends the session's background work too, once its turn has settled. */
async function endBackground(live: Live): Promise<void> {
  const { background, connection, sessionId } = live
  if (!background || !connection || !sessionId || live.state.status === "closed" || live.state.connection === "disconnected") return
  try {
    await background.stop({
      sessionId,
      running: live.state.backgroundTasks ?? 0,
      request: async (method, params) => { await connection.request(method, params) },
      reopen: () => {
        const reopening = (async () => {
          await connection.closeSession({ sessionId })
          await connection.resumeSession({ sessionId, cwd: live.cwd, mcpServers: live.mcpServers })
          live.providerTurnCause = undefined
        })().finally(() => {
          if (live.reopening === reopening) live.reopening = undefined
        })
        live.reopening = reopening
        return reopening
      },
    })
  } catch (error) {
    hostWarn("acp", "Background work was not ended", { harness: live.harness, conversation: live.id, error: errorMessage({ error }) })
  }
}

const closingSessions = new Map<string, Promise<void>>()

export async function liveClose(id: string): Promise<void> {
  const closing = closingSessions.get(id)
  if (closing) return closing
  const live = sessions.get(id)
  if (!live) return
  const operation = (async () => {
    live.agents?.dispose()
    live.compaction?.dispose()
    update(live, { status: "closed" })
    live.startup.abort()
    engine.release(live)
    await endAgent(live)
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

/**
 * End the agent the way its own client does, so the background work it
 * started ends with it. Grok stops its tasks on `session/close` and Devin
 * stops its shells when stdin closes; a signal leaves either one's work
 * running with nothing left to report it.
 */
async function endAgent(live: Live): Promise<void> {
  const { child } = live
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const deadline = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS)
  if (live.closesSession && live.connection && live.sessionId)
    await Promise.race([live.connection.closeSession({ sessionId: live.sessionId }).catch(() => undefined), exited])
  child.stdin.end()
  await exited
  clearTimeout(deadline)
}

export function stopAcp(): void {
  for (const id of sessions.keys()) void liveClose(id)
}

function update(live: Live, patch: Partial<LiveSessionState>): void {
  if (patch.configOptions && !patch.settings) {
    patch.settings = acpObservedSettings(live.configOptions, live.state.settings?.model)
  }
  engine.patch(live, patch)
  if (live.state.status !== "running") for (const settle of live.settling.splice(0)) settle()
}

/**
 * A compaction that ends while one Mako asked for is pending is that one:
 * harnesses that report both kinds through their automatic notifications
 * (Grok) would otherwise label it automatic.
 */
function asManualCompaction(notice: NativeNotice): NativeNotice {
  if (notice.kind !== "event" || notice.event.label !== CONTEXT_COMPACTED || !notice.event.detail?.startsWith("Automatic")) return notice
  return { ...notice, event: { ...notice.event, detail: notice.event.detail.replace(/^Automatic/, "Manual") } }
}
