import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
import { preparePrompt, preparePromptAsync, TurnInProgressError, type PromptDispatch } from "../prompt-dispatch.js"
import { ClaudeAgents } from "./sdk-agents.js"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { launchContext, reportedIdentity, reportedRuntime } from "../../base/execution-context.js"
import { NO_NATIVE_EXCLUSION } from "../../contracts/execution-context.js"
import { join } from "node:path"
import type {
  Options,
  Query,
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { SessionSettings } from "@mako/sessions/settings"
import { causeBody, claudeTaskOutput, outputBody, UNNAMED_TURN, type KeptOutputs, type ProviderTurnCause } from "@mako/sessions"
import { claudeTaskCause, claudeTaskMarker, parseClaudeTaskNotification } from "@mako/sessions/harnesses"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"
import type { LiveSessionMode, LiveSessionState } from "../../contracts/providers-acp.js"
import { createLiveEngine, type LiveEngineApi } from "../live-engine.js"
import type {
  ProviderLiveDriver,
  AdmittedStartOptions,
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
import type { SelectedAccount } from "../../contracts/accounts.js"
import { nativeStream, streamRuntime, withFrame, type NativeStream } from "../native-stream.js"
import { spawnClaudeProcess } from "./sdk-process.js"
import { ClaudePermissions } from "./sdk-permissions.js"
import { ClaudeApprovalObserver, claudeApprovalAnswerDigest, readClaudeApprovalDecisions } from "./approval-observer.js"
import type { ClaudePermissionObserver, prepareClaudePermissionObserver } from "./permission-observer.js"
import { ClaudeTranscript } from "./sdk-transcript.js"
import { ClaudeRequests, ClaudeTranscriptTail, takenIn, transcriptNotification, type TranscriptNotification, type TranscriptTailStats } from "./transcript-tail.js"
import { claudeGoalFeedback, claudeGoalLine, readClaudeGoal } from "./goals.js"
import { claudeReviewCommand } from "./review.js"
import { askClaudeSideQuestion } from "./side-questions.js"
import { ProviderStartupWatch, STARTUP_TOTAL_MS, stderrDetail } from "../provider-startup.js"
import type { ProviderLaunchTrace } from "../provider-launch.js"
import { hostLog, hostWarn } from "../../base/host-log.js"
import { CLAUDE_AUTH_LOG, claudeAuthDiagnostics } from "./auth-diagnostics.js"
import { claudeConfigDir, type ClaudeCredentialState } from "./accounts.js"
import { claudeStopReason } from "./sdk-notices.js"
import { claudeAcknowledged } from "./sdk-message-kinds.js"
import { fileResumeEvidence } from "../native-continuation.js"
import { claudeSessionCheckpoint } from "./session-checkpoint.js"
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
> & Partial<Pick<Query, "getContextUsage" | "stopTask">>

const CLAUDE_NATIVE_IDENTITY = { kind: "reported", via: "SDK initialization.account" } as const
/** Past Mako's own pipe release, so the SDK's stream can still report the exit first. */
const PROCESS_EXIT_GRACE_MS = 1_500
const GOAL_COMMAND = /^\/goal(\s|$)/
interface Receipt {
  /** The steered message, recorded when Claude echoes it, and what Mako showed for it where that differs. */
  text: string
  shown?: string
  resolve(result: ProviderSteerResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
interface Live {
  /** Amends the launch account's usage: a turn reporting its limits moves the meter without a request. */
  observeUsage: AdmittedStartOptions["observeUsage"]
  compaction?: { actionId: string; runId: string; confirmed: boolean }
  decoder: ClaudeDecoder
  sink?: DecodedSink<never>
  stream: NativeStream<SDKMessage | { transcript: readonly TranscriptNotification[] }> | null
  state: LiveSessionState
  query: ClaudeQuery
  input: ClaudeInput
  agents: ClaudeAgents
  permissions: ClaudePermissions
  approvals: ClaudeApprovalObserver
  disposeApprovals(): Promise<void>
  authDiagnostics: ReturnType<typeof claudeAuthDiagnostics>
  transcript: ClaudeTranscript
  emit: ProviderStartOptions["emit"]
  promptReceipt?: { id: string; dispatch: PromptDispatch }
  receipts: Map<string, Receipt>
  closed: boolean
  steered: boolean
  finishing: boolean
  /**
   * What the SDK said of each background task that settled, by task id,
   * until the transcript shows Claude took it in: the marker when no
   * transcript can be read, else the cause of the turn Claude runs on it
   * when its line can't be read.
   */
  told: Map<string, ProviderTurnCause>
  /** Tasks started in the foreground: their tool's result reports them, and their notification is not an event. */
  foreground: Set<string>
  /** The session's transcript, read forward for the notifications the SDK leaves out; made once its path is known. */
  tail?: ClaudeTranscriptTail
  /** Where kept copies of command output are (`KeptOutputs`). */
  outputs?: KeptOutputs
  /** Where each model request starts, so each reads the transcript once. */
  requests: ClaudeRequests
  /** How many notifications the transcript had queued when a request last waited for them to be taken in. */
  waited: { queued: number }
  /** Prompt lines read when a turn ended, before Claude opened the turn it runs on them. */
  prompts: TranscriptNotification[]
  /** The reader's counts at its last report in the host log. */
  reported?: TranscriptTailStats
  /** The prompt line of the last turn Claude started itself, so the next one never reads it again. */
  providerTurnPrompt?: string
  /** The session has had a goal, so each turn's end reads where it stands. */
  goals: boolean
  /** The running goal's condition, as Mako set it or last read it; its Stop hook's feedback names it. */
  goalCondition?: string
  exited(): Promise<void>
}
export interface ClaudeSdkConfiguration {
  options: Options
  account: SelectedAccount
}

export interface ClaudeSdkDependencies {
  available(): boolean
  configure(cwd: string, options: AdmittedStartOptions, trace: ProviderLaunchTrace): Promise<ClaudeSdkConfiguration>
  /** Claude's SDK is loaded by the first query, so asking for one is async. */
  query(input: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }): Promise<ClaudeQuery>
  interruptTimeoutMs?: number
  receiptTimeoutMs?: number
  prepareApprovals?: (input: Omit<Parameters<typeof prepareClaudePermissionObserver>[0], "root" | "settings">) => Promise<ClaudePermissionObserver | undefined>
  inspectCredentials?: (env: NodeJS.ProcessEnv) => Promise<ClaudeCredentialState>
  /** The config folder an account's sessions are kept under. */
  configDir?: (account: string) => string
  /** Where streams go (`HarnessContext.streams`); without it none are written. */
  streams?: string
  /** Kept copies of what background commands printed, for when Claude Code's output files are gone. */
  outputs?: KeptOutputs
}

type Engine = LiveEngineApi<Live>

function stop(live: Live): void {
  live.stream?.closed()
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
  const ids = claudeAcknowledged(message)
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
    live.stream?.steered(receipt.text, receipt.shown)
    receipt.resolve({ kind: "accepted" })
  }
}

/** What the decoder makes of a message reaches the session; plan-limit windows move the account's meter. */
function decode(engine: Engine, live: Live, message: SDKMessage): void {
  const frame = live.stream?.record(message)
  live.sink ??= engine.sink(live, { effect: () => undefined, usage: (windows) => live.observeUsage((previous) => mergeWindows(previous, windows, Date.now())) })
  const sink = live.sink
  withFrame(frame, () => deliverDecoded(live.decoder.decode(message), sink))
}

/**
 * What the SDK's task notification says of a task, when the transcript's
 * line for it can't be read. For an agent its `summary` is the agent's
 * report, not Claude's sentence, so the agent's name comes from its
 * `task_started` and the report becomes what opens; a command's output is
 * read from its output file.
 */
function sdkTaskTurn(message: SDKTaskNotificationMessage, agent: NativeAgentObservation | undefined, outputs: KeptOutputs | undefined): ProviderTurnCause {
  const outcome = message.status === "failed" ? "failed" : message.status === "stopped" ? "stopped" : "finished"
  if (agent?.title) {
    const turn: ProviderTurnCause = {
      reason: `Agent "${agent.title}" ${outcome === "stopped" ? "was stopped" : outcome}`,
      cause: { kind: "agent", name: agent.title.slice(0, 200), agentId: message.task_id, outcome, ...message.usage && { durationMs: message.usage.duration_ms } },
    }
    const report = causeBody(message.summary)
    if (report) turn.body = report
    return turn
  }
  const reason = message.summary.replace(/\s+/g, " ").trim().slice(0, 500)
  if (!reason) return UNNAMED_TURN
  const cause = claudeTaskCause(reason, message.status)
  const body = cause?.kind === "command" ? outputBody(claudeTaskOutput(message.output_file, message.task_id, outputs)?.output) : undefined
  return { reason, ...cause && { cause }, ...body && { body } }
}

/** How long a turn Claude started waits for its prompt to reach the transcript: Claude Code writes it within a tenth of a second. */
const TASK_PROMPT_WAIT_MS = 1_500
/** Settled tasks remembered for their notification; a turn sees a few. */
const MAX_TOLD = 64

/** The reader of the session's current transcript, made the first time its path is known. */
function transcriptTail(live: Live): ClaudeTranscriptTail | undefined {
  const path = live.transcript.path
  if (!path) return undefined
  if (live.tail?.path !== path) {
    logTranscriptReads(live)
    live.tail = new ClaudeTranscriptTail(path, live.state.nativeId, live.outputs)
    live.reported = undefined
  }
  return live.tail
}

/** Whether the transcript may hold a notification the SDK left out: background work runs, settled, or is queued. */
function armed(live: Live): boolean {
  return (live.state.backgroundTasks ?? 0) > 0 || live.told.size > 0 || (live.tail?.waiting() ?? 0) > 0
}

/**
 * Draws what the transcript gained: a notification taken in mid-turn as
 * the marker saved history draws for it, and a turn Claude ran on one,
 * each citing its line. Recorded in the stream, so a replay draws the
 * same. `openedAt` stamps a turn the driver opens, as the moment `init`
 * arrived.
 */
function drawTranscript(engine: Engine, live: Live, found: readonly TranscriptNotification[], openedAt?: number): void {
  if (!found.length) return
  const frame = live.stream?.record({ transcript: found })
  for (const item of found) {
    const task = parseClaudeTaskNotification(item.text)?.taskId
    if (task) live.told.delete(task)
    if (item.kind === "prompt") live.providerTurnPrompt = item.record
  }
  live.sink ??= engine.sink(live, { effect: () => undefined, usage: (windows) => live.observeUsage((previous) => mergeWindows(previous, windows, Date.now())) })
  const sink = live.sink
  withFrame(frame, () => {
    const decoded = live.decoder.transcript(found)
    deliverDecoded(openedAt === undefined ? decoded : decoded.map((item) =>
      item.kind === "update" && item.update.kind === "provider-turn" ? { ...item, update: { ...item.update, at: openedAt } } : item), sink)
  })
}

/**
 * The lines up to and including the prompt of the turn Claude just
 * opened on a notification: read when the last turn ended, or read now,
 * waiting for Claude Code to flush it. Without a transcript reader, the
 * newest prompt in the transcript's end.
 */
async function providerTurnLines(live: Live, openedAt: number): Promise<TranscriptNotification[]> {
  const fresh = (item: TranscriptNotification) => item.kind === "prompt" && item.record !== live.providerTurnPrompt
  const found: TranscriptNotification[] = []
  const take = () => {
    const index = live.prompts.findIndex(fresh)
    if (index < 0) return false
    found.push(...live.prompts.splice(0, index + 1))
    return true
  }
  if (take()) return found
  // Without a fresh prompt among them, only what was taken in mid-turn is still to draw.
  const leftover = () => found.push(...live.prompts.splice(0).filter((item) => item.kind === "queued"))
  if (!(await live.transcript.locate(live.state.nativeId).catch(() => undefined))) {
    leftover()
    return found
  }
  const tail = live.tail?.path === live.transcript.path ? live.tail : undefined
  for (const deadline = openedAt + TASK_PROMPT_WAIT_MS; ;) {
    if (tail) {
      live.prompts.push(...tail.read())
      if (take()) return found
    } else {
      const prompt = await live.transcript.taskNotification(live.state.nativeId, openedAt - 10_000).catch(() => undefined)
      if (prompt && prompt.id !== live.providerTurnPrompt) return [...found, transcriptNotification("prompt", prompt.id, new Date(prompt.at).toISOString(), prompt.text, live.outputs)]
    }
    if (live.closed || Date.now() >= deadline) {
      leftover()
      return found
    }
    await delay(50)
  }
}

async function openProviderTurn(engine: Engine, live: Live): Promise<void> {
  const at = Date.now()
  live.decoder.startTurn()
  live.transcript.reset()
  engine.patch(live, {
    status: "running",
    nativeForkId: undefined,
    nativeRunId: undefined,
    lastStop: undefined,
    error: undefined,
  })
  const found = await providerTurnLines(live, at)
  if (live.closed) return
  drawTranscript(engine, live, found, at)
  if (found.some((item) => item.kind === "prompt")) return
  // The line was never read: the SDK's word on the oldest task still told, else that something finished.
  const [told] = live.told
  if (told) live.told.delete(told[0])
  const turn = told?.[1] ?? UNNAMED_TURN
  const frame = live.stream?.prompted({ turn: JSON.parse(JSON.stringify(turn)) })
  withFrame(frame, () => engine.emitUpdate(live, { kind: "provider-turn", ...turn, at }))
}

/** What reading the transcript cost since the last report, in the host log: a turn with background work reports once. */
function logTranscriptReads(live: Live): void {
  const stats = live.tail?.stats
  if (!stats || stats.reads === live.reported?.reads) return
  const before = live.reported ?? { reads: 0, bytes: 0, parsed: 0, notifications: 0, jumps: 0, ms: 0, maxMs: 0 }
  hostLog("claude-sdk", "transcript reads", {
    conversation: live.state.id, reads: stats.reads - before.reads, bytes: stats.bytes - before.bytes,
    parsed: stats.parsed - before.parsed, notifications: stats.notifications - before.notifications,
    jumps: stats.jumps - before.jumps, ms: Math.round((stats.ms - before.ms) * 10) / 10, maxMs: Math.round(stats.maxMs * 10) / 10,
  })
  live.reported = { ...stats }
}

/**
 * The roster entry a notification settled: a command's or monitor's output
 * joins it, and only an agent or workflow names the turn it wakes.
 */
function notifiedAgent(engine: Engine, live: Live, message: SDKTaskNotificationMessage): NativeAgentObservation | undefined {
  const entry = live.agents.get(message.task_id)
  if (entry?.work === "command" || entry?.work === "monitor") {
    const output = claudeTaskOutput(message.output_file, message.task_id, live.outputs)?.output
    const read = output ? live.agents.withOutput(message.task_id, output) : undefined
    if (read) engine.emitAgent(live, read)
  }
  return entry?.work === "agent" || entry?.work === "workflow" ? entry : undefined
}

/** A task the SDK says settled: nothing for one run in the foreground, else remembered until the transcript shows it taken in. */
function settled(engine: Engine, live: Live, message: SDKTaskNotificationMessage, agent: NativeAgentObservation | undefined): void {
  if (live.foreground.delete(message.task_id)) return
  const told = sdkTaskTurn(message, agent, live.outputs)
  // Without a transcript, what the SDK said is all there is: the marker saved history draws for the queued notification.
  if (live.state.status === "running" && !transcriptTail(live)) {
    engine.event(live, { ...claudeTaskMarker(told), source: { harness: "claude", record: message.uuid, via: "wire" } }, message.uuid)
    return
  }
  live.told.delete(message.task_id)
  live.told.set(message.task_id, told)
  if (live.told.size > MAX_TOLD) live.told.delete(live.told.keys().next().value!)
}

async function pump(engine: Engine, live: Live): Promise<void> {
  try {
    for await (const message of live.query) {
      if (live.closed) return
      if (message.type === "system" && message.subtype === "init" && live.state.executionContext) {
        const runtime = reportedRuntime(message.claude_code_version, "system/init.claude_code_version")
        streamRuntime(live.stream, runtime)
        engine.patch(live, { executionContext: { ...live.state.executionContext, runtime } })
      }
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
      for (const observed of live.agents.project(message)) engine.emitAgent(live, observed)
      const agent = message.type === "system" && message.subtype === "task_notification" ? notifiedAgent(engine, live, message) : undefined
      if (message.type === "system" && message.subtype === "task_started" && message.is_backgrounded === false) live.foreground.add(message.task_id)
      if (message.type === "system" && message.subtype === "task_updated" && message.patch.is_backgrounded) live.foreground.delete(message.task_id)
      if (message.type === "system" && message.subtype === "task_notification" && !message.ambient) settled(engine, live, message, agent)
      // `init` opens every turn and never arrives between turns (SDK 0.3.283).
      // Mako marks its own turns running before sending, so an `init` while
      // settled is a turn Claude started itself, after a task notification.
      if (message.type === "system" && message.subtype === "init" &&
        (live.state.status === "ready" || live.state.status === "failed"))
        await openProviderTurn(engine, live)
      // A model request starts: what Claude took in for it is drawn before its reply.
      if (live.requests.starts(message)) {
        const tail = live.state.status === "running" && armed(live) ? transcriptTail(live) : undefined
        if (tail) {
          const found = await takenIn(tail, live.waited, () => live.closed)
          if (live.closed) return
          drawTranscript(engine, live, found)
        }
      }
      decode(engine, live, message)
      const unmet = live.goalCondition === undefined ? undefined : claudeGoalFeedback(message, live.goalCondition)
      if (unmet) live.emit({ type: "live-goal", id: live.state.id, goal: unmet })
      if (message.type === "conversation_reset") {
        live.transcript.follow(message.new_conversation_id)
        engine.patch(live, { nativePath: live.transcript.path, nativeForkId: undefined })
      }
      if (message.type !== "result" || live.state.status !== "running") continue
      if (live.compaction && message.user_message_uuid &&
        message.user_message_uuid !== live.compaction.runId &&
        !message.user_message_uuids?.includes(live.compaction.runId)) continue
      // A steer aborts the step it lands in, a reply streaming or a command
      // running, and Claude opens a query for it after this result (Claude
      // Code 2.1.278 and 2.1.293, `steered-shell` pairs).
      if (live.steered && (message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools"))
        continue
      if ((message.queued_turn_count ?? 0) > 0) continue
      live.steered = false
      live.finishing = true
      live.permissions.close()
      const nativeForkId = message.is_error
        ? undefined
        : await live.transcript.forkPoint(live.state.nativeId)
      if (live.goals) await reportGoal(live)
      if (live.closed) return
      // What the transcript gained by the turn's end: a notification taken in
      // after the last request, and the prompt of a turn Claude is about to
      // run on one, which waits for that turn's `init`.
      if (armed(live)) {
        const found = live.tail?.read() ?? []
        drawTranscript(engine, live, found.filter((item) => item.kind === "queued"))
        live.prompts.push(...found.filter((item) => item.kind === "prompt"))
      }
      logTranscriptReads(live)
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
  } finally {
    // The SDK's stream ended with its process, whether Mako closed it or it exited: the launch's stream is finished.
    live.stream?.ended()
  }
}

/** Where Claude's goal stands at a turn's end, from its newest `goal_status` record, which Claude has written by its result. */
async function reportGoal(live: Live): Promise<void> {
  const path = await live.transcript.locate(live.state.nativeId)
  const goal = path === undefined ? undefined : await readClaudeGoal(path)
  if (goal === undefined || live.closed) return
  if (goal) live.goals = true
  live.goalCondition = goal?.status === "active" ? goal.objective : undefined
  live.emit({ type: "live-goal", id: live.state.id, goal })
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
    launchEnvironment: { kind: "prepared", via: "SDK configuration consumes AdmittedStartOptions.accountLaunch." },
    nativeIdentity: CLAUDE_NATIVE_IDENTITY,
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["structured-question", ...(dependencies.prepareApprovals ? ["tool-permission" as const] : [])], coverage: "Parent AskUserQuestion results in the saved branch; parent tool decisions from the bundled runtime's local native event exporter, retained before delivery. Existing telemetry configuration, custom runtimes, child tools and MCP elicitation retain submission evidence unless a matching observer is available. Missing native events never confirm an answer." },
    planning: { via: "mode", mode: "plan", proposal: "ExitPlanMode's `plan` input, built by answering its permission request",
      feedback: { kind: "in-refusal", via: "the deny message of ExitPlanMode's permission answer, which Claude reads as the tool's result" } },
    approvalAnswerDigest: claudeApprovalAnswerDigest,
    resume: {
      kind: "native",
      via: "The Agent SDK's `resume` option with the session ID, after the session file is checked.",
      wake: "The next message starts a new `claude` process that resumes the session from its file.",
      ...fileResumeEvidence(claudeProcessProbe, claudeSessionCheckpoint),
      async locate(binding) {
        const account = binding.executionContext?.account
        const name = account?.kind === "configured" ? account.name : "default"
        return new ClaudeTranscript((dependencies.configDir ?? claudeConfigDir)(name)).locate(binding.nativeId)
      },
      elsewhere: {
        via: "The same `resume` from the new folder: Claude finds the session by ID and keeps writing its file under the folder it started in.",
        verified: "scripts/test-claude-resume-elsewhere-live.mjs against Claude Code 2.1.290 with a stand-in model.",
      },
    },
    fork: { kind: "native", point: "checkpoint", via: "The Agent SDK's `forkSession` at a checkpoint (`resumeSessionAt`)." },
    questions: { kind: "request", via: "AskUserQuestion reaches Mako as a tool approval carrying its questions; the answers return as the tool's input." },
    nativeAgents: { kind: "observed", via: "Agent and Workflow tool calls and their sidechain messages." },
    modeSwitching: { kind: "native", via: "Claude Code's permission modes, set on the running query with `setPermissionMode`." },
    backgroundStop: { kind: "ends-on-stop", how: "Stop interrupts and closes the Claude process, with or without a running turn, which ends its background tasks; the next prompt resumes the session. One task stops alone through the SDK's `stopTask`, from its row in the Agents panel." },
    stopNativeAgent: async (id, nativeId) => {
      const { query } = requireLive(id)
      if (!query.stopTask) throw new Error("This Claude session cannot stop one task")
      await query.stopTask(nativeId)
    },
    turnRecovery: {
      kind: "continues",
      accepted: "The SDK's echo of the prompt's user message, as the turn starts.",
      exit: "The SDK stream's failure when the process dies settles the session failed and disconnected in one update, with the transcript found by session ID when no hook has reported it yet.",
      tests: ["scripts/test-claude-sdk.ts", "scripts/test-turn-recovery-live.mjs"],
    },
    goals: {
      kind: "native",
      via: "The `/goal` command as a message; Claude has no pause, so Mako pauses with `/goal clear` and resumes by setting the goal again. Its Stop hook's feedback reports each unmet verdict as the turn runs, and the transcript's newest `goal_status` record reports where it stands at the turn's end.",
      budget: "mako",
      send: (command) => ({ via: "message", texts: [command.kind === "set" || command.kind === "resume" ? `/goal ${command.objective}` : "/goal clear"] }),
    },
    sideQuestions: {
      kind: "native",
      via: "Its `/btw`, through the SDK's `side_question` control request, with the side conversation's earlier exchanges as its history.",
      ask: async (id, question) => askClaudeSideQuestion(requireLive(id).query, question),
      close: async () => {},
    },
    review: {
      kind: "native",
      via: "Its `/code-review` command as a message, the target as its argument. Launched with `CLAUDE_CODE_REPORT_FINDINGS`, it reviews inline and reports through `ReportFindings`.",
      start: { via: "message", text: claudeReviewCommand },
    },
    modes: CLAUDE_MODES,
    defaultMode: "default",
    available: () => dependencies.available(),
    start: async (cwd, options) => {
      const { trace } = options
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
      const publishDecision = (decision: import("../../contracts/approval-response.js").NativeApprovalDecision) => options.emit({ type: "live-approval-decision", id: options.conversationId, decision })
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
        if (live.closed) return
        // Read from here on: what the file holds already is the session's history.
        transcriptTail(live)
        if (live.state.nativePath !== path) engine.patch(live, { nativePath: path })
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
      try { query = await dependencies.query({
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
        observeUsage: options.observeUsage,
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
        stream: nativeStream("claude", options.conversationId, () => ({ settings: { model: options.tuning?.model ?? null } }), dependencies.streams, () => live.state.nativeId),
        agents: new ClaudeAgents(options.observedAgents),
        told: new Map(),
        foreground: new Set(),
        outputs: dependencies.outputs,
        waited: { queued: 0 },
        prompts: [],
        requests: new ClaudeRequests(),
        receipts: new Map(),
        closed: false,
        steered: false,
        finishing: false,
        goals: false,
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
        transcriptTail(live)
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
        if (options.resume) void reportGoal(live)
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
    },
    async prompt(id, text, attachments, settings, dispatch) {
      const { live, content } = await preparePromptAsync(dispatch, async () => {
        const live = requireLive(id)
        if (live.state.status === "running")
          throw new TurnInProgressError("Claude")
        const content = await claudeInputContent(text, attachments)
        await tune(live, settings)
        return { live, content }
      })
      preparePrompt(dispatch, () => {
        const current = requireLive(id)
        if (current !== live) throw new Error("Claude changed while preparing the prompt")
        // A turn Claude started itself while the message was prepared (a notice of background work it found ended).
        if (current.state.status === "running") throw new TurnInProgressError("Claude")
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
      live.stream?.prompted({ text, shown: dispatch.shown, shownAt: dispatch.shownAt, attachments })
      if (GOAL_COMMAND.test(text)) {
        live.goals = true
        const condition = claudeGoalLine(text)
        if (condition !== undefined) live.goalCondition = condition ?? undefined
      }
      live.decoder.startTurn()
      live.transcript.reset()
      // With no background work, nothing this turn writes is read: the reader starts again where the turn does.
      if (!armed(live)) live.tail?.skip()
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
        live.receipts.set(uuid, { text: input.text, shown: input.shown, resolve, reject, timer })
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
