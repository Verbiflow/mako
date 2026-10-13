import type { NativeAgentObservation } from "../contracts/native-agents.js"
import { STARTUP_TOTAL_MS } from "./provider-startup.js"
import { CodexAgentRunsSchema } from "./codex/agent-status.js"
import type { CodexDecoded, CodexEffect } from "./codex/decoder.js"
import { z } from "zod"
import { CodexIdentityResponseSchema, CodexInitializeSchema } from "./codex/native-context.js"
import { CodexGoalClearResultSchema, CodexGoalSetResultSchema } from "./codex/goals.js"
import { isNumber, stringValue, type JsonRpcId } from "../base/json-values.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import {
  parseJsonRpcEnvelope,
  parseObjectResult,
  parseThreadResponse,
  parseTurnResponse,
  parseSteerResponse,
  type JsonRpcEnvelope,
} from "./codex-app-parse.js"
import { deliverDecoded, type DecodedSink } from "../contracts/native-decoding.js"
import { codexReadsBefore } from "./codex/rollout-tail.js"
import type {
  PendingRpc,
  ProtocolContext,
  RpcMethod,
  RpcParams,
  RpcResultParser,
  RpcResults,
} from "./codex-app-types.js"

export { boundedText } from "../base/json-values.js"
export type { JsonRpcId } from "../base/json-values.js"
export type { JsonObject, JsonScalar, JsonValue } from "../contracts/json.js"
export type {
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
const BackgroundTerminalsSchema = z.object({
  data: z.array(z.object({ itemId: z.string(), processId: z.string().min(1), command: z.string().nullish() })).max(4096),
  nextCursor: z.string().nullish(),
})
const LoadedThreadsSchema = z.object({
  data: z.array(z.string()),
  nextCursor: z.string().nullish(),
})
const UnsubscribeSchema = z.object({ status: z.enum(["notLoaded", "notSubscribed", "unsubscribed"]) })

export { CodexDecoder } from "./codex/decoder.js"

/** Never evict an interrupted turn while this transport can still emit its work. */
export function retainStoppedTurn(context: ProtocolContext, turnId: string): void {
  const stopped = context.stoppedTurns ??= new Set<string>()
  if (stopped.has(turnId)) return
  if (stopped.size >= 512) throw new Error("Codex Stop evidence reached its bound; reconnect before continuing")
  stopped.add(turnId)
}

export async function drainStoppedCommands(context: ProtocolContext): Promise<void> {
  while (context.stoppingCommands?.size) await Promise.all(context.stoppingCommands)
}

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
  if (context.sides?.route(message.method, message.params, message.kind === "request" ? message.id : undefined)) return
  if (message.kind === "request") {
    drawRollout(context)
    context.capture?.record({ request: message.method, id: message.id, params: message.params })
    context.protocol.handleServerRequest(
      message.id,
      message.method,
      message.params
    )
    return
  }
  const before = codexReadsBefore(message.method)
  if (before) drawRollout(context)
  context.capture?.record({ method: message.method, params: message.params })
  deliver(context, context.decoder.decode({ method: message.method, params: message.params }))
  if (!before) drawRollout(context)
}

/**
 * What Codex appended to the thread's rollout since the last read, drawn
 * through the one decoder. The driver reads before it handles each
 * notification, since Codex writes an item's record before it notifies, and
 * when the rollout changes between notifications.
 */
export function drawRollout(context: ProtocolContext): void {
  const records = context.rollout?.read()
  if (!records?.length) return
  context.capture?.record({ records })
  deliver(context, context.decoder.records(records.map((read) => read.record)))
}

/** Decoded events to the driver's callbacks, in order. */
function deliver(context: ProtocolContext, events: readonly CodexDecoded[]): void {
  if (events.length) deliverDecoded(events, protocolSink(context))
}

function protocolSink(context: ProtocolContext): DecodedSink<CodexEffect> {
  const protocol = context.protocol
  return {
    updates: (updates) => {
      for (const update of updates) protocol.emitUpdate(update)
    },
    patch: (patch) => protocol.updateState(patch),
    activity: (activity) => protocol.activity?.(activity),
    marker: (marker, source) => protocol.event?.(marker, source),
    compacted: (compaction, source) => protocol.compacted?.(compaction, source),
    usage: (windows) => protocol.usage?.(windows),
    rewound: (run) => protocol.rewound?.(run),
    goal: (goal) => protocol.goal?.(goal),
    unknown: (kind, reason, raw) => protocol.unhandled?.(kind, reason, raw),
    effect: (effect) => applyEffect(context, effect),
  }
}

function applyEffect(context: ProtocolContext, effect: CodexEffect): void {
  switch (effect.type) {
    case "turn-started":
      if (context.compaction && !context.compaction.turnId) context.compaction.turnId = effect.turnId
      context.currentTurnId = effect.turnId
      return
    case "turn-ending":
      context.currentTurnId = null
      context.protocol.clearTurnServerRequests(effect.turnId)
      return
    case "turn-ended": {
      const compaction = context.compaction?.turnId === effect.turnId ? context.compaction : undefined
      if (compaction) context.compaction = undefined
      void listBackground(context)
      if (compaction) context.protocol.actionResult?.(compaction.actionId,
        effect.error || effect.stop !== "completed"
          ? { kind: "failed", reason: effect.error ?? "Compaction was interrupted" }
          : compaction.confirmed
            ? { kind: "completed" }
            : { kind: "uncertain", reason: "The provider ended the turn without confirming compaction." })
      return
    }
    case "compaction-item":
      if (context.compaction?.turnId === effect.turnId) context.compaction.confirmed = true
      return
    case "server-request-resolved":
      context.protocol.resolveServerRequest(effect.requestId)
      return
    case "subagent-turn":
      context.protocol.observeAgentTurn?.(effect.threadId)
      if (effect.completed)
        for (const settle of context.subagentTurns?.get(effect.threadId) ?? []) settle()
      return
    case "agents":
      context.protocol.observeAgents(effect.item, effect.replay, effect.toolId)
      return
    case "question":
      context.protocol.observeQuestion?.(effect.question)
      return
    case "question-answer":
      context.protocol.observeQuestionAnswer?.(effect.answer)
      return
    case "command-started":
      if (context.stoppedTurns?.has(effect.turnId)) {
        if (!effect.processId || !context.threadId) {
          context.protocol.handleFatal("Codex started a command after Stop without a native terminal identity")
          return
        }
        const key = `${effect.threadId}\u0000${effect.turnId}\u0000${effect.processId}`
        const commands = context.stoppedCommands ??= new Set<string>()
        if (commands.has(key)) return
        if (commands.size >= 4096) {
          context.protocol.handleFatal("Codex late Stop evidence reached its bound; reconnect before continuing")
          return
        }
        commands.add(key)
        const rootCommand = effect.threadId === context.threadId
        if (rootCommand) {
          context.background.running.add(effect.itemId)
          reportBackground(context)
        }
        const stopping = context.stoppingCommands ??= new Set<Promise<void>>()
        const operation = terminateTerminal(context, effect.threadId, effect.processId, true).then(() => {
          if (rootCommand) backgroundEnded(context, effect.itemId)
        }, error => {
          context.protocol.handleFatal(`A command arriving after Stop was not ended: ${String(error)}`)
          throw error
        })
        stopping.add(operation)
        // The event callback cannot await. Retain the operation for lifecycle
        // callers and handle its rejection even if nobody is closing yet.
        void operation.then(() => stopping.delete(operation), () => stopping.delete(operation))
      }
      return
    case "command-ended":
      backgroundEnded(context, effect.itemId)
      return
  }
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

/** Terminate exact native terminal IDs. `clean` acknowledges submission only. */
export async function cleanBackground(context: ProtocolContext, threadId = context.threadId): Promise<void> {
  if (!threadId) return
  const terminals = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await rpcRequest(context, "thread/backgroundTerminals/list", { threadId, cursor })
    if (terminals.length + page.data.length > 4096) throw new Error("Codex terminal inventory exceeds its bound")
    terminals.push(...page.data)
    cursor = page.nextCursor ?? undefined
    if (cursor && (seen.size >= 128 || seen.has(cursor))) throw new Error("Codex terminal inventory repeated a cursor")
    if (cursor) seen.add(cursor)
  } while (cursor)
  for (const terminal of terminals) {
    await terminateTerminal(context, threadId, terminal.processId)
  }
  if (threadId === context.threadId) await listBackground(context)
}

async function terminateTerminal(context: ProtocolContext, threadId: string, processId: string, requireConfirmation = false): Promise<void> {
  const result = await rpcRequest(context, "thread/backgroundTerminals/terminate", { threadId, processId })
  if (!result.terminated) {
    if (requireConfirmation) throw new Error("Codex refused termination of a late native command")
    // An ordinary listed command can exit between list and terminate. An
    // absent terminal is native evidence; failed/malformed replies are not.
    const remaining = await rpcRequest(context, "thread/backgroundTerminals/list", { threadId })
    if (remaining.nextCursor || remaining.data.some(item => item.processId === processId))
      throw new Error("Codex did not confirm terminal termination")
  }
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
      retainStoppedTurn(context, turn.id)
      await cleanBackground(context, threadId)
      await rpcRequest(context, "turn/interrupt", { threadId, turnId: turn.id })
      await settled
    }
  } finally {
    const rest = waiters.get(threadId)?.filter((waiter) => waiter !== settle) ?? []
    if (rest.length) waiters.set(threadId, rest)
    else waiters.delete(threadId)
    await cleanBackground(context, threadId)
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
  const listed = new Map<string, { processId: string; command?: string }>()
  try {
    let cursor: string | undefined
    do {
      const page = await rpcRequest(context, "thread/backgroundTerminals/list", { threadId, cursor })
      for (const terminal of page.data) {
        running.add(terminal.itemId)
        listed.set(terminal.itemId, { processId: terminal.processId, ...(terminal.command && { command: terminal.command }) })
      }
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
  nameBackground(context, listed)
  reportBackground(context)
}

/**
 * Each terminal outliving its turn as a roster entry, named by the list's
 * own `command` (Codex 0.159), once; a terminal the list no longer holds
 * ended with its command's item.
 */
function nameBackground(context: ProtocolContext, listed: Map<string, { processId: string; command?: string }>): void {
  const named = context.background.named ??= new Map()
  const items: NativeAgentObservation[] = []
  for (const itemId of context.background.running) {
    const terminal = listed.get(itemId)
    if (!terminal || named.has(itemId)) continue
    named.set(itemId, terminal)
    items.push(terminalEntry(itemId, terminal, { kind: "working" }))
  }
  if (items.length) context.protocol.observeBackground?.(items)
}

function terminalEntry(itemId: string, terminal: { command?: string }, state: NativeAgentObservation["state"]): NativeAgentObservation {
  const command = terminal.command ? codexShellCommand(terminal.command) : undefined
  return {
    nativeId: itemId,
    title: (command ?? "Background terminal").slice(0, 512),
    work: "command",
    ...(command && { detail: command.slice(0, 8192) }),
    background: true,
    stoppable: state.kind === "working",
    source: "codex thread/backgroundTerminals/list",
    state,
  }
}

/** `/bin/zsh -lc 'npm run dev'` reads as the command it runs. */
function codexShellCommand(command: string): string {
  const wrapped = /^\S*\/(?:ba|z)?sh -lc '([\s\S]*)'$/.exec(command)
  return wrapped?.[1]?.replaceAll("'\\''", "'") ?? command
}

function backgroundEnded(context: ProtocolContext, itemId: string): void {
  context.background.raced?.add(itemId)
  const terminal = context.background.named?.get(itemId)
  if (terminal) {
    context.background.named?.delete(itemId)
    context.protocol.observeBackground?.([terminalEntry(itemId, terminal, { kind: "completed" })])
  }
  if (context.background.running.delete(itemId)) reportBackground(context)
}

/** Ends one background terminal of the thread, leaving the rest running. */
export async function stopBackgroundTerminal(context: ProtocolContext, itemId: string): Promise<void> {
  const terminal = context.background.named?.get(itemId)
  if (!terminal || !context.threadId) throw new Error("That terminal is no longer running")
  await terminateTerminal(context, context.threadId, terminal.processId)
}

function reportBackground(context: ProtocolContext): void {
  const count = context.background.running.size
  if ((context.state.backgroundTasks ?? 0) !== count)
    context.protocol.updateState({ backgroundTasks: count })
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
    case "account/read":
      return beginRpcRequest(context, method, params, value => {
        const parsed = CodexIdentityResponseSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid native identity response" }
      })
    case "thread/turns/list":
      return beginRpcRequest(context, method, params, (value) => {
        const parsed = CodexAgentRunsSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid child turn status response" }
      })
    case "initialize":
      return beginRpcRequest(context, method, params, value => {
        const parsed = CodexInitializeSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid native initialization response" }
      })
    case "thread/start":
      return beginRpcRequest(context, method, params, parseThreadResponse)
    case "thread/fork":
    case "thread/resume":
      // The catalog/base already supplies paged native history. Reopening must
      // not hydrate it again as one unbounded JSON-RPC frame. This only omits
      // response turns; Codex still restores its full native model context.
      return beginRpcRequest(context, method, { ...params, excludeTurns: true }, parseThreadResponse)
    case "turn/start":
    case "review/start":
      return beginRpcRequest(context, method, params, parseTurnResponse)
    case "turn/steer":
      return beginRpcRequest(context, method, params, parseSteerResponse)
    case "thread/compact/start":
    case "turn/interrupt":
    case "thread/backgroundTerminals/clean":
      return beginRpcRequest(context, method, params, parseObjectResult)
    case "thread/backgroundTerminals/terminate":
      return beginRpcRequest(context, method, params, value => {
        const parsed = z.object({ terminated: z.boolean() }).safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid terminal termination response" }
      })
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
    case "thread/goal/set":
      return beginRpcRequest(context, method, params, (value) => {
        const parsed = CodexGoalSetResultSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid goal response" }
      })
    case "thread/goal/clear":
      return beginRpcRequest(context, method, params, (value) => {
        const parsed = CodexGoalClearResultSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid goal clear response" }
      })
    case "config/read":
    case "thread/inject_items":
      return beginRpcRequest(context, method, params, parseObjectResult)
    case "thread/unsubscribe":
      return beginRpcRequest(context, method, params, (value) => {
        const parsed = UnsubscribeSchema.safeParse(value)
        return parsed.success ? { valid: true, value: parsed.data }
          : { valid: false, message: "Invalid unsubscribe response" }
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
    // A turn/start or review/start the app-server has not answered may
    // already be running its turn; a deadline would call that turn failed and
    // send the next prompt into it. The app-server answers or exits, and its
    // exit rejects.
    const timer = method === "turn/start" || method === "review/start" ? undefined : setTimeout(() => {
      context.pending.delete(rpcKey(id))
      reject(new Error(`Codex app-server did not answer ${method}`))
    }, method === "account/read" ? 5_000 : ["initialize", "thread/start", "thread/resume", "thread/fork"].includes(method)
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
  const sent = sendRpc(context, { jsonrpc: "2.0", id, result })
  context.capture?.record({ answered: id, result })
  return sent
}

export function sendRpcError(
  context: ProtocolContext,
  id: JsonRpcId,
  code: number,
  message: string
): void {
  sendRpc(context, { jsonrpc: "2.0", id, error: { code, message } })
}

function rpcKey(id: JsonRpcId): string {
  return `${isNumber(id) ? "number" : "string"}:${id}`
}
