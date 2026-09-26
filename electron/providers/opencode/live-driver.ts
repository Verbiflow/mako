import { randomBytes, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import type { OpenCodeEvent } from "@opencode/client"
import type { SessionSettings } from "@mako/sessions/settings"
import { applyControlEnvironment } from "../../control-launch.js"
import { hostLog, hostWarn } from "../../host-log.js"
import { traceProviderLaunch } from "../../provider-launch.js"
import type { AccessTier } from "../../contracts/access.js"
import type { LiveActionResult } from "../../contracts/live-actions.js"
import type { LiveSessionState, McpRegistrySnapshot, PromptAttachment } from "../../shared.js"
import { createLiveEngine, type LiveEngineApi } from "../../live-engine.js"
import { preparePrompt, preparePromptAsync, type PromptDispatch } from "../prompt-dispatch.js"
import type { ProviderLiveDriver, ProviderStartOptions } from "../live-driver.js"
import { startOpenCodeApi } from "./native-api.js"
import { resolveOpenCodeInstallation, openCodeExecutable, verifyOpenCodeSession } from "./installation.js"
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
import { OpenCodeContent } from "./content.js"
import { OpenCodeInteractions, openCodeApprovalDigest } from "./interactions.js"
import { OpenCodeAgents } from "./agents.js"
import { openCodeCheckpoint, openCodeResumeVerdict } from "./resume.js"

type Api = Awaited<ReturnType<typeof startOpenCodeApi>>

/** One native send and the execution it starts. The inbox ID binds both. */
interface Turn {
  kind: "prompt" | "command" | "compaction"
  /** Client-chosen for prompts and compaction; a command's is learned from its enqueue echo. */
  inboxId?: string
  enqueued: boolean
  delivered: boolean
  dispatch?: PromptDispatch
  actionId?: string
}

interface Live {
  state: LiveSessionState
  emit: NonNullable<ProviderStartOptions["emit"]>
  api: Api
  cwd: string
  root?: string
  children: Set<string>
  catalog?: OpenCodeCatalog
  /** Bumped by each native catalog change; a load answers for the generation it started at. */
  catalogGeneration: number
  catalogRefresh?: Promise<void>
  model?: OpenCodeModelRef
  launchAccess: AccessTier
  content?: OpenCodeContent
  interactions?: OpenCodeInteractions
  agents?: OpenCodeAgents
  turn: Turn | null
  /** Context tokens of the root session's latest step; cost is the session's own total. */
  context?: number
  cost?: number
  /** Native events are applied in order; interaction bookkeeping awaits its store. */
  queue: Promise<void>
  /** Pending while a missed call's native name is read; content waits behind it. */
  projection?: Promise<void>
  stream: AbortController
  closed: boolean
}

type Engine = LiveEngineApi<Live>

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
export function openCodeMessageId(now = Date.now()): string {
  if (now !== lastIdTime) { lastIdTime = now; idCounter = 0 }
  const value = (BigInt(now) * 0x1000n + BigInt(++idCounter)) & 0xffffffffffffn
  const random = [...randomBytes(14)].map(byte => ALPHABET[byte % 62]).join("")
  return `msg_${value.toString(16).padStart(12, "0")}${random}`
}

function promptFiles(attachments: readonly PromptAttachment[]): Array<{ uri: string; name?: string }> {
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
  if (tools) {
    const headers = { Authorization: `Bearer ${tools.token}` }
    servers.push({ name: "mako-conversations", config: { type: "remote", url: tools.url, headers, oauth: false } })
    if (tools.controlUrl) servers.push({ name: "mako-control", config: { type: "remote", url: tools.controlUrl, headers, oauth: false } })
  }
  return servers
}

function contextTokens(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * OpenCode v2 through its native API. One `opencode serve --stdio` per
 * conversation; stdin is its ownership lease. OpenCode owns execution,
 * permissions, questions and its store. The driver keeps the turn bound to
 * the inbox item it sent, and projects the event stream into the live contract.
 */
export function createOpenCodeDriver(dependencies: OpenCodeDriverDependencies): ProviderLiveDriver {
  const engine: Engine = createLiveEngine<Live>()
  const sessions = engine.sessions

  function requireLive(id: string): Live & { root: string; catalog: OpenCodeCatalog; model: OpenCodeModelRef; interactions: OpenCodeInteractions } {
    const live = sessions.get(id)
    if (!live || live.closed || !live.root || !live.catalog || !live.model || !live.interactions)
      throw new Error("This OpenCode session is disconnected")
    return live as Live & { root: string; catalog: OpenCodeCatalog; model: OpenCodeModelRef; interactions: OpenCodeInteractions }
  }

  const owns = (live: Live, sessionID: string) => sessionID === live.root || live.children.has(sessionID)

  function usage(live: Live) {
    const size = live.model ? live.catalog?.limits.get(openCodeLaunchId(live.model)) : undefined
    if (live.context === undefined || !size) return
    engine.patch(live, { usage: { used: live.context, size, cost: live.cost === undefined ? undefined : { amount: live.cost, currency: "USD" } } })
  }

  /** Load until no native catalog change arrived during the load. */
  async function loadCatalog(live: Live): Promise<OpenCodeCatalog> {
    for (;;) {
      const generation = live.catalogGeneration
      const catalog = await loadOpenCodeCatalog(live.api.client, live.cwd, live.api.signal)
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
      if (!live.closed) hostWarn("opencode", "the refreshed catalog could not be read", { conversation: live.state.id, error: errorText(error) })
    }).finally(() => { live.catalogRefresh = undefined })
  }

  function selectModel(live: Live, ref: OpenCodeModelRef) {
    live.model = ref
    if (!live.catalog) return
    engine.patch(live, openCodeReportedSettings(live.catalog, ref))
  }

  function finish(live: Live, outcome: { kind: "succeeded" } | { kind: "failed"; message: string; type?: string } | { kind: "interrupted"; reason: string }) {
    const turn = live.turn
    if (!turn) return
    live.turn = null
    if (live.root && live.content && outcome.kind !== "succeeded")
      engine.emitUpdates(live, live.content.settle(live.root, outcome.kind === "failed" ? "failed" : "cancelled",
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
      engine.patch(live, { status: "failed", lastStop: outcome.type === "aborted" ? "cancelled" : "failed", error: outcome.message.slice(0, 2000) })
    }
  }

  function observeAgent(live: Live, event: OpenCodeEvent) {
    const agents = live.agents
    if (!agents || !live.root) return
    switch (event.type) {
      case "session.tool.called":
        agents.observe({ sessionId: event.data.sessionID, toolCallId: event.data.id, title: live.content?.name(event.data.sessionID, event.data.id),
          rawInput: event.data.input, status: "in_progress" })
        return
      case "session.tool.progress":
        agents.observe({ sessionId: event.data.sessionID, toolCallId: event.data.id, rawOutput: { metadata: event.data.metadata } })
        return
      case "session.tool.success":
      case "session.tool.failed":
        agents.observe({ sessionId: event.data.sessionID, toolCallId: event.data.id, rawOutput: { metadata: event.data.metadata },
          status: event.type === "session.tool.success" ? "completed" : "failed" })
        return
    }
  }

  function receive(live: Live, event: OpenCodeEvent): void {
    if (live.closed) return
    if (event.type === "catalog.updated" || event.type === "agent.updated" || event.type === "command.updated" || event.type === "skill.updated") {
      if (event.location && event.location.directory !== live.cwd) return
      live.catalogGeneration++
      refreshCatalog(live)
      return
    }
    if (!live.root) return
    const root = live.root
    switch (event.type) {
      case "session.created":
        if (event.data.parentID && owns(live, event.data.parentID)) {
          live.children.add(event.data.sessionID)
          live.content?.nameSession(event.data.sessionID, event.data.title)
        }
        return
      case "session.renamed":
        if (event.data.sessionID === root) engine.patch(live, { title: event.data.title })
        else if (live.children.has(event.data.sessionID)) live.content?.nameSession(event.data.sessionID, event.data.title)
        return
      case "session.inbox.enqueued": {
        const turn = live.turn
        if (event.data.sessionID !== root || !turn) return
        if (turn.kind === "command" && !turn.inboxId && event.data.item.type === "user") turn.inboxId = event.data.inboxID
        if (turn.inboxId !== event.data.inboxID || turn.enqueued) return
        turn.enqueued = true
        turn.dispatch?.report({ kind: "accepted", source: "native-echo", referenceId: event.data.inboxID })
        if (turn.kind !== "compaction") engine.patch(live, { nativeRunId: event.data.inboxID })
        return
      }
      case "session.inbox.delivered":
        if (event.data.sessionID === root && live.turn?.inboxId === event.data.inboxID) live.turn.delivered = true
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
          if (live.children.has(sessionID) && event.type !== "session.execution.succeeded" && live.content)
            engine.emitUpdates(live, live.content.settle(sessionID, event.type === "session.execution.failed" ? "failed" : "cancelled", "The subagent stopped before this call finished."))
          return
        }
        if (!live.turn?.delivered) return
        if (event.type === "session.execution.succeeded") finish(live, { kind: "succeeded" })
        else if (event.type === "session.execution.failed") finish(live, { kind: "failed", message: event.data.error.message, type: event.data.error.type })
        else finish(live, { kind: "interrupted", reason: event.data.reason })
        return
      }
      case "session.compaction.failed":
        if (event.data.sessionID === root && live.turn?.kind === "compaction" && (!event.data.inputID || event.data.inputID === live.turn.inboxId))
          finish(live, { kind: "failed", message: event.data.error.message, type: event.data.error.type })
        return
      case "session.step.ended":
        if (event.data.sessionID === root) { live.context = contextTokens(event.data.tokens); usage(live) }
        return
      case "session.usage.updated":
        if (event.data.sessionID === root) { live.cost = event.data.cost; usage(live) }
        return
      case "session.agent.selected":
        if (event.data.sessionID === root) engine.patch(live, { currentMode: openCodeModeForAgent(event.data.agent, live.launchAccess) })
        return
      case "session.model.selected":
        if (event.data.sessionID === root) selectModel(live, event.data.model)
        return
      case "session.retry.scheduled":
        if (event.data.sessionID === root)
          hostLog("opencode", "provider retry scheduled", { conversation: live.state.id, attempt: event.data.attempt, error: event.data.error.message })
        return
      case "form.created":
      case "form.replied":
      case "form.cancelled":
      case "permission.asked":
      case "permission.replied":
        live.queue = live.queue.then(() => live.interactions?.observe(event)).catch(error =>
          hostWarn("opencode", "a native request could not be shown", { conversation: live.state.id, error: errorText(error) }))
        return
      default:
        break
    }
    if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string" || !owns(live, event.data.sessionID) || !live.content) return
    if (!live.projection && !unnamedCall(live, event)) { project(live, event); return }
    // Later content waits behind a native name lookup so rows keep their order.
    const projection: Promise<void> = (live.projection ?? Promise.resolve()).then(async () => {
      if (live.closed) return
      if (unnamedCall(live, event)) {
        const name = await nativeToolName(live, event)
        if (name && !live.closed) engine.emitUpdates(live, live.content!.open(event.data.sessionID, event.data.id, name))
      }
      if (!live.closed) project(live, event)
    }).catch(error => hostWarn("opencode", "a native event could not be applied", { conversation: live.state.id, type: event.type, error: errorText(error) }))
      .finally(() => { if (live.projection === projection) live.projection = undefined })
    live.projection = projection
  }

  type ToolCallEvent = Extract<OpenCodeEvent, { type: "session.tool.called" | "session.tool.success" | "session.tool.failed" }>

  /** A call seen first after its start: a resubscribed stream missed the event that names it. */
  function unnamedCall(live: Live, event: OpenCodeEvent): event is ToolCallEvent {
    return (event.type === "session.tool.called" || event.type === "session.tool.success" || event.type === "session.tool.failed")
      && live.content?.name(event.data.sessionID, event.data.id) === undefined
  }

  async function nativeToolName(live: Live, event: ToolCallEvent): Promise<string | undefined> {
    try {
      const message = await live.api.client.session.message({ sessionID: event.data.sessionID, messageID: event.data.assistantMessageID })
      if (message.type !== "assistant") return undefined
      for (const part of message.content) if (part.type === "tool" && part.id === event.data.id) return part.name
      return undefined
    } catch (error) {
      hostWarn("opencode", "a resumed tool call's name could not be read", { conversation: live.state.id, error: errorText(error) })
      return undefined
    }
  }

  function project(live: Live, event: OpenCodeEvent): void {
    const content = live.content
    if (!content) return
    // The call's name must still be open when the observer reads it; the result closes it.
    if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      observeAgent(live, event)
      engine.emitUpdates(live, content.observe(event))
    } else {
      engine.emitUpdates(live, content.observe(event))
      observeAgent(live, event)
    }
  }

  /** After a gap, native state says what the missed events would have: open requests and whether the turn ended. */
  async function reconcile(live: Live): Promise<void> {
    const root = live.root
    if (!root || !live.interactions) return
    for (const sessionID of [root, ...live.children]) await live.interactions.reconcile(sessionID)
    const turn = live.turn
    if (!turn) return
    const active = await live.api.client.session.active()
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
            hostWarn("opencode", "reconnect reconciliation failed", { conversation: live.state.id, error: errorText(error) }))
          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            try { receive(live, next.value) } catch (error) {
              hostWarn("opencode", "a native event could not be applied", { conversation: live.state.id, type: next.value.type, error: errorText(error) })
            }
          }
        } catch (error) {
          if (live.closed || live.api.signal.aborted) return
          hostWarn("opencode", "event stream ended", { conversation: live.state.id, error: errorText(error) })
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
      if (live.turn === turn && !turn.enqueued) {
        live.turn = null
        live.emit({ type: "live-action-result", id: live.state.id, actionId, result: { kind: "uncertain", reason: errorText(error) } })
        engine.patch(live, { status: "failed", lastStop: "failed", error: errorText(error) })
      }
      throw error
    }
  }

  return {
    provider: "opencode",
    approvalEvidence: {
      kind: "native-decisions",
      recovery: "retained-observer",
      nativeRequests: ["tool-permission", "structured-question"],
      coverage: "OpenCode v2 native API permission and form requests with exact session-scoped identities, answered through the same API. Decisions are retained per connection; requests pending when the server exits end with it.",
    },
    approvalAnswerDigest: openCodeApprovalDigest,
    observesNativeAgents: true,
    compaction: {
      kind: "supported",
      async start(id, actionId) {
        await startCompaction(requireLive(id), actionId)
      },
    },
    canResume: true,
    checkpoint: openCodeCheckpoint,
    resumeVerdict: openCodeResumeVerdict,
    modes: openCodeModes,
    defaultMode: OPENCODE_DEFAULT_MODE,
    available: () => openCodeExecutable() !== null,
    start: (requestedCwd, options) => traceProviderLaunch("opencode", options.conversationId, async trace => {
      if (!options.emit) throw new Error("A live event receiver is required")
      if (sessions.get(options.conversationId)?.closed === false) throw new Error("This OpenCode binding is already connected")
      if (options.fork) throw new Error("OpenCode conversations cannot be forked from Mako yet")
      const env = await trace.step("account", () => dependencies.env())
      delete env.CLAUDECODE
      delete env.CLAUDE_CODE_ENTRYPOINT
      const launchAccess = openCodeLaunchAccess(options.modeId)
      configureOpenCodePermissions(env, launchAccess)
      applyControlEnvironment(env, options.conversationTools?.control)
      const installation = await trace.step("runtime-discovery", () => resolveOpenCodeInstallation(env))
      const nativePath = options.resume ? await trace.step("session-resume", () => verifyOpenCodeSession(options.resume!, options.threadPath, env)) : undefined
      const cwd = requestedCwd && existsSync(requestedCwd) ? requestedCwd : homedir()
      const servers = await trace.step("mcp-preparation", () => mcpServers(options))
      const approvalRoot = await dependencies.approvalRoot()
      const api = await startOpenCodeApi({ command: installation.command, cwd, env, conversationId: options.conversationId, trace, fetch: dependencies.fetch })
      const live: Live = {
        api, cwd, emit: options.emit, launchAccess, children: new Set(), catalogGeneration: 0, turn: null, queue: Promise.resolve(),
        stream: new AbortController(), closed: false,
        state: {
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
        if (running) finish(live, { kind: "failed", message: detail })
        stop(live)
        engine.patch(live, { status: "failed", connection: "disconnected", error: detail })
      })
      try {
        await trace.step("observation", () => api.watch.step("event stream", new Promise<void>(resolve => follow(live, resolve))))
        const location = { directory: cwd }
        await trace.step("sdk-initialization", () => api.watch.step("plugin activation", api.client.plugin.awaitActivation({ location })))
        const catalog = await trace.step("model-discovery", () => api.watch.step("catalog", loadCatalog(live)))
        const loadedAt = live.catalogGeneration
        await trace.step("mcp-preparation", () => Promise.all(servers.map(server =>
          api.client.mcp.add({ server: server.name, location, config: server.config }).catch(error =>
            hostWarn("opencode", "an MCP server could not be added", { conversation: live.state.id, server: server.name, error: errorText(error) })))))
        const modes = openCodeSessionModes(catalog.agents)
        const requested = options.modeId && modes.some(mode => mode.id === options.modeId) ? options.modeId : OPENCODE_DEFAULT_MODE
        const agent = openCodeAgentForMode(requested, launchAccess)
        let session
        if (options.resume) {
          session = await trace.step("session-resume", () => api.watch.step("session", api.client.session.get({ sessionID: options.resume! })))
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
        live.content = new OpenCodeContent(session.id, cwd)
        live.interactions = new OpenCodeInteractions({
          client: api.client, root: approvalRoot, conversationId: live.state.id,
          owns: sessionID => owns(live, sessionID),
          emit: event => { if (!live.closed) live.emit(event) },
          describe: (sessionID, toolID) => ({
            title: toolID ? live.content?.title(sessionID, toolID) : undefined,
            prefix: live.content?.prefix(sessionID),
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
          nativePath: nativePath ?? await verifyOpenCodeSession(session.id, undefined, env).catch(() => undefined),
          title: session.title ?? options.title,
          modes,
          currentMode: openCodeModeForAgent(agent, launchAccess),
          commands: catalog.commands,
          ...reported,
        })
        api.watch.dispose()
        if (live.catalogGeneration !== loadedAt) refreshCatalog(live)
        hostLog("opencode", options.resume ? "resumed session" : "created session", {
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
    }),
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
      engine.patch(live, { status: "running", nativeRunId: inboxId, lastStop: undefined, error: undefined })
      engine.emitUpdate(live, { kind: "user", text })
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
          engine.patch(live, { status: "failed", lastStop: "failed", error: errorText(error) })
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
    async setMode(id, modeId) {
      const live = requireLive(id)
      if (!live.state.modes.some(mode => mode.id === modeId)) throw new Error(`OpenCode does not offer the mode "${modeId}" here`)
      const agent = openCodeAgentForMode(modeId, live.launchAccess)
      await live.api.client.session.switchAgent({ sessionID: live.root, agent })
      engine.patch(live, { currentMode: openCodeModeForAgent(agent, live.launchAccess) })
    },
    async cancel(id) {
      const live = requireLive(id)
      const turn = live.turn
      if (live.state.status !== "running" || !turn) return
      let interrupted: boolean
      try {
        interrupted = (await live.api.client.session.interrupt({ sessionID: live.root })).interrupted
      } catch (error) {
        // An unacknowledged interrupt is not a stopped turn. End the server so
        // its exit marks the session disconnected before anything continues it.
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
      const live = sessions.get(id)
      if (!live) return
      sessions.delete(id)
      if (live.closed) return
      stop(live)
      await live.api.close()
    },
  }
}