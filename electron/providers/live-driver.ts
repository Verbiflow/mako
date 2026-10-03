import type { ApprovalSubmission } from "../contracts/approval-response.js"
import { ApprovalEvidenceCapabilitySchema, type ApprovalEvidenceCapability } from "./approval-capability.js"
import type { PromptDispatch } from "./prompt-dispatch.js"
import type { NativeAgentObservation } from "../contracts/native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import type { NativeResumeEvidence } from "../native-continuation.js"
import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveSessionMode,
  LiveDriverEvent,
  LiveSteering,
  McpRegistrySnapshot,
} from "../shared.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { ProviderCapability } from "./registry.js"
import type { ControlLaunch } from "@mako/control-runtime/session"
import type { ThreadEnvironment } from "../contracts/thread-environments.js"
import { MAKO_COMPUTER_SERVER, MAKO_THREAD_SERVER } from "../contracts/mcp-reach.js"
import { UNAVAILABLE_RECOVERY, type RecoveryCapabilities } from "../contracts/recovery.js"

/** Admission resolves separately from the correlated live-action-result event.
 * A provider must confirm completion, failure, or cancellation; idle is not proof.
 * An exception means delivery is unknown and must never cause an automatic replay.
 */
export type ProviderCompaction =
  | { kind: "supported"; start(id: string, actionId: string): Promise<void> }
  | { kind: "unavailable"; reason: string }

export function recoveryCapabilities(driver: ProviderLiveDriver | undefined): RecoveryCapabilities {
  const compaction = driver?.compaction
  return compaction?.kind === "supported"
    ? { compaction: { kind: "supported" } }
    : compaction ? { compaction } : UNAVAILABLE_RECOVERY
}

/** How long a closing provider has to end its own work before it is terminated. */
export const SHUTDOWN_GRACE_MS = 5_000

/**
 * Stop ends the turn and the background work the conversation started, on
 * every harness. A harness either ends that work on Stop, with or without a
 * running turn, or never lets it outlive the turn that started it. A harness
 * that can do neither means Stop leaves background work running on all of
 * them instead.
 */
export type BackgroundStop =
  | { kind: "ends-on-stop"; how: string }
  | { kind: "ends-with-turn"; evidence: string }

/**
 * How a turn survives the provider's process dying under it. The host
 * decides for every harness: a turn the provider accepted is reopened on its
 * native session and continued once, and anything else is left to the user.
 * What the host cannot see is the driver's share, stated here with the tests
 * that kill the process mid-turn and prove it:
 * - `accepted`: when `prompt` reports `accepted`. It must be as soon as the
 *   provider shows it has the prompt, not at turn end, or a death mid-turn
 *   leaves an unknown outcome.
 * - `exit`: how the death reaches the host: one session update with
 *   `status: "failed"` and `connection: "disconnected"` together, carrying
 *   the `nativePath` a new session resumes from when the driver knows it.
 * - `tests`: scripts, each run by an npm script, that kill the process
 *   mid-turn and check both.
 * A provider whose sessions cannot be reopened says why instead.
 */
export type TurnRecovery =
  | { kind: "continues"; accepted: string; exit: string; tests: readonly string[] }
  | { kind: "manual"; reason: string }

/**
 * A running agent's grant to Mako's own MCP servers, both opened with
 * `token`: `mako-computer` for browser and computer use and, when the host
 * serves it, `mako` for the Thread's worktree, app and recipe; plus the
 * control CLI when it started.
 */
export interface ConversationTools {
  token: string
  computerUrl: string
  makoUrl?: string
  control?: ControlLaunch
}

/** Mako's servers for one launch, by the names the agent sees. Every adapter adds exactly these. */
export function conversationServers(tools: ConversationTools): Array<{ name: string; url: string }> {
  const servers = [{ name: MAKO_COMPUTER_SERVER, url: tools.computerUrl }]
  if (tools.makoUrl) servers.push({ name: MAKO_THREAD_SERVER, url: tools.makoUrl })
  return servers
}

/** Host-only launch credentials. Never included in the renderer wire contract or journals. */
export interface ProviderStartOptions extends LiveStartOptions {
  /** Known native occurrences from this binding, including answered ones. Keep
   * identities on callback replay; observe only, never send saved answers again. */
  observedApprovals?: import("../contracts/approval-response.js").NativeApprovalIdentity[]
  /** Prior child identities for this exact resumed binding; states require fresh evidence. */
  observedAgents?: NativeAgentObservation[]
  emit?: (event: LiveDriverEvent) => void
  mcpSnapshot?: () => Promise<McpRegistrySnapshot>
  fork?: { nativeId: string; runId: string }
  conversationTools?: ConversationTools
  /** Set on the agent process with `applyThreadEnvironment`, beside the control environment. */
  threadEnvironment?: ThreadEnvironment
}

/**
 * How the harness plans natively: a mode on its ladder, or a setting chosen
 * per send beside the model. `proposal` names the native record that carries
 * the plan to Mako's plan card, live and in saved history.
 */
export type PlanningCapability =
  | { via: "mode"; mode: string; proposal: string }
  | { via: "setting"; option: string; proposal: string }

export interface ProviderLiveDriver extends ProviderCapability {
  /** Nonblocking session questions. Ordinary user input retires their Mako forms;
   * exact answers preserve other questions. Native history supplies the same
   * retirement evidence after external continuation. Blocking approvals stay separate. */
  sessionQuestions?: {
    encodeAnswer(question: import("../contracts/live-questions.js").NativeQuestion, answers: Record<string, string[]>): string
    /** Read-only native catch-up. Reject unavailable/incomplete evidence; never return partial history. */
    history?(binding: ProviderBinding): Promise<import("../contracts/live-questions.js").NativeQuestionHistory>
  }
  approvalEvidence: ApprovalEvidenceCapability
  planning: PlanningCapability
  /** Hash the exact provider encoding before sending, without retaining answer text. */
  approvalAnswerDigest?(request: import("../shared.js").LivePermissionRequest, response: LivePermissionResponse): string | undefined
  observesNativeAgents?: true
  steer?(id: string, input: ProviderSteerInput): Promise<ProviderSteerResult>
  /** Required with `steer`; says what the provider does with the message. */
  steering?: LiveSteering
  /** The modes a fresh session will offer, declared without starting one. */
  modes?: readonly LiveSessionMode[]
  /** The mode a fresh session runs under when nothing was chosen — the level the chip reports before launch. */
  defaultMode?: string
  compaction?: ProviderCompaction
  /** What fills the running session's context, by category, from a harness that itemizes it. */
  contextBreakdown?(id: string): Promise<import("../contracts/providers-acp.js").ContextBreakdown>
  backgroundStop: BackgroundStop
  turnRecovery: TurnRecovery
  forkPoint?: "run" | "checkpoint"
  canResume: boolean
  checkpoint?(path: string): Promise<string | undefined>
  /** Required when resumable. Native identity, source and ownership facts; shared policy decides eligibility. */
  inspectNativeSession?(binding: ProviderBinding): Promise<NativeResumeEvidence>
  available(appPath: string): boolean
  start(cwd: string, options: ProviderStartOptions): Promise<LiveSessionState>
  /**
   * Resolving this call is not a receipt. Report native evidence through the
   * attempt-scoped dispatch, and keep the receipt and process-death promises
   * `turnRecovery` declares.
   */
  prompt(
    id: string,
    text: string,
    attachments: PromptAttachment[],
    settings: SessionSettings | undefined,
    dispatch: PromptDispatch
  ): Promise<void>
  permission(
    id: string,
    requestId: string,
    response: LivePermissionResponse,
    dispatch: ApprovalDispatch
  ): Promise<void>
  cancel(id: string): Promise<void>
  close(id: string): void | Promise<void>
  setMode(id: string, modeId: string): Promise<void>
}

export interface ProviderSteerInput {
  id: string
  expectedRunId: string
  text: string
  attachments: PromptAttachment[]
}

/** A thrown transport error means delivery is unknown, never permission to resend. */
export type ProviderSteerResult =
  { kind: "accepted" } | { kind: "not-accepted"; reason: string }

/**
 * What the interface cannot type: the invariants a driver must keep. The
 * registry runs this at install, so a driver that contradicts itself fails
 * at startup rather than at a call site months later.
 */
export function validateLiveDriver(driver: ProviderLiveDriver): void {
  if (driver.canResume && (!driver.checkpoint || !driver.inspectNativeSession))
    throw new Error(`${driver.provider}: native recovery requires explicit checkpoint and session evidence`)
  ApprovalEvidenceCapabilitySchema.parse(driver.approvalEvidence)
  if (driver.approvalEvidence.kind === "no-interactive-requests" && driver.modes?.some(mode => mode.access === "ask" || mode.access === "edits"))
    throw new Error(`${driver.provider}: an asking mode requires native interactive requests`)
  if (Boolean(driver.steer) !== Boolean(driver.steering))
    throw new Error(`${driver.provider}: steer and steering are declared together or not at all`)
  for (const mode of driver.modes ?? [])
    if (mode.access && mode.enforcement !== "provider" && mode.enforcement !== "launch")
      throw new Error(`${driver.provider}: mode ${mode.id} names a tier with no enforcer`)
  if (driver.defaultMode && !driver.modes?.some((mode) => mode.id === driver.defaultMode))
    throw new Error(`${driver.provider}: defaultMode ${driver.defaultMode} is not one of its declared modes`)
  const planning = driver.planning
  if (!planning) throw new Error(`${driver.provider}: doesn't say how it plans`)
  if (planning.via === "mode" && driver.modes?.find((mode) => mode.id === planning.mode)?.access !== "plan")
    throw new Error(`${driver.provider}: plans through mode ${planning.mode}, which its ladder doesn't offer as Plan`)
  if (planning.via === "mode" && planning.mode === driver.defaultMode)
    throw new Error(`${driver.provider}: a fresh session can't start in Plan unasked`)
  if (planning.via === "setting" && driver.modes?.some((mode) => mode.access === "plan"))
    throw new Error(`${driver.provider}: plans through a setting and a mode at once`)
  if (!planning.proposal.trim()) throw new Error(`${driver.provider}: says nothing of how its plan reaches Mako`)
  const background = driver.backgroundStop
  const reason = background?.kind === "ends-on-stop" ? background.how : background?.kind === "ends-with-turn" ? background.evidence : ""
  if (!reason.trim())
    throw new Error(`${driver.provider}: declare how Stop ends its background work, or the evidence that none outlives its turn`)
  const recovery = driver.turnRecovery
  if (recovery?.kind === "continues") {
    if (!driver.canResume)
      throw new Error(`${driver.provider}: a turn is continued on its native session, which needs canResume`)
    if (!recovery.accepted.trim() || !recovery.exit.trim() || !recovery.tests.length)
      throw new Error(`${driver.provider}: declare when a prompt is accepted, how a process death is reported, and the tests that prove both`)
  } else if (!recovery?.reason.trim())
    throw new Error(`${driver.provider}: declare how a turn survives its process dying, or why it cannot`)
}

/** Call immediately before answering a native request, after any adapter awaits. */
export interface ApprovalDispatch {
  assertCurrent(): void
  report(result: ApprovalSubmission): void
}
