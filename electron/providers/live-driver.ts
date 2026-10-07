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
import { LaunchEnvironmentCapabilitySchema, NativeIdentityCapabilitySchema, NativeExclusionCapabilitySchema, type LaunchEnvironmentCapability, type NativeIdentityCapability, type NativeExclusionCapability } from "../contracts/execution-context.js"
import { NativePromptIdentityCapabilitySchema, type NativePromptIdentityCapability } from "../contracts/native-prompt-identity.js"

/** Admission resolves separately from the correlated live-action-result event.
 * A provider must confirm completion, failure, or cancellation; idle is not proof.
 * An exception means delivery is unknown and must never cause an automatic replay.
 */
export type ProviderCompaction =
  | { kind: "supported"; start(id: string, actionId: string): Promise<void> }
  /** The harness compacts on its own as the context fills, and Mako cannot start it. */
  | { kind: "automatic"; reason: string }
  | { kind: "unavailable"; reason: string }

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
 * A capability the driver doesn't have, with the reason the window shows:
 * `unavailable` when the harness has no such thing, `not-built` when it has
 * one Mako doesn't drive yet, which is a gap to close.
 */
export type DriverAbsent =
  | { kind: "unavailable"; reason: string }
  | { kind: "not-built"; reason: string }

/**
 * Reopening a native session in a new process. Mako closes an idle
 * conversation's process exactly when its session can be reopened, so this
 * also decides residency.
 * - `via`: how the harness reopens it.
 * - `wake`: what the next message does once Mako has closed the process.
 * - `checkpoint`: a digest of the session's source that moves when the
 *   session does; undefined when there is no source.
 * - `inspect`: native identity, source and ownership facts; shared policy
 *   decides eligibility.
 * - `locate`: where the harness keeps the session named by
 *   `binding.nativeId`, for a binding whose source was never reported, as
 *   when the process ended inside its first turn. `cwd` is the folder the
 *   session ran in and `env` the environment of its account; undefined when
 *   no record exists yet.
 */
export type NativeResume =
  | {
      kind: "native"
      via: string
      wake: string
      checkpoint(path: string): Promise<string | undefined>
      inspect(binding: ProviderBinding): Promise<NativeResumeEvidence>
      locate?(binding: ProviderBinding, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined>
    }
  | DriverAbsent

/**
 * Forking a conversation at an answer. `native`: the harness forks its own
 * session, at a completed run or at a checkpoint inside one. `import`: it
 * can't, so Mako writes the conversation up to the fork point into a new
 * native session and resumes it, which needs native resume and a session
 * emitter.
 */
export type NativeFork =
  | { kind: "native"; point: "run" | "checkpoint"; via: string }
  | { kind: "import"; via: string }
  | DriverAbsent

/** Adding a message to the running turn. `lands` says what the harness does with it. */
export type SteerCapability =
  | { kind: "supported"; lands: LiveSteering; via: string; steer(id: string, input: ProviderSteerInput): Promise<ProviderSteerResult> }
  | DriverAbsent

/**
 * How the agent asks the user a question. `request`: a blocking native
 * request carrying the questions, answered through `permission`.
 * `session`: a nonblocking session question; ordinary user input retires
 * its form, exact answers preserve other questions, and native history
 * supplies the same retirement evidence after external continuation.
 * `history` is read-only catch-up that rejects unavailable or incomplete
 * evidence and never returns partial history.
 */
export type QuestionCapability =
  | { kind: "request"; via: string }
  | {
      kind: "session"
      via: string
      encodeAnswer(question: import("../contracts/live-questions.js").NativeQuestion, answers: Record<string, string[]>): string
      history?(binding: ProviderBinding): Promise<import("../contracts/live-questions.js").NativeQuestionHistory>
    }
  | DriverAbsent

/** Subagents the harness starts, observed with their progress and results. */
export type NativeAgentsCapability = { kind: "observed"; via: string } | DriverAbsent

/** What fills the running session's context, by category. */
export type ContextBreakdownCapability =
  | { kind: "itemized"; via: string; read(id: string): Promise<import("../contracts/providers-acp.js").ContextBreakdown> }
  | DriverAbsent

/** Changing the running session's mode. `single`: the harness runs one mode, and why. */
export type ModeSwitching = { kind: "native"; via: string } | { kind: "single"; reason: string }

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
  /** Prepared by shared execution admission. Adapters must use this environment
   * instead of resolving the global account a second time. Host-only. */
  accountLaunch?: import("../accounts.js").AccountLaunch
  /** Known native occurrences from this binding, including answered ones. Keep
   * identities on callback replay; observe only, never send saved answers again. */
  observedApprovals?: import("../contracts/approval-response.js").NativeApprovalIdentity[]
  /** Prior child identities for this exact resumed binding; states require fresh evidence. */
  observedAgents?: NativeAgentObservation[]
  /** The harness's last session totals for this exact resumed binding, which its process may restore. */
  observedUsage?: import("../contracts/providers-acp.js").NativeTotals
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
export type PlanningCapability = (
  | { via: "mode"; mode: string; proposal: string }
  | { via: "setting"; option: string; proposal: string }
) & { feedback: PlanFeedback }

/**
 * How what the person types in reply to a plan reaches the agent. In the
 * refusal, the plan request names the answer that carries the words
 * (`LivePermissionRequest.feedbackOption`); otherwise they go as the next
 * message.
 */
export type PlanFeedback =
  | { kind: "in-refusal"; via: string }
  | { kind: "next-message"; reason: string }

export interface ProviderLiveDriver extends ProviderCapability {
  launchEnvironment: LaunchEnvironmentCapability
  /** Native principal evidence, separately from configured account selection. */
  nativeIdentity: NativeIdentityCapability
  nativeExclusion: NativeExclusionCapability
  /** Whether an accepted reference identifies a stored user message, independently of the native run ID. */
  nativePromptIdentity: NativePromptIdentityCapability
  /** Required only for native atomic exclusion. Acquisition must precede
   * opening/resuming, and protect against the native CLI as well as Mako.
   * Failed acquisition must leave no executing session behind. Native writes
   * must themselves remain excluded/fenced; a host assertion is not a lock. */
  startExclusive?(cwd: string, options: ProviderStartOptions): Promise<{
    session: LiveSessionState
    lease: {
      /** Fail if the native authority no longer grants this executor ownership. */
      assertHeld(): Promise<void>
      /** Idempotently release this exact native grant after execution/children
       * have ended. Never release a replacement executor's grant. */
      release(): Promise<void>
    }
  }>
  /** Native record identity within a physical file, for DB/SDK locators.
   * Undefined rejects an invalid locator; ordinary transcript files omit it. */
  nativeSource?(path: string, nativeId: string | undefined): { path: string; record: string } | undefined
  approvalEvidence: ApprovalEvidenceCapability
  planning: PlanningCapability
  /** Hash the exact provider encoding before sending, without retaining answer text. */
  approvalAnswerDigest?(request: import("../shared.js").LivePermissionRequest, response: LivePermissionResponse): string | undefined
  /*
   * Each capability below is declared once, here: its implemented variant
   * carries what implements it, and an absent one says why. The catalog the
   * window and the audit read is projected from these fields alone.
   */
  resume: NativeResume
  fork: NativeFork
  steering: SteerCapability
  questions: QuestionCapability
  nativeAgents: NativeAgentsCapability
  contextBreakdown: ContextBreakdownCapability
  compaction: ProviderCompaction
  modeSwitching: ModeSwitching
  /** The modes a fresh session will offer, declared without starting one. */
  modes?: readonly LiveSessionMode[]
  /** The mode a fresh session runs under when nothing was chosen — the level the chip reports before launch. */
  defaultMode?: string
  backgroundStop: BackgroundStop
  turnRecovery: TurnRecovery
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
  /** Stop owns foreground, background and child effects as declared above.
   * Native interrupt acknowledgement is not cleanup evidence. Adapters must
   * retain ownership of late native events from stopped runs, never dispatch
   * replacement input, and report failed/unknown cleanup instead of readiness.
   */
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
  LaunchEnvironmentCapabilitySchema.parse(driver.launchEnvironment)
  NativeIdentityCapabilitySchema.parse(driver.nativeIdentity)
  NativeExclusionCapabilitySchema.parse(driver.nativeExclusion)
  NativePromptIdentityCapabilitySchema.parse(driver.nativePromptIdentity)
  if ((driver.nativeExclusion.kind === "atomic") !== Boolean(driver.startExclusive))
    throw new Error(`${driver.provider}: native atomic exclusion requires an exclusive start implementation, declared together`)
  ApprovalEvidenceCapabilitySchema.parse(driver.approvalEvidence)
  const interactive = driver.approvalEvidence.kind !== "no-interactive-requests"
  if (!interactive && driver.modes?.some(mode => mode.access === "ask" || mode.access === "edits"))
    throw new Error(`${driver.provider}: an asking mode requires native interactive requests`)
  if (driver.questions.kind === "request" && !interactive)
    throw new Error(`${driver.provider}: questions asked through a native request need interactive requests`)
  const resumes = driver.resume.kind === "native"
  if (driver.fork.kind === "import" && !resumes)
    throw new Error(`${driver.provider}: a fork Mako imports continues as a resumed session, which needs native resume`)
  const modeCount = driver.modes?.length ?? 0
  if ((driver.modeSwitching.kind === "native") !== modeCount > 1)
    throw new Error(`${driver.provider}: mode switching is ${driver.modeSwitching.kind} with ${modeCount} mode${modeCount === 1 ? "" : "s"} declared`)
  for (const [name, text] of declaredTexts(driver))
    if (!text.trim()) throw new Error(`${driver.provider}: explain its ${name} declaration`)
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
  if (!(planning.feedback?.kind === "in-refusal" ? planning.feedback.via : planning.feedback?.reason ?? "").trim())
    throw new Error(`${driver.provider}: says nothing of how a reply to its plan reaches it`)
  const background = driver.backgroundStop
  const reason = background?.kind === "ends-on-stop" ? background.how : background?.kind === "ends-with-turn" ? background.evidence : ""
  if (!reason.trim())
    throw new Error(`${driver.provider}: declare how Stop ends its background work, or the evidence that none outlives its turn`)
  const recovery = driver.turnRecovery
  if (recovery?.kind === "continues") {
    if (!resumes)
      throw new Error(`${driver.provider}: a turn is continued on its native session, which needs native resume`)
    if (!recovery.accepted.trim() || !recovery.exit.trim() || !recovery.tests.length)
      throw new Error(`${driver.provider}: declare when a prompt is accepted, how a process death is reported, and the tests that prove both`)
  } else if (!recovery?.reason.trim())
    throw new Error(`${driver.provider}: declare how a turn survives its process dying, or why it cannot`)
}

/** The words each capability declaration carries, so none is left empty. */
function declaredTexts(driver: ProviderLiveDriver): [string, string][] {
  const text = (value: { kind: string; via?: string; reason?: string }) => value.via ?? value.reason ?? ""
  const { resume, fork, steering, questions, nativeAgents, contextBreakdown, compaction, modeSwitching } = driver
  const texts: [string, string][] = [
    ["resume", text(resume)], ["fork", text(fork)], ["steering", text(steering)], ["questions", text(questions)],
    ["subagents", text(nativeAgents)], ["context breakdown", text(contextBreakdown)],
    ["compaction", compaction.kind === "supported" ? "started by Mako" : compaction.reason], ["mode switching", text(modeSwitching)],
  ]
  if (resume.kind === "native") texts.push(["idle wake", resume.wake])
  return texts
}

/** Call immediately before answering a native request, after any adapter awaits. */
export interface ApprovalDispatch {
  assertCurrent(): void
  report(result: ApprovalSubmission): void
}
