import { answersId, type PrefetchLaunch } from "./start-prefetch.js"
import { applyControlEnvironment } from "../control/index.js"
import { launchContext, observeNativeIdentity, reportedIdentity, reportedRuntime } from "../base/execution-context.js"
import { CODEX_NATIVE_IDENTITY } from "./codex/live-driver.js"
import { applyThreadEnvironment } from "../workspaces/index.js"
import { join } from "node:path"
import { CodexPermissionObserver, codexApprovalEnvironment } from "./codex/permission-observer.js"
import type { ApprovalSubmission } from "../contracts/approval-response.js"
import { preparePrompt, TurnInProgressError, type PromptDispatch } from "./prompt-dispatch.js"
import { ProviderStartupWatch } from "./provider-startup.js"
import type { ProviderLaunchTrace } from "./provider-launch.js"
import { CodexAgents } from "./codex/agents.js"
import { CodexRolloutTail } from "./codex/rollout-tail.js"
import { codexServiceTier } from "@mako/sessions/model-catalog"
import type { SessionSettings } from "@mako/sessions/settings"
import { CODEX_CLIENT_CAPABILITIES, codexCollaborationMode, codexInteractiveConfig, codexWireSettings } from "./codex/settings.js"
import { codexInput } from "./codex/input.js"
import { codexRuntimeVersion } from "./codex/native-context.js"
import type {
  ProviderSteerInput,
  ProviderSteerResult,
} from "./live-driver.js"
import { resolveCodexExecutable } from "./codex/executable.js"
import { SHUTDOWN_GRACE_MS, conversationServers, type AdmittedStartOptions, type DriverGoalCommand, type DriverSideQuestion } from "./live-driver.js"
import { codexGoalObservation } from "./codex/goals.js"
import { reviewDisplayText, type ReviewTarget } from "../contracts/live-reviews.js"
import type { ReviewTarget as CodexReviewTarget } from "./codex/generated/v2/ReviewTarget.js"
import { CodexSideQuestions } from "./codex/side-questions.js"
import { hostWarn } from "../base/host-log.js"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawnProviderProcess } from "./provider-process.js"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { mergeWindows } from "../contracts/account-usage.js"
import { CodexDecoder } from "./codex/decoder.js"
import { nativeStream, streamRuntime, type NativeStream } from "./native-stream.js"
import { environmentForExecutable } from "../base/executable.js"
import { codexMcpConfig, mergeCodexConfig } from "../tools/index.js"
import {
  clearTurnServerRequests,
  handleServerRequest,
  resolvePermission,
  resolveServerRequest,
  type PendingServerRequest,
  type PermissionCallbacks,
} from "./codex-app-permissions.js"
import { codexAccessModes, codexAccessTier, codexObservedTier, codexTurnAccess } from "./codex/access.js"
import { accessModeId, type AccessTier } from "../contracts/access.js"
import { boundedText } from "../base/json-values.js"
import type { JsonObject } from "../contracts/json.js"
import { LineAssembler } from "@mako/sessions"
import {
  cleanBackground,
  stopBackgroundTerminal,
  drainStoppedCommands,
  retainStoppedTurn,
  endSubagents,
  consumeStdout,
  MAX_STDOUT_BUFFER,
  drawRollout,
  rpcRequest,
  sendRpc,
  sendRpcError,
  sendRpcResult,
  type ProtocolContext,
} from "./codex-app-protocol.js"
import type {
  CodexFrame,
  PendingRpc,
  ProtocolCallbacks,
  RpcParams,
  ThreadResponse,
  Tuning,
} from "./codex-app-types.js"
import type { LivePermissionResponse, PromptAttachment, LiveSessionState } from "../contracts/providers-acp.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { LiveDriverEvent } from "../contracts/live-conversations.js"
import type { McpRegistrySnapshot } from "../contracts/mcp-skills-integrations.js"
import { createLiveEngine } from "./live-engine.js"
import { approvalRoot, type HarnessContext } from "./host.js"

type Live = {
  compaction?: { actionId: string; turnId?: string; confirmed: boolean }
  id: string
  cwd: string
  emit(event: LiveDriverEvent): void
  child: ChildProcessWithoutNullStreams
  processClosed: Promise<void>
  threadId: string | null
  promptSequence: number
  currentTurnId: string | null
  /** Stop arrived before turn/start answered: interrupt the turn once its id is known. */
  interruptWhenStarted: boolean
  /** Waiting for the running turn to settle, or for the app-server to exit. */
  settling: Array<() => void>
  stoppedTurns: Set<string>
  stoppingCommands: Set<Promise<void>>
  startingTurn?: Promise<void>
  resolveTurnStart?: () => void
  canceling?: Promise<void>
  deferredStop?: Partial<LiveSessionState>
  /** The chosen tier; sent with every turn/start and kept by Codex afterwards. */
  access: AccessTier | null
  state: LiveSessionState
  tuning?: Tuning
  /** Mako's own servers, opened with the token in `MAKO_CONVERSATIONS_TOKEN`. */
  makoServers: Array<{ name: string; url: string }>
  mcpSnapshot: McpRegistrySnapshot
  nextRequestId: number
  pending: Map<string, PendingRpc>
  serverRequests: Map<string, PendingServerRequest>
  decoder: CodexDecoder
  rollout?: CodexRolloutTail
  stream: NativeStream<CodexFrame> | null
  background: ProtocolContext["background"]
  subagentTurns: Map<string, Array<() => void>>
  sides: CodexSideQuestions
  stdoutLines: LineAssembler
  stderrBuffer: string
  approvals: CodexPermissionObserver
  agents: CodexAgents
  protocol: ProtocolCallbacks
  startupWatch: ProviderStartupWatch | null
  exited: boolean
}

const MAX_STDERR_BUFFER = 16 * 1024
const MAX_PROMPT_CHARS = 1_000_000

const permissionCallbacks: PermissionCallbacks<Live> = {
  identify: (live, call, choices) => live.approvals.identify(call, choices),
  submitted: (live, identity, response) => live.approvals.submitted(identity, response),
  emit: (live, event) => live.emit(event),
  sendResult: (live, id, result) => sendRpcResult(live, id, result),
  sendError: (live, id, code, message) => sendRpcError(live, id, code, message),
}

export type CodexEngine = ReturnType<typeof createCodexEngine>

function codexReviewTarget(target: ReviewTarget): CodexReviewTarget {
  switch (target.kind) {
    case "changes":
      return { type: "uncommittedChanges" }
    case "branch":
      return { type: "baseBranch", branch: target.base }
    case "commit":
      return { type: "commit", sha: target.sha, title: target.title ?? null }
  }
}

const CODEX_APP_SERVER_ARGS = ["app-server"]
const CODEX_INITIALIZE = {
  clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
  capabilities: CODEX_CLIENT_CAPABILITIES,
}

/**
 * A start's app-server, through `initialize` and a `thread/start` in `cwd`, for the driver's `startPrefetch`. The
 * thread is ephemeral and never takes a turn, so Codex keeps nothing of it: a process's first `thread/start` costs it
 * 0.4 s cold and the next process's 0.12 s (2026-10-20).
 */
export async function codexStartPrefetch(base: NodeJS.ProcessEnv, cwd: string): Promise<PrefetchLaunch | undefined> {
  const command = await resolveCodexExecutable(base)
  if (!command) return undefined
  const initialize = { jsonrpc: "2.0", id: 0, method: "initialize", params: CODEX_INITIALIZE }
  const open = { jsonrpc: "2.0", id: 1, method: "thread/start", params: { cwd, ephemeral: true } }
  return {
    command,
    args: CODEX_APP_SERVER_ARGS,
    env: codexApprovalEnvironment({ ...base }),
    exchange: [
      { send: JSON.stringify(initialize), answer: answersId(0) },
      { send: `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n${JSON.stringify(open)}`, answer: answersId(1) },
    ],
  }
}

/** Codex's sessions, each an app-server this engine started and closes. */
export function createCodexEngine(context: Pick<HarnessContext, "dataRoot" | "streams">) {
  const engine = createLiveEngine<Live>()
  const sessions = engine.sessions
  const closingSessions = new Map<string, Promise<void>>()

  async function startCodex(cwd: string, options: AdmittedStartOptions): Promise<LiveSessionState> {
    const { trace } = options
    const id = options.conversationId
    const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
    const mcpSnapshot = await trace.step("mcp-preparation", () => options.mcpSnapshot?.() ?? Promise.resolve({ cwd: workingDir, generatedAt: Date.now(), servers: [], providers: [] }))
    const { env, account: configuredAccount } = options.accountLaunch
    if (options.conversationTools)
      env.MAKO_CONVERSATIONS_TOKEN = options.conversationTools.token
    applyControlEnvironment(env, options.conversationTools?.control)
    applyThreadEnvironment(env, options.threadEnvironment)
    const executable = await trace.step("runtime-discovery", () => resolveCodexExecutable(env))
    if (!executable) throw new Error("Codex is not installed")
    const child = trace.sync("spawn", () => spawnProviderProcess(executable, CODEX_APP_SERVER_ARGS, {
      cwd: workingDir,
      env: environmentForExecutable(executable, codexApprovalEnvironment(env)),
      shell: false,
      windowsHide: true,
    }, { kind: "codex:app-server", owner: id }))
    const emit = (event: LiveDriverEvent) => {
      try {
        options.emit(event)
      } catch {
        return
      }
    }
    const live: Live = {
      id,
      cwd: workingDir,
      child,
      processClosed: new Promise(resolve => child.once("close", () => resolve())),
      threadId: null,
      promptSequence: 0,
      currentTurnId: null,
      interruptWhenStarted: false,
      // A chosen or remembered tier names a turn/start policy pair; it applies
      // from the first turn. An invalid id fails the start, matching the
      // ledger's "must apply or fail" rule.
      access: options.modeId ? codexAccessTier(options.modeId) : null,
      state: {
        executionContext: launchContext("codex-app-server", CODEX_NATIVE_IDENTITY, configuredAccount, executable),
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
      emit,
      makoServers: options.conversationTools ? conversationServers(options.conversationTools) : [],
      mcpSnapshot,
      nextRequestId: 0,
      pending: new Map(),
      serverRequests: new Map(),
      decoder: new CodexDecoder({
        get threadId() { return live.threadId },
        get state() { return live.state },
      }),
      stream: nativeStream("codex", id, () => ({ threadId: live.threadId }), context.streams, () => live.state.nativeId),
      background: { running: new Set() },
      subagentTurns: new Map(),
      sides: new CodexSideQuestions(
        (method, params) => rpcRequest(live, method, params),
        (requestId) => sendRpcError(live, requestId, -32000, "A side question can't ask for anything."),
      ),
      settling: [],
      stoppedTurns: new Set(),
      stoppingCommands: new Set(),
      stdoutLines: new LineAssembler(MAX_STDOUT_BUFFER),
      stderrBuffer: "",
      approvals: new CodexPermissionObserver(join(approvalRoot(context), "codex"), options.observedApprovals ?? [], decision => emit({ type: "live-approval-decision", id, decision })),
      agents: new CodexAgents({
        read: async (threadId) => {
          const result = await rpcRequest(live, "thread/turns/list", {
            threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
          })
          return result.data[0] ?? null
        },
        publish: (agent) => engine.emitAgent(live, agent),
      }),
      protocol: {
        actionResult: (actionId, result) => emit({ type: "live-action-result", id: live.id, actionId, result }),
        handleFatal: (message) => protocolFatal(live, message),
        updateState: (patch) => updateState(live, patch),
        emitUpdate: (update) => emitUpdate(live, update),
        activity: (activity) => engine.activity(live, activity),
        compacted: (compaction, markerId) => engine.compacted(live, compaction, markerId),
        event: (marker, markerId) => engine.event(live, marker, markerId),
        unhandled: (kind, reason, raw) =>
          raw === undefined ? engine.unhandled(live, kind) : engine.unknown(live, kind, reason ?? "unknown", raw),
        usage: (windows) => options.observeUsage((previous) => mergeWindows(previous, windows, Date.now())),
        rewound: (run) => emit({ type: "live-rewound", id: live.id, run }),
        goal: (goal) => emit({ type: "live-goal", id: live.id, goal }),
        observeAgentTurn: (nativeId) => live.agents.refresh(nativeId),
        observeBackground: (items) => {
          for (const item of items) engine.emitAgent(live, item)
        },
        observeAgents: (item, replay, toolId) => {
          for (const agent of live.agents.project(item, replay, toolId))
            engine.emitAgent(live, agent)
        },
        observeQuestionAnswer: answer => emit({ type: "live-question-answered", id: live.id, answer }),
        observeQuestion: question => emit({ type: "live-question", id: live.id, question }),
        handleServerRequest: (rpcId, method, params) =>
          handleServerRequest(live, permissionCallbacks, rpcId, method, params),
        resolveServerRequest: (rpcId) => resolveServerRequest(live, permissionCallbacks, rpcId),
        clearTurnServerRequests: (turnId) =>
          clearTurnServerRequests(live, turnId),
      },
      startupWatch: null,
      exited: false,
    }
    sessions.set(id, live)
    bindProcess(live)

    const watch = new ProviderStartupWatch(child, {
      harness: "Codex",
      stderr: () => live.stderrBuffer,
    })
    live.startupWatch = watch
    try {
      const response = await openThread(live, watch, trace, options.resume, options.fork)
      clearStartupWatch(live)
      live.threadId = response.thread.id
      live.rollout = response.thread.path ? new CodexRolloutTail(response.thread.path) : undefined
      live.rollout?.follow(() => {
        if (!live.exited) drawRollout(live)
      })
      if (options.resume === response.thread.id && !options.fork)
        live.agents.restore(options.observedAgents ?? [])
      if (response.thread.cwd !== undefined) live.cwd = response.thread.cwd
      const settings: SessionSettings = { model: response.model, options: {} }
      if (response.reasoningEffort)
        settings.options!.effort = response.reasoningEffort
      if (response.serviceTier !== undefined)
        settings.options!.serviceTier = codexServiceTier(
          response.serviceTier ?? "default"
        )
      const observedAccess = codexObservedTier(response)
      updateState(live, {
        nativeId: response.thread.id,
        nativePath: response.thread.path ?? undefined,
        settings,
        status: "ready",
        connection: "connected",
        cwd: live.cwd,
        error: undefined,
        // A choice is already in force; otherwise the approval/sandbox pair the
        // thread reports is the level the session opened with.
        currentMode:
          options.modeId ?? (observedAccess ? accessModeId(observedAccess) : null),
      })
      return live.state
    } catch (error) {
      clearStartupWatch(live)
      const fallback =
        lastLine(live.stderrBuffer) || "Codex app-server failed to start"
      const message =
        error instanceof Error && error.message ? error.message : fallback
      failLive(live, message)
      await codexAppClose(id)
      throw new Error(message, { cause: error })
    }
  }

  async function codexAppPrompt(
    id: string,
    text: string,
    attachments: PromptAttachment[],
    tuning: Tuning | undefined,
    dispatch: PromptDispatch
  ): Promise<void> {
    await codexAppTurn(id, dispatch, {
      text,
      attachments,
      tuning,
      // Codex starts its goal's next turn the moment a turn ends, so a queued
      // message can find one running; `turn/start` steers into it.
      joinsGoal: true,
      check: () => {
        if (!text.trim() && !attachments.length)
          throw new Error("A prompt cannot be empty")
        if (text.length > MAX_PROMPT_CHARS)
          throw new Error("The prompt is too large for the Codex app-server adapter")
      },
      start: (live, threadId) => rpcRequest(live, "turn/start", {
        threadId,
        input: codexInput(text, attachments),
        cwd: live.cwd,
        ...codexWireSettings(tuning),
        ...codexCollaborationMode(tuning, live.state.settings?.model),
        ...codexTurnAccess(live.access),
      }),
    })
  }

  /** Codex's own review, inline on the thread: a turn that ends with its findings. */
  async function codexAppReview(
    id: string,
    target: ReviewTarget,
    _tuning: Tuning | undefined,
    dispatch: PromptDispatch
  ): Promise<void> {
    await codexAppTurn(id, dispatch, {
      text: reviewDisplayText(target),
      attachments: [],
      joinsGoal: false,
      check: () => {},
      start: (live, threadId) => rpcRequest(live, "review/start", { threadId, target: codexReviewTarget(target), delivery: "inline" }),
    })
  }

  interface CodexTurnStart {
    /** What the transcript shows the user sent. */
    text: string
    attachments: PromptAttachment[]
    /** The settings the turn goes with, kept once Codex accepts it. */
    tuning?: Tuning
    joinsGoal: boolean
    check(): void
    start(live: Live, threadId: string): Promise<{ turn: { id: string } }>
  }

  async function codexAppTurn(id: string, dispatch: PromptDispatch, turn: CodexTurnStart): Promise<void> {
    const { live, threadId, joining } = preparePrompt(dispatch, () => {
      const live = sessions.get(id)
      if (!live?.threadId || live.exited || closingSessions.has(id))
        throw new Error("This Codex session is not running")
      const joining = live.state.status === "running" && turn.joinsGoal ? live.decoder.goalTurn() : null
      if (live.state.status === "running" && !joining)
        throw new TurnInProgressError("Codex")
      turn.check()
      return { live, threadId: live.threadId, joining }
    })
    const sequence = ++live.promptSequence
    let resolveStarted = () => {}
    const startingTurn = new Promise<void>(resolve => { resolveStarted = resolve })
    live.startingTurn = startingTurn
    live.resolveTurnStart = resolveStarted
    live.interruptWhenStarted = false
    if (!joining)
      updateState(live, {
        status: "running",
        nativeRunId: undefined,
        error: undefined,
        lastStop: undefined,
      })
    emitUpdate(live, { kind: "user", text: turn.text })
    live.stream?.prompted({ text: turn.text, shown: dispatch.shown, shownAt: dispatch.shownAt, attachments: turn.attachments })
    live.decoder.expectTurn()
    try {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const result = await turn.start(live, threadId)
      dispatch.report({ kind: "accepted", source: "native-response", referenceId: result.turn.id })
      // Steered into the goal's turn, the message starts none of its own.
      if (result.turn.id === joining) live.decoder.expectTurn(false)
      if (live.promptSequence === sequence) {
        const { tuning } = turn
        if (tuning) {
          const settings: SessionSettings = {
            ...live.state.settings,
            options: { ...live.state.settings?.options, ...tuning.options },
          }
          if (tuning.model) settings.model = tuning.model
          updateState(live, { settings })
        }
        if (isRunning(live)) {
          live.currentTurnId = result.turn.id
          updateState(live, { nativeRunId: result.turn.id })
        }
        if (live.interruptWhenStarted) {
          live.interruptWhenStarted = false
          await codexAppCancel(id).catch((error) =>
            hostWarn("codex", "A turn stopped while starting could not be interrupted", { conversation: id, error: String(error) }))
        }
      }
    } catch (error) {
      if (live.promptSequence !== sequence || live.exited) return
      live.decoder.expectTurn(false)
      live.interruptWhenStarted = false
      if (joining) throw error
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Codex rejected the turn"
      updateState(live, { status: "failed", error: message, lastStop: "failed" })
      throw new Error(message, { cause: error })
    } finally {
      resolveStarted()
      if (live.startingTurn === startingTurn) {
        live.startingTurn = undefined
        live.resolveTurnStart = undefined
      }
    }
  }

  /** Takes effect on the next turn/start; Codex has no mid-turn policy switch. */
  function codexAppSetMode(id: string, modeId: string): void {
    const live = sessions.get(id)
    if (!live || live.exited) throw new Error("This Codex session is not running")
    live.access = codexAccessTier(modeId)
    updateState(live, { currentMode: modeId })
  }

  function codexAppPermission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): ApprovalSubmission {
    const live = sessions.get(id)
    if (!live) return { kind: "not-submitted", pending: false, reason: "request-ended" }
    return resolvePermission(live, permissionCallbacks, requestId, response)
  }

  /** One terminal the thread left running, through Codex's own terminate; the rest keeps running. */
  async function codexAppStopBackground(id: string, itemId: string): Promise<void> {
    const live = sessions.get(id)
    if (!live?.threadId || live.exited) throw new Error("This Codex session is disconnected")
    await stopBackgroundTerminal(live, itemId)
  }

  /** Stop ends the turn, every terminal the thread left running, and its subagents' work. */
  async function codexAppCancel(id: string): Promise<void> {
    const live = sessions.get(id)
    if (!live?.threadId || live.exited) return
    if (live.canceling) return live.canceling
    const threadId = live.threadId
    if (!live.currentTurnId && isRunning(live) && !live.compaction) {
      // The accepted turn ID will issue this Stop once, without replaying input.
      live.interruptWhenStarted = true
      return
    }
    const operation = Promise.resolve().then(async () => {
      const turnId = live.currentTurnId
      let settled = Promise.resolve()
      let settle = () => {}
      if (turnId) {
        settled = new Promise<void>(resolve => { settle = resolve })
        live.settling.push(settle)
      }
      try {
        if (turnId) retainStoppedTurn(live, turnId)
        // Capture and terminate foreground terminals while the native turn still
        // owns their IDs. Interrupt can discard that ownership before cleanup.
        await cleanBackground(live)
        if (turnId && live.currentTurnId === turnId)
          await rpcRequest(live, "turn/interrupt", { threadId, turnId })
        await settled
        await Promise.all([cleanBackground(live), endSubagents(live)])
        await drainStoppedCommands(live)
        if (live.exited) throw new Error("The native transport ended before Stop cleanup was confirmed")
      } catch (error) {
        live.deferredStop = { status: "failed", lastStop: "failed", error: `Stop cleanup was not confirmed: ${String(error)}` }
        throw error
      } finally {
        live.settling = live.settling.filter(waiter => waiter !== settle)
        live.canceling = undefined
        const patch = live.deferredStop
        live.deferredStop = undefined
        if (patch && !live.exited) updateState(live, patch)
      }
    })
    live.canceling = operation
    return operation
  }

  async function codexAppSteer(
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
    live.stream?.steered(input.text, input.shown)
    return { kind: "accepted" }
  }

  async function codexAppCompact(id: string, actionId: string): Promise<void> {
    const live = sessions.get(id)
    if (
      !live?.threadId ||
      live.exited ||
      (live.state.status !== "ready" && live.state.status !== "failed")
    )
      throw new Error("Wait for Codex to become idle before compacting")
    live.compaction = { actionId, confirmed: false }
    updateState(live, {
      status: "running",
      nativeRunId: undefined,
      lastStop: undefined,
      error: undefined,
    })
    live.decoder.expectTurn()
    await rpcRequest(live, "thread/compact/start", { threadId: live.threadId })
  }

  async function codexAppGoal(id: string, command: DriverGoalCommand): Promise<void> {
    const live = sessions.get(id)
    if (!live?.threadId || live.exited || closingSessions.has(id)) throw new Error("This Codex session is not running")
    const threadId = live.threadId
    if (command.kind === "clear") {
      await rpcRequest(live, "thread/goal/clear", { threadId })
      live.emit({ type: "live-goal", id, goal: null })
      return
    }
    const { goal } = await rpcRequest(live, "thread/goal/set", command.kind === "set"
      ? { threadId, objective: command.objective, status: "active", tokenBudget: command.tokenBudget ?? null }
      : { threadId, status: command.kind === "pause" ? "paused" : "active" })
    live.emit({ type: "live-goal", id, goal: codexGoalObservation(goal) })
  }

  async function codexAppSideQuestion(id: string, question: DriverSideQuestion): Promise<string> {
    const live = sessions.get(id)
    if (!live?.threadId || live.exited || closingSessions.has(id)) throw new Error("This Codex session is not running")
    const settings = codexWireSettings(live.state.settings ?? live.tuning)
    return live.sides.ask({ threadId: live.threadId, cwd: live.cwd, model: settings.model, serviceTier: settings.serviceTier }, question)
  }

  async function codexAppCloseSide(id: string, side: string): Promise<void> {
    const live = sessions.get(id)
    if (!live || live.exited) return
    await live.sides.close(side)
  }

  async function codexAppClose(id: string): Promise<void> {
    const closing = closingSessions.get(id)
    if (closing) return closing
    const live = sessions.get(id)
    if (!live) return
    // Install the closing fence before the first native call. Keep decoding until
    // Stop has settled and every observed late terminal's termination has replied.
    const operation = Promise.resolve().then(async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        if (!live.exited) await Promise.race([
          (async () => {
            await live.startingTurn
            await codexAppCancel(id)
            await drainStoppedCommands(live)
            if (live.exited) throw new Error("The native transport ended before Close cleanup was confirmed")
          })(),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("Codex Close cleanup was not confirmed before the shutdown deadline")), SHUTDOWN_GRACE_MS)
          }),
        ])
      } finally {
        clearTimeout(deadline)
        updateState(live, { status: "closed" })
        live.stream?.closed()
        disposeLive(live, new Error("Codex session closed"))
        if (!live.child.killed) live.child.kill()
        await live.processClosed
        await live.approvals.close()
        if (sessions.get(id) === live) sessions.delete(id)
      }
    })
    closingSessions.set(id, operation)
    try {
      await operation
    } finally {
      if (closingSessions.get(id) === operation)
        closingSessions.delete(id)
    }
  }

  function stop(): void {
    for (const id of sessions.keys()) void codexAppClose(id)
  }

  async function openThread(
    live: Live,
    watch: ProviderStartupWatch,
    trace: ProviderLaunchTrace,
    resume?: string,
    fork?: { nativeId: string; runId: string }
  ): Promise<ThreadResponse> {
    const initialized = await trace.step("handshake", () => watch.step("initialize", rpcRequest(live, "initialize", CODEX_INITIALIZE)))
    sendRpc(live, { jsonrpc: "2.0", method: "initialized" })
    const runtime = reportedRuntime(codexRuntimeVersion(initialized.userAgent), "app-server initialize.userAgent")
    streamRuntime(live.stream, runtime)
    if (live.state.executionContext) updateState(live, { executionContext: { ...live.state.executionContext, runtime } })
    const identityObservation = trace.step("identity", () => observeNativeIdentity(async () => {
      const { account } = await rpcRequest(live, "account/read", { refreshToken: false })
      return reportedIdentity(account?.type === "chatgpt" ? account.email : undefined, account?.type ?? "signed-out", CODEX_NATIVE_IDENTITY.via)
    }, () => !live.exited && live.state.status !== "closed" && sessions.get(live.id) === live, identity => {
      if (live.state.executionContext) updateState(live, { executionContext: { ...live.state.executionContext, identity } })
    }))
    const tuning = threadTuning(
      live.tuning,
      codexMcpConfig(live.mcpSnapshot, live.makoServers)
    )
    const open = () => {
      if (fork)
        return trace.step("session-fork", () => watch.step("thread/fork", rpcRequest(live, "thread/fork", {
          threadId: fork.nativeId,
          lastTurnId: fork.runId,
          cwd: live.cwd,
          ...tuning,
        })))
      if (!resume)
        return trace.step("session-open", () => watch.step("thread/start", rpcRequest(live, "thread/start", { cwd: live.cwd, ...tuning })))
      // An archived native thread is never unarchived to make recovery pass.
      live.stream?.opening()
      return trace.step("session-resume", () => watch.step("thread/resume", rpcRequest(live, "thread/resume", { threadId: resume, cwd: live.cwd, ...tuning }))).then((response) => {
        live.stream?.record({ replay: response })
        live.stream?.opened()
        return response
      })
    }
    const [response] = await Promise.all([open(), identityObservation])
    return response
  }

  function threadTuning(
    tuning: Tuning | undefined,
    mcpConfig: JsonObject
  ): Omit<RpcParams["thread/start"], "cwd"> {
    const result: Omit<RpcParams["thread/start"], "cwd"> = {}
    const selected = codexWireSettings(tuning)
    const base = codexInteractiveConfig(selected.effort)
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
        live.stderrBuffer + live.approvals.stderr(chunk),
        MAX_STDERR_BUFFER
      )
    })
    live.child.on("error", (error) => handleProcessEnd(live, error.message))
    live.child.once("close", () => {
      void live.approvals.close()
      // Its output is all read once its pipes close: the launch's stream is finished.
      live.stream?.ended()
    })
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
        backgroundTasks: 0,
      })
  }

  function failLive(live: Live, message: string): void {
    if (!live.exited) disposeLive(live, new Error(message))
    if (live.state.status !== "closed")
      updateState(live, {
        status: "failed",
        connection: "disconnected",
        error: message,
        backgroundTasks: 0,
      })
  }

  function disposeLive(live: Live, error: Error): void {
    if (live.exited) return
    live.exited = true
    live.agents.dispose()
    clearStartupWatch(live)
    for (const pending of live.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    live.pending.clear()
    live.serverRequests.clear()
    live.decoder.forgetItems()
    live.rollout?.close()
    live.stdoutLines = new LineAssembler(MAX_STDOUT_BUFFER)
    for (const settle of live.settling.splice(0)) settle()
    for (const waiters of live.subagentTurns.values()) for (const settle of waiters) settle()
    live.subagentTurns.clear()
  }

  function clearStartupWatch(live: Live): void {
    live.startupWatch?.dispose()
    live.startupWatch = null
  }

  function updateState(live: Live, patch: Partial<LiveSessionState>): void {
    // Native turn/started can identify the accepted run before turn/start replies.
    // Close can interrupt that exact run without waiting for the delayed receipt.
    if (patch.nativeRunId) live.resolveTurnStart?.()
    if (patch.status && patch.status !== "running") {
      for (const settle of live.settling.splice(0)) settle()
      if (live.canceling && patch.status !== "closed") {
        live.deferredStop = { ...live.deferredStop, ...patch }
        return
      }
    }
    engine.patch(live, patch)
  }

  function emitUpdate(live: Live, update: LiveUpdate): void {
    if (
      (update.kind === "text" ||
        update.kind === "thinking" ||
        update.kind === "user") &&
      !update.text
    )
      return
    engine.emitUpdate(live, update)
  }

  return {
    start: startCodex,
    prompt: codexAppPrompt,
    setMode: codexAppSetMode,
    permission: codexAppPermission,
    cancel: codexAppCancel,
    stopBackground: codexAppStopBackground,
    steer: codexAppSteer,
    compact: codexAppCompact,
    goal: codexAppGoal,
    review: codexAppReview,
    sideQuestion: codexAppSideQuestion,
    closeSide: codexAppCloseSide,
    close: codexAppClose,
    stop,
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
