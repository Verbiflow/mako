import type { CodexAgentRun } from "./codex/agent-status.js"
import type { CodexIdentityResponse, CodexInitialize } from "./codex/native-context.js"
import type { CodexAgentItem } from "./codex/agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { AttachmentContent, LineAssembler } from "@mako/sessions"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { JsonRpcId } from "../base/json-values.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import type { LiveSessionState } from "../contracts/providers-acp.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { TurnStartParams } from "./codex/generated/v2/TurnStartParams.js"
import type { ReviewStartParams } from "./codex/generated/v2/ReviewStartParams.js"
import type { AskForApproval } from "./codex/generated/v2/AskForApproval.js"
import type { ApprovalsReviewer } from "./codex/generated/v2/ApprovalsReviewer.js"
import type { SandboxPolicy } from "./codex/generated/v2/SandboxPolicy.js"
import type { TurnSteerParams } from "./codex/generated/v2/TurnSteerParams.js"
import type { ThreadCompactStartParams } from "./codex/generated/v2/ThreadCompactStartParams.js"
import type { TurnInterruptParams } from "./codex/generated/v2/TurnInterruptParams.js"
import type { ThreadGoalSetParams } from "./codex/generated/v2/ThreadGoalSetParams.js"
import type { ThreadGoalClearParams } from "./codex/generated/v2/ThreadGoalClearParams.js"
import type { ThreadForkParams } from "./codex/generated/v2/ThreadForkParams.js"
import type { ThreadInjectItemsParams } from "./codex/generated/v2/ThreadInjectItemsParams.js"
import type { ThreadUnsubscribeParams } from "./codex/generated/v2/ThreadUnsubscribeParams.js"
import type { ThreadUnsubscribeResponse } from "./codex/generated/v2/ThreadUnsubscribeResponse.js"
import type { ConfigReadParams } from "./codex/generated/v2/ConfigReadParams.js"
import type { CodexThreadGoal } from "./codex/goals.js"
import type { GoalObservation } from "../contracts/live-goals.js"
import type { NativeCapture } from "./native-capture.js"
import type { CodexDecoder } from "./codex/decoder.js"
import type { CodexRolloutTail } from "./codex/rollout-tail.js"

export type Tuning = SessionSettings

type UserMessageContent = {
  type?: string
  text?: string
  attachment?: AttachmentContent
}
type FileChange = { path?: string; diff?: string; kind?: JsonValue }
type McpToolError = { message?: string }

export type ThreadItem =
  | CodexAgentItem
  | {
      type: "userMessage"
      id: string
      content: UserMessageContent[]
    }
  | { type: "agentMessage"; id: string; text: string; questions?: import("./codex/questions.js").CodexAsyncQuestion[] }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution"
      processId?: string
      id: string
      command: string
      cwd: string
      status: string
      aggregatedOutput: string | null
      exitCode: number | null
    }
  | {
      type: "fileChange"
      id: string
      changes: FileChange[]
      status: string
    }
  | {
      type: "mcpToolCall"
      id: string
      server: string
      tool: string
      status: string
      arguments?: JsonValue
      result: JsonValue
      error: McpToolError | null
    }
  | {
      type: "dynamicToolCall"
      id: string
      namespace: string | null
      tool: string
      status: string
      arguments?: JsonValue
      contentItems: JsonValue[] | null
      success: boolean | null
    }
  | { type: "webSearch"; id: string; query: string; action: JsonObject | null; results: JsonValue[] | null }
  | { type: "sleep"; id: string; durationMs: number }
  /** A tool's result that a client handed Codex to start a turn; Mako never starts one this way. */
  | { type: "functionCallOutput"; id: string; tool: string; output: string }
  | { type: "enteredReviewMode" | "exitedReviewMode"; id: string; review: string }
  /** Text a hook added to the conversation; Codex itself does not show it. */
  | { type: "hookPrompt"; id: string }
  | { type: "attachment"; id: string; attachment: AttachmentContent }
  /** The model's `view_image` call, which Codex shows as the image it viewed. */
  | { type: "imageView"; id: string; path: string; attachment: AttachmentContent }
  | { type: "plan"; id: string; text: string }
  | { type: "contextCompaction"; id: string }
  | { type: "unsupported"; id: string; sourceType: string }

export type Turn = {
  id: string
  items: ThreadItem[]
  status: string
  error: {
    message?: string
    additionalDetails?: string | null
    /** The `CodexErrorInfo` variant, when Codex classified the error. */
    variant?: string
  } | null
}

export type ThreadResponse = {
  thread: { id: string; cwd?: string; path?: string | null; turns?: Turn[] }
  model?: string
  serviceTier?: string | null
  reasoningEffort?: string | null
  /** The thread's effective policy — absent on app-servers that predate the field. */
  approvalPolicy?: AskForApproval
  approvalsReviewer?: ApprovalsReviewer
  sandbox?: SandboxPolicy
}

export type RpcParams = {
  "account/read": { refreshToken: false }
  initialize: {
    clientInfo: { name: string; title: string; version: string }
    capabilities: { experimentalApi: true; requestAttestation: false }
  }
  "thread/start": {
    cwd: string
    model?: string
    serviceTier?: string
    config?: JsonObject
  }
  "thread/fork": ThreadForkParams
  "thread/resume": {
    excludeTurns?: boolean
    threadId: string
    cwd: string
    model?: string
    serviceTier?: string
    config?: JsonObject
  }
  "thread/turns/list": { threadId: string; limit: 1; sortDirection: "desc"; itemsView: "notLoaded" }
  "turn/start": TurnStartParams
  "review/start": ReviewStartParams
  "turn/steer": TurnSteerParams
  "thread/compact/start": ThreadCompactStartParams
  "turn/interrupt": TurnInterruptParams
  "thread/backgroundTerminals/list": { threadId: string; cursor?: string }
  "thread/backgroundTerminals/clean": { threadId: string }
  "thread/backgroundTerminals/terminate": { threadId: string; processId: string }
  "thread/loaded/list": { cursor?: string }
  "thread/goal/set": ThreadGoalSetParams
  "thread/goal/clear": ThreadGoalClearParams
  "config/read": ConfigReadParams
  "thread/inject_items": ThreadInjectItemsParams
  "thread/unsubscribe": ThreadUnsubscribeParams
}

export type RpcResults = {
  "account/read": CodexIdentityResponse
  initialize: CodexInitialize
  "thread/start": ThreadResponse
  "thread/fork": ThreadResponse
  "thread/resume": ThreadResponse
  "thread/turns/list": { data: CodexAgentRun[] }
  "turn/start": { turn: Turn }
  "review/start": { turn: Turn }
  "turn/steer": { turnId: string }
  "thread/compact/start": JsonObject
  "turn/interrupt": JsonObject
  "thread/backgroundTerminals/list": { data: { itemId: string; processId: string; command?: string | null }[]; nextCursor?: string | null }
  "thread/backgroundTerminals/clean": JsonObject
  "thread/backgroundTerminals/terminate": { terminated: boolean }
  "thread/loaded/list": { data: string[]; nextCursor?: string | null }
  "thread/goal/set": { goal: CodexThreadGoal }
  "thread/goal/clear": { cleared: boolean }
  "config/read": JsonObject
  "thread/inject_items": JsonObject
  "thread/unsubscribe": ThreadUnsubscribeResponse
}

export type RpcMethod = keyof RpcParams

export type ParseResult<T> =
  { valid: true; value: T } | { valid: false; message: string }

export type RpcResultParser<M extends RpcMethod> = (
  value: JsonValue | undefined
) => ParseResult<RpcResults[M]>

export type PendingRpc<M extends RpcMethod = RpcMethod> = {
  method: M
  resolve(value: RpcResults[M]): void
  reject(error: Error): void
  parseResult: RpcResultParser<M>
  settleResult(value: JsonValue | undefined): void
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface ProtocolCallbacks {
  observeQuestionAnswer?(answer: import("../contracts/live-questions.js").NativeQuestionAnswer): void
  observeQuestion?(question: import("../contracts/live-questions.js").NativeQuestion): void
  actionResult?(actionId: string, result: import("../contracts/live-actions.js").LiveActionResult): void
  handleFatal(message: string): void
  updateState(patch: Partial<LiveSessionState>): void
  emitUpdate(update: LiveUpdate): void
  activity?(activity: import("../contracts/native-activity.js").NativeActivityObservation | null): void
  /** `id` is the native item or turn the marker stands for. */
  compacted?(compaction?: import("@mako/sessions/events").Compaction, id?: string): void
  /** A transcript marker: a warning, a failed turn, a review boundary. */
  event?(marker: import("@mako/sessions/events").TranscriptEvent, id?: string): void
  /** A notification or item the decoder has no meaning for, with its raw record. */
  unhandled?(kind: string, reason?: "unknown" | "unreadable", raw?: JsonValue): void
  /** `account/rateLimits/updated`: the windows the session's account just reported. */
  usage?(windows: import("../contracts/accounts.js").UsageWindow[]): void
  /** Codex dropped its history from the turn `run` on. */
  rewound?(run: string): void
  goal?(goal: GoalObservation | null): void
  observeAgents(item: CodexAgentItem, replay: boolean, toolId: string): void
  observeAgentTurn?(nativeId: string): void
  /** Background terminals as roster entries, when the list names them or one ends. */
  observeBackground?(items: readonly import("../contracts/native-agents.js").NativeAgentObservation[]): void
  handleServerRequest(id: JsonRpcId, method: string, params: JsonObject): void
  resolveServerRequest(id: JsonRpcId): void
  clearTurnServerRequests(turnId: string): void
}

export interface ProtocolContext {
  /** Side conversations' threads, whose messages never reach the decoder. */
  sides?: import("./codex/side-questions.js").CodexSideQuestions
  /** Stopped native turns retained until transport disposal: late commands still belong to Stop. */
  stoppedTurns?: Set<string>
  stoppedCommands?: Set<string>
  /** Native termination replies in flight; Close must drain them before retiring the decoder. */
  stoppingCommands?: Set<Promise<void>>
  compaction?: { actionId: string; turnId?: string; confirmed: boolean }
  child: ChildProcessWithoutNullStreams
  threadId: string | null
  currentTurnId: string | null
  state: LiveSessionState
  nextRequestId: number
  pending: Map<string, PendingRpc>
  /** What Codex's rollout records and notifications mean, for this session. */
  decoder: CodexDecoder
  /** The thread's rollout, read as Codex appends to it (`drawRollout`). */
  rollout?: CodexRolloutTail
  /** Records each notification as it arrived when `MAKO_NATIVE_CAPTURE` asks. */
  capture?: NativeCapture | null
  /**
   * Command items whose terminal outlived their turn. `raced` collects
   * completions that arrive while a terminal list is in flight.
   */
  background: { running: Set<string>; raced?: Set<string>; named?: Map<string, { processId: string; command?: string }> }
  /** Waiters for a subagent's turn to settle, by the subagent's thread. */
  subagentTurns?: Map<string, Array<() => void>>
  stdoutLines: LineAssembler
  exited: boolean
  protocol: ProtocolCallbacks
}
