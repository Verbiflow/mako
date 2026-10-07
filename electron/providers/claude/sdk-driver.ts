import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
import { preparePrompt, preparePromptAsync, type PromptDispatch } from "../prompt-dispatch.js"
import { ClaudeAgents } from "./sdk-agents.js"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { launchContext, reportedIdentity, reportedRuntime } from "../../execution-context.js"
import { NO_NATIVE_EXCLUSION } from "../../contracts/execution-context.js"
import { join } from "node:path"
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { SessionSettings } from "@mako/sessions/settings"
import { PROVIDER_TURN_FALLBACK } from "@mako/sessions"
import type { LiveSessionMode, LiveSessionState } from "../../shared.js"
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
import { ClaudeDecoder } from "./decoder.js"
import { claudeContextBreakdown } from "./context-breakdown.js"
import { mergeWindows } from "../../contracts/account-usage.js"
import { deliverDecoded, type DecodedSink } from "../../contracts/native-decoding.js"
import type { SelectedAccount, UsageWindow } from "../../account-types.js"
import { nativeCapture, type NativeCapture } from "../../native-capture.js"
import { spawnClaudeProcess } from "./sdk-process.js"
import { ClaudePermissions } from "./sdk-permissions.js"
import { ClaudeApprovalObserver, claudeApprovalAnswerDigest, readClaudeApprovalDecisions } from "./approval-observer.js"
import type { ClaudePermissionObserver, prepareClaudePermissionObserver } from "./permission-observer.js"
import { ClaudeTranscript } from "./sdk-transcript.js"
import { ProviderStartupWatch, STARTUP_TOTAL_MS, stderrDetail } from "../../provider-startup.js"
import { traceProviderLaunch, type ProviderLaunchTrace } from "../../provider-launch.js"
import { hostLog, hostWarn } from "../../host-log.js"
import { CLAUDE_AUTH_LOG, claudeAuthDiagnostics } from "./auth-diagnostics.js"
import { claudeConfigDir, type ClaudeCredentialState } from "./accounts.js"
import { claudeStopReason } from "./sdk-notices.js"
import { claudeCommandLifecycle } from "./sdk-message-kinds.js"
import { fileResumeEvidence } from "../../native-continuation.js"
import { claudeProcessProbe } from "./process-probe.js"

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
> & Partial<Pick<Query, "getContextUsage">>

const CLAUDE_NATIVE_IDENTITY = { kind: "reported", via: "SDK initialization.account" } as const
/** Past Mako's own pipe release, so the SDK's stream can still report the exit first. */
const PROCESS_EXIT_GRACE_MS = 1_500
interface Receipt {
  resolve(result: ProviderSteerResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
/** A turn reported where its account stands: the meter moves without a request. */
function observeLimits(live: Live, windows: UsageWindow[]): void {
  void import("../../accounts.js").then((accounts) =>
    accounts.observeAccountUsage("claude", live.account, (previous) => mergeWindows(previous, windows, Date.now())))
}

interface Live {
  /** The account this session spends, resolved beside its start. */
  account: string
  compaction?: { actionId: string; runId: string; confirmed: boolean }
  decoder: ClaudeDecoder
  sink?: DecodedSink<never>
  capture: NativeCapture | null
  state: LiveSessionState
  query: ClaudeQuery
  input: ClaudeInput
  agents: ClaudeAgents
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
export interface ClaudeSdkConfiguration {
  options: Options
  account: SelectedAccount
}

export interface ClaudeSdkDependencies {
  available(): boolean
  configure(cwd: string, options: ProviderStartOptions, trace: ProviderLaunchTrace): Promise<ClaudeSdkConfiguration>
  query(input: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }): ClaudeQuery
  interruptTimeoutMs?: number
  receiptTimeoutMs?: number
  prepareApprovals?: (input: Omit<Parameters<typeof prepareClaudePermissionObserver>[0], "root">) => Promise<ClaudePermissionObserver | undefined>
  inspectCredentials?: (env: NodeJS.ProcessEnv) => Promise<ClaudeCredentialState>
  /** The config folder an account's sessions are kept under. */
  configDir?: (account: string) => string
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
  const lifecycle = claudeCommandLifecycle(message)
  if (lifecycle && lifecycle.state !== "cancelled") ids.add(lifecycle.command_uuid)
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

/** What the decoder makes of a message reaches the session; plan-limit windows move the account's meter. */
function decode(engine: Engine, live: Live, message: SDKMessage): void {
  if (live.capture) live.capture.record(JSON.parse(JSON.stringify(message)))
  live.sink ??= engine.sink(live, { effect: () => undefined, usage: (windows) => observeLimits(live, windows) })
  deliverDecoded(live.decoder.decode(message), live.sink)
}

function openProviderTurn(engine: Engine, live: Live): void {
  live.capture?.prompted()
  live.decoder.startTurn()
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
      if (message.type === "system" && message.subtype === "init" && live.state.executionContext)
        engine.patch(live, { executionContext: {
          ...live.state.executionContext,
          runtime: reportedRuntime(message.claude_code_version, "system/init.claude_code_version"),
        } })
      if (live.state.status === "starting" && message.type === "system" &&
        (message.subtype === "hook_started" || message.subtype === "hook_response"))
        hostLog("claude-sdk", "startup event", {
          conversation: live.state.id, event: message.subtype,
        })
      acknowledge(live, message)
      live.authDiagnostics.observe(message)
      live.transcript.observe(message)
      live.approvals.observe(message)
      if (message.type === "system" && message.subtype === "compact_boundary" &&
        message.compact_metadata.trigger === "manual" && live.compaction)
        live.compaction.confirmed = true
      const agent = live.agents.project(message)
      if (agent) engine.emitAgent(live, agent)
      if (message.type === "system" && message.subtype === "task_notification" &&
        !message.ambient && live.state.status !== "running")
        live.providerTurnCause = message.summary
      // `init` opens every turn and never arrives between turns (SDK 0.3.283).
      // Mako marks its own turns running before sending, so an `init` while
      // settled is a turn Claude started itself, after a task notification.
      if (message.type === "system" && message.subtype === "init" &&
        (live.state.status === "ready" || live.state.status === "failed"))
        openProviderTurn(engine, live)
      decode(engine, live, message)
      if (message.type === "conversation_reset") {
        live.transcript.follow(message.new_conversation_id)
        engine.patch(live, { nativePath: live.transcript.path, nativeForkId: undefined })
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
    await disconnect(engine, live, error instanceof Error ? error.message : String(error))
  }
}

/** The session's process is gone: one failed and disconnected update, with the transcript it resumes from. */
async function disconnect(engine: Engine, live: Live, detail: string): Promise<void> {
  if (live.closed) return
  live.authDiagnostics.failure(detail)
  const nativePath = await live.transcript.locate(live.state.nativeId)
  if (live.closed) return
  stop(live)
  engine.patch(live, {
    nativePath,
    status: "failed",
    connection: "disconnected",
    error: detail,
    lastStop: "failed",
    backgroundTasks: 0,
  })
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
    launchEnvironment: { kind: "prepared", via: "SDK configuration consumes ProviderStartOptions.accountLaunch." },
    nativeIdentity: CLAUDE_NATIVE_IDENTITY,
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["structured-question", ...(dependencies.prepareApprovals ? ["tool-permission" as const] : [])], coverage: "Parent AskUserQuestion results in the saved branch; parent tool decisions from the bundled runtime's local native event exporter, retained before delivery. Existing telemetry configuration, custom runtimes, child tools and MCP elicitation retain submission evidence unless a matching observer is available. Missing native events never confirm an answer." },
    planning: { via: "mode", mode: "plan", proposal: "ExitPlanMode's `plan` input, built by answering its permission request" },
    approvalAnswerDigest: claudeApprovalAnswerDigest,
    resume: {
      kind: "native",
      via: "The Agent SDK's `resume` option with the session ID, after the session file is checked.",
      wake: "The next message starts a new `claude` process that resumes the session from its file.",
      ...fileResumeEvidence(claudeProcessProbe),
      async locate(binding) {
        const account = binding.executionContext?.account
        const name = account?.kind === "configured" ? account.name : "default"
        return new ClaudeTranscript((dependencies.configDir ?? claudeConfigDir)(name)).locate(binding.nativeId)
      },
    },
    fork: { kind: "native", point: "checkpoint", via: "The Agent SDK's `forkSession` at a checkpoint (`resumeSessionAt`)." },
    questions: { kind: "request", via: "AskUserQuestion reaches Mako as a tool approval carrying its questions; the answers return as the tool's input." },
    nativeAgents: { kind: "observed", via: "Agent and Workflow tool calls and their sidechain messages." },
    modeSwitching: { kind: "native", via: "Claude Code's permission modes, set on the running query with `setPermissionMode`." },
    backgroundStop: { kind: "ends-on-stop", how: "Stop interrupts and closes the Claude process, with or without a running turn, which ends its background tasks; the next prompt resumes the session. Mako declares no per-task stop affordance, so an interrupt stops them too." },
    turnRecovery: {
      kind: "continues",
      accepted: "The SDK's echo of the prompt's user message, as the turn starts.",
      exit: "The SDK stream's failure when the process dies settles the session failed and disconnected in one update, with the transcript found by session ID when no hook has reported it yet.",
      tests: ["scripts/test-claude-sdk.ts", "scripts/test-turn-recovery-live.mjs"],
    },
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
      let account: SelectedAccount
      let toolApprovals: ClaudePermissionObserver | undefined
      try {
        const configured = await trace.step("configuration", () => dependencies.configure(cwd, options, trace))
        config = configured.options
        account = configured.account
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
      const transcript = new ClaudeTranscript((config.env ?? process.env).CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), (path) => {
        if (!live.closed && live.state.nativePath !== path) engine.patch(live, { nativePath: path })
      })
      const decoder = new ClaudeDecoder({
        get state() { return live.state },
        restores: options.resume && !options.fork ? { totals: options.observedUsage } : undefined,
      })
      const permissions = new ClaudePermissions(
        options.conversationId,
        options.emit,
        approvals,
        toolApprovals
      )
      if (options.modeId === "plan") permissions.planReturn = ClaudeModeSchema.safeParse(options.launchModeId).data
      let exited = Promise.resolve()
      let disposedApprovals: Promise<void> | undefined
      const disposeApprovals = () => disposedApprovals ??= exited.then(() => toolApprovals?.dispose()).then(() => {}, () => {
        hostWarn("claude-sdk", "Approval observation cleanup failed", { conversation: conversationId })
      })
      const startedAt = Date.now()
      let startupFinished = false
      let startupWatch: ProviderStartupWatch | undefined
      let startupStderr = () => ""
      let observeSpawn: (watch: ProviderStartupWatch) => void = () => undefined
      let processGone: (detail: string) => void = () => undefined
      const spawned = new Promise<ProviderStartupWatch>((resolve) => {
        observeSpawn = resolve
      })
      hostLog("claude-sdk", "initializing", { conversation: conversationId })
      const authDiagnostics = claudeAuthDiagnostics(config.env ?? process.env, fields =>
        hostWarn(CLAUDE_AUTH_LOG, "Native authentication failure", { conversation: conversationId, ...fields }),
      dependencies.inspectCredentials)
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
            // A fresh session reports its transcript at the first prompt, not only when that turn ends.
            UserPromptSubmit: [...(config.hooks?.UserPromptSubmit ?? []), { hooks: [transcript.hook] }],
            Stop: [...(config.hooks?.Stop ?? []), { hooks: [transcript.hook] }],
            PostCompact: [...(config.hooks?.PostCompact ?? []), { hooks: [decoder.hook] }],
          },
          spawnClaudeCodeProcess: (options) => {
            const { child, stderr } = trace.sync("spawn", () => spawnClaudeProcess(options, conversationId))
            if (!startupFinished) {
              startupWatch = new ProviderStartupWatch(child, { harness: "Claude", stderr })
              startupStderr = stderr
              observeSpawn(startupWatch)
              hostLog("claude-sdk", "process spawned", {
                conversation: conversationId, pid: child.pid, ms: Date.now() - startedAt,
              })
            }
            exited = new Promise<void>((resolve) => {
              child.once("exit", (code, signal) => {
                const fields = { conversation: conversationId, pid: child.pid, code, signal, ms: Date.now() - startedAt }
                if (code === 0 || signal === "SIGTERM") hostLog("claude-sdk", "process exited", fields)
                // Durable logs carry no native output; the failure itself surfaces through startup.
                else hostWarn("claude-sdk", "process exited", { ...fields, stderrBytes: stderr().length })
                resolve()
                // The SDK's stream reports the exit with Claude's own words,
                // unless a process Claude started still holds its output open.
                setTimeout(() => processGone(stderrDetail(stderr()) ||
                  `Claude Code exited${signal ? ` on ${signal}` : code === null ? "" : ` with code ${code}`}`), PROCESS_EXIT_GRACE_MS).unref()
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
      processGone = (detail) => void disconnect(engine, live, detail)
      const context = launchContext("claude-agent-sdk", CLAUDE_NATIVE_IDENTITY, account, config.pathToClaudeCodeExecutable)
      const live: Live = {
        account: account.name,
        query,
        exited: () => exited,
        input,
        permissions,
        approvals,
        disposeApprovals,
        authDiagnostics,
        transcript,
        emit: options.emit,
        decoder,
        capture: nativeCapture("claude", options.conversationId, () => ({ settings: { model: options.tuning?.model ?? null } })),
        agents: new ClaudeAgents(),
        receipts: new Map(),
        closed: false,
        steered: false,
        finishing: false,
        state: {
          executionContext: context,
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
        const initialized = await trace.step("sdk-initialization", () => Promise.race([
          initialization,
          spawned.then((watch) => watch.step("SDK initialization", initialization)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Claude did not finish SDK initialization within ${STARTUP_TOTAL_MS / 1000} s`)),
              STARTUP_TOTAL_MS
            )
          }),
        ]))
        if (live.closed)
          throw new Error("Claude disconnected during initialization")
        // A resumed session's hooks have not reported its transcript yet, and
        // recovery refuses a reopened session that names no source.
        if (options.resume) await transcript.locate(live.state.nativeId)
        if (live.closed)
          throw new Error("Claude disconnected during initialization")
        engine.patch(live, {
          executionContext: {
            ...(live.state.executionContext ?? context),
            identity: reportedIdentity(initialized.account.email, initialized.account.apiProvider ?? "firstParty", CLAUDE_NATIVE_IDENTITY.via),
          },
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
        // The SDK's own "process exited" can win the race with the watch; what
        // Claude printed is the cause either way.
        const detail = stderrDetail(startupStderr())
        const message = error instanceof Error ? error.message : String(error)
        throw detail && !message.includes(detail) ? new Error(`${message}: ${detail}`, { cause: error }) : error
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
      live.capture?.prompted()
      live.decoder.startTurn()
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
    steering: { kind: "supported", lands: "step", via: "A message sent while a turn runs joins the running query and is read at its next step.", async steer(id, input) {
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
    } },
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
    // `summary` answers from the last response's usage without a token-count request per category.
    contextBreakdown: { kind: "itemized", via: "The Agent SDK's `getContextUsage`, by category.", async read(id) {
      const { query } = requireLive(id)
      if (!query.getContextUsage) throw new Error("This Claude session cannot itemize its context")
      return claudeContextBreakdown(await query.getContextUsage({ detail: "summary" }))
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
      const left = ClaudeModeSchema.safeParse(live.state.currentMode).data
      if (mode === "plan" && left && left !== "plan") live.permissions.planReturn = left
      await live.query.setPermissionMode(mode)
      engine.patch(live, { currentMode: mode })
    },
    async cancel(id) {
      const live = requireLive(id)
      // Stop interrupts and then closes the process, which exits non-zero; this
      // line is what tells that exit from a crash in the log.
      hostLog("claude-sdk", "stop requested", { conversation: id, approvalsOpen: live.permissions.open })
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
        // A first turn stopped early has no hook-reported transcript; the next prompt resumes from this one.
        const nativePath = await live.transcript.locate(live.state.nativeId)
        // The interrupt's own `error_during_execution` result may have settled
        // the turn as failed first; Stop ends it interrupted.
        engine.patch(live, {
          nativePath,
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
