import { NO_NATIVE_PROMPT_IDENTITY } from "../../../contracts/native-prompt-identity.js"
import { applyControlEnvironment } from "../../../control-launch.js"
import { launchContext, observeNativeIdentity, reportedIdentity, reportedRuntime } from "../../../execution-context.js"
import { NO_NATIVE_EXCLUSION } from "../../../contracts/execution-context.js"
import { applyThreadEnvironment } from "../../../thread-environment.js"
import { preparePrompt, preparePromptAsync } from "../../prompt-dispatch.js"
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
import { appendPromptAttachments } from "@mako/sessions/prompt-attachments"
import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
import { mcpServerFailedEvent, messageEvent, TURN_FAILED } from "@mako/sessions/events"
import { CURSOR_PLAN_OPTION } from "@mako/sessions"
import type { ProviderBinding } from "../../../contracts/conversation-control.js"
import type { NativeResumeEvidence } from "../../../native-continuation.js"
import { inspectNativeSession as inspectNativeSource } from "../../../native-continuation.js"
import { cursorProcessProbe } from "../process-probe.js"
import { hostLog, hostWarn } from "../../../host-log.js"
import { traceProviderLaunch, type ProviderLaunchTrace } from "../../../provider-launch.js"
import {
  CONNECTION_LOST_STOP,
  RETRIES_EXHAUSTED_STOP,
  type LivePermissionResponse,
  type LiveSessionState,
  type PromptAttachment,
} from "../../../shared.js"
import { createLiveEngine, type LiveEngineApi } from "../../../live-engine.js"
import { unlaunchableMcpServers } from "../../../mcp-preflight.js"
import {
  conversationServers,
  type ProviderLiveDriver,
  type ProviderStartOptions,
  type ProviderSteerResult,
} from "../../live-driver.js"
import type { CursorSdkAuth, CursorSdkProbeClient, CursorSdkSpawnOptions } from "./auth.js"
import { CursorSdkClient, CursorSdkError } from "./client.js"
import { createCursorModelCache, type CursorModelCache } from "./models.js"
import { CURSOR_SDK_DEFAULT_MODE, CURSOR_SDK_MODES, isCursorSdkModeId } from "./modes.js"
import { cursorUnfinishedToolNote, type CursorSdkModelSelection, type CursorTurnOutcome } from "@mako/sessions/cursor-sdk-content"
import { cursorConfigOptions, CursorDecoder, type CursorEffect } from "./decoder.js"
import { deliverDecoded, type Decoded, type DecodedSink } from "../../../contracts/native-decoding.js"
import { nativeCapture, type NativeCapture } from "../../../native-capture.js"
import { cursorLegacyCheckpoint, cursorSdkCheckpoint } from "../resume.js"
import { migrateRetiredMakoMcpFile } from "../../../retired-mcp.js"
import type {
  SdkEvent,
  SdkImage,
  SdkImportSource,
  SdkMcpServer,
  SdkModelListItem,
  SdkRunResult,
} from "./wire.js"
import { cursorSdkExitReason } from "./wire.js"
/** What a live conversation needs from its child beyond a probe. */
export type CursorSdkLiveClient = CursorSdkProbeClient & Pick<CursorSdkClient, "exited" | "alive" | "kill">
const CURSOR_NATIVE_IDENTITY = { kind: "reported", via: "SDK child me" } as const

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
  modelCache?: CursorModelCache
}

interface Live {
  state: LiveSessionState
  client: CursorSdkLiveClient
  emit: NonNullable<ProviderStartOptions["emit"]>
  /** Tells the host's auth that Cursor refused the key this session ran under. */
  onRejected(message: string): void
  models: SessionModel[]
  turn: string | null
  decoder: CursorDecoder
  sink?: DecodedSink<CursorEffect>
  capture: NativeCapture | null
  /** Turns this driver ended; their late lines are never taken for a turn it lost track of. */
  settledTurns: Set<string>
  pendingPermissions: Map<string, (response: LivePermissionResponse) => void>
  closed: boolean
}

/** The SDK's own error codes for a dropped or exhausted connection. */
const CONNECTION_CODES = new Set(["unavailable", "canceled", "cancelled", "deadline_exceeded", "aborted"])
const CONNECTION_MESSAGE =
  /RetriableError|http\/2|HTTP\/2|RST_STREAM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|stream closed|network error|fetch failed/i

/**
 * SDK 1.0.31's words when its own retry loop gives up; neither carries a
 * code. Each attempt it made already re-ran the turn (without a checkpoint,
 * the whole message), so continuing it repeats that work once more and, in
 * practice, ends on the same error.
 */
const RETRIES_EXHAUSTED_MESSAGE = /^Connection failed repeatedly$|resume attempts made no progress/i

/** The SDK's `unauthenticated` code, or its wording, on a run's error. */
export function authenticationFailure(error: { message: string; code?: string } | undefined): boolean {
  if (!error) return false
  if (error.code && /^unauthenticated$|^permission_denied$/i.test(error.code)) return true
  return /unauthenticated|unauthorized|not authenticated|invalid api key|api key is required|401\b/i.test(error.message)
}

/** A run that ended on the SDK's own connection dropping, not on the model or the tools. */
export function connectionLost(result: SdkRunResult): boolean {
  if (result.status !== "error" || !result.error) return false
  if (retriesExhausted(result)) return false
  if (result.error.code && CONNECTION_CODES.has(result.error.code.toLowerCase())) return true
  return CONNECTION_MESSAGE.test(result.error.message)
}

/** A run the SDK's retry loop gave up on after re-running it. */
export function retriesExhausted(result: SdkRunResult): boolean {
  return result.status === "error" && !!result.error && RETRIES_EXHAUSTED_MESSAGE.test(result.error.message)
}

type Engine = LiveEngineApi<Live>

function promptImages(attachments: readonly PromptAttachment[]): SdkImage[] {
  const images: SdkImage[] = []
  for (const attachment of attachments)
    if (attachment.data && attachment.mimeType.startsWith("image/"))
      images.push({ data: attachment.data, mimeType: attachment.mimeType })
  return images
}

/** Files outside the SDK image transport retain typed metadata in native history. */
function promptText(text: string, attachments: readonly PromptAttachment[]): string {
  const files = attachments.filter((attachment) => attachment.path && !(attachment.data && attachment.mimeType.startsWith("image/")))
  if (files.length === 0) return text
  return appendPromptAttachments(text, files.map((file) => ({ name: file.name, mimeType: file.mimeType, path: file.path! })))
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
    for (const { name, url } of conversationServers(options.conversationTools))
      servers[name] = { type: "http", url, headers: { Authorization: `Bearer ${options.conversationTools.token}` } }
  return servers
}

const MAX_SETTLED_TURNS = 64

/** Ends the turn's projection, closing any tool row the run left open: with what its checkpoint kept, else a note. */
function settleTurn(engine: Engine, live: Live, outcome: CursorTurnOutcome, error?: string, settled?: SdkRunResult["settled"]): void {
  if (live.turn) {
    live.settledTurns.add(live.turn)
    if (live.settledTurns.size > MAX_SETTLED_TURNS)
      live.settledTurns.delete(live.settledTurns.values().next().value!)
  }
  live.turn = null
  deliver(engine, live, live.decoder.finish(outcome, cursorUnfinishedToolNote(outcome, error), settled))
}

function deliver(engine: Engine, live: Live, decoded: Decoded<CursorEffect>[]): void {
  live.sink ??= engine.sink(live, { effect: (effect) => engine.emitAgent(live, effect.agent) })
  deliverDecoded(decoded, live.sink)
}

/**
 * Shows a turn the child is running that this driver no longer tracks. The
 * child runs one turn at a time and answers for it until it ends, so its
 * lines are that turn's and never belong on another.
 */
function adoptTurn(engine: Engine, live: Live, turn: string, reason: string, runId?: string): void {
  live.turn = turn
  live.decoder.startTurn(turn)
  hostWarn("cursor-sdk", "showing a turn the host had lost track of", { conversation: live.state.id, turn })
  engine.patch(live, { status: "running", nativeRunId: runId, lastStop: undefined, error: undefined })
  engine.emitUpdate(live, { kind: "provider-turn", reason })
}

const ADOPTED_TURN = "Cursor was already working on this turn when Mako picked it up again."

/** A line for a turn this driver neither runs nor ended: adopt it when nothing else is running. */
function claimTurn(engine: Engine, live: Live, turn: string): boolean {
  if (turn === live.turn) return true
  if (live.turn !== null || live.settledTurns.has(turn)) return false
  adoptTurn(engine, live, turn, ADOPTED_TURN)
  return true
}

function finishTurn(engine: Engine, live: Live, result: SdkRunResult): void {
  settleTurn(engine, live, result.status, result.error?.message, result.settled)
  const plan = live.state.settings?.options?.plan
  const settings = result.model ? cursorSdkReportedSettings(result.model, live.models, plan) : live.state.settings
  const patch: Partial<LiveSessionState> = {
    settings,
    configOptions: result.model ? cursorConfigOptions(live.models, result.model, plan) : live.state.configOptions,
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
      // A dropped connection is continued by Mako itself; its failure is not the conversation's.
      if (!lost) engine.event(live, messageEvent(TURN_FAILED, message, "error"))
      Object.assign(patch, {
        status: "failed",
        lastStop: lost ? CONNECTION_LOST_STOP : retriesExhausted(result) ? RETRIES_EXHAUSTED_STOP : "failed",
        error: message.slice(0, 2000),
      })
      break
    }
  }
  engine.patch(live, patch)
}

function receive(engine: Engine, live: Live, event: SdkEvent): void {
  if (live.closed) return
  live.capture?.record(event)
  switch (event.event) {
    case "message":
    case "delta":
      if (!claimTurn(engine, live, event.turn) || !live.decoder.open) return
      deliver(engine, live, live.decoder.decode(event))
      return
    case "settled":
      if (!claimTurn(engine, live, event.turn) || !live.decoder.open) return
      deliver(engine, live, live.decoder.settle(event.calls))
      return
    case "result":
      if (!claimTurn(engine, live, event.turn)) return
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
  const modelCache = dependencies.modelCache ?? createCursorModelCache(dependencies.now)

  const now = () => dependencies.now?.() ?? Date.now()

  function requireLive(id: string): Live {
    const live = sessions.get(id)
    if (!live || live.closed) throw new Error("This Cursor session is disconnected")
    return live
  }

  async function loadModels(client: CursorSdkLiveClient, env: NodeJS.ProcessEnv) {
    const list = await modelCache(env, () => dependencies.models
      ? dependencies.models(client)
      : client.request("models", undefined).then(result => result.models))
    const catalog = normalizeCursorSdkModels(list)
    if (catalog.models.length === 0) throw new Error("Cursor's SDK listed no models for this account")
    return catalog
  }

  function selectionFor(live: Pick<Live, "models">, settings: SessionSettings | undefined, fallback: string | undefined): CursorSdkModelSelection {
    const requested = settings?.model ?? fallback ?? live.models[0]?.id
    const resolved = cursorSdkSelection({ ...settings, model: requested }, live.models)
    if (!resolved) throw new Error(`Cursor does not offer the model "${requested ?? ""}" to this account`)
    if (resolved.dropped.length > 0)
      hostLog("cursor-sdk", "settings the model does not offer were dropped", { options: resolved.dropped.join(",") })
    return resolved.selection
  }

  async function ensureSignedIn(live: Live, trace: ProviderLaunchTrace, account: boolean): Promise<void> {
    // A selected account brings its own key; Cursor answers for it on open.
    if (account) return
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
      identity: cursorLegacyIdentity(origin, options.resume, dependencies.home ?? homedir()),
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
   * SDK-store resume requires source-scoped process evidence in addition to
   * the cooperating-host ledger. A `cursor-agent` store is only read here, so a CLI that
   * still has it open loses nothing when the SDK continues from a copy.
   */
  const inspectNativeSession = async (binding: ProviderBinding): Promise<NativeResumeEvidence> => {
    if (!binding.nativeId || !binding.path)
      return { kind: "unavailable", reason: "The saved binding does not name a Cursor session store." }
    const origin = cursorStoreOrigin(binding.path, { home: dependencies.home })
    if (!origin)
      return { kind: "unavailable", reason: "The saved binding does not point at a Cursor session store." }
    const sourcePath = binding.path
    if (origin.origin === "sdk") return inspectNativeSource(binding, cursorProcessProbe, async () => {
      const current = await checkpoint(sourcePath)
      return current === undefined
        ? { kind: "unavailable", reason: "The Cursor session store is missing or unreadable." }
        : { kind: "available", checkpoint: current }
    })
    const current = await checkpoint(binding.path)
    if (current === undefined)
      return { kind: "unavailable", reason: "The Cursor session store is missing or unreadable." }
    return { kind: "available", checkpoint: current, strategy: "copy" }
  }

  return {
    provider: "cursor",
    launchEnvironment: { kind: "prepared", via: "SDK auth resolves its credential over the admitted account environment." },
    compaction: { kind: "automatic", reason: "Cursor summarizes the conversation on its server when the context fills, and the summary shows in the thread. Cursor accepts a summarize request from a local run, but SDK 1.0.31 has no way to send one." },
    approvalEvidence: { kind: "no-interactive-requests", reason: "Local SDK runs expose no interactive approval request or answer method. Native tool availability and workspace hooks enforce access." },
    planning: { via: "setting", option: CURSOR_PLAN_OPTION.id, proposal: "createPlan's `plan` argument, built by a message that asks for the implementation",
      feedback: { kind: "next-message", reason: "createPlan asks nothing, so the turn ends with the plan." } },
    nativeAgents: { kind: "observed", via: "`task` tool calls and the subagent runs they start." },
    questions: { kind: "unavailable", reason: "Cursor doesn't offer its model `askQuestion` in a local SDK run, in agent or Plan mode, even when the run asks for the tool by name. A question that did come would be declined by the SDK itself." },
    contextBreakdown: { kind: "unavailable", reason: "The SDK reports a run's token usage, not what fills the context." },
    modeSwitching: { kind: "single", reason: "The SDK runs one mode, agent; Plan is a setting chosen with each message." },
    fork: { kind: "import", via: "Mako writes the conversation up to the fork point into a new agent in the SDK's store and resumes it, as the SDK has no fork of its own." },
    // Verified 2026-09-27 (SDK 1.0.31): a shell the SDK moved to the
    // background completed its call and died as its run finished; the local
    // executor disposes every shell it started when the run ends.
    backgroundStop: { kind: "ends-with-turn", evidence: "The local SDK disposes the shells a run started when the run ends, and a run stays running while a subagent it started works, so neither outlives its turn, and Stop ends the run." },
    turnRecovery: {
      kind: "continues",
      accepted: "The run ID the SDK returns for the sent message.",
      exit: "The SDK child's exit, unless Mako closed it, settles the running turn and the session failed and disconnected in one update.",
      tests: ["scripts/test-turn-recovery-live.mjs"],
    },
    resume: {
      kind: "native",
      via: "`Agent.resume` over the SDK's local store; a `cursor-agent` store is imported into it first.",
      wake: "The next message starts a new SDK child that resumes the agent; a run its killed child left active is expired by the next one (`run-records.ts`).",
      checkpoint,
      inspect: inspectNativeSession,
      elsewhere: {
        via: "The SDK child files the agent under the new folder in its store (`relocateCursorAgent`), which finds an agent only under its own folder, then `Agent.resume`.",
        verified: "scripts/test-cursor-relocate.ts against SDK 1.0.31: not found from another folder as saved, resumed there with its checkpoint once filed; with real turns, the moved agent remembered its turn and its shell ran in the new folder after running in the old one.",
      },
    },
    nativeIdentity: CURSOR_NATIVE_IDENTITY,
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    modes: CURSOR_SDK_MODES,
    defaultMode: CURSOR_SDK_DEFAULT_MODE,
    available: () => true,
    start: (cwd, options) => traceProviderLaunch("cursor", options.conversationId, async trace => {
      if (!options.emit) throw new Error("A live event receiver is required")
      if (sessions.get(options.conversationId)?.closed === false)
        throw new Error("This Cursor binding is already connected")
      const launch = await trace.step("account", () => dependencies.auth.childLaunch(options.accountLaunch?.env))
      const accountEnvironment = launch.env
      const env = { ...accountEnvironment }
      applyControlEnvironment(env, options.conversationTools?.control)
      applyThreadEnvironment(env, options.threadEnvironment)
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
      const context = launchContext("cursor-sdk-child", CURSOR_NATIVE_IDENTITY, options.accountLaunch?.account)
      context.credential = launch.credential
      const account = launch.credential.kind === "configured" && launch.credential.source === "account"
      // A selected account's refused key is that account's to sign in again,
      // not a reason to call Cursor's own login signed out.
      const rejected = (message: string) => {
        if (!account) dependencies.auth.reportRejected(message)
      }
      const live: Live = {
        client,
        emit: options.emit,
        onRejected: rejected,
        models: [],
        turn: null,
        decoder: new CursorDecoder({ get models() { return live.models }, get state() { return live.state } }),
        capture: nativeCapture("cursor", options.conversationId, () => ({ settings: { model: options.tuning?.model ?? null } })),
        settledTurns: new Set(),
        pendingPermissions: new Map(),
        closed: false,
        state: {
          executionContext: context,
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
      void live.client.exited.then(({ code, signal, fatal }) => {
        if (live.closed) return
        stop(engine, live)
        const exit = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
        const detail = fatal ? `${fatal}, ${exit}` : exit
        hostWarn("cursor-sdk", "child exited during a session", { conversation: live.state.id, detail, reason: fatal ?? (signal ? undefined : cursorSdkExitReason(code)) })
        if (live.state.status === "running") {
          settleTurn(engine, live, "error", `Cursor's SDK process exited (${detail})`)
          engine.event(live, messageEvent(TURN_FAILED, `Cursor's SDK process exited (${detail})`, "error"))
        }
        engine.patch(live, {
          status: live.state.status === "running" ? "failed" : live.state.status,
          connection: "disconnected",
          lastStop: live.state.status === "running" ? "failed" : live.state.lastStop,
          error: live.state.status === "running" ? `Cursor's SDK process exited (${detail})` : live.state.error,
        })
      })
      try {
        const hello = await trace.step("handshake", () => live.client.hello())
        engine.patch(live, { executionContext: {
          ...context,
          runtime: reportedRuntime(hello.sdkVersion, "SDK child hello.sdkVersion"),
        } })
        if (hello.ripgrep === false)
          hostWarn("cursor-sdk", "the child has no bundled ripgrep; Grep and Glob need one on PATH", { conversation: live.state.id })
        await trace.step("authentication", () => ensureSignedIn(live, trace, account))
        const identityObservation = observeNativeIdentity(async () => {
          const identity = await live.client.request("me", undefined)
          return reportedIdentity(identity.email, "cursor", CURSOR_NATIVE_IDENTITY.via)
        }, () => !live.closed && sessions.get(live.state.id) === live, identity => {
          if (live.state.executionContext) engine.patch(live, { executionContext: { ...live.state.executionContext, identity } })
        })
        const catalog = await trace.step("model-discovery", () => loadModels(live.client, accountEnvironment))
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
        await identityObservation
        if (live.closed) throw new Error("Cursor disconnected during identity verification")
        const reported = opened.model ?? selection
        engine.patch(live, {
          status: "ready",
          connection: "connected",
          nativeId: opened.agentId,
          nativePath: cursorSdkStorePath(stateRoot, opened.agentId),
          executionContext: live.state.executionContext && {
            ...live.state.executionContext,
            sourceImport: opened.importSource ? {
              source: opened.importSource,
              destination: cursorSdkStorePath(stateRoot, opened.agentId),
              nativeId: opened.agentId,
              via: "SDK child open.importSource",
              revision: opened.importRevision,
            } : undefined,
          },
          currentMode: CURSOR_SDK_DEFAULT_MODE,
          settings: cursorSdkReportedSettings(reported, live.models, options.tuning?.options?.plan),
          configOptions: cursorConfigOptions(live.models, reported, options.tuning?.options?.plan),
        })
        // Cursor's SDK says nothing about its MCP servers; this is the failure
        // Mako can name for it, in the words the other harnesses use.
        const stdio = Object.entries(servers).map(([name, server]) => (server.type === "stdio" ? { name, command: server.command, env: server.env } : { name }))
        for (const name of unlaunchableMcpServers(stdio, cwd))
          engine.event(live, mcpServerFailedEvent(name, "could not be launched"))
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
          if (error.kind === "authentication") rejected(error.message)
          throw new Error(error.message, { cause: error })
        }
        throw error
      }
    }),
    async prompt(id, text, attachments, settings, dispatch) {
      await preparePromptAsync(dispatch, async () => {
        const live = requireLive(id)
        if (live.state.status === "running") throw new Error("Cursor is already working")
        // The child runs one turn at a time. One it is still running here
        // was lost by this driver; it is shown, and this message is refused
        // before anything is sent so the host keeps it queued behind it.
        const running = await live.client.request("active", undefined)
        if (!running.turn) return
        if (running.starting || live.settledTurns.has(running.turn))
          throw new Error("Cursor is still ending the previous turn. Send the message again in a moment.")
        if (live.turn !== running.turn) adoptTurn(engine, live, running.turn, ADOPTED_TURN, running.runId)
        else engine.patch(live, { nativeRunId: running.runId })
        throw new Error(running.truncated
          ? "Cursor was still running an earlier turn. Mako shows it again from where its saved output starts; your message is sent when it finishes."
          : "Cursor was still running an earlier turn. Mako shows it again; your message is sent when it finishes.")
      })
      const { live, selection, plan } = preparePrompt(dispatch, () => {
        const live = requireLive(id)
        if (live.state.status === "running") throw new Error("Cursor is already working")
        const merged: SessionSettings = {
          ...live.state.settings,
          ...settings,
          options: { ...live.state.settings?.options, ...settings?.options },
        }
        const selection = selectionFor(live, merged, live.state.settings?.model)
        return { live, selection, plan: merged.options?.plan === true }
      })
      const turn = dispatch.attemptId
      live.turn = turn
      live.decoder.startTurn(turn)
      engine.patch(live, {
        status: "running",
        nativeRunId: undefined,
        lastStop: undefined,
        error: undefined,
        settings: cursorSdkReportedSettings(selection, live.models, plan),
        configOptions: cursorConfigOptions(live.models, selection, plan),
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
          plan,
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
    // Verified 2026-09-13 (SDK 1.0.31): a steer delivered while `sleep 6 &&
    // echo two` ran completed that shell step after 1.7 s and the model
    // resumed with the steered text, so the SDK cuts the current step short
    // rather than waiting for it, the same as `cursor-agent acp` did.
    steering: { kind: "supported", lands: "interrupt", via: "A message sent while a run works cuts its current step short and the model continues with it.", async steer(id, input): Promise<ProviderSteerResult> {
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
    } },
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
