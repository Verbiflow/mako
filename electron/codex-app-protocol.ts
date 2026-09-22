import { STARTUP_TOTAL_MS } from "./provider-startup.js"
import { CodexAgentRunsSchema } from "./providers/codex/agent-status.js"
import {
  codexPresentation,
  codexPrompt,
  codexPromptImages,
} from "@mako/sessions/codex-presentation"
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
  const notification = parseNotification(message.method, message.params)
  if (notification) handleNotification(context, notification)
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
  if (
    notification.threadId &&
    context.threadId &&
    notification.threadId !== context.threadId
  ) {
    if (notification.method === "turn/started" || notification.method === "turn/completed")
      context.protocol.observeAgentTurn?.(notification.threadId)
    return
  }
  switch (notification.method) {
    case "turn/started":
      if (context.compaction && !context.compaction.turnId)
        context.compaction.turnId = notification.turnId
      context.currentTurnId = notification.turnId
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
      if (context.compaction?.turnId === notification.turnId &&
        notification.item.type === "unsupported" && notification.item.sourceType === "contextCompaction")
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
      updateToolOutput(context, notification, boundedJson(notification.changes))
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
      context.protocol.updateState({ error: notification.message })
      return
    case "serverRequest/resolved":
      context.protocol.resolveServerRequest(notification.requestId)
      return
    case "thread/tokenUsage/updated":
      return
  }
}

function completeTurn(context: ProtocolContext, turn: Turn): void {
  const compaction = context.compaction?.turnId === turn.id ? context.compaction : undefined
  if (compaction) context.compaction = undefined
  const error = turn.error?.message || undefined
  const stop = turn.status === "inProgress" ? "completed" : turn.status
  context.currentTurnId = null
  context.protocol.clearTurnServerRequests(turn.id)
  for (const key of context.items.keys()) {
    if (key.startsWith(`${turn.id}\u0000`)) context.items.delete(key)
  }
  context.protocol.updateState({
    status: error || stop === "failed" ? "failed" : "ready",
    lastStop: stop,
    error,
  })
  if (compaction) context.protocol.actionResult?.(compaction.actionId,
    error || stop !== "completed"
      ? { kind: "failed", reason: error ?? "Compaction was interrupted" }
      : compaction.confirmed
        ? { kind: "completed" }
        : { kind: "uncertain", reason: "The provider ended the turn without confirming compaction." })
}

function streamDelta(
  context: ProtocolContext,
  notification: StreamDeltaNotification,
  kind: "text" | "thinking"
): void {
  if (!notification.turnId || !notification.itemId || !notification.delta)
    return
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
  const tracker = itemTracker(context, turnId, item.id)
  switch (item.type) {
    case "userMessage":
      if (completed && replay) {
        const originalText = item.content
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("\n")
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
      if (completed) emitFinalText(context, "text", item.text, tracker.acpId)
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
        finishTool(context, tracker, item.status, boundedJson(item.changes))
      return
    }
    case "mcpToolCall":
      startTool(
        context,
        tracker,
        `${item.server}: ${item.tool}`,
        item.tool,
        item.status
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
        item.status
      )
      if (completed)
        finishTool(
          context,
          tracker,
          item.status,
          item.contentItems ? boundedJson(item.contentItems) : undefined
        )
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
    case "unsupported":
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
  input?: JsonObject
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
      return beginRpcRequest(context, method, params, parseObjectResult)
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
    const timer = setTimeout(() => {
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
): void {
  sendRpc(context, { jsonrpc: "2.0", id, result })
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
