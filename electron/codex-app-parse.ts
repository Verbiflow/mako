import { CodexReportedAccessSchema } from "./providers/codex/access.js"
import {
  CodexAgentItemSchema,
  CodexAgentActivitySchema,
} from "./providers/codex/agents.js"
import { attachmentFromCodexContent } from "./providers/codex/content.js"
import {
  booleanValue,
  isJsonObject,
  numberValue,
  objectValue,
  stringValue,
  type JsonObject,
  type JsonRpcId,
  type JsonValue,
} from "./codex-app-json.js"
import type {
  ParseResult,
  ThreadItem,
  ThreadResponse,
  Turn,
} from "./codex-app-types.js"

type UserMessageContent = Extract<
  ThreadItem,
  { type: "userMessage" }
>["content"][number]
type FileChange = Extract<ThreadItem, { type: "fileChange" }>["changes"][number]
type McpToolError = NonNullable<
  Extract<ThreadItem, { type: "mcpToolCall" }>["error"]
>

export type JsonRpcEnvelope =
  | {
      kind: "response"
      id: JsonRpcId
      result: JsonValue | undefined
      error: JsonObject | null
    }
  | { kind: "request"; id: JsonRpcId; method: string; params: JsonObject }
  | { kind: "notification"; method: string; params: JsonObject }
  | { kind: "ignored" }
  | { kind: "invalid" }

type StartedTurnNotification = {
  method: "turn/started"
  threadId: string
  turnId: string
}

type CompletedTurnNotification = {
  method: "turn/completed"
  threadId: string
  turn: Turn
}

type ItemNotification = {
  method: "item/started" | "item/completed"
  threadId: string
  turnId: string
  item: ThreadItem
}

export type StreamDeltaNotification = {
  method:
    | "item/agentMessage/delta"
    | "item/plan/delta"
    | "item/reasoning/summaryTextDelta"
    | "item/reasoning/textDelta"
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export type ToolOutputNotification = {
  method:
    | "item/commandExecution/outputDelta"
    | "item/fileChange/outputDelta"
    | "item/mcpToolCall/progress"
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export type PatchNotification = {
  method: "item/fileChange/patchUpdated"
  threadId: string
  turnId: string
  itemId: string
  changes: JsonValue
}

type PlanNotification = {
  method: "turn/plan/updated"
  threadId: string
  plan: Array<{ step: string; status: string }>
}

type ErrorNotification = {
  method: "error"
  threadId?: string
  message: string
}

type ResolvedNotification = {
  method: "serverRequest/resolved"
  threadId?: string
  requestId: JsonRpcId
}

type TokenUsageNotification = {
  method: "thread/tokenUsage/updated"
  threadId: string
}

export type ProtocolNotification =
  | StartedTurnNotification
  | CompletedTurnNotification
  | ItemNotification
  | StreamDeltaNotification
  | ToolOutputNotification
  | PatchNotification
  | PlanNotification
  | ErrorNotification
  | ResolvedNotification
  | TokenUsageNotification

export function parseJsonRpcEnvelope(line: string): JsonRpcEnvelope {
  let value: JsonValue
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: "invalid" }
  }
  if (!isJsonObject(value)) return { kind: "ignored" }
  const id = rpcIdValue(value.id)
  if (
    id !== undefined &&
    (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))
  ) {
    return {
      kind: "response",
      id,
      result: value.result,
      error: isJsonObject(value.error) ? value.error : null,
    }
  }
  const method = stringValue(value.method)
  if (method === undefined) return { kind: "ignored" }
  const params = isJsonObject(value.params) ? value.params : {}
  return id === undefined
    ? { kind: "notification", method, params }
    : { kind: "request", id, method, params }
}

export function parseNotification(
  method: string,
  params: JsonObject
): ProtocolNotification | null {
  const threadId = stringValue(params.threadId)
  switch (method) {
    case "turn/started": {
      const turn = objectValue(params.turn)
      const turnId = stringValue(turn?.id)
      return threadId !== undefined && turnId !== undefined
        ? { method, threadId, turnId }
        : null
    }
    case "turn/completed": {
      const turn = parseTurn(params.turn)
      return threadId !== undefined && turn ? { method, threadId, turn } : null
    }
    case "item/started":
    case "item/completed": {
      const turnId = stringValue(params.turnId)
      const item = parseThreadItem(params.item)
      return threadId !== undefined && turnId !== undefined && item
        ? { method, threadId, turnId, item }
        : null
    }
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        delta !== undefined
        ? { method, threadId, turnId, itemId, delta }
        : null
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        delta !== undefined
        ? { method, threadId, turnId, itemId, delta }
        : null
    }
    case "item/mcpToolCall/progress": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      const message = stringValue(params.message)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        message !== undefined
        ? { method, threadId, turnId, itemId, delta: `${message}\n` }
        : null
    }
    case "item/fileChange/patchUpdated": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        params.changes !== undefined
        ? { method, threadId, turnId, itemId, changes: params.changes }
        : null
    }
    case "turn/plan/updated": {
      const plan = parsePlan(params.plan)
      return threadId !== undefined && plan ? { method, threadId, plan } : null
    }
    case "error": {
      const error = objectValue(params.error)
      return {
        method,
        threadId,
        message: stringValue(error?.message) ?? "Codex encountered an error",
      }
    }
    case "serverRequest/resolved": {
      const requestId = rpcIdValue(params.requestId)
      return requestId === undefined ? null : { method, threadId, requestId }
    }
    case "thread/tokenUsage/updated":
      return threadId === undefined ? null : { method, threadId }
    default:
      return null
  }
}

export function parseObjectResult(
  value: JsonValue | undefined
): ParseResult<JsonObject> {
  return isJsonObject(value)
    ? { valid: true, value }
    : invalidResult("Codex app-server returned an invalid object result")
}

export function parseThreadResponse(
  value: JsonValue | undefined
): ParseResult<ThreadResponse> {
  const root = objectValue(value)
  const thread = objectValue(root?.thread)
  const id = stringValue(thread?.id)
  if (!root || !thread || id === undefined)
    return invalidResult("Codex app-server returned an invalid thread result")
  const cwd = optionalString(thread.cwd)
  if (!cwd.valid)
    return invalidResult("Codex app-server returned an invalid thread cwd")
  const path = optionalNullableString(thread.path)
  if (!path.valid)
    return invalidResult("Codex app-server returned an invalid thread path")
  const turns = optionalArray(thread.turns, parseTurn)
  if (!turns.valid)
    return invalidResult("Codex app-server returned invalid thread turns")
  const model = optionalString(root.model)
  const serviceTier = optionalNullableString(root.serviceTier)
  const reasoningEffort = optionalNullableString(root.reasoningEffort)
  if (!model.valid || !serviceTier.valid || !reasoningEffort.valid)
    return invalidResult("Codex app-server returned invalid thread metadata")
  const parsedThread: ThreadResponse["thread"] = { id }
  if (cwd.value !== undefined) parsedThread.cwd = cwd.value
  if (path.value !== undefined) parsedThread.path = path.value
  if (turns.value !== undefined) parsedThread.turns = turns.value
  const response: ThreadResponse = { thread: parsedThread }
  if (model.value !== undefined) response.model = model.value
  if (serviceTier.value !== undefined) response.serviceTier = serviceTier.value
  if (reasoningEffort.value !== undefined)
    response.reasoningEffort = reasoningEffort.value
  // Missing or future policy variants remain unclassified, never "Ask".
  const access = CodexReportedAccessSchema.safeParse(root)
  if (access.success) Object.assign(response, access.data)
  return { valid: true, value: response }
}

export function parseTurnResponse(
  value: JsonValue | undefined
): ParseResult<{ turn: Turn }> {
  const root = objectValue(value)
  const turn = parseTurn(root?.turn)
  return root && turn
    ? { valid: true, value: { turn } }
    : invalidResult("Codex app-server returned an invalid turn result")
}

export function parseSteerResponse(
  value: JsonValue | undefined
): ParseResult<{ turnId: string }> {
  const root = objectValue(value)
  const turnId = stringValue(root?.turnId)
  return turnId
    ? { valid: true, value: { turnId } }
    : invalidResult("Codex returned an invalid steering receipt")
}

function parseTurn(value: JsonValue | undefined): Turn | null {
  const root = objectValue(value)
  const id = stringValue(root?.id)
  const status = stringValue(root?.status)
  const items = parseArray(root?.items, parseThreadItem)
  const error = parseTurnError(root?.error)
  return root &&
    id !== undefined &&
    status !== undefined &&
    items &&
    error.valid
    ? { id, status, items, error: error.value }
    : null
}

function parseTurnError(
  value: JsonValue | undefined
): ParseResult<Turn["error"]> {
  if (value === null) return { valid: true, value: null }
  const root = objectValue(value)
  if (!root) return invalidResult("invalid turn error")
  const message = optionalString(root.message)
  const additionalDetails = optionalNullableString(root.additionalDetails)
  if (!message.valid || !additionalDetails.valid)
    return invalidResult("invalid turn error")
  const error: Exclude<Turn["error"], null> = {}
  if (message.value !== undefined) error.message = message.value
  if (additionalDetails.value !== undefined)
    error.additionalDetails = additionalDetails.value
  return { valid: true, value: error }
}

function parseThreadItem(value: JsonValue | undefined): ThreadItem | null {
  const root = objectValue(value)
  const type = stringValue(root?.type)
  const id = stringValue(root?.id)
  if (!root || type === undefined || id === undefined) return null
  switch (type) {
    case "userMessage": {
      const content = parseArray(root.content, parseUserContent)
      return content ? { type, id, content } : null
    }
    case "agentMessage": {
      const text = stringValue(root.text)
      return text === undefined ? null : { type, id, text }
    }
    case "reasoning": {
      const summary = stringArray(root.summary)
      const content = stringArray(root.content)
      return summary && content ? { type, id, summary, content } : null
    }
    case "commandExecution": {
      const command = stringValue(root.command)
      const cwd = stringValue(root.cwd)
      const status = stringValue(root.status)
      const aggregatedOutput = nullableString(root.aggregatedOutput)
      const exitCode = nullableNumber(root.exitCode)
      return command !== undefined &&
        cwd !== undefined &&
        status !== undefined &&
        aggregatedOutput.valid &&
        exitCode.valid
        ? {
            type,
            id,
            command,
            cwd,
            status,
            aggregatedOutput: aggregatedOutput.value,
            exitCode: exitCode.value,
          }
        : null
    }
    case "fileChange": {
      const changes = parseArray(root.changes, parseFileChange)
      const status = stringValue(root.status)
      return changes && status !== undefined
        ? { type, id, changes, status }
        : null
    }
    case "mcpToolCall": {
      const server = stringValue(root.server)
      const tool = stringValue(root.tool)
      const status = stringValue(root.status)
      const error = parseItemError(root.error)
      return server !== undefined &&
        tool !== undefined &&
        status !== undefined &&
        root.result !== undefined &&
        error.valid
        ? {
            type,
            id,
            server,
            tool,
            status,
            result: root.result,
            error: error.value,
          }
        : null
    }
    case "dynamicToolCall": {
      const namespace = nullableString(root.namespace)
      const tool = stringValue(root.tool)
      const status = stringValue(root.status)
      const contentItems = nullableJsonArray(root.contentItems)
      const success = nullableBoolean(root.success)
      return namespace.valid &&
        tool !== undefined &&
        status !== undefined &&
        contentItems.valid &&
        success.valid
        ? {
            type,
            id,
            namespace: namespace.value,
            tool,
            status,
            contentItems: contentItems.value,
            success: success.value,
          }
        : null
    }
    case "imageView":
    case "imageGeneration": {
      return {
        type: "attachment",
        id,
        attachment: attachmentFromCodexContent(root),
      }
    }
    case "collabAgentToolCall": {
      const parsed = CodexAgentItemSchema.safeParse(root)
      return parsed.success ? parsed.data : null
    }
    case "subAgentActivity": {
      const parsed = CodexAgentActivitySchema.safeParse(root)
      return parsed.success ? parsed.data : null
    }
    case "plan": {
      const text = stringValue(root.text)
      return text === undefined ? null : { type, id, text }
    }
    default:
      return { type: "unsupported", id, sourceType: type }
  }
}

function parseUserContent(value: JsonValue): UserMessageContent | null {
  const root = objectValue(value)
  if (!root) return null
  const type = optionalString(root.type)
  const text = optionalString(root.text)
  if (!type.valid || !text.valid) return null
  const content: UserMessageContent = {}
  if (type.value && type.value !== "text")
    content.attachment = attachmentFromCodexContent(root)
  if (type.value !== undefined) content.type = type.value
  if (text.value !== undefined) content.text = text.value
  return content
}

function parseFileChange(value: JsonValue): FileChange | null {
  const root = objectValue(value)
  if (!root) return null
  const path = optionalString(root.path)
  const diff = optionalString(root.diff)
  if (!path.valid || !diff.valid) return null
  const change: FileChange = {}
  if (path.value !== undefined) change.path = path.value
  if (diff.value !== undefined) change.diff = diff.value
  if (root.kind !== undefined) change.kind = root.kind
  return change
}

function parseItemError(
  value: JsonValue | undefined
): ParseResult<McpToolError | null> {
  if (value === null) return { valid: true, value: null }
  const root = objectValue(value)
  const message = optionalString(root?.message)
  if (!root || !message.valid) return invalidResult("invalid item error")
  const error: McpToolError = {}
  if (message.value !== undefined) error.message = message.value
  return { valid: true, value: error }
}

function parsePlan(
  value: JsonValue | undefined
): Array<{ step: string; status: string }> | null {
  return parseArray(value, (entry) => {
    const root = objectValue(entry)
    const step = stringValue(root?.step)
    const status = stringValue(root?.status)
    return root && step !== undefined && status !== undefined
      ? { step, status }
      : null
  })
}

function invalidResult<T>(message: string): ParseResult<T> {
  return { valid: false, message }
}

function parseArray<T>(
  value: JsonValue | undefined,
  parse: (entry: JsonValue) => T | null
): T[] | null {
  if (!Array.isArray(value)) return null
  const result: T[] = []
  for (const entry of value) {
    const parsed = parse(entry)
    if (parsed === null) return null
    result.push(parsed)
  }
  return result
}

function optionalArray<T>(
  value: JsonValue | undefined,
  parse: (entry: JsonValue) => T | null
): ParseResult<T[] | undefined> {
  if (value === undefined) return { valid: true, value: undefined }
  const parsed = parseArray(value, parse)
  return parsed
    ? { valid: true, value: parsed }
    : invalidResult("invalid array")
}

function stringArray(value: JsonValue | undefined): string[] | null {
  return parseArray(value, (entry) => stringValue(entry) ?? null)
}

function optionalString(
  value: JsonValue | undefined
): ParseResult<string | undefined> {
  if (value === undefined) return { valid: true, value: undefined }
  const parsed = stringValue(value)
  return parsed === undefined
    ? invalidResult("invalid string")
    : { valid: true, value: parsed }
}

function optionalNullableString(
  value: JsonValue | undefined
): ParseResult<string | null | undefined> {
  if (value === undefined || value === null) return { valid: true, value }
  const parsed = stringValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable string")
    : { valid: true, value: parsed }
}

function nullableString(
  value: JsonValue | undefined
): ParseResult<string | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = stringValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable string")
    : { valid: true, value: parsed }
}

function nullableNumber(
  value: JsonValue | undefined
): ParseResult<number | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = numberValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable number")
    : { valid: true, value: parsed }
}

function nullableBoolean(
  value: JsonValue | undefined
): ParseResult<boolean | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = booleanValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable boolean")
    : { valid: true, value: parsed }
}

function nullableJsonArray(
  value: JsonValue | undefined
): ParseResult<JsonValue[] | null> {
  if (value === null) return { valid: true, value: null }
  return Array.isArray(value)
    ? { valid: true, value }
    : invalidResult("invalid nullable array")
}

function rpcIdValue(value: JsonValue | undefined): JsonRpcId | undefined {
  return stringValue(value) ?? numberValue(value)
}
