import type { McpServer, ClientCapabilities, SessionNotification, SessionUpdate, CreateElicitationRequest } from "@agentclientprotocol/sdk"
import type { NativeAgentObservation } from "../contracts/native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderCapability } from "./registry.js"
import type { ProviderLiveDriver } from "./live-driver.js"
import type { RequestPermissionRequest, NewSessionRequest } from "@agentclientprotocol/sdk"
import type { AccessTier } from "../contracts/access.js"
import type { AcpAccessPolicy } from "../acp-access.js"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "../contracts/approval-response.js"
import type { JsonObject } from "../codex-app-json.js"
import type { NativeNotice } from "../contracts/native-activity.js"
import type { LivePermissionRequest, LiveSessionState } from "../contracts/providers-acp.js"
import type { LiveUpdate } from "../contracts/live-content.js"

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
}

export interface AcpLaunch {
  command: string
  args: string[]
  configureEnvironment(env: NodeJS.ProcessEnv): void
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
export interface ProviderAcpSource extends ProviderCapability, Pick<ProviderLiveDriver, "checkpoint" | "resumeVerdict" | "approvalEvidence" | "approvalAnswerDigest" | "backgroundStop"> {
  /** Native tool identity supplied by provider extensions to ACP metadata. */
  toolName?(tool: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>): string | undefined
  /** Provider-owned native child evidence; shared ACP owns only binding lifetime and delivery. */
  observeAgents?(input: {
    nativeId: string
    observedAgents?: readonly NativeAgentObservation[]
    cwd: string
    env: NodeJS.ProcessEnv
    publish(agent: NativeAgentObservation): void
  }): Promise<AcpAgentObserver> | AcpAgentObserver
  compaction?: import("../acp-compaction.js").AcpCompactionSpec
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
  /**
   * How the agent's plan mode hands over its plan: the update that carries
   * the plan document, and the request whose approval builds it. Opened once
   * per session, since a provider may number a plan's revisions. Pure.
   */
  plans?(): AcpPlanDecoder
  /** Vendor requests (`_`-prefixed methods) the agent sends and waits on. */
  requests?: AcpVendorRequests
  /** A permission request's title when the agent leaves the tool call's title out. */
  permissionTitle?(request: RequestPermissionRequest): string | undefined
  clientCapabilities?: Pick<ClientCapabilities, "_meta">
  canResume: boolean
  /**
   * The native session's source, found from its id alone once the agent has
   * written it. A session is resumed only from a located source, and the
   * thread catalog finds one only after it has indexed the file, so without
   * this a process that dies in a new session's first turn could not be
   * continued. Required when `canResume`.
   */
  locateSession?(input: { nativeId: string; cwd: string; env: NodeJS.ProcessEnv }): string | undefined
  /**
   * How a second `session/prompt` during a running turn behaves, verified
   * against the real agent. `concurrent-prompt` folds it into the running
   * turn; `interrupting-prompt` cancels the current step and continues with
   * the message. An agent that queues it behind the turn declares nothing.
   */
  steering?: "concurrent-prompt" | "interrupting-prompt"
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
  /** The native event's own id, when the provider gives one; it names the notification's markers. */
  id?: string
}

/** A plan the user builds by answering a request with `approve`. */
export interface AcpPlanApproval {
  plan: string
  approve: string
}

/**
 * One session's plan handover. `update` returns the proposed-plan updates a
 * session update carries, `[]` for any other; `approval` names the plan a
 * permission request builds.
 */
export interface AcpPlanDecoder {
  update(update: SessionUpdate, sessionId: string): LiveUpdate[]
  approval?(request: RequestPermissionRequest): AcpPlanApproval | undefined
}

/** What the agent is sent when the user picks `optionId`. */
export interface AcpAnswer {
  optionId: string
  result: JsonObject
}

/** A request put to the user: what the desk shows, and for a vendor request, what each choice sends. */
export interface AcpAsk {
  request: Pick<LivePermissionRequest, "title" | "kind" | "options" | "implementsPlan">
  /** Absent for ACP's own permission request, whose answer is the chosen option. */
  answers?: AcpAnswer[]
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
