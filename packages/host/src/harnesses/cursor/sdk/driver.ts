import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { NO_NATIVE_PROMPT_IDENTITY } from "../../../contracts/native-prompt-identity.js"
import { applyControlEnvironment } from "../../../control/index.js"
import { launchContext, observeNativeIdentity, reportedIdentity, reportedRuntime } from "../../../base/execution-context.js"
import { NO_NATIVE_EXCLUSION } from "../../../contracts/execution-context.js"
import { untilStopped } from "../../../contracts/live-side-questions.js"
import { applyThreadEnvironment } from "../../../workspaces/index.js"
import { preparePrompt, preparePromptAsync, TurnInProgressError } from "../../prompt-dispatch.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { cursorLegacyIdentity, cursorSdkReportedSettings, cursorSdkSelection, cursorSdkStorePath, cursorStoreOrigin, normalizeCursorSdkModels, CURSOR_PLAN_OPTION } from "@mako/sessions"
import { appendPromptAttachments } from "@mako/sessions/prompt-attachments"
import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
import { mcpServerFailedEvent, messageEvent, TURN_FAILED } from "@mako/sessions/events"
import type { ProviderBinding } from "../../../contracts/conversation-control.js"
import type { NativeResumeEvidence } from "../../native-continuation.js"
import { inspectNativeSession as inspectNativeSource } from "../../native-continuation.js"
import { cursorProcessProbe } from "../process-probe.js"
import { hostLog, hostWarn } from "../../../base/host-log.js"
import { errorMessage } from "../../../base/error-message.js"
import type { ProviderLaunchTrace } from "../../provider-launch.js"
import { CONNECTION_LOST_STOP, RETRIES_EXHAUSTED_STOP, type LivePermissionResponse, type LiveSessionState, type PromptAttachment } from "../../../contracts/providers-acp.js"
import { createLiveEngine, type LiveEngineApi } from "../../live-engine.js"
import { acpMcpServers, unlaunchableMcpServers, migrateRetiredMakoMcpFile } from "../../../tools/index.js"
import {
  conversationServers,
  UNATTENDED_SIGN_IN,
  type ProviderLiveDriver,
  type ProviderStartOptions,
  type ProviderSteerResult,
} from "../../live-driver.js"
import type { CursorSdkAuth, CursorSdkProbeClient, CursorSdkSpawnOptions } from "./auth.js"
import { CursorSdkClient, CursorSdkError, cursorSdkPackages } from "./client.js"
import { createCursorModelCache, cursorSettings, type CursorModelCache } from "./models.js"
import { CURSOR_SDK_DEFAULT_MODE, CURSOR_SDK_MODES, isCursorSdkModeId } from "./modes.js"
import type { CursorSdkModelSelection, CursorTurnOutcome } from "@mako/sessions/cursor-sdk-content"
import { cursorConfigOptions, CursorDecoder, type CursorEffect } from "./decoder.js"
import { deliverDecoded, type Decoded, type DecodedSink } from "../../../contracts/native-decoding.js"
import { nativeStream, streamRuntime, withFrame, type NativeStream } from "../../native-stream.js"
import { cursorLegacyCheckpoint, cursorSdkCheckpoint } from "../resume.js"
import { cursorForkDeclined } from "./fork.js"
import type {
  SdkEvent,
  SdkImage,
  SdkImportSource,
  SdkMcpServer,
  SdkModelListItem,
  SdkResult,
  SdkRunResult,
} from "./wire.js"
import { cursorSdkExitReason } from "./wire.js"
/** What a live conversation needs from its child beyond a probe. */
export type CursorSdkLiveClient = CursorSdkProbeClient & Pick<CursorSdkClient, "exited" | "alive" | "kill"> & Partial<Pick<CursorSdkClient, "adopt">>
const CURSOR_NATIVE_IDENTITY = { kind: "reported", via: "SDK child me" } as const

/**
 * How long the run-ahead's child waits for the start that takes it: a cloud machine boots on the first keystroke of
 * its Thread's first message, which may take minutes to write.
 */
const AHEAD_HOLD_MS = 10 * 60_000
/**
 * How long a start waits for the stage after sign-in still asking on the child it takes, before it stops that child
 * and spawns its own: the stage's question normally answers within 1.5 s of being asked. On a copy one never answered,
 * and the start that joined it waited 20 s (2026-10-20).
 */
const AHEAD_ASKING_MS = 3_000

interface Ahead {
  /** The environment it was spawned with: only a start whose account environment is this one takes it. */
  env: NodeJS.ProcessEnv
  /** Its SDK loaded and its answer to `hello`, or undefined when it didn't answer. */
  ready: Promise<{ client: CursorSdkLiveClient; hello: SdkResult<"hello"> } | undefined>
  /** The stage after sign-in asking on it, settled either way; a start takes it only once that has settled. */
  asking?: Promise<void>
  /** Makes it a start's: nothing here stops it from then on. */
  claim(): void
  /** Stops it, unless a start claimed it. */
  release(): void
}

/** A promise's outcome, kept for later without an unhandled rejection meanwhile. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: Error }
function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }))
}
/** The value, or the rejection again. */
async function outcome<T>(promise: Promise<Settled<T>>): Promise<T> {
  const result = await promise
  if (result.ok) return result.value
  throw result.error
}

/** Two environments alike in every variable they set. */
function sameEnvironment(left: NodeJS.ProcessEnv, right: NodeJS.ProcessEnv): boolean {
  const entries = (env: NodeJS.ProcessEnv) => JSON.stringify(Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))
  return entries(left) === entries(right)
}

export interface CursorSdkDriverDependencies {
  auth: CursorSdkAuth
  stateRoot(): string
  /** How this host opens Cursor's stores; the child is told the same. */
  stores: NativeStores
  /** The user's home, for recognising `cursor-agent` stores; tests point it at a fixture. */
  home?: string
  /** Test hook: another client than the real child. */
  client?(options: CursorSdkSpawnOptions): CursorSdkLiveClient
  /** Test hook: a model list without a child. */
  models?(client: CursorSdkProbeClient): Promise<SdkModelListItem[]>
  now?(): number
  modelCache?: CursorModelCache
  /** Where streams go (`HarnessContext.streams`); without it none are written. */
  streams?: string
  /** Where `kill -USR2 <pid>` writes a conversation child's heap snapshot; without it the signal is not armed. */
  heapSnapshots?: string
}

interface Live {
  state: LiveSessionState
  client: CursorSdkLiveClient
  emit: ProviderStartOptions["emit"]
  /** Tells the host's auth that Cursor refused the key this session ran under. */
  onRejected(message: string): void
  models: SessionModel[]
  turn: string | null
  decoder: CursorDecoder
  sink?: DecodedSink<CursorEffect>
  stream: NativeStream<SdkEvent> | null
  /** Turns this driver ended; their late lines are never taken for a turn it lost track of. */
  settledTurns: Set<string>
  pendingPermissions: Map<string, (response: LivePermissionResponse) => void>
  /** Where each side answer being written takes its text. */
  sides: Map<string, (text: string) => void>
  closed: boolean
}

/** The SDK's own error codes for a dropped or exhausted connection. */
const CONNECTION_CODES = new Set(["unavailable", "canceled", "cancelled", "deadline_exceeded", "aborted"])
const CONNECTION_MESSAGE =
  /RetriableError|http\/2|HTTP\/2|RST_STREAM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|stream closed|network error|fetch failed/i

/**
 * The SDK's words when its own retry loop gives up (1.0.31 through 1.2.0);
 * neither carries a code. Each attempt it made already re-ran the turn
 * (without a checkpoint, the whole message), so continuing it repeats that
 * work once more and, in practice, ends on the same error.
 */
const TRANSPORT_RETRIES_EXHAUSTED_MESSAGE = /^Connection failed repeatedly$/i
const RESUMES_MADE_NO_PROGRESS_MESSAGE = /resume attempts made no progress/i

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
  return result.status === "error" && !!result.error &&
    (TRANSPORT_RETRIES_EXHAUSTED_MESSAGE.test(result.error.message) || RESUMES_MADE_NO_PROGRESS_MESSAGE.test(result.error.message))
}

/**
 * A run that gave up resuming after the agent's turn had ended, with the
 * answer delivered. A stream error after `turn-ended` makes the SDK resume
 * from an older checkpoint inside the same run; each resume re-streams the
 * closing and ends the turn again, and two that save nothing end the run with
 * the no-progress error. The turn finished, and its last ending is the answer
 * on screen. A transport give-up stays a failure, because those retries
 * resend the action and re-run its tools.
 */
export function resumesFailedAfterAnswer(result: SdkRunResult): boolean {
  return result.status === "error" && result.turnEnded === true && RESUMES_MADE_NO_PROGRESS_MESSAGE.test(result.error?.message ?? "")
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
/**
 * Ends the turn the decoder holds. `observed`: the host ended it from what it
 * saw itself (the child exiting), which no frame says, so the stream keeps
 * what it draws (`NativeStream.drawn`) and a replay draws the same.
 */
function settleTurn(engine: Engine, live: Live, outcome: CursorTurnOutcome, error?: string, settled?: SdkRunResult["settled"], observed = false): void {
  if (live.turn) {
    live.settledTurns.add(live.turn)
    if (live.settledTurns.size > MAX_SETTLED_TURNS)
      live.settledTurns.delete(live.settledTurns.values().next().value!)
  }
  live.turn = null
  const decoded = live.decoder.finish(outcome, error, settled)
  if (observed)
    for (const item of decoded) if (item.kind === "update") live.stream?.drawn(JSON.parse(JSON.stringify(item.update)))
  deliver(engine, live, decoded)
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

function finishTurn(engine: Engine, live: Live, reported: SdkRunResult): void {
  const answered = resumesFailedAfterAnswer(reported)
  if (answered) hostWarn("cursor-sdk", "the SDK's resumes after the turn ended made no progress; the turn finished", { conversation: live.state.id, error: reported.error?.message ?? "" })
  const result: SdkRunResult = answered ? { ...reported, status: "finished", error: undefined } : reported
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
  withFrame(live.stream?.record(event), () => received(engine, live, event))
}

function received(engine: Engine, live: Live, event: SdkEvent): void {
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
    case "context":
      deliver(engine, live, live.decoder.context(event))
      return
    case "compaction":
      deliver(engine, live, live.decoder.archived(event))
      return
    case "side-delta":
      live.sides.get(event.side)?.(event.text)
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
  live.stream?.closed()
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
  /**
   * The child the start run ahead spawned, as a session's is spawned, kept with its SDK loaded: the stage after sign-in
   * asks on it (a third child loading the SDK beside the run-ahead's and the session's held a quick start up by 1 s on
   * a 2-vCPU machine, 2026-10-20), and the start takes it as its own (`take`), its SDK loaded and its connection made.
   */
  let ahead: Ahead | undefined

  /** A child as every session's is spawned, the run-ahead's included. */
  function spawnChild(env: NodeJS.ProcessEnv, cwd: string, owner: string, onEvent: CursorSdkSpawnOptions["onEvent"] = () => undefined): CursorSdkLiveClient {
    const spawn: CursorSdkSpawnOptions = { owner, cwd, env, onEvent }
    return dependencies.client ? dependencies.client(spawn) : new CursorSdkClient({ ...spawn, heapSnapshots: dependencies.heapSnapshots })
  }

  /**
   * The run-ahead's child made the session's: once loaded, it takes the session's environment and folder before any
   * agent opens. Undefined when it didn't load or can't be taken; a session then spawns its own, as without it.
   */
  async function adopt(held: Ahead, spawn: CursorSdkSpawnOptions): Promise<{ client: CursorSdkLiveClient; hello: SdkResult<"hello"> } | undefined> {
    const ready = await held.ready
    if (!ready) return undefined
    // Taken only while it's asking nothing: its environment is replaced under no question in flight.
    if (held.asking) {
      let timer: NodeJS.Timeout | undefined
      const asked = await Promise.race([held.asking.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), AHEAD_ASKING_MS) })])
      clearTimeout(timer)
      if (!asked) {
        hostWarn("cursor-sdk", "the child run ahead was still asking Cursor for the account's models; stopping it and spawning the session's own", { conversation: spawn.owner, waitedMs: AHEAD_ASKING_MS })
        ready.client.kill()
        // Its question fails with it, and leaves the model cache before the start asks its own.
        await held.asking
        return undefined
      }
    }
    if (!ready.client.alive || !ready.client.adopt) {
      ready.client.kill()
      return undefined
    }
    try {
      await ready.client.adopt({ owner: spawn.owner, cwd: spawn.cwd, env: spawn.env, onEvent: spawn.onEvent })
      return ready
    } catch (error) {
      hostWarn("cursor-sdk", "the child run ahead couldn't be taken; spawning the session's own", { conversation: spawn.owner, error: errorMessage({ error }) })
      ready.client.kill()
      return undefined
    }
  }

  /**
   * The run-ahead's child, for a start whose account environment is the one it was spawned with: the same credential,
   * settings and everything else, so it differs from a child spawned for the session only by what `adopt` gives it.
   * Any other start stops it.
   */
  function take(accountEnvironment: NodeJS.ProcessEnv): Ahead | undefined {
    const held = ahead
    if (!held) return undefined
    if (!sameEnvironment(held.env, accountEnvironment)) {
      held.release()
      return undefined
    }
    held.claim()
    return held
  }

  /** Asks the account's models on `client`, kept for `env`'s credential, where the start finds them. */
  async function askAhead(client: CursorSdkProbeClient, env: NodeJS.ProcessEnv): Promise<void> {
    await loadModels(client, env)
  }

  const now = () => dependencies.now?.() ?? Date.now()

  function requireLive(id: string): Live {
    const live = sessions.get(id)
    if (!live || live.closed) throw new Error("This Cursor session is disconnected")
    return live
  }

  async function loadModels(client: CursorSdkProbeClient, env: NodeJS.ProcessEnv, refresh = false) {
    const list = await modelCache(env, () => dependencies.models
      ? dependencies.models(client)
      : client.request("models", undefined).then(result => result.models), refresh)
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

  /** Resolves whether a person had to sign in, after which what was asked before is another account's. */
  async function ensureSignedIn(live: Live, trace: ProviderLaunchTrace, account: boolean, apiKey: string | undefined, unattended: boolean | undefined): Promise<boolean> {
    // A selected account brings its own key; Cursor answers for it on open.
    if (account) return false
    // Asked, when no answer is kept, of the session's own child, which runs under the key the answer is about.
    const on = { client: live.client, apiKey }
    const snapshot = dependencies.auth.current ?? (await dependencies.auth.status(false, on))
    if (snapshot.state.status === "signed-in") return false
    // A remembered "signed out" may be stale — the CLI may have logged in
    // since — so the key sources are resolved again before asking anyone.
    const fresh = await dependencies.auth.status(true, on)
    if (fresh.state.status === "signed-in") return false
    if (unattended) throw new Error(UNATTENDED_SIGN_IN)
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
    return true
  }

  /** What `open` should copy first, when the thread being reopened is a `cursor-agent` store. */
  function importSource(options: ProviderStartOptions, cwd: string): SdkImportSource | undefined {
    if (!options.resume || !options.threadPath) return undefined
    const origin = cursorStoreOrigin(options.threadPath, { stateRoot: dependencies.stateRoot(), home: dependencies.home })
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
    const origin = cursorStoreOrigin(path, { stateRoot: dependencies.stateRoot(), home: dependencies.home })
    if (!origin) return undefined
    if (origin.origin === "sdk") return cursorSdkCheckpoint(dependencies.stores, dependencies.stateRoot(), origin.directoryName)
    return cursorLegacyCheckpoint(dependencies.stores, path, origin.sessionId)
  }

  /**
   * SDK-store resume requires source-scoped process evidence in addition to
   * the cooperating-host ledger. A `cursor-agent` store is only read here, so a CLI that
   * still has it open loses nothing when the SDK continues from a copy.
   */
  const inspectNativeSession = async (binding: ProviderBinding): Promise<NativeResumeEvidence> => {
    if (!binding.nativeId || !binding.path)
      return { kind: "unavailable", reason: "The saved binding does not name a Cursor session store." }
    const origin = cursorStoreOrigin(binding.path, { stateRoot: dependencies.stateRoot(), home: dependencies.home })
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
    compaction: { kind: "automatic", reason: "Cursor summarizes the conversation on its server when the context fills, and the summary shows in the thread. SDK 1.2.0 can ask for one (`Agent.summarize()`), which Mako doesn't send yet." },
    goals: { kind: "mako", reason: "SDK 1.2.0 has no goal to set or read; Cursor's own goal tools stay inside its agent." },
    review: { kind: "mako", reason: "Cursor's SDK has no review; Bugbot reviews pull requests on Cursor's servers." },
    sideQuestions: {
      kind: "fork",
      via: "SDK 1.2.0 has no side question, so Mako copies the agent's store to a new agent, resumes it with read-only tools and asks it there; closing the side conversation deletes the copy.",
      async ask(id, { side, question, earlier, stream, signal }) {
        const live = requireLive(id)
        live.sides.set(side, stream)
        const stop = () => void live.client.request("sideStop", { side }).catch(() => undefined)
        signal.addEventListener("abort", stop, { once: true })
        try {
          return (await untilStopped(live.client.request("side", { side, question, earlier: [...earlier] }), signal)).text
        } finally {
          signal.removeEventListener("abort", stop)
          live.sides.delete(side)
        }
      },
      async close(id, side) {
        const live = sessions.get(id)
        if (live && !live.closed) await live.client.request("sideClose", { side })
      },
    },
    approvalEvidence: { kind: "no-interactive-requests", reason: "Local SDK runs expose no interactive approval request or answer method. Native tool availability and workspace hooks enforce access." },
    planning: { via: "setting", option: CURSOR_PLAN_OPTION.id, proposal: "createPlan's `plan` argument, built by a message that asks for the implementation",
      feedback: { kind: "next-message", reason: "createPlan asks nothing, so the turn ends with the plan." } },
    nativeAgents: { kind: "observed", via: "`task` tool calls and the subagent runs they start." },
    questions: { kind: "unavailable", reason: "Cursor doesn't offer its model `askQuestion` in a local SDK run, in agent or Plan mode, even when the run asks for the tool by name. A question that did come would be declined by the SDK itself." },
    contextBreakdown: {
      kind: "itemized",
      via: "Each checkpoint's `token_details.breakdown`: Cursor's own estimate by category (system prompt, tools, rules, skills, MCP, subagents, conversation), summing to its reading.",
      read(id) {
        const breakdown = requireLive(id).decoder.breakdown
        return breakdown ? Promise.resolve(breakdown) : Promise.reject(new Error("Cursor has not measured this session's context yet; it does after the next model call."))
      },
    },
    modeSwitching: { kind: "single", reason: "The SDK runs one mode, agent; Plan is a setting chosen with each message." },
    // Verified 2026-10-16 (SDK 1.0.31, `scripts/test-cursor-fork.ts`): each
    // run records the root it checkpointed last, the next run starts from
    // it, and a new agent indexed at a first run's root, its store a clone of
    // the source's, was resumed by the SDK and recalled the first turn's
    // codeword and not the second's.
    fork: {
      kind: "native",
      point: "run",
      via: "A new SDK agent whose store is a clone of the source's blobs and whose index row starts at the root the run checkpointed last (`runs.latest_checkpoint_ref_json`), resumed with `Agent.resume`.",
      declines: (source) => Promise.resolve(cursorForkDeclined(dependencies.stores, dependencies.stateRoot(), source)),
    },
    // Verified 2026-09-27 (SDK 1.0.31): a shell the SDK moved to the
    // background completed its call and died as its run finished; the local
    // executor disposes every shell it started when the run ends.
    backgroundStop: { kind: "ends-with-turn", evidence: "The local SDK disposes the shells a run started when the run ends, and a run stays running while a subagent it started works, so neither outlives its turn, and Stop ends the run." },
    startPrefetch: {
      via: "The SDK's child, spawned as a session spawns it, until it answers `hello` with the SDK loaded, with the SDK's packages read alongside, and kept; once signed in, the account's models (1.3–1.5 s of a start, 2026-10-20), asked on that child and kept an hour for the start.",
      files: async () => cursorSdkPackages(),
      // A start that comes while it loads takes it as it is (`take`), so its stop is not this run's to act on.
      run: async (env, cwd, owner) => {
        ahead?.release()
        const client = spawnChild(env, cwd, owner)
        let claimed = false
        const held: Ahead = {
          env,
          ready: client.hello().then((hello) => ({ client, hello }), () => undefined),
          claim: () => {
            claimed = true
            clearTimeout(timer)
            if (ahead === held) ahead = undefined
          },
          release: () => {
            clearTimeout(timer)
            if (ahead === held) ahead = undefined
            if (!claimed) void client.close(2_000).catch(() => undefined)
          },
        }
        const timer = setTimeout(held.release, AHEAD_HOLD_MS)
        timer.unref()
        ahead = held
        const ready = await held.ready
        if (!ready) held.release()
        return ready !== undefined
      },
      signedIn: async (base) => {
        const { env } = await dependencies.auth.childLaunch(base)
        const held = ahead
        // The held child runs as the sign-in it was spawned with: a key resolved since is another account's.
        if (held && JSON.stringify(cursorSettings(held.env)) !== JSON.stringify(cursorSettings(env))) held.release()
        else if (held) {
          const ready = await held.ready
          // A start that took it meanwhile asks for itself: nothing is asked on a session's child but by its session.
          if (ahead !== held) return
          if (ready) {
            const asking = askAhead(ready.client, env)
            held.asking = asking.then(() => undefined, () => undefined)
            return asking
          }
        }
        // A session already asked what this would; its answers are kept.
        if (sessions.size > 0) return
        const client = spawnChild(env, homedir(), "prefetch:cursor")
        try {
          await client.hello()
          await askAhead(client, env)
        } finally {
          await client.close(2_000)
        }
      },
      release: () => ahead?.release(),
    },
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
    start: async (cwd, options) => {
      const { trace } = options
      if (sessions.get(options.conversationId)?.closed === false)
        throw new Error("This Cursor binding is already connected")
      const launch = await trace.step("account", () => dependencies.auth.childLaunch(options.accountLaunch.env))
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
      const held = take(accountEnvironment)
      const adopted = held && await trace.step("adoption", () => adopt(held, spawn))
      const client = adopted?.client ?? trace.sync("spawn", () => spawnChild(spawn.env, spawn.cwd, spawn.owner, spawn.onEvent))
      const context = launchContext("cursor-sdk-child", CURSOR_NATIVE_IDENTITY, options.accountLaunch.account)
      context.credential = launch.credential
      const account = launch.credential.kind === "configured" && launch.credential.source === "account"
      // A selected account's refused key is that account's to sign in again,
      // not a reason to call Cursor's own login signed out.
      const rejected = (message: string) => {
        void modelCache.forget(accountEnvironment)
        if (!account) dependencies.auth.reportRejected(message)
      }
      const live: Live = {
        client,
        emit: options.emit,
        onRejected: rejected,
        models: [],
        turn: null,
        decoder: new CursorDecoder({ get models() { return live.models }, get state() { return live.state } }),
        stream: nativeStream("cursor", options.conversationId, () => ({ settings: { model: options.tuning?.model ?? null } }), dependencies.streams, () => live.state.nativeId),
        settledTurns: new Set(),
        pendingPermissions: new Map(),
        sides: new Map(),
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
        const exit = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
        const detail = fatal ? `${fatal}, ${exit}` : exit
        hostWarn("cursor-sdk", "child exited during a session", { conversation: live.state.id, detail, reason: fatal ?? (signal ? undefined : cursorSdkExitReason(code)) })
        // What the host draws of the exit is its own observation: the stream
        // keeps it before it closes, so a replay ends the turn as the view did.
        if (live.state.status === "running") {
          settleTurn(engine, live, "error", `Cursor's SDK process exited (${detail})`, undefined, true)
          const failed = messageEvent(TURN_FAILED, `Cursor's SDK process exited (${detail})`, "error")
          live.stream?.drawn(JSON.parse(JSON.stringify({ kind: "event", ...failed })))
          engine.event(live, failed)
        }
        stop(engine, live)
        engine.patch(live, {
          status: live.state.status === "running" ? "failed" : live.state.status,
          connection: "disconnected",
          lastStop: live.state.status === "running" ? "failed" : live.state.lastStop,
          error: live.state.status === "running" ? `Cursor's SDK process exited (${detail})` : live.state.error,
        })
      })
      // After the handler above, which draws the exit into the stream: the child is gone, so the launch's stream is finished.
      void live.client.exited.then(() => live.stream?.ended(), () => live.stream?.ended())
      try {
        const hello = adopted ? adopted.hello : await trace.step("handshake", () => live.client.hello())
        const runtime = reportedRuntime(hello.sdkVersion, "SDK child hello.sdkVersion")
        streamRuntime(live.stream, runtime)
        engine.patch(live, { executionContext: { ...context, runtime } })
        if (hello.ripgrep === false)
          hostWarn("cursor-sdk", "the child has no bundled ripgrep; Grep and Glob need one on PATH", { conversation: live.state.id })
        // Who it runs as and the account's models are asked beside the sign-in check, not after it: each is a call to
        // Cursor of 0.2-1.9 s on a copy (2026-10-21). They stand only if no person had to sign in meanwhile, after
        // which they'd be another account's and are asked again.
        const asking = settled(live.client.request("me", undefined))
        const listing = settled(loadModels(live.client, accountEnvironment))
        const signedInNow = await trace.step("authentication", () => ensureSignedIn(live, trace, account, accountEnvironment.CURSOR_API_KEY, options.unattended))
        const identityObservation = trace.step("identity", () => observeNativeIdentity(async () => {
          const identity = signedInNow ? await live.client.request("me", undefined) : await outcome(asking)
          return reportedIdentity(identity.email, "cursor", CURSOR_NATIVE_IDENTITY.via)
        }, () => !live.closed && sessions.get(live.state.id) === live, identity => {
          if (live.state.executionContext) engine.patch(live, { executionContext: { ...live.state.executionContext, identity } })
        }))
        let catalog = await trace.step("model-discovery", async () => {
          const early = signedInNow ? undefined : await listing
          return early?.ok ? early.value : loadModels(live.client, accountEnvironment)
        })
        live.models = catalog.models
        let selection: CursorSdkModelSelection
        try {
          selection = selectionFor(live, options.tuning, catalog.defaultModel)
        } catch {
          // The kept list may predate the model: Cursor is asked again before it's refused.
          catalog = await trace.step("model-discovery", () => loadModels(live.client, accountEnvironment, true))
          live.models = catalog.models
          selection = selectionFor(live, options.tuning, catalog.defaultModel)
        }
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
        // A child's first call to Cursor pays its setup (`me` took 0.75–1.4 s first, 0.11 s after), which `open` paid
        // when nothing came before it (1.1 s cold, 0.36–0.40 s after a call; 2026-10-20). `me`, asked at once beside the
        // steps above, is that first call: `open` waits for it rather than paying it again.
        await identityObservation
        if (live.closed) throw new Error("Cursor disconnected during identity verification")
        const fork = options.fork
        if (options.resume || fork) live.stream?.opening()
        const opened = await trace.step(options.resume ? "session-resume" : fork ? "session-fork" : "session-open", () => live.client.request("open", {
          cwd,
          stateRoot,
          strictStores: dependencies.stores.strict,
          agentId,
          create: !options.resume && !fork,
          name: options.title,
          model: selection,
          mcpServers: servers,
          importFrom,
          forkFrom: fork && { agentId: fork.nativeId, runId: fork.runId },
        }))
        if (live.closed) throw new Error("Cursor disconnected during startup")
        if (options.resume || fork) live.stream?.opened()
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
        hostLog("cursor-sdk", opened.imported ? "imported and resumed a cursor-agent session" : options.resume ? "resumed agent" : fork ? "forked agent" : "created agent", {
          conversation: options.conversationId,
          agent: opened.agentId,
          from: importFrom?.path ?? fork?.nativeId ?? "",
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
    },
    async prompt(id, text, attachments, settings, dispatch) {
      await preparePromptAsync(dispatch, async () => {
        const live = requireLive(id)
        if (live.state.status === "running") throw new TurnInProgressError("Cursor")
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
        if (live.state.status === "running") throw new TurnInProgressError("Cursor")
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
      live.stream?.prompted({ text, shown: dispatch.shown, shownAt: dispatch.shownAt, attachments })
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
    // Verified 2026-10-31 (SDK 1.2.0): a steer sent 20 s into a foreground
    // `sleep 150` cut it short within 0.5 s and the model answered it; one
    // sent while a `task` subagent worked was held until the subagent
    // returned 136 s later, then delivered. The SDK answers a steer it holds
    // when its run ends (`revert_to_followup`), and its words go as the next
    // message: the queued one it came from is put back, else the client sends it.
    steering: { kind: "supported", lands: "interrupt", answersOnEnd: true, via: "A message sent while a run works cuts a running command short and the model continues with it; a running subagent finishes first. One the run ends before taking goes as the next message.", async steer(id, input): Promise<ProviderSteerResult> {
      const live = requireLive(id)
      if (live.state.status !== "running" || live.state.nativeRunId !== input.expectedRunId)
        return { kind: "not-accepted", reason: "The Cursor turn had already changed, so it goes as the next message." }
      const started = Date.now()
      const result = await live.client.request("steer", { text: promptText(input.text, input.attachments) })
      hostLog("cursor-sdk", "steer answered", { conversation: live.state.id, outcome: result.outcome, ms: Date.now() - started })
      if (result.outcome === "complete_delivered") {
        live.stream?.steered(input.text, input.shown)
        engine.emitUpdate(live, {
          kind: "user",
          text: input.text,
          steeringFor: input.expectedRunId,
        })
        return { kind: "accepted" }
      }
      return { kind: "not-accepted", reason: "Cursor didn't take it into this turn, so it goes as the next message." }
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
