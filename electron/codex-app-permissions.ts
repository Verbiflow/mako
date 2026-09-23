import { randomUUID } from "node:crypto"
import type { ApprovalSubmission } from "./contracts/approval-response.js"
import {
  booleanValue,
  boundedText,
  objectValue,
  stringValue,
  type JsonObject,
  type JsonRpcId,
  type JsonValue,
} from "./codex-app-json.js"
import type {
  LivePermissionRequest,
  LivePermissionResponse,
  LiveDriverEvent,
} from "./shared.js"

type CommandDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: JsonObject }
  | { applyNetworkPolicyAmendment: JsonObject }

type UserInputQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}

type ServerRequestParams = {
  "item/commandExecution/requestApproval": {
    threadId: string
    turnId: string
    itemId: string
    command?: string | null
    cwd?: string | null
    reason?: string | null
    availableDecisions?: CommandDecision[] | null
  }
  "item/fileChange/requestApproval": {
    threadId: string
    turnId: string
    itemId: string
    reason?: string | null
    grantRoot?: string | null
  }
  "item/tool/requestUserInput": {
    threadId: string
    turnId: string
    itemId: string
    questions: UserInputQuestion[]
    isBlocking: boolean
  }
  "item/permissions/requestApproval": {
    threadId: string
    turnId: string
    itemId: string
    cwd: string
    reason: string | null
    permissions: JsonObject
  }
  "mcpServer/elicitation/request": {
    threadId: string
    turnId: string | null
    serverName: string
    mode: "form" | "openai/form" | "url"
    approvalConfirmation: boolean
    message: string
  }
}

type ServerRequestResults = {
  "item/commandExecution/requestApproval": { decision: CommandDecision }
  "item/fileChange/requestApproval": {
    decision: "accept" | "acceptForSession" | "decline" | "cancel"
  }
  "item/tool/requestUserInput": {
    answers: Record<string, { answers: string[] }>
  }
  "item/permissions/requestApproval": {
    permissions: JsonObject
    scope: "turn" | "session"
  }
  "mcpServer/elicitation/request": {
    action: "accept" | "decline" | "cancel"
    content: JsonObject | null
    _meta: null
  }
}

type ServerRequestMethod = keyof ServerRequestParams
type ServerRequestResult = ServerRequestResults[ServerRequestMethod]
type PermissionChoice<R> = {
  optionId: string
  name: string
  kind?: string
  result: R
}

export type PendingServerRequest<
  M extends ServerRequestMethod = ServerRequestMethod,
> = {
  method: M
  observationId: string
  answered?: boolean
  rpcId: JsonRpcId
  turnId: string | null
  choices: Map<string, ServerRequestResults[M]>
  cancel: ServerRequestResults[M]
  questionIds?: Set<string>
}

export interface PermissionContext {
  id: string
  serverRequests: Map<string, PendingServerRequest>
}

export interface PermissionCallbacks<C extends PermissionContext> {
  emit(context: C, event: LiveDriverEvent): void
  sendResult(context: C, id: JsonRpcId, result: ServerRequestResult): boolean
  sendError(context: C, id: JsonRpcId, code: number, message: string): void
}

export function handleServerRequest<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId,
  method: string,
  params: JsonObject
): void {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const parsed = parseCommandApproval(params)
      if (parsed) requestCommandApproval(context, callbacks, id, parsed)
      else invalidRequest(context, callbacks, id)
      return
    }
    case "item/fileChange/requestApproval": {
      const parsed = parseFileApproval(params)
      if (parsed) requestFileApproval(context, callbacks, id, parsed)
      else invalidRequest(context, callbacks, id)
      return
    }
    case "item/tool/requestUserInput": {
      const parsed = parseUserInput(params)
      if (parsed) requestUserInput(context, callbacks, id, parsed)
      else invalidRequest(context, callbacks, id)
      return
    }
    case "item/permissions/requestApproval": {
      const parsed = parsePermissions(params)
      if (parsed) requestPermissions(context, callbacks, id, parsed)
      else invalidRequest(context, callbacks, id)
      return
    }
    case "mcpServer/elicitation/request": {
      const parsed = parseMcpElicitation(params)
      if (parsed) requestMcpElicitation(context, callbacks, id, parsed)
      else invalidRequest(context, callbacks, id)
      return
    }
    default:
      callbacks.sendError(
        context,
        id,
        -32601,
        `Unsupported server request: ${method}`
      )
  }
}

export function resolvePermission<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  requestId: string,
  response: LivePermissionResponse
): ApprovalSubmission {
  const pending = context.serverRequests.get(requestId)
  if (!pending || pending.answered) return { kind: "not-submitted", pending: false, reason: "request-ended" }
  let result: ServerRequestResult | undefined
  if (pending.method === "item/tool/requestUserInput" && pending.questionIds && response.kind === "answers") {
    const answers = validatedAnswers(response.answers, pending.questionIds)
    if (answers) result = { answers }
  } else if (response.kind === "choice") {
    result = response.optionId === null ? pending.cancel : pending.choices.get(response.optionId)
  }
  // Validation has not written anything. Keep the native question answerable.
  if (result === undefined) return { kind: "not-submitted", pending: true, reason: "invalid-answer" }
  pending.answered = true
  return callbacks.sendResult(context, pending.rpcId, result)
    ? { kind: "submitted", source: "transport-write" }
    : { kind: "uncertain", reason: "The answer could not be confirmed as written to the agent connection." }
}

function validatedAnswers(
  candidate: Record<string, string[]>,
  questionIds: Set<string>
): Record<string, { answers: string[] }> | null {
  const answers: Record<string, { answers: string[] }> = {}
  for (const [id, values] of Object.entries(candidate)) {
    if (
      !questionIds.has(id) ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => value.length > 10_000)
    )
      return null
    answers[id] = { answers: values }
  }
  return Object.keys(answers).length === questionIds.size ? answers : null
}

export function resolveServerRequest<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId
): void {
  const requestId = String(id)
  const pending = context.serverRequests.get(requestId)
  if (!pending) return
  context.serverRequests.delete(requestId)
  callbacks.emit(context, { type: "live-permission-ended", id: context.id, requestId,
    observationId: pending.observationId, source: "native-resolution" })
}

export function clearTurnServerRequests(
  context: PermissionContext,
  turnId: string
): void {
  for (const [key, request] of context.serverRequests) {
    if (request.turnId === turnId) context.serverRequests.delete(key)
  }
}

function invalidRequest<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId
): void {
  callbacks.sendError(context, id, -32602, "Invalid server request params")
}

function requestCommandApproval<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId,
  params: ServerRequestParams["item/commandExecution/requestApproval"]
): void {
  const defaultDecisions: CommandDecision[] = [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ]
  const decisions = params.availableDecisions?.length
    ? params.availableDecisions
    : defaultDecisions
  const choices = decisions.map(
    (decision, index): PermissionChoice<{ decision: CommandDecision }> => ({
      optionId: `decision:${index}`,
      name: decisionName(decision),
      kind: decisionKind(decision),
      result: { decision },
    })
  )
  const title =
    params.command || params.reason || "Codex wants to run a command"
  registerServerRequest(
    context,
    callbacks,
    id,
    "item/commandExecution/requestApproval",
    params.turnId,
    title,
    "execute",
    choices,
    { decision: "cancel" }
  )
}

function requestFileApproval<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId,
  params: ServerRequestParams["item/fileChange/requestApproval"]
): void {
  const choices: Array<
    PermissionChoice<ServerRequestResults["item/fileChange/requestApproval"]>
  > = [
    {
      optionId: "accept",
      name: "Allow once",
      kind: "allow_once",
      result: { decision: "accept" },
    },
    {
      optionId: "acceptForSession",
      name: "Allow for session",
      kind: "allow_always",
      result: { decision: "acceptForSession" },
    },
    {
      optionId: "decline",
      name: "Deny",
      kind: "reject_once",
      result: { decision: "decline" },
    },
    {
      optionId: "cancel",
      name: "Deny and stop",
      kind: "reject_always",
      result: { decision: "cancel" },
    },
  ]
  const title =
    params.reason ||
    (params.grantRoot
      ? `Allow changes under ${params.grantRoot}`
      : "Codex wants to change files")
  registerServerRequest(
    context,
    callbacks,
    id,
    "item/fileChange/requestApproval",
    params.turnId,
    title,
    "edit",
    choices,
    { decision: "cancel" }
  )
}

function requestUserInput<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId,
  params: ServerRequestParams["item/tool/requestUserInput"]
): void {
  const choices: Array<
    PermissionChoice<ServerRequestResults["item/tool/requestUserInput"]>
  > = []
  const title =
    params.questions.map((question) => question.question).join(" / ") ||
    "Codex needs input"
  registerServerRequest(
    context,
    callbacks,
    id,
    "item/tool/requestUserInput",
    params.turnId,
    title,
    "other",
    choices,
    { answers: {} },
    params.questions
  )
}

function requestPermissions<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId,
  params: ServerRequestParams["item/permissions/requestApproval"]
): void {
  const choices: Array<
    PermissionChoice<ServerRequestResults["item/permissions/requestApproval"]>
  > = [
    {
      optionId: "turn",
      name: "Allow once",
      kind: "allow_once",
      result: { permissions: params.permissions, scope: "turn" },
    },
    {
      optionId: "session",
      name: "Allow for session",
      kind: "allow_always",
      result: { permissions: params.permissions, scope: "session" },
    },
    {
      optionId: "deny",
      name: "Deny",
      kind: "reject_once",
      result: { permissions: {}, scope: "turn" },
    },
  ]
  registerServerRequest(
    context,
    callbacks,
    id,
    "item/permissions/requestApproval",
    params.turnId,
    params.reason || "Codex requests additional permissions",
    "execute",
    choices,
    { permissions: {}, scope: "turn" }
  )
}

function requestMcpElicitation<C extends PermissionContext>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  id: JsonRpcId,
  params: ServerRequestParams["mcpServer/elicitation/request"]
): void {
  const choices: Array<
    PermissionChoice<ServerRequestResults["mcpServer/elicitation/request"]>
  > = [
    {
      optionId: "decline",
      name: "Decline",
      kind: "reject_once",
      result: { action: "decline", content: null, _meta: null },
    },
    {
      optionId: "cancel",
      name: "Cancel",
      kind: "reject_always",
      result: { action: "cancel", content: null, _meta: null },
    },
  ]
  if (params.approvalConfirmation)
    choices.unshift({
      optionId: "accept",
      name: "Allow once",
      kind: "allow_once",
      result: { action: "accept", content: {}, _meta: null },
    })
  registerServerRequest(
    context,
    callbacks,
    id,
    "mcpServer/elicitation/request",
    params.turnId,
    `${params.serverName}: ${params.message}`,
    "fetch",
    choices,
    { action: "cancel", content: null, _meta: null }
  )
}

function registerServerRequest<
  C extends PermissionContext,
  M extends ServerRequestMethod,
>(
  context: C,
  callbacks: PermissionCallbacks<C>,
  rpcId: JsonRpcId,
  method: M,
  turnId: string | null,
  title: string,
  kind: string,
  choices: Array<PermissionChoice<ServerRequestResults[M]>>,
  cancel: ServerRequestResults[M],
  questions?: UserInputQuestion[]
): void {
  const requestId = String(rpcId)
  if (context.serverRequests.has(requestId)) {
    callbacks.sendError(context, rpcId, -32600, "Duplicate server request id")
    return
  }
  const pending: PendingServerRequest<M> = {
    method,
    observationId: randomUUID(),
    rpcId,
    turnId,
    choices: new Map(choices.map((choice) => [choice.optionId, choice.result])),
    cancel,
    questionIds: questions
      ? new Set(questions.map((question) => question.id))
      : undefined,
  }
  context.serverRequests.set(requestId, pending)
  const request: LivePermissionRequest = {
    id: requestId,
    observationId: pending.observationId,
    sessionId: context.id,
    title: boundedText(title, 1000),
    kind,
    options: choices.map(({ optionId, name, kind: optionKind }) => ({
      optionId,
      name,
      kind: optionKind,
    })),
    questions: questions?.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isSecret: question.isSecret,
      allowOther: question.isOther,
      options: question.options ?? [],
    })),
  }
  callbacks.emit(context, { type: "live-permission", request })
}

function decisionName(decision: CommandDecision): string {
  if (decision === "accept") return "Allow once"
  if (decision === "acceptForSession") return "Allow for session"
  if (decision === "decline") return "Deny"
  if (decision === "cancel") return "Deny and stop"
  if ("acceptWithExecpolicyAmendment" in decision)
    return "Allow matching commands"
  return "Apply network rule"
}

function decisionKind(decision: CommandDecision): string {
  if (decision === "accept") return "allow_once"
  if (decision === "decline") return "reject_once"
  if (decision === "cancel") return "reject_always"
  return "allow_always"
}

function parseCommandApproval(
  params: JsonObject
): ServerRequestParams["item/commandExecution/requestApproval"] | null {
  const base = parseItemRequest(params)
  if (!base) return null
  const command = optionalNullableString(params.command)
  const cwd = optionalNullableString(params.cwd)
  const reason = optionalNullableString(params.reason)
  const availableDecisions = optionalNullableArray(
    params.availableDecisions,
    parseCommandDecision
  )
  if (
    !command.valid ||
    !cwd.valid ||
    !reason.valid ||
    !availableDecisions.valid
  )
    return null
  const result: ServerRequestParams["item/commandExecution/requestApproval"] =
    base
  if (command.value !== undefined) result.command = command.value
  if (cwd.value !== undefined) result.cwd = cwd.value
  if (reason.value !== undefined) result.reason = reason.value
  if (availableDecisions.value !== undefined)
    result.availableDecisions = availableDecisions.value
  return result
}

function parseFileApproval(
  params: JsonObject
): ServerRequestParams["item/fileChange/requestApproval"] | null {
  const base = parseItemRequest(params)
  const reason = optionalNullableString(params.reason)
  const grantRoot = optionalNullableString(params.grantRoot)
  if (!base || !reason.valid || !grantRoot.valid) return null
  const result: ServerRequestParams["item/fileChange/requestApproval"] = base
  if (reason.value !== undefined) result.reason = reason.value
  if (grantRoot.value !== undefined) result.grantRoot = grantRoot.value
  return result
}

function parseUserInput(
  params: JsonObject
): ServerRequestParams["item/tool/requestUserInput"] | null {
  const base = parseItemRequest(params)
  const questions = parseArray(params.questions, parseQuestion)
  const isBlocking = booleanValue(params.isBlocking)
  return base && questions && isBlocking !== undefined
    ? { ...base, questions, isBlocking }
    : null
}

function parsePermissions(
  params: JsonObject
): ServerRequestParams["item/permissions/requestApproval"] | null {
  const base = parseItemRequest(params)
  const cwd = stringValue(params.cwd)
  const reason = nullableString(params.reason)
  const permissions = objectValue(params.permissions)
  return base && cwd !== undefined && reason.valid && permissions
    ? { ...base, cwd, reason: reason.value, permissions }
    : null
}

function parseMcpElicitation(
  params: JsonObject
): ServerRequestParams["mcpServer/elicitation/request"] | null {
  const threadId = stringValue(params.threadId)
  const turnId = nullableString(params.turnId)
  const serverName = stringValue(params.serverName)
  const message = stringValue(params.message)
  const mode = stringValue(params.mode)
  if (
    threadId === undefined ||
    !turnId.valid ||
    serverName === undefined ||
    message === undefined ||
    (mode !== "form" && mode !== "openai/form" && mode !== "url")
  )
    return null
  const schema = objectValue(params.requestedSchema)
  const properties = objectValue(schema?.properties)
  const meta = objectValue(params._meta) ?? objectValue(params.meta)
  const approvalConfirmation =
    mode === "form" &&
    meta?.codex_approval_kind === "mcp_tool_call" &&
    schema?.type === "object" &&
    Object.keys(schema).every((key) =>
      [
        "type",
        "properties",
        "required",
        "title",
        "description",
        "$schema",
        "additionalProperties",
      ].includes(key)
    ) &&
    properties !== undefined &&
    properties !== null &&
    Object.keys(properties).length === 0 &&
    (schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.length === 0))
  return {
    threadId,
    turnId: turnId.value,
    serverName,
    mode,
    message,
    approvalConfirmation,
  }
}

function parseItemRequest(
  params: JsonObject
): { threadId: string; turnId: string; itemId: string } | null {
  const threadId = stringValue(params.threadId)
  const turnId = stringValue(params.turnId)
  const itemId = stringValue(params.itemId)
  return threadId !== undefined && turnId !== undefined && itemId !== undefined
    ? { threadId, turnId, itemId }
    : null
}

function parseCommandDecision(value: JsonValue): CommandDecision | null {
  const scalar = stringValue(value)
  if (
    scalar === "accept" ||
    scalar === "acceptForSession" ||
    scalar === "decline" ||
    scalar === "cancel"
  )
    return scalar
  const root = objectValue(value)
  if (!root) return null
  const execpolicy = objectValue(root.acceptWithExecpolicyAmendment)
  if (execpolicy) return { acceptWithExecpolicyAmendment: execpolicy }
  const network = objectValue(root.applyNetworkPolicyAmendment)
  return network ? { applyNetworkPolicyAmendment: network } : null
}

function parseQuestion(value: JsonValue): UserInputQuestion | null {
  const root = objectValue(value)
  const id = stringValue(root?.id)
  const header = stringValue(root?.header)
  const question = stringValue(root?.question)
  const isOther = booleanValue(root?.isOther)
  const isSecret = booleanValue(root?.isSecret)
  const options = nullableArray(root?.options, parseQuestionOption)
  return root &&
    id !== undefined &&
    header !== undefined &&
    question !== undefined &&
    isOther !== undefined &&
    isSecret !== undefined &&
    options.valid
    ? { id, header, question, isOther, isSecret, options: options.value }
    : null
}

function parseQuestionOption(
  value: JsonValue
): { label: string; description: string } | null {
  const root = objectValue(value)
  const label = stringValue(root?.label)
  const description = stringValue(root?.description)
  return root && label !== undefined && description !== undefined
    ? { label, description }
    : null
}

type Parsed<T> = { valid: true; value: T } | { valid: false }

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

function optionalNullableArray<T>(
  value: JsonValue | undefined,
  parse: (entry: JsonValue) => T | null
): Parsed<T[] | null | undefined> {
  if (value === undefined || value === null) return { valid: true, value }
  const parsed = parseArray(value, parse)
  return parsed ? { valid: true, value: parsed } : { valid: false }
}

function nullableArray<T>(
  value: JsonValue | undefined,
  parse: (entry: JsonValue) => T | null
): Parsed<T[] | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = parseArray(value, parse)
  return parsed ? { valid: true, value: parsed } : { valid: false }
}

function optionalNullableString(
  value: JsonValue | undefined
): Parsed<string | null | undefined> {
  if (value === undefined || value === null) return { valid: true, value }
  const parsed = stringValue(value)
  return parsed === undefined
    ? { valid: false }
    : { valid: true, value: parsed }
}

function nullableString(value: JsonValue | undefined): Parsed<string | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = stringValue(value)
  return parsed === undefined
    ? { valid: false }
    : { valid: true, value: parsed }
}
