import type { z } from "zod"
import type { AcpDecoderHooks, AcpPlanDecoder as AcpUpdatePlans } from "@mako/sessions/acp-decoder"
import type { McpServer, ClientCapabilities, SessionNotification, CreateElicitationRequest } from "@agentclientprotocol/sdk"
import type { NativeAgentObservation } from "../contracts/native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderCapability } from "./registry.js"
import type { DriverAbsent, NativeFork, NativeResume, ProviderLiveDriver } from "./live-driver.js"
import type { RequestPermissionRequest, NewSessionRequest } from "@agentclientprotocol/sdk"
import type { AccessTier } from "../contracts/access.js"
import type { AcpAccessPolicy } from "../acp-access.js"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "../contracts/approval-response.js"
import type { JsonObject } from "../codex-app-json.js"
import type { NativeNotice } from "../contracts/native-activity.js"
import type { LivePermissionRequest, LiveSessionState } from "../contracts/providers-acp.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { TranscriptEvent } from "@mako/sessions/events"
import type { UsageObservation } from "../session-usage.js"

export type AcpTuning = SessionSettings

export interface AcpNativeMode {
  id: string
  name: string
  description?: string
}

export interface AcpLaunchOptions {
  appPath: string
  execPath: string
  resume?: string
  nativePath?: string
  env?: NodeJS.ProcessEnv
  tuning?: AcpTuning
  /** The access tier selected before launch, for providers that read it from flags or environment. */
  access?: AccessTier
  /** The folder the process runs in, for providers whose settings depend on it. */
  cwd: string
}

export interface AcpLaunch {
  /** Explicit fallback only when initialize omits agentInfo.version. */
  versionArgs?: string[]
  command: string
  args: string[]
  configureEnvironment(env: NodeJS.ProcessEnv): void
  /** The tier the process really runs at, when the provider's own settings override the selected one. */
  access?: AccessTier
  /** Shown in the conversation once the session is ready, such as a setting that overrides the selected access. */
  notices?: TranscriptEvent[]
  prepareMcp?(servers: readonly McpServer[], env: NodeJS.ProcessEnv): Promise<() => Promise<void>>
  /** Observe native decisions without taking over the provider's permission policy. */
  prepareApprovals?(input: {
    root: string
    env: NodeJS.ProcessEnv
    previous: readonly NativeApprovalIdentity[]
    publish(decision: NativeApprovalDecision): void
  }): Promise<AcpApprovalObserver>
}

export interface AcpApprovalObserver {
  identify(request: RequestPermissionRequest): Promise<NativeApprovalIdentity | undefined>
  identifyElicitation?(request: CreateElicitationRequest): NativeApprovalIdentity | undefined
  observe?(notification: SessionNotification): void
  dispose(): Promise<void>
}

/** Provider-owned process launch and environment for an interactive ACP agent. */
/**
 * Reopening an ACP session in a new agent process, with `session/load`.
 * `locate` finds the session's source from its id alone once the agent has
 * written it. A session is resumed only from a located source, and the
 * thread catalog finds one only after it has indexed the file, so without
 * it a process that dies in a new session's first turn could not be
 * continued.
 */
export type AcpResume =
  | (Omit<Extract<NativeResume, { kind: "native" }>, "locate"> & {
      locate(input: { nativeId: string; cwd: string; env: NodeJS.ProcessEnv }): string | undefined
    })
  | DriverAbsent

/**
 * How a second `session/prompt` during a running turn behaves, verified
 * against the real agent. `concurrent-prompt` folds it into the running
 * turn; `interrupting-prompt` cancels the current step and continues with
 * the message. `extension` names the agent's own request, sent
 * `{ sessionId, text }`, that joins the running turn at its next step;
 * `taken` parses only the reply that says it took the message. An agent
 * that queues it behind the turn declares it unavailable.
 */
export type AcpSteering =
  | { kind: "supported"; via: string; wire: "concurrent-prompt" | "interrupting-prompt" | { extension: string; taken: z.ZodType } }
  | DriverAbsent

/** Subagents, observed by the provider's own child evidence; shared ACP owns only binding lifetime and delivery. */
export type AcpAgents =
  | {
      kind: "observed"
      via: string
      observe(input: {
        nativeId: string
        observedAgents?: readonly NativeAgentObservation[]
        cwd: string
        env: NodeJS.ProcessEnv
        publish(agent: NativeAgentObservation): void
      }): Promise<AcpAgentObserver> | AcpAgentObserver
    }
  | DriverAbsent

/**
 * What Mako's ACP client offers an agent at `initialize`, before a source's
 * own `clientCapabilities`. An agent offers some tools only to a client that
 * can answer them: Devin 3000.10.23 hides `ask_user_question` from one
 * without `elicitation.form`.
 */
export function acpClientCapabilities(source: Pick<ProviderAcpSource, "clientCapabilities"> | undefined): ClientCapabilities {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    session: { configOptions: { boolean: {} } },
    elicitation: { form: {} },
    ...source?.clientCapabilities,
  }
}

/** What a native fork has to work with: the session, the checkpoint it forks at, and the agent as the driver launches it. */
export interface AcpForkInput {
  nativeId: string
  /** What `checkpoint` read when the turn the fork follows ended. */
  checkpoint: string
  executable: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  clientCapabilities: ClientCapabilities
  /** The conversation the fork is for, which owns any process it starts. */
  owner: string
  /** Aborted when the conversation closes before it has started. */
  signal: AbortSignal
}

/**
 * How an ACP agent forks. A native fork reads, as each turn ends, the
 * agent's own name for that point in the session, the turn's checkpoint;
 * `open` makes the agent's copy of the session ending there and returns its
 * id, which the driver opens with `session/load`, as it resumes a session.
 */
export type AcpFork =
  | (Extract<NativeFork, { kind: "native" }> & {
      checkpoint(session: { nativeId: string; env: NodeJS.ProcessEnv; cwd: string }): string | undefined
      open(input: AcpForkInput): Promise<string>
    })
  | Exclude<NativeFork, { kind: "native" }>

export interface ProviderAcpSource extends ProviderCapability, AcpDecoderHooks<AcpPlanDecoder>, Pick<ProviderLiveDriver, "nativeSource" | "approvalEvidence" | "planning" | "approvalAnswerDigest" | "backgroundStop" | "nativePromptIdentity" | "questions"> {
  fork: AcpFork
  agents: AcpAgents
  compaction: import("../acp-compaction.js").AcpCompactionSpec
  /**
   * Prompt content the agent reads though its `initialize` does not
   * advertise it, each with the run that showed it. Sent inline, not as a
   * file link the model would have to open.
   */
  readsUnadvertised?: { image?: { verified: string } }
  /** Provider evidence of background commands, and how Stop ends them. Required when Stop ends background work. */
  observeBackground?(): AcpBackgroundObserver
  /**
   * Turns the agent starts on its own. Declared only by an agent that reports
   * when such a turn ends: without that, a turn opened on unprompted output
   * could never settle, so its output stays with the previous turn.
   */
  providerTurns?(): AcpProviderTurnObserver
  /**
   * What one of the provider's vendor notifications (`_`-prefixed method),
   * or a `session/update` of a kind ACP does not declare, means in Mako's
   * shared vocabulary. Pure, so it is tested on recorded
   * payloads. `undefined` for a method the provider does not own.
   */
  decodeNotification?(method: string, params: JsonObject): AcpNotificationDecoding | undefined
  /** Whose reading a `usage_update` is, and what its `_meta` adds to ACP's own used, size and cost. Pure. */
  usageUpdate?(meta: JsonObject | undefined): AcpUsageReading
  /**
   * How the agent reports its MCP servers starting, opened once per session:
   * which servers it will start, and which did not, as setup notices.
   * Consulted before `decodeNotification`. A notice naming no session is the
   * connection's, so this session's, even said before the session has an id.
   */
  mcpStartup?(): AcpMcpStartupDecoder
  /** Vendor requests (`_`-prefixed methods) the agent sends and waits on. */
  requests?: AcpVendorRequests
  /** A permission request's title when the agent leaves the tool call's title out. */
  permissionTitle?(request: RequestPermissionRequest): string | undefined
  clientCapabilities?: Pick<ClientCapabilities, "_meta">
  resume: AcpResume
  steering: AcpSteering
  access?: AcpAccessPolicy
  /**
   * The session modes the installed agent advertises, recorded from a real
   * `session/new` so the ladder can be offered before a session exists. The
   * ids must match what the agent sends; a saved choice is validated against
   * the live list when the session starts.
   */
  nativeModes?: readonly AcpNativeMode[]
  launchOptionIds?: readonly string[]
  sessionMetadata?(tuning: SessionSettings): NewSessionRequest["_meta"]
  available(appPath: string): boolean
  launch(options: AcpLaunchOptions): Promise<AcpLaunch | null>
}

export interface AcpBackgroundReport {
  sessionId: string
  running: number
}

/** What Stop can use to end a session's background work once its turn is cancelled. */
export interface AcpBackgroundControl {
  sessionId: string
  /** The session's running count as last reported. */
  running: number
  /** A vendor request (`_`-prefixed method) whose answer Stop does not need. */
  request(method: string, params: JsonObject): Promise<void>
  /** Close the session, which ends the work it started, and resume it in the same process. */
  reopen(): Promise<void>
}

/** Each hook returns the named session's running count when the notification reports one. */
export interface AcpBackgroundObserver {
  sessionUpdate?(notification: SessionNotification): AcpBackgroundReport | undefined
  /** Vendor notifications (`_`-prefixed methods), whose payloads the provider parses. */
  extension?(method: string, params: JsonObject): AcpBackgroundReport | undefined
  /** End all of the session's background work, as Stop does on every harness. */
  stop(control: AcpBackgroundControl): Promise<void>
}

/**
 * Whose reading a `usage_update` is. The main agent's moves the context
 * meter and adds its spend; a subagent's own call adds its spend to the
 * conversation's and leaves the main context alone; a repeat of a reading
 * already counted adds nothing.
 */
export type AcpUsageReading =
  | { of: "agent"; observations: UsageObservation[] }
  | { of: "subagent"; observations: UsageObservation[] }
  | { of: "repeat" }

export interface AcpNotificationDecoding {
  /** The session the notification names; notices for another session are not applied. */
  sessionId?: string
  /**
   * The notification's specific kind, the method plus the payload's own
   * discriminator where it has one (`_x.ai/session_notification/auto_compact_started`),
   * so an unknown one is logged under its own name.
   */
  kind: string
  /** `[]` for a notification deliberately not shown; `undefined` for one the provider does not know. */
  notices: NativeNotice[] | undefined
  state?: Pick<Partial<LiveSessionState>, "title">
  /** What the notification says about tokens, cost or the window, for the session's usage meter. */
  usage?: UsageObservation[]
  /** About the agent process rather than one session; Mako runs one session per process, so it is this session's. */
  connectionWide?: true
  /** The native event's own id, when the provider gives one; it names the notification's markers. */
  id?: string
}

export interface AcpMcpStartupDecoder {
  /** `undefined` for a notification that says nothing about MCP startup. */
  decode(method: string, params: JsonObject): AcpNotificationDecoding | undefined
}

/** A plan the user builds by answering a request with `approve`. */
export interface AcpPlanApproval {
  plan: string
  approve: string
}

/**
 * One session's plan handover: the proposed-plan updates a session update
 * carries, and on the live side the plan a permission request builds.
 */
export interface AcpPlanDecoder extends AcpUpdatePlans {
  approval?(request: RequestPermissionRequest): AcpPlanApproval | undefined
}

/** What the agent is sent when the user picks `optionId`. */
export interface AcpAnswer {
  optionId: string
  result: JsonObject
}

/** A request put to the user: what the desk shows, and for a vendor request, what each choice sends. */
export interface AcpAsk {
  request: Pick<LivePermissionRequest, "title" | "detail" | "kind" | "options" | "implementsPlan" | "questions" | "feedbackOption">
  /** Absent for ACP's own permission request, whose answer is the chosen option. */
  answers?: AcpAnswer[]
  /** What the agent is sent for `request.feedbackOption` chosen with the person's words. */
  feedback?(text: string): JsonObject
  /** For a request that asks `questions`: what the agent is sent for the user's answers, by question ID. */
  answered?(answers: Record<string, string[]>): JsonObject
  /** Sent when the request ends with no choice, as when the session stops. */
  dismissed?: JsonObject
}

/**
 * The vendor requests an agent sends, each read as a question for the user
 * and the answer each choice sends back. Pure. Mako answers any other
 * method, or one that does not parse, method-not-found.
 */
export interface AcpVendorRequests {
  methods: ReadonlySet<string>
  decode(method: string, params: JsonObject): AcpVendorRequest | undefined
}

export interface AcpVendorRequest {
  /** The session the request names; one for another session is refused. */
  sessionId: string
  /** Transcript content the request carries, such as the plan it asks to approve. */
  updates: LiveUpdate[]
  ask: AcpAsk
}

/** Vendor notifications about turns the agent started itself. */
export interface AcpProviderTurnObserver {
  /** The agent announced the next turn it starts on its own, and why. Without an announcement, no turn opens. */
  cause?(method: string, params: JsonObject): { sessionId: string; reason: string } | undefined
  /** The same announcement, carried by a session update; it sees child-owned updates too. */
  updateCause?(notification: SessionNotification): { sessionId: string; reason: string } | undefined
  /** The agent ended its current turn; `interrupted` when a cancel ended it. */
  ended(method: string, params: JsonObject): { sessionId: string; interrupted: boolean } | undefined
}

export interface AcpAgentObserver {
  /** Child-owned events are consumed before parent content/settings projection. */
  observe(notification: SessionNotification): "child" | void
  dispose(): void
}
