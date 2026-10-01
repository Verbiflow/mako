import type { CodexAgentRun } from "./providers/codex/agent-status.js"
import type { CodexAgentItem } from "./providers/codex/agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { AttachmentContent, LineAssembler } from "@mako/sessions"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { JsonObject, JsonRpcId, JsonValue } from "./codex-app-json.js"
import type { LiveSessionState, LiveUpdate } from "./shared.js"
import type { TurnStartParams } from "./providers/codex/generated/v2/TurnStartParams.js"
import type { AskForApproval } from "./providers/codex/generated/v2/AskForApproval.js"
import type { ApprovalsReviewer } from "./providers/codex/generated/v2/ApprovalsReviewer.js"
import type { SandboxPolicy } from "./providers/codex/generated/v2/SandboxPolicy.js"
import type { TurnSteerParams } from "./providers/codex/generated/v2/TurnSteerParams.js"
import type { ThreadCompactStartParams } from "./providers/codex/generated/v2/ThreadCompactStartParams.js"
import type { TurnInterruptParams } from "./providers/codex/generated/v2/TurnInterruptParams.js"

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
  | { type: "agentMessage"; id: string; text: string; questions?: import("./providers/codex/questions.js").CodexAsyncQuestion[] }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution"
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
  | { type: "enteredReviewMode" | "exitedReviewMode"; id: string; review: string }
  /** Text a hook added to the conversation; Codex itself does not show it. */
  | { type: "hookPrompt"; id: string }
  | { type: "attachment"; id: string; attachment: AttachmentContent }
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
  "thread/fork": {
    excludeTurns?: boolean
    threadId: string
    lastTurnId: string
    cwd: string
    model?: string
    serviceTier?: string
    config?: JsonObject
  }
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
  "turn/steer": TurnSteerParams
  "thread/compact/start": ThreadCompactStartParams
  "turn/interrupt": TurnInterruptParams
  "thread/backgroundTerminals/list": { threadId: string; cursor?: string }
  "thread/backgroundTerminals/clean": { threadId: string }
  "thread/loaded/list": { cursor?: string }
}

export type RpcResults = {
  initialize: JsonObject
  "thread/start": ThreadResponse
  "thread/fork": ThreadResponse
  "thread/resume": ThreadResponse
  "thread/turns/list": { data: CodexAgentRun[] }
  "turn/start": { turn: Turn }
  "turn/steer": { turnId: string }
  "thread/compact/start": JsonObject
  "turn/interrupt": JsonObject
  "thread/backgroundTerminals/list": { data: { itemId: string }[]; nextCursor?: string | null }
  "thread/backgroundTerminals/clean": JsonObject
  "thread/loaded/list": { data: string[]; nextCursor?: string | null }
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

export type ItemTracker = {
  acpId: string
  started: boolean
  textDelta: boolean
  text: string | null
  thinkingDelta: boolean
  thinking: string | null
  output: string
}

export interface ProtocolCallbacks {
  observeQuestionAnswer?(answer: import("./contracts/live-questions.js").NativeQuestionAnswer): void
  observeQuestion?(question: import("./contracts/live-questions.js").NativeQuestion): void
  actionResult?(actionId: string, result: import("./contracts/live-actions.js").LiveActionResult): void
  handleFatal(message: string): void
  updateState(patch: Partial<LiveSessionState>): void
  emitUpdate(update: LiveUpdate): void
  activity?(activity: import("./contracts/native-activity.js").NativeActivityObservation | null): void
  /** `id` is the native item or turn the marker stands for. */
  compacted?(compaction?: import("@mako/sessions/events").Compaction, id?: string): void
  /** A transcript marker: a warning, a failed turn, a review boundary. */
  event?(marker: import("@mako/sessions/events").TranscriptEvent, id?: string): void
  /** A notification or item this protocol does not translate. */
  unhandled?(kind: string): void
  /** `account/rateLimits/updated`: where the session's account stands after spending. */
  rateLimits?(params: JsonObject): void
  observeAgents(item: CodexAgentItem, replay: boolean): void
  observeAgentTurn?(nativeId: string): void
  handleServerRequest(id: JsonRpcId, method: string, params: JsonObject): void
  resolveServerRequest(id: JsonRpcId): void
  clearTurnServerRequests(turnId: string): void
}

export interface ProtocolContext {
  compaction?: { actionId: string; turnId?: string; confirmed: boolean }
  child: ChildProcessWithoutNullStreams
  threadId: string | null
  currentTurnId: string | null
  state: LiveSessionState
  nextRequestId: number
  pending: Map<string, PendingRpc>
  items: Map<string, ItemTracker>
  /**
   * Command items whose terminal outlived their turn. `raced` collects
   * completions that arrive while a terminal list is in flight.
   */
  background: { running: Set<string>; raced?: Set<string> }
  /** Waiters for a subagent's turn to settle, by the subagent's thread. */
  subagentTurns?: Map<string, Array<() => void>>
  /** Context tokens when the running compaction started. */
  compactingFrom?: number
  /** The label of the waiting activity this protocol set and has yet to end. */
  waiting?: string
  /** Notices already shown this session; a repeat adds nothing. */
  notices?: Set<string>
  stdoutLines: LineAssembler
  exited: boolean
  protocol: ProtocolCallbacks
}
