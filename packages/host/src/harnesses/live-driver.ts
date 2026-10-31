import type { MakoProcesses } from "../threads/index.js"
import type { StartPrefetch } from "./start-prefetch.js"
import type { ApprovalSubmission } from "../contracts/approval-response.js"
import type { GoalCommand, GoalStatus } from "../contracts/live-goals.js"
import type { EarlierExchange } from "../contracts/live-side-questions.js"
import type { ReviewTarget } from "../contracts/live-reviews.js"
import { ApprovalEvidenceCapabilitySchema, type ApprovalEvidenceCapability } from "./approval-capability.js"
import type { PromptDispatch } from "./prompt-dispatch.js"
import type { NativeAgentObservation } from "../contracts/native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { SHOW_MEDIA_LINE } from "@mako/sessions/turn-media"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import type { NativeResumeEvidence } from "./native-continuation.js"
import type { LivePermissionResponse, PromptAttachment, LiveSessionState, LiveSessionMode, LiveSteering } from "../contracts/providers-acp.js"
import type { LiveDriverEvent, LiveStartOptions } from "../contracts/live-conversations.js"
import type { McpRegistrySnapshot } from "../contracts/mcp-skills-integrations.js"
import type { ProviderCapability } from "./registry.js"
import type { ToolGrant } from "../tools/index.js"
import type { ControlLaunch } from "@mako/control-runtime/session"
import type { ThreadEnvironment } from "../contracts/thread-environments.js"
import type { AccountLaunch } from "./accounts.js"
import type { UsageAmendment } from "./account-usage-readings.js"
import type { ProviderLaunchTrace } from "./provider-launch.js"
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
      /** `mako`: the harness processes Mako's hosts recorded, each with the session it holds (`ProviderProbeTarget.mako`). */
      inspect(binding: ProviderBinding, mako?: MakoProcesses): Promise<NativeResumeEvidence>
      locate?(binding: ProviderBinding, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined>
      elsewhere?: ResumeElsewhere
    }
  | DriverAbsent

/**
 * Whether the session goes on in another folder under its native ID, as a
 * Thread's move into its worktree needs, verified against the real harness:
 * the next message resumes it there, with `via` saying how. Left out, the
 * move forks the conversation with its history instead.
 */
export interface ResumeElsewhere {
  via: string
  verified: string
}

/**
 * The session a fork starts from: its native ID, the run it forks at, and its
 * native store when known. `steers` counts the messages Mako sent into that
 * run while it ran, for a harness that stores them like the prompts that open
 * turns.
 */
export interface NativeForkSource {
  nativeId: string
  runId: string
  path?: string
  steers?: number
}

/**
 * Forking a conversation at an answer. `native`: the harness forks its own
 * session, at a completed run or at a checkpoint inside one. `transcript`:
 * it has no fork of its own, so the fork opens a new session of the harness
 * whose first turn reads the transcript of the history up to that answer, as
 * a switch to another harness does; Mako never writes a session the harness
 * didn't. A native fork's `declines` says why the harness can't fork one
 * session itself, when it can't; that fork goes the `transcript` way.
 */
export type NativeFork =
  | { kind: "native"; point: "run" | "checkpoint"; via: string; declines?(source: NativeForkSource): Promise<string | undefined> }
  | { kind: "transcript"; via: string }
  | DriverAbsent

/**
 * Adding a message to the running turn. `lands` says what the harness does
 * with it. `answersOnEnd`: the harness answers every steer it still holds
 * when its turn ends, so a turn that ends, even stopped or failed, leaves no
 * steer whose fate is unknown: its answer is on its way.
 */
export type SteerCapability =
  | { kind: "supported"; lands: LiveSteering; answersOnEnd?: true; via: string; steer(id: string, input: ProviderSteerInput): Promise<ProviderSteerResult> }
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

/**
 * A goal command as a driver receives it. `replacing`: an unfinished goal is
 * set already. `from`: the status a resumed goal stands at, with the objective
 * for a harness that has to be told it again.
 */
export type DriverGoalCommand =
  | (Extract<GoalCommand, { kind: "set" }> & { replacing: boolean })
  | { kind: "resume"; objective: string; from: GoalStatus; tokenBudget?: number }
  | Extract<GoalCommand, { kind: "pause" | "clear" }>

/**
 * How one goal command reaches the harness: as messages, the way its own
 * client types them, the last carrying the command; or as a call to the
 * running session. Each message goes as written, with nothing before it.
 */
export type GoalDelivery =
  | { via: "message"; texts: readonly [...string[], string] }
  | { via: "call"; run(id: string): Promise<void> }

/**
 * Keeping the agent at an objective across turns. `native`: the harness keeps
 * its own goal and reports on it, and `send` says how each of Mako's commands
 * reaches it. `mako`: the harness has none, and Mako's loop keeps the agent at
 * it, continuing after each turn until the agent reports it done or blocked.
 */
export type GoalsCapability =
  | {
      kind: "native"
      via: string
      /**
       * Who holds a goal to its token budget. `harness`: the harness, given
       * it with the goal. `mako`: Mako counts the conversation's tokens and
       * stops the turn that spends the last of it.
       */
      budget: "harness" | "mako"
      send(command: DriverGoalCommand): GoalDelivery
    }
  | { kind: "mako"; reason: string }

/** One side question as a driver receives it. */
export interface DriverSideQuestion {
  /** The side conversation it belongs to: its first question opens it, and `close` ends it. */
  side: string
  question: string
  /** The side conversation's answered exchanges, oldest first, for a harness that doesn't keep them itself. */
  earlier: readonly EarlierExchange[]
  /** The answer's text as it arrives; a harness that answers whole calls it never. */
  stream(text: string): void
  /** Aborted when the user stops the answer. */
  signal: AbortSignal
}

/**
 * A question asked beside the turn, answered from the conversation's context
 * without interrupting the turn or joining the conversation. `native`: the
 * harness's own. `fork`: Mako asks a copy of the session, which `close`
 * discards. `ask` resolves with the whole answer once it is written.
 */
export type SideQuestionsCapability =
  | {
      kind: "native" | "fork"
      via: string
      ask(id: string, question: DriverSideQuestion): Promise<string>
      close(id: string, side: string): Promise<void>
    }
  | DriverAbsent

/**
 * How a review reaches the harness: as the command its own client types,
 * sent as written with nothing before it, or as a call that starts the
 * review's turn the way `prompt` starts one, reporting delivery through the
 * same dispatch.
 */
export type ReviewStart =
  | { via: "message"; text(target: ReviewTarget): string }
  | { via: "call"; run(id: string, target: ReviewTarget, settings: SessionSettings | undefined, dispatch: PromptDispatch): Promise<void> }

/**
 * Starting a code review. `native`: the harness's own review. `mako`: the
 * harness has none, and Mako's review prompt asks the agent for one. Either
 * way the review is a turn of the conversation, and its findings show as the
 * review's card when they arrive as data or in a `mako-review` block.
 */
export type ReviewCapability =
  | { kind: "native"; via: string; start: ReviewStart }
  /** `reviewer`: how the prompt tells the agent to hand the review to a reviewer of its own. */
  | { kind: "mako"; reason: string; reviewer?: string }

/** Changing the running session's mode. `single`: the harness runs one mode, and why. */
export type ModeSwitching = { kind: "native"; via: string } | { kind: "single"; reason: string }

/**
 * A running agent's grant to Mako's own MCP servers: `mako-computer` for
 * browser and computer use and, when the host serves it, `mako` for the
 * Thread's worktree, app and recipe; plus the control CLI when it started.
 */
export interface ConversationTools extends ToolGrant {
  control?: ControlLaunch
}

/** Mako's servers for one launch, by the names the agent sees. Every adapter adds exactly these. */
export function conversationServers(tools: ConversationTools): Array<{ name: string; url: string }> {
  const servers = [{ name: MAKO_COMPUTER_SERVER, url: tools.computerUrl }]
  if (tools.makoUrl) servers.push({ name: MAKO_THREAD_SERVER, url: tools.makoUrl })
  return servers
}

/**
 * What Mako tells the agent itself, beside the instructions of its servers:
 * how media reaches the person (`SHOW_MEDIA_LINE`). An adapter whose
 * harness takes instructions of its own hands it them there and declares
 * `makoInstructions`; elsewhere Mako's note before each prompt carries it.
 */
export function conversationInstructions(tools: ConversationTools | undefined): string | undefined {
  return tools?.makoUrl ? SHOW_MEDIA_LINE : undefined
}

/** Why an unattended start (`ProviderStartOptions.unattended`) that needed a person to sign in failed. */
export const UNATTENDED_SIGN_IN = "It isn't signed in here, and nobody is here to sign it in."

/** What a conversation owner starts a session with. Host-only: never in the renderer wire contract or journals. */
export interface ProviderStartOptions extends LiveStartOptions {
  /** Known native occurrences from this binding, including answered ones. Keep
   * identities on callback replay; observe only, never send saved answers again. */
  observedApprovals?: import("../contracts/approval-response.js").NativeApprovalIdentity[]
  /** Prior child identities for this exact resumed binding; states require fresh evidence. */
  observedAgents?: NativeAgentObservation[]
  /** The harness's last session totals for this exact resumed binding, which its process may restore. */
  observedUsage?: import("../contracts/providers-acp.js").NativeTotals
  /** The owner's generation-fenced sink: a replaced or hibernated owner hears nothing more. */
  emit: (event: LiveDriverEvent) => void
  mcpSnapshot?: () => Promise<McpRegistrySnapshot>
  fork?: NativeForkSource
  conversationTools?: ConversationTools
  /** Set on the agent process with `applyThreadEnvironment`, beside the control environment. */
  threadEnvironment?: ThreadEnvironment
  /**
   * Nobody is at this host to sign a harness in (a cloud machine, whose sign-ins come from the account): a start that
   * would ask a person to sign in fails at once, saying the harness isn't signed in, instead of waiting for an answer.
   */
  unattended?: boolean
}

/** What a driver's own start receives: the owner's options and the account admission launched it on. */
export interface AdmittedStartOptions extends ProviderStartOptions {
  /** This launch's trace, opened by admission; the driver records its phases on it. */
  trace: ProviderLaunchTrace
  /** The account's environment, held while the session runs. Use it; never resolve the selection again. */
  accountLaunch: AccountLaunch
  /** Amends that account's usage from limits the session reported, so its meter moves without a request. */
  observeUsage(amend: UsageAmendment): void
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
  /**
   * Where the harness takes Mako's own instructions (`conversationInstructions`)
   * as its own, never as the person's words: Claude's appended system
   * prompt, Codex's turn context. Absent, Mako's note before each prompt
   * (`controlNote`) carries them, which every reader of history strips.
   */
  makoInstructions?: { via: string }
  /** Native principal evidence, separately from configured account selection. */
  nativeIdentity: NativeIdentityCapability
  nativeExclusion: NativeExclusionCapability
  /** Whether an accepted reference identifies a stored user message, independently of the native run ID. */
  nativePromptIdentity: NativePromptIdentityCapability
  /** Required only for native atomic exclusion. Acquisition must precede
   * opening/resuming, and protect against the native CLI as well as Mako.
   * Failed acquisition must leave no executing session behind. Native writes
   * must themselves remain excluded/fenced; a host assertion is not a lock. */
  startExclusive?(cwd: string, options: AdmittedStartOptions): Promise<{
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
  approvalAnswerDigest?(request: import("../contracts/providers-acp.js").LivePermissionRequest, response: LivePermissionResponse): string | undefined
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
  goals: GoalsCapability
  sideQuestions: SideQuestionsCapability
  review: ReviewCapability
  modeSwitching: ModeSwitching
  /** The modes a fresh session will offer, declared without starting one. */
  modes?: readonly LiveSessionMode[]
  /** The mode a fresh session runs under when nothing was chosen — the level the chip reports before launch. */
  defaultMode?: string
  backgroundStop: BackgroundStop
  /**
   * Stops one roster entry the provider can stop alone (one it observed as
   * `stoppable`), leaving the session and the rest of its work running.
   */
  stopNativeAgent?(id: string, nativeId: string): Promise<void>
  turnRecovery: TurnRecovery
  /**
   * What its start runs first, run ahead while a cloud machine boots (`StartPrefetch`). Every installed harness
   * declares it (`test-harness-definitions.ts`); a fixture driver may leave it out.
   */
  startPrefetch?: StartPrefetch
  available(appPath: string): boolean
  start(cwd: string, options: AdmittedStartOptions): Promise<LiveSessionState>
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
  /** As the host quits: close every session still open, ending its process the way its own client does. */
  stop?(): void
}

/** A registered driver as the host hands it out: admission chooses each start's account. */
export type AdmittedLiveDriver = Omit<ProviderLiveDriver, "start"> & {
  start(cwd: string, options: ProviderStartOptions): Promise<LiveSessionState>
  /** The harness's declared oldest version, which a reopened session's runtime change is judged by. */
  runtimeOldest?(): string | undefined
}

export interface ProviderSteerInput {
  id: string
  expectedRunId: string
  text: string
  /** What Mako shows for the message, where it differs from `text` (a question's reply); its stream keeps both. */
  shown?: string
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
  const prefetch = driver.startPrefetch
  if (prefetch && !prefetch.via.trim())
    throw new Error(`${driver.provider}: explain its start prefetch`)
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
  const { resume, fork, steering, questions, nativeAgents, contextBreakdown, compaction, goals, sideQuestions, review, modeSwitching } = driver
  const texts: [string, string][] = [
    ["resume", text(resume)], ["fork", text(fork)], ["steering", text(steering)], ["questions", text(questions)],
    ["subagents", text(nativeAgents)], ["context breakdown", text(contextBreakdown)],
    ["compaction", compaction.kind === "supported" ? "started by Mako" : compaction.reason], ["goals", text(goals)],
    ["side questions", text(sideQuestions)], ["review", text(review)], ["mode switching", text(modeSwitching)],
  ]
  if (resume.kind === "native") texts.push(["idle wake", resume.wake])
  return texts
}

/** Call immediately before answering a native request, after any adapter awaits. */
export interface ApprovalDispatch {
  assertCurrent(): void
  report(result: ApprovalSubmission): void
}
