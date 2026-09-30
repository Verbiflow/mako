import { preparePrompt, preparePromptAsync, type PromptDispatch } from "../prompt-dispatch.js"
import { ClaudeAgents } from "./sdk-agents.js"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  ModelUsage,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { SessionSettings } from "@mako/sessions/settings"
import { PROVIDER_TURN_FALLBACK } from "@mako/sessions"
import type { LiveSessionCommand, LiveSessionMode, LiveSessionState, LiveSessionUsage } from "../../shared.js"
import { createLiveEngine, type LiveEngineApi } from "../../live-engine.js"
import type {
  ProviderLiveDriver,
  ProviderStartOptions,
  ProviderSteerResult,
} from "../live-driver.js"
import {
  ClaudeInput,
  ClaudeModeSchema,
  ClaudeTuningSchema,
  claudeInputContent,
} from "./input.js"
import { ClaudeProjection } from "./sdk-projection.js"
import { spawnClaudeProcess } from "./sdk-process.js"
import { ClaudePermissions } from "./sdk-permissions.js"
import { ClaudeApprovalObserver, claudeApprovalAnswerDigest, readClaudeApprovalDecisions } from "./approval-observer.js"
import type { ClaudePermissionObserver, prepareClaudePermissionObserver } from "./permission-observer.js"
import { ClaudeTranscript } from "./sdk-transcript.js"
import { ProviderStartupWatch, STARTUP_TOTAL_MS } from "../../provider-startup.js"
import { traceProviderLaunch, type ProviderLaunchTrace } from "../../provider-launch.js"
import { hostLog, hostWarn } from "../../host-log.js"
import { claudeAuthDiagnostics } from "./auth-diagnostics.js"
import { claudeMessageKind } from "./sdk-message-kinds.js"
import { ClaudeNotices, claudeStopReason } from "./sdk-notices.js"

/** Claude's permission modes, placed on the shared access ladder. */
const CLAUDE_MODES: LiveSessionMode[] = [
  { id: "default", name: "Ask for approval", access: "ask", enforcement: "provider" },
  { id: "acceptEdits", name: "Accept edits", access: "edits", enforcement: "provider" },
  { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
  { id: "dontAsk", name: "Deny unapproved tools", access: "deny", enforcement: "provider" },
  { id: "auto", name: "Automatic approval review", access: "auto", enforcement: "provider" },
  { id: "bypassPermissions", name: "Bypass permissions", access: "full", enforcement: "provider" },
]

type ClaudeQuery = Pick<
  Query,
  | typeof Symbol.asyncIterator
  | "initializationResult"
  | "setModel"
  | "applyFlagSettings"
  | "setPermissionMode"
  | "interrupt"
  | "close"
>
interface Receipt {
  resolve(result: ProviderSteerResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
interface Live {
  compaction?: { actionId: string; runId: string; confirmed: boolean }
  notices: ClaudeNotices
  /** The model and context of the main loop's latest request, for the usage its turn's result reports. */
  lastCall?: { model: string; tokens: number }
  /** Commands `init` said belong to a terminal; a later command list leaves them out too. */
  terminalCommands: Set<string>
  state: LiveSessionState
  query: ClaudeQuery
  input: ClaudeInput
  agents: ClaudeAgents
  projection: ClaudeProjection
  permissions: ClaudePermissions
  approvals: ClaudeApprovalObserver
  disposeApprovals(): Promise<void>
  authDiagnostics: ReturnType<typeof claudeAuthDiagnostics>
  transcript: ClaudeTranscript
  emit: NonNullable<ProviderStartOptions["emit"]>
  promptReceipt?: { id: string; dispatch: PromptDispatch }
  receipts: Map<string, Receipt>
  closed: boolean
  steered: boolean
  finishing: boolean
  /** The summary of a task that settled while no turn ran: the cause of the turn Claude starts on it. */
  providerTurnCause?: string
  exited(): Promise<void>
}
export interface ClaudeSdkDependencies {
  available(): boolean
  configure(cwd: string, options: ProviderStartOptions, trace: ProviderLaunchTrace): Promise<Options>
  query(input: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }): ClaudeQuery
  interruptTimeoutMs?: number
  receiptTimeoutMs?: number
  prepareApprovals?: (input: Omit<Parameters<typeof prepareClaudePermissionObserver>[0], "root">) => Promise<ClaudePermissionObserver | undefined>
}

type Engine = LiveEngineApi<Live>

function stop(live: Live): void {
  live.closed = true
  live.input.close()
  live.permissions.close()
  live.query.close()
  void live.disposeApprovals()
  for (const receipt of live.receipts.values()) {
    clearTimeout(receipt.timer)
    receipt.reject(
      new Error(
        "Claude disconnected before confirming steering delivery. Do not resend automatically."
      )
    )
  }
  live.receipts.clear()
  live.promptReceipt = undefined
}

function acknowledge(live: Live, message: SDKMessage): void {
  const ids = new Set<string>()
  if (message.type === "user" && message.uuid) ids.add(message.uuid)
  if ("user_message_uuid" in message && message.user_message_uuid)
    ids.add(message.user_message_uuid)
  if ("user_message_uuids" in message)
    for (const id of message.user_message_uuids ?? []) ids.add(id)
  const prompt = live.promptReceipt
  if (prompt && ids.has(prompt.id)) {
    live.promptReceipt = undefined
    prompt.dispatch.report({ kind: "accepted", source: "native-echo", referenceId: prompt.id })
  }
  for (const id of ids) {
    const receipt = live.receipts.get(id)
    if (!receipt) continue
    clearTimeout(receipt.timer)
    live.receipts.delete(id)
    receipt.resolve({ kind: "accepted" })
  }
}

/** Claude's own reports, and the session state they move outside a turn's content. */
function observe(engine: Engine, live: Live, message: SDKMessage): void {
  engine.observe(live, claudeMessageKind(message), live.notices.decode(message))
  if (message.type === "assistant") {
    const { model, usage } = message.message
    if (!message.parent_tool_use_id && model !== "<synthetic>")
      live.lastCall = { model, tokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) + usage.output_tokens }
  } else if (message.type === "result") {
    const size = live.lastCall && contextWindow(message.modelUsage, live.lastCall.model)
    if (live.lastCall && size)
      reportUsage(engine, live, { used: live.lastCall.tokens, size,
        cost: message.total_cost_usd > 0 ? { amount: message.total_cost_usd, currency: "USD" } : live.state.usage?.cost })
  } else if (message.type === "conversation_reset") {
    live.lastCall = undefined
    engine.patch(live, { nativeId: message.new_conversation_id, usage: undefined })
  } else if (message.type === "system" && message.subtype === "status") {
    if (message.permissionMode && message.permissionMode !== live.state.currentMode)
      engine.patch(live, { currentMode: message.permissionMode })
  } else if (message.type === "system" && message.subtype === "compact_boundary") {
    live.lastCall = undefined
    const after = message.compact_metadata.post_tokens
    if (after !== undefined && live.state.usage) reportUsage(engine, live, { ...live.state.usage, used: after })
  } else if (message.type === "system" && message.subtype === "commands_changed") {
    const described = message.commands
      .filter((command) => !live.terminalCommands.has(command.name))
      .map((command): LiveSessionCommand => ({ name: command.name, description: command.description || undefined, hint: command.argumentHint || undefined }))
    engine.patch(live, { commands: described })
  }
}

function reportUsage(engine: Engine, live: Live, usage: LiveSessionUsage): void {
  const held = live.state.usage
  if (held?.used === usage.used && held.size === usage.size && held.cost?.amount === usage.cost?.amount) return
  engine.patch(live, { usage })
}

/** The answering model's window. Usage can key it with a suffix the reply's model id lacks (`[1m]`). */
function contextWindow(models: Record<string, ModelUsage>, model: string): number | undefined {
  const usage = Object.hasOwn(models, model)
    ? models[model]
    : Object.entries(models).find(([name]) => name.startsWith(model))?.[1]
  return usage?.contextWindow || undefined
}

function openProviderTurn(engine: Engine, live: Live): void {
  live.projection.reset()
  live.transcript.reset()
  engine.patch(live, {
    status: "running",
    nativeForkId: undefined,
    nativeRunId: undefined,
    lastStop: undefined,
    error: undefined,
  })
  engine.emitUpdate(live, {
    kind: "provider-turn",
    reason: live.providerTurnCause?.replace(/\s+/g, " ").trim().slice(0, 500) || PROVIDER_TURN_FALLBACK,
  })
  live.providerTurnCause = undefined
}

async function pump(engine: Engine, live: Live): Promise<void> {
  try {
    for await (const message of live.query) {
      if (live.closed) return
      if (live.state.status === "starting" && message.type === "system" &&
        (message.subtype === "hook_started" || message.subtype === "hook_response"))
        hostLog("claude-sdk", "startup event", {
          conversation: live.state.id, event: message.subtype,
        })
      acknowledge(live, message)
      observe(engine, live, message)
      live.authDiagnostics.observe(message)
      live.transcript.observe(message)
      live.approvals.observe(message)
      if (message.type === "system" && message.subtype === "compact_boundary" &&
        message.compact_metadata.trigger === "manual" && live.compaction)
        live.compaction.confirmed = true
      const agent = live.agents.project(message)
      if (agent) engine.emitAgent(live, agent)
      if (message.type === "system" && message.subtype === "background_tasks_changed") {
        const running = message.tasks.filter((task) => !task.ambient).length
        if (running !== (live.state.backgroundTasks ?? 0)) engine.patch(live, { backgroundTasks: running })
      }
      if (message.type === "system" && message.subtype === "task_notification" &&
        !message.ambient && live.state.status !== "running")
        live.providerTurnCause = message.summary
      // `init` opens every turn and never arrives between turns (SDK 0.3.283).
      // Mako marks its own turns running before sending, so an `init` while
      // settled is a turn Claude started itself, after a task notification.
      if (message.type === "system" && message.subtype === "init" &&
        (live.state.status === "ready" || live.state.status === "failed"))
        openProviderTurn(engine, live)
      const updates = live.projection.project(message)
      if (updates.length)
        engine.emitUpdates(live, updates)
      if (message.type === "system" && message.subtype === "init") {
        const options = { ...live.state.settings?.options }
        if (message.effort) options.effort = message.effort
        if (message.fast_mode_state)
          options.fast = message.fast_mode_state !== "off"
        live.terminalCommands = new Set(message.terminal_slash_commands ?? [])
        const described = new Map(live.state.commands?.map((command) => [command.name, command]))
        engine.patch(live, {
          nativeId: message.session_id,
          currentMode: message.permissionMode,
          commands: (message.slash_commands ?? [])
            .filter((name) => !live.terminalCommands.has(name))
            .map((name) => described.get(name) ?? { name }),
          settings: {
            ...live.state.settings,
            model: message.model,
            options,
          },
        })
      }
      if (message.type !== "result" || live.state.status !== "running") continue
      if (live.compaction && message.user_message_uuid &&
        message.user_message_uuid !== live.compaction.runId &&
        !message.user_message_uuids?.includes(live.compaction.runId)) continue
      if (live.steered && message.terminal_reason === "aborted_streaming")
        continue
      if ((message.queued_turn_count ?? 0) > 0) continue
      live.steered = false
      live.finishing = true
      live.permissions.close()
      const nativeForkId = message.is_error
        ? undefined
        : await live.transcript.forkPoint(live.state.nativeId)
      if (live.closed) return
      // SDK subtype "success" also carries API failures; is_error is authoritative.
      const failure = message.is_error
        ? (message.subtype === "success" ? message.result : message.errors.join("\n")).slice(0, 2000) ||
          claudeStopReason(message) || "Claude ended the turn with an error"
        : undefined
      if (failure) live.authDiagnostics.failure(failure)
      engine.patch(live, {
        nativePath: live.transcript.path,
        nativeForkId,
        status: message.is_error ? "failed" : "ready",
        lastStop: message.is_error ? "failed" : "completed",
        error: failure,
      })
      live.finishing = false
      if (live.compaction) {
        const compact = live.compaction
        live.compaction = undefined
        live.emit({ type: "live-action-result", id: live.state.id, actionId: compact.actionId,
          result: message.is_error
            ? { kind: "failed", reason: failure ?? "Compaction failed" }
            : compact.confirmed ? { kind: "completed" }
              : { kind: "uncertain", reason: "The provider ended the turn without confirming compaction." } })
      }
    }
    if (!live.closed) throw new Error("Claude Code closed its SDK stream")
  } catch (error) {
    if (live.closed) return
    if (error instanceof Error) live.authDiagnostics.failure(error.message)
    const nativePath = await live.transcript.locate(live.state.nativeId)
    if (live.closed) return
    stop(live)
    engine.patch(live, {
      nativePath,
      status: "failed",
      connection: "disconnected",
      error: error instanceof Error ? error.message : String(error),
      lastStop: "failed",
      backgroundTasks: 0,
    })
  }
}

async function tune(live: Live, settings?: SessionSettings): Promise<void> {
  if (!settings) return
  const tuning = ClaudeTuningSchema.parse(settings.options ?? {})
  if (
    tuning.agentTeams !== undefined &&
    tuning.agentTeams !== live.state.settings?.options?.agentTeams
  )
    throw new Error("Change agent teams by starting a new Claude session")
  if (settings.model && settings.model !== live.state.settings?.model)
    await live.query.setModel(settings.model)
  if (tuning.effort !== undefined || tuning.fast !== undefined)
    await live.query.applyFlagSettings({
      effortLevel: tuning.effort,
      fastMode: tuning.fast,
    })
  live.state = {
    ...live.state,
    settings: {
      ...live.state.settings,
      ...settings,
      options: { ...live.state.settings?.options, ...settings.options },
    },
  }
}

export function createClaudeSdkDriver(
  dependencies: ClaudeSdkDependencies
): ProviderLiveDriver {
  const engine = createLiveEngine<Live>()
  const sessions = engine.sessions
  const starting = new Map<string, symbol>()
  function requireLive(id: string): Live {
    const live = sessions.get(id)
    if (!live || live.closed)
      throw new Error("This Claude session is disconnected")
    return live
  }
  return {
    provider: "claude",
    approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["structured-question", ...(dependencies.prepareApprovals ? ["tool-permission" as const] : [])], coverage: "Parent AskUserQuestion results in the saved branch; parent tool decisions from the bundled runtime's local native event exporter, retained before delivery. Existing telemetry configuration, custom runtimes, child tools and MCP elicitation retain submission evidence unless a matching observer is available. Missing native events never confirm an answer." },
    approvalAnswerDigest: claudeApprovalAnswerDigest,
    observesNativeAgents: true,
    canResume: true,
    forkPoint: "checkpoint",
    backgroundStop: { kind: "ends-on-stop", how: "Stop interrupts and closes the Claude process, with or without a running turn, which ends its background tasks; the next prompt resumes the session. Mako declares no per-task stop affordance, so an interrupt stops them too." },
    turnRecovery: {
      kind: "continues",
      accepted: "The SDK's echo of the prompt's user message, as the turn starts.",
      exit: "The SDK stream's failure when the process dies settles the session failed and disconnected in one update, with the transcript found by session ID when no hook has reported it yet.",
      tests: ["scripts/test-claude-sdk.ts", "scripts/test-turn-recovery-live.mjs"],
    },
    steering: "step",
    modes: CLAUDE_MODES,
    defaultMode: "default",
    available: () => dependencies.available(),
    start: (cwd, options) => traceProviderLaunch("claude", options.conversationId, async trace => {
      if (!options.emit) throw new Error("A live event receiver is required")
      const conversationId = options.conversationId
      if (
        starting.has(options.conversationId) ||
        (sessions.has(options.conversationId) &&
          !sessions.get(options.conversationId)?.closed)
      )
        throw new Error("This Claude binding is already connected")
      const generation = Symbol()
      starting.set(options.conversationId, generation)
      const nativeId = options.fork ? options.conversationId : (options.resume ?? options.conversationId)
      const publishDecision = (decision: import("../../contracts/approval-response.js").NativeApprovalDecision) => options.emit!({ type: "live-approval-decision", id: options.conversationId, decision })
      const approvals = new ClaudeApprovalObserver(nativeId, options.observedApprovals ?? [], publishDecision)
      let config: Options
      let toolApprovals: ClaudePermissionObserver | undefined
      try {
        config = await trace.step("configuration", () => dependencies.configure(cwd, options, trace))
        toolApprovals = await trace.step("observation", async () => {
          try {
            return await dependencies.prepareApprovals?.({ config, sessionId: nativeId,
              previous: options.fork ? [] : options.observedApprovals ?? [], publish: publishDecision })
          } catch {
            hostWarn("claude-sdk", "Native tool decisions remain unconfirmed: observation unavailable", { conversation: conversationId })
            return undefined
          }
        })
        if (!options.fork && options.resume && options.threadPath) {
          try {
            for (const decision of await readClaudeApprovalDecisions(options.threadPath, nativeId, options.observedApprovals ?? [])) publishDecision(decision)
          } catch { hostWarn("claude-sdk", "Native answer history could not be reconciled", { conversation: options.conversationId }) }
        }
        if (starting.get(options.conversationId) !== generation)
          throw new Error("Claude was closed while configuring")
      } catch (error) {
        await toolApprovals?.dispose()
        throw error
      } finally {
        if (starting.get(options.conversationId) === generation)
          starting.delete(options.conversationId)
      }
      const input = new ClaudeInput()
      const transcript = new ClaudeTranscript((config.env ?? process.env).CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))
      const notices = new ClaudeNotices()
      const permissions = new ClaudePermissions(
        options.conversationId,
        options.emit,
        approvals,
        toolApprovals
      )
      let exited = Promise.resolve()
      let disposedApprovals: Promise<void> | undefined
      const disposeApprovals = () => disposedApprovals ??= exited.then(() => toolApprovals?.dispose()).then(() => {}, () => {
        hostWarn("claude-sdk", "Approval observation cleanup failed", { conversation: conversationId })
      })
      const startedAt = Date.now()
      let startupFinished = false
      let startupWatch: ProviderStartupWatch | undefined
      let observeSpawn: (watch: ProviderStartupWatch) => void = () => undefined
      const spawned = new Promise<ProviderStartupWatch>((resolve) => {
        observeSpawn = resolve
      })
      hostLog("claude-sdk", "initializing", { conversation: conversationId })
      const authDiagnostics = claudeAuthDiagnostics(config.env ?? process.env, fields =>
        hostWarn("claude-auth", "Native authentication failure", { conversation: conversationId, ...fields }))
      let query: ClaudeQuery
      try { query = dependencies.query({
        prompt: input,
        options: {
          ...config,
          hooks: {
            ...config.hooks,
            SessionStart: [
              ...(config.hooks?.SessionStart ?? []),
              { hooks: [transcript.hook] },
            ],
            Stop: [...(config.hooks?.Stop ?? []), { hooks: [transcript.hook] }],
            PostCompact: [...(config.hooks?.PostCompact ?? []), { hooks: [notices.hook] }],
          },
          spawnClaudeCodeProcess: (options) => {
            const child = trace.sync("spawn", () => spawnClaudeProcess(options, conversationId))
            if (!startupFinished) {
              startupWatch = new ProviderStartupWatch(child, { harness: "Claude" })
              observeSpawn(startupWatch)
              hostLog("claude-sdk", "process spawned", {
                conversation: conversationId, pid: child.pid, ms: Date.now() - startedAt,
              })
            }
            exited = new Promise<void>((resolve) => {
              child.once("exit", (code, signal) => {
                hostLog("claude-sdk", "process exited", {
                  conversation: conversationId, pid: child.pid, code, signal,
                  ms: Date.now() - startedAt,
                })
                resolve()
              })
              child.once("error", () => resolve())
            })
            void exited.then(disposeApprovals)
            return child
          },
          canUseTool: permissions.tool,
          onElicitation: permissions.elicitation,
        },
      }) } catch (error) { await disposeApprovals(); throw error }
      const live: Live = {
        query,
        exited: () => exited,
        input,
        permissions,
        approvals,
        disposeApprovals,
        authDiagnostics,
        transcript,
        emit: options.emit,
        projection: new ClaudeProjection(),
        notices,
        terminalCommands: new Set(),
        agents: new ClaudeAgents(),
        receipts: new Map(),
        closed: false,
        steered: false,
        finishing: false,
        state: {
          id: options.conversationId,
          harness: "claude",
          cwd,
          title: options.title,
          nativeId: options.fork
            ? options.conversationId
            : (options.resume ?? options.conversationId),
          status: "starting",
          connection: "starting",
          modes: CLAUDE_MODES,
          currentMode: null,
          configOptions: [],
          settings: options.tuning,
        },
      }
      sessions.set(live.state.id, live)
      void pump(engine, live)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const initialization = query.initializationResult()
        await trace.step("sdk-initialization", () => Promise.race([
          initialization,
          spawned.then((watch) => watch.step("SDK initialization", initialization)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Claude SDK initialization exceeded the startup limit")),
              STARTUP_TOTAL_MS
            )
          }),
        ]))
        if (live.closed)
          throw new Error("Claude disconnected during initialization")
        engine.patch(live, {
          status: "ready",
          connection: "connected",
          nativePath: transcript.path,
        })
        hostLog("claude-sdk", "initialized", {
          conversation: conversationId, ms: Date.now() - startedAt,
          steps: startupWatch?.summary(),
        })
        return live.state
      } catch (error) {
        if (error instanceof Error) authDiagnostics.failure(error.message)
        hostWarn("claude-sdk", "initialization failed", {
          conversation: conversationId, ms: Date.now() - startedAt,
          spawned: startupWatch !== undefined, steps: startupWatch?.summary(),
        })
        stop(live)
        throw error
      } finally {
        startupFinished = true
        clearTimeout(timer)
        startupWatch?.dispose()
      }
    }),
    async prompt(id, text, attachments, settings, dispatch) {
      const { live, content } = await preparePromptAsync(dispatch, async () => {
        const live = requireLive(id)
        if (live.state.status === "running")
          throw new Error("Claude is already working")
        const content = await claudeInputContent(text, attachments)
        await tune(live, settings)
        return { live, content }
      })
      preparePrompt(dispatch, () => {
        const current = requireLive(id)
        if (current !== live || current.state.status === "running")
          throw new Error("Claude changed while preparing the prompt")
      })
      const uuid = dispatch.attemptId
      live.promptReceipt = { id: uuid, dispatch }
      // The input queue refuses before holding the message, so a refusal
      // means Claude never saw it; the turn is marked running only once it
      // is queued. Its consumer resumes after this synchronous section.
      try {
        preparePrompt(dispatch, () => live.input.send({
          type: "user",
          uuid,
          session_id: live.state.nativeId,
          parent_tool_use_id: null,
          message: { role: "user", content },
        }))
      } catch (error) {
        live.promptReceipt = undefined
        throw error
      }
      live.projection.reset()
      live.transcript.reset()
      engine.patch(live, {
        status: "running",
        nativeForkId: undefined,
        nativeRunId: uuid,
        lastStop: undefined,
        error: undefined,
      })
      engine.emitUpdate(live, { kind: "user", text })
      dispatch.report({ kind: "submitted", source: "sdk-input", correlationId: uuid })
    },
    async steer(id, input) {
      const live = requireLive(id)
      const content = await claudeInputContent(input.text, input.attachments)
      if (
        live.closed ||
        live.finishing ||
        live.state.status !== "running" ||
        live.state.nativeRunId !== input.expectedRunId
      )
        return {
          kind: "not-accepted",
          reason: "The Claude turn has already changed",
        }
      const uuid = randomUUID()
      const receipt = new Promise<ProviderSteerResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          live.receipts.delete(uuid)
          reject(
            new Error(
              "Claude has not confirmed steering delivery. Do not resend automatically."
            )
          )
        }, dependencies.receiptTimeoutMs ?? 120_000)
        live.receipts.set(uuid, { resolve, reject, timer })
      })
      try {
        live.input.send({
          type: "user",
          uuid,
          session_id: live.state.nativeId,
          parent_tool_use_id: null,
          priority: "now",
          message: { role: "user", content },
        })
        live.steered = true
      } catch (error) {
        const pending = live.receipts.get(uuid)
        if (pending) {
          clearTimeout(pending.timer)
          live.receipts.delete(uuid)
          pending.reject(
            error instanceof Error ? error : new Error(String(error))
          )
        }
      }
      return receipt
    },
    compaction: { kind: "supported", async start(id, actionId) {
      const live = requireLive(id)
      if (live.state.status === "running")
        throw new Error("Wait for Claude to finish before compacting")
      const uuid = randomUUID()
      live.compaction = { actionId, runId: uuid, confirmed: false }
      engine.patch(live, {
        status: "running",
        nativeRunId: uuid,
        lastStop: undefined,
        error: undefined,
      })
      live.input.send({
        type: "user",
        uuid,
        session_id: live.state.nativeId,
        parent_tool_use_id: null,
        message: { role: "user", content: "/compact" },
      })
    } },
    async permission(id, requestId, response, dispatch) {
      dispatch.assertCurrent()
      const live = sessions.get(id)
      dispatch.report(live ? live.permissions.respond(requestId, response)
        : { kind: "not-submitted", pending: false, reason: "request-ended" })
    },
    async setMode(id, modeId) {
      const live = requireLive(id)
      const mode = ClaudeModeSchema.parse(modeId)
      await live.query.setPermissionMode(mode)
      engine.patch(live, { currentMode: mode })
    },
    async cancel(id) {
      const live = requireLive(id)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          live.query.interrupt(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Claude interrupt timed out; the process was closed"
                  )
                ),
              dependencies.interruptTimeoutMs ?? 20_000
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
        // Query.interrupt can leave SDK-queued input behind. Closing its process
        // makes Stop definitive; the next prompt resumes the same native session.
        stop(live)
        await live.exited()
        // The interrupt's own `error_during_execution` result may have settled
        // the turn as failed first; Stop ends it interrupted.
        engine.patch(live, {
          status: "ready",
          connection: "disconnected",
          lastStop: "interrupted",
          error: undefined,
          backgroundTasks: 0,
        })
      }
    },
    async close(id) {
      starting.delete(id)
      const live = sessions.get(id)
      if (!live) return
      stop(live)
      sessions.delete(id)
      await live.exited()
      await live.disposeApprovals()
    },
  }
}
