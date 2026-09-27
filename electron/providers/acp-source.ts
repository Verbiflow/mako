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
  permissionTitle?(request: RequestPermissionRequest): string | undefined
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
export interface ProviderAcpSource extends ProviderCapability, Pick<ProviderLiveDriver, "checkpoint" | "resumeVerdict" | "approvalEvidence" | "approvalAnswerDigest"> {
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
  /** Provider evidence of background commands, which die with the agent process. */
  observeBackground?(): AcpBackgroundObserver
  /**
   * Turns the agent starts on its own. Declared only by an agent that reports
   * when such a turn ends: without that, a turn opened on unprompted output
   * could never settle, so its output stays with the previous turn.
   */
  providerTurns?(): AcpProviderTurnObserver
  clientCapabilities?: Pick<ClientCapabilities, "_meta">
  canResume: boolean
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

/** Vendor notifications about turns the agent started itself. */
export interface AcpProviderTurnObserver {
  /** The agent announced the next turn it starts on its own, and why. Without an announcement, no turn opens. */
  cause(method: string, params: JsonObject): { sessionId: string; reason: string } | undefined
  /** The agent ended its current turn; `interrupted` when a cancel ended it. */
  ended(method: string, params: JsonObject): { sessionId: string; interrupted: boolean } | undefined
}

export interface AcpAgentObserver {
  /** Child-owned events are consumed before parent content/settings projection. */
  observe(notification: SessionNotification): "child" | void
  dispose(): void
}
