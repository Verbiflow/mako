import { codexAsyncQuestion, codexAnsweredQuestions } from "./providers/codex/questions.js"
import { STARTUP_TOTAL_MS } from "./provider-startup.js"
import { CodexAgentRunsSchema } from "./providers/codex/agent-status.js"
import { z } from "zod"
import {
  codexErrorClass,
  codexFailureEvent,
  codexPresentation,
  codexPrompt,
  codexPromptImages,
  codexWarningEvent,
  firstLine,
} from "@mako/sessions/codex-presentation"
import { event, type TranscriptEvent } from "@mako/sessions/events"
import {
  boundedText,
  isNumber,
  stringValue,
  type JsonObject,
  type JsonRpcId,
  type JsonValue,
} from "./codex-app-json.js"
import {
  parseJsonRpcEnvelope,
  parseNotification,
  parseObjectResult,
  parseThreadResponse,
  parseTurnResponse,
  parseSteerResponse,
  type JsonRpcEnvelope,
  type PatchNotification,
  type ProtocolNotification,
  type StreamDeltaNotification,
  type ToolOutputNotification,
} from "./codex-app-parse.js"
import type { NativeActivityObservation } from "./contracts/native-activity.js"
import type {
  ItemTracker,
  PendingRpc,
  ProtocolContext,
  RpcMethod,
  RpcParams,
  RpcResultParser,
  RpcResults,
  ThreadItem,
  Turn,
} from "./codex-app-types.js"

export { boundedText } from "./codex-app-json.js"
export type {
  JsonObject,
  JsonRpcId,
  JsonScalar,
  JsonValue,
} from "./codex-app-json.js"
export type {
  ItemTracker,
  PendingRpc,
  ProtocolCallbacks,
  ProtocolContext,
  RpcMethod,
  RpcParams,
  RpcResults,
  ThreadItem,
  ThreadResponse,
  Tuning,
  Turn,
} from "./codex-app-types.js"

const RPC_TIMEOUT_MS = 30_000
export const MAX_STDOUT_BUFFER = 8 * 1024 * 1024
const MAX_TOOL_OUTPUT = 32 * 1024
const MAX_STREAM_COMPARE = 128 * 1024
const MAX_TRACKED_ITEMS = 2048
const MAX_REPLAY_ITEMS = 1000
const MAX_NOTICES = 256
const REVIEWING_APPROVAL = "Reviewing the approval"
const CHECKING_RESPONSE = "Checking the response"
const REFRESHING_SIGN_IN = "Refreshing sign-in"
/** Codex 0.159's `ModelRerouteReason`, in plain words. */
const REROUTE_REASONS = new Map([["highRiskCyberActivity", "cybersecurity safety check"]])
/** Codex 0.159's `McpServerStartupFailureReason`, in plain words. */
const MCP_FAILURES = new Map([["reauthenticationRequired", "sign-in required"]])
/**
 * Notifications that are bookkeeping for Codex's own clients: thread
 * lifecycle Mako drives itself, account and app state, realtime audio, raw
 * model frames, and duplicates of events handled elsewhere. Known here so the
 * unhandled log keeps to events Mako has yet to translate. Checked on 0.159.
 */
const IGNORED_NOTIFICATIONS = new Set([
  // Superseded by the contextCompaction item.
  "thread/compacted",
  "thread/started",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
  "thread/reverted",
  "thread/status/changed",
  "thread/closed",
  "thread/settings/updated",
  "thread/attachment/updated",
  "thread/queue/changed",
  "thread/project/updated",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/realtime/started",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/sdp",
  "thread/realtime/itemAdded",
  "thread/realtime/item/started",
  "thread/realtime/item/completed",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "project/changed",
  "skills/changed",
  "app/list/updated",
  "account/updated",
  "account/login/completed",
  "account/gatewayOAuth/changed",
  "account/rateLimits/updated",
  "remoteControl/status/changed",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "mcpServer/oauthLogin/completed",
  "mcpServer/event/stream/notification",
  "fs/changed",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "turn/moderationMetadata",
  // The fileChange items carry each edit; this is the turn's aggregate diff.
  "turn/diff/updated",
  "hook/started",
  "hook/completed",
  "model/verification",
  "item/commandExecution/terminalInteraction",
  "rawResponse/completed",
  "rawResponseItem/completed",
])
const PatchKindSchema = z.object({
  type: z.enum(["add", "delete", "update"]),
  move_path: z.string().nullish(),
})
const SearchActionSchema = z.object({
  query: z.string().nullish(),
  queries: z.array(z.string()).nullish(),
  url: z.string().nullish(),
})
const SearchResultSchema = z.object({ title: z.string().optional(), url: z.string().min(1) })
type FileChange = Extract<ThreadItem, { type: "fileChange" }>["changes"][number]
const BackgroundTerminalsSchema = z.object({
  data: z.array(z.object({ itemId: z.string() })),
  nextCursor: z.string().nullish(),
})
const LoadedThreadsSchema = z.object({
  data: z.array(z.string()),
  nextCursor: z.string().nullish(),
})

export function consumeStdout(context: ProtocolContext, chunk: Buffer): void {
  if (context.exited) return
  // Lines are assembled chunk by chunk without rescanning what has already
  // arrived: a multi-megabyte thread/resume reply or tool result arrives in
  // 64 KB pieces, and re-measuring the whole buffer for each one once held
  // the host's main thread for seconds while Codex streamed.
  const lines = context.stdoutLines.push(chunk)
  if (!lines) {
    context.protocol.handleFatal(
      "Codex app-server sent an oversized JSON-RPC message"
    )
    return
  }
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    if (line.trim()) processLine(context, line)
    if (context.exited) return
  }
}

function processLine(context: ProtocolContext, line: string): void {
  const message = parseJsonRpcEnvelope(line)
  if (message.kind === "invalid") {
    context.protocol.handleFatal("Codex app-server sent invalid JSON-RPC")
    return
  }
  if (message.kind === "ignored") return
  if (message.kind === "response") {
    settleRpc(context, message)
    return
  }
  if (message.kind === "request") {
    context.protocol.handleServerRequest(
      message.id,
      message.method,
      message.params
    )
    return
  }
  if (IGNORED_NOTIFICATIONS.has(message.method)) return
  const notification = parseNotification(message.method, message.params)
  if (notification) handleNotification(context, notification)
  else context.protocol.unhandled?.(message.method)
}

function settleRpc(
  context: ProtocolContext,
  message: Extract<JsonRpcEnvelope, { kind: "response" }>
): void {
  const key = rpcKey(message.id)
  const pending = context.pending.get(key)
  if (!pending) return
  context.pending.delete(key)
  clearTimeout(pending.timer)
  if (message.error) {
    pending.reject(
      new Error(
        stringValue(message.error.message) ?? "Codex JSON-RPC request failed"
      )
    )
    return
  }
  pending.settleResult(message.result)
}

function handleNotification(
  context: ProtocolContext,
  notification: ProtocolNotification
): void {
  if (notification.method === "invalid") {
    context.protocol.unhandled?.(notification.kind)
    return
  }
  if (
    notification.threadId &&
    context.threadId &&
    notification.threadId !== context.threadId
  ) {
    if (notification.method === "turn/started" || notification.method === "turn/completed")
      context.protocol.observeAgentTurn?.(notification.threadId)
    if (notification.method === "turn/completed")
      for (const settle of context.subagentTurns?.get(notification.threadId) ?? []) settle()
    return
  }
  switch (notification.method) {
    case "turn/started":
      if (context.compaction && !context.compaction.turnId)
        context.compaction.turnId = notification.turnId
      context.currentTurnId = notification.turnId
      context.waiting = undefined
      context.protocol.updateState({
        status: "running",
        nativeRunId: notification.turnId,
        error: undefined,
      })
      return
    case "turn/completed":
      completeTurn(context, notification.turn)
      return
    case "item/started":
      handleItem(context, notification.turnId, notification.item, false)
      return
    case "item/completed":
      if (context.compaction?.turnId === notification.turnId && notification.item.type === "contextCompaction")
        context.compaction.confirmed = true
      handleItem(context, notification.turnId, notification.item, true)
      return
    case "item/agentMessage/delta":
      streamDelta(context, notification, "text")
      return
    case "item/plan/delta": {
      const tracker = itemTracker(
        context,
        notification.turnId,
        notification.itemId
      )
      context.protocol.emitUpdate({
        kind: "proposed-plan",
        id: tracker.acpId,
        text: notification.delta,
        status: "drafting",
      })
      return
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      streamDelta(context, notification, "thinking")
      return
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/mcpToolCall/progress":
      streamToolOutput(context, notification)
      return
    case "item/fileChange/patchUpdated":
      updateToolOutput(context, notification, patchText(notification.changes))
      return
    case "turn/plan/updated":
      context.protocol.emitUpdate({
        kind: "plan",
        entries: notification.plan.map((step) => ({
          content: step.step,
          status: step.status === "inProgress" ? "in_progress" : step.status,
        })),
      })
      return
    case "error":
      if (notification.willRetry) {
        context.waiting = undefined
        context.protocol.activity?.(retrying(notification.message, notification.variant))
      } else context.protocol.updateState({ error: notification.message })
      return
    case "serverRequest/resolved":
      context.protocol.resolveServerRequest(notification.requestId)
      return
    case "thread/tokenUsage/updated": {
      const { used, size } = notification
      const current = context.state.usage
      if (size === undefined || (current?.used === used && current.size === size)) return
      context.protocol.updateState({ usage: { used, size } })
      return
    }
    case "warning":
    case "guardianWarning":
      // Codex's own UI leaves approvals out; denials and failures stay.
      if (notification.method === "guardianWarning" &&
        notification.message.startsWith("Automatic approval review approved ("))
        return
      notice(context, codexWarningEvent(notification.message))
      return
    case "configWarning":
    case "deprecationNotice":
      notice(context, codexWarningEvent(notification.summary, notification.details))
      return
    case "autoApprovalReview/strictReviewRequired":
      notice(context, codexWarningEvent("This request needs extra safety checks, so some tool calls may take longer."))
      return
    case "model/rerouted": {
      const reason = REROUTE_REASONS.get(notification.reason) ?? words(notification.reason)
      notice(context, event("Model changed", `${notification.fromModel} → ${notification.toModel} · ${reason}`))
      return
    }
    case "mcpServer/startupStatus/updated": {
      if (notification.status !== "failed") return
      const failure = notification.failureReason
      const reason = notification.error ??
        (failure ? MCP_FAILURES.get(failure) ?? words(failure) : undefined)
      const line = reason ? firstLine(reason) : undefined
      notice(context, {
        ...event("MCP server failed", line ? `${notification.name} · ${line}` : notification.name,
          reason === line ? undefined : reason),
        tone: "warning",
      })
      return
    }
    case "model/safetyBuffering/updated":
      if (notification.turnId !== context.currentTurnId) return
      if (notification.show) wait(context, CHECKING_RESPONSE)
      else endWait(context, CHECKING_RESPONSE)
      return
    case "item/autoApprovalReview/started":
      wait(context, REVIEWING_APPROVAL)
      return
    case "item/autoApprovalReview/completed":
      // A denial arrives as its own guardianWarning.
      endWait(context, REVIEWING_APPROVAL)
      return
    case "modelProvider/authRecoveryStarted":
      wait(context, REFRESHING_SIGN_IN)
      return
    case "modelProvider/authRecoveryCompleted":
      endWait(context, REFRESHING_SIGN_IN)
      return
    case "thread/name/updated":
      if (notification.name?.trim() && notification.name !== context.state.title)
        context.protocol.updateState({ title: notification.name })
      return
    case "item/reasoning/summaryPartAdded":
      // Codex joins summary parts with a blank line once the item completes.
      if (notification.summaryIndex > 0)
        streamDelta(context, { ...notification, method: "item/reasoning/summaryTextDelta", delta: "\n\n" }, "thinking")
      return
  }
}

/**
 * Codex numbers its own retries in the message ("Reconnecting... 2/5") and
 * classifies what failed; the counter becomes the attempt.
 */
function retrying(message: string, variant: string | undefined): NativeActivityObservation {
  const counter = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)\s*$/.exec(message)
  const said = message.replace(/^Reconnecting\.\.\.\s*/, "")
  // Codex tags every stream retry `responseStreamDisconnected`, whatever failed.
  const reason = (variant === "responseStreamDisconnected" ? undefined : codexErrorClass(variant)) ??
    (counter || !said ? undefined : `${said[0]?.toUpperCase() ?? ""}${said.slice(1)}`)
  const activity: NativeActivityObservation = { kind: "retrying" }
  if (counter) {
    activity.attempt = Number(counter[1])
    activity.maxAttempts = Number(counter[2])
  }
  if (reason) activity.reason = reason
  return activity
}

/** A marker shown once per session, however often Codex repeats it. */
function notice(context: ProtocolContext, marker: TranscriptEvent): void {
  const notices = context.notices ??= new Set()
  const key = `${marker.label}\u0000${marker.detail ?? ""}\u0000${marker.body ?? ""}`
  if (notices.has(key)) return
  const oldest = notices.size >= MAX_NOTICES ? notices.values().next().value : undefined
  if (oldest !== undefined) notices.delete(oldest)
  notices.add(key)
  context.protocol.event?.(marker)
}

function wait(context: ProtocolContext, label: string): void {
  if (context.waiting === label) return
  context.waiting = label
  context.protocol.activity?.({ kind: "waiting", label })
}

/** End a waiting activity this protocol set, never one it did not. */
function endWait(context: ProtocolContext, label: string): void {
  if (context.waiting !== label) return
  context.waiting = undefined
  context.protocol.activity?.(null)
}

/** A variant Mako has no words for yet, as lowercase words. */
function words(identifier: string): string {
  return identifier.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
}

function completeTurn(context: ProtocolContext, turn: Turn): void {
  const compaction = context.compaction?.turnId === turn.id ? context.compaction : undefined
  if (compaction) context.compaction = undefined
  const error = turn.error?.message || undefined
  const stop = turn.status === "inProgress" ? "completed" : turn.status
  if (error || stop === "failed")
    context.protocol.event?.(codexFailureEvent(turn.error?.variant, error))
  context.currentTurnId = null
  context.waiting = undefined
  context.protocol.clearTurnServerRequests(turn.id)
  for (const key of context.items.keys()) {
    if (key.startsWith(`${turn.id}\u0000`)) context.items.delete(key)
  }
  context.protocol.updateState({
    status: error || stop === "failed" ? "failed" : "ready",
    lastStop: stop,
    error,
  })
  void listBackground(context)
  if (compaction) context.protocol.actionResult?.(compaction.actionId,
    error || stop !== "completed"
      ? { kind: "failed", reason: error ?? "Compaction was interrupted" }
      : compaction.confirmed
        ? { kind: "completed" }
        : { kind: "uncertain", reason: "The provider ended the turn without confirming compaction." })
}

/**
 * End every terminal the thread left running, then read what remains.
 * Checked on codex 0.154: terminals outlive both an interrupt, which turns
 * the running foreground command into one more, and the app-server's exit.
 */
export async function cleanBackground(context: ProtocolContext): Promise<void> {
  if (!context.threadId) return
  await rpcRequest(context, "thread/backgroundTerminals/clean", { threadId: context.threadId })
  await listBackground(context)
}

/**
 * End the turns and terminals of every subagent the thread started.
 * Checked on codex 0.154: a subagent is another thread loaded in the same
 * app-server. It keeps working after its parent's turn ends, after an
 * interrupt of the parent, and after the app-server exits, and interrupting
 * its own turn leaves its running command as a terminal of its thread.
 */
export async function endSubagents(context: ProtocolContext): Promise<void> {
  const root = context.threadId
  if (!root) return
  const threads: string[] = []
  let cursor: string | undefined
  do {
    const page = await rpcRequest(context, "thread/loaded/list", { cursor })
    threads.push(...page.data)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  await Promise.all(threads.filter((threadId) => threadId !== root).map((threadId) => endSubagent(context, threadId)))
}

async function endSubagent(context: ProtocolContext, threadId: string): Promise<void> {
  const waiters = context.subagentTurns ??= new Map<string, Array<() => void>>()
  let settle = () => {}
  const settled = new Promise<void>((resolve) => { settle = resolve })
  waiters.set(threadId, [...(waiters.get(threadId) ?? []), settle])
  try {
    const [turn] = (await rpcRequest(context, "thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })).data
    if (turn?.status === "inProgress") {
      await rpcRequest(context, "turn/interrupt", { threadId, turnId: turn.id })
      await settled
    }
  } finally {
    const rest = waiters.get(threadId)?.filter((waiter) => waiter !== settle) ?? []
    if (rest.length) waiters.set(threadId, rest)
    else waiters.delete(threadId)
    await rpcRequest(context, "thread/backgroundTerminals/clean", { threadId })
  }
}

/**
 * Codex marks a terminal exited before it completes the command's item, so
 * the list minus completions that race the request is exact.
 */
async function listBackground(context: ProtocolContext): Promise<void> {
  const threadId = context.threadId
  if (!threadId) return
  const raced = new Set<string>()
  context.background.raced = raced
  const running = new Set<string>()
  try {
    let cursor: string | undefined
    do {
      const page = await rpcRequest(context, "thread/backgroundTerminals/list", { threadId, cursor })
      for (const terminal of page.data) running.add(terminal.itemId)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  } catch {
    if (context.background.raced === raced) context.background.raced = undefined
    return
  }
  if (context.background.raced !== raced) return
  context.background.raced = undefined
  if (context.exited || context.threadId !== threadId) return
  for (const id of raced) running.delete(id)
  context.background.running = running
  reportBackground(context)
}

function backgroundEnded(context: ProtocolContext, itemId: string): void {
  context.background.raced?.add(itemId)
  if (context.background.running.delete(itemId)) reportBackground(context)
}

function reportBackground(context: ProtocolContext): void {
  const count = context.background.running.size
  if ((context.state.backgroundTasks ?? 0) !== count)
    context.protocol.updateState({ backgroundTasks: count })
}

function streamDelta(
  context: ProtocolContext,
  notification: StreamDeltaNotification,
  kind: "text" | "thinking"
): void {
  if (!notification.turnId || !notification.itemId || !notification.delta)
    return
  // Output arriving is the response passing its check; Codex sends no end.
  if (context.waiting === CHECKING_RESPONSE) endWait(context, CHECKING_RESPONSE)
  const tracker = itemTracker(context, notification.turnId, notification.itemId)
  if (kind === "text") {
    tracker.textDelta = true
    tracker.text = appendComparable(tracker.text, notification.delta)
  } else {
    tracker.thinkingDelta = true
    tracker.thinking = appendComparable(tracker.thinking, notification.delta)
  }
  context.protocol.emitUpdate({
    kind,
    id: tracker.acpId,
    text: notification.delta,
  })
}

function streamToolOutput(
  context: ProtocolContext,
  notification: ToolOutputNotification
): void {
  if (!notification.delta || !notification.turnId || !notification.itemId)
    return
  const tracker = itemTracker(context, notification.turnId, notification.itemId)
  tracker.output = tail(tracker.output + notification.delta, MAX_TOOL_OUTPUT)
  context.protocol.emitUpdate({
    kind: "tool-update",
    id: tracker.acpId,
    output: tracker.output,
  })
}

function updateToolOutput(
  context: ProtocolContext,
  notification: PatchNotification,
  output: string
): void {
  if (!notification.turnId || !notification.itemId) return
  const tracker = itemTracker(context, notification.turnId, notification.itemId)
  tracker.output = boundedText(output, MAX_TOOL_OUTPUT)
  context.protocol.emitUpdate({
    kind: "tool-update",
    id: tracker.acpId,
    output: tracker.output,
  })
}

function handleItem(
  context: ProtocolContext,
  turnId: string,
  item: ThreadItem,
  completed: boolean,
  replay = false
): void {
  if (!turnId) return
  if (!replay && context.waiting === CHECKING_RESPONSE) endWait(context, CHECKING_RESPONSE)
  const tracker = itemTracker(context, turnId, item.id)
  switch (item.type) {
    case "userMessage":
      if (completed) {
        const originalText = item.content
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("\n")
        if (context.threadId)
          for (const answer of codexAnsweredQuestions(context.threadId, originalText))
            context.protocol.observeQuestionAnswer?.(answer)
        if (!replay) return
        const attachments = item.content.flatMap((part) =>
          part.attachment ? [part.attachment] : []
        )
        const text = codexPrompt(originalText) ?? ""
        if (!attachments.length)
          attachments.push(...codexPromptImages(originalText))
        if (text || attachments.length)
          context.protocol.emitUpdate({ kind: "user", text, attachments })
      }
      return
    case "attachment":
      if (completed)
        context.protocol.emitUpdate({
          kind: "attachment",
          attachment: item.attachment,
        })
      return
    case "agentMessage":
      if (completed) {
        emitFinalText(context, "text", item.text, tracker.acpId)
        if (item.questions && context.threadId)
          context.protocol.observeQuestion?.(codexAsyncQuestion(context.threadId, turnId, item.id, item.questions))
      }
      return
    case "reasoning":
      if (completed) {
        const final = [...item.summary, ...item.content]
          .filter(Boolean)
          .join("\n\n")
        emitFinalText(context, "thinking", final, tracker.acpId)
      }
      return
    case "commandExecution":
      startTool(
        context,
        tracker,
        item.command || "Command",
        "exec_command",
        item.status,
        { command: item.command }
      )
      if (completed) {
        const output = item.aggregatedOutput ?? tracker.output
        finishTool(context, tracker, item.status, output || undefined)
        if (!replay) backgroundEnded(context, item.id)
      }
      return
    case "fileChange": {
      const paths = item.changes.flatMap((change) =>
        change.path === undefined ? [] : [change.path]
      )
      startTool(
        context,
        tracker,
        paths.length ? `Edit ${paths.join(", ")}` : "File changes",
        "apply_patch",
        item.status,
        paths.length ? { path: paths[0], paths } : undefined
      )
      if (completed)
        finishTool(context, tracker, item.status, patchText(item.changes))
      return
    }
    case "mcpToolCall":
      startTool(
        context,
        tracker,
        `${item.server}: ${item.tool}`,
        item.tool,
        item.status,
        item.arguments ?? undefined
      )
      if (completed) {
        const output =
          item.error?.message ||
          (item.result === null ? tracker.output : boundedJson(item.result))
        finishTool(context, tracker, item.status, output || undefined)
      }
      return
    case "dynamicToolCall":
      startTool(
        context,
        tracker,
        `${item.namespace ? `${item.namespace}.` : ""}${item.tool}`,
        item.tool,
        item.status,
        item.arguments ?? undefined
      )
      if (completed)
        finishTool(
          context,
          tracker,
          item.status,
          item.contentItems ? boundedJson(item.contentItems) : undefined
        )
      return
    case "webSearch": {
      const input = item.action ?? { query: item.query }
      const title = item.query || searchTarget(item.action) || "Web search"
      startTool(context, tracker, title, "web_search", completed ? "completed" : "inProgress", input)
      // The query is empty until the search ends.
      if (completed)
        context.protocol.emitUpdate({
          kind: "tool-update",
          id: tracker.acpId,
          title: boundedText(title, 500),
          input: boundedJson(input),
          status: "completed",
          output: searchResults(item.results),
        })
      return
    }
    case "sleep":
      startTool(context, tracker, `Sleep ${duration(item.durationMs)}`, "sleep", completed ? "completed" : "inProgress")
      if (completed) finishTool(context, tracker, "completed")
      return
    case "enteredReviewMode":
      if (completed) {
        const line = firstLine(item.review)
        context.protocol.event?.(event("Review mode started", line, item.review === line ? undefined : item.review))
      }
      return
    case "exitedReviewMode":
      if (completed) context.protocol.event?.(event("Review mode ended", undefined, item.review))
      return
    case "hookPrompt":
      return
    case "collabAgentToolCall":
    case "subAgentActivity":
      context.protocol.observeAgents(item, replay)
      return
    case "plan":
      context.protocol.emitUpdate({
        kind: "proposed-plan",
        id: tracker.acpId,
        text: item.text,
        status: completed ? "proposed" : "drafting",
        replace: true,
      })
      return
    case "contextCompaction":
      if (replay) {
        if (completed) context.protocol.compacted?.()
        return
      }
      context.waiting = undefined
      if (completed) {
        // Codex reports the compacted estimate before this item completes.
        const tokensBefore = context.compactingFrom
        context.compactingFrom = undefined
        context.protocol.compacted?.(tokensBefore ? { tokensBefore } : undefined)
      } else {
        context.compactingFrom = context.state.usage?.used
        context.protocol.activity?.({ kind: "compacting" })
      }
      return
    case "unsupported":
      context.protocol.unhandled?.(`item/${item.sourceType}`)
      return
  }
}

/**
 * Codex names its items by shape, so the tool name and the argument the row
 * shows (the command, the file) are supplied here. Without the input the
 * shell row had no command on it at all, live or expanded.
 */
function startTool(
  context: ProtocolContext,
  tracker: ItemTracker,
  title: string,
  toolKind: string,
  status: string,
  input?: JsonValue
): void {
  if (tracker.started) return
  tracker.started = true
  context.protocol.emitUpdate({
    kind: "tool",
    id: tracker.acpId,
    title: boundedText(title, 500),
    toolKind,
    status: toolStatus(status),
    input: input === undefined ? undefined : boundedJson(input),
  })
}

function finishTool(
  context: ProtocolContext,
  tracker: ItemTracker,
  status: string,
  output?: string
): void {
  context.protocol.emitUpdate({
    kind: "tool-update",
    id: tracker.acpId,
    status: toolStatus(status),
    output: output || undefined,
  })
}

function emitFinalText(
  context: ProtocolContext,
  kind: "text" | "thinking",
  source: string,
  id: string
): void {
  const final = codexPresentation(source)
  // A completed item is authoritative, including corrections and empty replacements.
  if (!final) {
    context.protocol.emitUpdate({ kind, id, text: "", replace: true })
    return
  }
  for (let offset = 0; offset < final.length; offset += MAX_TOOL_OUTPUT) {
    context.protocol.emitUpdate({
      kind,
      id,
      text: final.slice(offset, offset + MAX_TOOL_OUTPUT),
      replace: offset === 0,
    })
  }
}

function itemTracker(
  context: ProtocolContext,
  turnId: string,
  itemId: string
): ItemTracker {
  const key = `${turnId}\u0000${itemId}`
  const current = context.items.get(key)
  if (current) return current
  if (context.items.size >= MAX_TRACKED_ITEMS) {
    const oldest = context.items.keys().next().value
    if (oldest !== undefined) context.items.delete(oldest)
  }
  const tracker: ItemTracker = {
    acpId: `codex:${turnId}:${itemId}`,
    started: false,
    textDelta: false,
    text: "",
    thinkingDelta: false,
    thinking: "",
    output: "",
  }
  context.items.set(key, tracker)
  return tracker
}

export function replayHistory(context: ProtocolContext, turns: Turn[]): void {
  const entries = turns.flatMap((turn) =>
    turn.items.map((item) => ({ turnId: turn.id, item }))
  )
  for (const entry of entries.slice(-MAX_REPLAY_ITEMS))
    handleItem(context, entry.turnId, entry.item, true, true)
  context.items.clear()
}

export function rpcRequest<M extends RpcMethod>(
  context: ProtocolContext,
  method: M,
  params: RpcParams[M]
): Promise<RpcResults[M]>
export function rpcRequest(
  context: ProtocolContext,
  method: RpcMethod,
  params: RpcParams[RpcMethod]
): Promise<RpcResults[RpcMethod]> {
  switch (method) {
    case "thread/turns/list":
      return beginRpcRequest(context, method, params, (value) => {
        const parsed = CodexAgentRunsSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid child turn status response" }
      })
    case "initialize":
      return beginRpcRequest(context, method, params, parseObjectResult)
    case "thread/start":
      return beginRpcRequest(context, method, params, parseThreadResponse)
    case "thread/fork":
    case "thread/resume":
      // The catalog/base already supplies paged native history. Reopening must
      // not hydrate it again as one unbounded JSON-RPC frame. This only omits
      // response turns; Codex still restores its full native model context.
      return beginRpcRequest(context, method, { ...params, excludeTurns: true }, parseThreadResponse)
    case "turn/start":
      return beginRpcRequest(context, method, params, parseTurnResponse)
    case "turn/steer":
      return beginRpcRequest(context, method, params, parseSteerResponse)
    case "thread/compact/start":
    case "turn/interrupt":
    case "thread/backgroundTerminals/clean":
      return beginRpcRequest(context, method, params, parseObjectResult)
    case "thread/backgroundTerminals/list":
      return beginRpcRequest(context, method, params, (value) => {
        const parsed = BackgroundTerminalsSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid background terminal list" }
      })
    case "thread/loaded/list":
      return beginRpcRequest(context, method, params, (value) => {
        const parsed = LoadedThreadsSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid loaded thread list" }
      })
  }
}

function beginRpcRequest<M extends RpcMethod>(
  context: ProtocolContext,
  method: M,
  params: RpcParams[RpcMethod],
  parseResult: RpcResultParser<M>
): Promise<RpcResults[M]> {
  if (context.exited || context.child.stdin.destroyed)
    return Promise.reject(new Error("Codex app-server is not running"))
  const id = ++context.nextRequestId
  return new Promise<RpcResults[M]>((resolve, reject) => {
    // A turn/start the app-server has not answered may already be running
    // its turn; a deadline would call that turn failed and send the next
    // prompt into it. The app-server answers or exits, and its exit rejects.
    const timer = method === "turn/start" ? undefined : setTimeout(() => {
      context.pending.delete(rpcKey(id))
      reject(new Error(`Codex app-server did not answer ${method}`))
    }, ["initialize", "thread/start", "thread/resume", "thread/fork"].includes(method)
      ? STARTUP_TOTAL_MS
      : RPC_TIMEOUT_MS)
    const pending: PendingRpc<M> = {
      method,
      resolve,
      reject,
      parseResult,
      settleResult: (value) => {
        const parsed = parseResult(value)
        if (parsed.valid) resolve(parsed.value)
        else reject(new Error(parsed.message))
      },
      timer,
    }
    context.pending.set(rpcKey(id), pending)
    if (!sendRpc(context, { jsonrpc: "2.0", id, method, params })) {
      clearTimeout(timer)
      context.pending.delete(rpcKey(id))
      reject(new Error("Failed to write to Codex app-server"))
    }
  })
}

export function sendRpc(
  context: ProtocolContext,
  message:
    | JsonObject
    | {
        jsonrpc: "2.0"
        id: number
        method: RpcMethod
        params: RpcParams[RpcMethod]
      }
): boolean {
  if (
    context.exited ||
    context.child.stdin.destroyed ||
    !context.child.stdin.writable
  )
    return false
  try {
    context.child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  } catch {
    return false
  }
}

export function sendRpcResult(
  context: ProtocolContext,
  id: JsonRpcId,
  result: JsonValue
): boolean {
  return sendRpc(context, { jsonrpc: "2.0", id, result })
}

export function sendRpcError(
  context: ProtocolContext,
  id: JsonRpcId,
  code: number,
  message: string
): void {
  sendRpc(context, { jsonrpc: "2.0", id, error: { code, message } })
}

function toolStatus(status: string): string {
  if (status === "inProgress" || status === "pending") return "pending"
  if (status === "completed") return "completed"
  return "failed"
}

function appendComparable(
  current: string | null,
  delta: string
): string | null {
  if (current === null || current.length + delta.length > MAX_STREAM_COMPARE)
    return null
  return current + delta
}

/**
 * Codex's edits as one patch a reader can follow: each file's heading, then
 * its unified diff, or its whole content for a file added or deleted.
 */
function patchText(changes: FileChange[]): string {
  const files = changes.map((change) => {
    const kind = PatchKindSchema.safeParse(change.kind)
    const type = kind.success ? kind.data.type : "update"
    const moved = kind.success ? kind.data.move_path : undefined
    const path = change.path ?? "file"
    const diff = change.diff ?? ""
    switch (type) {
      case "add":
        return `Add ${path}\n${prefixLines(diff, "+")}`
      case "delete":
        return `Delete ${path}\n${prefixLines(diff, "-")}`
      case "update":
        return `Update ${moved ? `${path} → ${moved}` : path}\n${diff.trimEnd()}`
    }
  })
  return boundedText(files.join("\n\n"), MAX_TOOL_OUTPUT)
}

function prefixLines(text: string, prefix: string): string {
  return text.trimEnd().split("\n").map((line) => `${prefix}${line}`).join("\n")
}

function searchTarget(action: JsonObject | null): string | undefined {
  const target = SearchActionSchema.safeParse(action)
  if (!target.success) return undefined
  const { query, queries, url } = target.data
  return query || queries?.join(" · ") || url || undefined
}

/** Standalone search returns results out of band; hosted search returns none. */
function searchResults(results: JsonValue[] | null): string | undefined {
  const lines = (results ?? []).flatMap((result) => {
    const parsed = SearchResultSchema.safeParse(result)
    if (!parsed.success) return []
    const { title, url } = parsed.data
    return [title ? `${title}\n${url}` : url]
  })
  return lines.length ? boundedText(lines.join("\n\n"), MAX_TOOL_OUTPUT) : undefined
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
}

function boundedJson(value: JsonValue): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return "[unserializable output]"
  }
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function rpcKey(id: JsonRpcId): string {
  return `${isNumber(id) ? "number" : "string"}:${id}`
}
