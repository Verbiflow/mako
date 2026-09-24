import { applyControlEnvironment } from "../../../control-launch.js"
import { preparePrompt } from "../../prompt-dispatch.js"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  cursorLegacyIdentity,
  cursorSdkReportedSettings,
  cursorSdkSelection,
  cursorSdkStorePath,
  cursorStoreOrigin,
  normalizeCursorSdkModels,
} from "@mako/sessions"
import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
import { compareNativeCheckpoint, type ProviderBinding, type ResumeVerdict } from "../../../contracts/conversation-control.js"
import { hostLog, hostWarn } from "../../../host-log.js"
import { traceProviderLaunch, type ProviderLaunchTrace } from "../../../provider-launch.js"
import {
  CONNECTION_LOST_STOP,
  type LivePermissionResponse,
  type LiveSessionState,
  type PromptAttachment,
} from "../../../shared.js"
import { createLiveEngine, type LiveEngineApi } from "../../../live-engine.js"
import type {
  ProviderLiveDriver,
  ProviderStartOptions,
  ProviderSteerResult,
} from "../../live-driver.js"
import type { CursorSdkAuth, CursorSdkProbeClient, CursorSdkSpawnOptions } from "./auth.js"
import { CursorSdkClient, CursorSdkError } from "./client.js"
import { CURSOR_SDK_DEFAULT_MODE, CURSOR_SDK_MODES, isCursorSdkModeId } from "./modes.js"
import { CursorSdkProjection } from "./projection.js"
import { CursorAgents } from "./agents.js"
import { cursorLegacyCheckpoint, cursorSdkCheckpoint } from "../resume.js"
import { migrateRetiredMakoMcpFile } from "../../../retired-mcp.js"
import type {
  SdkEvent,
  SdkImage,
  SdkImportSource,
  SdkMcpServer,
  SdkModelListItem,
  SdkModelSelection,
  SdkRunResult,
} from "./wire.js"

/** The model list is one network call; a start reuses it for this long. */
const MODELS_TTL_MS = 10 * 60_000

/** What a live conversation needs from its child beyond a probe. */
export type CursorSdkLiveClient = CursorSdkProbeClient & Pick<CursorSdkClient, "exited" | "alive" | "kill">

export interface CursorSdkDriverDependencies {
  auth: CursorSdkAuth
  stateRoot(): string
  /** The user's home, for recognising `cursor-agent` stores; tests point it at a fixture. */
  home?: string
  /** Test hook: another client than the real child. */
  client?(options: CursorSdkSpawnOptions): CursorSdkLiveClient
  /** Test hook: a model list without a child. */
  models?(client: CursorSdkLiveClient): Promise<SdkModelListItem[]>
  now?(): number
}

interface Live {
  state: LiveSessionState
  client: CursorSdkLiveClient
  emit: NonNullable<ProviderStartOptions["emit"]>
  /** Tells the host's auth that Cursor refused the key this session ran under. */
  onRejected(message: string): void
  models: SessionModel[]
  turn: string | null
  projection: CursorSdkProjection | null
  agents: CursorAgents
  pendingPermissions: Map<string, (response: LivePermissionResponse) => void>
  closed: boolean
}

interface ModelCache {
  models: SessionModel[]
  defaultModel: string | undefined
  fetchedAt: number
}

/** The SDK's own error codes for a dropped or exhausted connection. */
const CONNECTION_CODES = new Set(["unavailable", "canceled", "cancelled", "deadline_exceeded", "aborted"])
const CONNECTION_MESSAGE =
  /RetriableError|http\/2|HTTP\/2|RST_STREAM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|stream closed|network error|fetch failed/i

/** The SDK's `unauthenticated` code, or its wording, on a run's error. */
export function authenticationFailure(error: { message: string; code?: string } | undefined): boolean {
  if (!error) return false
  if (error.code && /^unauthenticated$|^permission_denied$/i.test(error.code)) return true
  return /unauthenticated|unauthorized|not authenticated|invalid api key|api key is required|401\b/i.test(error.message)
}

/** A run that ended on the SDK's own connection dropping, not on the model or the tools. */
export function connectionLost(result: SdkRunResult): boolean {
  if (result.status !== "error" || !result.error) return false
  if (result.error.code && CONNECTION_CODES.has(result.error.code.toLowerCase())) return true
  return CONNECTION_MESSAGE.test(result.error.message)
}

type Engine = LiveEngineApi<Live>

function configOptions(models: readonly SessionModel[], selection: SdkModelSelection | undefined): SessionModel["options"] {
  if (!selection) return []
  const model = models.find((candidate) => candidate.id === selection.id)
  if (!model) return []
  const reported = cursorSdkReportedSettings(selection, models)
  return model.options.map((option) => {
    const value = reported.options?.[option.id]
    if (value === undefined) return option
    if (option.kind === "select" && value !== true && value !== false) return { ...option, current: value }
    if (option.kind === "boolean" && (value === true || value === false)) return { ...option, current: value }
    return option
  })
}

function promptImages(attachments: readonly PromptAttachment[]): SdkImage[] {
  const images: SdkImage[] = []
  for (const attachment of attachments)
    if (attachment.data && attachment.mimeType.startsWith("image/"))
      images.push({ data: attachment.data, mimeType: attachment.mimeType })
  return images
}

/** Files the SDK cannot take as content are named in the prompt, the way a person would. */
function promptText(text: string, attachments: readonly PromptAttachment[]): string {
  const files = attachments.filter((attachment) => attachment.path && !(attachment.data && attachment.mimeType.startsWith("image/")))
  if (files.length === 0) return text
  return `${text}\n\nAttached files:\n${files.map((file) => `- ${file.path}`).join("\n")}`
}

async function mcpServers(options: ProviderStartOptions): Promise<Record<string, SdkMcpServer>> {
  const servers: Record<string, SdkMcpServer> = {}
  if (options.mcpSnapshot) {
    const snapshot = await options.mcpSnapshot()
    // Loaded here, as Claude's driver does: `mcp-runtime` reaches the whole
    // provider registry, which installs this driver, so a static import
    // would make this module a cycle for every test that loads it alone.
    const { acpMcpServers } = await import("../../../mcp-runtime.js")
    for (const server of acpMcpServers(snapshot, "cursor", ["stdio", "http", "sse"])) {
      if ("command" in server) {
        servers[server.name] = {
          type: "stdio",
          command: server.command,
          args: server.args,
          env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        }
      } else if (server.type === "http" || server.type === "sse") {
        servers[server.name] = {
          type: server.type,
          url: server.url,
          headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
        }
      }
    }
  }
  if (options.conversationTools)
    servers["mako-conversations"] = {
      type: "http",
      url: options.conversationTools.url,
      headers: { Authorization: `Bearer ${options.conversationTools.token}` },
    }
  if (options.conversationTools?.controlUrl)
    servers["mako-control"] = {
      type: "http",
      url: options.conversationTools.controlUrl,
      headers: { Authorization: `Bearer ${options.conversationTools.token}` },
    }
  return servers
}

/**
 * Why a tool row is still open when its turn has ended. The SDK has no
 * approval prompt: a call a hook rejects is refused before it runs, the
 * reason is fed to the model only, and no terminal event follows.
 */
function unfinishedToolNote(outcome: "finished" | "cancelled" | "error", error?: string): string {
  switch (outcome) {
    case "cancelled":
      return "Stopped before this call finished."
    case "error":
      return `Cursor ended the turn before this call finished${error ? `: ${error}` : "."}`
    case "finished":
      return "Cursor did not run this call. A hook in .cursor/hooks.json or the runtime rejected it before it ran and told the agent why; the SDK has no approval prompt."
  }
}

/** Ends the turn's projection, closing any tool row the run left open. */
function settleTurn(engine: Engine, live: Live, outcome: "finished" | "cancelled" | "error", error?: string): void {
  const projection = live.projection
  live.turn = null
  live.projection = null
  if (!projection) return
  engine.emitUpdates(live, projection.finish(outcome, unfinishedToolNote(outcome, error)))
}

function finishTurn(engine: Engine, live: Live, result: SdkRunResult): void {
  settleTurn(engine, live, result.status, result.error?.message)
  const settings = result.model ? cursorSdkReportedSettings(result.model, live.models) : live.state.settings
  const patch: Partial<LiveSessionState> = {
    settings,
    configOptions: result.model ? configOptions(live.models, result.model) : live.state.configOptions,
  }
  switch (result.status) {
    case "finished":
      Object.assign(patch, { status: "ready", lastStop: "end_turn", error: undefined })
      break
    case "cancelled":
      Object.assign(patch, { status: "ready", lastStop: "cancelled", error: undefined })
      break
    case "error": {
      const message = result.error?.message ?? "Cursor ended the turn with an error"
      const lost = connectionLost(result)
      hostWarn("cursor-sdk", lost ? "turn ended on a dropped connection" : "turn failed", {
        conversation: live.state.id,
        code: result.error?.code ?? "",
        error: message,
      })
      if (authenticationFailure(result.error)) live.onRejected(message)
      Object.assign(patch, {
        status: "failed",
        lastStop: lost ? CONNECTION_LOST_STOP : "failed",
        error: message.slice(0, 2000),
      })
      break
    }
  }
  engine.patch(live, patch)
}

function receive(engine: Engine, live: Live, event: SdkEvent): void {
  if (live.closed) return
  switch (event.event) {
    case "message": {
      if (event.turn !== live.turn || !live.projection) return
      if (event.message.type === "system" && event.message.model) {
        live.state = {
          ...live.state,
          settings: cursorSdkReportedSettings(event.message.model, live.models),
          configOptions: configOptions(live.models, event.message.model),
        }
      }
      engine.emitUpdates(live, live.projection.message(event.message))
      const agent = live.agents.project(event.message)
      if (agent) engine.emitAgent(live, agent)
      return
    }
    case "delta": {
      if (event.turn !== live.turn || !live.projection) return
      engine.emitUpdates(live, live.projection.delta(event.delta))
      return
    }
    case "result":
      if (event.turn !== live.turn) return
      finishTurn(engine, live, event.result)
      return
    case "login-url":
      return
    case "log":
      if (event.level === "warn") hostWarn("cursor-sdk", event.message, { conversation: live.state.id })
      else hostLog("cursor-sdk", event.message, { conversation: live.state.id })
      return
  }
}

function stop(engine: Engine, live: Live): void {
  live.closed = true
  engine.release(live)
}

/**
 * Cursor through its SDK. One Node child per conversation runs the SDK
 * agent; the driver keeps the transcript, the mode, and the model
 * selection, and turns the child's events into the shared live contract.
 * The SDK retries its own backend stream, so a turn here ends on the model
 * or on an exhausted retry budget, never on one reset frame.
 */
export function createCursorSdkDriver(dependencies: CursorSdkDriverDependencies): ProviderLiveDriver {
  const engine = createLiveEngine<Live>()
  const sessions = engine.sessions
  let modelCache: ModelCache | null = null

  const now = () => dependencies.now?.() ?? Date.now()

  function requireLive(id: string): Live {
    const live = sessions.get(id)
    if (!live || live.closed) throw new Error("This Cursor session is disconnected")
    return live
  }

  async function loadModels(client: CursorSdkLiveClient): Promise<ModelCache> {
    if (modelCache && now() - modelCache.fetchedAt < MODELS_TTL_MS) return modelCache
    const list = dependencies.models
      ? await dependencies.models(client)
      : (await client.request("models", undefined)).models
    const catalog = normalizeCursorSdkModels(list)
    if (catalog.models.length === 0) throw new Error("Cursor's SDK listed no models for this account")
    modelCache = { models: catalog.models, defaultModel: catalog.defaultModel, fetchedAt: now() }
    return modelCache
  }

  function selectionFor(live: Pick<Live, "models">, settings: SessionSettings | undefined, fallback: string | undefined): SdkModelSelection {
    const requested = settings?.model ?? fallback ?? live.models[0]?.id
    const resolved = cursorSdkSelection({ ...settings, model: requested }, live.models)
    if (!resolved) throw new Error(`Cursor does not offer the model "${requested ?? ""}" to this account`)
    if (resolved.dropped.length > 0)
      hostLog("cursor-sdk", "settings the model does not offer were dropped", { options: resolved.dropped.join(",") })
    return resolved.selection
  }

  async function ensureSignedIn(live: Live, trace: ProviderLaunchTrace): Promise<void> {
    const snapshot = dependencies.auth.current ?? (await dependencies.auth.status())
    if (snapshot.state.status === "signed-in") return
    // A remembered "signed out" may be stale — the CLI may have logged in
    // since — so the key sources are resolved again before asking anyone.
    const fresh = await dependencies.auth.status(true)
    if (fresh.state.status === "signed-in") return
    const requestId = `${live.state.id}-authenticate-${now()}`
    const problem = fresh.state.problem?.message
    const response = await trace.step("human-sign-in", () => engine.ask(live, {
      id: requestId,
      sessionId: live.state.id,
      kind: "authentication",
      title: problem
        ? `${problem} Sign in with your Cursor account in the browser to continue, or paste an API key under Settings › Agents.`
        : "Cursor needs a sign-in before this thread can open. Sign in with your Cursor account in the browser, or paste an API key under Settings › Agents.",
      options: [{ optionId: "browser", name: "Sign in in the browser", kind: "allow_once" }],
    }))
    if (live.closed) throw new Error("Cursor was closed while waiting for sign-in")
    if (response.kind !== "choice" || response.optionId !== "browser")
      throw new Error("Cursor sign-in was declined; the thread was not opened")
    const after = await trace.step("human-sign-in", () => dependencies.auth.signInWithBrowser())
    if (after.state.status !== "signed-in") throw new Error("Cursor sign-in did not complete")
  }

  /** What `open` should copy first, when the thread being reopened is a `cursor-agent` store. */
  function importSource(options: ProviderStartOptions, cwd: string): SdkImportSource | undefined {
    if (!options.resume || !options.threadPath) return undefined
    const origin = cursorStoreOrigin(options.threadPath, { home: dependencies.home })
    if (!origin || origin.origin === "sdk") return undefined
    const source: SdkImportSource = {
      path: options.threadPath,
      identity: cursorLegacyIdentity(origin, options.resume),
      cwd,
    }
    if (options.title) source.name = options.title
    return source
  }

  const checkpoint = async (path: string): Promise<string | undefined> => {
    const origin = cursorStoreOrigin(path, { home: dependencies.home })
    if (!origin) return undefined
    if (origin.origin === "sdk") return cursorSdkCheckpoint(dependencies.stateRoot(), origin.directoryName)
    return cursorLegacyCheckpoint(path, origin.sessionId)
  }

  /**
   * A binding is reopened when its store still reads. An SDK agent is
   * Mako's own and another host's hold is refused upstream by the session
   * ledger; a `cursor-agent` store is only ever read here, so a CLI that
   * still has it open loses nothing when the SDK continues from a copy.
   */
  const resumeVerdict = async (binding: ProviderBinding): Promise<ResumeVerdict> => {
    if (!binding.nativeId || !binding.path)
      return { kind: "unavailable", reason: "The saved binding does not name a Cursor session store." }
    const origin = cursorStoreOrigin(binding.path, { home: dependencies.home })
    if (!origin)
      return { kind: "unavailable", reason: "The saved binding does not point at a Cursor session store." }
    const current = await checkpoint(binding.path)
    if (current === undefined)
      return { kind: "unavailable", reason: "The Cursor session store is missing or unreadable." }
    return { kind: "resumable", record: compareNativeCheckpoint(binding.checkpoint, current) }
  }

  return {
    provider: "cursor",
    approvalEvidence: { kind: "no-interactive-requests", reason: "Local SDK runs expose no interactive approval request or answer method. Native tool availability and workspace hooks enforce access." },
    observesNativeAgents: true,
    compaction: { kind: "unavailable", reason: "Cursor's SDK does not expose manual compaction. Start a new thread and carry over what matters." },
    canResume: true,
    checkpoint,
    resumeVerdict,
    // Verified 2026-09-13 (SDK 1.0.31): a steer delivered while `sleep 6 &&
    // echo two` ran completed that shell step after 1.7 s and the model
    // resumed with the steered text, so the SDK cuts the current step short
    // rather than waiting for it, the same as `cursor-agent acp` did.
    steering: "interrupt",
    modes: CURSOR_SDK_MODES,
    defaultMode: CURSOR_SDK_DEFAULT_MODE,
    available: () => true,
    start: (cwd, options) => traceProviderLaunch("cursor", options.conversationId, async trace => {
      if (!options.emit) throw new Error("A live event receiver is required")
      if (sessions.get(options.conversationId)?.closed === false)
        throw new Error("This Cursor binding is already connected")
      const env = await trace.step("account", () => dependencies.auth.childEnv())
  applyControlEnvironment(env, options.conversationTools?.control)
      const agentId = options.resume ?? options.conversationId
      const stateRoot = dependencies.stateRoot()
      const spawn: CursorSdkSpawnOptions = {
        owner: options.conversationId,
        cwd,
        env,
        onEvent: (event) => {
          if (live) receive(engine, live, event)
        },
      }
      const client = trace.sync("spawn", () => dependencies.client ? dependencies.client(spawn) : new CursorSdkClient(spawn))
      const live: Live = {
        client,
        emit: options.emit,
        onRejected: (message) => dependencies.auth.reportRejected(message),
        models: [],
        turn: null,
        projection: null,
        agents: new CursorAgents(),
        pendingPermissions: new Map(),
        closed: false,
        state: {
          id: options.conversationId,
          harness: "cursor",
          cwd,
          title: options.title,
          nativeId: agentId,
          nativePath: cursorSdkStorePath(stateRoot, agentId),
          status: "starting",
          connection: "starting",
          modes: [...CURSOR_SDK_MODES],
          currentMode: null,
          configOptions: [],
          settings: options.tuning,
        },
      }
      sessions.set(live.state.id, live)
      void live.client.exited.then(({ code, signal }) => {
        if (live.closed) return
        stop(engine, live)
        const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
        hostWarn("cursor-sdk", "child exited during a session", { conversation: live.state.id, detail })
        if (live.state.status === "running") settleTurn(engine, live, "error", `Cursor's SDK process exited (${detail})`)
        engine.patch(live, {
          status: live.state.status === "running" ? "failed" : live.state.status,
          connection: "disconnected",
          lastStop: live.state.status === "running" ? "failed" : live.state.lastStop,
          error: live.state.status === "running" ? `Cursor's SDK process exited (${detail})` : live.state.error,
        })
      })
      try {
        await trace.step("handshake", () => live.client.hello())
        await trace.step("authentication", () => ensureSignedIn(live, trace))
        const catalog = await trace.step("model-discovery", () => loadModels(live.client))
        live.models = catalog.models
        const selection = selectionFor(live, options.tuning, catalog.defaultModel)
        const importFrom = importSource(options, cwd)
        await trace.step("configuration", () => Promise.allSettled([
          migrateRetiredMakoMcpFile(
            join(dependencies.home ?? homedir(), ".cursor", "mcp.json")
          ),
          migrateRetiredMakoMcpFile(
            join(cwd, ".cursor", "mcp.json")
          ),
        ]))
        const servers = await trace.step("mcp-preparation", () => mcpServers(options))
        const opened = await trace.step(options.resume ? "session-resume" : "session-open", () => live.client.request("open", {
          cwd,
          stateRoot,
          agentId,
          create: !options.resume,
          name: options.title,
          model: selection,
          mcpServers: servers,
          importFrom,
        }))
        if (live.closed) throw new Error("Cursor disconnected during startup")
        const reported = opened.model ?? selection
        engine.patch(live, {
          status: "ready",
          connection: "connected",
          nativeId: opened.agentId,
          nativePath: cursorSdkStorePath(stateRoot, opened.agentId),
          currentMode: CURSOR_SDK_DEFAULT_MODE,
          settings: cursorSdkReportedSettings(reported, live.models),
          configOptions: configOptions(live.models, reported),
        })
        hostLog("cursor-sdk", opened.imported ? "imported and resumed a cursor-agent session" : options.resume ? "resumed agent" : "created agent", {
          conversation: options.conversationId,
          agent: opened.agentId,
          from: importFrom?.path ?? "",
          model: reported.id,
        })
        return live.state
      } catch (error) {
        stop(engine, live)
        sessions.delete(live.state.id)
        await live.client.close(2_000).catch(() => live.client.kill())
        if (error instanceof CursorSdkError) {
          if (error.kind === "authentication") dependencies.auth.reportRejected(error.message)
          throw new Error(error.message, { cause: error })
        }
        throw error
      }
    }),
    async prompt(id, text, attachments, settings, dispatch) {
      const { live, selection } = preparePrompt(dispatch, () => {
        const live = requireLive(id)
        if (live.state.status === "running") throw new Error("Cursor is already working")
        const merged: SessionSettings = {
          ...live.state.settings,
          ...settings,
          options: { ...live.state.settings?.options, ...settings?.options },
        }
        const selection = selectionFor(live, merged, live.state.settings?.model)
        return { live, selection }
      })
      const turn = dispatch.attemptId
      live.turn = turn
      live.projection = new CursorSdkProjection(turn)
      engine.patch(live, {
        status: "running",
        nativeRunId: undefined,
        lastStop: undefined,
        error: undefined,
        settings: cursorSdkReportedSettings(selection, live.models),
        configOptions: configOptions(live.models, selection),
      })
      engine.emitUpdate(live, { kind: "user", text })
      try {
        const images = promptImages(attachments)
        dispatch.report({ kind: "submitted", source: "transport-call", correlationId: turn })
        const sent = await live.client.request("send", {
          turn,
          text: promptText(text, attachments),
          images: images.length > 0 ? images : undefined,
          model: selection,
        })
        dispatch.report({ kind: "accepted", source: "native-response", referenceId: sent.runId })
        if (live.turn === turn) engine.patch(live, { nativeRunId: sent.runId })
      } catch (error) {
        if (live.turn === turn) {
          const message = error instanceof Error ? error.message : String(error)
          settleTurn(engine, live, "error", message)
          engine.patch(live, { status: "failed", lastStop: "failed", error: message })
        }
        throw error
      }
    },
    async steer(id, input): Promise<ProviderSteerResult> {
      const live = requireLive(id)
      if (live.state.status !== "running" || live.state.nativeRunId !== input.expectedRunId)
        return { kind: "not-accepted", reason: "The Cursor turn has already changed" }
      const result = await live.client.request("steer", { text: promptText(input.text, input.attachments) })
      if (result.outcome === "complete_delivered") {
        engine.emitUpdate(live, {
          kind: "user",
          text: input.text,
          steeringFor: input.expectedRunId,
        })
        return { kind: "accepted" }
      }
      return { kind: "not-accepted", reason: "Cursor could not fold the message into the running turn" }
    },
    async permission(id, requestId, response, dispatch) {
      dispatch.assertCurrent()
      dispatch.report(engine.respondPermission(id, requestId, response))
    },
    async setMode(id, modeId) {
      const live = requireLive(id)
      // Agent is the only mode, so there is nothing to reshape; an unknown
      // id is refused by name rather than quietly meaning the same thing.
      if (!isCursorSdkModeId(modeId)) throw new Error(`Cursor's SDK does not offer the mode "${modeId}"`)
      engine.patch(live, { currentMode: modeId })
    },
    async cancel(id) {
      const live = requireLive(id)
      if (live.state.status !== "running") return
      const turn = live.turn
      try {
        await live.client.request("cancel", undefined)
      } catch (error) {
        // A missing cancellation acknowledgement is not a stopped run. End
        // this provider process and let its exit mark the session disconnected
        // before another continuation can acquire the native session.
        await live.client.close(5_000).catch(() => live.client.kill())
        await live.client.exited
        throw error
      }
      // A successful cancellation acknowledgement may arrive before the
      // run's terminal event. Both establish that this turn has stopped.
      if (live.turn === turn && live.state.status === "running") {
        settleTurn(engine, live, "cancelled")
        engine.patch(live, { status: "ready", lastStop: "cancelled", error: undefined })
      }
    },
    async close(id) {
      const live = sessions.get(id)
      if (!live) return
      sessions.delete(id)
      if (live.closed) return
      stop(engine, live)
      await live.client.close(5_000).catch(() => live.client.kill())
    },
  }
}
