import { randomBytes, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import type { OpenCodeEvent } from "@opencode/client"
import type { SessionSettings } from "@mako/sessions/settings"
import { isOpenCodeInstruction, openCodeNoticeLabel, PROVIDER_TURN_FALLBACK } from "@mako/sessions"
import { compactionFailedEvent, type TranscriptEvent } from "@mako/sessions/events"
import { z } from "zod"
import { applyControlEnvironment } from "../../control-launch.js"
import { launchContext, reportedRuntime } from "../../execution-context.js"
import { NO_NATIVE_EXCLUSION } from "../../contracts/execution-context.js"
import { openCodeRecordLocator } from "./resume-store.js"
import { applyThreadEnvironment } from "../../thread-environment.js"
import { hostLog, hostWarn } from "../../host-log.js"
import { traceProviderLaunch } from "../../provider-launch.js"
import { accessModeId, type AccessTier } from "../../contracts/access.js"
import { OPENCODE_PLAN_AGENT } from "@mako/sessions"
import type { LiveActionResult } from "../../contracts/live-actions.js"
import type { LiveSessionState, McpRegistrySnapshot, PromptAttachment } from "../../shared.js"
import { createLiveEngine, type LiveEngineApi } from "../../live-engine.js"
import { deliverDecoded, type Decoded, type DecodedSink } from "../../contracts/native-decoding.js"
import { nativeCapture, type NativeCapture } from "../../native-capture.js"
import { errorMessage } from "../../live-runtime.js"
import { preparePrompt, preparePromptAsync, type PromptDispatch } from "../prompt-dispatch.js"
import { SHUTDOWN_GRACE_MS, conversationServers, type ProviderLiveDriver, type ProviderStartOptions } from "../live-driver.js"
import { startOpenCodeApi } from "./native-api.js"
import { resolveOpenCodeInstallation, openCodeExecutable, locateOpenCodeSession, verifyOpenCodeSession } from "./installation.js"
import { configureOpenCodePermissions } from "./permissions.js"
import {
  OPENCODE_DEFAULT_MODE,
  openCodeAgentForMode,
  openCodeLaunchAccess,
  openCodeModeForAgent,
  openCodeModes,
  openCodeSessionModes,
} from "./access.js"
import {
  loadOpenCodeCatalog,
  openCodeLaunchId,
  openCodeReportedSettings,
  openCodeRequestedModel,
  sameOpenCodeModel,
  type OpenCodeCatalog,
  type OpenCodeModelRef,
} from "./catalog.js"
import { OpenCodeDecoder, openCodeCatalogChange, type OpenCodeEffect } from "./decoder.js"
import { OpenCodeInteractions, openCodeApprovalDigest } from "./interactions.js"
import { OpenCodeAgents } from "./agents.js"
import { OpenCodeMcpHealth, openCodeStopped } from "./notices.js"
import { openCodeCheckpoint, inspectOpenCodeSession } from "./resume.js"

type Api = Awaited<ReturnType<typeof startOpenCodeApi>>

const OPENCODE_NATIVE_IDENTITY = {
  kind: "unavailable",
  reason: "The native API reports provider configuration, not the effective identity for each selected model backend.",
} as const

type NoticePayload = Extract<Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>["data"]["item"], { type: "synthetic" }>["payload"]

/** A notice's metadata: what ended (a shell, or a subagent's session), and how. */
const NoticeMetadata = z.object({
  source: z.string().optional(),
  state: z.string().optional(),
  shellID: z.string().optional(),
  childID: z.string().optional(),
})

/**
 * One native send and the execution it starts. The inbox ID binds both. A
 * `provider` turn is an execution OpenCode started itself, on a notice.
 */
interface Turn {
  kind: "prompt" | "command" | "compaction" | "provider"
  /** Client-chosen for prompts and compaction; a command's is learned from its enqueue echo. */
  inboxId?: string
  enqueued: boolean
  delivered: boolean
  dispatch?: PromptDispatch
  actionId?: string
  /** Mako asked OpenCode to stop it; any other interrupt came from outside. */
  stopRequested?: true
}

interface Live {
  state: LiveSessionState
  emit: NonNullable<ProviderStartOptions["emit"]>
  api: Api
  cwd: string
  /** The launch environment, which says where OpenCode keeps its state. */
  env: NodeJS.ProcessEnv
  root?: string
  /** What the stream says, from the moment the root session exists. */
  decoder?: OpenCodeDecoder
  sink?: DecodedSink<OpenCodeEffect>
  capture: NativeCapture | null
  catalog?: OpenCodeCatalog
  /** Bumped by each native catalog change; a load answers for the generation it started at. */
  catalogGeneration: number
  catalogRefresh?: Promise<void>
  model?: OpenCodeModelRef
  launchAccess: AccessTier
  interactions?: OpenCodeInteractions
  agents?: OpenCodeAgents
  turn: Turn | null
  /** Waiting for the running turn to settle, or for the session to end. */
  settling: Array<() => void>
  /** Waiting for a subagent session's execution to settle, by its session. */
  childSettling: Map<string, Array<() => void>>
  /** The latest notice OpenCode enqueued while no turn ran: the cause of the turn it starts on it. */
  providerTurnCause?: string
  /** Shells and subagent sessions Stop ended. OpenCode notifies the root of each end. */
  stopped: Set<string>
  /** Those notices, by inbox item. A turn OpenCode starts on one is stopped too. */
  stopNotices: Set<string>
  mcp: OpenCodeMcpHealth
  /** MCP status reads, in order, so an older read never reports over a newer one. */
  mcpReads: Promise<void>
  /** Native events are applied in order; interaction bookkeeping awaits its store. */
  queue: Promise<void>
  /** Pending while a missed call's native name is read; content waits behind it. */
  projection?: Promise<void>
  stream: AbortController
  closed: boolean
}

type Engine = LiveEngineApi<Live>
type ConnectedLive = Live & { root: string; catalog: OpenCodeCatalog; model: OpenCodeModelRef; interactions: OpenCodeInteractions }

export interface OpenCodeDriverDependencies {
  env(): Promise<NodeJS.ProcessEnv>
  approvalRoot(): Promise<string>
  /** Transport fault injection at the SDK boundary. */
  fetch?: typeof globalThis.fetch
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastIdTime = 0
let idCounter = 0

/** OpenCode's ascending identifier: a 48-bit time and counter, then 14 random base62 characters. */
/** What opens a turn ahead of its user message: mode and model switches and the reminders OpenCode adds. */
const TURN_PREAMBLE = new Set(["agent-switched", "model-switched", "location-switched", "synthetic", "system"])

/**
 * Where a fork after the turn `runId` opened ends: before whatever opened
 * the next turn, or through the whole session when that turn was the last.
 * `runId` is the turn's user message, whose ID Mako gives OpenCode.
 */
export function openCodeForkBoundary(messages: ReadonlyArray<{ id: string; type: string }>, runId: string):
  { type: "before"; messageID: string } | { type: "through" } {
  const turn = messages.findIndex(message => message.type === "user" && message.id === runId)
  if (turn < 0) throw new Error("The answer to fork from is not in OpenCode's session")
  const next = messages.findIndex((message, index) => index > turn && message.type === "user")
  if (next < 0) return { type: "through" }
  let start = next
  while (start - 1 > turn && TURN_PREAMBLE.has(messages[start - 1]!.type)) start--
  return { type: "before", messageID: messages[start]!.id }
}

/** A page of `message.list`, as far as reading a whole session uses it. */
type MessagePage = (input: { sessionID: string; order?: "asc"; limit: number; cursor?: string }) =>
  Promise<{ data: ReadonlyArray<{ id: string; type: string }>; cursor: { next?: string | null } }>

export async function openCodeSessionMessages(list: MessagePage, sessionID: string): Promise<Array<{ id: string; type: string }>> {
  const limit = 200
  const messages: Array<{ id: string; type: string }> = []
  // OpenCode 2.0.1 names a next page even after the last one, and refuses a cursor sent with `order`.
  let page = await list({ sessionID, order: "asc", limit })
  for (;;) {
    for (const message of page.data) messages.push({ id: message.id, type: message.type })
    const cursor = page.cursor.next
    if (page.data.length < limit || !cursor) return messages
    page = await list({ sessionID, limit, cursor })
  }
}

export function openCodeMessageId(now = Date.now()): string {
  if (now !== lastIdTime) { lastIdTime = now; idCounter = 0 }
  const value = (BigInt(now) * 0x1000n + BigInt(++idCounter)) & 0xffffffffffffn
  const random = [...randomBytes(14)].map(byte => ALPHABET[byte % 62]).join("")
  return `msg_${value.toString(16).padStart(12, "0")}${random}`
}

export function promptFiles(attachments: readonly PromptAttachment[]): Array<{ uri: string; name?: string }> {
  return attachments.flatMap(attachment => {
    if (attachment.data && attachment.mimeType.startsWith("image/"))
      return [{ uri: `data:${attachment.mimeType};base64,${attachment.data}`, name: attachment.name }]
    if (attachment.path) return [{ uri: pathToFileURL(attachment.path).href, name: attachment.name }]
    return []
  })
}

/** `/name rest` for a native command or slash skill; anything else is prose. */
function slashInvocation(text: string, catalog: OpenCodeCatalog): { kind: "command" | "skill"; name: string; rest: string } | null {
  const match = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const [, name, rest = ""] = match
  if (catalog.skills.has(name)) return { kind: "skill", name, rest }
  if (catalog.commands.some(command => command.name === name) && name !== "compact") return { kind: "command", name, rest }
  return null
}

async function mcpServers(options: ProviderStartOptions): Promise<Array<{ name: string; config: Parameters<Api["client"]["mcp"]["add"]>[0]["config"] }>> {
  const servers: Array<{ name: string; config: Parameters<Api["client"]["mcp"]["add"]>[0]["config"] }> = []
  if (options.mcpSnapshot) {
    const snapshot: McpRegistrySnapshot = await options.mcpSnapshot()
    // `mcp-runtime` reaches the whole provider registry, which installs this driver.
    const { acpMcpServers } = await import("../../mcp-runtime.js")
    for (const server of acpMcpServers(snapshot, "opencode", ["stdio", "http", "sse"])) {
      if ("command" in server)
        servers.push({ name: server.name, config: { type: "local", command: [server.command, ...server.args],
          environment: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) } })
      else if (server.type === "http" || server.type === "sse")
        servers.push({ name: server.name, config: { type: "remote", url: server.url, oauth: false,
          headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) } })
    }
  }
  const tools = options.conversationTools
  if (tools)
    for (const { name, url } of conversationServers(tools))
      servers.push({ name, config: { type: "remote", url, headers: { Authorization: `Bearer ${tools.token}` }, oauth: false } })
  return servers
}

const errorText = errorMessage

/**
 * OpenCode v2 through its native API. One `opencode serve --stdio` per
 * conversation; stdin is its ownership lease. OpenCode owns execution,
 * permissions, questions and its store. The driver keeps the turn bound to
 * the inbox item it sent, and projects the event stream into the live contract.
 */
export function createOpenCodeDriver(dependencies: OpenCodeDriverDependencies): ProviderLiveDriver {
  const engine: Engine = createLiveEngine<Live>()
  const sessions = engine.sessions
  // A start not yet a session: Close cancels it here, including the API launch.
  const starting = new Map<string, AbortController>()
  function cancellable<T>(id: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const startup = new AbortController()
    starting.set(id, startup)
    return run(startup.signal).finally(() => { if (starting.get(id) === startup) starting.delete(id) })
  }

  function connected(live: Live | undefined): live is ConnectedLive {
    return !!live && !live.closed && !!live.root && !!live.catalog && !!live.model && !!live.interactions
  }

  function requireLive(id: string): ConnectedLive {
    const live = sessions.get(id)
    if (!connected(live)) throw new Error("This OpenCode session is disconnected")
    return live
  }

  const owns = (live: Live, sessionID: string) => live.decoder?.owns(sessionID) ?? false

  /** Effects act on the native event they were decoded from. */
  function deliver(live: Live, decoded: readonly Decoded<OpenCodeEffect>[], event?: OpenCodeEvent): void {
    if (!decoded.length) return
    live.sink ??= engine.sink(live, { effect: () => {} })
    deliverDecoded(decoded, event ? { ...live.sink, effect: effect => act(live, effect, event) } : live.sink)
  }

  function usage(live: Live) {
    if (live.decoder) deliver(live, live.decoder.usage())
  }

  /** Load until no native catalog change arrived during the load. */
  async function loadCatalog(live: Live): Promise<OpenCodeCatalog> {
    for (;;) {
      const generation = live.catalogGeneration
      const catalog = await loadOpenCodeCatalog(live.api.client, live.cwd, live.api.signal, live.env)
      if (generation === live.catalogGeneration || live.closed) return live.catalog = catalog
    }
  }

  /** OpenCode refreshes models, agents, commands and skills after startup and on configuration changes. */
  function refreshCatalog(live: Live): void {
    if (live.catalogRefresh || !live.root || live.closed) return
    live.catalogRefresh = loadCatalog(live).then(catalog => {
      if (live.closed || !live.model) return
      const modes = openCodeSessionModes(catalog.agents)
      engine.patch(live, { commands: catalog.commands, modes, ...openCodeReportedSettings(catalog, live.model) })
      usage(live)
    }).catch(error => {
      if (!live.closed) hostWarn("opencode", "the refreshed catalog could not be read", { conversation: live.state.id, error: errorText({ error }) })
    }).finally(() => { live.catalogRefresh = undefined })
  }

  function selectModel(live: Live, ref: OpenCodeModelRef) {
    live.model = ref
    if (!live.catalog) return
    engine.patch(live, openCodeReportedSettings(live.catalog, ref))
    usage(live)
  }

  function finish(live: Live, outcome: { kind: "succeeded" } | { kind: "failed"; message: string; type?: string; exited?: true } | { kind: "interrupted"; reason: string }) {
    const turn = live.turn
    if (!turn) return
    live.turn = null
    if (live.decoder && outcome.kind !== "succeeded")
      engine.emitUpdates(live, live.decoder.content.settle(live.decoder.root, outcome.kind === "failed" ? "failed" : "cancelled",
        outcome.kind === "failed" ? `OpenCode ended the turn before this call finished: ${outcome.message}` : "Stopped before this call finished."))
    if (turn.kind === "compaction" && turn.actionId) {
      const result: LiveActionResult = outcome.kind === "succeeded" ? { kind: "completed" }
        : { kind: "failed", reason: outcome.kind === "failed" ? outcome.message : `Compaction was interrupted (${outcome.reason})` }
      live.emit({ type: "live-action-result", id: live.state.id, actionId: turn.actionId, result })
    }
    if (outcome.kind === "succeeded") engine.patch(live, { status: "ready", lastStop: turn.kind === "compaction" ? "completed" : "end_turn", error: undefined })
    else if (outcome.kind === "interrupted") engine.patch(live, { status: "ready", lastStop: "cancelled", error: undefined })
    else {
      hostWarn("opencode", "turn failed", { conversation: live.state.id, type: outcome.type ?? "", error: outcome.message })
      const failure: Partial<LiveSessionState> = { status: "failed", lastStop: outcome.type === "aborted" ? "cancelled" : "failed", error: outcome.message.slice(0, 2000) }
      // The host tells a process that died under the turn from a turn that
      // failed by both arriving in one update.
      if (outcome.exited) failure.connection = "disconnected"
      engine.patch(live, failure)
    }
    for (const settle of live.settling.splice(0)) settle()
  }

  /** End every shell the conversation's sessions left running. */
  async function endShells(live: Live): Promise<void> {
    const location = { directory: live.cwd }
    const listed = await live.api.client.shell.list({ location })
    await Promise.all((live.decoder?.shells.ending(listed.data) ?? []).map(shell => {
      live.stopped.add(shell.id)
      return live.api.client.shell.remove({ id: shell.id, location })
    }))
  }

  /** Interrupt every subagent session still executing, and wait for each to settle. */
  async function interruptChildren(live: Live): Promise<void> {
    await Promise.all([...live.decoder?.children ?? []].map(async sessionID => {
      let settle = () => {}
      const settled = new Promise<void>(resolve => { settle = resolve })
      live.childSettling.set(sessionID, [...(live.childSettling.get(sessionID) ?? []), settle])
      live.stopped.add(sessionID)
      try {
        if ((await live.api.client.session.interrupt({ sessionID })).interrupted) await settled
      } finally {
        const rest = live.childSettling.get(sessionID)?.filter(waiter => waiter !== settle) ?? []
        if (rest.length) live.childSettling.set(sessionID, rest)
        else live.childSettling.delete(sessionID)
      }
    }))
  }

  /**
   * Subagents first. Checked on opencode 2.0.1: a background subagent keeps
   * executing after its parent's turn and its interrupt, and one whose shell
   * is removed runs the command again in a new shell.
   */
  async function endBackground(live: Live): Promise<void> {
    try {
      await interruptChildren(live)
    } finally {
      await endShells(live)
    }
  }

  /** Shells outlive the server, so they end before it closes, while it can still reach them. */
  async function endBackgroundWithinGrace(live: Live): Promise<void> {
    await Promise.race([endBackground(live).catch(() => {}), delay(SHUTDOWN_GRACE_MS, undefined, { ref: false })])
  }

  function observeNotice(live: Live, inboxID: string, notice: NoticePayload): void {
    const parsed = NoticeMetadata.safeParse(notice.metadata ?? {})
    const metadata = parsed.success ? parsed.data : {}
    const ended = metadata.shellID ?? metadata.childID
    if (ended && live.stopped.delete(ended)) live.stopNotices.add(inboxID)
    const read = { text: notice.text, description: notice.description, source: metadata.source, state: metadata.state }
    if (!live.turn && !isOpenCodeInstruction(read)) live.providerTurnCause = openCodeNoticeLabel(read)
  }

  function mark(live: Live, markers: readonly TranscriptEvent[]): void {
    for (const marker of markers) engine.event(live, marker)
  }

  /** OpenCode's status event names a server; its state is read back once the session is up. */
  function readMcp(live: Live): void {
    live.mcpReads = live.mcpReads.then(async () => {
      if (live.closed || live.state.connection !== "connected") return
      const listed = await live.api.client.mcp.list({ location: { directory: live.cwd } })
      if (!live.closed) mark(live, live.mcp.observe(listed.data))
    }).catch(error => {
      if (!live.closed) hostWarn("opencode", "MCP server status could not be read", { conversation: live.state.id, error: errorText({ error }) })
    })
  }

  /** Mako sends every other turn, so an execution starting while none is bound is one OpenCode started on a notice. */
  function openProviderTurn(live: Live): void {
    live.turn = { kind: "provider", enqueued: true, delivered: true }
    engine.patch(live, { status: "running", nativeRunId: undefined, lastStop: undefined, error: undefined })
    engine.emitUpdate(live, { kind: "provider-turn", reason: live.providerTurnCause ?? PROVIDER_TURN_FALLBACK })
    live.providerTurnCause = undefined
  }

  /** What the driver does with what its decoder read; `event` is the native event it came from. */
  function act(live: Live, effect: OpenCodeEffect, event: OpenCodeEvent): void {
    switch (effect.type) {
      case "turn":
        bindTurn(live, event)
        return
      case "request":
        if (event.type === "form.created" || event.type === "form.replied" || event.type === "form.cancelled" || event.type === "permission.asked" || event.type === "permission.replied")
          live.queue = live.queue.then(() => live.interactions?.observe(event)).catch(error =>
            hostWarn("opencode", "a native request could not be shown", { conversation: live.state.id, error: errorText({ error }) }))
        return
      case "catalog":
        live.catalogGeneration++
        refreshCatalog(live)
        return
      case "mcp":
        readMcp(live)
        return
      case "model":
        selectModel(live, effect.model)
        return
      case "agent-call":
        live.agents?.observe(effect.call)
        return
    }
  }

  /** Inbox receipts and execution ends, bound to the turn Mako sent or one OpenCode started. */
  function bindTurn(live: Live, event: OpenCodeEvent): void {
    const root = live.root
    if (!root) return
    switch (event.type) {
      case "session.inbox.enqueued": {
        if (event.data.sessionID !== root) return
        if (event.data.item.type === "synthetic") observeNotice(live, event.data.inboxID, event.data.item.payload)
        const turn = live.turn
        if (!turn) return
        if (turn.kind === "command" && !turn.inboxId && event.data.item.type === "user") turn.inboxId = event.data.inboxID
        if (turn.inboxId !== event.data.inboxID || turn.enqueued) return
        turn.enqueued = true
        turn.dispatch?.report({ kind: "accepted", source: "native-echo", referenceId: event.data.inboxID })
        if (turn.kind !== "compaction") engine.patch(live, { nativeRunId: event.data.inboxID })
        return
      }
      case "session.inbox.delivered":
        if (event.data.sessionID !== root) return
        if (live.turn?.inboxId === event.data.inboxID) live.turn.delivered = true
        if (live.stopNotices.delete(event.data.inboxID) && live.turn?.kind === "provider") {
          live.turn.stopRequested = true
          live.api.client.session.interrupt({ sessionID: root }).catch(error =>
            hostWarn("opencode", "The turn started on a stopped task's notice was not interrupted", { conversation: live.state.id, error: errorText({ error }) }))
        }
        return
      case "session.execution.started":
        if (event.data.sessionID === root && !live.turn && (live.state.status === "ready" || live.state.status === "failed"))
          openProviderTurn(live)
        return
      case "session.inbox.cancelled":
        if (event.data.sessionID === root && live.turn?.inboxId === event.data.inboxID && !live.turn.delivered)
          finish(live, { kind: "interrupted", reason: "cancelled before delivery" })
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const sessionID = event.data.sessionID
        if (sessionID !== root) {
          for (const settle of live.childSettling.get(sessionID) ?? []) settle()
          return
        }
        const stopped = event.type === "session.execution.interrupted"
          ? openCodeStopped(event.data.reason, live.turn?.stopRequested === true)
          : undefined
        if (stopped) {
          engine.event(live, stopped, event.id)
          hostWarn("opencode", "turn interrupted", { conversation: live.state.id, reason: event.type === "session.execution.interrupted" ? event.data.reason : "", detail: stopped.detail ?? "" })
        }
        if (!live.turn?.delivered) return
        if (event.type === "session.execution.succeeded") finish(live, { kind: "succeeded" })
        else if (event.type === "session.execution.failed") finish(live, { kind: "failed", message: event.data.error.message, type: event.data.error.type })
        else finish(live, { kind: "interrupted", reason: event.data.reason })
        return
      }
      case "session.compaction.failed":
        if (event.data.sessionID !== root) return
        // Compaction Mako asked for fails its action and turn; any other would leave no trace.
        if (live.turn?.kind === "compaction" && (!event.data.inputID || event.data.inputID === live.turn.inboxId))
          finish(live, { kind: "failed", message: event.data.error.message, type: event.data.error.type })
        else engine.event(live, compactionFailedEvent(event.data.error.message), event.id)
        return
      default:
        return
    }
  }

  function receive(live: Live, event: OpenCodeEvent): void {
    if (live.closed) return
    const decoder = live.decoder
    if (!decoder) {
      // Before the session exists, a catalog change only restarts the load in progress.
      if (openCodeCatalogChange(event, live.cwd)) live.catalogGeneration++
      return
    }
    if (live.capture) live.capture.record(JSON.parse(JSON.stringify(event)))
    if (event.type === "session.retry.scheduled" && event.data.sessionID === decoder.root)
      hostLog("opencode", "provider retry scheduled", { conversation: live.state.id, attempt: event.data.attempt, error: event.data.error.message })
    if (!decoder.transcript(event) || (!live.projection && !unnamedCall(live, event))) {
      deliver(live, decoder.decode(event), event)
      return
    }
    // Later content waits behind a native name lookup so rows keep their order.
    const projection: Promise<void> = (live.projection ?? Promise.resolve()).then(async () => {
      if (live.closed) return
      if (unnamedCall(live, event)) {
        const name = await nativeToolName(live, event)
        if (name && !live.closed) engine.emitUpdates(live, decoder.content.open(event.data.sessionID, event.data.id, name))
      }
      if (!live.closed) deliver(live, decoder.decode(event), event)
    }).catch(error => hostWarn("opencode", "a native event could not be applied", { conversation: live.state.id, type: event.type, error: errorText({ error }) }))
      .finally(() => { if (live.projection === projection) live.projection = undefined })
    live.projection = projection
  }

  type ToolCallEvent = Extract<OpenCodeEvent, { type: "session.tool.called" | "session.tool.success" | "session.tool.failed" }>

  /** A call seen first after its start: a resubscribed stream missed the event that names it. */
  function unnamedCall(live: Live, event: OpenCodeEvent): event is ToolCallEvent {
    return (event.type === "session.tool.called" || event.type === "session.tool.success" || event.type === "session.tool.failed")
      && live.decoder?.content.name(event.data.sessionID, event.data.id) === undefined
  }

  async function nativeToolName(live: Live, event: ToolCallEvent): Promise<string | undefined> {
    try {
      const message = await live.api.client.session.message({ sessionID: event.data.sessionID, messageID: event.data.assistantMessageID })
      if (message.type !== "assistant") return undefined
      for (const part of message.content) if (part.type === "tool" && part.id === event.data.id) return part.name
      return undefined
    } catch (error) {
      hostWarn("opencode", "a resumed tool call's name could not be read", { conversation: live.state.id, error: errorText({ error }) })
      return undefined
    }
  }

  /** After a gap, native state says what the missed events would have: open requests and whether the turn ended. */
  async function reconcile(live: Live): Promise<void> {
    const root = live.root
    const decoder = live.decoder
    if (!root || !decoder || !live.interactions) return
    for (const sessionID of [root, ...decoder.children]) await live.interactions.reconcile(sessionID)
    const background = decoder.shells.reconcile((await live.api.client.shell.list({ location: { directory: live.cwd } })).data)
    if (background !== undefined) engine.patch(live, { backgroundTasks: background })
    const turn = live.turn
    const active = await live.api.client.session.active()
    // Busy with nothing bound: the start was among the missed events.
    if (!turn) {
      if (active[root] && !live.turn && !live.closed) openProviderTurn(live)
      return
    }
    if (active[root] || live.turn !== turn) return
    const session = await live.api.client.session.get({ sessionID: root })
    if (live.turn !== turn) return
    if (!turn.enqueued) {
      const inbox = await live.api.client.session.inbox.list({ sessionID: root })
      if (inbox.some(item => item.id === turn.inboxId)) return
    }
    turn.delivered = true
    if (session.outcome === "failed") finish(live, { kind: "failed", message: "OpenCode reported the turn failed while Mako was reconnecting" })
    else if (session.outcome === "interrupted") finish(live, { kind: "interrupted", reason: "reconnect" })
    else finish(live, { kind: "succeeded" })
  }

  /** Whether a send whose response was lost reached the session: its inbox item, or an execution only this owner could start. */
  async function admitted(live: Live, turn: Turn): Promise<boolean> {
    if (!live.root || live.closed) return false
    try {
      const [inbox, active] = await Promise.all([
        live.api.client.session.inbox.list({ sessionID: live.root }),
        live.api.client.session.active(),
      ])
      if (live.turn !== turn) return true
      if (turn.enqueued || (turn.inboxId && inbox.some(item => item.id === turn.inboxId)) || active[live.root]) {
        turn.enqueued = true
        turn.delivered ||= Boolean(active[live.root])
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /** The event stream is subscribed before the session exists; OpenCode does not replay it. */
  function follow(live: Live, connected: () => void): void {
    const run = async () => {
      let attempts = 0
      let first = true
      while (!live.closed && !live.api.signal.aborted) {
        const stream = new AbortController()
        live.stream = stream
        try {
          const iterator = live.api.client.event.subscribe({ signal: AbortSignal.any([stream.signal, live.api.signal]) })[Symbol.asyncIterator]()
          const hello = await iterator.next()
          if (hello.done || hello.value.type !== "server.connected") throw new Error("OpenCode's event stream did not open")
          attempts = 0
          if (first) { first = false; connected() }
          else live.queue = live.queue.then(() => reconcile(live)).catch(error =>
            hostWarn("opencode", "reconnect reconciliation failed", { conversation: live.state.id, error: errorText({ error }) }))
          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            try { receive(live, next.value) } catch (error) {
              hostWarn("opencode", "a native event could not be applied", { conversation: live.state.id, type: next.value.type, error: errorText({ error }) })
            }
          }
        } catch (error) {
          if (live.closed || live.api.signal.aborted) return
          hostWarn("opencode", "event stream ended", { conversation: live.state.id, error: errorText({ error }) })
        }
        if (live.closed || live.api.signal.aborted) return
        if (++attempts > 5) {
          hostWarn("opencode", "event stream could not be restored", { conversation: live.state.id })
          await live.api.close()
          return
        }
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempts))
      }
    }
    void run()
  }

  function stop(live: Live): void {
    live.closed = true
    live.stream.abort()
    live.agents?.dispose()
    void live.interactions?.close().catch(() => {})
    live.settling.length = 0
    for (const waiters of live.childSettling.values()) for (const settle of waiters) settle()
    live.childSettling.clear()
  }

  async function startCompaction(live: ReturnType<typeof requireLive>, actionId: string, dispatch?: PromptDispatch): Promise<void> {
    if (live.state.status === "running" || live.turn) throw new Error("Wait for the current operation to finish")
    const inboxId = openCodeMessageId()
    const turn: Turn = { kind: "compaction", inboxId, enqueued: false, delivered: false, actionId, dispatch }
    live.turn = turn
    engine.patch(live, { status: "running", nativeRunId: actionId, lastStop: undefined, error: undefined })
    try {
      await live.api.client.session.compact({ sessionID: live.root, id: inboxId })
      dispatch?.report({ kind: "accepted", source: "native-response", referenceId: inboxId })
    } catch (error) {
      // As with a prompt, a lost response is not a lost request: native state decides.
      if (live.turn === turn && !turn.enqueued && !(await admitted(live, turn))) {
        live.turn = null
        live.emit({ type: "live-action-result", id: live.state.id, actionId, result: { kind: "uncertain", reason: errorText({ error }) } })
        engine.patch(live, { status: "failed", lastStop: "failed", error: errorText({ error }) })
      }
      throw error
    }
  }

  return {
    provider: "opencode",
    launchEnvironment: { kind: "prepared", via: "Native API launch consumes ProviderStartOptions.accountLaunch." },
    nativeIdentity: OPENCODE_NATIVE_IDENTITY,
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: { kind: "accepted-message-id", evidence: "OpenCode v2 session.prompt returns the accepted inbox ID; the native user message stores that same ID. Commands without that receipt remain uncorrelated." },
    planning: { via: "mode", mode: OPENCODE_PLAN_AGENT, proposal: "The Plan agent's reply to a step that ends its turn, built by a message to Build",
      feedback: { kind: "next-message", reason: "the plan is the Plan agent's reply, and nothing waits on an answer." } },
    approvalEvidence: {
      kind: "native-decisions",
      recovery: "retained-observer",
      nativeRequests: ["tool-permission", "structured-question"],
      coverage: "OpenCode v2 native API permission and form requests with exact session-scoped identities, answered through the same API. Decisions are retained per connection; requests pending when the server exits end with it.",
    },
    approvalAnswerDigest: openCodeApprovalDigest,
    nativeAgents: { kind: "observed", via: "`subagent` task calls and the child sessions they start." },
    questions: { kind: "request", via: "The `question` tool's form, answered with `form.reply`." },
    contextBreakdown: { kind: "unavailable", reason: "OpenCode reports token totals per message, not what fills the context." },
    modeSwitching: { kind: "native", via: "Each mode is an OpenCode agent, switched on the running session with `session.switchAgent`." },
    backgroundStop: { kind: "ends-on-stop", how: "Stop interrupts every subagent session still executing and then removes every running shell of the conversation's sessions, once the interrupted turn settles, and at once with no turn running; closing does both before the server exits. OpenCode 2.0.1 keeps a background shell and a background subagent through an interrupt, and a shell past its server's exit." },
    turnRecovery: {
      kind: "continues",
      accepted: "The server's acceptance of the prompt into the session's inbox, or its echo on the event stream.",
      exit: "The server's exit settles the session failed and disconnected in one update.",
      tests: ["scripts/test-opencode-live.ts"],
    },
    compaction: {
      kind: "supported",
      async start(id, actionId) {
        await startCompaction(requireLive(id), actionId)
      },
    },
    fork: { kind: "native", point: "run", via: "`session.fork` at a message." },
    resume: {
      kind: "native",
      via: "The session ID on a new `opencode serve`, which reads the session from its own store.",
      wake: "The next message starts a new `opencode serve` that reopens the session.",
      checkpoint: openCodeCheckpoint,
      inspect: inspectOpenCodeSession,
      locate: async (binding, _cwd, env) => binding.nativeId ? locateOpenCodeSession(binding.nativeId, env) : undefined,
    },
    nativeSource: (path, nativeId) => {
      const source = openCodeRecordLocator(path)
      return source && source.nativeId === nativeId
        ? { path: source.database, record: `${source.v2 ? "v2" : "unmarked"}:${source.nativeId}` }
        : undefined
    },
    modes: openCodeModes,
    defaultMode: OPENCODE_DEFAULT_MODE,
    available: () => openCodeExecutable() !== null,
    start: (requestedCwd, options) => cancellable(options.conversationId, signal => traceProviderLaunch("opencode", options.conversationId, async trace => {
      if (!options.emit) throw new Error("A live event receiver is required")
      if (sessions.get(options.conversationId)?.closed === false) throw new Error("This OpenCode binding is already connected")
      const env = await trace.step("account", () => options.accountLaunch?.env ?? dependencies.env())
      delete env.CLAUDECODE
      delete env.CLAUDE_CODE_ENTRYPOINT
      const launchAccess = openCodeLaunchAccess(options.modeId, options.launchModeId)
      configureOpenCodePermissions(env, launchAccess)
      applyControlEnvironment(env, options.conversationTools?.control)
      applyThreadEnvironment(env, options.threadEnvironment)
      const installation = await trace.step("runtime-discovery", () => resolveOpenCodeInstallation(env))
      const nativePath = options.resume ? await trace.step("session-resume", () => verifyOpenCodeSession(options.resume!, options.threadPath, env)) : undefined
      const cwd = requestedCwd && existsSync(requestedCwd) ? requestedCwd : homedir()
      const servers = await trace.step("mcp-preparation", () => mcpServers(options))
      const approvalRoot = await dependencies.approvalRoot()
      const api = await startOpenCodeApi({ command: installation.command, cwd, env, conversationId: options.conversationId, trace, signal, fetch: dependencies.fetch })
      const context = launchContext("opencode-native-api", OPENCODE_NATIVE_IDENTITY, options.accountLaunch?.account, installation.command)
      context.runtime = reportedRuntime(api.health.version, "launched native API health.version")
      const live: Live = {
        api, cwd, env, emit: options.emit, launchAccess, capture: null, catalogGeneration: 0, turn: null, queue: Promise.resolve(),
        mcp: new OpenCodeMcpHealth(), mcpReads: Promise.resolve(),
        settling: [], childSettling: new Map(), stopped: new Set(), stopNotices: new Set(), stream: new AbortController(), closed: false,
        state: {
          executionContext: context,
          id: options.conversationId, harness: "opencode", cwd, title: options.title, nativeId: options.resume, nativePath,
          status: "starting", connection: "starting", modes: [...openCodeModes], currentMode: null, configOptions: [], settings: options.tuning,
        },
      }
      sessions.set(live.state.id, live)
      void api.exited.then(({ code, signal }) => {
        if (live.closed) return
        const running = live.state.status === "running"
        const detail = api.stderr().trim().split("\n").slice(-3).join("\n") || `OpenCode exited${signal ? ` on ${signal}` : code === null ? "" : ` with code ${code}`}`
        hostWarn("opencode", "native API process exited during a session", { conversation: live.state.id, code: code ?? "", signal: signal ?? "" })
        if (running) finish(live, { kind: "failed", message: detail, exited: true })
        stop(live)
        engine.patch(live, { status: "failed", connection: "disconnected", error: detail })
      })
      try {
        await trace.step("observation", () => api.watch.step("event stream", new Promise<void>(resolve => follow(live, resolve))))
        const location = { directory: cwd }
        await trace.step("sdk-initialization", () => api.watch.step("plugin activation", api.client.plugin.awaitActivation({ location })))
        const catalog = await trace.step("model-discovery", () => api.watch.step("catalog", loadCatalog(live)))
        const loadedAt = live.catalogGeneration
        const refused: Array<{ name: string; error: string }> = []
        await trace.step("mcp-preparation", () => Promise.all(servers.map(server =>
          api.client.mcp.add({ server: server.name, location, config: server.config }).catch(error => {
            hostWarn("opencode", "an MCP server could not be added", { conversation: live.state.id, server: server.name, error: errorText({ error }) })
            refused.push({ name: server.name, error: errorText({ error }) })
          }))))
        const modes = openCodeSessionModes(catalog.agents)
        const requested = options.modeId && modes.some(mode => mode.id === options.modeId) ? options.modeId : OPENCODE_DEFAULT_MODE
        const agent = openCodeAgentForMode(requested, launchAccess)
        let session
        const fork = options.fork
        if (options.resume || fork) {
          session = fork
            ? await trace.step("session-open", async () => api.watch.step("session", api.client.session.fork({
                sessionID: fork.nativeId,
                boundary: openCodeForkBoundary(await openCodeSessionMessages((input) => api.client.message.list(input), fork.nativeId), fork.runId),
              })))
            : await trace.step("session-resume", () => api.watch.step("session", api.client.session.get({ sessionID: options.resume! })))
          const current = session.model ? { id: session.model.id, providerID: session.model.providerID, variant: session.model.variant } : undefined
          const ref = openCodeRequestedModel(catalog, options.tuning, current ?? catalog.defaultModel)
          if (session.agent !== agent) await trace.step("settings", () => api.client.session.switchAgent({ sessionID: session!.id, agent }))
          if (!sameOpenCodeModel(current, ref)) await trace.step("settings", () => api.client.session.switchModel({ sessionID: session!.id, model: ref }))
          live.model = ref
        } else {
          const ref = openCodeRequestedModel(catalog, options.tuning, catalog.defaultModel)
          session = await trace.step("session-open", () => api.watch.step("session", api.client.session.create({ location, agent, model: ref, title: options.title })))
          live.model = ref
        }
        live.root = session.id
        const contextSize = () => live.model ? live.catalog?.limits.get(openCodeLaunchId(live.model)) : undefined
        const decoder = live.decoder = new OpenCodeDecoder(session.id, cwd, { launchAccess, contextSize })
        live.capture = nativeCapture("opencode", options.conversationId, () => ({ root: decoder.root, cwd, launchAccess, contextSize: contextSize() ?? null }))
        live.interactions = new OpenCodeInteractions({
          client: api.client, root: approvalRoot, conversationId: live.state.id,
          owns: sessionID => owns(live, sessionID),
          emit: event => { if (!live.closed) live.emit(event) },
          describe: (sessionID, toolID) => ({
            title: toolID ? decoder.content.title(sessionID, toolID) : undefined,
            prefix: decoder.content.prefix(sessionID),
          }),
        })
        await trace.step("observation", () => live.interactions!.restore(options.observedApprovals ?? []))
        const agents = new OpenCodeAgents({ nativeId: session.id, env, observedAgents: options.observedAgents,
          publish: observation => { if (!live.closed) engine.emitAgent(live, observation) } })
        live.agents = agents
        await trace.step("observation", () => agents.ready)
        if (options.resume) await trace.step("observation", () => live.interactions!.reconcile(session!.id))
        if (live.closed) throw new Error("OpenCode disconnected during startup")
        const reported = openCodeReportedSettings(catalog, live.model)
        engine.patch(live, {
          status: "ready",
          connection: "connected",
          nativeId: session.id,
          nativePath: nativePath ?? await locateOpenCodeSession(session.id, env).catch((error) => {
            hostWarn("opencode", "the new session's store record was not found", { conversation: live.state.id, error: errorText({ error }) })
            return undefined
          }),
          title: session.title ?? options.title,
          modes,
          currentMode: openCodeModeForAgent(agent, launchAccess),
          launchMode: accessModeId(launchAccess),
          commands: catalog.commands,
          ...reported,
        })
        api.watch.dispose()
        for (const server of refused) mark(live, live.mcp.failed(server.name, server.error))
        readMcp(live)
        if (live.catalogGeneration !== loadedAt) refreshCatalog(live)
        hostLog("opencode", options.resume ? "resumed session" : fork ? "forked session" : "created session", {
          conversation: live.state.id, session: session.id, pid: api.health.pid, version: api.health.version,
          model: openCodeLaunchId(live.model), access: launchAccess, mcpServers: servers.length,
        })
        return live.state
      } catch (error) {
        stop(live)
        sessions.delete(live.state.id)
        await api.close()
        throw error
      }
    })),
    async prompt(id, text, attachments, settings, dispatch) {
      const live = preparePrompt(dispatch, () => {
        const live = requireLive(id)
        if (live.state.status === "running" || live.turn) throw new Error("OpenCode is already working")
        return live
      })
      if (text.trim() === "/compact" && attachments.length === 0) {
        dispatch.report({ kind: "submitted", source: "transport-call" })
        await startCompaction(live, randomUUID(), dispatch)
        return
      }
      const merged: SessionSettings = { ...live.state.settings, ...settings, options: { ...live.state.settings?.options, ...settings?.options } }
      const ref = preparePrompt(dispatch, () => openCodeRequestedModel(live.catalog, merged, live.model))
      if (!sameOpenCodeModel(live.model, ref)) {
        await preparePromptAsync(dispatch, () => live.api.client.session.switchModel({ sessionID: live.root, model: ref }))
        selectModel(live, ref)
      }
      const slash = preparePrompt(dispatch, () => {
        if (live.closed || live.turn) throw new Error("The session changed while preparing the prompt")
        return slashInvocation(text, live.catalog)
      })
      const files = promptFiles(attachments)
      const inboxId = slash?.kind === "command" ? undefined : openCodeMessageId()
      const turn: Turn = { kind: slash?.kind === "command" ? "command" : "prompt", inboxId, enqueued: false, delivered: false, dispatch }
      live.turn = turn
      live.providerTurnCause = undefined
      live.stopped.clear()
      live.stopNotices.clear()
      engine.patch(live, { status: "running", nativeRunId: inboxId, lastStop: undefined, error: undefined })
      engine.emitUpdate(live, { kind: "user", text })
      live.capture?.prompted({ text, run: inboxId, attachments })
      dispatch.report({ kind: "submitted", source: "transport-call", correlationId: inboxId })
      try {
        if (slash?.kind === "command") {
          await live.api.client.session.command({ sessionID: live.root, command: slash.name, text: slash.rest, files })
          dispatch.report({ kind: "accepted", source: "native-response" })
        } else {
          const skill = slash?.kind === "skill" ? live.catalog.skills.get(slash.name) : undefined
          const inbox = await live.api.client.session.prompt({ sessionID: live.root, id: inboxId, text: skill ? slash!.rest : text, files,
            skills: skill ? [{ id: skill.id }] : undefined })
          dispatch.report({ kind: "accepted", source: "native-response", referenceId: inbox.id })
        }
      } catch (error) {
        // A lost response is not a lost send. Native state decides; the host never resends.
        if (live.turn === turn && !turn.enqueued && !(await admitted(live, turn))) {
          live.turn = null
          engine.patch(live, { status: "failed", lastStop: "failed", error: errorText({ error }) })
        }
        throw error
      }
    },
    async permission(id, requestId, response, dispatch) {
      const live = sessions.get(id)
      if (!live?.interactions || live.closed) {
        dispatch.report({ kind: "not-submitted", pending: false, reason: "request-ended" })
        return
      }
      await live.interactions.respond(requestId, response, dispatch)
    },
    steering: { kind: "supported", lands: "step", via: "A prompt sent while the session is busy is read at its next step.", async steer(id, input) {
      const live = sessions.get(id)
      const turn = live?.turn
      if (!live?.root || live.closed || live.state.status !== "running" || !turn || turn.kind === "compaction" || live.state.nativeRunId !== input.expectedRunId)
        return { kind: "not-accepted", reason: "The OpenCode turn has already changed" }
      await live.api.client.session.prompt({ sessionID: live.root, id: openCodeMessageId(), text: input.text, files: promptFiles(input.attachments), delivery: "steer" })
      live.capture?.steered(input.text)
      return { kind: "accepted" }
    } },
    async setMode(id, modeId) {
      const live = requireLive(id)
      if (!live.state.modes.some(mode => mode.id === modeId)) throw new Error(`OpenCode does not offer the mode "${modeId}" here`)
      const agent = openCodeAgentForMode(modeId, live.launchAccess)
      await live.api.client.session.switchAgent({ sessionID: live.root, agent })
      engine.patch(live, { currentMode: openCodeModeForAgent(agent, live.launchAccess) })
    },
    /** Stop ends the turn, its subagents, and every shell the conversation left running. */
    async cancel(id) {
      const live = requireLive(id)
      const turn = live.turn
      const end = () => {
        if (live.closed) return
        endBackground(live).catch(error =>
          hostWarn("opencode", "Background work was not ended", { conversation: live.state.id, error: errorText({ error }) }))
      }
      if (live.state.status !== "running" || !turn) {
        end()
        return
      }
      live.settling.push(end)
      turn.stopRequested = true
      let interrupted: boolean
      try {
        interrupted = (await live.api.client.session.interrupt({ sessionID: live.root })).interrupted
      } catch (error) {
        // An unacknowledged interrupt is not a stopped turn. End the server so
        // its exit marks the session disconnected before anything continues it.
        live.settling = live.settling.filter(settle => settle !== end)
        await endBackgroundWithinGrace(live)
        await live.api.close()
        throw error
      }
      // No running execution: the item was still queued or already finished.
      if (!interrupted && live.turn === turn) {
        if (turn.inboxId && !turn.delivered)
          await live.api.client.session.inbox.cancel({ sessionID: live.root, inboxID: turn.inboxId }).catch(() => {})
        finish(live, { kind: "interrupted", reason: "user" })
      }
    },
    async close(id) {
      starting.get(id)?.abort(new Error("OpenCode was closed during startup"))
      const live = sessions.get(id)
      if (!live) return
      sessions.delete(id)
      if (live.closed) return
      await endBackgroundWithinGrace(live)
      stop(live)
      await live.api.close()
    },
  }
}
