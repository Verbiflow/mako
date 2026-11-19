import { ReportActionTargetSchema, ReportDispositionSchema, type ReportAction } from "../contracts/report-actions.js"
import type { ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { SessionSettingsSchema, type SessionModel, type SessionSettings } from "@mako/sessions/settings"
import { writeMessage } from "@mako/sessions/context-wire"
import { findThreadReference, parseThreadToken, referenceItems, threadReferenceId, threadToken } from "@mako/sessions/thread-references"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { branchSince, checkoutSince } from "../base/checkout-since.js"
import { cutAccount } from "./cut-account.js"
import { personWaiting } from "./session-report.js"
import { agentMessageOrder } from "./agent-message-order.js"
import type { WaitSubscription } from "../contracts/agent-tools.js"
import type { Waiting } from "../contracts/notifications.js"
import { finMovedText, finResumedText, worktreeRemadeText, worktreeRemadeWords } from "../contracts/resume-account.js"
import type { WorktreeRestored } from "../contracts/thread-worktrees.js"
import { isLimitAsk, limitNoticeId, limitNoticeLine, limitNoticeWords, movedLine, movedWords, outOfAccountsLine, placeKey, stepKey, type AccountContinuation, type FallbackAccount, type FallbackConnection, type FallbackStep, type FinMove } from "../contracts/fin-fallback.js"
import { errorMessage } from "../base/error-message.js"
import { z } from "zod"
import { homedir } from "node:os"
import { ACCESS_TIER_NAMES, accessModeId, sessionAccessTier, type AccessTier } from "../contracts/access.js"
import {
  childAccess,
  childEntry,
  sameChildEntry,
  reportAsk,
  ruleWords,
  childMode,
  childState,
  childSince,
  decisionOn,
  decisionWords,
  finPullRequests,
  pullKey,
  pullRef,
  idleFor,
  modeWithin,
  waitingStateWords,
  waitingWords,
  WAITING_ON_LIMIT,
  type FinPullRequest,
  type WaitingOn,
  PlaceSchema,
  ORCHESTRATION_VERSION,
  ReportSchema,
  type AgentsCancelInput,
  type AgentsCancelled,
  type AgentsCapabilities,
  type AgentsNoticed,
  type AgentsNoticeInput,
  type AgentsPlaced,
  type AgentsPlaceInput,
  type ApexCaller,
  type Placed,
  type PlaceTarget,
  PlaceTargetSchema,
  reportPhase,
  reportWord,
  reportRoute,
  APEX_ROLE,
  APEX_WORD,
  FIN_WORD,
  TREE_BUDGET,
  startRateWords,
  type AgentCaller,
  type AgentRefused,
  type AgentsDiagnostics,
  type AgentsDirected,
  type AgentsDirectInput,
  type AgentsRedirected,
  type AgentsRedirectInput,
  type AgentsRespondInput,
  type ChildJournal,
  type ChildStart,
  type FinDeliver,
  type FinDelivery,
  type ChildState,
  type ChildThread,
  type QueueReason,
  FinReroutedSchema,
  type FinRerouted,
  type LimitNotice,
  type LimitNoticeChoice,
  queuedWords,
  quietProgress,
  awaitedAnew,
  othersOnly,
  type Report,
  type ThreadParent,
  type TreeBudget,
  turnFailedAt,
  closedFinished,
  edgeStopped,
  FINISHED_CLOSE,
} from "../contracts/agents.js"
import type { LiveAction } from "../contracts/live-actions.js"
import {
  afterStart,
  APEX_DIGEST_FINS,
  WAIT_LIMIT_MS,
  LIST_ENDED_FOR_MS,
  type AgentOperations,
  type AgentsApexes,
  type AgentsCrew,
  type OtherApex,
  type AgentStrip,
  type CrewMate,
  type AgentsLinkInput,
  type AgentsLinkResult,
  type AgentsListInput,
  type AgentsListResult,
  type AgentsReadInput,
  type AgentsReadResult,
  type AgentsReportInput,
  type AgentsSettleInput,
  type AgentsSettleResult,
  type AgentsReportResult,
  type AgentsAnswered,
  type AgentsAnswerInput,
  type AgentsAnswerResult,
  type AgentContextInput,
  type AgentMoved,
  type AgentNotMoved,
  type AgentsMoved,
  type AgentsMoveInput,
  type AgentsMoveResult,
  type AgentsThreads,
  type AgentsSendInput,
  type AgentsSendResult,
  type AgentsSent,
  type AgentsStarted,
  type AgentsStartInput,
  type AgentsStartResult,
  type AgentsStopInput,
  type AgentsStopResult,
  type AgentsWaitInput,
  type AgentsWaitResult,
  type StartWaited,
  type WaitedReport,
  type FrontDoorChild,
  frontDoorNote,
} from "../contracts/agent-tools.js"
import { agentWords, answerText, FOCUS_MS, isBrief, apexAsk, apexNote, briefText, askWords, CHILD_GROUPS, childGroup, childLine, childStateOf, finName, fromApex, HANDED_OVER_NOTE, membershipLine, openAsk, type OpenAsk, PASSED_ON_NOTE, passedOn, personsApproval, QUIET_MS, quietLine, rollup, stoodFor, YOUR_APEX } from "../contracts/children.js"
import { KeyedAdmission } from "../base/keyed-admission.js"
import type { FinAtWork } from "./fin-cost-sampler.js"
import { hostCallSchema } from "../contracts/host-call-inputs.js"
import { resetWords, type HarnessLimit } from "../contracts/account-usage.js"
import { signInPause, signInResuming } from "../contracts/sign-in-hold.js"
import { FIN_LIMIT, finPolicyNote, placeFull, roleRuleLines, type RoleRuleLines, type CloudFinLimits, type FinPlaceLimit, FinTuningSourceSchema, finTuningLine, finTuningWords, resolveFinTuning, type FinPolicy, type FinTarget, type FinTuningSource } from "../contracts/fin-tuning.js"
import { AFTER_LIMIT, ASK_OPTIONS, type FinAsk, type NativeAgent } from "../contracts/native-agents.js"
import { backgroundWorkText, HELD_WORK_CEILING_MS, pendingWake, providerHolds, staleWork } from "../contracts/background-work.js"
import type { PendingAsk } from "../contracts/live-questions.js"
import { RESTART_RETIRED_MOVE, type ContextTransfer } from "../contracts/conversation-control.js"
import type { LiveRequest, LiveSnapshot, LiveStartOptions } from "../contracts/live-conversations.js"
import type { LivePermissionResponse, LiveSessionMode, PromptAttachment } from "../contracts/providers-acp.js"
import { SessionIdSchema, ThreadIdSchema, type Actor, type ThreadId } from "../contracts/thread-identity.js"
import { continuationsSpent, continueTurnPrompt, crashedChildTurn, CUT_BY, RESTART_CHAIN, STRANDED_AFTER_MS, strandedTurn } from "../contracts/turn-continuation.js"
import { uniqueName, type KeptAnswer, type KeptMark, type KeptPullWake, type ThreadCatalog, type ThreadStore } from "../threads/index.js"
import { AgentRuns, lastStep, type ProcessReads, type RunEnd } from "./agent-runs.js"
import { holdOf, keepsLine, nextInLine } from "../contracts/request-hold.js"
import { foldList } from "./agent-list-fold.js"
import { FinChanges, type ChangeFacts } from "./fin-changes.js"
import type { ThreadHistoryTools } from "./thread-history.js"
import { AgentWakes, DIGEST_WAITS, firstParagraph, FROM_AGENTS, fromAgent, type Notice, type ParentReady } from "./agent-wakes.js"
import { namedUuid } from "./cloud-moves.js"
import { carriedDigest } from "../contracts/delivery-retry.js"
import { settledWithin, type ContinueOn, type ThreadTarget } from "./continue-on.js"
import { unsettled } from "./live-transfers.js"
import type { LiveConversations } from "./live-conversations.js"
import { heldReferences, treeEdges } from "./thread-tree.js"
import type { ConversationChildren } from "./live-runtime.js"
import { macLoad, type MacLoad, type MacReading } from "./mac-capacity.js"
import { FinMoves, type FinPlace } from "./fin-moves.js"
import type { TurnReply } from "./live-goals.js"
import { PULL_WATCH_EVERY_MS, PullWatch, type PullWait } from "./pull-watch.js"
import { QuietWatch } from "./fin-quiet.js"
import { TurnWaits } from "./turn-waits.js"
import { CREW_STEPS_MAX, CREW_WAIT, crewWaitNote, crewWaitSeconds, turnWaitItemKey, turnWaitItemWords, turnWaitLine, turnWaitMovedNote, type CrewFin, type TurnWait, type TurnWaitItem, type TurnWaitLine } from "../contracts/turn-waits.js"
import { AFTER_WAIT, type TurnWaitInput, type TurnWaitResult } from "../contracts/thread-tools.js"
import { AgentPlaces, placeName, type AwayRefused, type OutboxNotice, type PlacedAsk, type PlaceLink, type ResolvedPlace } from "./agent-places.js"
import { checkedFinSource } from "./fin-source.js"
import { CommittedFinSourceSchema, type CommittedFinSource } from "../contracts/fin-source.js"
import { CloudFinStartSchema, cloudFinInputSha256, cloudFinThread, type CloudFinAnswer, type CloudFinPlace, type CloudFinPlaced, type CloudFinStart } from "@mako/protocol/cloud-fins"
import { ContinueRepositorySchema } from "@mako/protocol/continues"
import type { PullOutcome, PullReading, PullWaitUntil } from "../contracts/pull-waits.js"
import type { PullTarget as ReadTarget } from "../git/index.js"

const NONE: readonly NativeAgent[] = []
/** How long `agents_move` holds its answer for the switch to settle: within the door's window, and a failure later reports. */
const MOVE_WAIT_MS = 20_000
/** At most this long `personAsk` answers from its kept walk of a tree, should a change reach it no other way. */
const ASKS_KEPT_MS = 1_000
/** Conversations `agents_list` with `scope: threads` answers with. */
const THREADS_LISTED = 20
/** How long a start waits to read whether a harness's account is at its limit before taking it as having room. */
const LIMIT_READ_MS = 3_000
/** A Fin's own Fins in these states are work it still waits on. */
const WAITED_ON: ReadonlySet<ChildState["kind"]> = new Set(["queued", "starting", "working", "blocked"])
/**
 * A Fin's turn that ended on progress, with nothing it waits on that will wake it, in the words of its report
 * (`Report.unfinished`), which every surface heads "ended without a result": its last words lead, the whole reply follows.
 */
function holding(names: readonly string[]): { holds?: string[] } {
  return names.length ? { holds: [...names] } : {}
}

function unfinishedSummary(words: string): string {
  const last = firstLine(words).slice(0, 240)
  const head = `Nothing it waits on will wake it.${last ? ` Its last words: "${last}"` : ""}`
  return (words.trim() && words.trim() !== last ? `${head}\n\n${words.trim()}` : head).slice(0, 16_000)
}
/** How long a message waits for a Fin's session to finish reopening before it's refused: half a door's wait. */
const SWITCH_WAIT_MS = WAIT_LIMIT_MS / 2
/** Who a pull request's outcome reaches its Fin as: Mako, never the person. */
const PULL_WATCH_ACTOR: Actor = { kind: "service", name: "pull-watch" }
/** Whether a message is Mako's note of a pull request's outcome. */
/** What a turn took: the request that began it and those steered into it, unless they were refused. */
function inputsOf(request: string, actions: readonly LiveAction[] | undefined): string[] {
  const steered = (actions ?? []).flatMap(({ input, state }) => {
    if (input.kind === "compact" || input.requestId !== request || state.kind === "failed" || state.kind === "not-accepted") return []
    return [input.kind === "steer-queued" ? input.queuedRequestId : input.id]
  })
  return [request, ...steered]
}

const TURN_WAIT_ACTOR: Actor = { kind: "service", name: "turn-wait" }
/** A pull request's key in PullWatch for a turn wait's item, so its outcome goes to the wait (`pullOutcome`). */
const TURN_WAIT_PULL = "turn-wait:"

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? ""
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

function isTurnWaitNote(request: Pick<LiveRequest, "actor">): boolean {
  return request.actor?.kind === "service" && request.actor.name === "turn-wait"
}

function isPullNote(request: Pick<LiveRequest, "actor">): boolean {
  return request.actor?.kind === "service" && request.actor.name === "pull-watch"
}
/** How often what waits looks again, for a limit the person raised or a Fin that ended unseen. */
const ROOM_EVERY_MS = 10_000
/** The job that looks every `ROOM_EVERY_MS`. */
export const ROOM_WATCH_JOB = "read this device's capacity"
/** How long an ask its Apex may answer waits on the Apex alone before the person is asked too. */
export const APEX_ANSWER_MS = 60_000
/**
 * How long after a Fin reports a decision its Apex may go without hearing it before the person is asked anyway: the
 * stretch Mako lets a working Apex go before it steers in what waits (`FOCUS_MS`), and the minute an Apex has to answer
 * (`APEX_ANSWER_MS`). Three minutes. A decision's minute starts when its Apex hears it (`decisionHeardAt`), and this
 * bounds how long that can take, so none waits behind a turn that runs for an hour.
 */
export const DECISION_HEARD_BY_MS = FOCUS_MS + APEX_ANSWER_MS
/**
 * How long a Fin stays open after it finished with nothing left open, before Mako closes its edge (`closeFinished`).
 * Six hours is the person's decision of 2026-11-17: long enough that an Apex still at the same piece of work finds its
 * Fins where it left them, short enough that a day's finished Fins don't ride every prompt, list and start after it. It
 * is also `HELD_WORK_CEILING_MS`, past which Mako no longer counts on work a harness left running.
 */
export const FINISHED_CLOSE_MS = 6 * 60 * 60_000
/** How often finished Fins are looked at again while one is open (`FINISHED_SWEEP_JOB`): a close may come this late. */
const FINISHED_SWEEP_MS = 15 * 60_000
/** The job that closes finished Fins once their time has come. */
export const FINISHED_SWEEP_JOB = "close finished Fins"

/**
 * The rows of a harness each exact id can mean: a Fin's reach looks up every row it lists, so a walk of all of them for
 * each would be a walk of their square. An id with no row of its own may be a short one, which only that walk can tell.
 */
function referenceIndex(rows: readonly ThreadRef[]): Map<string, ThreadRef[]> {
  const byId = new Map<string, ThreadRef[]>()
  for (const row of rows)
    for (const id of new Set([row.nativeId, threadReferenceId(row)])) {
      const held = byId.get(id)
      if (held) held.push(row)
      else byId.set(id, [row])
    }
  return byId
}

/** What a message into a Fin's Thread attaches: what `reachOf` passed, or with `passedOn` what the person's own message granted. */
interface Attaching {
  refs?: readonly string[]
  passedOn?: string[]
  notification?: true
  expects?: "answer"
}

/** A steer the harness took, as `inputDelivered` reads it. */
type SteerDelivered = Pick<LiveRequest, "id" | "text" | "actor"> & Partial<Pick<LiveRequest, "digest" | "continues" | "goal">>

/** What a message into a child's Thread became, and when the child hears it. */
interface Delivered {
  delivery: FinDelivery
  hears: string
  deduped?: true
}

/** How long a steer waits for its child's turn to start, and then for its harness's answer, before the call answers without it. */
const STEER_WAIT_MS = 3_000
const STEER_ANSWER_MS = 2_000
/** How `agents_send` names another of the person's Apexes: `apex:<title or Thread ID>`. */
const APEX_PREFIX = "apex:"
/** Messages one Apex sends another in an hour; past them it's refused, so two Apexes can't talk in a loop. */
const APEX_SENDS_PER_HOUR = 3
const HOUR_MS = 3_600_000

/** Another of the person's Apexes as a message to it is addressed: its Thread, and the conversation that speaks for it. */
interface OtherApexRef {
  thread: string
  conversation: string
  title?: string
}

/** A message to another Apex whose reply goes back: to whom, from whom, as the sender's digest names it. */
interface ApexAsk {
  sender: Apex
  notification?: true
  /** Its conversation and the requests whose turn answers it: the message's own, or the turn it was steered into. */
  conversation: string
  requests: string[]
  thread: string
  label: string
  /** The Apex as the sender's card of its reply names it. */
  fin: { name: string; harness?: string }
}

/** A message Mako's exit or a crash paused, which the next host resumes for a Fin: never a Stop's, which waits for a deliberate resume. */
function madePaused(request: LiveRequest): boolean {
  const hold = holdOf(request)
  return hold?.kind === "paused" && hold.by === "mako"
}

/** Entries `agents_read` shows of a transcript, and the characters it returns at most. */
const READ_ENTRIES = 40
const READ_CHARS = 8_000

/**
 * The brief/digest identity a cut turn still reconciles against its native transcript (`LiveDispatch`). Task briefs
 * remain retained context for a new continuation; digests keep their report payload, since an admitted but unheard
 * notification otherwise has no delivery left. Neither a Stop nor a native receipt is bypassed.
 */
function cutBrief(op: string | undefined, cut: LiveRequest): string | undefined {
  const root = cut.continues?.brief ?? (cut.digest || (op !== undefined && cut.id === namedUuid(`${op}\nbrief`)) ? cut.id : undefined)
  return cut.nativeDelivery?.evidence.kind !== "accepted" ? root : undefined
}

/** A message on its way to a Fin, and whether a Stop came meanwhile; `worktree`, what became of a worktree Mako had retired from under it, for its sender's receipt. */
interface Crossing {
  stopped: boolean
  worktree?: string
}

type Live = Pick<
  LiveConversations,
  "session" | "held" | "nativeIds" | "atWork" | "resumeHeld" | "stopHolds" | "rewriteWaiting" | "rewordWaiting" | "adoptPin" | "wakeDue" | "snapshot" | "editQueued" | "switchSettled" | "stopMark" | "pinnedAccount" | "submit" | "act" | "cancel" | "continueTurn" | "leftUnsettled" | "waitingOn" | "workOf" | "pendingAsk" | "permission" | "steersAtStep" | "steering" | "interrupt" | "turnReply" | "childrenChanged" | "connectedSession" | "recordDirect" | "recordNote" | "switching" | "readIn"
> & Partial<Pick<LiveConversations, "waitChanged" | "expect">>

/** What starting a Fin in the cloud asks of the account and this device (`AgentsDeps.cloudFins`). */
export interface CloudFins {
  /** The harnesses the cloud's machines run, as the cloud says. */
  harnesses(): Promise<readonly string[]>
  /** The Fin's folder as a committed, pushed source (`captureFinSource`); throws, saying why, when it isn't one. */
  capture(folder: string): Promise<CommittedFinSource>
  reserve(start: CloudFinStart): Promise<CloudFinAnswer>
  start(place: CloudFinPlace): Promise<CloudFinPlaced>
  cancel(start: CloudFinStart): Promise<CloudFinAnswer>
}

/** A cloud start's own record, kept on its row before anything leaves: the start, what its machine clones, its source. */
export type CloudAway = { start: CloudFinStart; repository: { url: string; branch?: string }; source: CommittedFinSource; folder?: string }

export interface AgentsDeps {
  /** `thread_history`'s tools, for `agents_read`'s `search` of one Fin; absent until the host builds them. */
  history?: () => ThreadHistoryTools | undefined
  store(): ThreadStore | undefined
  catalog: Pick<ThreadCatalog, "nativePath" | "ref" | "page" | "activity" | "subscribe" | "announce"> & Partial<Pick<ThreadCatalog, "readRef">>
  jobs: HostJobs
  live: Live
  /** This Thread continues on that harness (`continueOn`): a Fin's move and its relaunch both. */
  continueOn: ContinueOn
  /** Every conversation on this device, as an `@` picker offers them, and each one's transcript: what `context` attaches. */
  references?: Pick<ThreadCatalog, "list" | "transcriptArtifact">
  /** Starts a conversation as `mako:live-start` does: its worktree, its profile and its mode. */
  startLive(harness: string, cwd: string, options: LiveStartOptions): Promise<void>
  /** The harnesses a Fin can run on: those with a live driver here. */
  harnesses(): readonly string[]
  /** Whether `harness` has a CLI a Thread's shell can run, so a Session of it can be one started there. */
  runs(harness: string): boolean
  harnessLabel(harness: string): string
  /** The modes `harness`'s live driver declares, each with its access tier; undefined for one that declares none. */
  modes(harness: string): readonly LiveSessionMode[] | undefined
  /** Whether a conversation's agent asked to move into its worktree and the move hasn't happened yet: it carries on there. */
  movePending?(conversation: string): boolean
  /** Whether the person archived a conversation's Thread: a Fin's work ends there for good, until they restore it. */
  archived?(conversation: string): boolean
  /** What a Fin of `harness` in `cwd` may run on: the harness's catalog, Mako's pick for it, and the person's own choices there. */
  finChoices?(harness: string, cwd: string): Promise<FinChoices>
  /** `harness`'s catalog as this host last read it, for a Fin's row; undefined before it's read. */
  catalogOf?(harness: string): readonly SessionModel[] | undefined
  /** `harness`'s account in use when it's at its limit (`HarnessAccounts.limited`); undefined while it has room. */
  limited?(harness: string): Promise<HarnessLimit | undefined>
  /** The harnesses in the person's order (Settings › Models), most preferred first: where a Fin goes when its Apex's harness is at its limit. */
  harnessOrder?(): Promise<readonly string[]>
  /** The person's rules for which work goes to which harness and model (Settings › Fins). */
  finPolicy?(): FinPolicy | undefined
  /**
   * A harness's accounts in the person's order as a Fin's fallback order reads them (`HarnessAccounts.standing`):
   * with it, a Fin whose account runs out starts on, or goes on at, the next step of its order (`FinMoves`).
   */
  accounts?(harness: string, on?: string, all?: boolean): Promise<readonly FallbackAccount[]>
  /** The person's model connections as `harness`'s declared routes take them. */
  connections?(harness: string): Promise<readonly FallbackConnection[]>
  /** Whether `harness`'s session goes on under another account (`ProviderLiveDriver.accountContinuation`). */
  accountContinuation?(harness: string): AccountContinuation | undefined
  /** Settings › Fins: "When an account runs out, continue on the next one"; absent, on. */
  moveOnLimit?(): boolean
  budget?: Partial<TreeBudget>
  /** How many of the person's Fins run at once on this device, every tree's: its capacity or their own number (`FinCapacity`); `FIN_LIMIT` without it. */
  finLimit?(): number
  /** Operations this device runs for another place's Threads under borrowing's leases: each takes a Fin's place here. */
  lent?(): number
  /** Reads the machine for its capacity, with the Fins at work here and their harnesses, as what waits is looked at. */
  observeCapacity?(working: number, mix: Readonly<Record<string, number>>, fins?: readonly { conversation: string; harness: string }[]): Promise<void>
  /** The person's Fins at once across every place (Settings › Fins): a safety net over the places' own. */
  finCeiling?(): number
  /** The places a start may name (`here`, `device:<name>`, `cloud`); only `here` until placement lands. */
  places?(): readonly string[]
  /** How this host reaches the person's other devices (`PlaceLink`); without it a Fin starts here only. */
  away?: PlaceLink
  /** The Git remote `cwd`'s repository is a checkout of (its `origin`), which a Fin placed elsewhere works in a checkout of; undefined for a folder with none. */
  remoteOf?(cwd: string): Promise<string | undefined>
  /** A checkout of `remote` on this device for a Fin placed here: one it has, or a clone it makes; refused with why. */
  checkoutOf?(remote: string): Promise<{ folder: string } | { refused: string }>
  /** Verify an already prepared private checkout and return the source's confined cwd before its brief is started. */
  verifySource?(folder: string, source: CommittedFinSource): Promise<string>
  /** The most access a Fin started here from another device may have (`PLACED_CEILING` without it). */
  placedCeiling?(): AccessTier
  /** What bounds the cloud's Fins (the person's plan and spend ceiling), once Fins start there; nothing without it. */
  cloudLimits?(): CloudFinLimits
  /**
   * Starting Fins in the cloud, once that's open: no shipping wiring gives it yet, so `place: cloud` is refused as it
   * always was. With it, a start is reserved by the account, made into its cloud Thread on a machine of its own, and
   * placed there with its committed source, all under its one op (`CloudFins`).
   */
  cloudFins?: CloudFins
  /** This Mac's cores, memory and load (`MacCapacity`): a start's answer says when it's busy, and it starts anyway. */
  capacity?: { read(): Promise<MacReading> }
  processes?: ProcessReads
  /** `APEX_ANSWER_MS`, shorter in tests. */
  apexAnswerMs?: number
  /** `FOCUS_MS`: how long a working Apex's turn runs before what waits for its end is steered in once; shorter in tests. */
  focusMs?: number
  /** How long a working Fin may show no activity before its Apex hears it (`QuietWatch`); `QUIET_MS` without it. */
  quietMs?: number
  /**
   * The pull requests whose head is `branch` in `repoRoot`, as this host last read them (the worktree summaries'),
   * without asking GitHub; none before any were read.
   */
  heldPulls?(repoRoot: string, branch: string): readonly { number: number; url: string; state: "open" | "draft" | "merged" | "closed" }[]
  /**
   * Makes again the worktree Mako retired from under a finished Fin, before a message reaches its conversation
   * (`ThreadWorktreeService.restoreRetired`), and says how it went; undefined when it had none retired.
   */
  restoreWorktree?(conversation: string): Promise<WorktreeRestored | undefined> | undefined
  /** Runs `run` once after `ms` on an unreferenced timer, and returns what cancels it: a test's fake clock instead. */
  later?(ms: number, run: () => void): () => void
  /** One pull request a Fin waits on, as GitHub says it stands now (`readPull`); without it nothing is watched. */
  readPull?(target: ReadTarget): Promise<PullReading | null>
  /** A conversation's app check under way, heard as it ends (`EnvironmentTools.watchCheck`); false when none is. */
  watchCheck?(conversation: string, tier: "quick" | "full", onEnd: (words: string) => void): Promise<boolean>
  now?(): number
}

/** What a Fin of one harness may run on (`AgentsDeps.finChoices`). */
export interface FinChoices {
  /** Its catalog; empty while it hasn't been read. */
  models: readonly SessionModel[]
  /** Mako's pick for the harness (`HarnessDefaults.work`). */
  recommended?: SessionSettings
  /** The person's Settings › Fins choice for it. */
  chosen?: SessionSettings
  /** The model the person last started or sent with on it. */
  used?: SessionSettings
}

/** A spawn's model, decided as it's admitted: what it starts with, where that came from, and any choice passed over. */
interface Tuned {
  settings?: SessionSettings
  source: FinTuningSource
  note?: string
  rerouted?: FinRerouted
  rule?: { n?: number; when: string }
}

/** The person's rule a spawn follows, or their choice for work no rule fits: where it sends the Fin, and its words. */
interface Ruled {
  target: FinTarget
  who: string
  rule: { n?: number; when: string }
}

/** Whether a harness took a request: `prepared` and `uncertain` say it may not have, and a refusal that it didn't. */
function handedOver(request: LiveRequest): boolean {
  const evidence = request.nativeDelivery?.evidence.kind
  return request.status === "completed" || evidence === "submitted" || evidence === "accepted"
}

/** A request waiting out a limit, which a move can take over: a Stop's latch leaves it where it is. */
type RosterLimitNotice = NonNullable<NativeAgent["child"]>["limitNotice"]
function sameLimitNotice(left: RosterLimitNotice, right: RosterLimitNotice): boolean {
  return left?.id === right?.id && left?.waiting?.version === right?.waiting?.version && left?.waiting?.count === right?.waiting?.count && left?.waiting?.at === right?.waiting?.at && left?.waiting?.resets === right?.waiting?.resets
}

function waitsOnLimit(request: LiveRequest): boolean {
  return request.status === "held" && request.retry?.cause === "rate-limited" && request.pause !== "stop"
}

/** A notice gathers what one limit does across its tree for this long, so it says it all at once. */
const NOTICE_GATHER_MS = 3_000
/** A notice's only answer. */
const SEEN_OPTIONS = [{ label: "Got it" }]

/** A notice gathering what a limit does to its tree: kept in the store, this is only its time to go. */
interface LimitEpisode {
  id: string
  timer: NodeJS.Timeout
}

/** The longest a timer holds: a limit's reset can be further off. */
const LONGEST_TIMER_MS = 2 ** 31 - 1

/** An Apex resolved in the store: its Session, its Thread, and its conversation here. */
interface Apex {
  session: string
  thread: string
  conversation?: string
  source?: CommittedFinSource
  sourceRoot?: string
  /**
   * It runs on another device and calls for the Fins it placed here (`ApexCaller`): its device, its conversation there,
   * its access as this device bounds it, and the person's message its turn answers.
   */
  away?: { device: string; conversation?: string; access: AccessTier; forwards?: string; epoch?: number }
}

/**
 * The most access a Fin started from another device runs at here: the person's decision of 2026-11-06 (B2, "Auto
 * edits, Full by choice"). Full by choice comes with the per-device ceiling's Settings, a later slice, which replaces
 * this constant; until then no placed Fin runs on full here, so an Apex on another device never grants a Fin's
 * approvals here: the person does, in the Fin's own Thread.
 */
export const PLACED_CEILING: AccessTier = "auto"

/** What a limit moves on: a Fin, by its edge, or the Apex at the top of a tree, which has none. */
interface Mover {
  thread: string
  edge?: ThreadParent
  /** Whose rules its target's model is chosen under. */
  apex: Apex
  tier: AccessTier
}

/** What a move goes on: the harness's own word for the limit, if it gave one, and where the turn has been. */
interface Spent {
  limit: TurnReply["limit"]
  /** Where this logical turn ran already (`FinTurn`): a move never goes back there. */
  visited: readonly string[]
}

/** Fins with nothing running on the account that ran out: they go with the tree, so their next message finds room. */
const IDLE_MOVES: ReadonlySet<ChildState["kind"]> = new Set(["idle", "blocked"])

/** What a spawn the running budget holds keeps, so the host that drains it starts what was asked. */
interface QueuedStart {
  /** Its Apex, under the key queued spawns were stored with. */
  lead: Apex
  input: AgentsStartInput
  tier: AccessTier
  harness: string
  /** Absent from a build before models were decided at admission: decided at its start. */
  tuned?: Tuned
  /** What held it: the tree's running budget, or the person's limit of Fins at once (`place-full`). Absent: only `after`, or a record from before. */
  why?: Extract<QueueReason, "tree-running" | "place-full">
  /** The Apex's Fins it starts after, each once it has finished: a Fin by its Thread, or a spawn queued too by its op. */
  after?: AfterRef[]
  /** Why it couldn't start once released: it stays, saying so, until its Apex has heard (`tellHeld`). */
  refused?: string
  /** The request named to tell its Apex why it can't start, kept here since a notice has no report row (`heldIn`). */
  wake?: string
  /**
   * It starts in another place: where its start is sent, and the Git remote its checkout there is of. `sent` once its
   * start left for that place, written before the call: from then, whether a Fin runs there is that place's to say.
   * `stop` once its Apex stopped it with that unsaid, kept until that place answers (`cancelAway`).
   */
  away?: { target: PlaceTarget; remote: string; sent?: number; stop?: { at: number; why: string }; cloud?: CloudAway }
}

interface AfterRef {
  name: string
  child?: string
  op?: string
}

/** How a spawn's `after` stands: the names still to finish, and the first that won't, which holds it. */
interface AfterStand {
  pending: string[]
  held?: { name: string; outcome: "failed" | "stopped"; reason?: string; session?: string }
}

/** Whose a queued start is: the Apex that asked, by Session, Thread and conversation. */
const QueuedByApexSchema = z.object({
  session: z.string(),
  thread: z.string(),
  conversation: z.string().optional(),
  source: CommittedFinSourceSchema.optional(),
  sourceRoot: z.string().optional(),
  away: z.object({ device: z.string(), conversation: z.string().optional(), access: z.enum(ACCESS_TIER_NAMES), forwards: z.string().optional() }).optional(),
})
const QueuedStartSchema = z.object({
  lead: QueuedByApexSchema,
  input: hostCallSchema("mako:agents-start").def.items[1],
  tier: z.enum(ACCESS_TIER_NAMES),
  harness: z.string(),
  tuned: z.object({
    settings: SessionSettingsSchema.optional(),
    source: FinTuningSourceSchema,
    note: z.string().optional(),
    rerouted: FinReroutedSchema.optional(),
    rule: z.object({ n: z.number().optional(), when: z.string() }).optional(),
  }).optional(),
  why: z.enum(["tree-running", "place-full"]).optional(),
  after: z.array(z.object({ name: z.string(), child: z.string().optional(), op: z.string().optional() })).optional(),
  refused: z.string().optional(),
  wake: z.string().optional(),
  away: z.object({ target: PlaceTargetSchema, remote: z.string(), sent: z.number().optional(), stop: z.object({ at: z.number(), why: z.string() }).optional(), cloud: z.object({ start: CloudFinStartSchema, repository: ContinueRepositorySchema, source: CommittedFinSourceSchema, folder: z.string().optional() }).optional() }).optional(),
}) satisfies z.ZodType<QueuedStart>
/** How the account's refusal of a cloud start reads to its Apex: full for now, not open to it, or not this start. */
function cloudRefusal(reason: string): AgentRefused["refused"] {
  return reason === "slots" || reason === "spend" ? "budget" : reason === "conflict" || reason === "cancelled" || reason === "missing" || reason === "generation" || reason === "thread" ? "conflict" : "place-unavailable"
}

function cloudWords(reason: string): string {
  const words = {
    slots: "The person's plan runs as many cloud machines at once as it allows; one frees when a cloud Fin ends.",
    spend: "Today's cloud spend and reservations reached the person's ceiling.",
    policy: "The account has no cloud plan this start can run under.",
    usage: "The account's cloud usage couldn't be confirmed, so nothing is started on it.",
    price: "The cloud's price couldn't be confirmed, so nothing is started on it.",
    unresolved: "The account has a cloud start it couldn't settle yet, so nothing more is started on it.",
    "no-cloud": "The person's plan doesn't include the cloud.",
    conflict: "The account holds this start's key for other work: start it again under another clientKey.",
    cancelled: "This start was cancelled.",
  }
  // SAFETY: `reason in words` was just checked, so it names one of the table's keys.
  return reason in words ? words[reason as keyof typeof words] : `The account refused the cloud start (${reason}).`
}

/** What a queued start's record still says when it no longer parses whole (an older Mako's): whose it is, and its name. */
const QueuedLeadSchema = z.object({
  lead: QueuedByApexSchema,
  input: z.object({ name: z.string().optional(), title: z.string().optional() }).optional().catch(undefined),
  harness: z.string().optional().catch(undefined),
  wake: z.string().optional().catch(undefined),
})

/** Where a Fin runs, as its limit counts it: `here` (this device), `device:<name>` or `cloud`. */
const HERE = "here"
const placeOf = (place: string | undefined) => place ?? HERE
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * A start under way (`Agents.starts`): one per Apex and client key, from its call's first step until it settles.
 * `name` is reserved once it launches, `launching` holds its place and its tree's, and `cancelled` is its stop.
 */
interface StartRecord {
  op: string
  thread: string
  /** The name it was asked for, which a stop by name finds it by before it has one of its own. */
  asked?: string
  name?: string
  launching?: { where: string; tree: string }
  cancelled: boolean
  answer: Promise<AgentsStartResult>
}

/** A device's word on a Fin's standing, as every device orders them: the host that said it, by its generation, and its count of sayings (`Placed.said`). */
type SaidMark = NonNullable<Placed["said"]>

/** Whether `next` is a newer word of a Fin's device than `said`, the mark kept on the edge: by the host's generation, then its count. */
function newerSaid(said: SaidMark | undefined, next: SaidMark): boolean {
  return !said || next.owner > said.owner || (next.owner === said.owner && next.seq > said.seq)
}

/** How a kept stop of a start or a Fin on another device went: stopped, as that device said, or why it still waits for it. */
type StopOutcome = { stopped: true } | { pending: string }

/** A queued start for another device found that device full as it started there, or got no answer from it: it stays queued (`drain`). */
const FILLED = "\0filled"

/** A queued spawn's notice that a Fin it was to start after didn't finish: `after:<op>`; once its Apex heard it, it's dropped. */
const HELD_PREFIX = "after:"
/** A quiet Fin's notice (`QuietWatch`): no report row holds it, and it goes once heard. */
const QUIET_PREFIX = "quiet:"
const stored = (id: string) => !id.startsWith(HELD_PREFIX) && !id.startsWith(QUIET_PREFIX)

/** How many of a tree's Threads work now and how many it started, as its budget counts them. */
/**
 * What the tree runs now, and what it started within its short window and within the hour: each `frees` is when enough
 * of those leave their window for one more start.
 */
type TreeCounts = { running: number; started: number; frees?: number; startedHour: number; freesHour?: number }

/** A `wait` start holding for its Fin: the Apex's conversation whose turn made the call, and how it hears the Fin move. */
interface Hold {
  child: string
  apex?: string
  check(): void
  end(): void
}

/** What answers whether a report settles a question its Apex asked (`answeredBy`): all of a report that asks. */
type ReportMark = Pick<Report, "at" | "status" | "handoff" | "awaits" | "answers">

/**
 * What the engine keeps of one Fin's reports, so nothing reads them again while none is new: the pull requests their
 * artifacts name, oldest report first, and each report's mark. `last` is the newest report it was read up to.
 */
interface ReportsHeld {
  last: string | undefined
  pulls: Pick<Report, "artifacts">[]
  marks: ReportMark[]
  /** Its open pull requests as last worked out, for the pull requests its branches held then (`held`, as one string). */
  open?: { held: string; found: FinPullRequest[] }
}

/** What a pass of `closeFinished` reads once: the store, its moment, and the Threads something is pending for. */
interface FinishedFacts {
  store: ThreadStore
  now: number
  /** Threads a pending follow-up action names, as its Fin or its owner. */
  actions: ReadonlySet<string>
  /** Fins with a report, an answer or a pull request's outcome kept and not delivered. */
  pending: ReadonlySet<string>
  /** Fins, and starts by their op, that a queued start or an armed wait names; an Apex with a start queued. */
  awaited: ReadonlySet<string>
  /** Trees with a queued start this build can't read. */
  unread: ReadonlySet<string>
}

/**
 * The one engine every Fin goes through (`contracts/agents.ts`): a Thread
 * another Thread's agent started (`agents_start`), or a harness CLI run its
 * shell started (`discovered`) or it named (`agents_link`). It starts a
 * Fin through `mako:live-start`, so a Fin is a conversation like any
 * other with its edge written with its Session (`LiveStartOptions.parent`);
 * follows it through its live conversation, or through `AgentRuns` while a
 * process Mako didn't start runs it; writes each end once, with at most one
 * implicit report; and tells the parent through `AgentWakes`. A tree's
 * budgets are held here, by the top Apex's host. Nothing here is saved twice:
 * the edge and the reports are the store's, the state is computed.
 */
export class Agents implements AgentOperations, ConversationChildren {
  readonly runs: AgentRuns
  readonly wakes: AgentWakes
  private readonly deps: AgentsDeps
  private readonly budget: TreeBudget
  /** This host's generation as a writer of reports: a report from an older owner is refused (`keepReport`). */
  private readonly generation: number
  private readonly entries = new Map<string, NativeAgent>()
  /**
   * Each Thread's roster as last built, with the entries that wear a limit's notice (`noticed`): those alone can go
   * stale with no commit (the notice's reset passes, a wait behind it moves), so a held roster is checked by them
   * and not by every entry it has.
   */
  private readonly rosters = new Map<string, { agents: readonly NativeAgent[]; noticed: readonly NativeAgent[] }>()
  /**
   * `personAsk`'s walk of a Thread's tree, kept while what it read stands: the edges, the reports and answers kept
   * (`ThreadStore.asksStamp`), and what each Fin beneath it asks, whose change drops the walks above that Fin alone
   * (`asksMoved`). `ASKS_KEPT_MS` bounds what none of those says (a Thread archived, an ask passed on by a timer).
   */
  private readonly asksKept = new Map<string, { edges: ReturnType<ThreadStore["edges"]>; reports: string; at: number; found: ReturnType<Agents["personAsk"]> }>()
  /** What each Fin asked when it last moved (`askKey`): a move that asks the same drops no walk. */
  private readonly askKeys = new Map<string, string>()
  private readonly conversations = new Map<string, string>()
  private readonly childOf = new Map<string, string>()
  private readonly starting = new Set<string>()
  /** The rules each conversation last read (`rulesNote`), as they were said. */
  private readonly rulesSaid = new Map<string, string>()
  /** When each Fin last changed for its Apex (`FinChanges`): `agents_list`'s marks and the front door's read it. */
  private readonly changes = new FinChanges()
  /** When each Apex conversation's front door last listed its Fins: one unchanged since is counted, not described again. */
  private readonly doorSaid = new Map<string, number>()
  private readonly waiters = new Set<() => void>()
  /** `wait` starts holding now: while one holds a Fin, its reports answer the start rather than wake its Apex. */
  private readonly holds = new Set<Hold>()
  /** Apexes whose turns a followed process ran, while their held reports start their next turn (`release`). */
  private readonly releasing = new Set<string>()
  /**
   * Fins whose turn ended while their own work went on, with that turn: its reply is their report once nothing is left.
   * `work` names what their harness held then (`pendingWake`), so a process that ends with it still pending is said;
   * `woke`, that its harness started a turn of its own since, on that work.
   */
  private readonly awaiting = new Map<string, { conversation: string; request: string; work?: string; woke?: true }>()
  /** By Fin, what cancels the timer that looks at its held work's end again past `HELD_WORK_CEILING_MS`: one at a time. */
  private readonly ceilings = new Map<string, () => void>()
  /**
   * Fins' conversations whose cut turn is looked at once Mako's own continuation would have been scheduled (`watchCut`),
   * and whether that continuation was still on its way (being verified, or queued for its next try) when the look was set.
   */
  private readonly cutChecks = new Map<string, { timer: NodeJS.Timeout; continuing: boolean }>()
  /** Messages on their way to each Fin (`deliver`), which a Stop marks: one may open a session before it has a queue to wait in. */
  private readonly crossings = new Map<string, Set<Crossing>>()
  /** Followed runs' cut turns an answer is continuing now (`answerCut`). */
  private readonly cutsAnswering = new Set<string>()
  /** The decision a blocked Fin's Apex was told of, by Fin: told once per question. */
  private readonly asked = new Map<string, string>()
  /** By Fin, the ask its Apex didn't answer in time, now the person's too, and why in the person's words. */
  private readonly escalated = new Map<string, { line: string; why: string }>()
  /** By Fin, what cancels the timer that asks the person once its Apex has left its ask unanswered for `APEX_ANSWER_MS`. */
  private readonly unanswered = new Map<string, () => void>()
  /**
   * By Fin, the done report whose decision its Apex has `APEX_ANSWER_MS` to make once it has heard it, whether it has
   * (`heard`), and what cancels its timer.
   */
  private readonly undecided = new Map<string, { report: string; heard: boolean; cancel: () => void }>()
  /** By operation, an answer to a report's question on its way to its Fin: a repeat of it waits for it, and gets its result. */
  private readonly inflight = new Map<string, Promise<AgentsAnswered | AgentRefused>>()
  /** By Fin, the newest answer to a question in its report, as the store keeps it (`ChildJournal.answered`). */
  private answersHeld = new Map<string, KeptAnswer>()
  /** What each `agents_send` key delivered, so a retry answers the same. */
  private readonly sent = new Map<string, AgentsSent>()
  /** The digests being steered into a running turn, by the steer's ID: Mako's own input, known by where it came from, never its words. */
  private readonly digestSteers = new Set<string>()
  /** Each move by its op: a repeat joins it, or answers what it became. */
  private readonly moveOps = new Map<string, Promise<AgentsMoveResult>>()
  /** Messages to another Apex, by its conversation and the request whose turn answers it: its reply goes to the sender once. */
  private readonly apexAsks = new Map<string, ApexAsk>()
  /** When each Apex messaged another, by the ordered pair: at most `APEX_SENDS_PER_HOUR` an hour. */
  private readonly apexSends = new Map<string, number[]>()
  /** What joined a running turn as a step, by its id: no request holds it for `redirect` to find. */
  private readonly steered = new Map<string, Pick<LiveRequest, "text" | "attachments">>()
  /** The person's direct messages by their request, delivering or delivered, so a repeat answers the first. */
  private readonly directed = new Map<string, Promise<AgentsDirected | AgentRefused>>()
  private readonly routes = { forwarded: 0, sent: 0, redirected: 0, direct: 0 }
  /** What each `agents_answer` key did, so a retry answers the same. */
  private readonly answers = new Map<string, AgentsAnswered>()
  private readonly answerCounts = { apex: 0, passed: 0, refused: 0, person: 0 }
  private latest = new Map<string, Report>()
  /**
   * By Fin, what its reports say that a row is built from (`ReportsHeld`): read once, added to as each report is kept
   * (`reportKept`), and read again only when its newest isn't the store's (`reportsOf`). Each prompt and each list read
   * every report of every Fin again: 11 MB parsed a call for an Apex whose Fins held 6,520.
   */
  private readonly reportsHeld = new Map<string, ReportsHeld>()
  /** Reports this host kept and took in as it did (`keepReport`), until `sync` reads them back from the store: each is taken in once. */
  private readonly keptHere = new Set<string>()
  private seen: unknown
  /** The store's `moved` when `sync` last took it in, and where its reports and answers were read to. */
  private syncedAt: number | undefined
  private keptMark: KeptMark = { reports: 0, answers: 0, titles: 0, journals: 0 }
  private draining = false
  private drainAgain = false
  /**
   * Every start under way, one record per Apex and client key from the call's first synchronous step until it
   * settles: a call with the same key joins it. The record alone holds its name, its place while it launches and its
   * stop, and only its own settle gives them back (`StartRecord`).
   */
  private readonly starts = new KeyedAdmission<StartRecord>((record) => record.op)
  /** What each Apex's conversations last heard of its waiting Fins (`queueRefresh`), by its Thread. */
  private readonly queueHeard = new Map<string, string>()
  /** Fins' conversations whose cut turn's time came with no room (`mayWake`). */
  private readonly wakingForRoom = new Set<string>()
  /** Fins holding a place now (`occupies`): one that lets go frees it for what waits, at once. */
  private readonly occupying = new Set<string>()
  private stopped = false
  /** The pass that closes finished Fins while it runs: one at a time, since it reads journals in between its looks. */
  private closing: Promise<string[]> | undefined
  /**
   * Finished Fins whose own conversation kept them open (`conversationHolds`), by when: not read in again for it until
   * that conversation is written (`moved`) or `FINISHED_CLOSE_MS` passed, or each pass would read the same journals.
   */
  private readonly finishedHeld = new Map<string, number>()
  /** On while an open Fin's last report says it finished: only then is there anything for the sweep to come back for. */
  private readonly finishedDemand: JobDemand
  private readonly stopFinishedSweep: () => void
  private readonly stopRoomWatch: () => void
  /** On while the room watch has something to read the room for (`roomNeeded`). */
  private readonly roomDemand: JobDemand
  /** The pull requests Fins' latest reports say they wait on, read until each outcome wakes its Fin. */
  readonly pulls: PullWatch
  private readonly stopPullWatch: () => void
  /** Fins that read as working and do nothing, each tree on one deadline (`QuietWatch`). */
  readonly quiet: QuietWatch
  /** What each quiet Fin's notice read of it: its last step then, and whether that ran. */
  private readonly quietSteps = new Map<string, { since: number; step?: string; running?: true }>()
  /** Conversations that aren't a Fin's, so activity in them costs a set lookup: emptied when the edges change. */
  private readonly notFins = new Set<string>()
  /** Turns' waits (`wait`): armed in the store, met by Fins' results and ends and pull requests' outcomes, fired once. */
  readonly turnWaits: TurnWaits
  /** This Mac's load as a start last read it, which every answer carries while it's busy. */
  private mac: MacLoad | undefined
  /** Where a Fin goes when its harness's account runs out; absent without the host's accounts. */
  private readonly moves: FinMoves | undefined
  /** By Apex, the moves of its Fins its next digest says, once. */
  private readonly movedNotes = new Map<string, string[]>()
  /** By root Thread, the limit its tree hit in the last moments, gathered into its one notice (`noteLimit`). */
  private readonly limits = new Map<string, LimitEpisode>()
  private readonly noticeEnds = new Map<string, NodeJS.Timeout>()
  /** The waits for a limit a move of this host is taking now (`limitMove`). */
  private readonly moving = new Set<string>()
  /** The person's other places, as far as the wire goes; absent on a host that reaches none (`AgentsDeps.away`). */
  private readonly places: AgentPlaces | undefined
  /** Starts for another device whose call got no answer, so their record stays for the next ask (`launchAway`). */
  private readonly lostPlacings = new Set<string>()
  /** Fins placed elsewhere with a message, an answer or a stop of their Apex's on its way to them: what their device says meanwhile may be from before it (`placedStands`). */
  private readonly placedSending = new Map<string, number>()
  /** Those whose device said how they stand while one was on its way: asked again once it has settled (`touchPlaced`). */
  private readonly placedMissed = new Set<string>()
  /** How each Fin here whose Apex is elsewhere stood when its device last said so, and this host's count of sayings (`standingOf`). */
  private readonly standingSaid = new Map<string, boolean>()
  private standingSeq = 0
  /** Stops being sent to other places now, by the start's op: one at a time each (`cancelAway`, `retryStops`). */
  private readonly stopping = new Map<string, Promise<StopOutcome>>()

  constructor(deps: AgentsDeps) {
    this.deps = deps
    this.budget = { ...TREE_BUDGET, ...deps.budget }
    this.generation = Math.max(1, Math.floor(this.now()))
    const accounts = deps.accounts
    this.moves = accounts && new FinMoves({
      on: () => deps.moveOnLimit?.() ?? true,
      accounts,
      ...(deps.connections && { connections: deps.connections }),
      continuation: (harness) => deps.accountContinuation?.(harness),
      harnessOrder: async () => (await deps.harnessOrder?.()) ?? deps.harnesses(),
      harnesses: () => deps.harnesses(),
      fits: (harness, tier) => childMode(deps.modes(harness), tier) !== undefined,
      signedIn: async (harness, cwd) => !cwd || ((await deps.finChoices?.(harness, cwd))?.models.length ?? 0) > 0,
      spent: async (harness) => (await this.limitOf(harness)) !== undefined,
    })
    this.runs = new AgentRuns({
      store: deps.store,
      catalog: deps.catalog,
      jobs: deps.jobs,
      runs: deps.runs,
      conversationOwns: (ref, marker) => this.conversationOwns(ref, marker),
      changed: (edge, progressOnly) => this.childMoved(edge, progressOnly),
      ended: (edge, ended) => this.runEnded(edge, ended),
      stuck: (edge) => this.runStuck(edge),
      ...(deps.processes && { processes: deps.processes }),
      now: deps.now,
    })
    this.wakes = new AgentWakes({
      ready: (conversation) => this.ready(conversation),
      moving: (conversation) => [...this.moving].some((key) => key.startsWith(`${conversation}:`)),
      awaited: (notice) => [...this.holds].some((hold) => notice.id === `notice:${hold.child}:${notice.report.id}`),
      lastSent: (conversation) => ((deps.live.held(conversation) ?? deps.live.snapshot(conversation))?.requests ?? []).reduce<number | undefined>((last, request) =>
        request.digest?.sentAt !== undefined && (last === undefined || request.digest.sentAt > last) ? request.digest.sentAt : last, undefined),
      // Read in when it isn't loaded: after a restart the Apex's queue is the receipt a notice is checked against. A digest
      // sent again says what the one it repeats said, so later news goes on its own.
      // Memory first: a notice for an Apex in memory reads nothing in, and one that isn't is read in before (`noticeOf`).
      unsent: (conversation) => ((deps.live.held(conversation) ?? deps.live.snapshot(conversation))?.requests ?? []).flatMap((request) =>
        request.digest && !request.continues?.brief && (request.status === "queued" || request.status === "held") ? [{ id: request.id, ...carriedDigest(request.digest) }] : []),
      // A digest folded into another turn (`joinedInto`) carries its notices there.
      carried: (conversation, notice) => Boolean((deps.live.held(conversation) ?? deps.live.snapshot(conversation))?.requests.some((request) =>
        (request.status !== "canceled" || request.joinedInto !== undefined) && request.digest?.notices.some((carried) => carried.id === notice))),
      admit: (conversation, request, text, notices, actor, hold, lines) => {
        // The conversation took this request already: a host that died before marking its reports heard sent it.
        if (deps.live.snapshot(conversation)?.requests.some((asked) => asked.id === request)) return
        deps.live.submit(conversation, request, text, [], undefined, undefined, undefined, actor, {
          digest: { notices: [...notices], ...(lines?.length && { lines: [...lines] }) },
          ...hold === "paused" ? { pause: "stop" as const } : hold && { wake: { at: hold.at, after: DIGEST_WAITS } },
        })
        // An idle Apex's digest goes when its burst's window ends: a provider that sleeps wakes through the window, not
        // after it. One paused for a stopped Fin wakes nothing, and the conversation says no to what it wouldn't send.
        if (hold && hold !== "paused") deps.live.expect?.(conversation, request)
      },
      rewrite: (conversation, request, text, notices, lines) => deps.live.rewriteWaiting(conversation, request, text, { notices: [...notices], ...(lines?.length && { lines: [...lines] }) }),
      steer: (conversation, id, text) => this.steer(conversation, id, text),
      steerQueued: (conversation, id, request, text) => this.steerQueuedDigest(conversation, id, request, text),
      ...(deps.focusMs !== undefined && { focusMs: deps.focusMs }),
      assign: (reports, request) => {
        this.store()?.assignWake(reports.filter(stored), request)
        for (const id of reports) if (id.startsWith(HELD_PREFIX)) this.heldIn(id.slice(HELD_PREFIX.length), request)
      },
      delivered: (reports, at) => {
        this.store()?.markReportsDelivered(reports.filter(stored), at)
        for (const id of reports) if (id.startsWith(HELD_PREFIX)) this.dropHeld(id.slice(HELD_PREFIX.length))
        // A steer its Apex's harness took carried one of them: that decision is heard, and its minute starts.
        this.decisionsHeard([...this.undecided].flatMap(([child, held]) => (reports.includes(held.report) ? [child] : [])))
      },
      counts: (conversation) => this.counts(conversation),
      takeLines: (conversation) => this.takeMoved(conversation),
      giveLines: (conversation, lines) => this.giveMoved(conversation, lines),
      current: (notice) => this.current(notice),
      now: deps.now,
    })
    // Reads the machine for its capacity; a place that gains room says so (`capacityChanged`), and what waits goes then.
    this.quiet = new QuietWatch({
      now: () => this.now(),
      // Its own timer, not `later`: those are the engine's waits on answers, which tests count and step through.
      later: (ms, run) => {
        const timer = setTimeout(run, ms)
        timer.unref()
        return () => clearTimeout(timer)
      },
      working: (child) => this.quietWorking(child),
      tree: (child) => this.rootOf(child),
      quiet: (child, since) => this.tellQuiet(child, since),
      heard: (child) => this.quietChanged(child),
      ...(deps.quietMs !== undefined && { quietMs: deps.quietMs }),
    })
    // Only while there's something to read the room for: a Fin here holding a place, or a start waiting for one
    // (`roomNeeded`). With neither, the job holds no timer, and an idle host reads no load and no process table.
    this.roomDemand = deps.jobs.demand("Fins at work or starts waiting here")
    this.stopRoomWatch = deps.jobs.every(ROOM_WATCH_JOB, ROOM_EVERY_MS, () => this.observe(true), { needs: [this.roomDemand] })
    // Only while an open Fin has finished: with none, the job holds no timer (`closeFinished` turns it off again).
    this.finishedDemand = deps.jobs.demand("open Fins that finished")
    this.stopFinishedSweep = deps.jobs.every(FINISHED_SWEEP_JOB, FINISHED_SWEEP_MS, async () => { await this.closeFinished() }, { needs: [this.finishedDemand] })
    const read = deps.readPull
    const watching = deps.jobs.demand("pull requests Fins wait on")
    this.pulls = new PullWatch({
      waits: () => (read ? this.pullWaits() : []),
      read: (target) => read!(target),
      fire: (wait, outcome, note) => this.pullOutcome(wait, outcome, note),
      watching: (on) => watching.set(on),
      now: () => this.now(),
    })
    this.stopPullWatch = deps.jobs.every("read the pull requests Fins wait on", PULL_WATCH_EVERY_MS, () => this.pulls.tick(), { needs: [watching] })
    this.turnWaits = new TurnWaits({
      store: () => this.store(),
      now: () => this.now(),
      deliver: (wait) => this.deliverWait(wait),
      timer: (at, fire) => {
        const timer = setTimeout(fire, Math.max(0, at - this.now()))
        timer.unref()
        return () => clearTimeout(timer)
      },
      changed: (conversation) => {
        this.pulls.refresh()
        this.deps.live.waitChanged?.(conversation)
      },
    })
    this.places = deps.away && new AgentPlaces({
      link: deps.away,
      jobs: deps.jobs,
      waiting: () => this.outbox(),
      taken: (report, at) => this.store()?.markReportsDelivered([report.id], at),
      standing: (edge, report) => this.standingOf(edge, report),
      ...(deps.now && { now: deps.now }),
    })
  }

  /** A digest never says a Fin ended, or was cut short, while its Session shows it at work: the end the host inferred for its run is past. */
  private current(notice: Pick<Notice, "report" | "quiet">): boolean {
    const { report } = notice
    // A quiet Fin that did something since, or stopped working, isn't quiet: its notice leaves any digest still unsent.
    if (notice.quiet) return this.quiet.stillQuiet(report.child, notice.quiet.since)
    if (this.store()?.edges().internalRuns.some((edge) => edge.child === report.child)) return false
    if (report.retainsQuestion && !this.store()?.openReportAsks(report.child).some((open) => open.id === report.id)) return false
    // Nor a question a message answered before this digest went.
    if (this.answersHeld.get(report.child)?.ask === reportAsk(report).id) return false
    // What a Fin placed elsewhere reported is its device's word: nothing here reads its conversation to say otherwise.
    if (this.store()?.edges().of(report.child)?.placed) return true
    // Nor that a turn was cut that something picked up since, or a run its session shows at work again.
    const cut = cutOf(report.child, report.id)
    if (cut) {
      const edge = this.store()?.edges().of(report.child)
      if (!edge || edge.closedAt !== undefined) return false
      if (cut.startsWith("run:")) {
        const reading = this.childReading(edge)
        return !(reading.source === "followed" && reading.working)
      }
      const conversation = this.conversationOf(report.child)
      const snapshot = conversation ? this.deps.live.snapshot(conversation) : undefined
      return snapshot ? strandedTurn(snapshot.requests)?.id === cut : false
    }
    // Nor that it waits on an ask it no longer does: answered by the person, say, while its Apex's turn ran on.
    if (report.implicit && report.status === "blocked") {
      const conversation = this.conversationOf(report.child)
      const waiting = conversation ? this.deps.live.waitingOn(conversation) : undefined
      return waiting !== undefined && report.id.endsWith(namedUuid(waiting.line))
    }
    // Nor that its held work ended without waking it, once the work did wake it after all (a notification later than the
    // driver's grace): it's at work on it, or said where it stands since. Its Apex hears one outcome, not two.
    if (report.implicit && report.id.endsWith(":work-ended") && report.unfinished) {
      const conversation = this.conversationOf(report.child)
      if (conversation && this.deps.live.atWork(conversation)) return false
      return this.store()?.reportsOf(report.child).at(-1)?.id === report.id
    }
    if (!report.implicit || (report.status !== "done" && report.status !== "failed")) return true
    const edge = this.store()?.edges().of(report.child)
    if (!edge?.run || edge.closedAt !== undefined) return true
    const reading = this.childReading(edge)
    return !(reading.source === "followed" && reading.working)
  }

  /** A Fin no longer waits on what its turn ended on: its entry goes, and the timer that would look at it again. */
  private stopAwaiting(child: string): void {
    this.awaiting.delete(child)
    this.ceilings.get(child)?.()
    this.ceilings.delete(child)
  }

  /** `resume`, every conversation it reads read in first a slice at a time (`LiveConversations.readIn`): what a host starting calls. */
  async resumeInSlices(): Promise<void> {
    const store = this.store()
    if (!store) return
    await this.runs.reconciled()
    if (this.stopped) return
    // A host that stops meanwhile resumes nothing: the next one takes up what this one would have.
    if ((await this.deps.live.readIn(this.resumeReads(store))) && !this.stopped) this.resume()
  }

  /**
   * Every conversation `resume` may read, taken from what it goes through:
   * each open delegation (never one closed, stopped or finished, which resume
   * passes over) and each placed on another account, the report, the
   * answer and the pull request's outcome the last host left undelivered, a
   * limit's notice, a queued start, and the Apexes it left a message of
   * unsettled. Each names Threads, and every conversation of each goes, with
   * its Apex's and its tree's root's: whatever `resume` reads on the way (a
   * digest's receipt in the Apex's queue, say) is of a Thread it already
   * counts in. `test:resume-holds` fails on one it reads whole.
   */
  private resumeReads(store: ThreadStore): string[] {
    const edges = store.edges()
    const threads = new Set<string>()
    const reads = new Set<string>()
    const tree = (thread: string) => {
      threads.add(thread)
      const parent = edges.of(thread)?.parent
      if (parent) threads.add(parent)
      threads.add(this.rootOf(thread))
    }
    for (const edge of edges.all) if (edge.closedAt === undefined || edge.tuned?.rerouted) tree(edge.child)
    for (const { report } of store.undeliveredReports()) tree(report.child)
    for (const kept of store.undeliveredAnswers()) tree(kept.child)
    for (const kept of store.undeliveredPullWakes()) tree(kept.child)
    for (const { root } of store.limitNotices()) tree(root)
    for (const spawn of store.queuedSpawns()) {
      tree(spawn.tree)
      const lead = parseQueued(spawn.record)?.lead
      if (lead) tree(lead.thread)
    }
    for (const thread of threads) for (const conversation of this.conversationsOfThread(thread)) reads.add(conversation)
    // An Apex is read for its own sake only when the last host left its queue unsettled: its Fins all closed, or the
    // harness's own reviewer runs it once held (`internalRuns`), are no reason to read it.
    for (const apex of new Set([...edges.all, ...edges.internalRuns].map((edge) => edge.parent)))
      for (const conversation of this.conversationsOfThread(apex)) if (this.deps.live.leftUnsettled(conversation)) reads.add(conversation)
    return [...reads]
  }

  /** What the last host left: reports no Apex heard, sent again under their ids, Fins' messages its exit paused, and spawns the budget held. */
  resume(): void {
    const store = this.store()
    if (!store) return
    this.sync()
    const edges = store.edges()
    // The room watch's demand starts off: a host that comes back to Fins at work, or to starts queued for a full place
    // (here or away), reads the room again from now, as the last host did.
    this.roomDemand.set(this.roomNeeded(edges.all.some((edge) => this.occupies(edge))))
    // A crash can leave a reclassified review's old notice in its Apex's queue. Narrow that digest before it resumes;
    // genuine sibling reports stay in it. Already handed-over input cannot be recalled.
    // Only a queue the last host left unsettled can hold one, and those were read in (`resumeReads`): an Apex with
    // nothing waiting isn't read for the runs it once held.
    for (const parent of new Set(edges.internalRuns.map((edge) => edge.parent)))
      for (const conversation of this.conversationsOfThread(parent))
        if (this.deps.live.held(conversation) || this.deps.live.leftUnsettled(conversation)) this.wakes.refresh(conversation)
    // Before anything launches: the account a Fin was placed on before its binding kept it.
    for (const edge of edges.all) {
      const to = edge.tuned?.rerouted?.to
      const conversation = to?.why === "account" ? this.conversationOf(edge.child) : undefined
      if (to?.why === "account" && conversation) this.deps.live.adoptPin(conversation, to.harness, to.account)
    }
    const unheard = store.undeliveredReports()
    this.wakes.leftOver(unheard.map(({ report }) => `notice:${report.child}:${report.id}`))
    for (const { report, wake } of unheard) {
      const edge = edges.of(report.child)
      if (edge && report.status !== "progress") this.noticeOf(edge, report, wake)
    }
    for (const edge of edges.all) {
      if (edge.closedAt !== undefined || (edge.run && !edge.run.ended)) continue
      // When its Apex heard a decision is in the Apex's own queue: read as resume reads any conversation it acts on.
      const asks = this.latest.get(edge.child)
      const apex = this.pendingReports(edge).length || (asks?.status === "done" && asks.question?.trim()) ? this.frontOf(edge.parent, edge.parentSession) : undefined
      if (apex && !this.deps.live.held(apex)) this.deps.live.snapshot(apex)
      this.watchDecision(edge)
      const last = store.reportsOf(edge.child, 0).at(-1)
      const conversation = this.conversationOf(edge.child)
      // A Fin that finished is read in only when the last host left a message of it waiting, paused or running.
      if ((last?.status !== "done" && last?.status !== "failed") || (conversation && this.deps.live.leftUnsettled(conversation))) this.resumePaused(edge)
      // Whatever the last host left of it, a cut turn nothing picks up reaches its Apex.
      if (conversation) this.watchCut(conversation)
      // One at work as this host starts is watched from the last activity its journal kept: a turn hung across a
      // restart is named as one hung before it would be (`QuietWatch`).
      if (conversation && !edge.placed && this.deps.live.atWork(conversation))
        this.quiet.activity(edge.child, this.deps.live.snapshot(conversation)?.activityAt ?? this.now())
    }
    // A notice the last host was gathering goes on and is said, and one standing still ends at its reset.
    for (const { root, notice } of store.limitNotices()) {
      if (notice.gathering) this.gatherNotice(root, notice.id)
      else this.endNotice(root)
    }
    // An answer kept and not delivered when the last host stopped goes once, under the request it was kept with.
    for (const kept of store.undeliveredAnswers()) {
      const edge = edges.of(kept.child)
      // Kept for a stopped Fin, it waits for its resume; one closed as finished takes it, and opens again.
      if (!edge || edgeStopped(edge) || this.inflight.has(kept.op)) continue
      const settled = this.sendAnswer(edge, kept, false)
      this.inflight.set(kept.op, settled)
      this.untilSettled(kept.op, settled)
    }
    // So is a pull request's outcome, claimed once, under the request it was kept with, if its wait still holds.
    for (const kept of store.undeliveredPullWakes()) {
      const edge = edges.of(kept.child)
      if (edge) void this.sendPullWake(edge, kept)
    }
    // A turn's wait the last host fired and didn't deliver goes once; one met or due while it was down fires now.
    this.turnWaits.start()
    this.rewatchChecks()
    this.pulls.refresh()
    for (const apex of new Set(edges.all.map((edge) => edge.parent))) {
      // A stopped Fin's wait for it to resume (`resumeFin`).
      if (edgeStopped(edges.of(apex))) continue
      for (const conversation of this.conversationsOfThread(apex)) {
        if (!this.deps.live.leftUnsettled(conversation)) continue
        this.resumeWakes(conversation)
        // An Apex is a Fin of its own Fins' work: a crash's cut turn of one that isn't a Fin itself goes on as a Fin's does.
        if (!edges.of(apex)) this.continueCrashed(conversation, { apex })
      }
    }
    // The places Fins hold as this host takes over, the turns the last one cut short going on among them: each that lets
    // go of one later wakes what waits (`childMoved`).
    for (const edge of edges.all) if (this.occupies(edge)) this.occupying.add(edge.child)
    // What Fins here left for Apexes on other devices is sent again, and the places holding this device's Fins are told it's back.
    this.places?.resume()
    this.knock()
    // Counted: from here a start may take a place (`KeyedAdmission.recovered`).
    this.starts.recovered()
    void this.drain()
    // Fins that finished long ago, under a host that didn't close them or while none ran, close now.
    this.sweepFinished()
  }

  /**
   * A turn a host that died cut short, continued as Mako's exit's is, under the loop guard. It enters the queue here,
   * before anything is awaited: what moved since the cut and what the transcript shows are read as it's sent
   * (`LiveDispatch`), so a Stop or a newer message meets it in its place like any message.
   */
  private continueCrashed(conversation: string, who: { op?: string; apex?: string }): void {
    const snapshot = this.deps.live.snapshot(conversation)
    const crashed = snapshot && crashedChildTurn(snapshot.requests, this.now())
    if (!crashed) return
    if (snapshot?.control?.transfers.some((transfer) => transfer.continues?.requestId === crashed.id)) return
    const brief = cutBrief(who.op, crashed)
    try {
      this.deps.live.continueTurn(conversation, { requestId: namedUuid(`crashed:${crashed.id}`), reason: "host-crashed", continues: crashed.id, ...(brief ? { brief } : { since: crashed.interruption?.at ?? crashed.createdAt ?? this.now() }), actor: { kind: "service", name: "auto-continue" } })
      hostLog("agents", "resumed", { ...who, request: crashed.id, crashed: true, ...(brief && { brief: "tracked for reconciliation" }) })
    } catch (error) {
      hostWarn("agents", "a turn a crash cut short waits for Continue turn", { ...who, request: crashed.id, error: errorMessage({ error }) })
    }
  }

  /**
   * An exit pauses the messages waiting in each conversation for the person's
   * Resume, and a crash leaves the turn it cut for their Continue turn; a
   * Fin's are its Apex's, and nobody would press either. A quit's cut turn
   * the next host continues already (`LiveRestarts`).
   */
  private resumePaused(edge: ThreadParent): void {
    const conversation = this.conversationOf(edge.child)
    const snapshot = conversation && this.deps.live.snapshot(conversation)
    if (!snapshot) return
    const unmoved = snapshot.control?.transfers.at(-1)
    if (unmoved?.state.kind === "failed" && unmoved.state.error === RESTART_RETIRED_MOVE)
      this.keepReport(edge, { id: `report:${edge.child}:move:${unmoved.input.id}`, child: ThreadIdSchema.parse(edge.child), status: "failed", summary: `${edge.name} didn't move to ${this.deps.harnessLabel(unmoved.input.provider)}: ${RESTART_RETIRED_MOVE}`, implicit: true, ownerGeneration: this.generation, at: this.now() })
    this.continueCrashed(conversation, { op: edge.op })
    this.resumeMade(edge, conversation)
  }

  /** A Fin's messages an exit or a crash paused go on: they're its Apex's. */
  private resumeMade(edge: ThreadParent, conversation: string): void {
    const snapshot = this.deps.live.snapshot(conversation)
    if (!snapshot) return
    const binding = snapshot.control?.bindings.find((candidate) => candidate.id === snapshot.control?.activeBindingId)
    const paused = snapshot.requests.filter((request) => madePaused(request) && (request.actor?.kind === "agent" || request.continues?.auto || isPullNote(request)))
    const waiting = (id: string) => this.deps.live.snapshot(conversation)?.requests.find((request) => request.id === id && madePaused(request))
    const resume = (requests: readonly LiveRequest[]) => {
      for (const { id } of requests) {
        // Read as it stands: what a Stop paused since isn't Mako's to send on.
        const request = waiting(id)
        if (!request) continue
        try {
          this.deps.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "resume" } })
          hostLog("agents", "resumed", { op: edge.op, request: request.id, relaunched: false })
        } catch (error) {
          hostWarn("agents", "a Fin's paused message waits for Resume", { op: edge.op, request: request.id, error: errorMessage({ error }) })
        }
      }
    }
    const first = paused.find((request) => !isPullNote(request))
    if (binding?.nativeId || !first) return resume(paused)
    // Its harness never started: the exit cut its launch. It starts now, the brief its first message, and the rest wait behind it.
    const input = { id: namedUuid(`relaunch:${first.id}`), provider: snapshot.session.harness, text: first.text, attachments: first.attachments, ...(first.tuning && { tuning: first.tuning }), ...(binding?.modeId && { modeId: binding.modeId }) }
    const taken = () => {
      const row = waiting(first.id)
      if (!row) return false
      this.deps.live.editQueued(conversation, { requestId: row.id, expectedText: row.text, change: { kind: "remove" } })
      return true
    }
    void this.deps.continueOn(conversation, { kind: "words", input, ...(first.continues && { continues: first.continues }) }, first.actor, taken).then((relaunched) => {
      if (!relaunched) return
      hostLog("agents", "resumed", { op: edge.op, request: first.id, relaunched: true })
      resume(paused.filter((request) => request !== first))
    }, (error) => hostWarn("agents", "a Fin's paused message waits for Resume", { op: edge.op, request: first.id, error: errorMessage({ error }) }))
  }

  /** An exit or a crash pauses the digests waiting for an Apex with the person's messages; they're Mako's, so they go on. */
  private resumeWakes(conversation: string): void {
    for (const request of this.deps.live.snapshot(conversation)?.requests ?? []) {
      if (!madePaused(request) || ((request.actor?.kind !== "agent" || !request.text.startsWith(FROM_AGENTS)) && !request.continues?.auto)) continue
      try {
        this.deps.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "resume" } })
        hostLog("agents", "resumed", { conversation, request: request.id, wake: true })
      } catch (error) {
        hostWarn("agents", "a digest an exit paused waits for Resume", { conversation, request: request.id, error: errorMessage({ error }) })
      }
    }
  }

  // ── ConversationChildren ──

  /** The conversation's armed wait as the person's waiting line reads it: what it waits on, each item met or not. */
  turnWaitLine(conversation: string): TurnWaitLine | undefined {
    const armed = this.store()?.armedTurnWaitOf(conversation)
    return armed && turnWaitLine(armed)
  }

  /**
   * The person's Stop waiting on the line they saw: that wait ends, waking no one. A wait that already ended, or a newer
   * one armed since, is left as it is, so a repeat stops nothing more. Answers whether it ended now or by them before.
   */
  stopWaiting(conversation: string, wait: string): boolean {
    const armed = this.store()?.armedTurnWaitOf(conversation)
    if (armed?.id !== wait) return this.store()?.turnWaitsOf(conversation).find((held) => held.id === wait)?.cancelled?.by === "person"
    return this.turnWaits.cancel(armed.id, "person")?.cancelled?.by === "person"
  }

  roster(conversation: string): readonly NativeAgent[] {
    const store = this.store()
    if (!store) return NONE
    this.sync()
    const thread = store.journalPlacement(conversation)?.thread
    if (!thread) return NONE
    const held = this.rosters.get(thread)
    if (held && !held.noticed.some(agent => {
      if (!agent.child?.limitNotice) return false
      const edge = this.store()?.edges().of(agent.child.thread)
      return !edge || !sameLimitNotice(agent.child.limitNotice, this.noticeOn(edge))
    })) return held.agents
    const children = store.edges().children(thread)
    const queued = this.queuedOf(thread)
    if (!children.length && !queued.length) return NONE
    const agents = [...children.map((edge) => this.entryOf(edge)), ...queued]
    this.rosters.set(thread, { agents, noticed: agents.filter((agent) => agent.child?.limitNotice) })
    return agents
  }

  /** Uses the same current-state reading as the crew, never just its last done report. */
  finishedThreadAt(thread: ThreadId): number | undefined {
    this.sync()
    const edge = this.store()?.edges().of(thread)
    if (!edge) return undefined
    const reading = this.childReading(edge)
    const journal = this.journalOf(thread)
    const state = childState(edge, reading, journal)
    return state.kind === "ended" ? childSince(edge, reading, journal, state) : undefined
  }

  isApex(conversation: string): boolean {
    if (this.roster(conversation).length) return true
    const thread = this.store()?.journalPlacement(conversation)?.thread
    return thread !== undefined && this.store()?.edges().of(thread)?.role === APEX_ROLE
  }

  /**
   * The person's standing rules a conversation reads, as standing lines of Mako's note (`roleRuleLines`): a Fin the Fin
   * rules, and the Apex rules a top-level Thread, an Apex or a Fin started as one. Its process hears them whole once and
   * then as they change, whoever's message starts its turn (`standingLines`).
   */
  ruleLines(conversation: string): RoleRuleLines {
    const policy = this.deps.finPolicy?.()
    const requests = (this.deps.live.held(conversation) ?? this.deps.live.snapshot(conversation))?.requests ?? []
    const read = new Set(requests.flatMap((request) => request.ruleLines ?? []))
    if (!policy?.forFins && !policy?.forApexes && !read.size) return {}
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    return roleRuleLines(policy, { fin: edge !== undefined, apex: !edge || edge.role === APEX_ROLE || this.isApex(conversation), read })
  }

  /**
   * `whole`: its process hasn't heard a note before (new, compacted, a send failed), so every Fin is described. `forgot`:
   * its harness compacted or rewound since the note last went, so the roster rides this prompt whoever's it is.
   */
  frontDoor(conversation: string, request: Pick<LiveRequest, "actor"> & Partial<Pick<LiveRequest, "id">>, includeGuidance = true, whole = false, forgot = false): string[] {
    const order = request.actor && request.actor.kind !== "person" ? agentMessageOrder(this.deps.live.snapshot(conversation), request.id, (session) => this.store()?.sessionPlacement(session)?.thread ?? session) : []
    const store = this.store()
    const thread = store?.journalPlacement(conversation)?.thread
    if (!store || !thread) return order
    const rules = request.actor && request.actor.kind !== "person" ? order : this.rulesNote(conversation)
    const open = store.edges().children(thread).filter((edge) => !edge.closedAt)
    this.sync()
    const pending = open.flatMap((edge) => this.pendingReports(edge).map((report) => ({ edge, report })))
    const questions = pending.slice(0, 8).map(({ edge, report }) => `fin:${edge.name} · ask ${report.id} · ${decisionOn(edge.asked, report) === "lead" ? "Apex" : "person"}: ${report.question!.replace(/\s+/g, " ").slice(0, 240)}`)
    const note = questions.length ? ["Pending report questions (notice delivery and reading do not resolve them):", ...questions,
      ...(pending.length > 8 ? [`${pending.length - 8} more: agents_list gives pendingQuestions counts; agents_read pages exact ask IDs with afterAsk.`] : []),
      "agents_answer with to and ask resolves only that question; use an explicit answer/park decision. Progress stays quiet."] : []
    const actions = store.reportActionInbox(thread)
    const actionLines = actions.items.map(action => this.actionLine(action))
    const followUps = actionLines.length ? ["Pending action-only reports (delivery/read is not disposition):", ...actionLines,
      `${actions.total} pending; source Apex uses agents_read on the source Fin with afterAction. Custodian uses agents_read {child: its own Thread ID, view: actions, afterAction} for full targets and more pages.`,
      "Source Apex alone records exact agents_settle dispositions. Dispatch/handoff/defer stay pending; receiver outcome alone resolves nothing. Reclaim returns custody to Apex. No automatic reminder/reply."] : []
    const person = !request.actor || request.actor.kind === "person"
    const now = this.now()
    // The roster goes before the person's words, and once before anything else after its harness compacted or rewound
    // its history: a digest after a compaction otherwise reaches an Apex that no longer holds its Fins' picture.
    const roster = person || (forgot && open.length > 0)
    const acting = roster ? store.pendingActionThreads() : undefined
    const door = roster ? frontDoorNote(open.map((edge) => this.frontDoorChild(edge, false, acting)), now, person && includeGuidance, whole ? undefined : this.doorSaid.get(conversation)) : []
    // On the marks' own clock: every change this note read came before it.
    if (roster && open.length) this.doorSaid.set(conversation, this.changes.tick(now))
    const lines = [...rules, ...door, ...note, ...followUps, ...this.owedReminder(conversation)]
    hostLog("agents", "front door", { conversation, children: open.length, chars: lines.reduce((sum, line) => sum + line.length + 1, 0) })
    return lines
  }

  /**
   * The person's rules for Fins, for a conversation that hasn't read them as they stand: once, and again when they
   * change, so every Thread that might start a Fin knows them without paying for them on every message.
   */
  private rulesNote(conversation: string): string[] {
    const lines = this.policyLines()
    const said = lines.join("\n")
    if (this.rulesSaid.get(conversation) === said) return []
    this.rulesSaid.set(conversation, said)
    return lines
  }

  /** The person's rules as an Apex reads them, each target in its catalog's words. */
  private policyLines(): string[] {
    const policy = this.deps.finPolicy?.()
    if (!policy) return []
    return finPolicyNote(policy, (target) => {
      const label = this.deps.harnessLabel(target.harness)
      const catalog = this.deps.catalogOf?.(target.harness)
      const words = catalog && target.settings ? finTuningWords(catalog, target.settings) : undefined
      return words ? `${label} · ${finTuningLine(words)}` : target.settings?.model ? `${label} · ${target.settings.model}` : `${label}, on the model the person uses there`
    })
  }

  /**
   * The person moved a message their Apex passed on to the wrong Fin: it
   * leaves that Fin if it hasn't started there, and goes to `to` as the
   * person's own. The Apex learns of it from its next front-door note, which
   * names the person's direct words to each Fin.
   */
  async redirect(conversation: string, input: AgentsRedirectInput): Promise<AgentsRedirected | AgentRefused> {
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    if (!store || !placed) return { refused: "unavailable", why: "That conversation isn't a Thread here." }
    const apex: Apex = { session: placed.session, thread: placed.thread, conversation }
    const from = this.resolve(apex, input.from, false)
    const to = this.resolve(apex, input.to, false)
    if (!from) return unknownFin(input.from)
    if (!to) return unknownFin(input.to)
    const was = this.conversationOf(from.child)
    const steeredIn = this.steered.get(input.request)
    const queued = was && !steeredIn ? this.deps.live.held(was)?.requests.find((request) => request.id === input.request) : undefined
    // One folded into a turn that went (`joinedInto`) was heard there: its words are what it said, not its carrier's.
    const passed = queued ?? steeredIn
    if (!was || !passed) return { refused: "unknown-child", why: `${from.name} has no such message.` }
    const words = agentWords(passed.text)
    const text = words?.passedOn ? words.body : passed.text
    if (queued && (queued.status === "queued" || queued.status === "held"))
      this.deps.live.editQueued(was, { requestId: queued.id, expectedText: queued.text, change: { kind: "remove" } })
    // One that already went folded into its sender's earlier message (`joinedInto`) was delivered, not withdrawn.
    const withdrawn = queued !== undefined && (queued.status === "queued" || queued.status === "held" || (queued.status === "canceled" && !queued.joinedInto))
    const sent = await this.deliver(to, namedUuid(`redirect:${input.request}:${to.child}`), text, passed.attachments, undefined, "steer")
    if ("refused" in sent) return sent
    if (!sent.deduped) this.routes.redirected += 1
    hostLog("agents", "redirect", { from: from.op, to: to.op, request: input.request, withdrawn, delivery: sent.delivery })
    return { to: to.name, withdrawn, delivery: sent.delivery }
  }

  /**
   * The person wrote to one of this Apex's Fins from the Apex's own
   * conversation: the message goes to the Fin as the person's own, as
   * `agents_send` delivers one, and the Apex's conversation keeps it as an
   * event its harness never sees, so the Apex takes no turn. It learns of it
   * from its next front-door note. A repeat of the request answers the first;
   * a refusal is asked again.
   */
  direct(conversation: string, input: AgentsDirectInput): Promise<AgentsDirected | AgentRefused> {
    const going = this.directed.get(input.request)
    if (going) return going
    const answer = this.directOnce(conversation, input)
    this.directed.set(input.request, answer)
    void answer.then((settled) => {
      if ("refused" in settled) this.directed.delete(input.request)
    })
    return answer
  }

  private async directOnce(conversation: string, input: AgentsDirectInput): Promise<AgentsDirected | AgentRefused> {
    const began = performance.now()
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    if (!store || !placed) return { refused: "unavailable", why: "That conversation isn't a Thread here." }
    const edge = this.resolve({ session: placed.session, thread: placed.thread, conversation }, input.to, false)
    if (!edge) return unknownFin(input.to)
    if (!input.text.trim() && !input.attachments?.length) return { refused: "conflict", why: "A message needs words or an attachment." }
    const received = namedUuid(`direct:${input.request}`)
    const attachments = input.attachments ?? []
    const sent = await this.deliver(edge, received, input.text, attachments, undefined, "steer")
    if ("refused" in sent) return sent
    if (sent.delivery === "steer") this.steered.set(received, { text: input.text, attachments })
    const kept = this.deps.live.recordDirect(conversation, { to: edge.name, fin: edge.child, request: input.request, received, delivery: sent.delivery, at: Date.now() }, input.text)
    if (!sent.deduped) this.routes.direct += 1
    hostLog("agents", "direct", { to: edge.op, request: input.request, delivery: sent.delivery, kept, ms: Math.round(performance.now() - began), ...(sent.deduped && { deduped: true }) })
    return { to: edge.name, fin: edge.child, delivery: sent.delivery }
  }

  /**
   * The person archived a conversation's Thread: a Fin's work ends there, once.
   * One at work is stopped as a stop would, in those words; one stopped
   * already keeps its stop. A message to it is refused until it's restored.
   */
  async archived(conversation: string): Promise<boolean> {
    // Its own wait ends with it, a Fin's or not.
    this.turnWaits.cancelOf(conversation, "archive")
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (!edge) return false
    return this.end(edge, "the person archived it")
  }

  async stopChild(conversation: string, child: string): Promise<boolean> {
    const store = this.store()
    const thread = store?.journalPlacement(conversation)?.thread
    const edge = store?.edges().of(child)
    if (!edge || edge.parent !== thread) return false
    const open = !edgeStopped(edge)
    const ended = await this.end(edge, "the person stopped it")
    // Said where the person stopped it, in its Apex's conversation: the Apex's own stops are its tool rows.
    if (ended && open) {
      const line = membershipLine({ kind: "stopped", fin: store?.thread(edge.child)?.title ?? edge.name })
      this.deps.live.recordNote(conversation, line.label, line.detail, true)
    }
    return ended
  }

  settled(conversation: string, request: string): void {
    // A turn that ended mid-wait left no one to answer: the Fin's result wakes it instead.
    for (const hold of this.holds) if (hold.apex === conversation) hold.end()
    this.apexReplied(conversation, request)
    this.wakes.settled(conversation)
    // It can take input again: a turn wait's note it couldn't take goes now.
    this.turnWaits.retry(conversation)
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (child && !this.deps.live.atWork(conversation)) this.quiet.forget(child)
    // A stopped Fin's cut turn reports nothing; one closed as finished whose turn ran reports, and opens again (`keepReport`).
    if (edge && !edgeStopped(edge)) {
      this.turnEnded(edge, conversation, request)
      this.owedAfterTurn(edge, conversation)
    }
    if (!edge) this.apexLimit(conversation, request)
    this.crewCheckIn(conversation, request)
    void this.drain()
    // Where the engine settles anyway: a Fin whose time came since the last pass closes without waiting for the job.
    if (this.finishedDemand.on) this.sweepFinished()
  }

  /**
   * An Apex whose turn ended with its Fins at work, and no wait of its own armed, waits for the crew: Capy's captain's
   * sweep, made automatic. Each turn's end arms it again, replacing the last; a wait the agent arms replaces it. Their
   * reports still wake it as ever; at its time it hears how each one stands. It backs off: a turn its own note started,
   * with no report since, doubles the next (`crewWaitSeconds`); any report, or a turn anyone else started, resets it.
   */
  private crewCheckIn(conversation: string, request: string): void {
    const store = this.store()
    if (!store || !this.isApex(conversation) || this.deps.live.atWork(conversation) || this.deps.archived?.(conversation)) return
    const armed = store.armedTurnWaitOf(conversation)
    if (armed && armed.armedBy !== "mako") return
    if (!this.crewAtWork(conversation).length) return
    const woke = store.turnWaitOfRequest(request)
    const step = woke?.armedBy === "mako" && !this.crewReportedSince(conversation, woke.createdAt) ? Math.min((woke.crewStep ?? 0) + 1, CREW_STEPS_MAX) : 0
    this.armCrew(conversation, `crew\0${request}`, step)
  }

  private armCrew(conversation: string, clientKey: string, step: number): void {
    const thread = this.store()?.journalPlacement(conversation)?.thread
    if (!thread) return
    this.turnWaits.arm({ conversation, thread, clientKey, description: CREW_WAIT, seconds: crewWaitSeconds(step), armedBy: "mako", crewStep: step })
  }

  /** Whether any of the conversation's Fins reported since `at`: what resets the check-in's backoff. */
  private crewReportedSince(conversation: string, at: number): boolean {
    return this.roster(conversation).some((agent) => {
      const report = agent.child && this.latest.get(agent.child.thread)
      return report !== undefined && report.at >= at
    })
  }

  /** The conversation's Fins at work or about to start, as its crew check-in names them. */
  private crewAtWork(conversation: string): CrewFin[] {
    if (!this.showsFins(conversation)) return []
    const now = this.now()
    return this.roster(conversation).flatMap((agent): CrewFin[] => {
      if (!agent.child) return []
      const state = childStateOf(agent)
      const group = childGroup(state)
      if (group !== "working" && group !== "queued") return []
      const last = this.quiet.lastActivity(agent.child.thread) ?? (group === "working" ? agent.since : undefined)
      return [{ name: agent.child.name ?? agent.title ?? FIN_WORD, line: childLine(state, now) ?? "At work", ...(last !== undefined && { quietMs: now - last }) }]
    })
  }

  /** A conversation's snapshot moved: a Fin's entry follows it, and a decision it now waits on goes to its Apex. */
  moved(conversation: string): void {
    const child = this.childOf.get(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (!edge) return this.apexLimit(conversation)
    // Written since the sweep last looked: what kept it open may be gone.
    this.finishedHeld.delete(edge.child)
    // The person writing in a stopped Fin's own Thread resumes it, as a message from its Apex does.
    const closedAt = edge.closedAt
    const since = closedAt === undefined || this.deps.archived?.(conversation) ? []
      : (this.deps.live.held(conversation)?.requests ?? []).filter((request) => (request.createdAt ?? 0) > closedAt)
    const persons = since.find((request) => !request.actor || request.actor.kind === "person")
    if (persons) {
      this.reopen(edge, "the person")
      return this.resumeFin(conversation, persons.id)
    }
    // One closed as finished is open again for whatever reaches its queue, Mako's own notes too: nothing waits in a
    // closed Fin's queue for someone to open it.
    const reached = closedFinished(edge) ? since.find((request) => request.status !== "canceled") : undefined
    if (reached) return void this.reopen(edge, "a message in its queue")
    this.childMoved(edge, true)
    // A Fin whose turn ended on its harness's background work: that work settling, or the process holding it ending,
    // moves its snapshot, and its end is looked at again.
    const awaiting = this.awaiting.get(edge.child)
    if (awaiting?.work) {
      if (this.deps.live.held(conversation)?.session.status === "running") awaiting.woke = true
      this.checkAwaiting(edge)
    }
    // A message its harness refused at its limit waits to go again: a Fin moves on instead. A continuation scheduled
    // for its cut turn that was dropped leaves it cut: looked at again.
    if (edge.closedAt === undefined && !this.limitMove(edge, conversation)) this.watchCut(conversation)
  }

  // ── AgentOperations ──

  start(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    return input.mode === "wait" ? this.startWaiting(caller, input) : this.admitOnce(caller, input)
  }

  /**
   * One admission per Apex and client key: the record is made before anything is awaited, so a second call with the
   * same key, while the first is still deciding or launching, joins its answer rather than starting again.
   */
  private admitOnce(caller: AgentCaller, input: AgentsStartInput, prepared?: { source: CommittedFinSource; root: string }): Promise<AgentsStartResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return Promise.resolve(apex)
    if (prepared) { apex.source = prepared.source; apex.sourceRoot = prepared.root }
    const op = `start:${apex.session}:${input.clientKey}`
    const { record, joined } = this.starts.open(op, () => startRecord(op, apex.thread, input.name ?? input.title))
    if (joined) return record.answer.then((answer) => ("refused" in answer ? answer : { ...answer, deduped: true as const }))
    record.answer = this.admit(apex, input, record).finally(() => this.retire(record))
    return record.answer
  }

  /** A start's record, in place before its first await (`starts`). */
  private record(op: string, thread: string, name?: string): StartRecord {
    return this.starts.open(op, () => startRecord(op, thread, name)).record
  }

  /**
   * Its own settle gives back what it held: its name, its place and its stop. A place given back goes to what waits in
   * the same tick, whichever way the start ended; a record its replacement already took over gives back nothing.
   */
  private retire(record: StartRecord): void {
    if (!this.starts.retire(record)) return
    if (record.launching) void this.drain()
  }

  /** Its Apex stopped it: no edge is written for it from now (`startWanted`), and one written already ends. */
  private cancelRecord(record: StartRecord): void {
    record.cancelled = true
    const edge = this.store()?.edges().byOp(record.op)
    if (edge) void this.end(edge, `its ${APEX_WORD} stopped it`)
  }

  /** Its edge is its entry now, written as its start goes on: the row it was is out of the line, and every Apex behind it hears its place move at once. */
  edgeWritten(): void {
    this.queueRefresh()
  }

  /** How many starts are under way, each holding its name, place and stop until it settles: none once all have. */
  startsUnderWay(): number {
    return this.starts.size
  }

  /** Whether the start `op` is under way: deciding, launching, or taken from its queue row and coming up. */
  startUnderWay(op: string): boolean {
    return this.starts.has(op)
  }

  /** Whether a start under way is still wanted: one its Apex stopped isn't (`mako:live-start` asks before writing its edge). */
  startWanted(op: string): boolean {
    return this.starts.get(op)?.cancelled !== true
  }

  private async startWaiting(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult> {
    const began = this.now()
    const answer = await this.admitOnce(caller, input)
    if ("refused" in answer) return answer
    const window = Math.max(0, Math.min(input.timeoutMs ?? WAIT_LIMIT_MS, WAIT_LIMIT_MS) - (this.now() - began))
    const waited = answer.child ? await this.hold(answer.child, window) : { outcome: "pending" as const }
    hostLog("agents", "start waited", { child: answer.child ?? answer.name, outcome: waited.outcome, ms: this.now() - began, ...(answer.deduped && { deduped: true }) })
    return { ...answer, waited, next: afterStart(input.wake ?? "decisions", waited) }
  }

  private async admit(apex: Apex, input: AgentsStartInput, start: StartRecord): Promise<AgentsStartResult> {
    const store = this.store()!
    const place = input.place === undefined ? HERE : PlaceSchema.safeParse(input.place).data
    if (!place) return this.refuse(input.clientKey, "place-unavailable", "place is here, device:<name> or cloud.")
    if (place !== HERE) return this.admitAway(apex, input, start, place)
    const op = `start:${apex.session}:${input.clientKey}`
    const kept = store.edges().byOp(op)
    if (kept) return this.started(kept, apex, true)
    if (store.queuedSpawns().some((spawn) => spawn.op === op)) return this.queuedAnswer(op, apex, true)
    const policy = this.deps.finPolicy?.()
    const followed = input.rule === undefined ? undefined : policy?.rules[input.rule - 1]
    if (input.rule !== undefined && !followed)
      return this.refuse(op, "unknown-rule", policy?.rules.length
        ? `The person has ${policy.rules.length} rule${policy.rules.length === 1 ? "" : "s"}, so there's no rule ${input.rule}: ${policy.rules.map((rule, index) => `${index + 1}. ${rule.when}`).join(" ")}`
        : "The person has no rules for Fins: leave rule out.")
    const otherwise = !followed && input.harness === undefined && input.model === undefined ? policy?.otherwise : undefined
    const ruled: Ruled | undefined = followed
      ? { target: followed.target, who: `Your rule ${input.rule}`, rule: { n: input.rule!, when: followed.when } }
      : otherwise ? { target: otherwise, who: "Your choice for work no rule fits", rule: { when: "No rule fit" } } : undefined
    const asked = input.harness ?? ruled?.target.harness ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.harness : undefined)
    if (!asked || !this.deps.harnesses().includes(asked))
      return this.refuse(op, "unknown-harness", `No harness named ${asked ?? "(none)"} runs here: ${this.deps.harnesses().join(", ")}.`)
    const own = this.tierOf(apex)
    const allowed = childAccess(own, input.access)
    if (!allowed) return this.refuse(op, "access", `A ${FIN_WORD} runs at most at its ${APEX_WORD}'s access: this Thread is on ${own}, so ${input.access} is refused.`)
    const fit = await this.fitAccess(apex, asked, allowed, own, input, ruled)
    if ("refused" in fit) return this.refuse(op, "access", fit.refused)
    // Without a limit reader there's nothing to wait for between these checks.
    const placed: Awaited<ReturnType<Agents["placeFor"]>> = this.moves?.on() ? await this.placeFor(apex, fit.harness, allowed, input) : this.deps.limited ? await this.roomFor(apex, fit.harness, allowed, input) : { harness: fit.harness }
    if ("refused" in placed) return this.refuse(op, "limited", placed.refused)
    const { harness, rerouted, step } = placed
    // A harness at its limit hands the Fin to one that offers what was asked, so a widened tier stays with its own harness.
    const fitted = harness === fit.harness ? fit : { harness, tier: allowed }
    const mode = childMode(this.deps.modes(harness), fitted.tier)
    if (!mode) return this.refuse(op, "access", `${this.deps.harnessLabel(harness)} runs on ${offered(this.deps.modes(harness))}, each above ${fitted.tier}, the most this ${FIN_WORD} may have. Start it on another harness.`)
    const tier = mode.tier
    // A connection's model is the step itself: its harness's account ran out for the model the Fin would have run on.
    const decided: Tuned | { refused: string } = step?.why === "connection"
      ? { settings: { model: step.model }, source: "connection" }
      : await this.tuningOf(apex, harness, input, ruled)
    if ("refused" in decided) return this.refuse(op, "unknown-model", decided.refused)
    const note = [fitted.note, rerouted?.note, decided.note].filter(Boolean).join(" ")
    const tuned: Tuned = {
      ...decided,
      ...(note && { note }),
      ...(rerouted && { rerouted: rerouted.on }),
      ...(ruled && { rule: ruled.rule }),
    }
    const attached = this.threadRefs(apex, input.context)
    if ("refused" in attached) return this.refuse(op, attached.refused, attached.why)
    const tree = this.rootOf(apex.thread)
    if ((input.after?.length ?? 0) > AFTER_LIMIT)
      return this.refuse(op, "conflict", `A start waits on at most ${AFTER_LIMIT} ${FIN_WORD}s; it names ${input.after!.length}. Name the last of a chain instead of each one.`)
    // What it starts after is read as the call made it; one of those that ends meanwhile is the queue's to tell (`tellHeld`).
    const after = this.afterOf(apex, input.after ?? [])
    if ("refused" in after) return this.refuse(op, after.refused, after.why)
    await Promise.all([this.readMac(), this.observe(), this.reconcilePlaced(this.placedUnder(tree)), this.starts.recovery])
    // From here to its place or its queue row nothing is awaited: every budget is checked and taken in one step, so two
    // starts deciding together never both take the last of one.
    if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    // A queued spawn is one the tree has started (`treeCounts`): once the budget would refuse it, it never waits.
    const counts = this.treeCounts(tree)
    const rate = this.rateRefusal(counts)
    if (rate) {
      const queued = store.queuedSpawns().filter((spawn) => spawn.tree === tree && !store.edges().byOp(spawn.op)).length
      return this.refuse(op, "budget", `${rate}${queued ? ` ${queued} of those still wait to start.` : ""}`)
    }
    // It waits only as its Apex asked: for the Fins it starts after, or with `queue` for a place, behind every spawn that waits for one already.
    const where = placeOf(input.place)
    const working = this.working(where)
    const full = this.full(where)
    const waiting = this.waitingForRoom(where)
    const why = after.length ? undefined : counts.running >= this.budget.running ? "tree-running" : full || waiting > 0 ? "place-full" : undefined
    if (why && !input.queue)
      return this.refuse(op, "budget", why === "tree-running"
        ? `This tree runs ${counts.running} ${FIN_WORD}s at once, its running limit of ${this.budget.running}; it frees when one ends. Pass queue: true to start it then.`
        : `${upper(full ?? `${working} ${FIN_WORD}s are at work here`)}${waiting ? ` and ${waiting} wait for one to end` : ""}.${this.elsewhere(where)} Pass queue: true to start it when one ends, or after: to start it after one of yours.`)
    if (why || after.length) {
      const record: QueuedStart = { lead: apex, input, tier, harness, tuned, ...(why && { why }), ...(after.length && { after }) }
      this.changeQueue((held) => held.queueSpawn({ op, tree, record: JSON.stringify(record), at: this.now() }))
      hostLog("agents", "start queued", { op, ...(why && { why }), ...(after.length && { after: after.map((ref) => ref.name).join(" ") }), running: counts.running, budget: this.budget.running, working, place: where })
      const answer = this.queuedAnswer(op, apex, false)
      // Its queue row stands for it now: the drain that takes the row makes it a record of its own.
      this.retire(start)
      void this.drain()
      return answer
    }
    // Its place, and its share of the tree's budgets, are its record's from the step that found them free.
    start.launching = { where, tree }
    return this.launch(op, { lead: apex, input, tier, harness, tuned }, start)
  }

  /**
   * A start for another place (`place: device:<name>`): the name resolved among the account's devices and that device
   * asked what it offers, then admitted against that place's room and this tree's budgets as any start is, and
   * placed there (`launchAway`). What the Fin runs on is its device's to decide, from its own catalog and accounts:
   * only what its Apex asked, and the most it may have, go with it.
   */
  private async admitAway(apex: Apex, input: AgentsStartInput, start: StartRecord, place: string): Promise<AgentsStartResult> {
    const store = this.store()!
    const op = `start:${apex.session}:${input.clientKey}`
    const kept = store.edges().byOp(op)
    if (kept) return this.started(kept, apex, true)
    const held = this.queuedAway(op)
    if (held?.away?.stop)
      return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it, and the stop waits for ${placeName(held.away.target)} to answer. Start it again under another clientKey if it should run.`)
    if (store.queuedSpawns().some((spawn) => spawn.op === op)) return this.queuedAnswer(op, apex, true)
    const places = this.places
    if (!places || apex.away)
      return this.refuse(op, "place-unavailable", `This device reaches no other place of the person's now (it isn't signed in to Mako), so a ${FIN_WORD} starts here only. Leave place out.`)
    // The cloud is a place only once its starts are open (`AgentsDeps.cloudFins`); until then it's refused as it always was.
    const cloud = place === "cloud" ? this.deps.cloudFins : undefined
    if (place === "cloud" && !cloud)
      return this.refuse(op, "place-unavailable", `A ${FIN_WORD} can't be placed in the cloud yet: name one of the person's devices with device:<name>, or leave place out to start it here.`)
    if (input.context?.length)
      return this.refuse(op, "conflict", `A Thread can't be attached to a ${FIN_WORD} on another device yet: its transcript is on this one. Put what it needs in the brief, or leave place out.`)
    // A cloud Fin's Thread is fixed by its op, so every repeat of the start reaches the one Thread.
    const resolved: ResolvedPlace = cloud ? { kind: "away", target: { kind: "cloud", thread: await cloudFinThread(op) }, where: "cloud" } : await places.resolve(place)
    if ("refused" in resolved) return this.refuse(op, resolved.refused, resolved.why)
    if (resolved.kind === "here") {
      const here = { ...input }
      delete here.place
      return this.admit(apex, here, start)
    }
    const { target, where } = resolved
    const name = placeName(target)
    const offers = cloud ? { harnesses: await cloud.harnesses() } : await places.capabilities(target, where)
    if ("refused" in offers) return this.refuse(op, offers.refused, offers.why)
    const policy = this.deps.finPolicy?.()
    const followed = input.rule === undefined ? undefined : policy?.rules[input.rule - 1]
    if (input.rule !== undefined && !followed)
      return this.refuse(op, "unknown-rule", policy?.rules.length ? `The person has ${policy.rules.length} rule${policy.rules.length === 1 ? "" : "s"}, so there's no rule ${input.rule}.` : "The person has no rules for Fins: leave rule out.")
    const otherwise = !followed && input.harness === undefined && input.model === undefined ? policy?.otherwise : undefined
    const ruled = followed?.target ?? otherwise
    const harness = input.harness ?? ruled?.harness ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.harness : undefined)
    if (!harness || !offers.harnesses.includes(harness))
      return this.refuse(op, "unknown-harness", `${name} runs no harness named ${harness ?? "(none)"}: it has ${offers.harnesses.join(", ") || "none"}.`)
    const own = this.tierOf(apex)
    const tier = childAccess(own, input.access)
    if (!tier) return this.refuse(op, "access", `A ${FIN_WORD} runs at most at its ${APEX_WORD}'s access: this Thread is on ${own}, so ${input.access} is refused.`)
    const cwd = input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined)
    const remote = cwd ? await this.deps.remoteOf?.(cwd).catch(() => undefined) : undefined
    if (!remote)
      return this.refuse(op, "place-unavailable", `A ${FIN_WORD} on ${name} works in its own checkout of this project's Git remote, and ${cwd ? `${cwd} has none (no origin)` : "this Thread has no folder"}. Push the project to a remote, or leave place out to start it here.`)
    const tree = this.rootOf(apex.thread)
    if ((input.after?.length ?? 0) > AFTER_LIMIT)
      return this.refuse(op, "conflict", `A start waits on at most ${AFTER_LIMIT} ${FIN_WORD}s; it names ${input.after!.length}. Name the last of a chain instead of each one.`)
    const after = this.afterOf(apex, input.after ?? [])
    if ("refused" in after) return this.refuse(op, after.refused, after.why)
    // What this tree's Fins on other devices are doing is asked of them first, so work this device didn't send them counts.
    await Promise.all([this.reconcilePlaced(this.placedUnder(tree)), this.starts.recovery])
    // From here to its place or its queue row nothing is awaited, as for a start here.
    if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    const counts = this.treeCounts(tree)
    const rate = this.rateRefusal(counts)
    if (rate) return this.refuse(op, "budget", rate)
    const full = this.full(where)
    const waiting = this.waitingForRoom(where)
    const why = after.length ? undefined : counts.running >= this.budget.running ? "tree-running" : full || waiting > 0 ? "place-full" : undefined
    if (why && !input.queue)
      return this.refuse(op, "budget", why === "tree-running"
        ? `This tree runs ${counts.running} ${FIN_WORD}s at once, its running limit of ${this.budget.running}; it frees when one ends. Pass queue: true to start it then.`
        : `${upper(full ?? `${name} has ${FIN_WORD}s waiting for room`)}${waiting ? ` and ${waiting} wait for one to end` : ""}.${this.elsewhere(where)} Pass queue: true to start it when ${name} has room, or leave place out to start it here.`)
    // Its place by the device's own name, so every start there is counted under one key.
    const asked: AgentsStartInput = { ...input, place: where, harness, ...(input.model === undefined && ruled?.settings?.model && harness === ruled.harness && { model: ruled.settings.model }) }
    // A cloud start launches its folder's committed, pushed source, under one launch digest its every repeat sends.
    let cloudAway: CloudAway | undefined
    if (cloud && target.kind === "cloud") {
      // Its source is its folder's: an Apex with none has nothing to start from, and is told so rather than of an "undefined".
      if (!cwd) return this.refuse(op, "place-unavailable", `A ${FIN_WORD} in the cloud starts from its project's committed, pushed source, and this Thread has no folder to take it from. Pass cwd, or leave place out to start it here.`)
      const folder = cwd
      const made = await this.cloudAway(op, apex, asked, tier, harness, target.thread, folder).catch((error) => ({ refused: errorMessage({ error }) }))
      if ("refused" in made) return this.refuse(op, "place-unavailable", `A ${FIN_WORD} in the cloud starts from this project's committed, pushed source, and ${folder} isn't one: ${made.refused}. Commit and push it, or leave place out to start it here.`)
      cloudAway = made
    }
    const record: QueuedStart = { lead: apex, input: asked, tier, harness, away: { target, remote, ...(cloudAway && { cloud: cloudAway }) }, ...(why && { why }), ...(after.length && { after }) }
    // Recorded before anything goes to the other device: a host that dies with the call on its way finds the start
    // here and asks again under the same op, so a Fin started there is never left without its Apex's record of it.
    this.changeQueue((held) => held.queueSpawn({ op, tree, record: JSON.stringify(record), at: this.now(), away: true }))
    if (why || after.length) {
      hostLog("agents", "start queued", { op, ...(why && { why }), running: counts.running, budget: this.budget.running, place: where })
      const answer = this.queuedAnswer(op, apex, false)
      this.retire(start)
      void this.drain()
      return answer
    }
    start.launching = { where, tree }
    const answer = await this.launch(op, record, start)
    // Its Apex stopped it meanwhile: its record is the stop's now, settled once that device answers (`cancelAway`).
    if (start.cancelled || this.queuedAway(op)?.away?.stop) {
      this.lostPlacings.delete(op)
      return "refused" in answer ? answer : this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    }
    // No answer came, so whether it started there isn't known: its record stays, and it's asked again once that device answers.
    if ("refused" in answer && this.lostPlacings.delete(op))
      return { ...this.queuedAnswer(op, apex, false), why: `${name} didn't answer, so whether it started there isn't known. It's asked again under the same key once ${name} answers, and never started twice; agents_list shows it.` }
    this.changeQueue((held) => held.unqueueSpawn(op))
    return answer
  }

  /**
   * Places a Fin on another device: one call there, settled by its op, carrying what its Apex asked, the most it may
   * have, the remote its checkout is of, and this Apex as its parent. That device starts it as it starts its own and
   * writes its edge; this one keeps where it put it (`ThreadParent.placed`), so its notices are taken and this Apex's
   * operations on it are routed there. A call whose answer was lost isn't sent again here: the same clientKey asks
   * again, and the device answers the Fin it started.
   */
  private async launchAway(op: string, queued: QueuedStart, start: StartRecord): Promise<AgentsStartResult> {
    const store = this.store()!
    const { lead: apex, input, tier, harness } = queued
    const { target, remote } = queued.away!
    const began = performance.now()
    const self = await this.places?.self()
    if (!this.places || !self) return this.refuse(op, "place-unavailable", `This device isn't signed in to Mako now, so it can't reach ${placeName(target)}.`)
    const others = [...this.starts.values()].flatMap((other) => (other !== start && other.thread === apex.thread && other.name ? [other.name] : []))
    const name = uniqueName(input.name ?? input.title ?? input.brief.objective, new Set([...store.edges().children(apex.thread).map((edge) => edge.name), ...others]))
    start.name = name
    if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    // A cloud start is reserved, then made into its cloud Thread on its own machine, before it's placed there.
    const cloudAway = queued.away!.cloud
    let folder: string | undefined
    if (cloudAway) {
      // Sent from its first call to the account: from here a reservation may exist, so a stop must ask the account.
      this.keepAway(op, (away) => ({ ...away, sent: away.sent ?? this.now() }))
      const made = await this.makeCloud(op, cloudAway, harness)
      if (!("folder" in made)) return made
      folder = made.folder
      if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    }
    // Written before the call leaves: from here whether a Fin runs there is that device's to say, so a stop asks it.
    this.keepAway(op, (away) => ({ ...away, sent: away.sent ?? this.now() }))
    this.forget(apex.thread)
    const placed = await this.places.place(target, {
      version: ORCHESTRATION_VERSION,
      op,
      clientKey: input.clientKey,
      parent: { device: self, thread: apex.thread, session: apex.session, ...(apex.conversation && { conversation: apex.conversation }), access: this.tierOf(apex) },
      brief: input.brief,
      name,
      ...(input.title && { title: input.title }),
      ...(input.role && { role: input.role }),
      harness,
      ...(input.model && { model: input.model }),
      ...(input.reasoning && { reasoning: input.reasoning }),
      ...(input.fast !== undefined && { fast: input.fast }),
      access: tier,
      // A cloud Fin works in its machine's clone, at its committed source, verified there before its brief.
      workspace: cloudAway && folder ? { folder, source: cloudAway.source } : { remote, ...(input.workspace?.branch && { branch: input.workspace.branch }), ...(input.workspace?.base && { base: input.workspace.base }) },
      ...(input.mode && { mode: input.mode }),
      ...(input.wake && { wake: input.wake }),
    })
    if ("lost" in placed) {
      // Asked again only once that device answers what it offers: until then nothing is known of it.
      this.places.forget(input.place ?? "")
      this.lostPlacings.add(op)
      return this.refuse(op, "unavailable", `${placeName(target)} didn't answer the start: ${placed.lost}`)
    }
    if ("refused" in placed) {
      // Full by its own count, whatever it last said: nothing more goes there until it says it has room.
      if (placed.refused === "budget") this.places.filled(input.place ?? "")
      return this.refuse(op, placed.refused, placed.why)
    }
    // Stopped while its start was on its way: no edge is written for it here, and the stop kept with its record ends
    // the Fin there (`cancelAway`).
    if (start.cancelled || this.queuedAway(op)?.away?.stop) {
      void this.cancelAway(op)
      return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    }
    const edge = this.keepPlacedEdge(op, queued, placed)
    this.places.took(input.place ?? "")
    hostLog("agents", "start placed", { op, child: edge.child, place: input.place ?? "", harness: placed.harness, access: placed.access, ms: Math.round(performance.now() - began), ...(placed.deduped && { deduped: true }) })
    this.childMoved(edge, false)
    return this.started(store.edges().of(edge.child) ?? edge, apex, false)
  }

  /**
   * A cloud start's account steps, each settled there by the start's op, so a repeat after a lost answer is the same
   * step, never a second reservation, Thread or machine: reserved, then made into its cloud Thread on its own machine,
   * whose folder its committed source is prepared in. A lost answer keeps the start's row, asked again under its op.
   */
  private async makeCloud(op: string, away: CloudAway, harness: string): Promise<AgentsStartResult | { folder: string }> {
    const cloud = this.deps.cloudFins
    if (!cloud) return this.refuse(op, "place-unavailable", `${upper(FIN_WORD)}s don't start in the cloud from this device now. Leave place out to start it here.`)
    const lost = (step: string, why: string) => {
      this.lostPlacings.add(op)
      return this.refuse(op, "unavailable", `The account didn't answer the cloud start's ${step}: ${why}`)
    }
    let reserved: CloudFinAnswer
    try {
      reserved = await cloud.reserve(away.start)
    } catch (error) {
      return lost("reservation", errorMessage({ error }))
    }
    if (!reserved.ok) return this.refuse(op, cloudRefusal(reserved.reason), cloudWords(reserved.reason))
    let made: CloudFinPlaced
    try {
      made = await cloud.start({ ...away.start, repository: away.repository, harness })
    } catch (error) {
      return lost("start", errorMessage({ error }))
    }
    if (!made.ok) return this.refuse(op, cloudRefusal(made.reason), made.detail)
    const folder = made.folder
    this.keepAway(op, (kept) => (kept.cloud ? { ...kept, cloud: { ...kept.cloud, folder } } : kept))
    return { folder }
  }

  /**
   * This device's record of a Fin its Apex placed elsewhere, from that place's answer: at work from its brief until
   * its device says how it went. `closed` when its Apex stopped it before that answer came.
   */
  private keepPlacedEdge(op: string, queued: QueuedStart, placed: AgentsPlaced, closed?: { at: number; why: string }): ThreadParent {
    const { lead: apex, input } = queued
    const session = SessionIdSchema.parse(apex.session)
    return this.store()!.keepEdge({
      child: ThreadIdSchema.parse(placed.child),
      parent: ThreadIdSchema.parse(apex.thread),
      parentSession: session,
      name: placed.name,
      role: input.role ?? "worker",
      origin: "started",
      asked: {
        brief: input.brief,
        harness: placed.harness,
        ...(input.model && { model: input.model }),
        ...(input.reasoning && { reasoning: input.reasoning }),
        ...(input.fast !== undefined && { fast: input.fast }),
        ...(input.rule !== undefined && { rule: input.rule }),
        access: placed.access,
        ...(input.place && { place: input.place }),
        ...(input.workspace && { workspace: input.workspace }),
        ...(input.mode && { mode: input.mode }),
        ...(input.wake && { wake: input.wake }),
      },
      op,
      startedBy: { kind: "agent", session },
      createdAt: this.now(),
      ...(placed.note && { tuned: { source: "asked" as const, note: placed.note.slice(0, 2_000) } }),
      placed: { target: queued.away!.target, ...(placed.session && { session: placed.session }), ...(placed.conversation && { conversation: placed.conversation }), working: !closed && placed.state !== "ended", epoch: 1 },
      ...(closed && { closedAt: closed.at, closedReason: stopReason(closed.why) }),
    })
  }

  /**
   * A cloud start's own record: its folder's committed source (`CloudFins.capture`), the repository its machine clones,
   * and the start the account knows it by, its launch digest covering everything it launches.
   */
  private async cloudAway(op: string, apex: Apex, input: AgentsStartInput, tier: AccessTier, harness: string, thread: string, folder: string): Promise<CloudAway> {
    const source = await this.deps.cloudFins!.capture(folder)
    const inputSha256 = await cloudFinInputSha256({
      version: ORCHESTRATION_VERSION,
      op,
      parentThread: apex.thread,
      brief: input.brief,
      ...(input.name && { name: input.name }),
      ...(input.title && { title: input.title }),
      ...(input.role && { role: input.role }),
      harness,
      ...(input.model && { model: input.model }),
      ...(input.reasoning && { reasoning: input.reasoning }),
      ...(input.fast !== undefined && { fast: input.fast }),
      access: tier,
      ...(input.mode && { mode: input.mode }),
      ...(input.wake && { wake: input.wake }),
      source: source.sha256,
    })
    return { start: CloudFinStartSchema.parse({ op, inputSha256, thread }), repository: source.repository, source }
  }

  /** A start queued for another place, by its op, as its row stands now. */
  private queuedAway(op: string): QueuedStart | undefined {
    const spawn = this.store()?.queuedSpawns().find((each) => each.away && each.op === op)
    const queued = spawn && parseQueued(spawn.record)
    return queued?.away ? queued : undefined
  }

  /** Rewrites what a queued start for another place keeps of that place (`QueuedStart.away`), in its row as it stands now. */
  private keepAway(op: string, change: (away: NonNullable<QueuedStart["away"]>) => NonNullable<QueuedStart["away"]>): void {
    const queued = this.queuedAway(op)
    if (!queued?.away) return
    const away = change(queued.away)
    this.changeQueue((held) => held.keepQueuedSpawn(op, JSON.stringify({ ...queued, away } satisfies QueuedStart)))
  }

  /**
   * Stops a start that has no Fin on this device yet: one under way, or its queue row. A start for another place that
   * already left for it may have made a Fin there, whatever became of its answer, so its stop is kept with its row
   * and sent to that place (`cancelAway`). True once the start is known not to run; else why that isn't known yet.
   */
  private async stopUnstarted(op: string, under: StartRecord | undefined, why: string): Promise<true | string> {
    // One under way writes no edge, or ends at once if it wrote one: a stop is never undone by its start.
    if (under) this.cancelRecord(under)
    const away = this.queuedAway(op)?.away
    if (away && (away.sent !== undefined || away.stop)) {
      if (!away.stop) this.keepAway(op, (kept) => ({ ...kept, stop: { at: this.now(), why: why.slice(0, 2_000) } }))
      hostLog("agents", "stop kept", { op, place: placeName(away.target), ...(under && { underWay: true }) })
      const outcome = await this.cancelAway(op)
      return "pending" in outcome ? outcome.pending : true
    }
    // Its Apex's conversations hear it go, and every other Apex's held Fins move up the line.
    this.changeQueue((held) => held.unqueueSpawn(op))
    hostLog("agents", "end", { op, outcome: "stopped", queued: true, ...(under && { underWay: true }) })
    return true
  }

  /**
   * A kept stop, sent to its place: one call at a time for a start. Whoever asks while one is on its way asks again
   * if it ends without that place's answer, since the place may have come back since that call left.
   */
  private sendStop(op: string, send: () => Promise<StopOutcome>): Promise<StopOutcome> {
    const running = this.stopping.get(op)
    if (running) return running.then((outcome) => ("pending" in outcome && !this.stopped ? this.sendStop(op, send) : outcome))
    const run = send().finally(() => this.stopping.delete(op))
    this.stopping.set(op, run)
    return run
  }

  /** The stop of a placed start, sent to its place (`sendCancel`). */
  private cancelAway(op: string): Promise<StopOutcome> {
    return this.sendStop(op, () => this.sendCancel(op))
  }

  /**
   * A placed start its Apex stopped while how it went wasn't known (`mako:agents-cancel`). Its place ends the Fin if
   * the start made one, and keeps the stop if it didn't, so the start never runs there; only that answer retires the
   * start's record here. A place that can't be reached leaves the record and its stop, to be sent again
   * (`retryStops`).
   */
  private async sendCancel(op: string): Promise<StopOutcome> {
    const store = this.store()!
    const queued = this.queuedAway(op)
    const stop = queued?.away?.stop
    // Settled already: its record went with its place's answer.
    if (!queued?.away || !stop) return { stopped: true }
    const { lead: apex, away } = queued
    const name = placeName(away.target)
    const fin = queued.input.name ?? queued.input.title ?? "it"
    const kept = (why: string) => ({ pending: `${name} can't be reached now, so whether ${fin} started there isn't known and it isn't stopped yet. The stop is kept: it goes once ${name} answers, and a start that arrives after it won't run. ${why}` })
    // A cloud start is the account's first: a reservation it closes before any machine was made ran nothing, and its
    // stop is settled; one made into a machine is stopped there too, as a device's is.
    if (away.cloud) {
      const cancelled = await this.deps.cloudFins?.cancel(away.cloud.start).catch((error) => ({ error: errorMessage({ error }) }))
      if (!cancelled || "error" in cancelled) return kept(`The account didn't answer the stop${cancelled && "error" in cancelled ? `: ${cancelled.error}` : ""}.`)
      if (cancelled.ok && cancelled.reservation.phase === "cancelled") {
        this.changeQueue((held) => held.unqueueSpawn(op))
        this.lostPlacings.delete(op)
        hostLog("agents", "end", { op, outcome: "stopped", place: name, started: false })
        this.forget(apex.thread)
        void this.drain()
        return { stopped: true }
      }
    }
    const self = await this.places?.self()
    if (!this.places || !self) return kept("This device isn't signed in to Mako now.")
    const answer = await this.places.cancel(away.target, {
      version: ORCHESTRATION_VERSION,
      op,
      parent: { device: self, thread: apex.thread, session: apex.session, ...(apex.conversation && { conversation: apex.conversation }), access: this.tierOf(apex) },
      reason: stop.why,
    })
    if ("refused" in answer) {
      hostLog("agents", "stop waits", { op, place: name, refused: answer.refused, why: answer.why })
      return kept(answer.why)
    }
    // That place had started it and has stopped it now: this device keeps the Fin as it keeps any it placed, stopped.
    const written = store.edges().byOp(op)
    const edge = written
      ? written.closedAt === undefined ? store.keepEdge({ ...written, closedAt: this.now(), closedReason: stopReason(stop.why) }) : written
      : answer.fin && this.keepPlacedEdge(op, queued, answer.fin, { at: this.now(), why: stop.why })
    if (written?.placed) store.keepPlaced(written.child, { working: false, stop: undefined })
    this.changeQueue((held) => held.unqueueSpawn(op))
    this.lostPlacings.delete(op)
    hostLog("agents", "end", { op, outcome: "stopped", place: name, ...(edge ? { child: edge.child } : { started: false }) })
    this.forget(apex.thread)
    if (edge) this.childMoved(store.edges().of(edge.child) ?? edge, false)
    void this.drain()
    return { stopped: true }
  }

  /** Stops kept for places that couldn't be reached, sent again: a placed start's (`cancelAway`), and a placed Fin's (`stopAway`). */
  private retryStops(): void {
    const store = this.store()
    if (!store || !this.places || this.stopped) return
    for (const spawn of store.queuedSpawns()) if (spawn.away && parseQueued(spawn.record)?.away?.stop) void this.cancelAway(spawn.op)
    for (const edge of store.edges().all) {
      const stop = edge.placed?.stop
      if (!stop) continue
      void this.sendStop(edge.op, async () => {
        const ended = await this.stopAway(this.apexOfEdge(edge), edge, stop.why)
        if ("pending" in ended) return ended
        // Its device answered that it won't: the stop has nothing left to wait for.
        if ("refused" in ended) store.keepPlaced(edge.child, { stop: undefined })
        return { stopped: true }
      })
    }
  }

  /** The Fins of a tree that run elsewhere, as far down as this device holds the tree. */
  private placedUnder(root: string): ThreadParent[] {
    const edges = this.store()?.edges()
    const found: ThreadParent[] = []
    const visit = (parent: string, depth: number) => {
      if (depth > 10_000) return
      for (const edge of edges?.children(parent) ?? []) {
        if (edge.placed) found.push(edge)
        else visit(edge.child, depth + 1)
      }
    }
    visit(root, 0)
    return found
  }

  /**
   * Fins placed elsewhere, asked of their places how they stand: one call for each Apex and place, which also tells
   * that place this device hears again. It runs before a start is admitted, so work this device didn't send a Fin
   * (the person writing to it there) counts against its tree. A place that can't be asked leaves what this device keeps.
   */
  private async reconcilePlaced(edges: readonly ThreadParent[]): Promise<void> {
    const asked = new Map<string, ThreadParent>()
    for (const edge of edges) if (edge.placed) asked.set(`${edge.parentSession}\n${placeOf(edge.asked.place)}`, edge)
    await Promise.all([...asked.values()].map((edge) => this.listAway(this.apexOfEdge(edge), edge, {})))
  }

  /**
   * A place's own word on the Fins one Apex placed there (`mako:agents-list`), kept: each Fin's work as that place
   * says it, unless this device set it to work meanwhile, which that answer may be from before. Undefined when the
   * place can't be asked.
   */
  private async listAway(apex: Apex, edge: ThreadParent, input: AgentsListInput): Promise<AgentStrip[] | undefined> {
    const before = new Map<string, number>()
    for (const each of this.store()!.edges().children(apex.thread)) if (each.placed) before.set(each.child, each.placed.epoch ?? 1)
    const listed = await this.askPlace<Extract<AgentsListResult, { children: AgentStrip[] }>>(apex, edge, "mako:agents-list", input, "list")
    if ("refused" in listed) {
      hostLog("agents", "a place holding Fins of this device's wasn't reached", { place: edge.asked.place ?? "", refused: listed.refused })
      return undefined
    }
    if (!Array.isArray(listed.children)) return undefined
    for (const strip of listed.children) {
      const epoch = before.get(strip.child)
      if (epoch !== undefined) this.placedStands(strip.child, strip.state.kind === "working" || strip.state.kind === "starting", epoch, strip.said)
    }
    return listed.children
  }

  /**
   * A placed Fin's work as its device said it, kept on its edge, so its tree's budget counts it after a restart too.
   * `epoch` is this device's count for the Fin when that word was asked for: one it set to work since, or is sending
   * to now, keeps what this device knows, which is newer.
   */
  private placedStands(child: string, working: boolean, epoch: number, said?: SaidMark): void {
    const store = this.store()!
    const edge = store.edges().of(child)
    if (!edge?.placed || (edge.placed.epoch ?? 1) !== epoch) return
    if (this.placedSending.get(child)) return void this.placedMissed.add(child)
    // Only the newest word of its device, by the mark kept with `working`: an older one, replayed or late, changes nothing.
    if (said && !newerSaid(edge.placed.said, said)) return
    // At work there with its delegation closed here: someone on its device sent it on, so it's open here too.
    const reopened = working && edge.closedAt !== undefined ? store.reopenEdge(child, this.now()) : undefined
    const changed = (edge.placed.working ?? false) !== working || reopened !== undefined
    if (!changed && !said) return
    // The mark and the work are one write, so a restart never finds one without the other.
    const kept = store.keepPlaced(child, { ...(changed && { working }), ...(said && { said }) }) ?? reopened ?? edge
    if (!changed) return
    hostLog("agents", "placed Fin stands", { child, working, place: edge.asked.place ?? "", ...(said && { owner: said.owner, seq: said.seq }) })
    this.forget(edge.parent)
    this.childMoved(kept, false)
    if (!working) void this.drain()
  }

  /**
   * How a placed Fin stood as its device sent a notice. It's taken when that device had heard everything this one sent
   * the Fin. One from before a message reached it says nothing of the turn that message started, so its device is
   * asked instead.
   */
  private standingHeard(child: string, standing: AgentsNoticeInput["standing"]): void {
    const edge = this.store()!.edges().of(child)
    if (!standing || !edge?.placed) return
    const epoch = edge.placed.epoch ?? 1
    if (standing.heard < epoch) {
      if (!this.placedSending.get(child)) void this.reconcilePlaced([edge])
      return
    }
    // Only the newest said, by the mark on the edge (`Placed.said`): a notice replayed, or on its way while the Fin's
    // standing changed, arrives after the word that says so and changes nothing, after a restart too.
    this.placedStands(child, standing.working, epoch, { owner: standing.owner, seq: standing.seq })
  }

  /**
   * One of an Apex's calls that changes what a Fin it placed does: a message, an answer or a stop. It goes with the
   * count this device will keep once it has reached the Fin (`Placed.epoch`), and while it's on its way what the
   * Fin's device says of it is set aside, since that may be from before the call arrived.
   */
  private async touchPlaced<Answer extends object>(apex: Apex, edge: ThreadParent, channel: string, input: PlacedAsk, what: string, forwards?: string): Promise<{ answer: Answer | AwayRefused; epoch: number }> {
    const epoch = (edge.placed?.epoch ?? 1) + 1
    this.placedSending.set(edge.child, (this.placedSending.get(edge.child) ?? 0) + 1)
    try {
      return { answer: await this.askPlace<Answer>(apex, edge, channel, input, what, forwards, epoch), epoch }
    } finally {
      const left = (this.placedSending.get(edge.child) ?? 1) - 1
      if (left > 0) this.placedSending.set(edge.child, left)
      else {
        this.placedSending.delete(edge.child)
        if (this.placedMissed.delete(edge.child)) void this.reconcilePlaced([edge])
      }
    }
  }

  /**
   * The Fins a start names in `after`, the Apex's own or its spawns queued: those not finished yet, each once. One
   * that ended without finishing refuses the start now, so its Apex decides while it can.
   */
  private afterOf(apex: Apex, refs: readonly string[]): AfterRef[] | AgentRefused {
    const found = new Map<string, AfterRef>()
    for (const ref of refs) {
      const edge = this.resolve(apex, ref, false)
      if (edge) {
        const state = this.stateOf(edge)
        if (state.kind === "ended" && state.outcome !== "done")
          return { refused: "conflict", why: `${FIN_WORD} ${edge.name} ${state.outcome === "stopped" ? "was stopped" : "failed"}, so nothing starts after it: leave it out of after, or start it again first.` }
        if (state.kind !== "ended") found.set(edge.child, { name: edge.name, child: edge.child })
        continue
      }
      const name = finName(ref)
      const spawn = this.queuedOfApex(apex).find(({ spawn, queued }) => namedUuid(spawn.op) === ref || (queued.input.name ?? queued.input.title) === name)
      if (!spawn) return unknownFin(ref)
      found.set(spawn.spawn.op, { name: spawn.queued.input.name ?? spawn.queued.input.title ?? name, op: spawn.spawn.op })
    }
    return [...found.values()]
  }

  /** This Apex's spawns that wait, oldest first. */
  private queuedOfApex(apex: Pick<Apex, "thread">): { spawn: ReturnType<ThreadStore["queuedSpawns"]>[number]; queued: QueuedStart }[] {
    return (this.store()?.queuedSpawns() ?? []).flatMap((spawn) => {
      const queued = parseQueued(spawn.record)
      return queued?.lead.thread === apex.thread ? [{ spawn, queued }] : []
    })
  }

  /**
   * How a spawn's `after` stands now: a Fin done is finished; one failed or stopped, or a spawn of them that was
   * dropped or refused before it started, holds it; the rest it waits for, one that ended without a result included.
   */
  private afterStand(queued: QueuedStart): AfterStand {
    const store = this.store()!
    const pending: string[] = []
    for (const ref of queued.after ?? []) {
      const edge = ref.child ? store.edges().of(ref.child) : ref.op ? store.edges().byOp(ref.op) : undefined
      if (!edge) {
        if (ref.op && store.queuedSpawns().some((spawn) => spawn.op === ref.op)) pending.push(ref.name)
        else return { pending, held: { name: ref.name, outcome: "stopped", reason: "it never started" } }
        continue
      }
      const state = this.stateOf(edge)
      // One that ended without a result isn't finished, nor failed: what waits for it waits on, until its Apex sends it
      // on and it finishes, takes its reply as its result, or stops it.
      if (state.kind === "ended" && state.outcome === "failed" && state.unfinished) {
        pending.push(edge.name)
        continue
      }
      if (state.kind === "ended" && state.outcome !== "done") {
        const session = store.thread(edge.child)?.sessions[0]
        return { pending, held: { name: edge.name, outcome: state.outcome, ...(state.reason && { reason: state.reason }), ...(session && { session }) } }
      }
      if (state.kind !== "ended") pending.push(edge.name)
    }
    return { pending }
  }

  /**
   * A spawn a Fin it was to start after didn't finish for: its Apex is told, to decide, and the spawn is dropped once
   * it heard (`AgentWakes`'s `delivered`). Told again by each host until then, under one id.
   */
  private tellHeld(op: string, queued: QueuedStart, held: NonNullable<AfterStand["held"]> | { refused: string }): void {
    const summary = "refused" in held
      ? `It didn't start: ${held.refused.replace(/^It didn't start: /, "")} Start it again with agents_start if it should still run.`
      : `It didn't start: it was to start after ${held.name}, which ${held.outcome === "stopped" ? "was stopped" : "failed"}${held.reason ? ` (${held.reason})` : ""}. Start it again with agents_start, without after or after another ${FIN_WORD}, if it should still run.`
    this.tellUnstarted(op, { lead: queued.lead, name: queued.input.name ?? queued.input.title ?? "queued", harness: queued.harness, wake: queued.wake }, summary, ("session" in held && held.session) || queued.lead.session)
  }

  /**
   * A queued start whose record this Mako can't read whole, such as one an older Mako wrote: it can't start, so its
   * Apex is told as for one refused, and it's dropped once it heard. One that doesn't say whose it is has nobody to
   * tell, and goes with a warning.
   */
  private tellUnreadable(op: string, record: string): void {
    const read = queuedLead(record)
    if (!read) {
      hostWarn("agents", "a queued start's record can't be read, nor whose it is; it's dropped", { op })
      return this.unqueued(op)
    }
    const name = read.input?.name ?? read.input?.title ?? "queued"
    this.tellUnstarted(op, { lead: read.lead, name, harness: read.harness ?? "unknown", wake: read.wake }, `It didn't start: Mako couldn't read what was queued for it, as an older version of Mako may have written it. Start it again with agents_start if it should still run.`, read.lead.session)
  }

  /** Tells an Apex one of its queued starts won't start, under one id each host repeats until it heard (`dropHeld`). */
  private tellUnstarted(op: string, start: { lead: QueuedStart["lead"]; name: string; harness: string; wake: string | undefined }, summary: string, from: string): void {
    const conversation = this.frontOf(start.lead.thread, start.lead.session)
    if (!conversation) return
    const report: Report = {
      id: `${HELD_PREFIX}${op}`,
      child: ThreadIdSchema.parse(namedUuid(op)),
      status: "failed",
      summary,
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    }
    this.wakes.notice(conversation, this.rootOf(start.lead.thread), { id: `notice:${report.id}`, report, ...(start.wake && { wake: start.wake }), label: `"${start.name}" (${this.deps.harnessLabel(start.harness)})`, fin: { name: start.name, harness: start.harness }, from })
  }

  async link(caller: AgentCaller, input: AgentsLinkInput): Promise<AgentsLinkResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    let process: Awaited<ReturnType<AgentRuns["processOf"]>>
    if (input.pid !== undefined) {
      try {
        process = await this.runs.processOf(input.pid)
      } catch (error) {
        return { refused: "unavailable", why: `Process ${input.pid} is running, but Mako couldn't read when it started (${errorMessage({ error })}). Try again.` }
      }
      if (!process) return { refused: "unknown-child", why: `No process ${input.pid} runs on this device; leave pid out for a run that has ended.` }
    }
    const path = this.deps.catalog.nativePath({ harness: input.harness, nativeId: input.session })
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!ref) return { refused: "unknown-child", why: `No ${input.harness} session with that ID is on this device.` }
    if (this.conversationOwns(ref)) return { refused: "conflict", why: `That session is a conversation of its own; it can't be a ${FIN_WORD}.` }
    const before = this.store()!.edges().byRun(input.harness, input.session)
    const adopted = await this.runs.adopt({
      parentSession: apex.session,
      ref,
      origin: "linked",
      ...(process && { process }),
      ...(input.name && { name: input.name }),
      ...(input.role && { role: input.role }),
      startedBy: { kind: "agent", session: SessionIdSchema.parse(apex.session) },
    })
    if ("refused" in adopted) {
      hostLog("agents", "link refused", { refused: adopted.refused, harness: input.harness })
      return adopted
    }
    this.forget(apex.thread)
    return { child: adopted.child, name: adopted.name, origin: adopted.origin, ...(before && { deduped: true as const }) }
  }

  async list(caller: AgentCaller, input: AgentsListInput): Promise<AgentsListResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    if (input.scope === "threads") return this.threadsMatching(apex, input.query)
    if (input.scope === "crew") return this.crewOf(apex)
    if (input.scope === "apexes") return this.apexesOf(apex)
    const store = this.store()!
    const strips: AgentStrip[] = []
    // Fins the fold drops whatever the budget (`unlisted`): counted from what's held, their rows never built.
    const dropped: { child: string; facts: ChangeFacts }[] = []
    const actions = store.pendingActionThreads()
    const began = this.now()
    const visit = (parent: string, under?: string) => {
      for (const edge of store.edges().children(parent)) {
        const facts = input.scope === "all" ? undefined : this.unlisted(edge, began, actions)
        if (facts) dropped.push({ child: edge.child, facts })
        else strips.push(this.strip(edge, under, actions))
        if (input.scope === "tree") visit(edge.child, edge.name)
      }
      for (const { placeholder, queued } of this.heldFor(parent))
        strips.push({
          child: placeholder.child,
          name: placeholder.name,
          ...(under && { under }),
          harness: placeholder.asked.harness ?? this.harnessOf(placeholder),
          origin: placeholder.origin,
          state: { kind: "queued", ...queued },
          startedAt: placeholder.createdAt,
        })
    }
    visit(apex.thread)
    // For an Apex on another device, each strip is this host's newest word on its Fin: an older notice changes nothing after it.
    if (apex.away) {
      const said = this.saidNow()
      for (const strip of strips) if (!strip.under) strip.said = said
    }
    // Capture host-owned waits with their local rows, before the remote portion yields. A later wait cannot stamp
    // an older row: otherwise the next delta would hide the change whose row this response never carried.
    const awaitingByChild = new Map<string, string>()
    for (const strip of strips) {
      const edge = store.edges().of(strip.child)
      const awaiting = strip.state.kind === "working" && edge ? this.childReading(edge).awaiting : undefined
      if (awaiting) awaitingByChild.set(strip.child, awaiting)
    }
    await this.listPlaced(apex, input, strips)
    const counts = this.treeCounts(this.rootOf(apex.thread))
    const tree = this.treeAnswer(counts)
    // Each Fin's change mark, read at one tick of this host's clock: `mark` is this list's, so what changed after it
    // shows next time. A mark this host can't read (another host's, an earlier life's, one ahead) lists them all.
    const now = this.now()
    const tick = this.changes.tick(now)
    for (const strip of strips) {
      const awaiting = awaitingByChild.get(strip.child)
      strip.changedAt = this.changes.at(strip.child, { ...stripChange(strip), ...(awaiting && { awaiting }) }, tick)
    }
    const since = this.changes.since(input.since)
    // What needs its Apex is listed whatever changed: a question, an action, a decision, a block (`needsApex`).
    const changed = since === undefined ? strips : strips.filter((strip) => strip.changedAt! > since || needsApex(strip))
    // A dropped Fin keeps its mark as its row would have: unchanged since the mark, it's counted there, else as folded.
    const folded = dropped.filter(({ child, facts }) => {
      const at = this.changes.at(child, facts, tick)
      return since === undefined || at > since || (facts.owes ?? 0) > 0
    }).length
    const unchanged = strips.length - changed.length + dropped.length - folded
    const marked = { tree, mark: this.changes.mark(tick), ...(since !== undefined && { unchanged }) }
    if (input.scope === "all") return { children: changed, ...marked }
    return { ...foldList(changed, now, undefined, folded), ...marked }
  }

  /**
   * The Apex's Fins placed elsewhere, as their devices say they stand: each place is asked once, its strips take the
   * place of what this device reads from their notices, and its Fins' own Fins join a `tree`. A place that can't be
   * asked leaves this device's reading, which says where the Fin is.
   */
  private async listPlaced(apex: Apex, input: AgentsListInput, strips: AgentStrip[]): Promise<void> {
    const placed = this.store()!.edges().children(apex.thread).filter((edge) => edge.placed)
    const targets = new Map(placed.map((edge) => [placeOf(edge.asked.place), edge]))
    await Promise.all([...targets].map(async ([where, edge]) => {
      const listed = await this.listAway(apex, edge, { ...(input.scope === "tree" && { scope: "tree" as const }) })
      for (const strip of listed ?? []) {
        const at = strips.findIndex((mine) => mine.child === strip.child)
        if (at >= 0) strips[at] = { ...strip, place: where }
        else if (strip.under) strips.push({ ...strip, place: where })
      }
    }))
  }

  async read(caller: AgentCaller, input: AgentsReadInput): Promise<AgentsReadResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    if (input.view === "actions") {
      if (apex.away || input.child !== apex.thread || input.report !== undefined || input.afterAsk !== undefined || input.snapshot !== undefined || input.offset !== undefined || input.limit !== undefined)
        return { refused: "conflict", why: "view actions reads only your own delegated custody with your exact Thread ID and optional afterAction; it grants no source conversation access." }
      try {
        const actions = this.store()!.reportCustody(apex.thread, input.afterAction)
        const own = this.store()!.edges().of(apex.thread)
        return { child: apex.thread, name: own?.name ?? "self", state: own ? this.stateOf(own) : { kind: "idle" }, actions,
          text: actions.items.map(action => this.actionLine(action)).join("\n") }
      } catch { return { refused: "conflict", why: "afterAction must name a report in your exact custody view." } }
    }
    const edge = this.resolve(apex, input.child, true)
    if (edge && input.search !== undefined) return this.searchFin(apex, edge, input)
    if (!edge) {
      const held = this.heldNamed(apex, input.child)
      if (!held) return unknownFin(input.child)
      const state: ChildState = { kind: "queued", ...held.queued }
      return { child: held.placeholder.child, name: held.placeholder.name, state, text: `Queued, not started yet: ${queuedWords(state)}. It has nothing to read until it starts.` }
    }
    const limit = Math.max(200, Math.min(input.maxChars ?? READ_CHARS, 64_000))
    if (edge.placed && (input.report !== undefined || input.afterAsk !== undefined || input.afterAction !== undefined)) return { refused: "unsupported", why: "Exact report reads and question paging for placed Fins need verified receiver capability. Read the specific report on the Fin's owning device." }
    const reports = this.store()!.reportsOf(edge.child)
    const selected = input.report !== undefined ? reports.find((report) => report.id === input.report) : undefined
    if (input.report !== undefined && (!selected || input.view === "transcript")) return { refused: "conflict", why: "report must name this Fin's stored report and uses the report view." }
    const after = input.afterAsk === undefined ? -1 : reports.findIndex((report) => report.id === input.afterAsk)
    if (input.afterAsk !== undefined && after < 0) return { refused: "conflict", why: "afterAsk must name a report of this Fin." }
    const positions = new Map(reports.map((report, index) => [report.id, index]))
    const pending = this.pendingReports(edge).filter((report) => (positions.get(report.id) ?? -1) > after)
    const asks = pending.slice(0, 8).map((report) => ({ id: report.id, question: report.question!.slice(0, 400), on: decisionOn(edge.asked, report), ...(report.action && { action: report.action }) }))
    if (input.afterAction !== undefined) {
      const cursor = this.store()!.reportAction(input.afterAction)
      if (!cursor || cursor.parent !== edge.parent || cursor.child !== edge.child)
        return { refused: "conflict", why: "afterAction must name an action-only report of this Fin." }
    }
    const actions = this.pendingActions(edge.parent, edge.child, input.afterAction)
    const state = this.stateOf(edge)
    let away: string | undefined
    if (edge.placed) {
      // Its device reads it: its transcript is there, and so is how it stands now.
      const read = await this.askPlace<Exclude<AgentsReadResult, AgentRefused>>(apex, edge, "mako:agents-read", { ...input, child: edge.child }, "read")
      if (!("refused" in read)) return read
      if (read.refused !== "place-unavailable" && read.refused !== "unavailable") return read
      away = `${read.why}\nWhat it last reported to this device:`
    }
    // Its outcome: the latest result it reported, without the progress after it or a transcript.
    const outcome = input.view === "outcome" && !selected ? [...reports].reverse().find((report) => report.status !== "progress") : undefined
    const local = input.view === "transcript" && !away ? await this.transcript(edge)
      : input.view === "outcome" && !selected && !outcome ? `No result yet. It is ${state.kind}${state.kind === "working" && state.step ? `: ${state.step}` : ""}.`
      : this.reportText(edge, state, selected ?? outcome)
    const text = away ? `${away}\n${local}` : local
    const truncated = text.length > limit
    return {
      child: edge.child,
      name: edge.name,
      state,
      ...((actions.items.length || input.afterAction !== undefined) && { actions }),
      ...(selected?.followUp && { followUp: this.store()!.reportAction(selected.id) }),
      ...(asks.length && { pending: { asks, ...(pending.length > asks.length && { more: pending.length - asks.length, next: asks.at(-1)!.id }) } }),
      text: truncated ? text.slice(text.length - limit) : text,
      ...(truncated && { truncated: true as const }),
      ...(input.view === "transcript" && { whole: `That's the last ${READ_ENTRIES} entries of its newest session at most. thread_history with thread: "${edge.child}" reads every turn of every harness it ran on (turns, read, search, payload), and action export writes it to a file.` }),
    }
  }

  /**
   * `agents_read`'s `search`: words found in one Fin's whole history, every Session and harness it ran on, through
   * `thread_history`'s search of its Thread as its Apex would ask it, a page of hits at a time. A placed Fin's history is
   * on its own device, where `thread_history` reads it.
   */
  private async searchFin(apex: Apex, edge: ThreadParent, input: AgentsReadInput): Promise<AgentsReadResult> {
    const query = input.search?.trim()
    if (!query) return { refused: "conflict", why: "search needs words to find." }
    if (input.view !== undefined || input.report !== undefined || input.afterAsk !== undefined || input.afterAction !== undefined || input.snapshot !== undefined)
      return { refused: "conflict", why: "search reads only the Fin's history: leave out view, report, afterAsk, afterAction and snapshot; offset pages on." }
    if (edge.placed) return { refused: "unsupported", why: `${edge.name}'s history is on ${placeName(edge.placed.target)}: thread_history there searches it.` }
    const history = this.deps.history?.()
    if (!history || !apex.conversation) return { refused: "unavailable", why: "This host can't search a Fin's history: thread_history isn't open here." }
    let text: string
    try {
      text = await history.answer(apex.conversation, { action: "search", thread: edge.child, query: query.slice(0, 400), ...(input.offset !== undefined && { offset: input.offset }) })
    } catch (error) {
      return { refused: "unavailable", why: errorMessage({ error }) }
    }
    const limit = Math.max(200, Math.min(input.maxChars ?? READ_CHARS, 64_000))
    const truncated = text.length > limit
    return { child: edge.child, name: edge.name, state: this.stateOf(edge), text: truncated ? text.slice(0, limit) : text, ...(truncated && { truncated: true as const }) }
  }

  async report(caller: AgentCaller, input: AgentsReportInput): Promise<AgentsReportResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.store()!.edges().of(apex.thread)
    if (!edge) return { refused: "no-parent", why: `This Thread has no ${APEX_WORD}: agents_report is for a ${FIN_WORD}, a Thread another one started.` }
    if (input.followUp !== undefined && (!ReportActionTargetSchema.safeParse(input.followUp).success || !input.action?.trim() || input.question?.trim() || input.decides === "person" || (input.status !== "done" && input.status !== "failed")))
      return { refused: "conflict", why: "followUp pairs action with an exact target/version on a done/failed action-only result. Questions/person decisions use their retained ask; progress stays quiet." }
    if (input.followUp && (edge.placed || edge.remote))
      return { refused: "unsupported", why: "Action-only follow-up requires a local parent/Fin; remote ownership capability is not negotiated. Use the existing explicit question/answer contract." }
    const own = new Set(this.store()!.reportsOf(edge.child).filter((report) => report.question?.trim()).map((report) => report.id))
    if (input.supersedes && (input.supersedes.length > 8 || input.supersedes.some((id) => !own.has(id)) || (input.supersedes.length > 0 && !input.summary.trim()))) return { refused: "conflict", why: "supersedes needs a reason in summary and at most eight exact question report IDs owned by this Fin." }
    const report: Report = {
      id: `report:${edge.child}:${input.clientKey}`,
      child: ThreadIdSchema.parse(edge.child),
      status: input.status,
      summary: input.summary,
      ...(input.artifacts?.length && { artifacts: input.artifacts }),
      ...(input.question && { question: input.question }),
      ...(input.question?.trim() && (input.status === "done" || input.status === "blocked" || input.status === "needs-input") && { retainsQuestion: true as const }),
      ...(input.supersedes?.length && { supersedes: input.supersedes }),
      ...(input.answers?.length && { answers: input.answers.slice(0, 8).map((id) => id.slice(0, 200)) }),
      ...(input.options?.length && { options: input.options.slice(0, ASK_OPTIONS).map((option) => ({ label: option.label.slice(0, 200), ...(option.detail && { detail: option.detail.slice(0, 600) }) })) }),
      ...(input.recommended !== undefined && input.recommended < (input.options?.length ?? 0) && { recommended: input.recommended }),
      ...(input.action && { action: input.action.slice(0, 400) }),
      ...(input.followUp && { followUp: input.followUp }),
      ...(input.status === "done" && input.question && input.decides && { decides: input.decides }),
      ...(input.status !== "failed" && input.waitingOn?.length && { waitingOn: input.waitingOn.slice(0, WAITING_ON_LIMIT).map(waitingItem) }),
      ownerGeneration: this.generation,
      at: this.now(),
    }
    // Progress that hands work to another Fin of its Apex, said so (`handoff`, or `fin:<name>`), is a handoff: the Apex
    // has to act on it, so it wakes. A Fin merely mentioned ("waiting on loop-holds' PR") is progress.
    const handedTo = input.handoff ? this.siblingOf(edge, input.handoff.to) : undefined
    if (input.handoff && !handedTo) return { refused: "unknown-child", why: `No other ${FIN_WORD} of your ${APEX_WORD} is ${input.handoff.to}: handoff names one by its name or Thread. agents_list with scope crew lists them.` }
    const handed = handedTo ?? (input.status === "progress" ? this.siblingNamed(edge, `${input.summary}\n${input.action ?? ""}`) : undefined)
    if (handed && input.status === "progress") report.handoff = { to: handed.name, child: ThreadIdSchema.parse(handed.child) }
    // Progress that first waits on a review or on the person waits on what its Apex arranges or passes on: it wakes
    // the Apex once. Every wait named since its last result or question counts as said, so narrating one again,
    // rewording it or flipping between two stays quiet.
    if (input.status === "progress" && !report.handoff) {
      const reports = this.store()!.reportsOf(edge.child)
      let from = reports.length
      while (from > 0 && reports[from - 1]!.status === "progress") from -= 1
      const said = reports.slice(from).flatMap((each) => each.waitingOn ?? [])
      if (awaitedAnew(said, report.waitingOn).length) report.awaits = true
    }
    const kept = this.keepReport(edge, report)
    if ("refused" in kept) return kept
    return { id: kept.report.id, ...(kept.report.followUp && { followUp: this.store()!.reportAction(kept.report.id) }), ...(kept.deduped && { deduped: true as const }), delivered: quietProgress(kept.report) ? "none" : "notice", ...(kept.report.waitingOn?.length && { subscriptions: this.waitSubscriptions(edge, kept.report) }), ...(kept.report.supersedes?.length && { superseded: kept.report.supersedes }) }
  }

  /** Silent disposition of ordinary follow-through; native questions/approvals remain in answer(). */
  async settle(caller: AgentCaller, input: AgentsSettleInput): Promise<AgentsSettleResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.resolve(apex, input.to, false)
    if (!edge) return unknownFin(input.to)
    if (apex.away || edge.placed || edge.remote) return { refused: "unsupported", why: "Exact action disposition across devices needs negotiated ownership; resolve on its local owning host." }
    const target = ReportActionTargetSchema.safeParse(input.target)
    const parsed = ReportDispositionSchema.safeParse(input.disposition)
    if (!target.success || !parsed.success || !Number.isSafeInteger(input.version) || input.version < 1 || !input.clientKey?.trim() || input.clientKey.length > 200)
      return { refused: "conflict", why: "Disposition needs an exact report, positive version, target and valid evidence/reason." }
    const store = this.store()!
    const op = `report-action:${apex.thread}:${input.clientKey}`
    let disposition = parsed.data
    if (disposition.kind === "dispatch" || disposition.kind === "handoff") {
      const next = this.resolve(apex, disposition.to, false)
      const there = next && this.conversationOf(next.child)
      const requestId = disposition.request
      const request = there ? sentAs(this.deps.live.snapshot(there)?.requests ?? [], requestId) : undefined
      const sender = request && request.actor?.kind === "agent" ? store.sessionPlacement(request.actor.session) : undefined
      if (!next || next.placed || next.remote || (!store.hasReportActionOperation(op) &&
          (edgeStopped(next) || (there && this.deps.archived?.(there)) || !request || sender?.thread !== apex.thread ||
          (request.status !== "queued" && request.status !== "dispatching" && request.status !== "completed"))))
        return { refused: "conflict", why: "Dispatch/handoff must link an existing admitted request from this Apex to its own local Fin; a receipt is not completion of that work." }
      disposition = { ...disposition, to: next.child }
    }
    try {
      const resolved = store.resolveReportAction({ parent: apex.thread, child: edge.child, report: input.report, version: input.version,
        target: target.data, disposition, op, at: this.now() })
      // Custody handed to a Fin closed as finished is work it owns again: it's open while it holds any.
      const owner = disposition.kind === "dispatch" || disposition.kind === "handoff" ? store.edges().of(disposition.to) : undefined
      if (owner && closedFinished(owner)) this.reopen(owner, "custody of an action")
      return resolved
    } catch (error) {
      return { refused: "conflict", why: `Disposition changed nothing: ${errorMessage({ error })}` }
    }
  }

  /** What was actually registered, from the kept report, its current owner, configured reader and durable claims. */
  private waitSubscriptions(edge: ThreadParent, report: Report): WaitSubscription[] {
    this.pulls.refresh()
    const claimed = this.store()!.pullWakesFor(edge.child).filter((wake) => wake.obsolete === undefined)
    return (report.waitingOn ?? []).map((wait): WaitSubscription => {
      if (wait.kind !== "pull-request") return { wait, state: "unsupported", why: "Recorded only: no automatic wake. Actions runs and main-commit checks are not supported watch targets. Arrange a verified external notification or keep an explicit owner to verify the outcome; a merged PR cannot stand in for main CI." }
      const pull = waitedPull(wait)
      if (!pull) return { wait, state: "unsupported", why: "No valid PR target; use its URL or owner/repo#number. No automatic wake was registered." }
      if (!this.deps.readPull) return { wait, state: "unavailable", why: "This host has no PR reader; no automatic wake was registered. Keep an explicit outcome owner or arrange a verified external notification." }
      if (!this.pullWaitHolds(edge.child, report.id, pull.key)) return { wait, state: "inactive", why: "This is no longer the Fin's current open wait; no new wake was registered." }
      const retained = pullWaitReports(this.store()!.reportsOf(edge.child), pull.key)
      const prefix = `pull-wake:${edge.child}:${retained[0]!.id}:${pull.key}:observation:`
      if (claimed.some(({ wait: key }) => key.startsWith(prefix) || retained.some((entry) => key === `pull-wake:${edge.child}:${entry.id}:${pull.key}`))) return { wait, state: "claimed", why: "An observed outcome has a durable delivery claim; this does not prove the Fin has heard it. Equivalent narration retains the dependency. New observations have separate claims; legacy claims without a cursor require withdrawing and re-registering the wait to re-arm it." }
      return { wait, state: "registered" }
    })
  }

  async send(caller: AgentCaller, input: AgentsSendInput): Promise<AgentsSendResult> {
    const began = performance.now()
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    if (input.to.startsWith(APEX_PREFIX)) return this.sendToApex(apex, input, began)
    const edge = this.resolve(apex, input.to, false)
    if (!edge) return this.unsendableFin(apex, input)
    const op = `send:${apex.session}:${input.clientKey}`
    const request = namedUuid(op)
    const kept = this.sent.get(op)
    if (kept) return { ...kept, deduped: true }
    if (edge.placed) return this.sendAway(apex, edge, input, op, began)
    const own = input.text?.trim()
    let text: string
    let attachments: PromptAttachment[] = []
    let passedOnGrants: string[] | undefined
    if (input.forward) {
      // An Apex on another device sends the person's words with its call: their message is in its conversation there.
      const asked = apex.away ? (apex.away.forwards === undefined ? undefined : { text: apex.away.forwards, attachments: [] }) : this.personsMessage(apex)
      if (!asked) return this.refuse(op, "unavailable", "No message from the person is in this Thread to pass on: send your own words as text instead.")
      text = `${passedOn(YOUR_APEX)}\n${asked.text}${own ? `\n\n${PASSED_ON_NOTE}\n${own}` : ""}`
      attachments = asked.attachments
      passedOnGrants = "id" in asked ? heldReferences([asked]).map((reference) => reference.ref) : []
    } else {
      if (!own) return this.refuse(op, "conflict", "A message needs text, or forward: true to pass on the person's.")
      text = `${fromAgent(YOUR_APEX)}\n${own}`
    }
    const deliver = input.deliver ?? "queue"
    const attached = this.threadRefs(apex, input.context)
    if ("refused" in attached) return this.refuse(op, attached.refused, attached.why)
    this.toldBy(apex, edge, true)
    const sent = await this.deliver(edge, request, text, attachments, { kind: "agent", session: SessionIdSchema.parse(apex.session) }, deliver, false, { ...(passedOnGrants ? { passedOn: passedOnGrants } : { refs: attached }), ...(input.reply === "none" && { notification: true }), ...(input.expects === "answer" && input.reply !== "none" && { expects: "answer" as const }) })
    if ("refused" in sent) return this.refuse(op, sent.refused, sent.why)
    this.heardFrom(apex, edge)
    const answer: AgentsSent = { child: edge.child, name: edge.name, request, delivery: sent.delivery, hears: sent.hears, ...(sent.deduped && { deduped: true as const }) }
    this.sent.set(op, answer)
    if (sent.delivery === "steer") this.steered.set(request, { text, attachments })
    if (input.forward) this.routes.forwarded += 1
    else this.routes.sent += 1
    hostLog("agents", "send", { op, child: edge.child, request, deliver, delivery: sent.delivery, forward: input.forward ?? false, ms: Math.round(performance.now() - began) })
    return answer
  }

  /**
   * A message to a Fin placed elsewhere: its device delivers it as it delivers its own Apexes' (`mako:agents-send`),
   * under the same key, so a repeat is the same message there too. The person's message a `forward` passes on goes
   * with the call, in words; a Thread can't be attached across devices yet.
   */
  private async sendAway(apex: Apex, edge: ThreadParent, input: AgentsSendInput, op: string, began: number): Promise<AgentsSendResult> {
    if (input.context?.length) return this.refuse(op, "conflict", `A Thread can't be attached to a message for a ${FIN_WORD} on another device yet: its transcript is on this one. Say what it needs in the text.`)
    const asked = input.forward ? this.personsMessage(apex) : undefined
    if (input.forward && !asked) return this.refuse(op, "unavailable", "No message from the person is in this Thread to pass on: send your own words as text instead.")
    if (!input.forward && !input.text?.trim()) return this.refuse(op, "conflict", "A message needs text, or forward: true to pass on the person's.")
    const { answer: sent, epoch } = await this.touchPlaced<AgentsSent>(apex, edge, "mako:agents-send", { ...input, to: edge.child }, "deliver a message", asked?.text)
    if ("refused" in sent) {
      // No answer came, so whether it reached its Fin isn't known: it counts as at work until its device says.
      if (sent.lost) {
        const kept = this.store()!.keepPlaced(edge.child, { working: true, epoch })
        this.forget(edge.parent)
        if (kept) this.childMoved(kept, false)
      }
      return this.refuse(op, sent.refused, sent.why)
    }
    this.sent.set(op, sent)
    if (input.forward) this.routes.forwarded += 1
    else this.routes.sent += 1
    // A message opens a stopped delegation there, so it's open here too; and its Fin is at work on it until it reports.
    const open = edge.closedAt === undefined ? edge : this.store()!.reopenEdge(edge.child, this.now()) ?? edge
    const kept = this.store()!.keepPlaced(edge.child, { working: true, epoch, stop: undefined }) ?? open
    this.forget(edge.parent)
    this.childMoved(kept, false)
    hostLog("agents", "send", { op, child: edge.child, request: sent.request, delivery: sent.delivery, forward: input.forward ?? false, place: edge.asked.place ?? "", ms: Math.round(performance.now() - began) })
    return sent
  }

  /**
   * A message to another of the person's Apexes: Mako's words, never the
   * person's, naming the Apex and Thread that sent it, after the other's turn
   * unless the sender steers it into a turn whose work is wrong. The turn that
   * answers it sends its reply back once, as the sender's wake
   * (`apexReplied`), which sends nothing on. At most `APEX_SENDS_PER_HOUR` go
   * from one Apex to another; a repeat of the key answers the first.
   */
  private async sendToApex(sender: Apex, input: AgentsSendInput, began: number): Promise<AgentsSendResult> {
    const op = `send:${sender.session}:${input.clientKey}`
    const kept = this.sent.get(op)
    if (kept) return { ...kept, deduped: true }
    const target = this.otherApexNamed(sender, input.to.slice(APEX_PREFIX.length))
    if ("refused" in target) return target
    const name = `${APEX_PREFIX}${target.title ?? target.thread}`
    const own = input.text?.trim()
    if (input.forward) return this.refuse(op, "conflict", `forward passes the person's message on to a ${FIN_WORD}: to another ${APEX_WORD}, write everything it needs as text.`)
    if (!own) return this.refuse(op, "conflict", "A message needs text.")
    if (input.deliver === "interrupt") return this.refuse(op, "conflict", `Another ${APEX_WORD}'s turn is its own to end: queue (the default), or steer when what it's doing now is wrong.`)
    const now = this.now()
    const pair = `${sender.thread}>${target.thread}`
    const recent = (this.apexSends.get(pair) ?? []).filter((at) => now - at < HOUR_MS)
    if (recent.length >= APEX_SENDS_PER_HOUR) {
      const minutes = Math.max(1, Math.ceil((recent[0]! + HOUR_MS - now) / 60_000))
      return this.refuse(op, "rate-limited", `${name} had ${APEX_SENDS_PER_HOUR} messages from this ${APEX_WORD} in the last hour; the next can go in ${minutes} min. agents_list with scope apexes says how it stands.`)
    }
    const conversation = target.conversation
    const ready = this.ready(conversation)
    if (ready === "gone") return this.refuse(op, "unavailable", `${name}'s conversation isn't on this device.`)
    const request = namedUuid(op)
    const senderTitle = this.store()!.thread(ThreadIdSchema.parse(sender.thread))?.title ?? (sender.conversation && this.deps.live.session(sender.conversation)?.title) ?? `Thread ${sender.thread}`
    const text = `${fromApex(senderTitle)}\n${apexNote(sender.thread)}\n\n${own}`
    const requests = [request]
    let sent: Delivered
    if (this.deps.live.held(conversation)?.requests.some((asked) => asked.id === request)) sent = { delivery: "queued", hears: `${name} already has it.`, deduped: true }
    else {
      this.deps.live.submit(conversation, request, text, [], undefined, undefined, undefined, { kind: "agent", session: SessionIdSchema.parse(sender.session) }, input.reply === "none" ? { notification: true } : {})
      const queued = this.queuedDelivery(conversation, name, ready)
      sent = queued
      if (ready !== "idle" && input.deliver === "steer") {
        const running = this.deps.live.held(conversation)?.requests.find((asked) => asked.status === "dispatching")?.id
        const steered = await this.steerInto(conversation, name, request, text, [])
        if ("why" in steered) sent = { ...queued, hears: `${name} hears it when its current turn ends, as its next message: ${steered.why}` }
        else {
          sent = steered
          if (running) requests.push(running)
        }
      }
      recent.push(now)
      this.apexSends.set(pair, recent)
      const harness = this.deps.live.session(conversation)?.harness
      const ask: ApexAsk = { sender, ...(input.reply === "none" && { notification: true }), conversation, requests, thread: target.thread, label: `"${target.title ?? target.thread}" (${harness ? this.deps.harnessLabel(harness) : APEX_WORD})`, fin: { name: target.title ?? target.thread, ...(harness && { harness }) } }
      for (const id of requests) this.apexAsks.set(`${conversation}:${id}`, ask)
    }
    const answer: AgentsSent = { child: target.thread, name, request, delivery: sent.delivery, hears: sent.hears, ...(sent.deduped && { deduped: true as const }) }
    this.sent.set(op, answer)
    hostLog("agents", "send apex", { op, to: target.thread, request, deliver: input.deliver ?? "queue", delivery: sent.delivery, ms: Math.round(performance.now() - began) })
    return answer
  }

  /**
   * An Apex answers what one of its Fins waits on, within its own access: the
   * person's access mode is the grant, so an Apex on full access answers its
   * Fins' approvals as the person would, and one on any mode answers their
   * questions, which grant nothing. Or it leaves the ask to the person.
   */
  async answer(caller: AgentCaller, input: AgentsAnswerInput): Promise<AgentsAnswerResult> {
    const began = performance.now()
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const edge = this.resolve(apex, input.to, false)
    if (!edge) return unknownFin(input.to)
    const op = `answer:${apex.session}:${input.clientKey}`
    const kept = this.answers.get(op)
    if (kept) return { ...kept, deduped: true }
    if (edge.placed && (input.ask !== undefined || this.pendingReports(edge).length > 1)) return { refused: "unsupported", why: "Exact report-ask selection for a placed Fin needs a verified receiver capability; this host does not negotiate it. Answer that specific ID on the Fin's owning device." }
    // A Fin placed elsewhere is answered by its device, which holds its question and the claim on it.
    const touched = edge.placed ? await this.touchPlaced<AgentsAnswered>(apex, edge, "mako:agents-answer", { ...input, to: edge.child }, "answer") : undefined
    if (!touched && input.person !== true) this.toldBy(apex, edge, true)
    const answered = touched ? touched.answer : await this.answerOnce({ kind: "apex", apex }, edge, op, input)
    // Its answer is what its Fin goes on with. One whose outcome isn't known counts as at work until its device says.
    if (touched && ("refused" in answered ? "lost" in answered && answered.lost === true : answered.answered !== "person")) {
      const kept = this.store()!.keepPlaced(edge.child, { working: true, epoch: touched.epoch, stop: undefined })
      this.forget(edge.parent)
      if (kept) this.childMoved(kept, false)
    }
    if (!touched && !("refused" in answered)) this.heardFrom(apex, edge)
    const ms = Math.round(performance.now() - began)
    if ("refused" in answered) {
      if (answered.refused === "access") this.answerCounts.refused += 1
      hostLog("agents", "answer refused", { op, child: edge.child, refused: answered.refused, ms })
      return { refused: answered.refused, why: answered.why }
    }
    this.answers.set(op, answered)
    if (!answered.deduped) this.answerCounts[answered.answered === "person" ? "passed" : "apex"] += 1
    hostLog("agents", "answer", { op, child: edge.child, answered: answered.answered, ...(answered.delivery && { delivery: answered.delivery }), ms })
    return answered
  }

  /** The notice of a limit its tree hit, on the first Fin it touched, while it stands. */
  private noticeOn(edge: ThreadParent): NonNullable<NativeAgent["child"]>["limitNotice"] {
    const root = this.rootOf(edge.child)
    const notice = this.standingNotice(root)
    if (notice?.fin !== edge.child) return undefined
    const conversation = this.conversationOf(root)
    const held = conversation ? this.noticeWaits(conversation, notice.id) : []
    const first = held.map(({ wait }) => wait.retry!).sort((a, b) => (a.until ?? a.at) - (b.until ?? b.at))[0]
    return { id: notice.id, line: notice.line, harness: notice.harness,
      ...(first && { waiting: { count: held.length, at: first.until ?? first.at, resets: first.until !== undefined,
        version: namedUuid(held.map(({ edge, wait }) => `${edge.parent}:${edge.child}:${edge.op}:${edge.asked.access}:${wait.id}`).sort().join("|")) } }) }
  }

  /** Only current, local, Mako-owned usage waits in this exact tree episode. Closed/Stop/external work never joins. */
  private noticeWaits(conversation: string, id: string) {
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    const root = placed && this.rootOf(placed.thread)
    const notice = root && this.standingNotice(root)
    if (!store || !placed || placed.thread !== root || !notice || notice.id !== id) return []
    return treeEdges(store.edges(), root).flatMap(edge => {
      const heldIn = this.conversationOf(edge.child)
      if (!heldIn || !edge.asked.access || edge.closedAt !== undefined || (edge.run && !edge.run.ended) || this.inTurn(heldIn)) return []
      if (this.deps.live.session(heldIn)?.harness !== notice.harness) return []
      const wait = this.deps.live.held(heldIn)?.requests.find(request => waitsOnLimit(request) && request.retry?.until === notice.until)
      return wait ? [{ edge, conversation: heldIn, wait, mark: this.deps.live.stopMark(heldIn) }] : []
    })
  }

  /** A tree's notice until it's seen or its reset has passed: by then it's no news. */
  private standingNotice(root: string): LimitNotice | undefined {
    const notice = this.store()?.limitNotice(root)
    return notice && (notice.until === undefined || notice.until > this.now()) ? notice : undefined
  }

  /**
   * The person answering one of an Apex's Fins from the Apex's Thread, on any
   * device: theirs to answer whatever the Apex's access, as its own Thread's
   * ask would be, and as their own words.
   */
  async respond(conversation: string, input: AgentsRespondInput): Promise<AgentsAnswerResult> {
    const began = performance.now()
    const placed = this.store()?.journalPlacement(conversation)
    if (!placed) return { refused: "unavailable", why: "That conversation isn't a Thread here." }
    // A limit's notice answers nothing: it goes no further than the person having seen it.
    if (isLimitAsk(input.ask)) {
      const root = this.rootOf(placed.thread)
      if (!this.store()!.seeLimitNotice(root, input.ask)) return { refused: "conflict", why: "That notice has passed." }
      const edge = this.store()!.edges().of(input.fin)
      this.noticeChanged(edge)
      return { answered: "person", child: input.fin, name: edge?.name ?? "Usage" }
    }
    const edge = this.resolve({ session: placed.session, thread: placed.thread, conversation }, input.fin, true)
    if (!edge) return unknownFin(input.fin)
    const op = `respond:${input.request}`
    const kept = this.answers.get(op)
    if (kept) return { ...kept, deduped: true }
    const repeat = this.repeatOf(edge, op)
    if (repeat) return repeat
    if (edge.placed && this.store()!.reportsOf(edge.child).some((report) => report.retainsQuestion && report.id === input.ask)) return { refused: "unsupported", why: "Exact report-ask selection for a placed Fin needs a verified receiver capability. Answer that specific ID on the Fin's owning device." }
    const ask = this.openQuestion(edge, input.ask)?.ask
    const picked = input.option === undefined ? undefined : ask?.options?.[input.option]?.label
    const answered: AgentsAnswerResult = !ask || ask.id !== input.ask
      ? { refused: "conflict", why: `${edge.name} no longer waits on that: it was answered.` }
      : input.option !== undefined && !picked
        ? { refused: "conflict", why: `That isn't one of ${edge.name}'s options.` }
        : await this.answerOnce({ kind: "person" }, edge, op, { ask: input.ask, ...((picked ?? input.answer) && { answer: picked ?? input.answer }), ...(input.allow !== undefined && { allow: input.allow }) })
    const ms = Math.round(performance.now() - began)
    if ("refused" in answered) {
      hostLog("agents", "respond refused", { op, child: edge.child, refused: answered.refused, ms })
      return answered
    }
    this.answers.set(op, answered)
    if (!answered.deduped) this.answerCounts.person += 1
    hostLog("agents", "respond", { op, child: edge.child, answered: answered.answered, ...(answered.delivery && { delivery: answered.delivery }), ms })
    return answered
  }

  /**
   * What the person's row for `conversation` waits on of its Fins: the first
   * ask anywhere under its Thread that is theirs, a done Fin's decision too,
   * and how many more wait behind it. Only the Session they last wrote in
   * says it.
   */
  personAsk(conversation: string): { fin: ThreadId; name: string; line: string; ask: FinAsk; more: number } | undefined {
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    if (!store || !placed || !store.edges().children(placed.thread).length) return undefined
    if (this.frontOf(placed.thread, placed.session) !== conversation) return undefined
    const notice = placed.thread === this.rootOf(placed.thread) ? this.standingNotice(placed.thread) : undefined
    if (notice) return { fin: ThreadIdSchema.parse(notice.fin), name: "Usage", line: notice.line, ask: { kind: "report", id: notice.id, options: SEEN_OPTIONS }, more: 0 }
    // Asked on every batch of the Apex's conversation and every report of its row: the walk of its tree is kept until
    // an edge, a report or an answer changes or a Fin beneath it asks something else. Worked out afresh each time, with
    // 57 Fins it held the loop 0.3-0.6 s a batch; dropped at every Fin's every batch, 17% of the thread with 30 at work.
    const edges = store.edges()
    const reports = store.asksStamp()
    const kept = this.asksKept.get(placed.thread)
    if (kept && kept.edges === edges && kept.reports === reports && this.now() - kept.at < ASKS_KEPT_MS) return kept.found
    const found = this.walkAsks(store, placed.thread)
    this.asksKept.set(placed.thread, { edges, reports, at: this.now(), found })
    return found
  }

  /** What `edge`'s Fin asks now, as `walkAsks` reads it of its state and its conversation: the same words, the same walk. */
  private askKey(edge: ThreadParent, state = this.stateOf(edge)): string {
    const open = openAsk(state)
    if (!open) return ""
    const conversation = open.ask && open.ask.kind !== "report" ? this.askingConversation(edge.child) : undefined
    return JSON.stringify([open, conversation && this.personWaiting(conversation)?.line])
  }

  /** What `edge`'s Fin asks changed: the walks of every Thread above it are made again. With no edge, every walk is. */
  private asksMoved(edge: ThreadParent | undefined): void {
    if (!edge) return this.asksKept.clear()
    const edges = this.store()?.edges()
    for (let thread: string | undefined = edge.parent, depth = 0; thread !== undefined && depth < 64; depth += 1) {
      this.asksKept.delete(thread)
      thread = edges?.of(thread)?.parent
    }
  }

  private walkAsks(store: ThreadStore, top: string): ReturnType<Agents["personAsk"]> {
    const asks: { edge: ThreadParent; question: string; ask: FinAsk }[] = []
    const look = (thread: string, depth: number) => {
      for (const edge of store.edges().children(thread)) {
        // One closed as finished asks nothing (`closeFinished`), and has no open Fin beneath it (`reopen`): its state and
        // its reports aren't read for every look at its Apex's row.
        if (closedFinished(edge)) continue
        const open = openAsk(this.stateOf(edge))
        if (open && open.on !== "lead" && open.ask) asks.push({ edge, question: askWords(open), ask: open.ask })
        for (const report of this.pendingReports(edge)) {
          if (!report.retainsQuestion || decisionOn(edge.asked, report) !== "person" || report.id === open?.ask?.id) continue
          const ask = reportAsk(report)
          asks.push({ edge, question: askWords({ question: report.question!, ...(report.status === "done" && { done: true }) }), ask })
        }
        if (depth < 64) look(edge.child, depth + 1)
      }
    }
    look(top, 0)
    const first = asks[0]
    if (!first) return undefined
    // A harness's own ask in its words; the reason it's the person's is the Agents panel's to say.
    const finConversation = first.ask.kind === "report" ? undefined : this.askingConversation(first.edge.child)
    const line = (finConversation && this.personWaiting(finConversation)?.line) || first.question
    return { fin: first.edge.child, name: first.edge.name, line, ask: first.ask, more: asks.length - 1 }
  }

  private actionLine(action: ReportAction): string {
    const store = this.store()!
    const source = store.edges().of(action.child)
    const receiver = this.conversationOf(action.owner)
    const receiverEdge = store.edges().of(action.owner)
    const request = action.custody && receiver ? this.deps.live.snapshot(receiver)?.requests.find(item => item.id === action.custody!.request) : undefined
    const state = receiverEdge?.closedAt !== undefined ? "stopped" : receiver && this.deps.archived?.(receiver) ? "archived" : "present"
    const custody = action.custody ? ` · custodian ${state} · request ${request?.status ?? "unavailable"}` : ""
    return `fin:${source?.name ?? action.child} · source Apex ${action.parent} · action ${JSON.stringify(action.report)} · v${action.version} · owner ${action.owner} · ${action.disposition.kind}${action.disposition.kind === "defer" ? ` until ${noteLine(action.disposition.resume, 120)}` : ""}${custody}: ${noteLine(action.action, 180)} · target ${noteLine(action.target.ref, 120)} @ ${noteLine(action.target.version, 80)}`
  }

  private pendingActions(parent: string, child?: string, after?: string) {
    // Action decisions are silent and outlive native work. Stop/archive never sends or cancels a disposition.
    const children = this.store()!.edges().children(parent).filter(edge => child === undefined || edge.child === child)
    return this.store()!.reportActions(parent, children.map(edge => edge.child), after)
  }

  /**
   * What a Fin asks that's still open: what it waits on, or a question in its last report while nothing has answered
   * it, whether or not it stopped to wait. One that asks and works on is still asking, so its answer reaches it as a
   * message, and an answer is never refused while the digest shows the question.
   */
  private pendingReports(edge: ThreadParent): readonly Report[] {
    // A stop hides what its Fin asked until it's resumed. One closed as finished had nothing open as it closed, and
    // anything asked of it since is as open as on any Fin: its answer reaches it and opens it again.
    if (edgeStopped(edge)) return []
    const conversation = this.conversationOf(edge.child)
    if (conversation && this.deps.archived?.(conversation)) return []
    return this.store()!.openReportAsks(edge.child)
  }

  private openQuestion(edge: ThreadParent, id?: string): OpenAsk | undefined {
    const open = openAsk(this.stateOf(edge))
    if (open?.ask?.kind !== "report" && open && (id === undefined || open.ask?.id === id)) return open
    if (id !== undefined && open?.ask?.id === id && !this.store()!.answerOf(id)) return open
    const reports = this.pendingReports(edge)
    const selected = id !== undefined ? reports.find((report) => report.id === id) : reports.length === 1 ? reports[0] : undefined
    if (selected) return { question: selected.question!, on: decisionOn(edge.asked, selected), ask: reportAsk(selected), ...(selected.status === "done" && { done: true as const }) }
    if (id !== undefined || reports.length > 1) return undefined
    if (open && (!open.ask || !this.store()!.answerOf(open.ask.id))) return open
    const latest = this.latest.get(edge.child)
    if (!latest || (latest.status !== "blocked" && latest.status !== "needs-input") || edge.closedAt !== undefined) return undefined
    const ask = reportAsk(latest)
    if (this.answersHeld.get(edge.child)?.ask === ask.id) return undefined
    return { question: latest.question ?? "It asks for a decision.", on: "lead", ask }
  }

  /**
   * Input reached a Fin, from anyone, its harness having taken it: what it last asked is answered, and nobody hears it
   * as open again (`docs/delivery-queue.md`, rule 13). Not before: a message removed unheard leaves the question open.
   * What Mako sends by itself answers nothing. An answer still on its way that later fails doesn't open it again.
   */
  inputDelivered(conversation: string, { id: request, text, actor, digest, continues, goal }: LiveRequest | SteerDelivered, delivery: FinDelivery): void {
    // Its harness took input: a turn begins, or a steer reaches the one it runs. Either is the Fin at work again.
    this.active(conversation)
    const child = this.childOfConversation(conversation)
    const taken = child ? this.store()?.edges().of(child) : undefined
    // Whatever it is and whoever sent it, a Fin closed as finished that takes input is at work, so it's open again:
    // its turn reports and wakes its Apex, and nothing that asks of open Fins passes it over.
    const edge = taken && closedFinished(taken) ? this.reopen(taken, "input its harness took") : taken
    // What an Apex's harness takes may carry its Fins' decisions (a digest, a turn one was folded into, a steer): each
    // is heard from now, and its minute starts.
    if (this.undecided.size) {
      const thread = this.store()?.journalPlacement(conversation)?.thread
      if (thread) this.decisionsHeard([...this.undecided.keys()].filter((fin) => this.store()?.edges().of(fin)?.parent === thread))
    }
    if (digest || continues || goal || actor?.kind === "service" || this.digestSteers.has(request)) return
    const latest = edge && this.latest.get(edge.child)
    if (!edge || !latest || (latest.status !== "blocked" && latest.status !== "needs-input") || edge.closedAt !== undefined) return
    // An agent's unlinked message is not an answer to a retained question. The person's direct-reply contract stays.
    if (latest.retainsQuestion && actor?.kind === "agent") return
    const store = this.store()!
    const ask = reportAsk(latest).id
    const delivered = { at: this.now(), delivery }
    const held = this.answersHeld.get(edge.child)
    if (held?.ask === ask) {
      if (held.request === request || held.delivered) return
      store.markAnswerDelivered(ask, delivered)
      this.answersHeld.set(edge.child, { ...held, delivered })
      return this.childMoved(edge, false)
    }
    // An Apex's message answers only what reached it: one that crossed the question is just a message, and the question goes on.
    if (actor?.kind === "agent" && !this.reachedApex(edge, latest)) return hostLog("agents", "a message crossed a question its Apex hasn't heard", { op: edge.op, ask, request })
    const claim = store.claimAnswer({ ask, child: ThreadIdSchema.parse(edge.child), op: request, by: actor?.kind === "agent" ? "lead" : "person", answer: (agentWords(text)?.body ?? text).slice(0, 400), request, text, ...(actor?.kind === "agent" && { actor }), at: this.now() })
    if (!claim.claimed) return
    store.markAnswerDelivered(ask, delivered)
    this.answersHeld.set(edge.child, { ...claim.answer, delivered })
    this.childMoved(edge, false)
  }

  /**
   * Whether a Fin's report has reached its Apex. A digest carrying it reached it once it was handed over: being sent
   * isn't being heard. One no digest carries took another way, so the store's receipt says, unless a steer still has it.
   */
  private reachedApex(edge: ThreadParent, report: Report): boolean {
    const apex = this.frontOf(edge.parent, edge.parentSession)
    const id = `notice:${edge.child}:${report.id}`
    if (apex && this.wakes.steered(id)) return false
    const requests = apex ? this.deps.live.snapshot(apex)?.requests ?? [] : []
    const carriers = requests.filter((request) => (request.status !== "canceled" || request.joinedInto !== undefined) && request.digest?.notices.some((notice) => notice.id === id))
    // One folded into another turn reached it when that turn was handed over.
    const went = (request: LiveRequest): boolean => handedOver(request.joinedInto === undefined ? request : requests.find((each) => each.id === request.joinedInto) ?? request)
    return carriers.length ? carriers.some(went) : !this.store()!.undeliveredReports().some((waiting) => waiting.report.id === report.id)
  }

  private async answerOnce(by: Answerer, edge: ThreadParent, op: string, input: Pick<AgentsAnswerInput, "answer" | "allow" | "person" | "ask">): Promise<AgentsAnswered | AgentRefused> {
    const repeat = this.repeatOf(edge, op)
    if (repeat) return repeat
    const open = this.openQuestion(edge, input.ask)
    if (!input.ask && !open && this.pendingReports(edge).length > 1) return { refused: "conflict", why: `${edge.name} has several pending report questions. agents_read lists their exact IDs; pass ask to answer only one.` }
    if (!open?.ask)
      return { refused: "conflict", why: `${edge.name} isn't waiting on a question, an approval or a decision: agents_send gives it a message.` }
    const { ask } = open
    const done = (answered: AgentsAnswered["answered"], delivery?: FinDelivery): AgentsAnswered => ({ child: edge.child, name: edge.name, answered, ...(ask.kind === "report" && { ask: ask.id }), ...(delivery && { delivery }) })
    const source = ask.kind === "report" ? this.store()!.reportsOf(edge.child).find((report) => report.id === ask.id) : undefined
    if (by.kind === "apex" && open.done && source?.decides === "person")
      return { refused: "conflict", why: `${edge.name} left that decision to the person, who answers it from their Inbox: don't answer it.` }
    if (input.person) {
      this.passToPerson(edge, ask, open.question)
      return done("person")
    }
    if (ask.kind === "report") {
      const words = input.answer?.trim()
      if (!words) return { refused: "conflict", why: "Its question needs an answer: one of its options by its label, or your own words." }
      const cut = cutOf(edge.child, this.latest.get(edge.child)?.for === "person" ? this.cutPassed(edge) ?? ask.id : ask.id)
      if (cut) return this.answerCut(by, edge, op, cut, words)
      const picked = ask.options?.find((option) => sameWords(option.label, words))
      const actor = by.kind === "apex" ? { kind: "agent" as const, session: SessionIdSchema.parse(by.apex.session) } : undefined
      const text = answerText(open.question, picked?.label ?? words)
      // Kept before any await, so of two answers at once (its Apex's and the person's, or either twice) one takes the
      // question, and a host that stops before its delivery still holds it answered and sends it once on its start.
      const claim = this.store()!.claimAnswer({
        ask: ask.id, child: ThreadIdSchema.parse(edge.child), op, by: by.kind === "apex" ? "lead" : "person", answer: (picked?.label ?? words).slice(0, 400),
        request: namedUuid(op), text: actor ? `${fromAgent(YOUR_APEX)}\n${text}` : text, ...(actor && { actor }), at: this.now(),
      })
      if (!claim.claimed) return claim.answer.op === op ? this.keptAnswered(edge, claim.answer) : { refused: "conflict", why: `${edge.name} no longer waits on that: it was answered.` }
      const settled = this.sendAnswer(edge, claim.answer, true)
      this.inflight.set(op, settled)
      this.untilSettled(op, settled)
      return settled
    }
    const tier = by.kind === "apex" ? this.tierOf(by.apex) : "full"
    if (ask.kind === "approval" && tier !== "full")
      return { refused: "access", why: `${edge.name}'s approval is the person's: this Thread is on ${tier}, and only an ${APEX_WORD} on full access answers its ${FIN_WORD}s' approvals. Leave it to them with person: true.` }
    const conversation = this.answeringConversation(edge.child, ask.id)
    const pending = conversation ? this.deps.live.pendingAsk(conversation) : undefined
    if (!conversation || !pending || pending.request !== ask.id) return { refused: "conflict", why: `${edge.name} no longer waits on that: it was answered.` }
    if (pending.gone) return { refused: "unavailable", why: `${edge.name}'s harness exited while it waited, so no answer reaches it: agents_send gives it a message to go on.` }
    const response = permissionAnswer(pending, input)
    if ("refused" in response) return response
    try {
      await this.deps.live.permission(conversation, pending.request, response)
    } catch (error) {
      return { refused: "unavailable", why: `${edge.name}'s harness didn't take the answer: ${errorMessage({ error })}` }
    }
    return done(ask.kind)
  }

  /**
   * A repeat of an answer to a report's question, by its operation: the one still on its way waits for it, and one the
   * store kept, delivered or not, is that answer. Undefined for an operation that answered nothing yet.
   */
  private repeatOf(edge: ThreadParent, op: string): Promise<AgentsAnswered | AgentRefused> | AgentsAnswered | undefined {
    const flight = this.inflight.get(op)
    if (flight) return flight.then((answered) => ("refused" in answered ? answered : { ...answered, deduped: true }))
    const kept = this.store()?.answerByOp(op)
    return kept && kept.child === edge.child ? this.keptAnswered(edge, kept) : undefined
  }

  /** Forgets an answer in flight once it settles, however it settles: its caller hears a failure, nothing else does. */
  private untilSettled(op: string, settled: Promise<AgentsAnswered | AgentRefused>): void {
    const forget = () => {
      if (this.inflight.get(op) === settled) this.inflight.delete(op)
    }
    settled.then(forget, (error: Error) => {
      forget()
      hostWarn("agents", "an answer didn't settle", { op, error: errorMessage({ error }) })
    })
  }

  private keptAnswered(edge: ThreadParent, kept: KeptAnswer): Promise<AgentsAnswered | AgentRefused> | AgentsAnswered {
    const flight = this.inflight.get(kept.op)
    if (flight) return flight.then((answered) => ("refused" in answered ? answered : { ...answered, deduped: true }))
    return { child: edge.child, name: edge.name, answered: "report", ask: kept.ask, ...(kept.delivered && { delivery: kept.delivered.delivery }), deduped: true }
  }

  /**
   * Carries an answer the store kept to its Fin under the request it was kept with, so a delivery already made is found
   * and not made again (`deliver`), and marks it delivered. One just given that doesn't reach it (`release`) lets go of
   * the question for another answer; one a starting host sends again stays kept for the next start.
   */
  private async sendAnswer(edge: ThreadParent, kept: KeptAnswer, release: boolean): Promise<AgentsAnswered | AgentRefused> {
    const store = this.store()!
    this.answersHeld.set(edge.child, kept)
    this.childMoved(edge, false)
    let sent: Delivered | AgentRefused
    try {
      sent = await this.deliver(edge, kept.request, kept.text, [], kept.actor, "steer")
    } catch (error) {
      sent = { refused: "unavailable", why: `${edge.name} didn't get the answer: ${errorMessage({ error })}` }
    }
    if ("refused" in sent) {
      if (!release) {
        hostWarn("agents", "a kept answer didn't reach its Fin; the next start sends it", { op: edge.op, ask: kept.ask, refused: sent.refused })
        return sent
      }
      store.releaseAnswer(kept.ask, kept.op)
      const before = store.latestAnswers().get(edge.child)
      if (before) this.answersHeld.set(edge.child, before)
      else this.answersHeld.delete(edge.child)
      this.childMoved(edge, false)
      return sent
    }
    const delivered = { at: this.now(), delivery: sent.delivery }
    try {
      store.markAnswerDelivered(kept.ask, delivered)
    } catch (error) {
      // It reached the Fin: the claim stays pending, and the next start finds that delivery under its request and stamps it.
      hostWarn("agents", "an answer's delivery couldn't be kept; the next start finds it and keeps it", { op: edge.op, ask: kept.ask, error: errorMessage({ error }) })
      return { child: edge.child, name: edge.name, answered: "report", ask: kept.ask, delivery: sent.delivery }
    }
    if (this.answersHeld.get(edge.child)?.ask === kept.ask) this.answersHeld.set(edge.child, { ...kept, delivered })
    hostLog("agents", "answer delivered", { op: edge.op, ask: kept.ask, by: kept.by, delivery: sent.delivery, ...(!release && { resent: true }), ...(sent.deduped && { deduped: true }) })
    return { child: edge.child, name: edge.name, answered: "report", ask: kept.ask, delivery: sent.delivery }
  }

  /**
   * What the pull request watch reads: each open Fin's retained dependencies (`waitingOn`). Equivalent narration
   * keeps their first registration; claims deduplicate head/check observations. Failed, stopped and archived Fins wait on nothing.
   */
  private pullWaits(): PullWait[] {
    return [...this.finPullWaits(), ...this.turnPullWaits()]
  }

  /**
   * The pull requests turns' armed waits name, keyed apart from Fins' (`TURN_WAIT_PULL`) so an outcome meets the wait,
   * never a Fin's report: read with the same cadence and the same outcomes (`pullOutcome`). A bare `#412` is read in the
   * waiting conversation's folder.
   */
  private turnPullWaits(): PullWait[] {
    const store = this.store()
    if (!store) return []
    return store.armedTurnWaits().flatMap((wait) => wait.items.flatMap((item): PullWait[] => {
      if (item.kind !== "pull" || wait.met[turnWaitItemKey(item)] !== undefined) return []
      const ref = pullRef(item.pull)
      if (!ref) return []
      const cwd = this.deps.live.session(wait.conversation)?.cwd || homedir()
      return [{
        key: `${TURN_WAIT_PULL}${wait.id}:${item.pull}:${item.until ?? ""}`,
        child: wait.thread,
        report: wait.id,
        pullKey: item.pull,
        since: wait.createdAt,
        pull: item.pull,
        target: { key: ref.repository ? item.pull : `${item.pull}@${cwd}`, ...(ref.repository && { repository: ref.repository }), number: ref.number, cwd },
        ...(item.until && { until: item.until }),
      }]
    }))
  }

  private finPullWaits(): PullWait[] {
    const store = this.store()
    if (!store) return []
    this.sync()
    const edges = store.edges()
    const open = [...this.latest.values()].flatMap((report) => {
      if (report.status === "failed" || !report.waitingOn?.some((item) => item.kind === "pull-request")) return []
      const edge = edges.of(report.child)
      if (!edge || edgeStopped(edge)) return []
      const conversation = this.conversationOf(edge.child)
      if (conversation && this.deps.archived?.(conversation)) return []
      return [{ edge, report, conversation }]
    })
    if (!open.length) return []
    return open.flatMap(({ edge, report, conversation }) => {
      const reports = store.reportsOf(edge.child)
      const claimed = store.pullWakesFor(edge.child)
      const stopped = new Set((conversation ? this.deps.live.held(conversation)?.requests ?? [] : []).filter((request) => request.pause === "stop").map((request) => request.id))
      return report.waitingOn!.flatMap((item): PullWait[] => {
        const pull = waitedPull(item)
        if (!pull) return []
        const retained = pullWaitReports(reports, pull.key)
        const anchor = retained[0]
        if (!anchor) return []
        // A direct Stop can hold a journal note without closing the delegation. Its latch also pauses this watch.
        if (claimed.some((wake) => stopped.has(wake.request) && wake.pull === pull.key && retained.some((entry) => entry.id === wake.report))) return []
        // Older builds kept no observation cursor. Preserve their still-live claim rather than replaying an unknown outcome.
        if (claimed.some((wake) => wake.obsolete === undefined && retained.some((entry) => wake.wait === `pull-wake:${edge.child}:${entry.id}:${pull.key}`))) return []
        const key = `pull-wake:${edge.child}:${anchor.id}:${pull.key}`
        const cwd = (conversation && this.deps.live.session(conversation)?.cwd) || homedir()
        return [{
          key,
          child: edge.child,
          report: anchor.id,
          pullKey: pull.key,
          since: anchor.at,
          pull: pull.repository ? `${pull.repository}#${pull.number}` : `#${pull.number}`,
          target: { key: pull.repository ? pull.key : `${pull.key}@${cwd}`, ...(pull.repository && { repository: pull.repository }), number: pull.number, cwd },
          ...(pull.until && { until: pull.until }),
        }]
      })
    })
  }

  /**
   * Whether a Fin still waits on a pull request as one report named it: its delegation open, its Thread not archived
   * nor stopped, and every report since the original still names the same pull request and condition. Read before a claim, before
   * it's handed to delivery, and at its handoff (`admits`), since a report or a stop can come between any two.
   */
  private pullWaitHolds(child: string, report: string, pull: string): boolean {
    const store = this.store()
    const edge = store?.edges().of(child)
    // A Fin closed as finished still waits on what it named: only a stop, an archive or its own later word ends a wait.
    if (!store || !edge || edgeStopped(edge)) return false
    const conversation = this.conversationOf(child)
    if (conversation && this.deps.archived?.(conversation)) return false
    const state = this.stateOf(edge)
    if (state.kind === "ended" && state.outcome === "stopped") return false
    return pullWaitReports(store.reportsOf(child), pull).some((entry) => entry.id === report)
  }

  /** A pull request's outcome: claimed once per retained dependency and observation, then sent as Mako's note. */
  private async pullOutcome(wait: PullWait, outcome: PullOutcome, note: string): Promise<void> {
    if (wait.key.startsWith(TURN_WAIT_PULL)) {
      // The note says "Mako: PR acme/app#371 checks settled: …"; the wait's line names the pull request already.
      const said = note.startsWith("Mako: PR ") ? note.slice("Mako: PR ".length) : note
      const words = said.startsWith(`${wait.pull} `) ? said.slice(wait.pull.length + 1) : said
      this.turnWaits.metWhere((item) => item.kind === "pull" && item.pull === wait.pullKey && item.until === wait.until, words)
      return
    }
    const store = this.store()
    const edge = store?.edges().of(wait.child)
    if (!store || !edge || !this.pullWaitHolds(wait.child, wait.report, wait.pullKey)) return
    const key = wait.observation ? `${wait.key}:observation:${wait.observation}` : wait.key
    const { wake, claimed } = store.claimPullWake({
      wait: key,
      child: ThreadIdSchema.parse(wait.child),
      report: wait.report,
      pull: wait.pullKey,
      // Informational wakes keep the existing storage tag for older hosts; their notes and cursors say what happened.
      outcome: outcome.kind === "no-checks" || outcome.kind === "incomplete" || outcome.kind === "unreadable" ? "settled" : outcome.kind,
      request: namedUuid(`${key}:${outcome.kind}`),
      text: note,
      at: this.now(),
    })
    if (claimed) {
      hostLog("agents", "pull request outcome", { wait: wait.key, child: wait.child, outcome: outcome.kind })
      await this.sendPullWake(edge, wake)
    }
  }

  /**
   * Mako's note of a pull request's outcome into the Fin that waits on it, never its Apex: a finished Fin takes it as
   * its next turn, a working one after its turn. It never reopens, resumes or takes over a stopped Fin, and its handoff
   * reads the wait again (`admits`); one whose wait no longer holds is retired, never sent. One the Fin's
   * conversation couldn't take waits in the store for the next start (`undeliveredPullWakes`).
   */
  private async sendPullWake(edge: ThreadParent, kept: KeptPullWake): Promise<void> {
    const store = this.store()!
    if (!this.pullWaitHolds(kept.child, kept.report, kept.pull)) return this.retirePullWake(kept)
    let sent: Delivered | AgentRefused
    try {
      sent = await this.deliver(edge, kept.request, kept.text, [], PULL_WATCH_ACTOR, "queue", true)
    } catch (error) {
      sent = { refused: "unavailable", why: errorMessage({ error }) }
    }
    if ("refused" in sent) {
      hostWarn("agents", "a pull request's outcome didn't reach its Fin; the next start sends it", { op: edge.op, wait: kept.wait, refused: sent.refused })
      return
    }
    store.markPullWakeDelivered(kept.wait, { at: this.now(), delivery: sent.delivery })
    hostLog("agents", "pull request wake", { op: edge.op, wait: kept.wait, outcome: kept.outcome, delivery: sent.delivery, ...(sent.deduped && { deduped: true }) })
    this.pulls.refresh()
  }

  private retirePullWake(kept: KeptPullWake): void {
    this.store()?.retirePullWake(kept.wait, this.now())
    hostLog("agents", "pull request wake retired", { child: kept.child, wait: kept.wait, outcome: kept.outcome })
  }

  /** At a request's handoff: a pull request's note goes only while its wait holds, and is retired once it doesn't. */
  admits(conversation: string, request: Pick<LiveRequest, "id" | "actor">): boolean {
    if (isTurnWaitNote(request)) return this.turnWaits.admits(request.id)
    if (!isPullNote(request)) return true
    const child = this.childOfConversation(conversation)
    const kept = child ? this.store()?.pullWakeOfRequest(child, request.id) : undefined
    if (!kept || kept.obsolete !== undefined) return false
    if (this.pullWaitHolds(kept.child, kept.report, kept.pull)) return true
    this.retirePullWake(kept)
    return false
  }

  /**
   * The Apex leaves a Fin's ask to the person: a report on the Fin that no Apex hears, with the ask's options. A
   * finished Fin's decision stays a done report, its result and artifacts with it, so it still reads as done.
   */
  private passToPerson(edge: ThreadParent, ask: FinAsk, question: string): void {
    const from = ask.kind === "report" ? this.store()!.reportsOf(edge.child).find((report) => report.id === ask.id) : undefined
    const decision = from?.status === "done"
    this.keepReport(edge, {
      id: passedId(edge.child, ask.id),
      child: ThreadIdSchema.parse(edge.child),
      status: decision ? "done" : "needs-input",
      summary: from?.summary ?? `It waits: ${question}`,
      ...(decision && from.artifacts && { artifacts: from.artifacts }),
      ...(from?.waitingOn && { waitingOn: from.waitingOn }),
      question: from?.question ?? question,
      ...(ask.options && { options: ask.options }),
      ...(ask.recommended !== undefined && { recommended: ask.recommended }),
      ...(ask.action && { action: ask.action }),
      for: "person",
      ...(from?.retainsQuestion ? { retainsQuestion: true as const, supersedes: [from.id] } : { implicit: true as const }),
      ownerGeneration: this.generation,
      at: this.now(),
    })
  }

  async stop(caller: AgentCaller, input: AgentsStopInput): Promise<AgentsStopResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const store = this.store()!
    const why = input.reason ?? `its ${APEX_WORD} stopped it`
    const one = input.child === "all" ? undefined : this.resolve(apex, input.child, false)
    if (input.child !== "all" && !one) {
      const name = finName(input.child)
      const under = [...this.starts.values()].find((start) => start.thread === apex.thread && (start.name === name || (!start.name && start.asked === name) || namedUuid(start.op) === input.child))
      const waiting = this.queuedOfApex(apex).find(({ spawn, queued }) => namedUuid(spawn.op) === input.child || (queued.input.name ?? queued.input.title) === name || spawn.op === under?.op)
      if (!waiting && !under) return unknownFin(input.child)
      const shown = under?.name ?? under?.asked ?? waiting?.queued.input.name ?? waiting?.queued.input.title ?? name
      const outcome = await this.stopUnstarted(waiting?.spawn.op ?? under!.op, under, why)
      // What was to start after it is its Apex's to decide now.
      void this.drain()
      return outcome === true ? { stopped: [shown] } : { stopped: [], pending: [{ name: shown, why: outcome }] }
    }
    if (one?.placed) {
      const ended = await this.stopAway(apex, one, why)
      if ("refused" in ended) return ended
      return "pending" in ended ? { stopped: [], pending: [{ name: one.name, why: ended.pending }] } : { stopped: ended.stopped ? [one.name] : [] }
    }
    const targets = one ? [one] : store.edges().children(apex.thread)
    const stopped = new Set<string>()
    const pending: { name: string; why: string }[] = []
    // What waits and what's under way go first, so an end below doesn't start it.
    if (input.child === "all") {
      const unstarted = new Map<string, { name: string; under?: StartRecord }>()
      const rows = new Map(this.queuedOfApex(apex).map(({ spawn, queued }) => [spawn.op, queued]))
      for (const start of this.starts.values()) if (start.thread === apex.thread) unstarted.set(start.op, { name: start.name ?? start.asked ?? start.op, under: start })
      for (const [op, queued] of rows) if (!unstarted.has(op)) unstarted.set(op, { name: queued.input.name ?? queued.input.title ?? op })
      // Each is stopped, or its stop kept, before anything is awaited: what a place answers comes after.
      const outcomes = [...unstarted].map(async ([op, { name, under }]) => ({ name, outcome: await this.stopUnstarted(op, under, why) }))
      for (const { name, outcome } of await Promise.all(outcomes)) {
        if (outcome === true) stopped.add(name)
        else pending.push({ name, why: outcome })
      }
    }
    for (const edge of targets) {
      if (edge.placed) {
        const ended = await this.stopAway(apex, edge, why)
        if ("pending" in ended) pending.push({ name: edge.name, why: ended.pending })
        else if ("refused" in ended) hostWarn("agents", "a Fin placed elsewhere wouldn't stop; it goes on there", { op: edge.op, refused: ended.refused, why: ended.why })
        else if (ended.stopped) stopped.add(edge.name)
        continue
      }
      this.toldBy(apex, edge, false)
      if (await this.end(edge, why)) stopped.add(edge.name)
      this.heardFrom(apex, edge)
    }
    this.forget(apex.thread)
    return { stopped: [...stopped], ...(pending.length && { pending }) }
  }

  /**
   * `wait`: a turn's wait (`contracts/turn-waits.ts`), started, cancelled or read. An agent waits in its own Thread on
   * its Fins, pull requests and a time; one that could never end is refused (a Fin stopped or finished, a pull request
   * closed, or merged when it waits for checks or a review). It's kept in the Thread store and wakes the Thread once.
   */
  async turnWait(caller: AgentCaller, input: TurnWaitInput): Promise<TurnWaitResult> {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: "Waits need the Thread store, which didn't open on this host." }
    const apex = caller.kind === "person" ? undefined : this.apexOf(caller)
    if (apex && "refused" in apex) return { refused: "no-thread", why: apex.why }
    if (apex?.conversation && input.conversation && input.conversation !== apex.conversation) return { refused: "not-yours", why: "An agent waits in its own Thread: leave conversation out." }
    const conversation = apex?.conversation ?? input.conversation
    if (!conversation) return { refused: "no-thread", why: "Name the conversation that waits (--conversation), or call it from a Thread's shell, where MAKO_SESSION_ID names it." }
    const thread = apex?.thread ?? store.journalPlacement(conversation)?.thread
    if (!thread) return { refused: "no-thread", why: "Mako doesn't know that conversation here." }
    const action = input.action ?? "start"
    if (action === "list") {
      const armed = store.armedTurnWaitOf(conversation)
      const line = armed ? turnWaitLine(armed) : undefined
      return { outcome: "listed", ...(line && { wait: { id: line.wait, description: line.description, waitsOn: line.items.map((item) => ({ what: item.words, met: item.met })), returnWhen: line.returnWhen, ...(line.endsBy !== undefined && { endsBy: new Date(line.endsBy).toISOString() }) } }) }
    }
    if (action === "cancel") {
      const armed = store.armedTurnWaitOf(conversation)
      if (armed) this.turnWaits.cancel(armed.id, caller.kind === "person" ? "person" : "agent")
      return { outcome: "cancelled", ...(armed && { wait: armed.id }) }
    }
    // Pull requests are read first, the only await; the Fins are checked after, with nothing between their check and
    // the arm, so a Fin that ends while a read is pending can't leave a wait that never ends.
    const items: TurnWaitItem[] = []
    const met: Record<string, { at: number; words: string }> = {}
    const pulls = new Map<number, Extract<TurnWaitItem, { kind: "pull" }>>()
    const asked = input.on ?? []
    const checks = new Map<number, Extract<TurnWaitItem, { kind: "check" }>>()
    for (const [index, on] of asked.entries()) {
      if (!("check" in on)) continue
      const item: Extract<TurnWaitItem, { kind: "check" }> = { kind: "check", tier: on.check, ...(on.target && { target: on.target }) }
      if (!(await this.watchCheck(conversation, item)))
        return { refused: "never", why: `No ${on.check} check of this Thread's app is running or waiting for a build slot: run app_check with tier "${on.check}" first, then wait on it.` }
      checks.set(index, item)
    }
    for (const [index, on] of asked.entries()) {
      if ("fin" in on || "check" in on) continue
      const ref = pullRef(on.pull)
      if (!ref) return { refused: "invalid", why: `${on.pull} isn't a pull request: name it as owner/name#412, #412 or its URL.` }
      const item: Extract<TurnWaitItem, { kind: "pull" }> = { kind: "pull", pull: pullKey(ref), ...(on.until && { until: on.until }) }
      const reading = await this.readPullOnce(item, conversation)
      if (reading?.state === "closed") return { refused: "never", why: `${item.pull} was closed without merging, so nothing more will happen on it.` }
      if (reading?.state === "merged") {
        if (item.until !== "merge") return { refused: "never", why: `${item.pull} is merged already: its checks and reviews won't change now.` }
        met[turnWaitItemKey(item)] = { at: this.now(), words: "merged" }
      }
      pulls.set(index, item)
    }
    for (const [index, on] of asked.entries()) {
      const pull = pulls.get(index) ?? checks.get(index)
      if (pull) {
        items.push(pull)
        continue
      }
      if (!("fin" in on)) continue
      if (!apex) return { refused: "invalid", why: `Wait on a ${FIN_WORD} from its ${APEX_WORD}'s own Thread.` }
      const edge = this.resolve(apex, on.fin, false)
      if (!edge) return { refused: "unknown-fin", why: `${on.fin} isn't a ${FIN_WORD} of this Thread: agents_list names them.` }
      if (edge.closedAt !== undefined || this.stateOf(edge).kind === "ended")
        return { refused: "never", why: `${edge.name} isn't at work, so it has no result coming: send it work with agents_send, or read its report with agents_read.` }
      items.push({ kind: "fin", fin: edge.child, name: edge.name })
    }
    let at: number | undefined
    if (input.at !== undefined) {
      at = Date.parse(input.at)
      if (!Number.isFinite(at)) return { refused: "invalid", why: `${input.at} isn't a time: give it as ISO 8601, such as 2026-11-16T09:00:00-08:00.` }
    }
    const armed = this.turnWaits.arm({
      conversation,
      thread,
      clientKey: input.clientKey,
      description: input.description ?? "",
      items,
      ...(input.returnWhen && { returnWhen: input.returnWhen }),
      ...(input.seconds !== undefined && { seconds: input.seconds }),
      ...(at !== undefined && { at }),
      met,
    })
    if ("refused" in armed) return { refused: armed.refused, why: armed.why }
    if ("alreadyDone" in armed) return { outcome: "already-done", met: Object.values(armed.met).map((each) => each.words), next: AFTER_WAIT.alreadyDone }
    hostLog("agents", "turn wait", { conversation, wait: armed.wait.id, items: items.length, existed: armed.existed })
    return {
      outcome: "armed",
      wait: armed.wait.id,
      waitsOn: armed.wait.items.map(turnWaitItemWords),
      ...(armed.wait.endsBy !== undefined && { endsBy: new Date(armed.wait.endsBy).toISOString() }),
      ...(armed.replaced.length && { replaced: armed.replaced.map((wait) => wait.description) }),
      next: AFTER_WAIT.armed,
    }
  }

  /**
   * Hears a conversation's app check end, and meets that conversation's waits on it. False when none runs or waits for
   * a slot. A host that starts watches the armed waits' checks again (`resume`); one that ended while it was down meets
   * its waits at once, saying so.
   */
  private async watchCheck(conversation: string, item: Extract<TurnWaitItem, { kind: "check" }>): Promise<boolean> {
    if (!this.deps.watchCheck) return false
    return await this.deps.watchCheck(conversation, item.tier, (words) => {
      this.turnWaits.metWhere((each, wait) => wait.conversation === conversation && each.kind === "check" && each.tier === item.tier, words)
    }).catch(() => false)
  }

  /** The armed waits' app checks, watched again by a host that starts: their runs' exits were the last host's to hear. */
  private rewatchChecks(): void {
    for (const wait of this.store()?.armedTurnWaits() ?? [])
      for (const item of wait.items) {
        if (item.kind !== "check" || wait.met[turnWaitItemKey(item)] !== undefined) continue
        void this.watchCheck(wait.conversation, item).then((watching) => {
          if (!watching) this.turnWaits.met(wait.id, item, `the ${item.tier} check ended while Mako was stopped; app_check with tier "${item.tier}" reads how`)
        })
      }
  }

  /**
   * The conversation's Thread is leaving this host (a move's handover): its waits end, and the notes that tell its agent
   * on arrival are answered, the same however often the handover is asked (`since`, the move's start).
   */
  waitsDeparting(conversation: string, since: number): string[] {
    return this.turnWaits.departing(conversation, since).map(turnWaitMovedNote)
  }

  /** The move that ended the conversation's waits didn't happen: they're armed again, and their checks watched again. */
  waitsStayed(conversation: string, since: number): void {
    for (const wait of this.turnWaits.stayed(conversation, since))
      for (const item of wait.items) {
        if (item.kind !== "check" || wait.met[turnWaitItemKey(item)] !== undefined) continue
        void this.watchCheck(conversation, item).then((watching) => {
          if (!watching) this.turnWaits.met(wait.id, item, `the ${item.tier} check ended while this Thread was moving; app_check with tier "${item.tier}" reads how`)
        })
      }
  }

  /** A pull request's state as a wait arms on it; nothing when it can't be read now, which refuses nothing. */
  private async readPullOnce(item: Extract<TurnWaitItem, { kind: "pull" }>, conversation: string): Promise<PullReading | null | undefined> {
    const read = this.deps.readPull
    const ref = pullRef(item.pull)
    if (!read || !ref) return undefined
    const cwd = this.deps.live.session(conversation)?.cwd || homedir()
    try {
      return await read({ ...(ref.repository && { repository: ref.repository }), number: ref.number, cwd })
    } catch {
      return undefined
    }
  }

  /**
   * A turn wait's note into the conversation that waited, as Mako's words under the request it fired with: a Fin's
   * through `deliver` as a pull request's note goes, a Thread's own straight into its queue. `later` when the
   * conversation can't take it now: its next turn's end, or the next start, sends it (`TurnWaits.retry`, `start`).
   */
  private async deliverWait(wait: TurnWait): Promise<"taken" | "later"> {
    const due = wait.fired
    if (!due) return "taken"
    let fired = due
    // The crew check-in says how the crew stands as it's due, only once one of them has been quiet past QUIET_MS:
    // a crew still showing work is armed again at the same step, a turn under way ends by arming the next, and a crew
    // that finished has reported.
    if (wait.armedBy === "mako") {
      const crew = this.crewAtWork(wait.conversation)
      const reported = this.crewReportedSince(wait.conversation, wait.createdAt)
      const quiet = !reported && crew.some((fin) => fin.quietMs !== undefined && fin.quietMs >= (this.deps.quietMs ?? QUIET_MS))
      const busy = this.deps.live.atWork(wait.conversation)
      if (!crew.length || busy || !quiet) {
        const why = !crew.length ? "no Fin at work" : busy ? "at work" : reported ? "a Fin reported" : "the crew shows work"
        hostLog("waits", "crew check-in passed quietly", { wait: wait.id, conversation: wait.conversation, why })
        if (crew.length && !busy) this.armCrew(wait.conversation, `crew\0${wait.id}\0again`, reported ? 0 : wait.crewStep ?? 0)
        return "taken"
      }
      fired = { ...due, text: crewWaitNote(crew, stoodFor, crewWaitSeconds(wait.crewStep ?? 0)) }
    }
    const child = this.childOfConversation(wait.conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (edge) {
      const sent = await this.deliver(edge, fired.request, fired.text, [], TURN_WAIT_ACTOR, "queue", true)
      if ("refused" in sent) {
        hostLog("agents", "turn wait note held", { wait: wait.id, refused: sent.refused })
        return "later"
      }
      return "taken"
    }
    const live = this.deps.live
    if (!live.session(wait.conversation) || this.deps.archived?.(wait.conversation)) return "later"
    if (live.held(wait.conversation)?.requests.some((request) => request.id === fired.request)) return "taken"
    live.submit(wait.conversation, fired.request, fired.text, [], undefined, undefined, undefined, TURN_WAIT_ACTOR)
    return "taken"
  }

  /**
   * The host came back (`watchWake`: a resume, an unlock, or the clock jumping over a sleep): a wait whose time came
   * meanwhile fires now, once, saying it's late; the timer it armed may have slept through it.
   */
  woke(): void {
    this.turnWaits.check()
  }

  /** The person's Stop, or their archive, of a conversation's Thread ends the wait its turn armed. */
  threadStopped(conversation: string, by: "stop" | "archive"): void {
    this.turnWaits.cancelOf(conversation, by)
  }

  async wait(caller: AgentCaller, input: AgentsWaitInput): Promise<AgentsWaitResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    const store = this.store()!
    const named = (input.children ?? []).map((child) => ({ child, edge: this.resolve(apex, child, true) }))
    const missing = named.find(({ edge }) => !edge)
    if (missing) return unknownFin(missing.child)
    const edges = named.length ? named.flatMap(({ edge }) => edge ?? []) : store.edges().children(apex.thread)
    const after = input.after ?? 0
    const collect = () => edges.flatMap((edge) => store.reportsOf(edge.child, after).map((report) => ({ edge, report })))
      .sort((a, b) => a.report.at - b.report.at)
    let found = collect()
    let timedOut = false
    if (!found.length) {
      timedOut = await new Promise<boolean>((resolve) => {
        const wake = () => {
          found = collect()
          if (!found.length) return
          done(false)
        }
        const timer = setTimeout(() => done(true), Math.max(0, Math.min(input.timeoutMs ?? WAIT_LIMIT_MS, WAIT_LIMIT_MS)))
        const done = (out: boolean) => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          resolve(out)
        }
        this.waiters.add(wake)
      })
    }
    return {
      reports: found.map(({ edge, report }) => ({ child: edge.child, name: edge.name, status: report.status, line: reportPhase(report) ?? report.status, at: report.at })),
      cursor: found.at(-1)?.report.at ?? after,
      timedOut,
    }
  }

  /** The host's Fins and budgets, for Diagnostics. */
  diagnostics(): AgentsDiagnostics {
    const store = this.store()
    if (!store) return { fins: 0, running: 0, followed: 0, queued: 0, notices: 0, budget: this.budget, trees: [], routes: { ...this.routes }, answers: { ...this.answerCounts } }
    const edges = store.edges()
    const roots = new Set([...edges.all.map((edge) => this.rootOf(edge.parent)), ...store.queuedSpawns().map((spawn) => spawn.tree), ...[...this.starts.values()].flatMap((start) => (start.launching ? [start.launching.tree] : []))])
    const trees = [...roots].map((apex) => { const { running, started } = this.treeCounts(apex); return { apex, running, started } })
    return {
      fins: edges.all.length,
      running: trees.reduce((sum, tree) => sum + tree.running, 0),
      followed: this.runs.following(),
      queued: store.queuedSpawns().length,
      notices: this.wakes.pending(),
      budget: this.budget,
      trees,
      routes: { ...this.routes },
      answers: { ...this.answerCounts },
    }
  }

  dispose(): void {
    this.places?.dispose()
    for (const episode of this.limits.values()) clearTimeout(episode.timer)
    this.limits.clear()
    for (const timer of this.noticeEnds.values()) clearTimeout(timer)
    this.noticeEnds.clear()
    this.stopped = true
    this.quiet.stop()
    for (const { timer } of this.cutChecks.values()) clearTimeout(timer)
    this.cutChecks.clear()
    this.stopRoomWatch()
    this.stopFinishedSweep()
    this.stopPullWatch()
    this.turnWaits.stop()
    for (const cancel of this.unanswered.values()) cancel()
    this.unanswered.clear()
    for (const held of this.undecided.values()) held.cancel()
    this.undecided.clear()
    this.runs.dispose()
    this.wakes.dispose()
    for (const wake of this.waiters) wake()
    for (const hold of this.holds) hold.end()
  }

  // ── Other places ──

  /**
   * `mako:agents-capabilities`: what this device offers as a place for Fins, so a caller checks before it places one.
   * A stand-in for the runtime link's `advertise` frame, whose `slots` these are (`AgentsCapabilities`): once that
   * lands, the probe carries the harnesses and the version too, room is read from it alone, and this call goes.
   */
  capabilities(): AgentsCapabilities {
    const limit = this.placeLimit(HERE)
    const of = limit.place === "device" ? limit.atOnce : FIN_LIMIT
    const used = this.full(HERE) ? of : Math.min(of, this.working(HERE) + this.waitingForRoom(HERE))
    return { orchestration: { version: ORCHESTRATION_VERSION }, slots: { used, of }, harnesses: [...this.deps.harnesses()], ...(this.deps.verifySource && { committedSource: 1 as const }) }
  }

  /**
   * `mako:agents-place`: a Fin started here for an Apex on another device, as this device starts its own. Its op is
   * the Apex's (`start:{apexSession}:{clientKey}`), so a repeat answers the same Fin. Its access is at most the
   * Apex's and this device's ceiling for such Fins; its folder is a worktree of this device's checkout of the
   * project's remote, cloned when it has none; and its edge names its Apex there (`ThreadParent.remote`), so its
   * reports go to that device's runtime.
   */
  async place(input: AgentsPlaceInput): Promise<AgentsPlaced | AgentRefused> {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: `${FIN_WORD}s need the Thread store, which didn't open on this device.` }
    if (input.version !== ORCHESTRATION_VERSION)
      return { refused: "unsupported", why: `This device speaks version ${ORCHESTRATION_VERSION} of placing ${FIN_WORD}s and the caller version ${input.version}. Update Mako on ${input.version > ORCHESTRATION_VERSION ? "this device" : "the caller's"}.` }
    const caller: ApexCaller = { kind: "apex", device: input.parent.device, thread: input.parent.thread, session: input.parent.session, ...(input.parent.conversation && { conversation: input.parent.conversation }), access: input.parent.access }
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    if (input.op !== `start:${apex.session}:${input.clientKey}`) return { refused: "conflict", why: "A placed start's op is start:{its Apex's Session}:{its clientKey}." }
    let source: CommittedFinSource | undefined
    if (input.workspace.source) {
      try { source = checkedFinSource(input.workspace.source) }
      catch { return this.refuse(input.op, "conflict", "The Fin's committed source manifest is invalid.") }
      if (!input.workspace.folder || input.workspace.remote !== undefined || input.workspace.branch !== undefined || input.workspace.base !== undefined)
        return this.refuse(input.op, "conflict", "Committed source requires its prepared folder, without another remote, branch or base.")
    }
    const kept = store.edges().byOp(input.op)
    if (kept) return kept.source?.sha256 === source?.sha256 ? this.placedAnswer(kept, true) : this.refuse(input.op, "conflict", "That placement already has a different source.")
    // Its Apex stopped it before it got here (`cancel`): whenever it arrives, it doesn't run.
    const stopped = `Its ${APEX_WORD} stopped this start before it reached this device, so it doesn't run here.`
    if (store.startCancelled(input.op)) return this.refuse(input.op, "conflict", stopped)
    const asked = childAccess(input.parent.access, input.access)
    if (!asked) return this.refuse(input.op, "access", `A ${FIN_WORD} runs at most at its ${APEX_WORD}'s access: its ${APEX_WORD} is on ${input.parent.access}, so ${input.access} is refused.`)
    const ceiling = this.deps.placedCeiling?.() ?? PLACED_CEILING
    const access = childAccess(ceiling, asked) ?? ceiling
    let folder = input.workspace.folder
    if (source) {
      if (!this.deps.verifySource) return this.refuse(input.op, "unsupported", "This host cannot verify committed Fin sources.")
      try { folder = await this.deps.verifySource(folder!, source) }
      catch { return this.refuse(input.op, "conflict", "The prepared checkout does not match the Fin's committed source.") }
    }
    if (!folder) {
      const remote = input.workspace.remote
      if (!remote) return this.refuse(input.op, "place-unavailable", `A ${FIN_WORD} placed here works in a checkout of its project's Git remote, and its ${APEX_WORD} named none.`)
      const found = this.deps.checkoutOf ? await this.deps.checkoutOf(remote).catch((error) => ({ refused: errorMessage({ error }) })) : { refused: "this device keeps no projects folder to clone it into" }
      if ("refused" in found) return this.refuse(input.op, "place-unavailable", `This device has no checkout of ${remote} and couldn't make one: ${found.refused}`)
      folder = found.folder
    }
    if (store.startCancelled(input.op)) return this.refuse(input.op, "conflict", stopped)
    const started = await this.admitOnce(caller, {
      brief: input.brief,
      name: input.name,
      ...(input.title && { title: input.title }),
      ...(input.role && { role: input.role }),
      harness: input.harness,
      ...(input.model && { model: input.model }),
      ...(input.reasoning && { reasoning: input.reasoning }),
      ...(input.fast !== undefined && { fast: input.fast }),
      access,
      // Its own worktree of this device's checkout, as a local Fin's; a folder made for it (a cloud Thread's clone) is its own already.
      ...(!input.workspace.folder && { workspace: { ...(input.workspace.branch && { branch: input.workspace.branch }), ...(input.workspace.base && { base: input.workspace.base }) } }),
      ...(input.mode && { mode: input.mode }),
      ...(input.wake && { wake: input.wake }),
      clientKey: input.clientKey,
      cwd: folder,
    }, source && input.workspace.folder ? { source, root: input.workspace.folder } : undefined)
    if ("refused" in started) return started
    const edge = started.child ? store.edges().of(started.child) : undefined
    if (!edge) return { refused: "budget", why: started.why ?? "This device has no room for it now." }
    if (edge.source?.sha256 !== source?.sha256) return this.refuse(input.op, "conflict", "That placement already has a different source.")
    const lowered = access !== asked ? `It runs on ${access} here: this device holds ${FIN_WORD}s started from other devices to ${ceiling}.` : undefined
    return this.placedAnswer(edge, started.deduped === true, [lowered, started.note].filter(Boolean).join(" "))
  }

  private placedAnswer(edge: ThreadParent, deduped: boolean, note?: string): AgentsPlaced {
    const store = this.store()!
    const reading = this.childReading(edge)
    const conversation = this.conversationOf(edge.child)
    const session = store.thread(edge.child)?.sessions[0]
    const runsOn = reading.runsOn ? finTuningLine(reading.runsOn) : reading.model
    const said = note || edge.tuned?.note
    return {
      child: edge.child,
      name: edge.name,
      ...(session && { session }),
      ...(conversation && { conversation }),
      harness: this.harnessOf(edge),
      access: edge.asked.access ?? "ask",
      state: this.stateOf(edge).kind,
      ...(runsOn && { runsOn }),
      ...(said && { note: said }),
      ...(deduped && { deduped: true as const }),
      ...(edge.source && { sourceSha256: edge.source.sha256 }),
    }
  }

  /**
   * `mako:agents-cancel`: an Apex on another device stopped a start it sent here without knowing how it went. The
   * stop is kept first, by the start's op, so the start is refused whenever it arrives; then the Fin that start made,
   * if it made one, is stopped as any stop stops it, and answered. A start under way here ends without a Fin.
   */
  async cancel(input: AgentsCancelInput): Promise<AgentsCancelled> {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: `${FIN_WORD}s need the Thread store, which didn't open on this device.` }
    if (input.version !== ORCHESTRATION_VERSION)
      return { refused: "unsupported", why: `This device speaks version ${ORCHESTRATION_VERSION} of placing ${FIN_WORD}s and the caller version ${input.version}. Update Mako on ${input.version > ORCHESTRATION_VERSION ? "this device" : "the caller's"}.` }
    const caller: ApexCaller = { kind: "apex", device: input.parent.device, thread: input.parent.thread, session: input.parent.session, ...(input.parent.conversation && { conversation: input.parent.conversation }), access: input.parent.access }
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    if (!input.op.startsWith(`start:${apex.session}:`)) return { refused: "conflict", why: "A stop names its Apex's own start: start:{its Apex's Session}:{its clientKey}." }
    store.cancelStart(input.op, this.now())
    const why = input.reason ?? `its ${APEX_WORD} stopped it`
    const under = this.starts.get(input.op)
    if (under) {
      this.cancelRecord(under)
      await under.answer.catch(() => undefined)
    }
    const edge = store.edges().byOp(input.op)
    if (!edge) {
      hostLog("agents", "start cancelled", { op: input.op, started: false })
      return { cancelled: true }
    }
    if (edge.parent !== apex.thread || edge.remote?.device !== caller.device) return { refused: "conflict", why: `That start made a ${FIN_WORD} here for another ${APEX_WORD}.` }
    await this.end(edge, why)
    hostLog("agents", "start cancelled", { op: input.op, child: edge.child, started: true })
    return { cancelled: true, fin: this.placedAnswer(store.edges().of(edge.child) ?? edge, true) }
  }

  /**
   * `mako:agents-notice`: a report of a Fin this device placed elsewhere, from the Fin's device. It's kept once by its
   * report's ID, so a repeat is the same notice; one from an owner older than the newest heard is refused
   * (`stale-owner`); and it wakes its Apex through the same digest as a Fin's here (`noticeOf`).
   */
  async notice(input: AgentsNoticeInput): Promise<AgentsNoticed> {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: `${FIN_WORD}s need the Thread store, which didn't open on this device.` }
    // A Fin that reports at once can outrun its own start's answer: the notice waits for that start to settle here.
    // One whose start's answer never came (lost on the way, or this host died with it under way) is this device's
    // word that the Fin is there: its start is asked again now, under its op, and answers that Fin.
    if (!store.edges().of(input.child)) {
      // Its Apex stopped that start: its device plainly answers now, so the stop goes, and the Fin is kept as stopped.
      if (this.queuedAway(input.op)?.away?.stop) await this.cancelAway(input.op)
      else if (!this.starts.has(input.op) && store.queuedSpawns().some((spawn) => spawn.away && spawn.op === input.op)) await this.askRooms()
      await this.starts.get(input.op)?.answer.catch(() => undefined)
    }
    const edge = store.edges().of(input.child)
    if (!edge?.placed || edge.parent !== input.parent.thread)
      return { refused: "unknown-child", why: `This device placed no ${FIN_WORD} with that Thread under that ${APEX_WORD}: its start's answer may not have reached it yet.` }
    const report = ReportSchema.safeParse(input.report)
    if (!report.success || report.data.child !== edge.child || input.id !== `notice:${edge.child}:${report.data.id}`)
      return { refused: "conflict", why: "A notice is notice:{child}:{reportId}, carrying that report of that child." }
    const kept = this.keepReport(edge, report.data)
    if ("refused" in kept) return kept
    // How it stands is its device's word as it sent this, never the report's: an earlier turn's report ends no later turn.
    this.standingHeard(edge.child, input.standing)
    hostLog("agents", "notice taken", { notice: input.id, child: edge.child, status: report.data.status, ownerGeneration: report.data.ownerGeneration, ...(kept.deduped && { deduped: true }) })
    // A Fin there reported, so its place may have room now: what waits for it asks.
    if (!kept.deduped) void this.askRooms()
    return { heard: true, ...(kept.deduped && { deduped: true as const }) }
  }

  /**
   * This device is back on its account (its link opened, or its host started): each place holding Fins it placed is
   * asked once how they stand, which is kept (`listAway`) and also tells that place this device hears again, so the
   * notices it kept go now. The stops this device kept for places it couldn't reach go too.
   */
  knock(): void {
    const store = this.store()
    if (!store || !this.places || this.stopped) return
    this.retryStops()
    void this.reconcilePlaced(store.edges().all.filter((edge) => edge.placed))
  }

  // ── Starting ──

  /**
   * Starts a Fin for its record: its name, taken now beside every other record's of its Apex and every written edge,
   * is the record's until the record settles, so two launching side by side never take one.
   */
  private async launch(op: string, queued: QueuedStart, start: StartRecord): Promise<AgentsStartResult> {
    if (queued.away) return this.launchAway(op, queued, start)
    const store = this.store()!
    const { lead: apex, input, tier, harness } = queued
    const began = performance.now()
    const others = [...this.starts.values()].flatMap((other) => (other !== start && other.thread === apex.thread && other.name ? [other.name] : []))
    const name = uniqueName(input.name ?? input.title ?? input.brief.objective, new Set([...store.edges().children(apex.thread).map((edge) => edge.name), ...others]))
    start.name = name
    const cwd = input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined)
    if (!cwd) return this.refuse(op, "unavailable", "There's no folder to start it in: name one, or start it from a Thread that has one.")
    const conversationId = namedUuid(op)
    const parent: ChildStart = {
      parent: ThreadIdSchema.parse(apex.thread),
      parentSession: SessionIdSchema.parse(apex.session),
      name,
      role: input.role ?? "worker",
      origin: "started",
      ...(apex.source && { source: apex.source }),
      asked: {
        brief: input.brief,
        harness,
        ...(input.model && { model: input.model }),
        ...(input.reasoning && { reasoning: input.reasoning }),
        ...(input.fast !== undefined && { fast: input.fast }),
        ...(input.rule !== undefined && { rule: input.rule }),
        access: tier,
        ...(input.place && { place: input.place }),
        ...(input.workspace && { workspace: input.workspace }),
        ...(input.mode && { mode: input.mode }),
        ...(input.wake && { wake: input.wake }),
      },
      op,
      startedBy: { kind: "agent", session: SessionIdSchema.parse(apex.session) },
      // Its Apex is on another device: its notices go to that device's runtime, never to a conversation here.
      ...(apex.away && { remote: { device: apex.away.device, ...(apex.away.conversation && { conversation: apex.away.conversation }), access: apex.away.access } }),
    }
    const decided = queued.tuned ?? await this.tuningOf(apex, harness, input)
    if ("refused" in decided) return this.refuse(op, "unknown-model", decided.refused)
    parent.tuned = { source: decided.source, ...(decided.note && { note: decided.note }), ...(decided.rerouted && { rerouted: decided.rerouted }), ...(decided.rule && { rule: decided.rule }) }
    const tuning = decided.settings
    const workspace = input.workspace
    const attached = this.threadRefs(apex, input.context)
    if ("refused" in attached) return this.refuse(op, attached.refused, attached.why)
    const options: LiveStartOptions = {
      conversationId,
      ...(decided.rerouted?.to?.why === "account" && { account: decided.rerouted.to.account }),
      // An Apex of its own starts Fins too: it reads the person's rules with its brief.
      initialRequest: { id: namedUuid(`${op}\nbrief`), ...await this.withContext([briefText(input.brief, name), ...(input.role === APEX_ROLE ? [this.policyLines().join("\n")] : [])].filter(Boolean).join("\n\n"), attached), attachments: [] },
      title: input.title ?? name,
      modeId: childMode(this.deps.modes(harness), tier)?.id ?? accessModeId(tier),
      ...(tuning && { tuning }),
      ...(workspace && {
        worktree: true,
        ...(workspace.branch ? { worktreeStart: { kind: "branch" as const, branch: workspace.branch } } : workspace.base ? { worktreeStart: { kind: "from" as const, ref: workspace.base } } : {}),
      }),
      parent,
    }
    if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
    this.starting.add(op)
    this.forget(apex.thread)
    try {
      if (apex.source) {
        if (!apex.sourceRoot || !this.deps.verifySource || await this.deps.verifySource(apex.sourceRoot, apex.source) !== cwd)
          throw new Error("The Fin's committed source is no longer prepared.")
        if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
      }
      await this.deps.startLive(harness, cwd, options)
    } catch (error) {
      if (!store.edges().byOp(op)) {
        this.starting.delete(op)
        this.forget(apex.thread)
        if (start.cancelled) return this.refuse(op, "conflict", `Its ${APEX_WORD} stopped it before it started.`)
        return this.refuse(op, "unavailable", `It didn't start: ${errorMessage({ error })}`)
      }
      hostWarn("agents", "a Fin's start failed after its edge was written; it shows as failed", { op, error: errorMessage({ error }) })
    } finally {
      this.starting.delete(op)
    }
    const edge = store.edges().byOp(op)
    if (!edge) return this.refuse(op, "unavailable", `Its Thread was made without its edge; it was not started as a ${FIN_WORD}.`)
    // Stopped while its edge was being written: it ends now, as a stop would have.
    if (start.cancelled) {
      await this.end(edge, `its ${APEX_WORD} stopped it before it started`)
      return this.started(edge, apex, false)
    }
    this.conversations.set(edge.child, conversationId)
    this.childOf.set(conversationId, edge.child)
    hostLog("agents", "start admitted", { op, child: edge.child, harness, access: tier, ms: Math.round(performance.now() - began) })
    this.childMoved(edge, false)
    return this.started(edge, apex, false)
  }

  /**
   * What a Fin runs on (`resolveFinTuning`): what the spawn named, held to its
   * harness's catalog, else what the person uses there. The Apex's own model
   * counts only on the Apex's harness. Its folder doesn't change the catalog,
   * so the Apex's is read.
   */
  private async tuningOf(apex: Apex, harness: string, input: Pick<AgentsStartInput, "cwd" | "model" | "reasoning" | "fast">, ruled?: Ruled): Promise<Tuned | { refused: string }> {
    const cwd = input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined)
    const choices: FinChoices = (cwd && await this.deps.finChoices?.(harness, cwd).catch((error) => {
      hostWarn("agents", "a Fin's catalog couldn't be read; its choice isn't held to it", { harness, error: errorMessage({ error }) })
      return undefined
    })) || { models: [] }
    const apexSettings = apex.conversation && this.deps.live.session(apex.conversation)?.harness === harness ? this.settingsOf(apex.conversation) : undefined
    const decided = resolveFinTuning({
      label: this.deps.harnessLabel(harness),
      models: choices.models,
      asked: { ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }), ...(input.fast !== undefined && { fast: input.fast }) },
      // A rule's model is for its own harness: one named instead, or a harness at its limit, runs on its own choices.
      ...(ruled?.target.settings && ruled.target.harness === harness && { rule: { who: ruled.who, settings: ruled.target.settings } }),
      ...(choices.chosen && { chosen: choices.chosen }),
      ...(apexSettings && { apex: apexSettings }),
      ...(choices.used && { used: choices.used }),
      ...(choices.recommended && { recommended: choices.recommended }),
    })
    if ("refused" in decided) return decided
    const note = decided.notes.join(" ")
    hostLog("agents", "a Fin's model decided", { harness, source: decided.source, ...(decided.settings?.model && { model: decided.settings.model }), ...(note && { passedOver: true }) })
    return { ...(decided.settings && { settings: decided.settings }), source: decided.source, ...(note && { note }) }
  }

  /**
   * Where a Fin can run when `asked`'s account is at its limit: a start that named no harness or model goes to the
   * person's next harness (`harnessOrder`) that runs here at this access, is signed in and has room, and says so; one
   * that named it, or with nowhere to go, is refused with when the limit resets and what the person can do instead.
   * A limit that can't be read in `LIMIT_READ_MS` reads as room.
   */
  private async roomFor(apex: Apex, asked: string, tier: AccessTier, input: AgentsStartInput): Promise<{ harness: string; rerouted?: { note: string; on: NonNullable<Tuned["rerouted"]> } } | { refused: string }> {
    const limit = await this.limitOf(asked)
    if (!limit) return { harness: asked }
    const label = this.deps.harnessLabel(asked)
    const until = limit.until ?? undefined
    const spent = this.spentWords(asked, limit)
    const switchTo = limit.instead ? `${limit.instead}, another ${label} account, has room: the person can switch to it in Settings › Agents.` : ""
    const next = await this.nextHarness(asked, tier, input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined))
    if (input.harness !== undefined || input.model !== undefined || !next) {
      const elsewhere = next ? `Leave harness and model out to start it on ${this.deps.harnessLabel(next)}, the person's next harness, or name another.` : "No other harness here has room either."
      return { refused: [`${spent}, so a ${FIN_WORD} there would stop at once.`, switchTo, elsewhere, until === undefined ? "" : "Or wait for the reset and start it then."].filter(Boolean).join(" ") }
    }
    hostLog("agents", "a Fin's harness is at its limit; it starts on the next", { from: asked, to: next, ...(until !== undefined && { until }) })
    return {
      harness: next,
      rerouted: {
        note: [`${spent}, so it runs on ${this.deps.harnessLabel(next)}, the person's next harness.`, switchTo].filter(Boolean).join(" "),
        on: { from: asked, ...(until !== undefined && { until }), ...(limit.instead && { instead: limit.instead }) },
      },
    }
  }

  /**
   * Where a Fin starts when `asked`'s account in use is at its limit and the person's switch is on: the first step of
   * its fallback order with room (`FinMoves.order`): another account of `asked`, which keeps its harness and model; a
   * connection's model on it; or the person's next harness. It applies whether or not the start named the harness; a
   * start that named a model keeps the refusal, saying when the limit resets.
   */
  private async placeFor(apex: Apex, asked: string, tier: AccessTier, input: AgentsStartInput): Promise<{ harness: string; step?: FallbackStep; rerouted?: { note: string; on: FinRerouted } } | { refused: string }> {
    const moves = this.moves!
    const accounts = await moves.accounts(asked)
    const from = accounts.find((account) => account.active) ?? (accounts.length === 1 ? accounts[0] : undefined)
    // A harness Mako lists no accounts for is read as it was before.
    const limit = from ? undefined : await this.limitOf(asked)
    const spent = from?.spent ?? (limit && { until: limit.until })
    if (!spent) return { harness: asked }
    const account = from?.label ?? limit?.account
    const label = this.deps.harnessLabel(asked)
    const until = spent.until ?? undefined
    const now = this.now()
    const words = `${label} is at its limit${account ? ` on ${account}` : ""}${until === undefined ? "" : ` until ${resetWords(until, now)}`}`
    const cwd = input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined)
    const { steps } = input.model === undefined
      ? await moves.order({ from: { harness: asked, ...(from && { account: from.name }) }, when: "start", tier, ...(cwd && { cwd }), accounts })
      : { steps: [] }
    const step = steps[0]
    if (!step) {
      const reset = until === undefined ? "" : " Or wait for the reset and start it then."
      return { refused: input.model !== undefined
        ? `${words}, so a ${FIN_WORD} there would stop at once. Leave model out to start it on the person's next account or harness with room.${reset}`
        : `${words}, so a ${FIN_WORD} there would stop at once, and none of the person's other accounts, connections or harnesses here has room.${reset}` }
    }
    const move: FinMove = { step, from: { harness: asked, ...(account && { account }) }, ...(until !== undefined && { until }) }
    const line = movedLine(move, (harness) => this.deps.harnessLabel(harness), now)
    hostLog("agents", "a Fin's account is at its limit; it starts on the next step", { from: asked, why: step.why, to: step.harness, ...(until !== undefined && { until }) })
    // Its row and the start's answer say the move (`moved`), so its note doesn't say it twice.
    return { harness: step.harness, step, rerouted: { note: "", on: { from: asked, ...(until !== undefined && { until }), ...(account && { account }), to: step, line } } }
  }

  /**
   * Where a Fin asked on `allowed` runs when `asked` offers no mode at or below
   * it, as Cursor offers only full: a start that named no harness, model or
   * rule goes to the person's next harness that offers `allowed`; otherwise,
   * or with none, it runs on `asked`'s least mode above `allowed` within its
   * Apex's own access (`modeWithin`). The start's note says which. Refused
   * only when every mode of the harness is wider than the Apex's own.
   */
  private async fitAccess(apex: Apex, asked: string, allowed: AccessTier, own: AccessTier, input: Pick<AgentsStartInput, "cwd" | "harness" | "model">, ruled: Ruled | undefined): Promise<{ harness: string; tier: AccessTier; note?: string } | { refused: string }> {
    const modes = this.deps.modes(asked)
    if (childMode(modes, allowed)) return { harness: asked, tier: allowed }
    const label = this.deps.harnessLabel(asked)
    const offers = offered(modes)
    if (input.harness === undefined && input.model === undefined && !ruled) {
      const next = await this.nextHarness(asked, allowed, input.cwd ?? (apex.conversation ? this.deps.live.session(apex.conversation)?.cwd : undefined))
      if (next) {
        hostLog("agents", "a Fin's harness runs above its access; it starts on the next", { from: asked, to: next, access: allowed })
        return { harness: next, tier: allowed, note: `${label} runs only on ${offers}, above the ${allowed} it was asked on, so it runs on ${this.deps.harnessLabel(next)}, the person's next harness, on ${allowed}.` }
      }
    }
    const wider = modeWithin(modes, allowed, own)
    if (wider) {
      hostLog("agents", "a Fin's harness runs above its access; it runs on the harness's nearest", { harness: asked, asked: allowed, access: wider.tier })
      return { harness: asked, tier: wider.tier, note: `${label} runs only on ${offers}, so it runs on ${wider.tier} rather than the ${allowed} it was asked on, within this Thread's own ${own}.` }
    }
    return { refused: `${label} runs on ${offers}, each above ${allowed} and above this Thread's own ${own}, so a ${FIN_WORD} there would have more access than you. Name a harness that runs on ${allowed}, or leave harness out for the person's next one.` }
  }

  /** The first harness after `from` in the person's order that a Fin at `tier` can run on now. */
  private async nextHarness(from: string, tier: AccessTier, cwd: string | undefined): Promise<string | undefined> {
    const live = this.deps.harnesses()
    const order = (await this.deps.harnessOrder?.().catch(() => undefined)) ?? live
    for (const harness of [...order, ...live]) {
      if (harness === from || !live.includes(harness) || !childMode(this.deps.modes(harness), tier)) continue
      const signedIn = cwd ? ((await this.deps.finChoices?.(harness, cwd).catch(() => undefined))?.models.length ?? 0) > 0 : true
      if (signedIn && !(await this.limitOf(harness))) return harness
    }
    return undefined
  }

  private async limitOf(harness: string): Promise<HarnessLimit | undefined> {
    if (!this.deps.limited) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), LIMIT_READ_MS) })
    try {
      return await Promise.race([this.deps.limited(harness).catch((error) => {
        hostWarn("agents", "a harness's limit couldn't be read; it's taken as having room", { harness, error: errorMessage({ error }) })
        return undefined
      }), late])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The model a conversation runs on now: the person's last choice in it, else what its harness reported, else what it started with. */
  private settingsOf(conversation: string): SessionSettings | undefined {
    const snapshot = this.deps.live.snapshot(conversation)
    return snapshot ? settingsIn(snapshot) : undefined
  }

  /**
   * Starts what waits, oldest first: each once the Fins it starts after finished, while its tree's budget and the
   * person's limit have room. One a Fin it was to start after didn't finish for is its Apex's to decide (`tellHeld`).
   */
  private async drain(): Promise<void> {
    const store = this.store()
    // Nothing waiting goes until the places the last host left are counted (`resume`).
    if (!store || this.stopped || !this.starts.isRecovered) return
    // An end during a drain is looked at by another, after it: a Fin that was to start after it doesn't wait for the watch.
    if (this.draining) return void (this.drainAgain = true)
    this.draining = true
    try {
      // A cut turn whose time came has waited longest for a place: it goes ahead of what's queued, if there's room yet.
      if (this.wakingForRoom.size) {
        this.wakingForRoom.clear()
        this.deps.live.wakeDue()
      }
      // Each place's own room: a device's count, or the cloud's plan and spend.
      // Counted once as the drain begins, plus what it starts: a Fin it launched isn't counted again as it comes up.
      const filled = new Map<string, number>()
      const working = new Map<string, number>()
      let totalStarted = 0
      const everywhere = this.workingEverywhere()
      for (const spawn of store.queuedSpawns()) {
        if (this.starts.has(spawn.op)) continue
        // Its Fin started, and a host that died before taking it off the queue left it: it holds no place, and whether
        // this build can read the row, there's nothing to say of it. Its edge is the start.
        if (store.edges().byOp(spawn.op)) {
          this.changeQueue((held) => held.unqueueSpawn(spawn.op))
          continue
        }
        const queued = parseQueued(spawn.record)
        if (!queued) {
          this.tellUnreadable(spawn.op, spawn.record)
          continue
        }
        if (queued.refused) {
          this.tellHeld(spawn.op, queued, { refused: queued.refused })
          continue
        }
        // Its Apex stopped it, and the stop waits for its place to answer (`cancelAway`): it never starts.
        if (queued.away?.stop) continue
        // A stopped Fin's own Fins wait for it to resume (`reopen`): a stop doesn't go on starting work under it.
        if (this.apexStopped(queued.lead.thread)) continue
        if (queued.after?.length) {
          const stand = this.afterStand(queued)
          if (stand.held) this.tellHeld(spawn.op, queued, stand.held)
          if (stand.held || stand.pending.length) continue
        }
        const counts = this.treeCounts(spawn.tree)
        if (counts.running >= this.budget.running) continue
        // First come, first started: once a place is full, a later spawn of another tree doesn't go ahead of this one there.
        const where = placeOf(queued.input.place)
        const started = filled.get(where) ?? 0
        if (!working.has(where)) working.set(where, this.working(where))
        // Another device's room is its own word: one not asked since this host started waits until it is (`askRooms`).
        if (queued.away && queued.away.target.kind !== "cloud" && !this.places?.room(where)) continue
        if (this.overCeiling(everywhere + totalStarted) ?? this.awayFull(where, started) ?? (queued.away ? undefined : placeFull(this.placeLimit(where), working.get(where)! + started))) continue
        totalStarted += 1
        filled.set(where, started + 1)
        hostLog("agents", "start released", { op: spawn.op, waitedMs: this.now() - spawn.at, ...(queued.after?.length && { after: queued.after.map((ref) => ref.name).join(" ") }) })
        // Each starts on its own record: one whose harness is slow to come up holds its place, never the queue behind it.
        const start = this.record(spawn.op, queued.lead.thread, queued.input.name ?? queued.input.title)
        start.launching = { where, tree: spawn.tree }
        start.answer = this.launch(spawn.op, queued, start)
        void start.answer
          .then((answer) => ("refused" in answer ? (queued.away && (answer.refused === "budget" || this.lostPlacings.delete(spawn.op)) ? FILLED : answer.why) : undefined), (error: Error) => `It didn't start: ${errorMessage({ error })}`)
          .then((refused) => {
            // A host shutting down leaves the row as it stands: the next host takes it from the store.
            if (this.stopped) return void this.retire(start)
            // Its place filled between that device's word and its start there, or that device didn't answer: it waits on
            // as it was, until that device says it has room.
            if (refused === FILLED) return void this.retire(start)
            // Stopped with its start on its way: its row is the stop's now, and goes with its place's answer.
            if (this.queuedAway(spawn.op)?.away?.stop) return void this.retire(start)
            // One its Apex stopped is gone; one that couldn't start stays, saying why, until its Apex has heard (`tellHeld`).
            if (refused && !start.cancelled && store.queuedSpawns().some((each) => each.op === spawn.op)) {
              hostWarn("agents", "a queued start couldn't start; its Apex is told", { op: spawn.op, why: refused })
              this.changeQueue((held) => held.keepQueuedSpawn(spawn.op, JSON.stringify({ ...queued, refused: refused.slice(0, 2000) } satisfies QueuedStart)))
            } else this.changeQueue((held) => held.unqueueSpawn(spawn.op))
            // Its Apex hears it start or say why it couldn't; those still held moved up the line, their places, not their kind.
            // Its row is settled first, so the drain its place wakes sees it as it now stands.
            this.retire(start)
          })
      }
    } catch (error) {
      hostWarn("agents", "queued starts could not be released; they wait for the next end", { error: errorMessage({ error }) })
    } finally {
      this.draining = false
      this.queueRefresh()
      if (this.drainAgain) {
        this.drainAgain = false
        void this.drain()
      }
    }
  }

  private started(edge: ThreadParent, apex: Apex, deduped: boolean): AgentsStarted {
    const state = this.stateOf(edge)
    const counts = this.treeCounts(this.rootOf(apex.thread))
    const conversation = this.conversationOf(edge.child)
    const reading = this.childReading(edge)
    const runsOn = reading.runsOn ? finTuningLine(reading.runsOn) : reading.model
    return {
      child: edge.child,
      name: edge.name,
      ...(conversation && { conversation }),
      state: state.kind,
      ...(runsOn && { runsOn }),
      ...(edge.tuned?.note && { note: edge.tuned.note }),
      ...(edge.tuned?.rule && { rule: ruleWords(edge.tuned.rule) }),
      ...(edge.tuned?.rerouted && { limited: { harness: edge.tuned.rerouted.from, ...(edge.tuned.rerouted.until !== undefined && { until: edge.tuned.rerouted.until }), ...(edge.tuned.rerouted.instead && { instead: edge.tuned.rerouted.instead }) } }),
      ...(edge.tuned?.rerouted?.line && { moved: edge.tuned.rerouted.line }),
      tree: this.treeAnswer(counts),
      ...this.placeWords(),
      ...(edge.placed && edge.asked.place && { place: edge.asked.place }),
      ...(deduped && { deduped: true as const }),
      next: afterStart(edge.asked.wake ?? "decisions"),
    }
  }

  /** This device's limit as it stands, and its load while it's busy, as every start's answer carries them. */
  private placeWords(): Pick<AgentsStarted, "atOnce" | "mac"> {
    const limit = this.placeLimit(HERE)
    return {
      ...(limit.place === "device" && { atOnce: { working: this.working(HERE), of: limit.atOnce } }),
      ...this.mac?.busy && { mac: `This Mac is busy (${this.mac.why}): it starts anyway, so run builds and test suites one at a time.` },
    }
  }

  private queuedAnswer(op: string, apex: Apex, deduped: boolean): AgentsStarted {
    const store = this.store()!
    const tree = this.rootOf(apex.thread)
    const queue = store.queuedSpawns().filter((spawn) => spawn.tree === tree)
    const queued = parseQueued(queue.find((spawn) => spawn.op === op)?.record ?? "")
    const counts = this.treeCounts(tree)
    const forRoom = queued?.why === "place-full"
    const where = placeOf(queued?.input.place)
    const forTheLimit = store.queuedSpawns().filter((spawn) => { const other = parseQueued(spawn.record); return other?.why === "place-full" && placeOf(other.input.place) === where })
    const ahead = Math.max(0, (forRoom ? forTheLimit : queue).findIndex((spawn) => spawn.op === op))
    const stand = queued?.after?.length ? this.afterStand(queued) : undefined
    const pending = stand?.pending ?? []
    return {
      name: queued?.input.name ?? queued?.input.title ?? "queued",
      state: "queued",
      why: stand?.held
        ? `It won't start: ${stand.held.name} ${stand.held.outcome === "stopped" ? "was stopped" : "failed"}, and you're told to decide.`
        : pending.length
          ? `It starts once ${pending.join(", ")} ${pending.length === 1 ? "finishes" : "finish"}; if one fails or is stopped it doesn't start, and you're woken to decide.`
          : forRoom
            ? `${upper(this.full(where) ?? "A place is free now")}; it starts when one ends (${ahead} ahead).`
            : queued?.away && !queued.why
              ? `${placeName(queued.away.target)} hasn't answered its start yet: it's asked again under the same key once it does, and never started twice.`
              : `This tree runs ${counts.running} of its ${this.budget.running} at once; it starts when one ends (${ahead} ahead).`,
      ...(pending.length && { after: pending }),
      tree: this.treeAnswer(counts),
      ...this.placeWords(),
      ...(deduped && { deduped: true as const }),
      next: afterStart(queued?.input.wake ?? "decisions"),
    }
  }

  // ── A wait ──

  /**
   * Holds a `wait` start's answer for at most `window` ms: until its Fin's
   * result, a question it asks, or the window's or the Apex's turn's end.
   * While it holds, the Fin's reports answer it instead of waking the Apex,
   * and once it lets go they wake the Apex (`reportRoute`), the result
   * settled-only. A repeat of the start answers the result again.
   */
  private hold(child: string, window: number): Promise<StartWaited> {
    const now = this.outcomeOf(child)
    if (now || window <= 0) return Promise.resolve(this.answered(child, now ?? { outcome: "pending" }))
    const edge = this.store()!.edges().of(child)
    const apex = edge && (this.conversationOfSession(edge.parentSession) ?? this.conversationOf(edge.parent))
    return new Promise((resolve) => {
      const done = (outcome: StartWaited) => {
        clearTimeout(timer)
        this.holds.delete(hold)
        resolve(this.answered(child, outcome))
      }
      const hold: Hold = {
        child,
        ...(apex && { apex }),
        check: () => {
          const outcome = this.outcomeOf(child)
          if (outcome) done(outcome)
        },
        end: () => done({ outcome: "pending" }),
      }
      const timer = setTimeout(() => hold.end(), window)
      this.holds.add(hold)
    })
  }

  /** Where a waited-for Fin stands: its result, a question it waits on, or nothing yet. */
  private outcomeOf(child: string): StartWaited | undefined {
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge) return { outcome: "result", report: { status: "failed", summary: "Its Thread is gone from this device." } }
    const last = store.reportsOf(child, 0).filter((report) => report.status !== "progress").at(-1)
    if (last && (last.status === "done" || last.status === "failed")) return { outcome: "result", report: waitedReport(last) }
    const state = this.stateOf(edge)
    if (state.kind === "blocked") {
      const asking = last && (last.status === "blocked" || last.status === "needs-input") ? waitedReport(last) : undefined
      return { outcome: "question", question: state.question, answers: state.on === "lead" ? "you" : "the person", ...(asking && { report: asking }) }
    }
    // A turn's end writes its report just after it shows as ended; only a closed delegation ends without one.
    if (state.kind === "ended" && edgeStopped(edge)) return { outcome: "result", report: { status: "failed", summary: `It was stopped${state.reason ? `: ${state.reason}` : "."}` } }
    return undefined
  }

  /** A wait's answer carried the report: the Apex heard it, so a wake waiting with it is taken back. */
  private answered(child: string, outcome: StartWaited): StartWaited {
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge || outcome.outcome === "pending") return outcome
    const report = store.reportsOf(child, 0).filter((candidate) => candidate.status !== "progress").at(-1)
    if (!report || (outcome.outcome === "question" && !outcome.report)) return outcome
    const conversation = this.frontOf(edge.parent, edge.parentSession)
    if (conversation) this.wakes.withdraw(conversation, `notice:${child}:${report.id}`)
    store.markReportsDelivered([report.id], this.now())
    return outcome
  }

  private refuse(op: string, refused: AgentRefused["refused"], why: string): AgentRefused {
    hostLog("agents", "start refused", { op, refused, why })
    return { refused, why }
  }

  // ── Ends and reports ──

  /** A Fin's turn ended: its end, once, as its last report, unless it reported since the turn began or it goes on elsewhere. */
  private turnEnded(edge: ThreadParent, conversation: string, request: string): void {
    const reply = this.deps.live.turnReply(conversation, request)
    const ended = reply?.request
    if (!ended || (ended.status !== "completed" && ended.status !== "failed" && ended.status !== "interrupted")) return
    // A turn cut short continues, by Mako's continuation or the next host's (`LeftTurn.always`), or its Apex hears it didn't.
    if (ended.signIn) {
      this.stopAwaiting(edge.child)
      return this.childMoved(edge, false)
    }
    if (ended.status === "interrupted" && ended.interruption?.reason !== "stopped") return this.watchCut(conversation)
    if (this.limitMove(edge, conversation, ended, reply)) return
    if (this.deps.live.snapshot(conversation)?.requests.some(request => request.status === "held" && request.retry?.cause === "rate-limited" && request.continues?.auto && request.continues.requestId === ended.id)) {
      this.stopAwaiting(edge.child)
      return this.childMoved(edge, false)
    }
    if (ended.status === "completed" && this.store()!.finTurn(edge.child)) this.store()!.clearFinTurn(edge.child)
    this.turnReported(edge, conversation, request, ended, reply)
  }

  /** The end of a Fin's turn as its report: what `turnEnded` writes once nothing more goes on in it. */
  private turnReported(edge: ThreadParent, conversation: string, request: string, ended: LiveRequest, reply: TurnReply): void {
    const store = this.store()!
    // What it said this turn stands, unless its last word was progress on nothing that will wake it: then the turn's end
    // is said, and its Apex hears it. A Fin that said "ready for your review" as progress and ended its turn woke nobody
    // (loop-holds on #810, 2026-11-15).
    const said = store.reportsOf(edge.child, (ended.createdAt ?? 0) - 1).filter((report) => !report.implicit).at(-1)
    // A result or a question said this turn stands. So does progress on what will wake it.
    if (said && !(ended.status === "completed" && this.progressLeftUnwatched(said, conversation))) return this.childMoved(edge, false)
    const waits = ended.status === "completed" ? this.waitsOn(edge, conversation) : undefined
    if (waits) {
      const work = this.heldWork(conversation)
      this.awaiting.set(edge.child, { conversation, request, ...(work && { work }) })
      // Work nothing says the end of is believed for `HELD_WORK_CEILING_MS`: past it, its end is looked at again.
      this.ceilings.get(edge.child)?.()
      this.ceilings.delete(edge.child)
      if (work) this.ceilings.set(edge.child, this.later(HELD_WORK_CEILING_MS + 1_000, () => {
        this.ceilings.delete(edge.child)
        const now = this.store()?.edges().of(edge.child)
        if (now && this.awaiting.get(edge.child)?.request === request) this.checkAwaiting(now)
      }))
      hostLog("agents", "turn ended waiting", { op: edge.op, child: edge.child, on: waits })
      return this.childMoved(edge, false)
    }
    this.stopAwaiting(edge.child)
    // Its word on where it stands: what it said this turn, else, for a turn Mako's own note started (a pull request's
    // outcome, a wait that fired), the progress it said before that and hasn't followed with a result. fin-models, woken
    // by #868's failed check, pushed a fix and ended its turn saying it would report when CI settled (2026-11-16): the
    // wait had fired, nothing watched the new run, and its end was written "done".
    const latest = store.reportsOf(edge.child).at(-1)
    const woken = ended.actor?.kind === "service"
    const word = said ?? (woken && latest && !latest.implicit && latest.status === "progress" ? latest : undefined)
    const text = reply.text.trim() || (said && ended.status === "completed" ? said.summary.trim() : "")
    if (ended.status === "completed" && ended.notification) return this.childMoved(edge, false)
    // A Fin whose word is progress hasn't said it's done, and nothing it waits on will wake it: its turn ended without a
    // result, and it reads so wherever it's listed, never "done". Its Apex hears so at once, with its last words, and
    // sends it on or takes the reply; nobody is asked, so nothing reaches the person's Inbox. A turn that said nothing at all, over progress from before it, stays a failure,
    // as below: it answered nothing.
    if (ended.status === "completed" && word?.status === "progress" && (said || reply.text.trim())) {
      return void this.keepReport(edge, {
        id: `report:${edge.child}:${request}`,
        child: ThreadIdSchema.parse(edge.child),
        status: "failed",
        unfinished: true,
        summary: unfinishedSummary(text || word.summary),
        ...(word.artifacts?.length && { artifacts: word.artifacts }),
        implicit: true,
        ownerGeneration: this.generation,
        at: this.now(),
      })
    }
    const done = ended.status === "completed" && text.length > 0
    this.keepReport(edge, {
      id: `report:${edge.child}:${request}`,
      child: ThreadIdSchema.parse(edge.child),
      status: done ? "done" : "failed",
      summary: (ended.error || text || (ended.status === "completed" ? "Its turn ended without reporting a result." : "Its turn ended before it finished.")).slice(0, 16_000),
      // What its progress said it waits on that nothing here watches (the person, other words) is why it stopped.
      ...(said?.waitingOn?.length && { waitingOn: said.waitingOn }),
      ...(said?.artifacts?.length && { artifacts: said.artifacts }),
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    })
  }

  /**
   * Whether a report made in a turn leaves its end unheard: progress that hands nothing on and names no wait something
   * will end. A pull request the watch reads, a wait the turn armed (`turn_waits`) or a Fin of its own at work wakes it
   * again, so that progress stays quiet; a wait on the person or in other words wakes nothing, so its Apex hears it.
   */
  private progressLeftUnwatched(report: Report, conversation: string): boolean {
    // One that handed work on or first named a wait on someone else woke its Apex already: its turn's end says nothing new.
    if (report.status !== "progress" || report.handoff || report.awaits) return false
    // Nor does one naming again, in other words or later, a wait on someone else that an earlier progress since the last
    // result or question woke its Apex for (`awaits`), when it names nothing new.
    const reports = this.store()!.reportsOf(report.child)
    let from = reports.length
    while (from > 0 && reports[from - 1]!.status === "progress") from -= 1
    const since = reports.slice(from)
    if (since.some((each) => each.awaits) && othersOnly(since.filter((each) => each.id !== report.id).flatMap((each) => each.waitingOn ?? []), report.waitingOn)) return false
    if (this.deps.readPull && report.waitingOn?.some((item) => waitedPull(item) !== undefined)) return false
    return !this.store()!.armedTurnWaits().some((wait) => wait.conversation === conversation)
  }

  /**
   * The questions from its Apex (`agents_send`'s `expects: "answer"`) this Fin's harness took that it still owes an answer (`docs/delivery-queue.md`, rule 17),
   * oldest first, each with when it was taken and how many of the Fin's turns have ended since without answering it. A
   * reply owed opens only once its harness takes the message, as a turn or a steer, so a report from before can't
   * answer it; its brief, a `reply: none` message, an answer to the Fin's own question, and Mako's own words owe none. Any report
   * after it settles it but progress: progress only when it hands work on, waits on someone else, or names it in
   * `answers`. Only turns its model answered count (`completed`), so a turn a limit or a failure cut draws no reminder.
   * Read from the journal and the store, never kept, so a restart reads it the same.
   */
  private owedOf(edge: ThreadParent, conversation: string): { request: LiveRequest; at: number; turns: number }[] {
    const snapshot = this.deps.live.held(conversation) ?? this.deps.live.snapshot(conversation)
    const store = this.store()
    if (!snapshot || !store) return []
    const { requests } = snapshot
    const actions = snapshot.control?.actions ?? []
    const answers = store.answerRequests(edge.child)
    const reports = store.reportsOf(edge.child)
    const owed: { request: LiveRequest; at: number; turns: number }[] = []
    for (const request of requests) {
      // Only a question its Apex said it expects an answer to: a task's answer is its result, which has its own route.
      if (request.expects !== "answer" || request.actor?.kind !== "agent" || request.digest || request.continues || request.goal || answers.has(request.id) || isBrief(request.text)) continue
      if (store.sessionPlacement(request.actor.session)?.thread !== edge.parent) continue
      const taken = takenAs(request, requests, actions)
      if (!taken) continue
      if (answeredBy(reports, request.id, taken.at)) continue
      const turns = answeredTurns(requests, taken)
      owed.push({ request, at: taken.at, turns })
    }
    return owed
  }

  /**
   * How many of its Apex's questions a Fin still owes an answer past their reminder: its Apex was told, so its list
   * shows the Fin whatever changed (`needsApex`). Read from what its Apex was told, the digests in the Apex's own queue
   * (`Notice.unanswered`), and the Fin's reports in the store, so a Fin unloaded or hibernated since, as one that owes an
   * answer usually is, still counts, and no journal is read in.
   */
  private owesApex(edge: ThreadParent): number {
    const apex = this.frontOf(edge.parent, edge.parentSession)
    const requests = (apex ? this.deps.live.held(apex) : undefined)?.requests ?? []
    const told = new Map<string, number>()
    for (const request of requests)
      for (const notice of request.digest?.notices ?? [])
        if (notice.unanswered && notice.report.child === edge.child) told.set(notice.unanswered.request, notice.unanswered.at)
    if (!told.size) return 0
    const reports = this.reportsOf(edge.child).marks
    return [...told].filter(([request, at]) => !answeredBy(reports, request, at)).length
  }

  /**
   * A Fin's reminder, once, on the turn after the first of its turns that ended without answering a message its Apex
   * sent: by the request's ID, which `agents_report`'s `answers` takes when progress is its answer.
   */
  private owedReminder(conversation: string): string[] {
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (!edge || edge.closedAt) return []
    return this.owedOf(edge, conversation).filter((owed) => owed.turns === 1).map((owed) => {
      const line = noteLine(agentWords(owed.request.text)?.body ?? owed.request.text, 160)
      return `You haven't answered your ${APEX_WORD}'s message of ${new Date(owed.at).toISOString().slice(11, 16)} UTC (request ${owed.request.id}): "${line}". Answer it in this turn's report; when progress is your answer, agents_report with answers: ["${owed.request.id}"].`
    })
  }

  /**
   * After a Fin's turn ends: a message it still owes a reply after two of its turns (the second carried the reminder,
   * `frontDoor`) is said once to its Apex, in its digest, under its request's own notice ID, so the queue's receipt
   * (`carried`) keeps it once across a restart.
   */
  private owedAfterTurn(edge: ThreadParent, conversation: string): void {
    const apex = this.frontOf(edge.parent, edge.parentSession)
    if (!apex) return
    for (const owed of this.owedOf(edge, conversation)) {
      if (owed.turns !== 2) continue
      const words = agentWords(owed.request.text)
      const line = noteLine(words?.body ?? owed.request.text, 160)
      const report: Report = {
        id: `owed:${owed.request.id}`,
        child: ThreadIdSchema.parse(edge.child),
        status: "progress",
        summary: `It hasn't answered your message: "${line}"`,
        implicit: true,
        ownerGeneration: this.generation,
        at: this.now(),
      }
      this.wakes.notice(apex, this.rootOf(edge.parent), {
        id: `notice:owed:${owed.request.id}`, report, label: `"${edge.name}" (${this.deps.harnessLabel(this.harnessOf(edge))})`,
        fin: { name: edge.name, harness: this.harnessOf(edge) }, from: this.store()!.thread(edge.child)?.sessions[0] ?? edge.parentSession,
        unanswered: { request: owed.request.id, at: owed.at, turns: owed.turns, line },
      })
      hostLog("agents", "a reply owed went unanswered", { op: edge.op, request: owed.request.id, turns: owed.turns })
    }
  }

  /**
   * A Fin's request that waits out its account's usage limit (held with its `retry`: the continuation Mako made of a
   * turn the limit cut, or a message its harness refused) goes on at the next step of its order instead (`FinMoves`).
   * The limit is the harness's own word for it (`TurnReply.limit`), else the account's own reading. Once per wait,
   * never back to a place its logical turn ran on, across a restart too (`FinTurn`, claimed by this host's
   * generation). Only a Fin Mako drives moves, and never a turn the person sent in its Thread. True while a move for
   * the turn `ended` is under way: its report is the turn the move goes on with.
   */
  private limitMove(edge: ThreadParent, conversation: string, ended?: LiveRequest, reply?: TurnReply): boolean {
    const moves = this.moves
    if (!moves || !edge.asked.access || edge.closedAt !== undefined || (edge.run && !edge.run.ended)) return false
    const requests = this.deps.live.held(conversation)?.requests ?? []
    const wait = requests.find((request) => waitsOnLimit(request) && (ended ? request.continues?.requestId === ended.id : request.continues === undefined))
    // Whether Fins move on is the person's setting, read from its file: asked only of a Fin that waits on a limit, not
    // at every batch of every Fin.
    if (!wait || this.moving.has(wait.id) || !moves.on()) return false
    const origin = wait.continues ? requests.find((request) => request.id === wait.continues!.requestId) : wait
    if (!origin || origin.actor?.kind === "person") return false
    const harness = this.deps.live.session(conversation)?.harness
    const turn = harness && this.store()!.claimFinMove(edge.child, wait.id, this.generation, this.now())
    if (!turn) return false
    this.moving.add(wait.id)
    const limit = reply?.limit ?? (wait.continues ? this.deps.live.turnReply(conversation, wait.continues.requestId)?.limit : undefined)
    // A move that gives up leaves the turn's end as it was: its report, as `turnEnded` would have written it.
    const report = ended && reply ? () => this.turnReported(edge, conversation, ended.id, ended, reply) : () => {}
    const apex: Apex = { session: edge.parentSession, thread: edge.parent, ...(this.conversationOf(edge.parent) && { conversation: this.conversationOf(edge.parent)! }) }
    void this.moveOn({ thread: edge.child, edge, apex, tier: edge.asked.access }, conversation, harness, { limit, visited: turn.visited }, { wait, since: origin.createdAt }, report).finally(() => this.moving.delete(wait.id))
    return true
  }

  /**
   * An Apex at a limit with Fins open goes on as they do, whatever waits: its person's message, its Fins' digest or its
   * own cut turn. Nobody is there to press anything, and a tree whose Apex can't run hears nothing. Each waiting row keeps
   * its words, but for Mako's own continuation, which says the move; a Thread with no Fins is the person's to decide.
   */
  private apexLimit(conversation: string, ended?: string): void {
    const requests = this.deps.live.held(conversation)?.requests
    const store = this.store()
    if (!store || !requests) return
    const thread = store.journalPlacement(conversation)?.thread
    if (!thread || store.edges().of(thread)) return
    const wait = requests.find(waitsOnLimit)
    if (!wait) {
      if (ended && requests.find((request) => request.id === ended)?.status === "completed" && store.finTurn(thread)) store.clearFinTurn(thread)
      return
    }
    const session = this.deps.live.session(conversation)
    if (!this.moves?.on() || !session || this.moving.has(wait.id) || !store.edges().children(thread).some((edge) => !edgeStopped(edge))) return
    const placed = store.journalPlacement(conversation)
    const turn = placed && store.claimFinMove(thread, wait.id, this.generation, this.now())
    if (!turn) return
    this.moving.add(wait.id)
    const limit = wait.continues ? this.deps.live.turnReply(conversation, wait.continues.requestId)?.limit : undefined
    const tier = this.tierOfConversation(conversation) ?? "ask"
    void this.moveOn({ thread, apex: { session: placed.session, thread, conversation }, tier }, conversation, session.harness, { limit, visited: turn.visited }, { wait, since: wait.createdAt }, () => {}).finally(() => this.moving.delete(wait.id))
  }

  /**
   * What else of the tree stood on the account that ran out, with nothing running on it: it goes now, so the next message
   * to it finds room rather than a limit. A Fin at work meets the limit itself; one stopped stays stopped; each move
   * yields to a Stop and to a turn starting meanwhile. Once per Thread for an account's reset.
   */
  private moveIdle(root: string, harness: string, account: string | undefined, until: number | undefined): void {
    const store = this.store()
    if (!store || !this.moves?.on()) return
    const claimed = `tree:${harness}:${account ?? ""}:${until ?? ""}`
    const go = (mover: Mover, conversation: string) => {
      if (this.deps.live.session(conversation)?.harness !== harness || this.inTurn(conversation) || this.moving.has(`${conversation}:${claimed}`)) return
      const turn = store.claimFinMove(mover.thread, claimed, this.generation, this.now())
      if (!turn) return
      this.moving.add(`${conversation}:${claimed}`)
      void this.moveOn(mover, conversation, harness, { limit: undefined, visited: turn.visited }, undefined, () => {}, account).finally(() => this.moving.delete(`${conversation}:${claimed}`))
    }
    const visit = (thread: string, depth: number) => {
      for (const edge of store.edges().children(thread)) {
        if (depth < 64) visit(edge.child, depth + 1)
        const conversation = this.conversationOf(edge.child)
        if (!conversation || !edge.asked.access || edge.closedAt !== undefined || (edge.run && !edge.run.ended) || !IDLE_MOVES.has(this.stateOf(edge).kind)) continue
        go({ thread: edge.child, edge, tier: edge.asked.access, apex: { session: edge.parentSession, thread: edge.parent, ...(this.conversationOf(edge.parent) && { conversation: this.conversationOf(edge.parent)! }) } }, conversation)
      }
    }
    visit(root, 0)
    const conversation = this.conversationOf(root)
    const session = conversation ? store.journalPlacement(conversation)?.session : undefined
    if (conversation && session) go({ thread: root, tier: this.tierOfConversation(conversation) ?? "ask", apex: { session, thread: root, conversation } }, conversation)
  }

  /**
   * Whether the state a move was decided on still holds: a Fin open and Mako's to drive (not stopped, not released to a
   * process), this host's claim on it, and what it was decided for: the wait still waiting on its limit, as a person who
   * took it away and started a turn has decided otherwise, or a Thread with nothing waiting still at rest. Read again
   * right before what the move does, whatever that is.
   */
  private stillDecided(conversation: string, thread: string, claimed: string, wait?: string): boolean {
    const store = this.store()!
    const edge = store.edges().of(thread)
    const claim = store.finTurn(thread)?.moving
    if (edge && (edge.closedAt !== undefined || (edge.run && edge.run.ended === undefined))) return false
    if (claim?.owner !== this.generation || claim.wait !== claimed) return false
    if (!wait) return !this.inTurn(conversation)
    const row = this.deps.live.held(conversation)?.requests.find((request) => request.id === wait)
    return row !== undefined && waitsOnLimit(row)
  }

  /**
   * The move a limit decided, through `continueOn`: the step, the edge that says it, and the waiting request carried
   * there first with the move's words. `waiting` is undefined for a Thread that goes with its tree, which `resting`
   * names the account of. An Apex keeps the words of anything but its own continuation, and with nowhere to go it waits.
   */
  private async moveOn(mover: Mover, conversation: string, harness: string, spent: Spent, waiting: { wait: LiveRequest; since: number | undefined } | undefined, report: () => void, resting?: string, chosen?: { place: string; valid(): boolean }): Promise<boolean | undefined> {
    const { thread, edge, apex, tier } = mover
    const { limit, visited } = spent
    const wait = waiting?.wait
    const moves = this.moves!
    const store = this.store()!
    const claimed = store.finTurn(thread)?.moving?.wait
    // Owned before anything is waited for: a Stop with no row to pause leaves only this.
    const mark = this.deps.live.stopMark(conversation)
    const stoppedSince = () => this.deps.live.stopMark(conversation) !== mark
    let moved = false
    let ended = false
    try {
      const pinned = this.deps.live.pinnedAccount(conversation, harness)
      const accounts = await moves.accounts(harness, pinned, true)
      const from = accounts.find((account) => account.name === pinned) ?? accounts.find((account) => account.active)
      // The harness's own word for the limit, the words it refused with, or the account's reading has to say it ran out.
      if (!limit && wait?.retry?.cause !== "rate-limited" && !from?.spent) return
      if (!wait && from?.name !== resting) return
      const session = this.deps.live.session(conversation)
      const model = this.settingsOf(conversation)?.model
      const place: FinPlace = { harness, ...(from && { account: from.name }), ...(model && { model }) }
      const order = await moves.order({ from: place, when: "mid-run", tier, ...(session?.cwd && { cwd: session.cwd }), visited, accounts, ...(chosen && { personAsked: true }) })
      const now = this.now()
      const until = limit?.resetsAt ?? wait?.retry?.until ?? from?.spent?.until ?? undefined
      const label = (name: string) => this.deps.harnessLabel(name)
      const step = chosen ? order.steps.find(step => stepKey(step) === chosen.place) : order.steps[0]
      if (chosen && (!step || !chosen.valid())) return
      if (!step) {
        // An Apex with nowhere to go stays and says so: what waits for it waits, and goes when something can run.
        if (!edge && wait) this.noteMove(mover, { harness, ...(from && { account: from.label }), ...(until !== undefined && { until }) })
        if (!edge || !wait) return
        if (stoppedSince() || !this.stillDecided(conversation, thread, wait.id, wait.id)) return
        if (wait.retry?.cause === "rate-limited") {
          // No available fallback does not cancel the queue's already-owned reset recovery.
          this.noteMove(mover, { harness, ...(from && { account: from.label }), ...(until !== undefined && { until }) })
          moved = store.finishFinMove(thread, this.generation, "retired")
          this.stopAwaiting(edge.child)
          this.childMoved(edge, false)
          hostLog("agents", "a Fin's fallback steps are exhausted; its usage-limit wait stays pending", { op: edge.op, harness })
          return
        }
        // Without a timed retry, existing exhausted-turn reporting still applies.
        if (!order.spent.length && visited.length === 0) return
        const line = outOfAccountsLine({ harness, ...(from && { account: from.label }) }, order.spent, label, until, now)
        store.rerouteEdge(edge.child, { ...(store.edges().of(edge.child)?.tuned?.rerouted ?? { from: harness }), line })
        moved = store.finishFinMove(edge.child, this.generation, { visited: [placeKey(place)] })
        this.noteLimit(edge.child, { harness, ...(from && { account: from.label }), ...(until !== undefined && { until }) })
        hostLog("agents", "a Fin's account ran out and every other is at its limit; it stops", { op: edge.op, harness })
        ended = true
        // Its Apex hears it stopped, however long it can't run itself: what it asked for isn't coming. Said before the
        // stop, which it reads as ending: a report after it would make this any failed Fin.
        this.keepReport(edge, { id: `report:${edge.child}:limit:${wait.id}`, child: ThreadIdSchema.parse(edge.child), status: "failed", summary: `${edge.name} stopped with its work unfinished. ${line}.`, ownerGeneration: this.generation, at: this.now() })
        await this.end(store.edges().of(edge.child) ?? edge, line)
        return
      }
      const move: FinMove = { step, from: { harness, ...(from && { account: from.label }) }, ...(until !== undefined && { until }) }
      const words = movedWords(move, label, now)
      const line = `${words.to}: ${words.why}`
      const actor: Actor = { kind: "service", name: "auto-continue" }
      const target = await this.targetOf(step, apex, tier, session?.cwd)
      // What Mako says of the move goes on what's its to word: a Fin's waiting message, or a continuation of anyone's.
      // Never a digest, which is its Fins' reports, whatever failed under it.
      let said: string | undefined
      if (wait && !wait.digest && (edge || wait.continues)) {
        const checkout = session?.cwd ? await checkoutSince(session.cwd, waiting!.since ?? now) : []
        const text = finMovedText({ from: from ? `${label(harness)} (${from.label})` : label(harness), to: words.to, why: words.why, session: step.why === "harness" ? "handed-over" : "same", checkout })
        // A message the harness never took goes on with its own words beneath the move's.
        said = wait.continues ? text : `${text}\n\n${wait.text}`
      }
      // It goes as any Thread does, yielding to a Stop. Nothing says it moved until it has: a Stop or a person taking
      // the wait back leaves no trace of it.
      const decided = () => claimed !== undefined && !stoppedSince() && (!chosen || chosen.valid()) && this.stillDecided(conversation, thread, claimed, wait?.id)
      let worded = false
      const retire = (why: string): undefined => {
        // Only what the move wrote is its to take back: words edited since stand.
        if (wait && said !== undefined && worded) this.deps.live.rewordWaiting(conversation, wait.id, said, wait.text, wait.displayText)
        moved = store.finishFinMove(thread, this.generation, "retired")
        hostLog("agents", "a move was retired", { thread, harness, why })
        report()
      }
      if (decided() && wait && said !== undefined) worded = this.deps.live.rewordWaiting(conversation, wait.id, wait.text, said)
      if (!decided() || (said !== undefined && !worded)) return retire("what it was decided on no longer holds")
      const id = namedUuid(chosen ? `moved:${claimed}:${stepKey(step)}` : `moved:${wait?.id ?? `${conversation}:${claimed}`}`)
      const first = wait && (edge || wait.continues) ? wait.id : undefined
      const snapshot = await this.deps.continueOn(conversation, { kind: "move", move: { id, to: target, ...(first && { first }), unlessStopped: true } }, actor, decided)
      if (this.stopped) return
      if (!snapshot) return retire("what it was decided on no longer holds")
      const switching = snapshot.control?.transfers.some((transfer) => transfer.input.id === id && unsettled(transfer))
      const settled = switching ? await this.deps.live.switchSettled(id) : undefined
      if (this.stopped) return
      if (settled && settled.state.kind !== "accepted") return retire(settled.state.kind === "failed" ? settled.state.error : settled.state.kind)
      const rerouted = edge && (store.rerouteEdge(edge.child, { from: harness, ...(until !== undefined && { until }), ...(from && { account: from.label }), to: step, at: now, line }) ?? edge)
      moved = store.finishFinMove(thread, this.generation, { visited: [placeKey(place), stepKey(step)] })
      if (edge) this.movedNotes.set(edge.parent, [...(this.movedNotes.get(edge.parent) ?? []), `"${edge.name}" ${line.charAt(0).toLowerCase()}${line.slice(1)}.`])
      // Its Apex's transcript says it too, where the person reads the crew, as a line of its own.
      const apexConversation = edge && this.frontOf(edge.parent, edge.parentSession)
      if (edge && apexConversation) {
        const said = membershipLine({ kind: "moved", fin: store.thread(edge.child)?.title ?? edge.name, to: words.to, why: words.why })
        this.deps.live.recordNote(apexConversation, said.label, said.detail)
      }
      // The tree's line says an Apex's move, and more: its own line only when that line has been said already.
      if (!this.noteMove(mover, { harness, ...(from && { account: from.label }), ...(until !== undefined && { until }) }, words.to.replace(/^Moved to /, "")) || edge) this.deps.live.recordNote(conversation, words.to, words.why)
      hostLog("agents", "a Thread's account ran out; it goes on at the next step", { thread, from: harness, why: step.why, to: step.harness })
      if (edge) {
        this.forget(edge.parent)
        this.childMoved(rerouted!, false)
      }
      if (wait && !chosen) this.moveIdle(this.rootOf(thread), harness, from?.name, until)
      return moved || undefined
    } catch (error) {
      hostWarn("agents", "a Thread couldn't go on after its account ran out; it waits as before", { thread, error: errorMessage({ error }) })
    } finally {
      // A host closing leaves its claim: the next one's gives way to it.
      if (!this.stopped) {
        if (!moved) store.finishFinMove(thread, this.generation)
        if (!moved && !ended) report()
      }
    }
  }

  /**
   * A limit touched Fin `fin` of a tree: the tree's one notice gathers it (`NOTICE_GATHER_MS`), then says what ran out,
   * until when, what moved where and what waits. A moved Fin says nothing of its own; `to` is where it went, none for
   * one with nowhere to go. One notice per account and reset (`limitNoticeId`). Kept as it happens, in the same step as
   * the move: a host that stops while it gathers leaves it to the next (`resume`).
   */
  private noteLimit(fin: string, limit: { harness: string; account?: string; until?: number }, to?: string, apex = false): boolean {
    const store = this.store()
    if (!store) return false
    const { harness, account, until } = limit
    const root = this.rootOf(fin)
    const now = this.now()
    const id = this.limits.get(root)?.id ?? limitNoticeId(limit, now)
    const first = { id, fin, harness, line: "", at: now, ...(until !== undefined && { until }), gathering: { ...(account && { account }), moved: [], stopped: 0 } }
    if (!store.gatherLimitNotice(root, first, to, apex)) return false
    this.gatherNotice(root, id)
    return true
  }

  /** A limit's mark on the tree's notice from `mover`: an Apex's, which has no roster entry of its own, on its first Fin's. False when the notice was said already. */
  private noteMove(mover: Mover, limit: { harness: string; account?: string; until?: number }, to?: string): boolean {
    if (mover.edge) return this.noteLimit(mover.edge.child, limit, to)
    const carrier = this.store()?.edges().children(mover.thread)[0]
    return carrier ? this.noteLimit(carrier.child, limit, to, true) : false
  }

  private gatherNotice(root: string, id: string): void {
    if (this.limits.has(root)) return
    const timer = setTimeout(() => this.sayLimit(root, id), NOTICE_GATHER_MS)
    timer.unref()
    this.limits.set(root, { id, timer })
  }

  private sayLimit(root: string, id: string): void {
    this.limits.delete(root)
    const store = this.store()
    if (!store || this.stopped) return
    const notice = store.limitNotices().find((each) => each.root === root && each.notice.id === id)?.notice
    if (!notice?.gathering) return
    const { harness, until, fin, gathering: { account, moved, stopped, apex } } = notice
    const now = this.now()
    const conversation = this.conversationOf(root)
    // What's on its way and what's held in a digest that hasn't gone, which already counts as delivered.
    const held = (conversation ? this.deps.live.held(conversation)?.requests ?? [] : []).filter((request) => request.status === "queued" || request.status === "held").flatMap((request) => request.digest?.notices ?? [])
    const waiting = store.undeliveredReports().filter(({ report }) => report.status !== "progress" && this.rootOf(report.child) === root).length + held.filter((notice) => notice.report.status !== "progress").length
    const words = limitNoticeWords({ harness, ...(account && { account }), ...(until !== undefined && { until }), ...(apex && { apex }), moved, stopped, waiting }, (name) => this.deps.harnessLabel(name), now)
    const line = limitNoticeLine(words)
    if (!store.sayLimitNotice(root, id, line)) return
    hostLog("agents", "a limit's notice", { root, harness, moved: moved.length, stopped })
    // One a host came back to past its reset is no news: it's kept as said, so the episode isn't said again.
    if (conversation && (until === undefined || until > now)) this.deps.live.recordNote(conversation, words.ran, words.did)
    // Its end first: a reset that falls between them leaves no timer to say so.
    this.endNotice(root)
    this.noticeChanged(store.edges().of(fin))
  }

  /** A tree's notice ends at its reset: every surface hears it as they hear "Got it", a quiet Thread's too. */
  private endNotice(root: string): void {
    clearTimeout(this.noticeEnds.get(root))
    this.noticeEnds.delete(root)
    const notice = this.standingNotice(root)
    if (notice?.until !== undefined) this.waitOutNotice(root, notice, notice.until)
  }

  /**
   * Until `notice`'s reset. A timer can fire a moment early, so one that finds the notice standing waits on for this
   * notice: read for the tree instead, it could already be past, and that read would end the wait with nothing told.
   */
  private waitOutNotice(root: string, notice: LimitNotice, until: number): void {
    const timer = setTimeout(() => {
      this.noticeEnds.delete(root)
      if (this.standingNotice(root)?.id === notice.id) return this.waitOutNotice(root, notice, until)
      this.noticeChanged(this.store()?.edges().of(notice.fin))
      this.endNotice(root)
    }, Math.min(Math.max(until - this.now(), 1), LONGEST_TIMER_MS))
    timer.unref()
    this.noticeEnds.set(root, timer)
  }

  /** The notice on `edge`'s entry came or went: every surface reads the entry again. */
  private noticeChanged(edge: ThreadParent | undefined): void {
    this.asksMoved(edge)
    if (!edge) return
    this.entries.delete(edge.child)
    this.forget(edge.parent)
    this.childMoved(edge, false)
  }

  /** The next step of an order, as a move's target: a harness takes the model and mode the Thread would start on there. */
  private async targetOf(step: FallbackStep, apex: Apex, tier: AccessTier, cwd: string | undefined): Promise<ThreadTarget> {
    if (step.why !== "harness") return { harness: step.harness, ...(step.why === "account" && { account: step.account }), ...(step.why === "connection" && { tuning: { model: step.model } }) }
    const tuned = await this.tuningOf(apex, step.harness, { ...(cwd && { cwd }) })
    const mode = childMode(this.deps.modes(step.harness), tier)
    return { harness: step.harness, ...(!("refused" in tuned) && tuned.settings && { tuning: tuned.settings }), ...(mode && { modeId: mode.id }) }
  }

  /**
   * Where a Thread held by a limit could go on, for its card: one Mako doesn't move by itself, as a Thread with no Fins
   * is the person's to decide, and only with somewhere to go.
   */
  async nextPlace(conversation: string, notice?: string): Promise<{ label: string; harness: string; target: ThreadTarget; choice?: LimitNoticeChoice } | undefined> {
    if (notice !== undefined) {
      const held = this.noticeWaits(conversation, notice)
      for (const item of held) {
        const next = await this.nextForWait(item.conversation, item.edge.asked.access!, this.store()!.finTurn(item.edge.child)?.visited ?? [])
        if (next) return { ...next, choice: { notice, place: next.place,
          waits: [item, ...held.filter(other => other !== item)].slice(0, 64).map(({ edge, wait }) => ({ thread: edge.child, request: wait.id })) } }
      }
      return undefined
    }
    const store = this.store()
    const placed = store?.journalPlacement(conversation)
    if (!store || !placed || store.edges().of(placed.thread) || (this.moves?.on() && store.edges().children(placed.thread).some(edge => !edgeStopped(edge)))) return undefined
    return this.nextForWait(conversation, this.tierOfConversation(conversation) ?? "ask", [])
  }

  private async nextForWait(conversation: string, tier: AccessTier, visited: readonly string[]) {
    const moves = this.moves
    const placed = this.store()?.journalPlacement(conversation)
    const session = this.deps.live.session(conversation)
    if (!moves || !placed || !session || !this.deps.live.held(conversation)?.requests.some(waitsOnLimit)) return undefined
    const pinned = this.deps.live.pinnedAccount(conversation, session.harness)
    const accounts = await moves.accounts(session.harness, pinned, true)
    const from = accounts.find(account => account.name === pinned) ?? accounts.find(account => account.active)
    const model = this.settingsOf(conversation)?.model
    const place: FinPlace = { harness: session.harness, ...(from && { account: from.name }), ...(model && { model }) }
    const order = await moves.order({ from: place, when: "mid-run", tier, ...(session.cwd && { cwd: session.cwd }), visited, accounts, personAsked: true })
    const step = order.steps[0]
    if (!step) return undefined
    const move: FinMove = { step, from: { harness: session.harness, ...(from && { account: from.label }) } }
    const apex: Apex = { session: placed.session, thread: placed.thread, conversation }
    return { label: movedWords(move, name => this.deps.harnessLabel(name), this.now()).to.replace(/^Moved to /, ""),
      harness: step.harness, place: stepKey(step), target: await this.targetOf(step, apex, tier, session.cwd) }
  }

  /** An explicit press re-verifies the shown place and exact waits; it never adopts a newer request after a retry. */
  async continueNext(conversation: string, id: string, choice?: LimitNoticeChoice): Promise<boolean> {
    if (choice) {
      const store = this.store()
      if (!store || !this.moves) return false
      const held = this.noticeWaits(conversation, choice.notice)
      let moved = false
      for (const item of held) {
        if (!choice.waits.some(wait => wait.thread === item.edge.child && wait.request === item.wait.id) || this.moving.has(item.wait.id)) continue
        const valid = () => this.noticeWaits(conversation, choice.notice).some(current => current.edge.op === item.edge.op && current.edge.parent === item.edge.parent && current.edge.child === item.edge.child && current.wait.id === item.wait.id && current.mark === item.mark)
        if (!valid()) continue
        const claim = `person:${id}:${item.wait.id}`
        const turn = store.claimFinMove(item.edge.child, claim, this.generation, this.now())
        if (!turn) continue
        this.moving.add(item.wait.id)
        const apex: Apex = { session: item.edge.parentSession, thread: item.edge.parent, ...(this.conversationOf(item.edge.parent) && { conversation: this.conversationOf(item.edge.parent)! }) }
        try {
          const result = await this.moveOn({ thread: item.edge.child, edge: item.edge, apex, tier: item.edge.asked.access! }, item.conversation,
            this.deps.live.session(item.conversation)!.harness, { limit: undefined, visited: turn.visited },
            { wait: item.wait, since: item.wait.createdAt }, () => {}, undefined, { place: choice.place, valid })
          moved = result === true || moved
        } finally { this.moving.delete(item.wait.id) }
      }
      if (moved && !this.noticeWaits(conversation, choice.notice).length) {
        const placed = store.journalPlacement(conversation)
        const notice = placed && this.standingNotice(placed.thread)
        if (placed && notice?.id === choice.notice && store.seeLimitNotice(placed.thread, choice.notice)) this.noticeChanged(store.edges().of(notice.fin))
      }
      return moved
    }
    const mark = this.deps.live.stopMark(conversation)
    const next = await this.nextPlace(conversation)
    if (!next || this.deps.live.stopMark(conversation) !== mark) return false
    return (await this.deps.continueOn(conversation, { kind: "move", move: { id, to: next.target } }, undefined, () => this.deps.live.stopMark(conversation) === mark)) !== undefined
  }

  /**
   * What a Fin whose turn ended still waits on, in words: its own Fins at
   * work or waiting, their reports still on their way to it, or the move into
   * its worktree it asked for, after which it carries on there. Its turn's end
   * isn't its result while any holds.
   */
  private waitsOn(edge: ThreadParent, conversation: string): string | undefined {
    const own = this.store()!.edges().children(edge.child).filter((child) => !child.closedAt && WAITED_ON.has(this.stateOf(child).kind))
    const parts: string[] = []
    if (own.length === 1) parts.push(`its ${FIN_WORD} ${own[0]!.name}`)
    else if (own.length) parts.push(`its ${own.length} ${FIN_WORD}s (${own.map((child) => child.name).join(", ")})`)
    if (!own.length && this.wakes.waits(conversation)) parts.push(`what its ${FIN_WORD}s reported, which comes to it next`)
    if (this.deps.movePending?.(conversation)) parts.push("its move into its own worktree")
    const work = this.heldWork(conversation)
    if (work) parts.push(work)
    return parts.length ? parts.join(" and ") : undefined
  }

  /**
   * What a Fin's harness still holds that wakes it when it settles (`pendingWake`): "a monitor it left running", "2
   * commands it left running". Its harness starts the Fin's next turn then, as Claude Code does for a background command
   * or a Monitor's event, so a turn that ended on it hasn't finished.
   */
  private heldWork(conversation: string): string | undefined {
    const held = this.deps.live.held(conversation)
    const work = held ? pendingWake(held.session, held.nativeAgents, this.now()) : null
    return work ? `${backgroundWorkText(work)} it left running` : undefined
  }

  /**
   * A Fin whose turn ended waiting: once it waits on nothing, isn't at work
   * and has no digest coming, that turn's reply is its result. One its Fins'
   * reports wake reports when that turn ends instead.
   */
  private checkAwaiting(edge: ThreadParent): void {
    const held = this.awaiting.get(edge.child)
    if (!held || edge.closedAt !== undefined) return
    if (this.ready(held.conversation) !== "idle" || this.wakes.waits(held.conversation) || this.waitsOn(edge, held.conversation)) return
    this.stopAwaiting(edge.child)
    // Its harness's process ended while what it waited on still ran: that work ended with it, and nothing wakes it now.
    const snapshot = this.deps.live.held(held.conversation)
    const newest = snapshot?.requests.filter((request) => request.status !== "queued" && request.status !== "held" && request.status !== "canceled").at(-1)
    if (held.work && newest?.id !== held.request) {
      // A turn its harness started on that work (a Monitor's event, a command settling) came after it: that turn's end
      // is its word, as `turnEnded` reads it.
      if (newest && (newest.status === "completed" || newest.status === "failed" || newest.status === "interrupted")) this.turnEnded(edge, held.conversation, newest.id)
      return
    }
    if (held.work && !providerHolds(snapshot?.session) && snapshot?.session.connection !== "hibernated") {
      const why = snapshot?.session.error
      this.keepReport(edge, {
        id: `report:${edge.child}:${held.request}:work-ended`,
        child: ThreadIdSchema.parse(edge.child),
        status: "failed",
        summary: `Its ${this.deps.harnessLabel(snapshot!.session.harness)} process ended while it waited on ${held.work}${why ? ` (${why})` : ""}, so that work ended with it and nothing will wake it. A message resumes it.`,
        implicit: true,
        ownerGeneration: this.generation,
        at: this.now(),
      })
      return
    }
    // That work ended without its harness starting a turn on it (Claude dropped a Monitor that timed out, or one TaskStop
    // ended, saying nothing), or nothing was heard of it past the ceiling: nothing will wake it. It ended without a result.
    if (held.work && !held.woke) {
      const stale = staleWork(snapshot?.nativeAgents, this.now()).length > 0
      const why = stale
        ? `Nothing was heard of ${held.work} in ${HELD_WORK_CEILING_MS / 3_600_000} hours, so Mako no longer counts on it.`
        : `${held.work.charAt(0).toUpperCase()}${held.work.slice(1)} ended without waking it.`
      const said = this.deps.live.turnReply(held.conversation, held.request)?.text ?? ""
      this.keepReport(edge, {
        id: `report:${edge.child}:${held.request}:work-ended`,
        child: ThreadIdSchema.parse(edge.child),
        status: "failed",
        unfinished: true,
        summary: `${why} ${unfinishedSummary(said)}`.slice(0, 16_000),
        implicit: true,
        ownerGeneration: this.generation,
        at: this.now(),
      })
      return
    }
    this.turnEnded(edge, held.conversation, held.request)
  }

  /** A run Mako stopped outlived its kill: its Fin's row says so (`stuckWords`), and it keeps its place. */
  private runStuck(edge: ThreadParent): void {
    this.childMoved(this.store()?.edges().of(edge.child) ?? edge, false)
  }

  /**
   * A Fin's turn may have been cut short: once Mako's own continuation would
   * have been scheduled (`STRANDED_AFTER_MS`), a cut turn nothing picks up
   * becomes a question for its Apex (`reportCut`). Looked at once per cut.
   *
   * While Mako's own continuation of it is on its way (a reconnect whose native turn is still being verified, or queued
   * for its next try after a check that couldn't finish yet, `NativeVerificationPendingError`), nothing is asked: the
   * wait counts from when that continuation settled without going on. Counted from the cut, the question was once
   * written while a verification still ran past the wait, and the turn then went on: the question was dropped as
   * stale (`AgentWakes.notice`), a stored report its Apex never heard.
   */
  private watchCut(conversation: string): void {
    if (this.stopped) return
    const snapshot = this.deps.live.snapshot(conversation)
    const last = snapshot?.requests.filter((request) => request.status !== "queued" && request.status !== "held" && request.status !== "canceled").at(-1)
    if (!snapshot || (last?.status !== "interrupted" && last?.status !== "uncertain") || !last.interruption || last.interruption.reason === "stopped" || last.interruption.reason === "steered") return
    const continuing = continuationUnsettled(snapshot, last.id)
    const armed = this.cutChecks.get(conversation)
    // Armed as things stand: its wait goes on. A continuation that settled since the look was set starts the wait anew,
    // from now (a snapshot moves as it settles, `moved`); one that set out since makes the look wait for it.
    if (armed && armed.continuing === continuing) return
    if (armed) clearTimeout(armed.timer)
    const timer = setTimeout(() => {
      this.cutChecks.delete(conversation)
      // Still on its way: looked at again, so a continuation that settled without a snapshot moving is still noticed.
      if (continuing) this.watchCut(conversation)
      else this.checkCut(conversation)
    }, STRANDED_AFTER_MS)
    timer.unref()
    this.cutChecks.set(conversation, { timer, continuing })
  }

  private checkCut(conversation: string): void {
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (!edge || edge.closedAt !== undefined || !this.deps.live.snapshot(conversation)) return
    // What Mako continues itself is continued before anyone is asked: a crash's cut whose continuation wasn't admitted
    // when this host took the Fin up (its conversation not read in yet, or refused for that moment) is asked for again
    // here, under the same request, so one admitted since changes nothing. Asked only after, the question was once
    // written for a turn that then went on, and no digest ever carried it (`current`): a stored report its Apex never
    // heard.
    this.continueCrashed(conversation, { op: edge.op })
    const snapshot = this.deps.live.snapshot(conversation)
    if (!snapshot) return
    const cut = strandedTurn(snapshot.requests)
    if (!cut) return
    // A continuation on its way through a reconnect is a transfer until it commits, not yet a request: the cut is
    // looked at again once it has settled, and the wait before the question counts from then (`watchCut`).
    if (continuationUnsettled(snapshot, cut.id)) return this.watchCut(conversation)
    this.reportCut(edge, snapshot.requests, cut)
  }

  /**
   * A Fin's cut turn nothing will continue: its Apex hears what cut it, why
   * it isn't going on, and what it had in flight, as a question it answers
   * with one call (`CUT_ANSWERS`): continue it, stop it, or its own words.
   */
  private reportCut(edge: ThreadParent, requests: readonly LiveRequest[], cut: LiveRequest): void {
    const interruption = cut.interruption!
    const why = continuationsSpent(requests, cut, this.now())
      ? `Mako continued it ${RESTART_CHAIN} times in a row and each was cut short too, so it stopped trying.`
      : interruption.reason === "signed-out"
        ? "It can go on once its harness is signed in again."
        : "Mako doesn't continue a turn cut that way on its own."
    const flight = (interruption.calls ?? []).filter((call) => call.result === "none").map((call) => call.title)
    const did = [
      flight.length ? `It had ${flight.length === 1 ? "a call" : `${flight.length} calls`} in flight: ${flight.slice(0, 4).join("; ")}${flight.length > 4 ? "; …" : ""}.` : "",
      interruption.stopped?.length ? `The cut stopped what it left running: ${interruption.stopped.slice(0, 4).join("; ")}.` : "",
    ].filter(Boolean).join(" ")
    this.keepReport(edge, {
      id: cutReportId(edge.child, cut.id),
      child: ThreadIdSchema.parse(edge.child),
      status: "blocked",
      summary: `Its turn was cut short: ${CUT_BY[interruption.reason]}. ${why}${did ? ` ${did}` : ""}`,
      question: "Its turn was cut short. Continue it, give it other words, or stop it?",
      options: [...CUT_OPTIONS],
      recommended: 0,
      action: "Decide whether its cut turn goes on.",
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    })
  }

  /** The cut a question its Apex passed to the person came from: the newest cut question before it, if the Fin said nothing between. */
  private cutPassed(edge: ThreadParent): string | undefined {
    const reports = this.store()!.reportsOf(edge.child, 0)
    const passed = reports.at(-1)
    const before = reports.at(-2)
    return passed?.for === "person" && before ? (cutOf(edge.child, before.id) && before.id) : undefined
  }

  /**
   * The Apex's answer to a cut turn's question: continue it where it was cut
   * (a followed run's session resumed here), stop it, or give it other words
   * as its next message.
   */
  private async answerCut(by: Answerer, edge: ThreadParent, op: string, cut: string, words: string): Promise<AgentsAnswered | AgentRefused> {
    const done = (delivery?: FinDelivery): AgentsAnswered => ({ child: edge.child, name: edge.name, answered: "report", ...(delivery && { delivery }) })
    const actor: Actor | undefined = by.kind === "apex" ? { kind: "agent", session: SessionIdSchema.parse(by.apex.session) } : undefined
    if (sameWords(words, CUT_STOP)) {
      await this.end(edge, by.kind === "apex" ? `its ${APEX_WORD} stopped it after its turn was cut short` : "the person stopped it after its turn was cut short")
      return done()
    }
    if (!sameWords(words, CUT_CONTINUE)) {
      const sent = await this.deliver(edge, namedUuid(op), actor ? `${fromAgent(YOUR_APEX)}\n${words}` : words, [], actor, "queue")
      return "refused" in sent ? sent : done(sent.delivery)
    }
    if (cut.startsWith("run:")) {
      // Two answers at once read as one: the first takes it, and what a Stop or the engine's end did meanwhile stands.
      if (this.cutsAnswering.has(cut)) return { refused: "conflict", why: `${edge.name}'s cut turn is being continued.` }
      this.cutsAnswering.add(cut)
      try {
        const run = edge.run
        const path = run?.nativeId ? this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId }) : undefined
        const ref = path ? this.deps.catalog.ref(path) : undefined
        // Since its session was last written, when it last worked: its end is only when a host found it gone.
        const written = Date.parse(ref?.updatedAt ?? "")
        const note = await cutAccount(ref?.cwd, Number.isFinite(written) ? written : run?.startedAt ?? run?.ended?.at ?? this.now(), "provider-exited", this.now())
        if (this.stopped || this.store()?.edges().of(edge.child)?.closedAt !== undefined) return { refused: "conflict", why: `${edge.name} was stopped while its cut turn was answered.` }
        // Its session resumes here (`takeOver`), the continuation its first message.
        const sent = await this.deliver(edge, namedUuid(op), `${continueTurnPrompt("provider-exited", "mako")}${note ? `\n\n${note}` : ""}`, [], actor, "queue")
        if ("refused" in sent) return sent
        hostLog("agents", "cut turn continued", { op: edge.op, run: true, by: by.kind })
        return done(sent.delivery)
      } finally {
        this.cutsAnswering.delete(cut)
      }
    }
    const conversation = this.conversationOf(edge.child)
    const request = conversation ? this.deps.live.snapshot(conversation)?.requests.find((each) => each.id === cut) : undefined
    if (!conversation || !request?.interruption) return { refused: "conflict", why: `${edge.name}'s cut turn isn't in its conversation here anymore: agents_send gives it a message.` }
    if (!strandedTurn(this.deps.live.snapshot(conversation)!.requests)) return { refused: "conflict", why: `${edge.name}'s cut turn was already picked up.` }
    const brief = cutBrief(edge.op, request)
    try {
      this.deps.live.continueTurn(conversation, { requestId: namedUuid(op), reason: request.interruption.reason, continues: cut, ...(brief ? { brief } : { since: request.interruption.at }), actor: actor ?? { kind: "service", name: "auto-continue" } })
    } catch (error) {
      return { refused: "unavailable", why: `${edge.name}'s turn couldn't be continued: ${errorMessage({ error })}` }
    }
    hostLog("agents", "cut turn continued", { op: edge.op, request: cut, by: by.kind })
    return done("turn")
  }

  /** A followed run ended: its end is its last report, unless it reported while it ran; held notices go to its next turn. */
  private runEnded(edge: ThreadParent, ended: RunEnd): void {
    hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: ended.kind })
    const run = edge.run!
    const store = this.store()
    const reported = store?.reportsOf(edge.child, run.startedAt - 1).some((report) => !report.implicit) ?? true
    // A run that ended without saying how, as one a quit, a crash or a shutdown ended does, is cut short: its Apex decides.
    if (store && !reported && ended.kind === "unknown")
      this.keepReport(edge, {
        id: cutReportId(edge.child, `run:${run.startedAt}`),
        child: ThreadIdSchema.parse(edge.child),
        status: "blocked",
        summary: `Its run was cut short: ${ended.detail ?? "its process ended without saying how it went."} Mako doesn't start it again on its own; continuing it resumes its session here.`,
        question: "Its run was cut short. Continue it, give it other words, or stop it?",
        options: [...CUT_OPTIONS],
        recommended: 0,
        action: "Decide whether its cut run goes on.",
        implicit: true,
        ownerGeneration: this.generation,
        at: ended.at,
      })
    else if (store && ended.kind !== "stopped" && !reported)
      this.keepReport(edge, {
        id: `report:${edge.child}:run:${run.startedAt}`,
        child: ThreadIdSchema.parse(edge.child),
        status: ended.kind === "done" ? "done" : "failed",
        summary: ended.detail ?? (ended.kind === "done" ? "It finished." : "It ended without saying how it went."),
        implicit: true,
        ownerGeneration: this.generation,
        at: ended.at,
      })
    void this.release(edge)
    void this.drain()
  }

  private keepReport(reporting: ThreadParent, report: Report): { report: Report; deduped: boolean } | AgentRefused {
    // Its own report is the Fin at work; one Mako writes for it (a cut turn, a silent turn's end) isn't.
    if (!report.implicit) this.quiet.activity(reporting.child)
    const store = this.store()!
    // A new report of a Fin closed as finished is news of an open one: the edge opens first, so the report is kept and
    // heard as any, and its six hours start from this report. A repeat of one it kept opens nothing.
    const standing = store.edges().of(reporting.child)
    const edge = standing && closedFinished(standing) && !store.hasReport(report.id) ? this.reopen(standing, "a report") : reporting
    let kept: ReturnType<ThreadStore["keepReport"]>
    try {
      kept = store.keepReport(report)
    } catch (error) {
      return { refused: "conflict", why: `That report's key was used for another report: ${errorMessage({ error })}` }
    }
    if ("stale" in kept) {
      hostLog("agents", "report refused", { op: edge.op, report: report.id, refused: "stale-owner" })
      return { refused: "stale-owner", why: "A newer owner of this Thread already reported; this one's report is refused." }
    }
    if (kept.deduped) return kept
    hostLog("agents", "report", { op: edge.op, report: report.id, status: report.status, implicit: report.implicit ?? false })
    this.reportKept(kept.report)
    this.keptHere.add(kept.report.id)
    this.latest.set(edge.child, kept.report)
    if (report.status === "done" || report.status === "failed") this.finishedDemand.set(true)
    if (quietProgress(report)) store.markReportsDelivered([report.id], this.now())
    else this.noticeOf(edge, kept.report, undefined, "off-the-call")
    this.childMoved(edge, false)
    for (const wake of this.waiters) wake()
    this.checkHolds(edge.child)
    if (report.status !== "progress") this.finMet(edge.child, `${reportWord(report)}: ${firstLine(report.summary)}`)
    this.pulls.refresh()
    return kept
  }

  /** A Fin's result or end meets every turn wait naming it. */
  private finMet(child: string, words: string): void {
    this.turnWaits.metWhere((item) => item.kind === "fin" && item.fin === child, words)
  }

  /** `notice:{child}:{reportId}` to the Apex's owner: this host, which has the Apex's conversation; a report its spawn asked not to hear goes nowhere but its strip. */
  private noticeOf(edge: ThreadParent, report: Report, wake?: string, read: "in-order" | "off-the-call" = "in-order"): void {
    const notice = this.noticeFor(edge, report, wake)
    if (!notice) return
    // Its Apex is on another device: the report waits in the store, unheard, until that device's host takes it.
    if (edge.remote) {
      if (this.places) this.places.queued(edge.remote.device)
      else hostLog("agents", "notice waits", { notice: notice.id, device: edge.remote.device, why: "this device isn't signed in to Mako" })
      return
    }
    const conversation = this.frontOf(edge.parent, edge.parentSession)
    if (conversation && (read === "in-order" || this.deps.live.held(conversation))) return this.wakes.notice(conversation, this.rootOf(edge.parent), notice)
    // A report (`off-the-call`) whose Apex's conversation isn't in memory: it's read in off this call, on a reader, and
    // the notice follows. Read in here, a report read the Apex's whole journal on the loop. Kept unheard in the store
    // meanwhile, so a host that stops first sends it on its start. A starting host's notices (`resume`) go in order
    // with the rest of what it resumes: one that came after its Apex's wakes resumed was never heard.
    if (conversation) return this.wakes.noticeWhen(this.deps.live.readIn([conversation]), conversation, this.rootOf(edge.parent), notice)
    // An Apex whose turns a process Mako didn't start runs: the report waits unheard in the store until that process ends.
    const apex = this.store()!.edges().of(edge.parent)
    if (!apex?.run) return
    if (apex.run.ended) return void this.release(apex)
    hostLog("agents", "message held", { notice: notice.id, until: "its process exits" })
  }

  /** What a report is to its Apex: a notice, or nothing, and heard, when its route sends it elsewhere. */
  private noticeFor(edge: ThreadParent, report: Report, wake?: string): Notice | undefined {
    const store = this.store()!
    const route = report.for === "person" ? (report.told ? "apex" : "person") : reportRoute(edge.asked, report.status, !quietProgress(report))
    if (route !== "apex") {
      store.markReportsDelivered([report.id], this.now())
      hostLog("agents", "report kept", { op: edge.op, report: report.id, status: report.status, to: route, wake: edge.asked.wake ?? "decisions" })
      return undefined
    }
    return {
      id: `notice:${edge.child}:${report.id}`,
      report,
      label: `"${edge.name}" (${this.deps.harnessLabel(this.harnessOf(edge))})`,
      fin: { name: edge.name, harness: this.harnessOf(edge) },
      from: store.thread(edge.child)?.sessions[0] ?? edge.parentSession,
      ...(wake && { wake }),
      ...(edge.asked.mode === "wait" && (report.status === "done" || report.status === "failed") && { settledOnly: true as const }),
      ...(report.status === "done" && report.question && { decision: decisionOn(edge.asked, report) }),
      ...(report.unfinished && { ...holding(this.waitingAfter(edge)) }),
    }
  }

  /** The names of the starts queued to go after a Fin, oldest first. */
  private waitingAfter(edge: ThreadParent): string[] {
    return (this.store()?.queuedSpawns() ?? []).flatMap((spawn) => {
      const queued = parseQueued(spawn.record)
      const after = queued?.after?.some((ref) => ref.child === edge.child || (ref.op !== undefined && ref.op === edge.op))
      return queued && after ? [(queued.input.name ?? queued.input.title ?? "queued").slice(0, 200)] : []
    }).slice(0, 32)
  }

  /** The notices of Fins here whose Apex is on another device that no such device has taken yet, oldest first (`AgentPlaces`). */
  private outbox(): OutboxNotice[] {
    const store = this.store()
    if (!store) return []
    const edges = store.edges()
    return store.undeliveredReports().flatMap(({ report }) => {
      const edge = edges.of(report.child)
      return edge?.remote && report.status !== "progress" && this.noticeFor(edge, report) ? [{ edge, report }] : []
    })
  }

  /**
   * A Fin that is an Apex of its own ended its process: its conversation opens
   * on Mako's live driver, and the reports its Fins left unheard wake it there
   * as any Apex's do. They're read from the store, so a process that ended
   * while no host ran is heard from the next one.
   */
  private async release(edge: ThreadParent): Promise<void> {
    const run = edge.run
    const store = this.store()
    if (!store || !run?.nativeId || this.releasing.has(edge.child)) return
    const edges = store.edges()
    const notices = store.undeliveredReports().flatMap(({ report, wake }) => {
      const child = edges.of(report.child)
      const notice = child?.parent === edge.child && report.status !== "progress" ? this.noticeFor(child, report, wake) : undefined
      return notice ? [notice] : []
    })
    if (!notices.length) return
    const path = this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId })
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!path || !ref?.cwd) {
      hostWarn("agents", "a held message has no session to resume; it waits unheard", { child: edge.child, notices: notices.length })
      return
    }
    const conversationId = namedUuid(`resume:${edge.child}:${run.nativeId}`)
    this.releasing.add(edge.child)
    try {
      await this.deps.startLive(run.harness, ref.cwd, { conversationId, resume: run.nativeId, threadPath: path })
      hostLog("agents", "held message released", { child: edge.child, notices: notices.length, conversation: conversationId })
      for (const notice of notices) this.wakes.notice(conversationId, this.rootOf(edge.child), notice)
    } catch (error) {
      hostWarn("agents", "a held message could not start its turn; it waits for the next start", { child: edge.child, error: errorMessage({ error }) })
    } finally {
      this.releasing.delete(edge.child)
    }
  }

  /**
   * Stops a Fin, once: its running turn, or its process group. The delegation
   * closes first, with why, so the turn the stop cuts short ends as stopped
   * rather than as a failure that wakes the Apex, which asked for it.
   */
  private async end(asked: ThreadParent, why: string): Promise<boolean> {
    // One closed as finished wasn't stopped: a stop or an archive closes it in its own words, as it closes an open Fin
    // that finished, so it reads as stopped and nothing Mako sends by itself opens it.
    const edge = closedFinished(asked) ? this.store()?.reopenEdge(asked.child, this.now()) ?? asked : asked
    if (edge.placed) {
      const ended = await this.stopAway(this.apexOfEdge(edge), edge, why)
      if ("refused" in ended) hostWarn("agents", "a Fin placed elsewhere couldn't be stopped; it goes on there", { op: edge.op, refused: ended.refused, why: ended.why })
      return "stopped" in ended && ended.stopped
    }
    for (const crossing of this.crossings.get(edge.child) ?? []) crossing.stopped = true
    const conversation = this.conversationOf(edge.child)
    // Stopped already: a turn or a message still going there is what a stop now ends.
    if (edge.closedAt) {
      if (!conversation || !(await this.halt(edge, conversation))) return false
      hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: "stopped", why, again: true })
      this.childMoved(edge, false)
      void this.drain()
      return true
    }
    const store = this.store()!
    const closed = store.keepEdge({ ...edge, closedAt: this.now(), closedReason: stopReason(why) })
    // What waits looks again now; a Fin whose turn is still being cancelled holds its place until that's done (`occupies`).
    void this.drain()
    this.runs.stop(edge.child, why.slice(0, 2000))
    if (conversation) await this.halt(edge, conversation)
    hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: "stopped", why })
    this.finMet(edge.child, `stopped: ${why}`)
    // The Fin's own wait ends with its work.
    if (conversation) this.turnWaits.cancelOf(conversation, why === "the person archived it" ? "archive" : "stop")
    this.childMoved(closed, false)
    // Its own queued Fins now wait for it to resume.
    this.queueRefresh()
    this.pulls.refresh()
    void this.drain()
    return true
  }

  /**
   * Stops a Fin placed elsewhere, where it runs (`mako:agents-stop`): once its device says it stopped, the delegation
   * closes here too, with why. A device that can't be reached is said, and nothing closes: the stop is kept on the
   * Fin's edge and sent once that device answers (`retryStops`), unless its Apex sends the Fin on first.
   */
  private async stopAway(apex: Apex, edge: ThreadParent, why: string): Promise<{ stopped: boolean } | { pending: string } | AgentRefused> {
    const { answer, epoch } = await this.touchPlaced<Exclude<AgentsStopResult, AgentRefused>>(apex, edge, "mako:agents-stop", { child: edge.child, reason: why }, "stop")
    const store = this.store()!
    if ("refused" in answer) {
      // Its device answered that it won't: there's nothing to keep.
      if (answer.refused !== "place-unavailable" && answer.refused !== "unavailable") return { refused: answer.refused, why: answer.why }
      const name = edge.placed ? placeName(edge.placed.target) : "its device"
      store.keepPlaced(edge.child, { stop: edge.placed?.stop ?? { at: this.now(), why: why.slice(0, 2_000) } })
      hostLog("agents", "stop kept", { op: edge.op, child: edge.child, place: edge.asked.place ?? "", refused: answer.refused })
      return { pending: `${name} can't be reached now, so ${edge.name} isn't stopped yet and may be at work there. The stop is kept: it goes once ${name} answers. ${answer.why}` }
    }
    const shut = edge.closedAt === undefined ? store.keepEdge({ ...edge, closedAt: this.now(), closedReason: stopReason(why) }) : edge
    const closed = store.keepPlaced(edge.child, { working: false, epoch, stop: undefined }) ?? shut
    hostLog("agents", "end", { op: edge.op, child: edge.child, outcome: "stopped", why, place: edge.asked.place ?? "" })
    this.forget(edge.parent)
    this.childMoved(closed, false)
    void this.drain()
    return { stopped: answer.stopped.length > 0 || edge.closedAt === undefined }
  }

  /** A stopped Fin's turn stops and its waiting messages pause, as the person's Stop pauses them; whether either was there. */
  private async halt(edge: ThreadParent, conversation: string): Promise<boolean> {
    const status = this.deps.live.session(conversation)?.status
    const turn = status === "running" || status === "starting" || Boolean(this.deps.live.held(conversation)?.requests.some((request) => request.status === "dispatching"))
    if (turn) await this.deps.live.cancel(conversation).catch((error) => hostWarn("agents", "a Fin's turn could not be stopped", { op: edge.op, error: errorMessage({ error }) }))
    let paused = 0
    try {
      paused = this.deps.live.stopHolds(conversation)
    } catch (error) {
      hostWarn("agents", "a stopped Fin's messages couldn't be paused", { op: edge.op, error: errorMessage({ error }) })
    }
    return turn || paused > 0
  }

  // ── Finished Fins ──

  /**
   * Closes every Fin that finished `FINISHED_CLOSE_MS` ago with nothing left open, and answers the Fins it closed. Until
   * this, no edge was ever closed for being finished: on 2026-11-17 the person's store held 113 open Fins, 98 of them
   * done, 61 for over a week, each in every prompt's note, every list and every start's read of its journal. Closing
   * is bookkeeping alone. The edge takes `FINISHED_CLOSE` as its reason, the Fin still reads as done or failed
   * (`childState`), and nothing is cancelled, no process is stopped, no report is written and no worktree goes here. A
   * message to it, from anyone, opens it again in the same Session (`reopen`), as a stopped Fin's does.
   *
   * A closed edge is passed over by what looks for open questions and waits, so it closes only when there are none:
   * every condition is read (`keptOpen`, `conversationHolds`) in the same step as the write, with nothing awaited
   * between. A conversation that isn't in memory is read in first, a slice at a time: only its journal says whether a
   * message still waits there.
   */
  closeFinished(): Promise<string[]> {
    this.closing ??= this.closeFinishedNow().finally(() => {
      this.closing = undefined
    })
    return this.closing
  }

  /** `closeFinished` where nobody waits for it: at a host's start and as a turn settles, while an open Fin has finished. */
  private sweepFinished(): void {
    void this.closeFinished().catch((error: Error) => hostWarn("agents", "finished Fins couldn't be closed; the next pass looks again", { error: errorMessage({ error }) }))
  }

  private async closeFinishedNow(): Promise<string[]> {
    const closed: string[] = []
    const store = this.store()
    // Not before the last host's leftovers are taken up (`resume`): until then what's pending isn't all known.
    if (!store || this.stopped || !this.starts.isRecovered || !store.writable) return closed
    this.sync()
    let facts = this.finishedFacts(store)
    let read = store.moved()
    /** What's pending as the store stands now, read again only once it moved; the moment is always now. */
    const current = () => {
      if (store.moved() === read) return void (facts = { ...facts, now: this.now() })
      this.sync()
      facts = this.finishedFacts(store)
      read = store.moved()
    }
    for (const listed of store.edges().all) {
      // What takes no read first: most Fins aren't finished, or not for long enough.
      const latest = this.latest.get(listed.child)
      if (listed.closedAt !== undefined || !latest || !this.finished(listed) || this.now() - latest.at < FINISHED_CLOSE_MS) continue
      const heldAt = this.finishedHeld.get(listed.child)
      if (heldAt !== undefined && this.now() - heldAt < FINISHED_CLOSE_MS) continue
      // One Fin a turn of the loop: looking at one may read its every report once, and a tree has many.
      await new Promise((resolve) => setImmediate(resolve))
      if (this.stopped) break
      current()
      const standing = store.edges().of(listed.child)
      if (!standing || this.keptOpen(standing, facts)) continue
      const cold = this.conversationsOfThread(listed.child).filter((conversation) => this.deps.live.session(conversation) && !this.deps.live.held(conversation))
      if (cold.length) {
        if (!(await this.deps.live.readIn(cold)) || this.stopped) break
        // Whatever came while they were read counts: the store and the engine are read again from here.
        current()
      }
      const edge = store.edges().of(listed.child)
      if (!edge || this.keptOpen(edge, facts)) continue
      if (this.conversationHolds(edge, facts.now)) {
        this.finishedHeld.set(edge.child, facts.now)
        continue
      }
      this.finishedHeld.delete(edge.child)
      const shut = store.keepEdge({ ...edge, closedAt: facts.now, closedReason: FINISHED_CLOSE })
      // Another host's stop came first: its reason stands.
      if (!closedFinished(shut)) continue
      closed.push(shut.child)
      hostLog("agents", "closed as finished", { op: shut.op, child: shut.child, finishedFor: facts.now - (this.latest.get(shut.child)?.at ?? facts.now) })
      this.forget(shut.parent)
      this.childMoved(shut, false)
      current()
    }
    // The job comes back only while an open Fin has finished, or will be found to have.
    this.finishedDemand.set(!this.stopped && store.edges().all.some((edge) => edge.closedAt === undefined && this.finished(edge)))
    return closed
  }

  /**
   * Why a Fin's edge is open now, as the sweep reads it without reading anything in; undefined for one it would close,
   * or that isn't a Fin here. For Diagnostics, the log and a test's failure, never for a decision: `closeFinished` reads
   * it all again as it closes.
   */
  keptOpenBy(child: string): string | undefined {
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge) return undefined
    this.sync()
    const facts = this.finishedFacts(store)
    return this.keptOpen(edge, facts) ?? this.conversationHolds(edge, facts.now)
  }

  /** Whether a Fin's last report says it finished: done, or failed asking nothing. Its edge closes on nothing less. */
  private finished(edge: ThreadParent): boolean {
    const latest = this.latest.get(edge.child)
    return latest !== undefined && (latest.status === "done" || (latest.status === "failed" && !latest.question?.trim()))
  }

  /** What one pass reads of the store once for every Fin it looks at: who something still waits on, or for. */
  private finishedFacts(store: ThreadStore): FinishedFacts {
    const pending = new Set<string>()
    for (const { report } of store.undeliveredReports()) pending.add(report.child)
    for (const kept of store.undeliveredAnswers()) pending.add(kept.child)
    for (const kept of store.undeliveredPullWakes()) pending.add(kept.child)
    const awaited = new Set<string>()
    const unread = new Set<string>()
    for (const spawn of store.queuedSpawns()) {
      const queued = parseQueued(spawn.record)
      // A start this build can't read may name any Fin of its tree: none of them closes while it waits.
      if (!queued) {
        unread.add(spawn.tree)
        continue
      }
      awaited.add(queued.lead.thread)
      for (const ref of queued.after ?? []) {
        if (ref.child) awaited.add(ref.child)
        if (ref.op) awaited.add(ref.op)
      }
    }
    for (const wait of store.armedTurnWaits()) {
      awaited.add(wait.thread)
      for (const item of wait.items) if (item.kind === "fin") awaited.add(item.fin)
    }
    return { store, now: this.now(), actions: store.pendingActionThreads(), pending, awaited, unread }
  }

  /**
   * Why a Fin's edge stays open, or undefined when it finished `FINISHED_CLOSE_MS` ago and nothing waits on it or for
   * it, as far as the store and this engine say; its conversation's own queue is `conversationHolds`'s to say. Each
   * line is one thing a closed edge would hide or strand: a question, an action, an answer owed either way, a report
   * its Apex hasn't taken, a start that waits on it, Fins of its own, a wait Mako watches.
   */
  private keptOpen(edge: ThreadParent, facts: FinishedFacts): string | undefined {
    const { store, now } = facts
    const child = edge.child
    if (edge.closedAt !== undefined) return "closed already"
    // What a Fin placed elsewhere waits on is its device's to know, and what one placed here owes is its Apex's device's.
    if (edge.placed || edge.remote) return "placed on another device"
    const latest = this.latest.get(child)
    if (!latest || !this.finished(edge)) return "not finished"
    if (now - latest.at < FINISHED_CLOSE_MS) return "finished too recently"
    // Opened again by a message: its time starts over, whatever its last report's age.
    if (edge.resumed && now - edge.resumed.at < FINISHED_CLOSE_MS) return "opened again too recently"
    // Named whether or not this host reads pull requests: a host that does must find the wait open.
    if (latest.status !== "failed" && latest.waitingOn?.some((item) => item.kind === "pull-request")) return "waits on a pull request"
    if (edge.run && (!edge.run.ended || this.runs.isTerminating(child) || this.runs.reading(child)?.working)) return "its run goes on"
    if (this.starting.has(edge.op) || this.starts.has(edge.op)) return "starting"
    const state = this.stateOf(edge)
    if (state.kind !== "ended" || state.decision || (state.outcome !== "done" && state.outcome !== "failed")) return "not finished as it reads now"
    if (store.openReportAsks(child).length) return "an open question"
    if (facts.actions.has(child)) return "an open action"
    if (facts.pending.has(child)) return "a report, an answer or a pull request's outcome undelivered"
    if (facts.awaited.has(child) || facts.awaited.has(edge.op) || facts.unread.has(this.rootOf(child))) return "a start or a wait names it"
    if (store.edges().children(child).some((own) => own.closedAt === undefined)) return "open Fins of its own"
    for (const start of this.starts.values()) if (start.thread === child) return "a start of its own under way"
    for (const hold of this.holds) if (hold.child === child) return "a start holds for its result"
    if (this.awaiting.has(child) || this.crossings.has(child) || this.unanswered.has(child) || this.undecided.has(child) || this.cutsAnswering.has(child) || this.releasing.has(child))
      return "the engine waits on it"
    const answer = this.answersHeld.get(child)
    if (answer && !answer.delivered) return "an answer on its way"
    if (store.finTurn(child)) return "a move under way"
    if (store.limitNotice(this.rootOf(child))?.fin === child) return "a limit's notice stands on it"
    if (this.owesApex(edge)) return "owes its Apex an answer"
    // Its result in a digest its Apex hasn't taken, or a steer unanswered: heard by the store, not yet by the Apex.
    if (this.wakes.steered(`notice:${child}:${latest.id}`)) return "its Apex hasn't taken its result"
    const apex = this.frontOf(edge.parent, edge.parentSession)
    if (apex && !this.deps.live.held(apex) && this.deps.live.leftUnsettled(apex)) return "its Apex's queue isn't read in"
    const waiting = apex ? this.deps.live.held(apex)?.requests ?? [] : []
    if (waiting.some((request) => (request.status === "queued" || request.status === "held") && request.digest?.notices.some((notice) => notice.report.child === child)))
      return "its Apex hasn't taken its result"
    return undefined
  }

  /**
   * Why a Fin's own conversations keep its edge open, or undefined when every one is in memory, idle and empty-handed:
   * no turn, no message queued, held or being sent, nothing asked, no work its harness left running, no cut turn, no
   * wait. One this host can't read keeps it open: what it can't see it doesn't close.
   */
  private conversationHolds(edge: ThreadParent, now: number): string | undefined {
    const store = this.store()
    const live = this.deps.live
    const conversations = this.conversationsOfThread(edge.child)
    // A run Mako never drove has no conversation here: its process's end, on this device, is all there is of it.
    if (!conversations.length) return edge.run?.ended && edge.run.device === store?.deviceId ? undefined : "no conversation on this host"
    for (const conversation of conversations) {
      if (this.deps.archived?.(conversation)) return "archived"
      const held = live.session(conversation) ? live.held(conversation) : undefined
      if (!held) return "a conversation this host hasn't read in"
      if (live.atWork(conversation) || live.switching(conversation)) return "at work"
      if (held.requests.some((request) => request.status === "queued" || request.status === "held" || request.status === "dispatching")) return "a message waits in its queue"
      if (held.permissions.length || live.waitingOn(conversation) || live.pendingAsk(conversation)) return "it asks"
      if (pendingWake(held.session, held.nativeAgents, now)) return "work its harness left running"
      const last = held.requests.filter((request) => request.status !== "queued" && request.status !== "held" && request.status !== "canceled").at(-1)
      if (last && (last.status === "interrupted" || last.status === "uncertain")) return "a turn cut short"
      if (this.cutChecks.has(conversation)) return "a cut turn being looked at"
      if (store?.armedTurnWaitOf(conversation)) return "an armed wait"
      if (this.deps.movePending?.(conversation)) return "a move into its worktree"
      // A question its Apex asked that no report of its has answered, whether or not its Apex was told yet (`owedOf`).
      if (held.requests.some((request) => request.expects === "answer") && this.owedOf(edge, conversation).length) return "a question its Apex asked, unanswered"
    }
    return undefined
  }

  // ── What a Fin shows ──

  /** A Fin's reading, with the quiet stretch `QuietWatch` holds now, while it holds. */
  private childReading(edge: ThreadParent): ChildThread {
    const reading = this.liveReading(edge)
    const since = reading.working ? this.quiet.quietSince(edge.child) : undefined
    const told = since === undefined ? undefined : this.quietSteps.get(edge.child)
    return since === undefined ? reading : { ...reading, quiet: { since, ...(told?.since === since && told.step && { step: told.step }), ...(told?.since === since && told.running && { running: true as const }) } }
  }

  /** What the Fin's Thread shows now, from whatever runs its current turn: one source at a time. */
  private liveReading(edge: ThreadParent): ChildThread {
    if (edge.placed) return this.placedReading(edge)
    const run = edge.run
    const conversation = this.askingConversation(edge.child)
    // A run Mako stopped is read from its process until that has exited (`AgentRuns.isTerminating`), whatever reads after it.
    if (run && (!run.ended || !conversation || this.runs.isTerminating(edge.child))) return this.runs.reading(edge.child) ?? { source: "followed", harness: run.harness }
    if (!conversation) return { source: "live", ...(this.starting.has(edge.op) && { starting: "launching" as const }) }
    const live = this.deps.live
    const session = live.session(conversation)
    if (!session) return { source: "live" }
    const held = live.held(conversation)
    // A request sent and not yet answered is work, before its harness says it runs; one nothing will send isn't.
    const busy = live.atWork(conversation)
    const messageHold = !busy && this.messageHold(conversation)
    const waiting = this.personWaiting(conversation) ?? (messageHold ? { for: "needs-you" as const, line: messageHold } : undefined)
    const last = held?.requests.filter((request) => request.status !== "queued" && request.status !== "held").at(-1)
    // A provider reset keeps logical work pending without taking an execution place.
    const reset = !busy && !waiting ? held?.requests.find(request => request.status === "held" && request.pause !== "stop" && request.retry?.cause === "rate-limited" && request.continues?.auto) : undefined
    const resetWait = reset?.retry && `${this.deps.harnessLabel(session.harness)}'s usage limit to reset at ${resetWords(reset.retry.until ?? reset.retry.at, this.now())}`
    const signedInWait = !busy && !waiting && held && signInResuming(signInPause(held.requests), held.requests)
      ? `${this.deps.harnessLabel(session.harness)} to resume after sign-in when an execution place opens` : undefined
    // A turn that ended on its own Fins' work or its move is still at work, on that.
    const ownerWait = !busy && !waiting && held && nextInLine(held.requests, session.status === "failed")?.ownerCheck
      ? "your account" : undefined
    const waits = ownerWait || resetWait || signedInWait || (!busy && !waiting && last?.status === "completed" ? this.waitsOn(edge, conversation) : undefined)
    const working = busy || waits !== undefined
    const workSince = waits ? held?.activityAt : last && (last.dispatchedAt ?? last.createdAt)
    const thread = this.store()?.thread(edge.child)
    const title = thread?.title ?? session.title
    // A reading is taken of every Fin there is, on every look: it holds to what memory has, and never reads a journal in.
    const settings = held ? settingsIn(held) : session.settings
    const model = settings?.model
    const catalog = this.deps.catalogOf?.(session.harness)
    const runsOn = catalog && finTuningWords(catalog, settings)
    return {
      source: "live",
      conversation,
      session: thread?.sessions[0],
      ...(session.nativeId && { nativeId: session.nativeId }),
      ...(session.nativePath && { path: session.nativePath }),
      ...(title && { title }),
      harness: session.harness,
      ...(model && { model }),
      ...(runsOn && { runsOn }),
      ...((session.status === "starting" || this.starting.has(edge.op)) && { starting: "launching" as const }),
      ...(working && { working }),
      ...(working && workSince !== undefined && { workSince }),
      ...(working && last && { workInputs: inputsOf(last.id, held?.control?.actions) }),
      ...(waits ? { step: ownerWait ? "Waiting to hear from your account" : `Waiting for ${waits}`, awaiting: waits } : working && held && { step: lastStep(held.blocks.slice(-24), session.harness) }),
      ...(waiting && { waiting: this.waitingOf(edge, waiting.line, live.pendingAsk(conversation)) }),
      ...(!working && last?.status === "failed" && { ended: { outcome: "failed" as const, ...(last.error && { reason: last.error }), at: turnFailedAt(last, held?.activityAt, edge.createdAt) } }),
      ...(!working && last?.status === "interrupted" && last.interruption?.reason === "stopped" && { ended: { outcome: "stopped" as const, at: last.interruption.at } }),
      startedAt: edge.createdAt,
      ...(held?.activityAt && { updatedAt: held.activityAt }),
    }
  }

  /**
   * A Fin placed elsewhere, read from what this device keeps of it (`Placed.working`): at work from its start, and
   * from each message and answer of its Apex's that reached it, until its device says it isn't. Its device's word
   * comes with each notice and whenever it's asked (`agents_list`, `agents_read`, an admission, this device's return).
   */
  private placedReading(edge: ThreadParent): ChildThread {
    const latest = this.latest.get(edge.child)
    const working = edge.closedAt === undefined && edge.placed?.working === true
    const session = SessionIdSchema.safeParse(edge.placed?.session)
    return {
      source: "placed",
      ...(session.success && { session: session.data }),
      ...(edge.asked.harness && { harness: edge.asked.harness }),
      ...(edge.asked.model && { model: edge.asked.model }),
      ...(working && { working, step: `On ${edge.placed ? placeName(edge.placed.target) : "another device"}` }),
      startedAt: edge.createdAt,
      ...(latest && { updatedAt: latest.at }),
    }
  }

  /** What a Fin's harness waits on, as its state says it: whose it is (the line says why when it's the person's) and what answers it. */
  private waitingOf(edge: ThreadParent, line: string, pending: PendingAsk | undefined): NonNullable<ChildThread["waiting"]> {
    const ask = pending ? nativeAsk(pending) : undefined
    const why = this.personsBecause(edge, ask, line)
    // What waits on the person for something no answer of its Apex's gives (needs-you: its subagent waiting on them,
    // say) is theirs.
    const on = !ask ? "person" : !why ? "lead" : ask.kind === "approval" ? "approval" : "person"
    return { question: why ? `${line} (yours to answer: ${why})` : line, on, ...(ask && { ask }) }
  }

  /**
   * Why a Fin's ask `line` is the person's, or undefined when it's its Apex's
   * alone: an Apex answers within its own access (a question on any, an
   * approval on full access), unless its spawn asked to hear only its result,
   * it left the ask to the person, or it hasn't answered in time.
   */
  private personsBecause(edge: ThreadParent, ask: FinAsk | undefined, line: string): string | undefined {
    if (reportRoute(edge.asked, "blocked") !== "apex") return `its ${APEX_WORD} hears only ${edge.asked.wake === "never" ? "what it reads" : "its result"}`
    if (this.passed(edge, ask)) return `its ${APEX_WORD} left it to you`
    if (this.belowFull(edge, ask)) return `its ${APEX_WORD} isn't on full access`
    const escalated = this.escalated.get(edge.child)
    return escalated?.line === line ? escalated.why : undefined
  }

  private passed(edge: ThreadParent, ask: FinAsk | undefined): boolean {
    return Boolean(ask && this.latest.get(edge.child)?.id === passedId(edge.child, ask.id))
  }

  /** The Apex's tier when `ask` is an approval and the Apex isn't on full access, so can't answer it. */
  private belowFull(edge: ThreadParent, ask: FinAsk | undefined): AccessTier | undefined {
    if (ask?.kind !== "approval") return undefined
    const parent = this.frontOf(edge.parent, edge.parentSession)
    // An Apex on another device answers at the access it placed the Fin with, as this device bounded it.
    const tier = edge.remote?.access ?? (parent ? this.tierOfConversation(parent) : undefined) ?? "ask"
    return tier === "full" ? undefined : tier
  }

  private stateOf(edge: ThreadParent): ChildState {
    this.sync()
    return childState(edge, this.childReading(edge), this.journalOf(edge.child))
  }

  /** A notice of a harness ask speaks only while the ask does: the digest, state and current report share that rule. */
  private latestOf(child: string): Report | undefined {
    const report = this.latest.get(child)
    return report?.implicit && report.status === "blocked" && !this.current({ report }) ? undefined : report
  }

  private journalOf(child: string): ChildJournal {
    const latest = this.latestOf(child)
    const kept = (latest ? this.store()?.answerOf(latest.id) : undefined) ?? this.answersHeld.get(child)
    return { ...(latest && { latest }), ...(kept && { answered: { by: kept.by, answer: kept.answer, ask: kept.ask, request: kept.request, at: kept.at, ...(kept.op === kept.request && { routine: true as const }), ...(kept.delivered && { delivered: true as const }) } }) }
  }

  private entryOf(edge: ThreadParent, read?: { reading: ChildThread; journal: ChildJournal }): NativeAgent {
    this.sync()
    const held = this.entries.get(edge.child)
    // A notice past its reset leaves what's held whatever's next to say so: the Inbox and a phone read it from here.
    if (held && (!held.child?.limitNotice || sameLimitNotice(held.child.limitNotice, this.noticeOn(edge)))) return held
    const made = childEntry(edge, read?.reading ?? this.childReading(edge), read?.journal ?? this.journalOf(edge.child))
    const notice = this.noticeOn(edge)
    const entry = notice && made.child ? { ...made, child: { ...made.child, limitNotice: notice } } : made
    this.entries.set(edge.child, entry)
    return entry
  }

  /** A Fin's entry moved: its Apex's conversations hear it, and a decision it waits on reaches its Apex once. */
  private childMoved(edge: ThreadParent, progressOnly: boolean): void {
    if (this.stopped) return
    this.sync()
    // Every batch of a working Fin comes here, so the Fin is read once for what it asks and for its entry. Only a batch
    // that changes what it asks drops its Apexes' kept walks.
    const moved = { reading: this.childReading(edge), journal: this.journalOf(edge.child) }
    const asks = this.askKey(edge, childState(edge, moved.reading, moved.journal))
    if (this.askKeys.get(edge.child) !== asks) {
      this.askKeys.set(edge.child, asks)
      this.asksMoved(edge)
    }
    if (this.store()?.edges().internalRuns.some((internal) => internal.child === edge.child)) {
      this.occupying.delete(edge.child)
      for (const conversation of this.conversationsOfThread(edge.parent)) {
        this.wakes.refresh(conversation)
        this.deps.live.childrenChanged(conversation, false)
      }
      void this.drain()
      return
    }
    // A place it let go of is the next waiting Fin's at once, whether or not how it reads changed: a Fin shown stopped
    // lets go only when its harness or its process has actually stopped (`occupies`).
    const holds = this.occupies(edge)
    const held = this.occupying.has(edge.child)
    // A Fin taking a place, here or elsewhere, is a reason to read the room: its next look turns it off once none is.
    if (holds) this.roomDemand.set(true)
    if (holds) this.occupying.add(edge.child)
    else this.occupying.delete(edge.child)
    const released = held && !holds
    // Its Apex is on another device, and it stands otherwise than that device last heard, with nothing new to report
    // (its turn ended after a report it made itself, or someone here sent it on): its last report says so again.
    if (edge.remote && holds !== held && this.standingSaid.get(edge.child) !== holds) this.restate(edge)
    const before = this.entries.get(edge.child)
    this.entries.delete(edge.child)
    const entry = this.entryOf(edge, moved)
    if (before && sameChildEntry(before, entry)) {
      this.entries.set(edge.child, before)
      if (released) void this.drain()
      return
    }
    // Its one entry takes its place in the roster held, whose other entries stand as they were: read again, each of an
    // Apex's 226 was looked up for every step of any one of them.
    const roster = this.rosters.get(edge.parent)
    const at = roster && before ? roster.agents.indexOf(before) : -1
    if (roster && at >= 0) {
      const agents = roster.agents.slice()
      agents[at] = entry
      this.rosters.set(edge.parent, { agents, noticed: before?.child?.limitNotice || entry.child?.limitNotice ? agents.filter((agent) => agent.child?.limitNotice) : roster.noticed })
    } else this.rosters.delete(edge.parent)
    const kindChanged = !before || before.state.kind !== entry.state.kind || before.stoppable !== entry.stoppable
    for (const conversation of this.finReaders(edge.parent)) this.deps.live.childrenChanged(conversation, progressOnly && !kindChanged)
    // A digest still unsent is in memory, whose queue keeps it there: one only on disk holds none, and isn't read in.
    if (kindChanged) for (const conversation of this.conversationsOfThread(edge.parent)) if (this.deps.live.held(conversation)) this.wakes.refresh(conversation)
    this.askApex(edge)
    this.watchDecision(edge)
    if (kindChanged) {
      this.checkHolds(edge.child)
      // A Fin waiting on its own Fins reads from them: its entry follows, and its result may be in.
      const above = this.store()?.edges().of(edge.parent)
      if (above) {
        this.childMoved(above, false)
        this.checkAwaiting(above)
      }
    }
    if (released || (before && before.state.kind === "working" && entry.state.kind !== "working")) void this.drain()
  }

  private checkHolds(child: string): void {
    for (const hold of this.holds) if (hold.child === child) hold.check()
  }

  /**
   * A Fin's harness waits on a question or an approval: the Apex hears it as
   * `blocked`, keyed by what it waits on, told whether it may answer. One it
   * may answer that it leaves for `APEX_ANSWER_MS` goes to the person too
   * (`escalate`), so no ask sits on an Apex busy with a long turn of its own.
   */
  private askApex(edge: ThreadParent): void {
    // Its harness's own ask, which an answer reaches: what only waits on the person (needs-you) no Apex answers, and its
    // row says it's theirs (`waitingOf`).
    const conversation = this.answeringConversation(edge.child)
    const waiting = conversation ? this.deps.live.waitingOn(conversation) : undefined
    if (!conversation || !waiting) {
      this.asked.delete(edge.child)
      this.unwatch(edge.child)
      return
    }
    if (this.asked.get(edge.child) === waiting.line) return
    this.asked.set(edge.child, waiting.line)
    this.unwatch(edge.child)
    const pending = this.deps.live.pendingAsk(conversation)
    const ask = pending ? nativeAsk(pending) : undefined
    const why = this.personsBecause(edge, ask, waiting.line)
    hostLog("agents", "ask routed", { op: edge.op, child: edge.child, ask: ask?.kind ?? waiting.for, to: why ? "person" : "apex" })
    const asked = {
      child: ThreadIdSchema.parse(edge.child),
      status: "blocked" as const,
      summary: `It waits: ${waiting.line}`,
      ...(ask?.options && { options: ask.options }),
      implicit: true as const,
      ownerGeneration: this.generation,
    }
    if (why) {
      const tier = this.belowFull(edge, ask)
      if (tier && reportRoute(edge.asked, "blocked") === "apex" && !this.passed(edge, ask))
        this.keepReport(edge, { ...asked, id: personsId(edge.child, waiting.line), question: personsApproval(waiting.line, tier), for: "person", told: true, at: this.now() })
      return
    }
    this.keepReport(edge, { ...asked, id: `report:${edge.child}:waiting:${namedUuid(waiting.line)}`, question: apexAsk(waiting.line, ask?.kind === "approval"), at: this.now() })
    const line = waiting.line
    this.unanswered.set(edge.child, this.later(this.deps.apexAnswerMs ?? APEX_ANSWER_MS, () => this.escalate(edge.child, line, ask)))
  }

  private unwatch(child: string): void {
    this.unanswered.get(child)?.()
    this.unanswered.delete(child)
    this.escalated.delete(child)
  }

  /**
   * The live engine stamped activity in a conversation: its output, a step, a turn beginning. A Fin's quiet starts again
   * (`QuietWatch`); any other conversation's costs a set lookup. Called on every stamp, so it reads no store row twice.
   */
  active(conversation: string): void {
    if (this.stopped || this.notFins.has(conversation)) return
    const child = this.childOfConversation(conversation)
    if (!child) {
      this.notFins.add(conversation)
      return
    }
    this.quiet.activity(child)
  }

  /**
   * Whether a Fin's quiet means anything: it reads as working on Mako's live driver, by the same `atWork` its row reads,
   * and waits on nothing that explains a pause (the person's answer, its own Fins, its move, a usage limit). A Fin
   * placed elsewhere or run by a process Mako follows is its own host's or process's to watch.
   */
  private quietWorking(child: string): boolean {
    const edge = this.store()?.edges().of(child)
    if (!edge || edge.closedAt !== undefined || edge.placed || (edge.run && !edge.run.ended)) return false
    const conversation = this.askingConversation(child)
    if (!conversation || !this.deps.live.atWork(conversation)) return false
    if (this.personWaiting(conversation) !== undefined || this.messageHold(conversation)) return false
    const reading = this.childReading(edge)
    // One whose last word handed its Apex a wait on someone else is waiting, not quiet.
    return reading.working === true && reading.awaiting === undefined && reading.waiting === undefined && !this.latest.get(child)?.awaits
  }

  /**
   * A working Fin was quiet `QUIET_MS` since `since`: its Apex hears it once, in its digest, with its last step and
   * whether that still runs, so it decides (read it, ask it, stop it, or leave a long command be). Not a report: kept
   * nowhere, it changes how the Fin reads in nothing. A Fin whose spawn asked to be heard only on results, or never,
   * isn't named.
   */
  private tellQuiet(child: string, since: number): void {
    const edge = this.store()?.edges().of(child)
    if (!edge || edge.closedAt !== undefined || edge.remote) return
    const wake = edge.asked.wake ?? "decisions"
    const conversation = this.askingConversation(child)
    const held = conversation ? this.deps.live.held(conversation) : undefined
    const blocks = held?.blocks.slice(-24) ?? []
    const harness = this.harnessOf(edge)
    const step = lastStep(blocks, harness)
    const tool = [...blocks].reverse().find((block) => block.type === "tool")
    const running = tool?.type === "tool" && (tool.status === "pending" || tool.status === "running") && blocks.at(-1) === tool
    const forMs = this.now() - since
    this.quietSteps.set(child, { since, ...(step && { step: step.slice(0, 400) }), ...(running && { running: true as const }) })
    // Its row reads quiet now, whoever its notice goes to.
    this.childMoved(edge, true)
    hostLog("agents", "fin quiet", { op: edge.op, forMs, ...(step && { step }), ...(running && { running }), told: wake === "decisions" })
    if (wake !== "decisions") return
    const front = this.frontOf(edge.parent, edge.parentSession)
    if (!front) return
    const quiet = { since, forMs, ...(step && { step: step.slice(0, 400) }), ...(running && { running: true as const }) }
    const report: Report = {
      id: `${QUIET_PREFIX}${child}:${since}`,
      child: ThreadIdSchema.parse(child),
      status: "progress",
      summary: quietLine(quiet),
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    }
    this.wakes.notice(front, this.rootOf(edge.parent), {
      id: `notice:${report.id}`,
      report,
      label: `"${edge.name}" (${this.deps.harnessLabel(harness)})`,
      fin: { name: edge.name, harness },
      from: this.store()?.thread(edge.child)?.sessions[0] ?? edge.parentSession,
      quiet,
    })
  }

  /** A quiet stretch ended: the Fin did something, or left work. Its row reads as it is again. */
  private quietChanged(child: string): void {
    this.quietSteps.delete(child)
    if (this.stopped) return
    const edge = this.store()?.edges().of(child)
    if (edge) this.childMoved(edge, true)
  }

  private later(ms: number, run: () => void): () => void {
    if (this.deps.later) return this.deps.later(ms, run)
    const timer = setTimeout(run, ms)
    timer.unref()
    return () => clearTimeout(timer)
  }

  /**
   * A Fin that finished with a decision its Apex makes: one the Apex leaves
   * for `APEX_ANSWER_MS` goes to the person too, as an ask its harness asks
   * does (`escalate`). The minute is the Apex's to answer in, so it starts
   * when the Apex hears the decision (`decisionHeardAt`), never when the Fin
   * reported it: an Apex mid-turn on a harness that hears a digest only at
   * its turn's end can't answer what it hasn't been sent. Until then the
   * decision waits at most `DECISION_HEARD_BY_MS` from its report, and then
   * goes to the person as before. Watched from its report, so a host that
   * starts with one open watches it again, with the same times: both are read
   * from what's kept.
   */
  private watchDecision(edge: ThreadParent): void {
    const state = this.stateOf(edge)
    const pending = this.pendingReports(edge).find((report) => report.retainsQuestion && decisionOn(edge.asked, report) === "lead")
    const report = pending?.id ?? (!this.latestOf(edge.child)?.retainsQuestion && state.kind === "ended" && state.decision?.on === "lead" ? state.decision.ask?.id : undefined)
    const held = this.undecided.get(edge.child)
    if (!report) {
      held?.cancel()
      this.undecided.delete(edge.child)
      return
    }
    const heard = this.decisionHeardAt(edge, report)
    // Watched already: armed again only as it's first heard, when the wait to be heard becomes the minute to answer.
    if (held?.report === report && (held.heard || heard === undefined)) return
    held?.cancel()
    this.undecided.delete(edge.child)
    const window = this.deps.apexAnswerMs ?? APEX_ANSWER_MS
    const now = this.now()
    const reported = pending?.at ?? this.latest.get(edge.child)?.at ?? now
    const delay = heard === undefined
      ? Math.max(0, reported + (this.deps.focusMs ?? FOCUS_MS) + window - now)
      // A question kept by its ID keeps its due time across a restart; one from before those IDs has its minute again, as it had.
      : pending ? Math.max(0, heard + window - now) : window
    this.undecided.set(edge.child, { report, heard: heard !== undefined, cancel: this.later(delay, () => this.escalateDecision(edge.child, report)) })
  }

  /**
   * When its Apex's harness took a Fin's decision: the handoff of the digest that carries its notice, or of the turn
   * that digest was folded into; for one steered into a running turn, or heard another way (a `wait` start's answer),
   * when the store marked it heard. Undefined while it waits in the Apex's queue, while a steer carrying it is
   * unanswered, while its Apex's conversation isn't in memory, and while nobody has heard it: the Apex couldn't have
   * answered it yet. Read from the Apex's queue and the store, so it's the same after a restart.
   */
  private decisionHeardAt(edge: ThreadParent, report: string): number | undefined {
    const id = `notice:${edge.child}:${report}`
    if (this.wakes.steered(id)) return undefined
    const apex = this.frontOf(edge.parent, edge.parentSession)
    const requests = apex ? this.deps.live.held(apex)?.requests : undefined
    if (!requests) return undefined
    const carriers = requests.filter((request) => (request.status !== "canceled" || request.joinedInto !== undefined) && request.digest?.notices.some((notice) => notice.id === id))
    // No digest carries it: it went as a steer, or was heard without one, and the store's receipt says when.
    if (!carriers.length) return this.store()?.reportDeliveredAt(report)
    let heard: number | undefined
    for (const carrier of carriers) {
      const sent = carrier.joinedInto === undefined ? carrier : requests.find((each) => each.id === carrier.joinedInto) ?? carrier
      if (!handedOver(sent)) continue
      const at = sent.dispatchedAt ?? sent.digest?.sentAt ?? this.now()
      if (heard === undefined || at < heard) heard = at
    }
    return heard
  }

  /** Something their Apex's harness took may have carried these Fins' decisions: each is looked at again (`watchDecision`). */
  private decisionsHeard(children: readonly string[]): void {
    for (const child of children) {
      const edge = this.store()?.edges().of(child)
      if (edge) this.watchDecision(edge)
    }
  }

  /** Its Apex left a Fin's decision `APEX_ANSWER_MS` after hearing it, or didn't hear it in `DECISION_HEARD_BY_MS`: the person is asked too, and the Apex told so, as a done report of the same decision. */
  private escalateDecision(child: string, id: string): void {
    if (this.undecided.get(child)?.report === id) this.undecided.delete(child)
    const store = this.store()
    const edge = store?.edges().of(child)
    if (this.stopped || !store || !edge || edge.closedAt !== undefined) return
    const state = this.stateOf(edge)
    const retained = this.pendingReports(edge).find((report) => report.retainsQuestion && report.id === id && decisionOn(edge.asked, report) === "lead")
    const from = retained ?? this.latest.get(child)
    if (!retained && from?.retainsQuestion) return
    if (!retained && (state.kind !== "ended" || state.decision?.on !== "lead" || state.decision.ask?.id !== id || from?.id !== id)) return
    if (!from) return
    const front = this.frontOf(edge.parent, edge.parentSession)
    const busy = front !== undefined && this.ready(front) === "queue"
    hostLog("agents", "decision escalated", { op: edge.op, child, after: this.deps.apexAnswerMs ?? APEX_ANSWER_MS, busy, heard: this.decisionHeardAt(edge, id) !== undefined })
    if (front && this.wakes.withdraw(front, `notice:${child}:${id}`)) store.markReportsDelivered([id], this.now())
    this.keepReport(edge, { ...from, id: personsId(child, id), for: "person", told: true, ...(from.retainsQuestion && { supersedes: [id] }), ownerGeneration: this.generation, at: this.now() })
  }

  /**
   * The Apex left its Fin's ask `line` unanswered past `APEX_ANSWER_MS`: the
   * person is asked too, through every surface that reads the Fin's state
   * (the Inbox, a notification, the phone), and the Apex hears that they
   * were, and that it may still answer. A digest still waiting with the
   * first notice gives way to this one.
   */
  private escalate(child: string, line: string, ask: FinAsk | undefined): void {
    this.unanswered.delete(child)
    if (this.stopped || this.asked.get(child) !== line) return
    const store = this.store()
    const edge = store?.edges().of(child)
    if (!store || !edge || edge.closedAt !== undefined) return
    const ms = this.deps.apexAnswerMs ?? APEX_ANSWER_MS
    const within = waitWords(ms)
    const front = this.frontOf(edge.parent, edge.parentSession)
    const busy = front !== undefined && this.ready(front) === "queue"
    this.escalated.set(child, { line, why: `its ${APEX_WORD} ${busy ? "is mid-turn and " : ""}didn't answer within ${within}` })
    hostLog("agents", "ask escalated", { op: edge.op, child, after: ms, busy })
    const first = `report:${child}:waiting:${namedUuid(line)}`
    if (front && this.wakes.withdraw(front, `notice:${child}:${first}`)) store.markReportsDelivered([first], this.now())
    this.keepReport(edge, {
      id: personsId(child, line),
      child: ThreadIdSchema.parse(child),
      status: "blocked",
      summary: `It waits: ${line}`,
      question: apexAsk(line, ask?.kind === "approval", `you ${busy ? "are mid-turn and " : ""}didn't answer within ${within}`),
      ...(ask?.options && { options: ask.options }),
      implicit: true,
      ownerGeneration: this.generation,
      at: this.now(),
    })
  }

  /** Seconds since a Fin last did anything (`idleFor`): its transcript's last activity, else its last report or end. */
  private idleOf(edge: ThreadParent, state: ChildState, reading: ChildThread): number | undefined {
    const at = reading.updatedAt ?? this.latest.get(edge.child)?.at ?? reading.ended?.at ?? edge.closedAt ?? edge.createdAt
    return idleFor(state, at, this.now())
  }

  /** A Fin's open pull requests from what this host holds: its worktree branches' as last read, and its reports' (`finPullRequests`). */
  private openPRsOf(edge: ThreadParent): FinPullRequest[] {
    const store = this.store()!
    const held = this.deps.heldPulls
      ? store.worktrees().filter((worktree) => worktree.thread === edge.child).flatMap((worktree) => this.deps.heldPulls!(worktree.repoRoot, worktree.branch))
      : []
    const reports = this.reportsOf(edge.child)
    const key = JSON.stringify(held)
    if (reports.open?.held !== key) reports.open = { held: key, found: finPullRequests(held, reports.pulls) }
    return reports.open.found
  }

  /**
   * What a Fin's reports say (`ReportsHeld`), from what's held while its newest report is the one the store has, and
   * read from the store otherwise: a Fin with no new report costs no read and no parse.
   */
  private reportsOf(child: string): ReportsHeld {
    this.sync()
    const latest = this.latest.get(child)?.id
    const held = this.reportsHeld.get(child)
    if (held && held.last === latest) return held
    const reports = this.store()?.reportsOf(child, 0) ?? []
    const read: ReportsHeld = { last: reports.at(-1)?.id, pulls: reports.flatMap((report) => (report.artifacts?.some((artifact) => artifact.kind === "pull-request") ? [{ artifacts: report.artifacts }] : [])), marks: reports.map(reportMark) }
    this.reportsHeld.set(child, read)
    return read
  }

  /**
   * A report was kept, by this host or another: what's held of its Fin's reports takes it in when it follows the one
   * held last, and is dropped otherwise, to be read again when next asked for. Called before `latest` moves to it.
   */
  private reportKept(report: Report): void {
    const held = this.reportsHeld.get(report.child)
    if (!held) return
    if (held.last === report.id) return
    if (held.last !== this.latest.get(report.child)?.id) return void this.reportsHeld.delete(report.child)
    held.last = report.id
    held.marks.push(reportMark(report))
    if (report.artifacts?.some((artifact) => artifact.kind === "pull-request")) {
      held.pulls.push({ artifacts: report.artifacts })
      delete held.open
    }
  }

  /**
   * A Fin `foldList` drops whatever the budget, as its row's change mark would read it; undefined for one that's
   * listed. One closed as finished (`closeFinished`: ended six hours and more, nothing open), and one that ended over
   * `LIST_ENDED_FOR_MS` ago with nothing open: no question, no decision, no action it reported or holds, no wait. Read
   * from what the engine holds, so a tree's old Fins cost a list no row each. `scope: all` asks this of none.
   */
  private unlisted(edge: ThreadParent, now: number, actions: ReadonlySet<string>): ChangeFacts | undefined {
    // A Fin placed elsewhere is listed by its device's word, which takes this row's place (`listPlaced`).
    if (edge.placed) return undefined
    const state = this.stateOf(edge)
    if (state.kind !== "ended" || state.decision || waitingWords(state.waitingOn)) return undefined
    if (actions.has(edge.child) || this.pendingReports(edge).length) return undefined
    const latest = this.latestOf(edge.child)
    if (!closedFinished(edge)) {
      const idle = this.idleOf(edge, state, this.childReading(edge))
      const moved = idle === undefined ? latest?.at ?? edge.createdAt : now - idle * 1000
      if (now - moved <= LIST_ENDED_FOR_MS) return undefined
    }
    const pulls = this.openPRsOf(edge)
    return { state, ...(latest && { report: { status: latest.status, at: latest.at } }), ...(pulls.length && { pulls }), questions: 0, actions: 0, owes: this.owesApex(edge) }
  }

  private strip(edge: ThreadParent, under?: string, actions?: ReadonlySet<string>): AgentStrip {
    const reading = this.childReading(edge)
    const latest = this.latestOf(edge.child)
    const state = this.stateOf(edge)
    const waiting = state.kind === "idle" && state.waitingOn?.length
      ? waitingStateWords(state.waitingOn, state.since, this.now())
      : (state.kind === "blocked" || state.kind === "ended") && waitingWords(state.waitingOn)
    const idle = this.idleOf(edge, state, reading)
    const pulls = this.openPRsOf(edge)
    const pendingQuestions = this.pendingReports(edge).length
    // Only a Fin a pending action names, as its reporter or its owner, has any to count.
    const acts = (actions ?? this.store()!.pendingActionThreads()).has(edge.child)
    const pendingActions = acts ? this.pendingActions(edge.parent, edge.child).total : 0
    const custodyActions = acts ? this.store()!.reportCustody(edge.child).total : 0
    const owes = this.owesApex(edge)
    return {
      child: edge.child,
      name: edge.name,
      ...(under && { under }),
      harness: reading.harness ?? this.harnessOf(edge),
      ...((reading.model ?? edge.asked.model) && { model: reading.model ?? edge.asked.model }),
      ...(reading.runsOn && { runsOn: finTuningLine(reading.runsOn) }),
      ...(edge.tuned?.rule && { rule: ruleWords(edge.tuned.rule) }),
      ...(edge.tuned?.rerouted?.line && { moved: edge.tuned.rerouted.line }),
      origin: edge.origin,
      state,
      ...(reading.title && { title: reading.title }),
      ...(reading.toolUses && { toolUses: reading.toolUses }),
      ...(latest && { report: { status: latest.status, ...(latest.unfinished && { unfinished: true as const }), line: latest.unfinished ? latest.summary.split("\n", 1)[0]!.slice(0, 400) : reportPhase(latest) ?? latest.status, at: latest.at } }),
      ...(pendingQuestions && { pendingQuestions }),
      ...(pendingActions && { pendingActions }),
      ...(custodyActions && { custodyActions }),
      ...(owes && { owes }),
      ...(waiting && { waiting }),
      ...(idle !== undefined && { idleFor: idle }),
      ...(pulls.length && { openPRs: pulls }),
      ...(edge.placed && edge.asked.place && { place: edge.asked.place }),
      startedAt: edge.createdAt,
    }
  }

  private reportText(edge: ThreadParent, state: ChildState, selected?: Report): string {
    const latest = selected ?? this.latestOf(edge.child)
    if (!latest) return `${this.latest.has(edge.child) ? "No current report" : "No report yet"}. It is ${state.kind}${state.kind === "working" && state.step ? `: ${state.step}` : ""}.`
    const lines = [`${latest.status}${latest.implicit ? " (its turn ended without a report; this is its last reply)" : ""}:`, latest.summary]
    if (latest.question) lines.push(`Question: ${latest.question}`)
    if (latest.options?.length) lines.push(`Options: ${latest.options.map((option) => `${option.label}${option.detail ? ` (${option.detail})` : ""}`).join(" · ")}`)
    const waiting = waitingWords(latest.waitingOn)
    if (waiting) lines.push(waiting)
    for (const artifact of latest.artifacts ?? []) lines.push(`${artifact.kind}: ${artifact.ref}${artifact.label ? ` (${artifact.label})` : ""}`)
    const pending = this.pendingReports(edge)
    if (pending.length) {
      lines.push("Pending report questions (reading does not resolve them):")
      for (const report of pending.slice(0, 8)) lines.push(`ask ${report.id} · ${decisionOn(edge.asked, report) === "lead" ? "Apex" : "person"}: ${report.question!.replace(/\s+/g, " ").slice(0, 400)}`)
      if (pending.length > 8) lines.push(`${pending.length - 8} more; agents_read afterAsk: ${pending[7]!.id} pages their exact IDs.`)
    }
    return lines.join("\n")
  }

  private async transcript(edge: ThreadParent): Promise<string> {
    const reading = this.childReading(edge)
    const entries = reading.source === "followed"
      ? await this.runs.tail(edge.child, READ_ENTRIES)
      : reading.path ? (await this.deps.catalog.page(reading.path, undefined, READ_ENTRIES).catch(() => null))?.entries ?? [] : []
    if (!entries.length) return "Its transcript has nothing this device can read yet."
    return entries.map(entryLine).filter(Boolean).join("\n")
  }

  // ── Who and where ──

  private apexOf(caller: AgentCaller): Apex | AgentRefused {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: `${FIN_WORD}s need the Thread store, which didn't open.` }
    if (caller.kind === "apex") return this.apexAway(caller)
    if (caller.kind !== "agent")
      return { refused: "no-parent", why: `Only a Thread's agent is an ${APEX_WORD}: call it from a Thread's mako tools, or from its shell, where MAKO_SESSION_ID names it.` }
    const session = SessionIdSchema.safeParse(caller.session)
    const placed = session.success ? store.sessionPlacement(session.data) : undefined
    if (!placed) return { refused: "no-parent", why: "No Thread has that Session." }
    const conversation = this.conversationOfSession(placed.session)
    return { session: placed.session, thread: placed.thread, ...(conversation && { conversation }) }
  }

  /**
   * An Apex on another device, calling for the Fins it placed here: its access is at most this device's ceiling for
   * such Fins, and hearing from it says its device is back, so the notices that waited for it go now.
   */
  private apexAway(caller: ApexCaller): Apex | AgentRefused {
    const thread = ThreadIdSchema.safeParse(caller.thread)
    const session = SessionIdSchema.safeParse(caller.session)
    if (!thread.success || !session.success || !z.string().uuid().safeParse(caller.device).success)
      return { refused: "no-parent", why: `An ${APEX_WORD} on another device names its device, Thread and Session by their IDs.` }
    const ceiling = this.deps.placedCeiling?.() ?? PLACED_CEILING
    this.places?.heard(caller.device)
    return {
      session: session.data,
      thread: thread.data,
      away: { device: caller.device, access: childAccess(ceiling, caller.access) ?? ceiling, ...(caller.conversation && { conversation: caller.conversation }), ...(caller.forwards !== undefined && { forwards: caller.forwards }), ...(caller.epoch !== undefined && { epoch: caller.epoch }) },
    }
  }

  /** This Apex as another place hears it call for a Fin it placed there (`ApexCaller`). */
  private async callerOf(apex: Apex, forwards?: string, epoch?: number): Promise<ApexCaller | AgentRefused> {
    const device = await this.places?.self()
    if (!device) return { refused: "unavailable", why: `This device isn't signed in to Mako now, so it can't reach the ${FIN_WORD}s it placed elsewhere.` }
    return { kind: "apex", device, thread: apex.thread, session: apex.session, ...(apex.conversation && { conversation: apex.conversation }), access: this.tierOf(apex), ...(forwards !== undefined && { forwards }), ...(epoch !== undefined && { epoch }) }
  }

  /**
   * How a Fin here stands as its device sends a notice of `report`: whether it holds a place, and the newest of its
   * Apex's messages it has heard. One that asks through its harness waits on the answer, whatever its turn shows as
   * the ask is made.
   */
  private standingOf(edge: ThreadParent, report: Report): NonNullable<AgentsNoticeInput["standing"]> {
    const asks = report.implicit === true && (report.status === "blocked" || report.status === "needs-input")
    const working = !asks && this.occupies(edge)
    this.standingSaid.set(edge.child, working)
    return { heard: edge.remote?.heard ?? 1, working, ...this.saidNow() }
  }

  /**
   * This host's next word on a Fin here, in the order every device sorts its words by: its generation, which a host
   * that restarts takes afresh and higher, then its count of sayings in this life.
   */
  private saidNow(): SaidMark {
    this.standingSeq += 1
    return { owner: this.generation, seq: this.standingSeq }
  }

  /** An Apex on another device sets its Fin here to work, or stops it: its device knows that from its own call, so it isn't said back (`restate`). */
  private toldBy(apex: Apex, edge: ThreadParent, working: boolean): void {
    if (apex.away && edge.remote) this.standingSaid.set(edge.child, working)
  }

  /** A Fin here stands otherwise than its Apex's device last heard: its last report goes again, saying how (`AgentPlaces.restate`). */
  private restate(edge: ThreadParent): void {
    const report = this.latest.get(edge.child)
    if (report && report.status !== "progress" && this.noticeFor(edge, report)) this.places?.restate({ edge, report })
  }

  /** A message, an answer or a stop of an Apex on another device reached its Fin here: the count it came with is the newest this Fin heard (`RemoteParent.heard`). */
  private heardFrom(apex: Apex, edge: ThreadParent): void {
    if (apex.away?.epoch !== undefined && edge.remote) this.store()!.keepHeard(edge.child, apex.away.epoch)
  }

  /** One of this Apex's operations on a Fin it placed, answered by the Fin's device (`AgentPlaces.ask`). */
  private async askPlace<Answer extends object>(apex: Apex, edge: ThreadParent, channel: string, input: PlacedAsk, what: string, forwards?: string, epoch?: number): Promise<Answer | AwayRefused> {
    const caller = await this.callerOf(apex, forwards, epoch)
    if ("refused" in caller) return caller
    if (!this.places || !edge.placed) return { refused: "unavailable", why: `${edge.name} isn't placed anywhere this device can reach.` }
    return this.places.ask<Answer>(edge.placed.target, channel, caller, input, what)
  }

  /** The Apex of a Fin, from its edge: the Session that started it, and that Session's conversation here. */
  private apexOfEdge(edge: ThreadParent): Apex {
    const conversation = this.conversationOfSession(edge.parentSession)
    return { session: edge.parentSession, thread: edge.parent, ...(conversation && { conversation }) }
  }

  /**
   * A discovered sibling is readable crew, not an authorized send target: what it was sent goes to the Apex instead, as
   * a handoff that wakes it (`Report.handoff`, carrying the words), and the Apex passes it on in one step. The send is
   * still refused (`relayed`): nothing reached the sibling.
   */
  private unsendableFin(caller: Apex, input: AgentsSendInput): AgentRefused {
    const edges = this.store()!.edges()
    const own = edges.of(caller.thread)
    const sibling = own && edges.children(own.parent).find((edge) => edge.child !== caller.thread && (edge.child === input.to || edge.name === finName(input.to)))
    if (!own || !sibling) return unknownFin(input.to)
    const report: Report = {
      id: `report:${own.child}:relay:${input.clientKey}`,
      child: ThreadIdSchema.parse(own.child),
      status: "progress",
      summary: `Pass this to ${sibling.name}: ${input.text}`,
      handoff: { to: sibling.name, child: ThreadIdSchema.parse(sibling.child), text: input.text },
      ownerGeneration: this.generation,
      at: this.now(),
    }
    const kept = this.keepReport(own, report)
    if ("refused" in kept) return kept
    return { refused: "relayed", why: `${sibling.name} (${sibling.child}) is your sibling, owned by your ${APEX_WORD} (${sibling.parent}); you can't send to it. Your message went to your ${APEX_WORD} instead, which it wakes, to pass on to ${sibling.name}: nothing reached ${sibling.name} directly (report ${kept.report.id}).` }
  }

  /** Another open Fin of `edge`'s Apex, by its name, `fin:<name>` or its Thread. */
  private siblingOf(edge: ThreadParent, ref: string): ThreadParent | undefined {
    const name = finName(ref)
    return this.store()!.edges().children(edge.parent).find((other) => other.child !== edge.child && !edgeStopped(other) && (other.child === ref || other.name === name))
  }

  /**
   * Another Fin of `edge`'s Apex a report hands work to in its words: only as `fin:<name>`, the explicit form. A bare
   * name or a Thread is a mention ("waiting on loop-holds' PR"), not a handoff.
   */
  private siblingNamed(edge: ThreadParent, text: string): ThreadParent | undefined {
    const words = text.toLowerCase()
    return this.store()!.edges().children(edge.parent).find((other) => {
      if (other.child === edge.child || edgeStopped(other)) return false
      const said = `fin:${other.name.toLowerCase()}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      return new RegExp(`(^|[^a-z0-9_-])${said}($|[^a-z0-9_-])`).test(words)
    })
  }

  /** A Fin by its name, `fin:<name>` (`child:<name>` before the names) or its Thread: the Apex's own, or with `deep` a descendant's. */
  private resolve(apex: Apex, ref: string, deep: boolean): ThreadParent | undefined {
    const store = this.store()!
    const name = finName(ref)
    const look = (parent: string, depth: number): ThreadParent | undefined => {
      // An Apex on another device has only the Fins that device placed here.
      const children = store.edges().children(parent).filter((edge) => !apex.away || depth > 0 || edge.remote?.device === apex.away.device)
      const found = children.find((edge) => edge.child === ref || edge.name === name)
      if (found || !deep || depth > 64) return found
      for (const edge of children) {
        const below = look(edge.child, depth + 1)
        if (below) return below
      }
      return undefined
    }
    return look(apex.thread, 0)
  }

  private tierOf(apex: Apex): AccessTier {
    if (apex.away) return apex.away.access
    return (apex.conversation ? this.tierOfConversation(apex.conversation) : undefined) ?? "ask"
  }

  private tierOfConversation(conversation: string): AccessTier | undefined {
    return sessionAccessTier(this.deps.live.session(conversation))
  }

  /** The harness a Fin is on now: an automatic move's, which leaves what it was asked for as it was. */
  private harnessOf(edge: ThreadParent): string {
    const running = edge.run && !edge.run.ended ? edge.run.harness : undefined
    return running ?? edge.tuned?.rerouted?.to?.harness ?? edge.asked.harness ?? edge.run?.harness ?? "unknown"
  }

  /**
   * The Threads `context` names as `thread:<harness>:<id>` refs, each what a person's picker would have written, or a
   * refusal naming the one that isn't known or isn't this caller's to attach (`reachOf`). A ref goes as it is: a
   * reference the catalog can't place says so in its item, as a chip's does.
   */
  private threadRefs(apex: Apex, context: readonly AgentContextInput[] | undefined): readonly string[] | AgentRefused {
    if (!context?.length) return []
    const reach = this.reachOf(apex)
    const refs: string[] = []
    for (const { thread } of context) {
      const ref = this.threadRef(apex, thread)
      if (!ref) return { refused: "unknown-thread", why: `${thread} isn't a Thread here: name it by a thread:<harness>:<id> ref, a Thread ID or a ${FIN_WORD}'s name. agents_list with scope threads finds one.` }
      if (!reach(ref)) return { refused: "access", why: `${thread} is outside this ${FIN_WORD}'s reach: it attaches Threads of its own tree and those it holds by reference. Its ${APEX_WORD} can hand one down with context.` }
      refs.push(ref)
    }
    return refs
  }

  /**
   * What this caller may attach or find, the one check for both, since what's attached can be read and exported
   * (`thread_history`). The person's picker offers everything to the Apex they talk to, whose every attach shows as a
   * chip in its Thread. A Fin below reaches its own tree and what it holds by reference, so a Thread comes down only as
   * an Apex deliberately hands it on. This scopes what agents are offered and can ask Mako for; it isn't a sandbox. A
   * Fin's shell runs as the person, so `mako send` reaches the host as them, and a chip written that way is theirs.
   * Keys are the harness and the ids a ref can carry, so spellings of one session match.
   */
  private reachOf(apex: Apex): (ref: string) => boolean {
    const store = this.store()!
    if (!store.edges().of(apex.thread)) return () => true
    // Each harness's rows, once: a list is capped after it's filtered, so one of everything can hide all of a harness.
    const listed = new Map<string, { rows: ThreadRef[]; byId: Map<string, ThreadRef[]> }>()
    const listOf = (harness: string) => {
      const held = listed.get(harness)
      if (held) return held
      const rows = this.deps.references?.list({ harness }) ?? []
      const list = { rows, byId: referenceIndex(rows) }
      listed.set(harness, list)
      return list
    }
    const keysOf = (ref: string): string[] => {
      const token = parseThreadToken(ref)
      if (!token) return []
      const { rows, byId } = listOf(token.harness)
      const row = findThreadReference(byId.get(token.id) ?? rows, token.harness, token.id)
      return [token.id, ...(row ? [row.nativeId, threadReferenceId(row)] : [])].map((id) => `${token.harness}\0${id}`)
    }
    const tree = treeEdges(store.edges(), apex.thread)
    const family = [apex.thread, tree[0]?.parent, ...tree.map((edge) => edge.child)].flatMap((thread) => (thread ? this.refsOfThread(ThreadIdSchema.parse(thread)) : []))
    const held = heldReferences(this.conversationsOfThread(apex.thread).flatMap((conversation) => this.deps.live.snapshot(conversation)?.requests ?? []))
    const reached = new Set([...family, ...held.map((reference) => reference.ref)].flatMap(keysOf))
    return (ref) => keysOf(ref).some((key) => reached.has(key))
  }

  /** A ref as written, or the ref of a Thread by its ID or of a Fin of the caller's tree by its name. */
  private threadRef(apex: Apex, named: string): string | undefined {
    const bare = named.trim().replace(/^@/, "")
    if (parseThreadToken(bare)) return bare
    const store = this.store()!
    const name = finName(bare)
    const thread = treeEdges(store.edges(), apex.thread).find((edge) => edge.child === bare || edge.name === name)?.child ?? ThreadIdSchema.safeParse(bare).data
    if (!thread || !store.thread(thread)) return undefined
    return this.refOfThread(thread)
  }

  /** A Thread's ref: its newest session its harness keeps; `thread_history` reads every session of the Thread from any. */
  private refOfThread(thread: ThreadId): string | undefined {
    const natives = this.nativesOf(thread)
    const session = [...natives].reverse().find((native) => this.deps.catalog.nativePath({ harness: native.harness, nativeId: native.nativeId })) ?? natives.at(-1)
    return session && threadToken(session.harness, session.nativeId).slice(1)
  }

  private refsOfThread(thread: ThreadId): string[] {
    return this.nativesOf(thread).map((native) => threadToken(native.harness, native.nativeId).slice(1))
  }

  /**
   * The native sessions a Thread ran in, oldest first, from what's listed: a Fin's reach walks every Thread of its
   * tree, and reading each conversation in for this read 74 journals back at once.
   */
  private nativesOf(thread: ThreadId): { harness: string; nativeId: string }[] {
    const conversation = this.conversationOf(thread)
    const bindings = conversation ? this.deps.live.nativeIds(conversation).map(({ provider, nativeId }) => ({ harness: provider, nativeId })) : []
    if (bindings.length) return bindings
    const store = this.store()!
    return (store.thread(thread)?.sessions ?? []).flatMap((session) => store.sessionContents(session).natives.flatMap(({ path }) => {
      const row = this.deps.catalog.ref(path)
      return row ? [{ harness: row.harness, nativeId: row.nativeId }] : []
    }))
  }

  /**
   * An agent's words as a message, with the Threads `refs` names attached in the one format a person's chip writes and
   * stored as its grants. Its words go through the format too, so a block it spelled out is text, and draws as text.
   */
  private async withContext(words: string, refs: readonly string[]): Promise<{ text: string; grants?: string[] }> {
    const references = this.deps.references
    const items = refs.length && references
      ? await referenceItems(refs, (harness, id) => findThreadReference(references.list({ harness }), harness, id), (threads) => Promise.all(threads.map((thread) => references.transcriptArtifact(thread.path))))
      : []
    const grants = items.flatMap((item) => (item.attrs.ref ? [item.attrs.ref] : []))
    return { text: writeMessage({ body: words, items }), ...(grants.length > 0 && { grants }) }
  }

  /** What an `@` picker offers this caller (`reachOf`): by a Thread's ID or a Fin's name, else the conversations whose titles hold the words, newest first. */
  private threadsMatching(apex: Apex, query: string | undefined): AgentsThreads {
    const references = this.deps.references
    const reach = this.reachOf(apex)
    const rows = references?.list({}) ?? []
    const refOf = (row: ThreadRef) => threadToken(row.harness, threadReferenceId(row)).slice(1)
    const named = query ? this.threadRef(apex, query) : undefined
    if (named) {
      const token = parseThreadToken(named)
      const exact = token ? findThreadReference(rows, token.harness, token.id) : undefined
      return { threads: reach(named) ? [{ ref: named, harness: token?.harness ?? "", ...(exact?.title && { title: exact.title }), ...(exact?.updatedAt && { updatedAt: exact.updatedAt }) }] : [] }
    }
    const words = query?.trim().toLowerCase()
    const found = (words ? rows.filter((row) => row.title?.toLowerCase().includes(words)) : rows).filter((row) => reach(refOf(row))).slice(0, THREADS_LISTED)
    return { threads: found.map((row) => ({ ref: refOf(row), harness: row.harness, ...(row.title && { title: row.title }), ...(row.updatedAt && { updatedAt: row.updatedAt }) })) }
  }

  /** Whether a turn runs in it, or a message is on its way to its harness: nothing moves under either. */
  private inTurn(conversation: string): boolean {
    const status = this.deps.live.session(conversation)?.status
    return status === "running" || status === "starting" || Boolean(this.deps.live.held(conversation)?.requests.some((request) => request.status === "dispatching"))
  }

  /**
   * `agents_move`: the same Thread goes on on another harness, through the one operation (`continueOn`), under the
   * rules a start of it there would meet. Nothing is asked of the harness it leaves. It carries the message that waits
   * for its harness, if one does; a Stop's holds stay, so a stopped Fin stays stopped and goes on there when resumed.
   */
  async move(caller: AgentCaller, input: AgentsMoveInput): Promise<AgentsMoveResult> {
    const apex = this.apexOf(caller)
    if ("refused" in apex) return apex
    if (Boolean(input.all) === Boolean(input.child)) return { refused: "conflict", why: `Name one ${FIN_WORD} with child, or pass all: true.` }
    const op = `move:${apex.session}:${input.clientKey}`
    const kept = this.moveOps.get(op)
    if (kept) {
      const answer = await kept
      return "refused" in answer ? answer : { ...answer, deduped: true }
    }
    const moving = this.moveAll(apex, input, op)
    this.moveOps.set(op, moving)
    const answer = await moving
    if ("refused" in answer) this.moveOps.delete(op)
    return answer
  }

  private async moveAll(apex: Apex, input: AgentsMoveInput, op: string): Promise<AgentsMoveResult> {
    // A Fin placed elsewhere moves there, by that device's harnesses, accounts and rules (`moveAway`).
    const named = input.all ? undefined : this.resolve(apex, input.child!, true)
    if (named?.placed) {
      const one = await this.moveAway(apex, named, input)
      return "refused" in one ? this.refuse(op, one.refused, one.why) : { moved: [one] }
    }
    if (!this.deps.harnesses().includes(input.harness))
      return this.refuse(op, "unknown-harness", `No harness named ${input.harness} runs here: ${this.deps.harnesses().join(", ")}.`)
    // Owned from here, before anything is waited for: a Stop, a stop of the Fin or a turn that comes meanwhile declines it.
    const edges = input.all ? this.store()!.edges().children(apex.thread) : [named].flatMap((edge) => edge ?? [])
    const intents = new Map(edges.map((edge) => [edge.child, this.intentOf(edge)]))
    const limit = await this.limitOf(input.harness)
    if (limit) {
      const instead = limit.instead ? ` ${limit.instead}, another ${this.deps.harnessLabel(input.harness)} account, has room: the person can switch to it in Settings › Agents.` : ""
      return this.refuse(op, "limited", `${this.spentWords(input.harness, limit)}, so a ${FIN_WORD} moved there would stop at once.${instead} Name another harness, or move it after the reset.`)
    }
    if (!input.all) {
      const edge = edges[0]
      if (!edge) return unknownFin(input.child!)
      const one = await this.moveOne(apex, edge, input, op, intents.get(edge.child)!)
      return "refused" in one ? this.refuse(op, one.refused, one.why) : { moved: [one] }
    }
    const each = await Promise.all(edges.map(async (edge) => ({ edge, moved: await this.moveOne(apex, edge, input, op, intents.get(edge.child)!) })))
    const moved: AgentMoved[] = []
    const left: AgentNotMoved[] = []
    for (const one of each) {
      if ("refused" in one.moved) left.push({ name: one.edge.name, refused: one.moved.refused, why: one.moved.why })
      else moved.push(one.moved)
    }
    return { moved, ...(left.length && { left }) } satisfies AgentsMoved
  }

  /** What a move of `edge` is decided on, read as it's asked for: true while no Stop has come since and no turn runs. */
  private intentOf(edge: ThreadParent): () => boolean {
    const conversation = this.conversationOf(edge.child)
    const closed = edge.closedAt
    const mark = conversation ? this.deps.live.stopMark(conversation) : 0
    return () => {
      const now = this.conversationOf(edge.child)
      return this.store()!.edges().of(edge.child)?.closedAt === closed && (!conversation || this.deps.live.stopMark(conversation) === mark) && !(now && this.inTurn(now))
    }
  }

  /**
   * `agents_move` for a Fin placed elsewhere: its device moves it through its own `continueOn`, under the same key, and
   * this device's record of what it was asked follows once it's there.
   */
  private async moveAway(apex: Apex, edge: ThreadParent, input: AgentsMoveInput): Promise<AgentMoved | AgentRefused> {
    const one = { ...input }
    delete one.all
    const answer = await this.askPlace<AgentsMoved>(apex, edge, "mako:agents-move", { ...one, child: edge.child }, "move")
    if ("refused" in answer) return answer
    const left = answer.left?.[0]
    const moved = answer.moved[0]
    if (!moved) return left ? { refused: left.refused, why: left.why } : { refused: "unavailable", why: `${edge.name} didn't move: its device said nothing of it.` }
    if (moved.state !== "here") {
      const kept = this.store()!.moveEdge(edge.child, { harness: moved.harness, ...(edge.asked.access && { access: edge.asked.access }), ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }), ...(input.fast !== undefined && { fast: input.fast }) }, undefined)
      this.forget(edge.parent)
      this.childMoved(kept ?? edge, false)
    }
    return moved
  }

  private async moveOne(apex: Apex, edge: ThreadParent, input: AgentsMoveInput, op: string, wanted: () => boolean): Promise<AgentMoved | AgentRefused> {
    const { name } = edge
    if (edge.placed) return this.moveAway(apex, edge, input)
    if (edge.run && !edge.run.ended) return { refused: "conflict", why: `${name} runs in a process your shell started: agents_stop stops it, and then it can move.` }
    const taken = edge.run && !this.conversationOf(edge.child) ? await this.takeOver(edge) : undefined
    if (taken && "refused" in taken) return taken
    const conversation = this.conversationOf(edge.child)
    const session = conversation ? this.deps.live.session(conversation) : undefined
    if (!conversation || !session) return { refused: "unavailable", why: `${name}'s conversation isn't on this device.` }
    if (this.deps.archived?.(conversation)) return { refused: "conflict", why: `${name} was archived, which ends its work for good: the person can restore it, and then it can move.` }
    const from = session.harness
    const label = this.deps.harnessLabel(input.harness)
    const retunes = input.model !== undefined || input.reasoning !== undefined || input.fast !== undefined
    if (from === input.harness && !retunes) return { child: edge.child, name, from, harness: from, state: "here", hears: `${name} is on ${label} already.` }
    if (from === input.harness) return this.retune(apex, edge, conversation, input, op, wanted)
    if (this.inTurn(conversation)) return { refused: "conflict", why: `${name} is at work on ${this.deps.harnessLabel(from)}: it can move once its turn ends, or agents_stop stops it now.` }
    const own = this.tierOf(apex)
    const allowed = childAccess(own, edge.asked.access) ?? own
    const asked = { harness: input.harness, ...(session.cwd && { cwd: session.cwd }) }
    const fit = await this.fitAccess(apex, input.harness, allowed, own, asked, undefined)
    if ("refused" in fit) return { refused: "access", why: fit.refused }
    const mode = childMode(this.deps.modes(input.harness), fit.tier)
    if (!mode) return { refused: "access", why: `${label} runs on ${offered(this.deps.modes(input.harness))}, each above ${fit.tier}, the most this ${FIN_WORD} may have. Move it to another harness.` }
    const decided = await this.tuningOf(apex, input.harness, { ...asked, ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }), ...(input.fast !== undefined && { fast: input.fast }) })
    if ("refused" in decided) return { refused: "unknown-model", why: decided.refused }
    const moveId = namedUuid(`${op}\n${edge.child}`)
    const note = [fit.note, decided.note].filter(Boolean).join(" ")
    let snapshot: LiveSnapshot | undefined
    try {
      snapshot = await this.deps.continueOn(conversation, { kind: "move", move: { id: moveId, to: { harness: input.harness, modeId: mode.id, ...(decided.settings && { tuning: decided.settings }) } } }, { kind: "agent", session: SessionIdSchema.parse(apex.session) }, wanted)
    } catch (error) {
      return { refused: "unavailable", why: `${name} stayed on ${this.deps.harnessLabel(from)}: ${errorMessage({ error })}` }
    }
    if (!snapshot) return { refused: "conflict", why: `${name} stayed on ${this.deps.harnessLabel(from)}: a Stop or a turn came before it moved. Ask again to move it.` }
    const waiting = snapshot.requests.filter((request) => request.status === "queued" || holdOf(request)?.kind === "retry" || holdOf(request)?.kind === "sign-in").length
    const settled = this.deps.live.switchSettled(moveId)
    const landed = (at: ContextTransfer) => {
      if (at.state.kind !== "accepted") return
      const moved = this.store()!.moveEdge(edge.child, { harness: input.harness, access: mode.tier, ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }), ...(input.fast !== undefined && { fast: input.fast }) }, { source: decided.source, ...(note && { note }) })
      hostLog("agents", "moved", { op, child: edge.child, from, to: input.harness })
      this.forget(edge.parent)
      this.childMoved(moved ?? edge, false)
    }
    const outcome = await settledWithin(settled, MOVE_WAIT_MS)
    if (outcome?.state.kind === "failed" || outcome?.state.kind === "uncertain")
      return { refused: "unavailable", why: `${name} stayed on ${this.deps.harnessLabel(from)}: ${outcome.state.error}` }
    if (!outcome) void settled.then((late) => {
      if (late.state.kind === "accepted") return landed(late)
      this.keepReport(edge, { id: `report:${edge.child}:move:${moveId}`, child: ThreadIdSchema.parse(edge.child), status: "failed", summary: `${name} didn't move to ${label}: ${late.state.kind === "failed" || late.state.kind === "uncertain" ? late.state.error : "its move ended before it went"}. It stays on ${this.deps.harnessLabel(from)}.`, implicit: true, ownerGeneration: this.generation, at: this.now() })
    })
    else landed(outcome)
    const stopped = edgeStopped(this.store()!.edges().of(edge.child))
    const hears = stopped ? `${name} stays stopped: nothing runs until you message it, and what its stop paused goes there then.`
      : waiting ? `${name} takes what waited for it there now, with its whole conversation.`
        : `${name} runs nothing until your next message, which goes there with its whole conversation.`
    const runsOn = decided.settings?.model
    return { child: edge.child, name, from, harness: input.harness, state: outcome ? "moved" : "moving", ...(runsOn && { runsOn }), ...(note && { note }), hears }
  }

  /**
   * `agents_move` to the harness a Fin is on, naming a model, reasoning or fast: it stays in its session there and runs
   * on that from its next turn (`LiveConversations.moveOn`'s retune), the choice held to the harness's catalog as a
   * start's is. Its edge says what it runs on now.
   */
  private async retune(apex: Apex, edge: ThreadParent, conversation: string, input: AgentsMoveInput, op: string, wanted: () => boolean): Promise<AgentMoved | AgentRefused> {
    const { name } = edge
    const harness = input.harness
    const label = this.deps.harnessLabel(harness)
    const cwd = this.deps.live.session(conversation)?.cwd
    const decided = await this.tuningOf(apex, harness, { ...(cwd && { cwd }), ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }), ...(input.fast !== undefined && { fast: input.fast }) })
    if ("refused" in decided) return { refused: "unknown-model", why: decided.refused }
    if (!decided.settings) return { refused: "unknown-model", why: `${label} offers no model choice to change ${name} to.` }
    const moveId = namedUuid(`${op}\n${edge.child}`)
    try {
      const snapshot = await this.deps.continueOn(conversation, { kind: "move", move: { id: moveId, to: { harness, tuning: decided.settings } } }, { kind: "agent", session: SessionIdSchema.parse(apex.session) }, wanted)
      if (!snapshot) return { refused: "conflict", why: `${name} stays as it was: a Stop or a turn came before it changed. Ask again once its turn ends.` }
    } catch (error) {
      return { refused: "unavailable", why: `${name} stays as it was on ${label}: ${errorMessage({ error })}` }
    }
    const moved = this.store()!.moveEdge(edge.child, { harness, ...(edge.asked.access && { access: edge.asked.access }), ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }), ...(input.fast !== undefined && { fast: input.fast }) }, { source: decided.source, ...(decided.note && { note: decided.note }) })
    hostLog("agents", "retuned", { op, child: edge.child, harness, model: decided.settings.model ?? "" })
    this.forget(edge.parent)
    this.childMoved(moved ?? edge, false)
    const runsOn = decided.settings.model
    return {
      child: edge.child, name, from: harness, harness, state: "moved", ...(runsOn && { runsOn }), ...(decided.note && { note: decided.note }),
      hears: `${name} stays in its ${label} session and runs on ${runsOn ?? "the new choice"} from its next turn.`,
    }
  }

  /** A harness's account at its limit, in the words a start's refusal and a move's both say it. */
  private spentWords(harness: string, limit: HarnessLimit): string {
    const until = limit.until ?? undefined
    return `${this.deps.harnessLabel(harness)} is at its limit on ${limit.account}${until === undefined ? "" : ` until ${resetWords(until, this.now())}`}`
  }

  private rootOf(thread: string): string {
    return this.store()?.ancestors(thread).at(-1) ?? thread
  }

  /** How a tree stands against its budgets: Threads at work now, and Threads it started. */
  /** This Mac's load now, every tree's working Fins counted; undefined without a reading of it. */
  private async readMac(): Promise<MacLoad | undefined> {
    const reading = await this.deps.capacity?.read().catch((error: Error) => {
      hostWarn("agents", "this Mac's load couldn't be read; a start says nothing of it", { error: errorMessage({ error }) })
      return undefined
    })
    this.mac = reading ? macLoad(reading, this.working(HERE)) : undefined
    return this.mac
  }

  /**
   * The person's Fins at work in one place, every tree's, with the queued starts launching there; on this device, with
   * the operations it lends too, so its own Fins and another place's borrowed work share one pool.
   */
  private working(where: string): number {
    return this.finsWorking(where) + (where === HERE ? (this.deps.lent?.() ?? 0) : 0)
  }

  private finsWorking(where: string): number {
    return (this.store()?.edges().all ?? []).filter((edge) => placeOf(edge.asked.place) === where && this.occupies(edge)).length + this.unwritten((launch) => launch.where === where)
  }

  /** This device's own Fins at work, without what it lends: what its advertisement says its own work holds. */
  workingHere(): number {
    return this.finsWorking(HERE)
  }

  /** Queued starts launching that have no edge yet, so nothing else counts them. */
  private unwritten(which: (launch: { where: string; tree: string }) => boolean): number {
    const edges = this.store()?.edges()
    let count = 0
    for (const start of this.starts.values()) if (start.launching && which(start.launching) && !edges?.byOp(start.op)) count += 1
    return count
  }

  /** A place has more room: its capacity rose, or the person raised a number. What waits goes now. */
  capacityChanged(): void {
    void this.drain()
  }

  /**
   * Whether a Fin's turn a usage limit cut may go on: its place went while it waited, so it takes one again by the same
   * limits as a start. With no room it stays held, and the next place to free is its (`drain`).
   */
  mayWake(conversation: string): boolean {
    const child = this.childOfConversation(conversation)
    const edge = child ? this.store()?.edges().of(child) : undefined
    if (!edge) return true
    const room = this.full(placeOf(edge.asked.place)) === undefined && this.treeCounts(this.rootOf(edge.parent)).running < this.budget.running
    if (!room) this.wakingForRoom.add(conversation)
    return room
  }

  /** What a place's Fins at once are held to: a device's own count, or the cloud's plan and spend (`placeFull`). */
  private placeLimit(where: string): FinPlaceLimit {
    if (where === "cloud") return { place: "cloud", ...this.deps.cloudLimits?.() }
    return { place: "device", atOnce: this.deps.finLimit?.() ?? FIN_LIMIT }
  }

  /** Why a place takes no more now, with `more` already starting there; undefined while it has room. */
  private full(where: string, more = 0): string | undefined {
    return this.overCeiling(this.workingEverywhere() + more) ?? this.awayFull(where, more) ?? (this.places?.room(where) ? undefined : placeFull(this.placeLimit(where), this.working(where) + more))
  }

  /**
   * Why another device takes no more now, by what it last said of itself (`AgentsCapabilities.slots`): its own Fins
   * and other Apexes' count there, which this device can't see, so its word is the count. What this device is placing
   * there now, and `more`, come off it. Undefined while it has room, and for a place that was never asked.
   */
  private awayFull(where: string, more = 0): string | undefined {
    const room = where === HERE ? undefined : this.places?.room(where)
    if (!room) return undefined
    const free = room.slots.of - room.slots.used - this.unwritten((launch) => launch.where === where) - more
    return free > 0 ? undefined : `the ${room.slots.of} ${FIN_WORD}s ${where.slice("device:".length)} runs at once are at work`
  }

  /** The places queued starts wait for room in, asked again what they have: one that gained room starts what waits. */
  private async askRooms(): Promise<void> {
    const places = this.places
    if (!places) return
    this.retryStops()
    const waiting = new Map<string, PlaceTarget>()
    for (const spawn of this.store()?.queuedSpawns() ?? []) {
      const queued = parseQueued(spawn.record)
      // What waits for room there, and what was on its way there when its device, or this host, stopped answering.
      if (queued?.away && !queued.away.stop && !queued.refused && !this.starts.has(spawn.op)) waiting.set(placeOf(queued.input.place), queued.away.target)
    }
    const cloudWaits = [...waiting.values()].some((target) => target.kind === "cloud")
    for (const [where, target] of waiting) if (target.kind === "cloud") waiting.delete(where)
    if (cloudWaits) void this.drain()
    if (!waiting.size) return
    const had = new Set([...waiting.keys()].filter((where) => places.room(where) && this.awayFull(where) === undefined))
    await Promise.all([...waiting].map(([where, target]) => places.capabilities(target, where)))
    if ([...waiting.keys()].some((where) => !had.has(where) && places.room(where) && this.awayFull(where) === undefined)) void this.drain()
  }

  /** The places a start may name that have room now, as a refused start offers them: " The cloud has room: pass place: cloud." */
  private elsewhere(where: string): string {
    const open = (this.deps.places?.() ?? [HERE]).filter((place) => place !== where && !this.full(place))
    if (!open.length) return ""
    const named = open.map((place) => (place === HERE ? "this device" : place === "cloud" ? "the cloud" : place.slice("device:".length)))
    return ` ${upper(named.join(" and "))} ${open.length === 1 ? "has" : "have"} room: pass place: ${open.join(" or ")}.`
  }

  /** The person's ceiling across every place, when `working` Fins fill it. */
  private overCeiling(working: number): string | undefined {
    const ceiling = this.deps.finCeiling?.()
    return ceiling !== undefined && working >= ceiling ? `${working} of the person's ${ceiling} ${FIN_WORD}s at once across every place are at work` : undefined
  }

  /**
   * Whether the room watch has anything to read the room for: a Fin here at work (`atWork`), a start launching
   * without its edge yet, or one queued for a place. A Fin taking a place turns it on (`childMoved`), as does a start.
   */
  private roomNeeded(atWork: boolean): boolean {
    return atWork || this.unwritten(() => true) > 0 || (this.store()?.queuedSpawns().length ?? 0) > 0
  }

  private workingEverywhere(): number {
    return (this.store()?.edges().all ?? []).filter((edge) => this.occupies(edge)).length + this.unwritten(() => true)
  }

  /**
   * This device's Fins at work and their harnesses, for its capacity; with `sample`, each by its conversation too, so
   * what they cost is read. Only the periodic look samples: a start reads the machine, not every Fin's processes.
   */
  private async observe(sample = false): Promise<void> {
    if (sample) void this.askRooms()
    const mix: Record<string, number> = {}
    const fins: FinAtWork[] = []
    for (const edge of this.store()?.edges().all ?? []) {
      if (placeOf(edge.asked.place) !== HERE || !this.occupies(edge)) continue
      const conversation = this.conversationOf(edge.child)
      const at = conversation ? this.bindingAtWork(conversation, this.harnessOf(edge)) : undefined
      const harness = at?.harness ?? this.harnessOf(edge)
      mix[harness] = (mix[harness] ?? 0) + 1
      if (at) fins.push(at)
    }
    const working = Object.values(mix).reduce((sum, count) => sum + count, 0)
    // The look that finds nothing at work and nothing waiting is the last until something is: its reading of none
    // still goes to the capacity below, so the mix isn't left at the last Fin's.
    this.roomDemand.set(this.roomNeeded(working > 0))
    if (!this.deps.observeCapacity) return
    await this.deps.observeCapacity(working, mix, sample ? fins : undefined).catch((error: Error) =>
      hostWarn("agents", "this device's capacity couldn't be read; it keeps its last", { error: errorMessage({ error }) }))
  }

  /**
   * Whose processes a Fin's conversation runs on now: its active binding, by the ID its harness's processes are owned
   * by, on that binding's harness. A switch of harness moves both, so a Fin is measured as the harness it runs on now.
   */
  private bindingAtWork(conversation: string, harness: string): FinAtWork {
    const control = this.deps.live.snapshot(conversation)?.control
    const binding = control?.bindings.find((each) => each.id === control.activeBindingId)
    return { conversation: binding?.id ?? conversation, harness: binding?.provider ?? harness }
  }

  /** A Fin at work holds a place against the budgets; one only waiting for its own Fins or its move holds none, or they'd wait for it. */
  /**
   * Whether a Fin holds a place: by its run's own life, never by how it reads. From its launch until its harness has
   * finished, or finished cancelling, it holds one; a Fin shown stopped whose turn is still being cancelled still does.
   * One only waiting for its own Fins or its move, or on a question, holds none, or its Fins would wait for it.
   */
  private occupies(edge: ThreadParent): boolean {
    if (this.starting.has(edge.op)) return true
    // Closed as finished, it holds no place: nothing ran there as it closed, and what next reaches it opens it first.
    if (closedFinished(edge)) return false
    // The same answer `childReading` gives, without building what a Fin shows: the room watch, every admission and
    // every report ask it of each edge there is (260 on the person's Mac on 2026-11-12), and building each one's step,
    // model and title held the host's loop for hundreds of milliseconds at a time.
    if (edge.placed) return this.placedReading(edge).working === true
    const run = edge.run
    const conversation = this.askingConversation(edge.child)
    if (run && (!run.ended || !conversation || this.runs.isTerminating(edge.child))) {
      const reading = this.runs.reading(edge.child)
      return Boolean(reading?.starting) || (reading?.working === true && reading.awaiting === undefined && reading.waiting === undefined)
    }
    if (!conversation) return false
    const session = this.deps.live.session(conversation)
    if (!session) return false
    if (session.status === "starting") return true
    // Not at work, it reads as working only while it waits on its own Fins or its move, which holds no place.
    return this.deps.live.atWork(conversation) && this.personWaiting(conversation) === undefined
  }

  /** Spawns waiting for room in a place, every tree's; with none named, in every place. */
  private waitingForRoom(where?: string): number {
    return this.store()?.queuedSpawns().filter((spawn) => {
      const queued = parseQueued(spawn.record)
      return queued?.why === "place-full" && (where === undefined || placeOf(queued.input.place) === where)
    }).length ?? 0
  }

  /**
   * How a tree stands against its budgets: Threads at work now, and Threads it started, each start counted once
   * whether it's a written edge, a queue row, or a record under way between them (`StartRecord`).
   */
  private treeCounts(root: string): TreeCounts {
    const store = this.store()
    if (!store) return { running: 0, started: 0, startedHour: 0 }
    let running = 0
    // Each start once, at the first time it was asked for: queued, then given its edge, or launching now.
    const started = new Map<string, number>()
    const at = (op: string, time: number) => started.set(op, Math.min(started.get(op) ?? time, time))
    const now = this.now()
    const visit = (parent: string, depth: number) => {
      if (depth > 10_000) return
      for (const edge of store.edges().children(parent)) {
        at(edge.op, edge.createdAt)
        if (this.occupies(edge)) running += 1
        visit(edge.child, depth + 1)
      }
    }
    visit(root, 0)
    for (const spawn of store.queuedSpawns()) if (spawn.tree === root) at(spawn.op, spawn.at)
    for (const start of this.starts.values()) if (start.launching?.tree === root) at(start.op, now)
    // A spawn still waiting holds its place in the window, however long it waits: it hasn't started yet.
    const waiting = new Set(store.queuedSpawns().filter((spawn) => spawn.tree === root && !store.edges().byOp(spawn.op)).map((spawn) => spawn.op))
    const within = (windowMs: number, limit: number) => {
      const recent = [...started].filter(([op, time]) => time > now - windowMs || waiting.has(op))
      // One more fits once all but limit - 1 of them have left: the start that many places from the oldest frees it.
      const aging = recent.filter(([op]) => !waiting.has(op)).map(([, time]) => time).sort((left, right) => left - right)
      const freeing = aging[recent.length - limit]
      return { count: recent.length, ...(freeing !== undefined && { frees: freeing + windowMs }) }
    }
    const short = within(this.budget.windowMs, this.budget.started)
    const hour = within(HOUR_MS, this.budget.hourly)
    return {
      running: running + this.unwritten((launch) => launch.tree === root),
      started: short.count,
      ...(short.frees !== undefined && { frees: short.frees }),
      startedHour: hour.count,
      ...(hour.frees !== undefined && { freesHour: hour.frees }),
    }
  }

  /** A tree's counts as an answer says them, against its budget. */
  private treeAnswer(counts: TreeCounts): AgentsStarted["tree"] {
    return { running: counts.running, started: counts.started, startedHour: counts.startedHour, of: { ...this.budget } }
  }

  /** The words refusing a start for its tree's start rate, of whichever window is full and frees last; undefined while both have room. */
  private rateRefusal(counts: TreeCounts): string | undefined {
    const full = [
      ...(counts.startedHour >= this.budget.hourly ? [{ windowMs: HOUR_MS, started: counts.startedHour, frees: counts.freesHour }] : []),
      ...(counts.started >= this.budget.started ? [{ windowMs: this.budget.windowMs, started: counts.started, frees: counts.frees }] : []),
    ].sort((left, right) => (right.frees ?? Infinity) - (left.frees ?? Infinity))[0]
    return full && startRateWords(full, full.started, full.frees, this.now())
  }


  /** The digest's last line, for the parent `conversation`. */
  private counts(conversation: string): string {
    const thread = this.store()?.journalPlacement(conversation)?.thread
    return thread ? this.childCounts(thread) : ""
  }

  /** A Fin's move rides the next digest, said once: it never wakes its Apex by itself. From here it's that digest's. */
  private takeMoved(conversation: string): string[] {
    const thread = this.store()?.journalPlacement(conversation)?.thread
    const moved = (thread && this.movedNotes.get(thread)) || []
    if (thread) this.movedNotes.delete(thread)
    return moved
  }

  private giveMoved(conversation: string, lines: readonly string[]): void {
    const thread = this.store()?.journalPlacement(conversation)?.thread
    if (thread) this.movedNotes.set(thread, [...lines, ...this.movedNotes.get(thread) ?? []])
  }

  private childCounts(thread: string): string {
    const store = this.store()
    if (!store) return ""
    const tally = new Map<string, number>()
    for (const edge of store.edges().children(thread)) {
      const kind = this.stateOf(edge).kind
      tally.set(kind, (tally.get(kind) ?? 0) + 1)
    }
    const queued = this.queuedOf(thread).length
    const parts = [`${tally.get("working") ?? 0} working`]
    if (tally.get("starting")) parts.push(`${tally.get("starting")} starting`)
    if (queued) parts.push(`${queued} queued`)
    if (tally.get("blocked")) parts.push(`${tally.get("blocked")} blocked`)
    if (tally.get("idle")) parts.push(`${tally.get("idle")} idle`)
    parts.push(`${tally.get("ended") ?? 0} ended`)
    return `${parts.join(", ")}.`
  }

  /** Spawns held for a parent, as roster entries that say why. */
  private queuedOf(thread: string): NativeAgent[] {
    return this.heldFor(thread).map(({ placeholder, queued }) => childEntry(placeholder, { source: "live", queued }, {}))
  }

  /**
   * Spawns held for a parent, with why each waits and how many wait ahead of it. One projection, by op: a row is a
   * Fin's entry until its edge is written, then the edge is, so a Fin never shows twice while its launch answers. The
   * placeholder's `child` is the waiting entry's own ID, for agents_read and agents_stop; the Fin's Thread gets its own
   * ID once it starts.
   */
  private heldFor(thread: string): Array<{ op: string; placeholder: ThreadParent; queued: { reason: QueueReason; ahead: number; after?: string[]; held?: string; refused?: string; apexStopped?: true } }> {
    const store = this.store()
    if (!store) return []
    const spawns = store.queuedSpawns().filter((spawn) => !store.edges().byOp(spawn.op))
    return spawns.flatMap((spawn, at) => {
      const queued = parseQueued(spawn.record)
      if (queued?.lead.thread !== thread) return []
      // A start for another device with nothing to wait for but that device's answer is on its way there.
      // One its Apex stopped waits only for its device to answer the stop.
      const reason: QueueReason = queued.away?.stop ? "device-offline" : queued.why ?? (queued.away && !queued.after?.length ? "device-offline" : "tree-running")
      const ahead = spawns.slice(0, at).filter((other) => (reason === "place-full" ? parseQueued(other.record)?.why === "place-full" : other.tree === spawn.tree)).length
      const stand = queued.after?.length ? this.afterStand(queued) : undefined
      const placeholder: ThreadParent = {
        child: ThreadIdSchema.parse(namedUuid(spawn.op)),
        parent: ThreadIdSchema.parse(thread),
        parentSession: SessionIdSchema.parse(queued.lead.session),
        name: queued.input.name ?? queued.input.title ?? "queued",
        role: queued.input.role ?? "worker",
        origin: "started",
        asked: { brief: queued.input.brief, harness: queued.harness },
        op: spawn.op,
        startedBy: { kind: "agent", session: SessionIdSchema.parse(queued.lead.session) },
        createdAt: spawn.at,
      }
      const apexStopped = this.apexStopped(thread)
      return [{ op: spawn.op, placeholder, queued: { reason, ahead, ...(stand?.pending.length && { after: stand.pending }), ...(stand?.held && { held: stand.held.name }), ...(queued.refused && { refused: queued.refused }), ...(apexStopped && { apexStopped }) } }]
    })
  }

  /** A held spawn of the Apex's, by name or by its waiting entry's ID (`heldFor`). */
  private heldNamed(apex: Apex, ref: string): { op: string; placeholder: ThreadParent; queued: { reason: QueueReason; ahead: number; after?: string[]; held?: string; refused?: string; apexStopped?: true } } | undefined {
    const name = finName(ref)
    return this.heldFor(apex.thread).find(({ placeholder }) => placeholder.child === ref || placeholder.name === name)
  }

  /**
   * Every change to the queue goes through here: a spawn held, rewritten or dropped. It's applied, then every Apex
   * whose waiting Fins moved hears it (`queueRefresh`), so no path can leave another Apex's line stale.
   */
  private changeQueue(change: (store: ThreadStore) => void): void {
    const store = this.store()
    if (!store) return
    change(store)
    this.queueRefresh()
  }

  /**
   * Each Apex's waiting Fins as they stand now (`heldFor`), against what its conversations last heard: one whose
   * entries changed (one joined or left, or its place in line moved) has its roster read again and its conversations
   * told, as they are when an edge moves. Also after an edge is written, which takes its row out of the projection.
   */
  private queueRefresh(): void {
    if (this.stopped) return
    const now = new Map<string, string>()
    for (const thread of new Set([...this.holdingThreads(), ...this.queueHeard.keys()]))
      now.set(thread, JSON.stringify(this.heldFor(thread).map(({ op, queued }) => [op, queued])))
    for (const [thread, entries] of now) {
      if (this.queueHeard.get(thread) === entries) continue
      const kinds = (text: string | undefined) => (text ? JSON.parse(text).length : 0)
      // Only places in line moved: the same Fins wait, so it's progress, not a change of kind.
      const progressOnly = this.queueHeard.has(thread) && kinds(this.queueHeard.get(thread)) === kinds(entries)
      if (entries === "[]") this.queueHeard.delete(thread)
      else this.queueHeard.set(thread, entries)
      this.forget(thread)
      for (const conversation of this.finReaders(thread)) this.deps.live.childrenChanged(conversation, progressOnly)
    }
  }

  /** Every parent with a spawn held now. */
  private holdingThreads(): string[] {
    return (this.store()?.queuedSpawns() ?? []).flatMap((spawn) => parseQueued(spawn.record)?.lead.thread ?? [])
  }

  /** Whether this Apex is a Fin that was stopped, and not resumed since. */
  private apexStopped(thread: string): boolean {
    return edgeStopped(this.store()?.edges().of(thread))
  }

  private ready(conversation: string): ParentReady {
    const session = this.deps.live.session(conversation)
    if (!session) return "gone"
    // A stopped Fin hears its own Fins' news once it's resumed (`reopen`), not as turns of a Fin its Apex paused.
    const child = this.childOfConversation(conversation)
    // One closed as finished isn't paused: news of its own Fins goes to it, and opens it again as its harness takes it.
    if (child && edgeStopped(this.store()?.edges().of(child))) return "paused"
    if (!this.deps.live.atWork(conversation)) return "idle"
    return this.deps.live.steersAtStep(conversation) ? "steer" : "queue"
  }

  /** A queued digest itself into the Apex's running turn (`steer-queued`): taken from the queue once, or left where it was. */
  private steerQueuedDigest(conversation: string, id: string, request: string, text: string): Promise<boolean> | false {
    const running = this.deps.live.held(conversation)?.requests.find((asked) => asked.status === "dispatching")
    if (!running) return false
    this.digestSteers.add(id)
    return this.deps.live.act(conversation, { kind: "steer-queued", id, requestId: running.id, queuedRequestId: request, text, attachments: [] }, "native").then(
      (action) => action.state.kind === "accepted" || action.state.kind === "completed",
      (error) => {
        hostWarn("agents", "a digest could not join the running turn", { conversation, error: errorMessage({ error }) })
        return false
      }).finally(() => this.digestSteers.delete(id))
  }

  private steer(conversation: string, id: string, text: string): Promise<boolean> | false {
    const running = this.deps.live.held(conversation)?.requests.find((request) => request.status === "dispatching")
    if (!running) return false
    this.digestSteers.add(id)
    return this.deps.live.act(conversation, { kind: "steer", id, requestId: running.id, text, attachments: [] }, "native").then(
      (action) => {
        const took = action.state.kind === "accepted" || action.state.kind === "completed"
        if (!took) hostWarn("agents", "a digest wasn't taken by the running turn", { conversation, state: action.state.kind })
        return took
      },
      (error) => {
        hostWarn("agents", "a digest could not join the running turn", { conversation, error: errorMessage({ error }) })
        return false
      }).finally(() => this.digestSteers.delete(id))
  }

  /**
   * A message into a child's Thread: an idle one takes it as its next turn, and a working one as `want` says, after its
   * turn, into it, or by stopping it first. The same Thread whether it's at work, idle or done, so a finished child
   * takes a follow-up where its work is. `hears` says when the child hears it, as the child's own harness takes a
   * message, whatever harness the sender runs on.
   */
  private async deliver(stopped: ThreadParent, request: string, text: string, attachments: PromptAttachment[], actor: Actor | undefined, want: FinDeliver, automatic = false, attaching: Attaching = {}): Promise<Delivered | AgentRefused> {
    if (stopped.placed)
      return { refused: "unavailable", why: `${stopped.name} runs on ${placeName(stopped.placed.target)}: its ${APEX_WORD} reaches it with agents_send and agents_answer, and the person writes to it in its own Thread there.` }
    const crossing: Crossing = { stopped: false }
    const crossings = this.crossings.get(stopped.child) ?? new Set()
    this.crossings.set(stopped.child, crossings.add(crossing))
    try {
      const sent = await this.sendInto(stopped, request, text, attachments, actor, want, crossing, automatic, attaching)
      return crossing.worktree && !("refused" in sent) ? { ...sent, hears: `${sent.hears} ${crossing.worktree}` } : sent
    } finally {
      crossings.delete(crossing)
      if (!crossings.size) this.crossings.delete(stopped.child)
    }
  }

  private async sendInto(stopped: ThreadParent, request: string, text: string, attachments: PromptAttachment[], actor: Actor | undefined, want: FinDeliver, crossing: Crossing, automatic: boolean, attaching: Attaching): Promise<Delivered | AgentRefused> {
    const before = this.conversationOf(stopped.child)
    const repeat = before ? sentAs(this.deps.live.held(before)?.requests ?? [], request) : undefined
    if (repeat) return repeat.status === "queued" || repeat.status === "held"
      ? { ...this.queuedDelivery(before!, stopped.name, this.ready(before!)), deduped: true }
      : { delivery: "turn", hears: `${stopped.name} already has it.`, deduped: true }
    if (before && this.deps.archived?.(before))
      return { refused: "conflict", why: `${stopped.name} was archived, which ends its work for good: start a new ${FIN_WORD} with agents_start, or the person can restore it, after which a message resumes it.` }
    // What Mako sends by itself never undoes a stop, nor stops a run to get in: it goes only to a Fin Mako drives now.
    // One closed as finished wasn't stopped by anyone: Mako's own note opens it again, as any message does.
    if (automatic && (edgeStopped(stopped) || (stopped.run && (!stopped.run.ended || !before))))
      return { refused: "unavailable", why: `${stopped.name} is stopped or runs outside Mako.` }
    // From here the message goes as a Fin at rest's next turn unless something below refuses it: a provider that
    // sleeps wakes while its words are gathered (the checkout's account, attached Threads). A run that must be taken
    // over first, a Stop that crossed, a Fin at work, a hold ahead of the message and a folder that's gone (its
    // worktree is made again below, and the message says how that went) wake nothing.
    const wokeAhead = before !== undefined && !crossing.stopped && !(stopped.run && !stopped.run.ended) && !this.deps.live.atWork(before) && !this.messageHold(before) &&
      this.deps.live.expect?.(before) === "waking"
    const resumed = automatic ? undefined : await this.resumeAccount(stopped)
    const edge = automatic && !closedFinished(stopped) ? stopped : this.reopen(stopped, "a message")
    const taken = !automatic && edge.run && (!edge.run.ended || !this.conversationOf(edge.child)) ? await this.takeOver(edge) : undefined
    if (taken && "refused" in taken) return taken
    // Its worktree, retired once it had finished, is made again before anything is queued for it, so its session
    // resumes where it began, on its branch. It reads how that went beneath the message, and its sender in the receipt:
    // one that couldn't be made again never holds a message back.
    const remade = before ? await this.remadeWorktree(before, edge) : undefined
    if (remade) crossing.worktree = worktreeRemadeWords(edge.name, remade)
    const words = [text, resumed, taken?.cut ? HANDED_OVER_NOTE : undefined, remade && worktreeRemadeText(remade)].filter(Boolean).join("\n\n")
    // What an agent writes is its words: only what `reachOf` passed goes as an item. A person's words are the window's.
    const written = actor?.kind === "agent" && !attaching.passedOn ? await this.withContext(words, attaching.refs ?? []) : { text: words, ...(attaching.passedOn?.length && { grants: attaching.passedOn }) }
    const message = written.text
    const marks = { ...(written.grants && { grants: written.grants }), ...(attaching.notification && { notification: attaching.notification }), ...(attaching.expects && { expects: attaching.expects }) }
    const conversation = this.conversationOf(edge.child)
    // A Fin reopening its session, as the next host relaunches one an exit cut, takes a message once that settles.
    if (conversation && !(await this.switchSettled(conversation)))
      return { refused: "unavailable", why: `${edge.name} is still reopening its session; send it again in a moment.` }
    const stands = conversation ? this.ready(conversation) : "gone"
    // The wake begun above reads as a session starting, which is work to every other reader. It is this message's own
    // way in, not a turn ahead of it: with nothing sent or queued there meanwhile, the Fin is at rest as it was.
    const ready = wokeAhead && conversation === before && (stands === "steer" || stands === "queue") &&
      !(this.deps.live.held(conversation)?.requests ?? []).some((asked) => asked.status === "dispatching" || asked.status === "queued")
      ? "idle" : stands
    if (!conversation || ready === "gone") return { refused: "unavailable", why: `${edge.name}'s conversation isn't on this device.` }
    const name = edge.name
    const held = sentAs(this.deps.live.held(conversation)?.requests ?? [], request)
    if (held)
      return held.status === "queued" || held.status === "held"
        ? { ...this.queuedDelivery(conversation, name, this.ready(conversation)), deduped: true }
        : { delivery: "turn", hears: `${name} already has it.`, deduped: true }
    const queue = (why?: string): Delivered => {
      this.deps.live.submit(conversation, request, message, attachments, undefined, undefined, undefined, actor, marks)
      // A Stop's pause is the person's or the Apex's to lift, never Mako's own message's.
      if (!automatic) this.resumeFin(conversation, request)
      return this.queuedDelivery(conversation, name, ready, why)
    }
    // A Stop that came while this was on its way, before there was a queue to reach, holds it as it holds any message.
    if (crossing.stopped) {
      this.deps.live.submit(conversation, request, message, attachments, undefined, undefined, undefined, actor, { ...marks, pause: "stop" })
      return { delivery: "queued", hears: `${name} was stopped as this reached it: it waits, held, and goes when ${name} is resumed.` }
    }
    if (taken) {
      const queued = queue()
      if (this.messageHold(conversation) || !this.deps.live.atWork(conversation)) return queued
      return { delivery: "turn", hears: `${taken.cut ? `Mako stopped ${name}'s run and resumed` : "Mako resumed"} its session here; ${name} takes it as its next turn.` }
    }
    if (ready === "idle") return this.reopening(conversation, name, request, queue())
    if (want === "interrupt") {
      if (!this.deps.live.interrupt(conversation, request, message, attachments, actor, written.grants, attaching.notification))
        return queue(`it had no turn running to stop, and something was already queued ahead of this.`)
      this.resumeFin(conversation, request)
      return { delivery: "interrupt", hears: `Mako stopped ${name}'s turn; this message starts its next one, ahead of anything queued for it.` }
    }
    if (want === "queue") return this.reopening(conversation, name, request, queue())
    const queued = queue()
    const steered = await this.steerInto(conversation, name, request, message, attachments)
    return "why" in steered ? { ...queued, hears: `${name} hears it when its current turn ends, as its next message: ${steered.why}` } : steered
  }

  /**
   * A message to a Fin with no session open here reopens it: a wake of its native session, or a transfer that resumes
   * it or hands a new one the conversation (`LiveConversations.submit`). It's taken only once that session opens and
   * the message goes, so the answer waits for that, at most `SWITCH_WAIT_MS`: one whose session couldn't open is
   * refused with why, and one still opening says so. Neither is ever said as taken. A Fin whose session is open
   * answers at once, as it did.
   */
  private async reopening(conversation: string, name: string, request: string, delivered: Delivered): Promise<Delivered | AgentRefused> {
    const transferOf = () => this.deps.live.held(conversation)?.control?.transfers.find((each) => each.input.id === request)
    const requestOf = () => this.deps.live.held(conversation)?.requests.find((each) => each.id === request)
    const opening = () => {
      const transfer = transferOf()
      if (transfer) return transfer.state.kind === "queued" || transfer.state.kind === "preparing"
      const session = this.deps.live.session(conversation)
      return requestOf()?.status === "queued" && (session?.status === "starting" || session?.connection === "starting" || session?.connection === "hibernated")
    }
    if (!opening()) return delivered
    const deadline = Date.now() + SWITCH_WAIT_MS
    while (opening() && Date.now() < deadline && !this.stopped) await new Promise((resolve) => setTimeout(resolve, 25))
    const transfer = transferOf()
    const asked = requestOf()
    const failed = transfer && (transfer.state.kind === "failed" || transfer.state.kind === "uncertain") ? transfer.state.error
      : !transfer && asked?.status === "failed" ? asked.error ?? this.deps.live.session(conversation)?.error ?? "its session didn't open."
        : undefined
    if (failed !== undefined) {
      hostWarn("agents", "a message didn't reach its Fin: its session couldn't be opened", { conversation, request, error: failed })
      return { refused: "unavailable", why: `${name} didn't get this: Mako couldn't open its session. ${failed}` }
    }
    if (opening())
      return { delivery: "queued", hears: `Mako is still opening ${name}'s session: ${name} takes this as its next turn once it opens. agents_read says whether it did.` }
    // A cause that clears by itself (`transientCause`): the message waits, saved, and goes again at its time.
    const retry = transfer?.retry ?? asked?.retry
    if (retry && (transfer ? transfer.state.kind === "queued" : asked?.status === "held"))
      return { delivery: "queued", hears: `Mako couldn't open ${name}'s session yet (${retry.reason}). This is saved and goes again by itself at ${new Date(retry.at).toISOString()}; agents_read says whether it did.` }
    if (transfer?.state.kind === "accepted" || (asked && asked.status !== "queued" && asked.status !== "held"))
      return { delivery: "turn", hears: `Mako opened ${name}'s session again; ${name} takes it as its next turn.` }
    return this.queuedDelivery(conversation, name, this.ready(conversation))
  }

  /** What became of the worktree Mako had retired from under a Fin, made again now for a message to it; undefined when it had none retired. */
  private async remadeWorktree(conversation: string, edge: ThreadParent): Promise<WorktreeRestored | undefined> {
    try {
      return await this.deps.restoreWorktree?.(conversation)
    } catch (error) {
      hostWarn("agents", "a Fin's retired worktree couldn't be looked at; its message goes on", { op: edge.op, error: errorMessage({ error }) })
      return undefined
    }
  }

  /** Waits, at most `SWITCH_WAIT_MS`, for a conversation's provider switch or reopening to settle; false if it hasn't. */
  private async switchSettled(conversation: string): Promise<boolean> {
    const deadline = Date.now() + SWITCH_WAIT_MS
    while (this.deps.live.switching(conversation)) {
      if (Date.now() > deadline || this.stopped) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return true
  }

  /**
   * What a stopped or failed Fin reads beneath the message that resumes it
   * (`finResumedText`): when and why it stopped, and what moved in its
   * checkout and on the branch it goes into since. Undefined for a Fin that
   * didn't end that way.
   */
  private async resumeAccount(edge: ThreadParent): Promise<string | undefined> {
    const state = this.stateOf(edge)
    if (state.kind !== "ended" || (state.outcome !== "stopped" && state.outcome !== "failed")) return undefined
    const reading = this.childReading(edge)
    const at = (state.outcome === "stopped" ? edge.closedAt : this.latest.get(edge.child)?.at) ?? reading.ended?.at ?? edge.closedAt ?? edge.createdAt
    const conversation = this.conversationOf(edge.child)
    const path = reading.path ?? (edge.run?.nativeId ? this.deps.catalog.nativePath({ harness: edge.run.harness, nativeId: edge.run.nativeId }) : undefined)
    const cwd = (conversation ? this.deps.live.session(conversation)?.cwd : undefined) ?? (path ? this.deps.catalog.ref(path)?.cwd : undefined)
    const [checkout, branches] = cwd ? await Promise.all([checkoutSince(cwd, at), branchSince(cwd, at)]) : [[], []]
    return finResumedText({ how: state.outcome, at, ...(state.reason && { reason: state.reason }), now: this.now(), checkout, branches })
  }

  /**
   * Stopping a Fin pauses it: whatever next reaches it (`why`) opens its
   * delegation again, in the same Session, so its turns report and wake its
   * Apex as before. The edge as it stands after.
   */
  private reopen(edge: ThreadParent, why: string): ThreadParent {
    if (edge.closedAt === undefined) return edge
    const store = this.store()!
    const open = store.reopenEdge(edge.child, this.now()) ?? edge
    hostLog("agents", closedFinished(edge) ? "opened again after it finished" : "resumed after stop", { op: edge.op, child: edge.child, by: why, stoppedFor: this.now() - edge.closedAt })
    this.finishedHeld.delete(edge.child)
    this.forget(edge.parent)
    // An open Fin never stands under one closed as finished: its Apex, a Fin too, is open while any of its Fins is, as
    // it was before either closed, so it hears their reports and reads as waiting on them.
    const above = store.edges().of(edge.parent)
    if (above && closedFinished(above)) this.reopen(above, `its ${FIN_WORD} ${edge.name} opened again`)
    this.childMoved(open, false)
    // Its own queued Fins waited for it.
    this.queueRefresh()
    void this.drain()
    return open
  }

  /**
   * A message reached a Fin (`first`): what its stop or an exit paused goes
   * on behind it, its Apex's messages and its own Fins' digests, since
   * nobody presses Resume on a Fin's queue; a paused one first in line would
   * hold every message behind it. Then the digests that waited for a stopped
   * Fin to resume (`ready`).
   */
  private resumeFin(conversation: string, first: string): void {
    const paused = (this.deps.live.held(conversation)?.requests ?? []).filter((request) =>
      holdOf(request)?.kind === "paused" && request.actor?.kind === "agent")
    if (paused.length) {
      try {
        this.deps.live.resumeHeld(conversation, paused.map((request) => request.id), first)
        hostLog("agents", "resumed", { conversation, first, requests: paused.length })
      } catch (error) {
        hostWarn("agents", "a Fin's paused messages wait for Resume", { conversation, error: errorMessage({ error }) })
      }
    }
    this.wakes.settled(conversation)
  }

  /**
   * A Fin whose turns a process Mako didn't start runs, or ran: a message goes
   * on in its own Session on Mako's live driver, which drives it from then on.
   * A run still going is stopped first, since a headless run takes nothing
   * until it exits; its last step may be cut short (`cut`), which the message
   * tells it. Later messages steer or queue as any Fin's do.
   */
  private async takeOver(edge: ThreadParent): Promise<{ cut: boolean } | AgentRefused> {
    const run = edge.run!
    const store = this.store()!
    const path = run.nativeId ? this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId }) : undefined
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!run.nativeId || !path || !ref?.cwd) return { refused: "unavailable", why: `${edge.name}'s session isn't on this device yet, so no message can reach it.` }
    if (!this.deps.harnesses().includes(run.harness))
      return { refused: "unavailable", why: `${this.deps.harnessLabel(run.harness)} has no live driver here to resume ${edge.name}'s session with a message: its report reaches you when it ends.` }
    if (run.ended && this.runs.reading(edge.child)?.working)
      return { refused: "unavailable", why: `${edge.name}'s session is being written by a process Mako lost track of, so it can't be resumed here: link that process with agents_link, or try again once it's quiet.` }
    let cut = false
    if (!run.ended) {
      if (run.device !== store.deviceId || !run.process) return { refused: "unavailable", why: `${edge.name} runs in a process on another device, which takes no message until it exits.` }
      if (!(await this.runs.handOver(edge.child))) return { refused: "unavailable", why: `${edge.name}'s process didn't stop, so its session can't take a message yet.` }
      cut = true
    }
    const conversationId = namedUuid(`resume:${edge.child}:${run.nativeId}`)
    const apex = this.frontOf(edge.parent, edge.parentSession)
    const mode = childMode(this.deps.modes(run.harness), (apex ? this.tierOfConversation(apex) : undefined) ?? "ask")
    try {
      await this.deps.startLive(run.harness, ref.cwd, { conversationId, resume: run.nativeId, threadPath: path, ...(mode && { modeId: mode.id }) })
    } catch (error) {
      return { refused: "unavailable", why: `${edge.name}'s session didn't open here${cut ? " after its run was stopped" : ""}: ${errorMessage({ error })}` }
    }
    this.conversations.set(edge.child, conversationId)
    this.childOf.set(conversationId, edge.child)
    hostLog("agents", "run taken over", { op: edge.op, child: edge.child, harness: run.harness, cut, conversation: conversationId })
    return { cut }
  }

  /**
   * Steers a message already queued for a working child (`steer-queued`, as the window steers a queued message) into
   * its running turn. Refused, then or later, it stays where it was queued, so what was sent after it still comes
   * after; taken, it leaves the queue; never confirmed, it isn't sent again. A harness can hold a steer until what runs
   * returns (Cursor, its subagent): the call answers after `STEER_WAIT_MS` and `STEER_ANSWER_MS` at most, before that.
   * `why` when it never went into the turn, so it waits for the turn's end.
   */
  private async steerInto(conversation: string, name: string, request: string, text: string, attachments: PromptAttachment[]): Promise<Delivered | { why: string }> {
    const steering = this.deps.live.steering(conversation)
    const harness = this.deps.harnessLabel(this.deps.live.session(conversation)?.harness ?? "unknown")
    if (!steering) return { why: `${harness} takes no message into a running turn.` }
    const deadline = Date.now() + STEER_WAIT_MS
    const turn = () => this.deps.live.held(conversation)?.requests.find((asked) => asked.status === "dispatching" && asked.nativeRun)
    // A turn just handed to its harness has no run yet while its session still reads ready: wait for it too, rather than
    // queue a steer that arrived as the turn began (land-2's 911d68d2, 2026-11-16).
    const starting = () => this.deps.live.session(conversation)?.status !== "ready" || Boolean(this.deps.live.held(conversation)?.requests.some((asked) => asked.status === "dispatching"))
    while (!turn() && Date.now() < deadline && starting()) await new Promise((resolve) => setTimeout(resolve, 50))
    const running = turn()
    // Its own message went with the turn that just began, folded into the one before it (`foldQueued`): it's heard.
    const wentWith = (): Delivered | undefined => {
      const carrier = sentAs(this.deps.live.held(conversation)?.requests ?? [], request)
      return carrier && carrier.id !== request && carrier.status !== "queued" && carrier.status !== "held"
        ? { delivery: "turn", hears: `${name} takes it in the turn that just began, with the message before it.` }
        : undefined
    }
    if (!running) return wentWith() ?? { why: "its turn hadn't started yet." }
    const already = wentWith()
    if (already) return already
    const action = Promise.resolve().then(() => this.deps.live.act(conversation, { kind: "steer-queued", id: namedUuid(`steer:${request}`), requestId: running.id, queuedRequestId: request, text, attachments }, "native"))
    const answered = await Promise.race([
      action.then((taken) => taken.state, (error) => ({ kind: "refused" as const, reason: errorMessage({ error }) })),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()) + STEER_ANSWER_MS)),
    ])
    const unconfirmed = (reason: string): Delivered => ({ delivery: "steer", hears: `${harness} didn't confirm ${name} took it (${reason}); Mako won't send it again, so look for it in ${name}'s next report before sending it once more.` })
    if (!answered)
      return { delivery: "steer", hears: `${harness} holds it until what ${name} is running now returns, then ${name} hears it${steering.answersOnEnd ? "; if its turn ends first, it goes as its next message" : ""}.` }
    if (answered.kind === "refused") {
      const folded = wentWith()
      if (folded) return folded
      // Refused before its harness heard it, it's still queued; one whose action took it from the queue has an unknown outcome.
      const status = this.deps.live.held(conversation)?.requests.find((asked) => asked.id === request)?.status
      return status === "queued" || status === "held" ? { why: `it couldn't go into its running turn (${answered.reason})` } : unconfirmed(answered.reason)
    }
    if (answered.kind === "not-accepted")
      return { delivery: "queued", hears: `${harness} didn't take it into ${name}'s running turn, so ${name} hears it when that turn ends, as its next message.` }
    if (answered.kind === "uncertain" || answered.kind === "failed") return wentWith() ?? unconfirmed(answered.reason)
    return { delivery: "steer", hears: `${name} hears it ${steering.hears} (${harness}).` }
  }

  /** The message the Apex's turn answers: its newest from the person, with what came with it. */
  private personsMessage(apex: Apex): LiveRequest | undefined {
    const requests = apex.conversation ? this.deps.live.held(apex.conversation)?.requests ?? [] : []
    const own = requests.filter((request) => !request.actor || request.actor.kind === "person")
    return own.find((request) => request.status === "dispatching") ?? own.at(-1)
  }

  /** A Fin's Apex as it stands, and the other open Fins it started, as its front-door note names them: no transcript is read. */
  private crewOf(fin: Apex): AgentsCrew | AgentRefused {
    const store = this.store()!
    const edge = store.edges().of(fin.thread)
    if (!edge) return { refused: "no-parent", why: `This Thread has no ${APEX_WORD}: scope crew is for a ${FIN_WORD}. Leave scope out for this Thread's own ${FIN_WORD}s.` }
    this.sync()
    const conversation = this.frontOf(edge.parent, edge.parentSession)
    const session = conversation ? this.deps.live.session(conversation) : undefined
    const ready = conversation ? this.ready(conversation) : "gone"
    const working = ready === "steer" || ready === "queue"
    const held = working && conversation ? this.deps.live.held(conversation) : undefined
    const step = held && session ? lastStep(held.blocks.slice(-24), session.harness) : undefined
    const title = session?.title ?? store.thread(ThreadIdSchema.parse(edge.parent))?.title
    const above = store.edges().of(edge.parent)
    return {
      you: edge.name,
      apex: {
        ...(title && { title }),
        ...(session && { harness: this.deps.harnessLabel(session.harness) }),
        working,
        ...(step && { step }),
        ...(above && { asked: noteLine(above.asked.brief.objective, 160) }),
      },
      crew: store.edges().children(edge.parent).filter((other) => other.child !== edge.child && !other.closedAt).map((other) => crewMate(this.frontDoorChild(other, true))),
    }
  }

  /** The person's other Apexes open here, each as it stands, from typed state: reading one never wakes it. */
  private apexesOf(caller: Apex): AgentsApexes {
    return { apexes: this.otherApexes(caller).map((other) => this.otherApex(other)) }
  }

  /** Every tree's top Apex but the caller's own whose conversation is open on this host, with the conversation that speaks for it. */
  private otherApexes(caller: Apex): OtherApexRef[] {
    const store = this.store()!
    this.sync()
    const roots = new Set(store.edges().all.map((edge) => this.rootOf(edge.parent)))
    roots.delete(this.rootOf(caller.thread))
    return [...roots].flatMap((thread) => {
      const record = store.thread(ThreadIdSchema.parse(thread))
      const first = record?.sessions[0]
      const conversation = first && this.frontOf(thread, first)
      if (!conversation || !this.deps.live.held(conversation)) return []
      const title = record.title ?? this.deps.live.session(conversation)?.title
      return [{ thread, conversation, ...(title && { title }) }]
    })
  }

  /** Another Apex by its title or Thread, as `scope: apexes` lists them; a title two share is refused with their Threads. */
  private otherApexNamed(caller: Apex, ref: string): OtherApexRef | AgentRefused {
    const others = this.otherApexes(caller)
    const words = ref.trim().toLowerCase()
    const found = others.filter((other) => other.thread === ref.trim() || other.title?.trim().toLowerCase() === words)
    if (found.length === 1) return found[0]!
    if (found.length) return { refused: "unknown-apex", why: `${found.length} ${APEX_WORD}es are titled ${ref}: name one as apex:<Thread ID>: ${found.map((other) => other.thread).join(", ")}.` }
    const listed = others.map((other) => `${APEX_PREFIX}${other.title ?? other.thread}`).join(", ")
    return { refused: "unknown-apex", why: `No other ${APEX_WORD} of the person's open here is ${ref}${listed ? `; they are ${listed}` : ""}. agents_list with scope apexes shows them.` }
  }

  private otherApex(other: OtherApexRef): OtherApex {
    const store = this.store()!
    const { thread, conversation } = other
    const session = this.deps.live.session(conversation)
    const ready = this.ready(conversation)
    const working = ready === "steer" || ready === "queue"
    const held = working ? this.deps.live.held(conversation) : undefined
    const step = held && session ? lastStep(held.blocks.slice(-24), session.harness) : undefined
    const branch = store.worktrees().find((worktree) => worktree.thread === thread)?.branch
    const open = store.edges().children(thread).filter((edge) => !edge.closedAt).map((edge) => ({ edge, state: this.stateOf(edge) }))
      .sort((a, b) => CHILD_GROUPS.indexOf(childGroup(a.state)) - CHILD_GROUPS.indexOf(childGroup(b.state)))
    const fins = open.slice(0, APEX_DIGEST_FINS).map(({ edge, state }) => {
      const idle = this.idleOf(edge, state, this.childReading(edge))
      const pulls = this.openPRsOf(edge)
      return { name: edge.name, line: this.digestLine(edge, state), ...(idle !== undefined && { idleFor: idle }), ...(pulls.length && { openPRs: pulls }) }
    })
    const said = this.lastReply(conversation)
    return {
      thread,
      ...(other.title && { title: other.title }),
      ...(session && { harness: this.deps.harnessLabel(session.harness) }),
      working,
      ...(step && { step }),
      ...(session?.cwd && { folder: session.cwd }),
      ...(branch && { branch }),
      fins: rollup(this.roster(conversation)),
      digest: { fins, ...(open.length > fins.length && { more: open.length - fins.length }), ...(said && { said }) },
    }
  }

  /** A Fin in another Apex's digest: its open decision, its last report, or before one, its state. */
  private digestLine(edge: ThreadParent, state: ChildState): string {
    const waiting = state.kind === "idle" && state.waitingOn?.length
      ? waitingStateWords(state.waitingOn, state.since, this.now())
      : (state.kind === "blocked" || state.kind === "ended") && waitingWords(state.waitingOn)
    const line = this.digestWords(edge, state)
    return waiting ? `${line} · ${waiting}` : line
  }

  private digestWords(edge: ThreadParent, state: ChildState): string {
    if (state.kind === "ended" && state.decision) {
      const words = decisionWords(state.decision).replace(/\s+/g, " ")
      return words.length > 240 ? `${words.slice(0, 239).trimEnd()}…` : words
    }
    const latest = this.latestOf(edge.child)
    if (latest) return `${latest.status}: ${noteLine(reportPhase(latest) ?? latest.status, 160)}`
    const line = childLine(state)
    return line ? `${state.kind}: ${noteLine(line, 160)}` : state.kind
  }

  /** The first paragraph of what a conversation's agent said as its last finished turn ended. */
  private lastReply(conversation: string): string | undefined {
    const last = this.deps.live.held(conversation)?.requests.filter((request) => request.status === "completed").at(-1)
    const text = last ? this.deps.live.turnReply(conversation, last.id)?.text.trim() : undefined
    return text ? firstParagraph(text) : undefined
  }

  /** The turn that answers another Apex's message ended: its reply goes to that Apex once, as a wake of its own. */
  private apexReplied(conversation: string, request: string): void {
    const ask = this.apexAsks.get(`${conversation}:${request}`)
    if (!ask) return
    for (const id of ask.requests) this.apexAsks.delete(`${conversation}:${id}`)
    const reply = this.deps.live.turnReply(conversation, request)
    if (ask.notification && reply?.request?.status === "completed") return
    const text = reply?.text.trim()
    const done = reply?.request?.status === "completed" && Boolean(text)
    const said = reply?.request?.error || text || "Its turn ended without reporting a result."
    const front = this.frontOf(ask.sender.thread, ask.sender.session) ?? ask.sender.conversation
    const from = this.store()?.journalPlacement(conversation)?.session
    if (!front || !from) return
    this.wakes.notice(front, this.rootOf(ask.sender.thread), {
      id: `notice:reply:${conversation}:${request}`,
      report: { id: `reply:${conversation}:${request}`, child: ThreadIdSchema.parse(ask.thread), status: done ? "done" : "failed", summary: said.slice(0, 16_000), ownerGeneration: this.generation, at: this.now() },
      label: ask.label,
      fin: ask.fin,
      from,
      reply: true,
    })
    hostLog("agents", "apex replied", { conversation, request, to: ask.sender.thread, done })
  }

  /**
   * A Fin as its Apex's front-door note names it: what it was asked, where it stands and what it said last; with
   * `facts`, as the crew view reads it, how long it has been idle and its open pull requests too. `acting`: the
   * Threads a pending action names, read once by a note of many Fins.
   */
  private frontDoorChild(edge: ThreadParent, facts = false, acting?: ReadonlySet<string>): FrontDoorChild {
    const latest = this.latestOf(edge.child)
    const conversation = this.conversationOf(edge.child)
    const direct = conversation
      ? this.deps.live.held(conversation)?.requests.filter((request) => request.actor?.kind === "person" && request.createdAt !== undefined).at(-1)
      : undefined
    const state = this.stateOf(edge)
    const idle = facts ? this.idleOf(edge, state, this.childReading(edge)) : undefined
    const held = this.openPRsOf(edge)
    const pulls = facts ? held : []
    // Read as `agents_list` reads its row (`stripChange`), so the two marks agree.
    const changedAt = this.changes.at(edge.child, {
      state, ...(state.kind === "working" && { awaiting: this.childReading(edge).awaiting }),
      ...(latest && { report: { status: latest.status, at: latest.at } }), ...(held.length && { pulls: held }),
      // Only a Fin a pending action names has any to count (`strip`).
      questions: this.pendingReports(edge).length, actions: (acting ?? this.store()!.pendingActionThreads()).has(edge.child) ? this.pendingActions(edge.parent, edge.child).total : 0, owes: this.owesApex(edge),
    }, this.changes.tick(this.now()))
    return {
      name: edge.name,
      changedAt,
      harness: this.deps.harnessLabel(this.harnessOf(edge)),
      state,
      ...(idle !== undefined && { idleFor: idle }),
      ...(pulls.length && { openPRs: pulls }),
      topic: noteLine(edge.asked.brief.objective, 160),
      ...(edge.asked.workspace?.branch && { branch: edge.asked.workspace.branch }),
      ...(latest && { report: { status: latest.status, ...(latest.unfinished && { unfinished: true as const }), line: noteLine(latest.unfinished ? latest.summary : reportPhase(latest) ?? latest.status, 160), at: latest.at } }),
      ...(direct && { direct: { line: noteLine(direct.displayText ?? direct.text, 120), at: direct.createdAt! } }),
    }
  }

  /**
   * Where a Thread hears its children: the Session the person last wrote in,
   * which is the one speaking as its Apex; before any, the one that started
   * them. One Session answers, so two never act as the Apex at once.
   */
  private frontOf(thread: string, started: string): string | undefined {
    let front: { conversation: string; at: number } | undefined
    for (const conversation of this.conversationsOfThread(thread)) {
      const asked = this.deps.live.held(conversation)?.requests.filter((request) => (!request.actor || request.actor.kind === "person") && request.createdAt !== undefined).at(-1)
      if (asked && (!front || asked.createdAt! > front.at)) front = { conversation, at: asked.createdAt! }
    }
    return front?.conversation ?? this.conversationOfSession(started) ?? this.conversationOf(thread)
  }

  /**
   * A conversation of the `marker` Session on the same harness that is still starting, or hasn't named its native
   * session, may own this one: its shell can't have run anything yet.
   */
  private conversationOwns(ref: Pick<ThreadRef, "harness" | "nativeId" | "sessionId">, marker?: string): boolean {
    if (this.deps.live.connectedSession(ref.harness, ref.nativeId) !== null) return true
    if (ref.sessionId !== undefined && (this.store()?.conversationsOf(ref.sessionId).length ?? 0) > 0) return true
    return marker !== undefined && (this.store()?.conversationsOf(marker) ?? []).some((conversation) => {
      const session = this.deps.live.session(conversation)
      return session?.harness === ref.harness && (session.nativeId === undefined || session.connection === "starting")
    })
  }

  private conversationOfSession(session: string): string | undefined {
    return this.store()?.conversationsOf(session).at(-1)
  }

  /** The conversation that drives a Thread's turns here: its newest Session's. */
  private conversationOf(thread: string): string | undefined {
    const known = this.conversations.get(thread)
    if (known) return known
    const sessions = this.sessionsOf(thread)
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      // A Session's newest journal, as `conversationOfSession` reads it.
      const conversation = sessions[index]!.at(-1)
      if (!conversation) continue
      this.conversations.set(thread, conversation)
      this.childOf.set(conversation, thread)
      return conversation
    }
    return undefined
  }

  /**
   * A Thread's conversations, Session by Session in its order: every Fin's read together in one look at the store, and
   * held until it moves (`ThreadStore.threadConversations`), since a roster and the list read each Fin's on every look.
   */
  private sessionsOf(thread: string): string[][] {
    const store = this.store()
    if (!store) return []
    return store.threadConversations([thread], () => store.edges().all.map((edge) => edge.child)).get(thread) ?? []
  }

  /**
   * The conversation a Fin's standing is read from: of its Thread's Sessions, the newest one whose harness asks (an
   * approval or a question, which an answer reaches), else the newest otherwise waiting on the person (needs-you, by
   * `personWaiting`), else its newest (`conversationOf`). A Fin read its newest Session alone, so an approval in an older
   * tab, beside a newer one left idle, was never its Apex's or the person's to see. What waits is held in memory
   * (`waitingOn`, `workOf`), so nothing is read in to find it.
   */
  private askingConversation(thread: string): string | undefined {
    return this.answeringConversation(thread) ?? this.newestOf(thread, (conversation) => this.personWaiting(conversation) !== undefined) ?? this.conversationOf(thread)
  }

  /**
   * The conversation a Fin's harness's own ask waits in for its answer (`request`, or any): the newest of its Thread's
   * Sessions holding one. What only waits on the person (needs-you) holds none, so it never hides an older one's ask.
   */
  private answeringConversation(thread: string, request?: string): string | undefined {
    return this.newestOf(thread, (conversation) => {
      const pending = this.deps.live.pendingAsk(conversation)
      return pending !== undefined && (request === undefined || pending.request === request)
    })
  }

  /** Of a Thread's Sessions, newest first, the first conversation `picked` takes. */
  private newestOf(thread: string, picked: (conversation: string) => boolean): string | undefined {
    const sessions = this.sessionsOf(thread)
    for (let index = sessions.length - 1; index >= 0; index -= 1)
      for (const conversation of sessions[index]!)
        if (picked(conversation)) return conversation
    return undefined
  }

  /** What a conversation waits on the person for, by the rule its row says it with (`personWaiting`). */
  private personWaiting(conversation: string): Waiting | undefined {
    return personWaiting(this.deps.live.waitingOn(conversation), this.deps.live.workOf(conversation)?.status)
  }

  /** Saving a request confirms its place in the queue; only the live owner says whether a turn can go. */
  private queuedDelivery(conversation: string, name: string, ready: ParentReady, why?: string): Delivered {
    const held = this.messageHold(conversation)
    if (held) return { delivery: "queued", hears: `${name}'s message is saved, but ${held}` }
    if (!this.deps.live.atWork(conversation))
      return { delivery: "queued", hears: `${name}'s message is saved; its session hasn't started the next turn.${why ? ` ${why}` : ""}` }
    return ready === "idle"
      ? { delivery: "turn", hears: `${name} takes it now, as its next turn.` }
      : { delivery: "queued", hears: `${name} hears it when its current turn ends, as its next message${why ? `: ${why}` : "."}` }
  }

  /** A person's hold ahead of unsent work: a saved message is not a turn, nor the Fin's old completed task. */
  private messageHold(conversation: string): string | undefined {
    const requests = this.deps.live.held(conversation)?.requests ?? []
    const signIn = signInPause(requests)
    const resuming = signInResuming(signIn, requests)
    // The accepted cut itself is pending work even when no later message was queued.
    if (signIn && !resuming) {
      if (signIn.hold.ready) return "its work is paused. Resume it in its Thread when you want it to continue."
      return signIn.hold.verification !== undefined && !requests.some(request => request.signIn && request.pause === "stop")
        ? "its account is signed out. Sign in once in Settings; held work resumes automatically."
        : "its account is signed out. Sign in and Resume in its Thread."
    }
    for (const request of requests) {
      if (request.status === "queued") return undefined
      const hold = holdOf(request)
      if (!hold || !keepsLine(hold)) continue
      if (hold.kind === "edit") return "a message is paused for editing. Resume it in its Thread."
      if (hold.kind === "sign-in" && resuming) return undefined
      if (hold.kind === "paused") return "a message is paused. Resume it in its Thread."
      return undefined
    }
    return undefined
  }

  /**
   * The conversations a Thread's Fins go to as they move: its newest Session's, by the store's order of its Sessions.
   * Every move went to every Session, and one let go of was read back from its journal for it and held while its Fins
   * worked: on 2026-11-07, with progress going to the newest alone (#517), a window was still sent 62 whole rosters in
   * ten minutes for each of 13 Sessions besides the newest, 157 of the 226 MiB of rosters it took. A window draws a
   * Thread's Fins, and counts what each of its Sessions waits on, from its newest Session by the same order
   * (`threadChildren`, `conversationWork`), and one read in takes its Fins as they are then.
   */
  private finReaders(thread: string): string[] {
    const store = this.store()
    const sessions = store?.thread(ThreadIdSchema.parse(thread))?.sessions ?? []
    return sessions.length ? (store?.conversationsOf(sessions[sessions.length - 1]!) ?? []) : []
  }

  /** Whether the conversation hears its Thread's Fins move (`finReaders`): only then do they hold it in memory. */
  showsFins(conversation: string): boolean {
    const thread = this.store()?.journalPlacement(conversation)?.thread
    return thread !== undefined && this.finReaders(thread).includes(conversation)
  }

  private conversationsOfThread(thread: string): string[] {
    const store = this.store()
    return (store?.thread(ThreadIdSchema.parse(thread))?.sessions ?? []).flatMap((session) => store?.conversationsOf(session) ?? [])
  }

  private childOfConversation(conversation: string): string | undefined {
    const known = this.childOf.get(conversation)
    if (known) return known
    const thread = this.store()?.journalPlacement(conversation)?.thread
    if (!thread || !this.store()?.edges().of(thread)) return undefined
    this.childOf.set(conversation, thread)
    return thread
  }

  /** Takes in what other hosts wrote: a commit drops every entry, read again from the store as it's asked for. */
  /**
   * Takes in what the store holds that this host's entries are built on. Edges that changed rebuild everything; any
   * other commit (another Mako's, a title, this host's own report) takes the reports and answers kept since, and only
   * the Fins they're of read again, with the rosters above them. Rebuilt on every commit, a day's 226 Fins were read
   * again on every report and every list, seconds of the loop on a store other Makos commit to all day.
   */
  private sync(): void {
    const store = this.store()
    if (!store) return
    const moved = store.moved()
    if (moved === this.syncedAt) return
    this.syncedAt = moved
    const edges = store.edges()
    if (edges !== this.seen) {
      this.seen = edges
      this.notFins.clear()
      this.keptMark = store.keptMark()
      // Read whole from here: nothing kept before this mark comes back, and what's held of each Fin's reports is
      // checked against its newest as it's asked for (`reportsOf`).
      this.keptHere.clear()
      this.latest = store.latestReports()
      this.answersHeld = store.latestAnswers()
      this.entries.clear()
      this.rosters.clear()
      return
    }
    const since = store.keptSince(this.keptMark)
    this.keptMark = since.mark
    if (since.lost) {
      // Title changes were pruned past this mark before they were read: what any Fin shows may have changed.
      this.keptHere.clear()
      this.latest = store.latestReports()
      this.answersHeld = store.latestAnswers()
      this.entries.clear()
      this.rosters.clear()
      return
    }
    // A Fin renamed, or its Session given another journal, shows that in its entry: read again, with the rosters above,
    // and the conversation it's read from found again.
    const changed = new Set<string>(since.threads)
    for (const thread of since.threads) this.conversations.delete(thread)
    for (const report of since.reports) {
      if (!this.keptHere.delete(report.id)) this.reportKept(report)
      this.latest.set(report.child, report)
      changed.add(report.child)
    }
    // An answer's delivery is marked on its row in place, so answers are read again whole; there are few.
    const answers = store.latestAnswers()
    for (const child of new Set([...answers.keys(), ...this.answersHeld.keys()]))
      if (JSON.stringify(answers.get(child)) !== JSON.stringify(this.answersHeld.get(child))) changed.add(child)
    this.answersHeld = answers
    for (const child of changed) {
      this.entries.delete(child)
      for (let edge = edges.of(child), hops = 0; edge && hops < 64; edge = edges.of(edge.parent), hops += 1) {
        this.rosters.delete(edge.parent)
        this.entries.delete(edge.parent)
      }
    }
  }

  private forget(thread: string): void {
    this.rosters.delete(thread)
  }

  /** A spawn left the queue without starting: its Apex's roster drops it. */
  private unqueued(op: string): void {
    this.changeQueue((store) => store.unqueueSpawn(op))
  }



  /**
   * Names the request that will tell an Apex of this queued start, on its row, before it's sent: a notice has no report
   * row to keep that, and a host that dies before `dropHeld` must find the same request, not tell it again in a new one.
   */
  private heldIn(op: string, request: string): void {
    const store = this.store()
    const spawn = store?.queuedSpawns().find((queued) => queued.op === op)
    if (spawn) store?.keepQueuedSpawn(op, JSON.stringify({ ...JSON.parse(spawn.record), wake: request }))
  }

  /** Its Apex heard that a Fin it was to start after didn't finish (`tellHeld`): it's the Apex's to start again. */
  private dropHeld(op: string): void {
    const spawn = this.store()?.queuedSpawns().find((queued) => queued.op === op)
    if (!spawn) return
    const queued = parseQueued(spawn.record)
    hostLog("agents", "end", { op, outcome: "stopped", queued: true, why: !queued ? "its record couldn't be read" : queued.refused ? "it couldn't start" : "a Fin it was to start after didn't finish" })
    this.unqueued(op)
  }

  private store(): ThreadStore | undefined {
    return this.deps.store()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** A stop's reason as its edge keeps it. `FINISHED_CLOSE` is Mako's alone to write: a stop that says those very words is still a stop. */
function stopReason(why: string): string {
  const reason = why.slice(0, 2000)
  return reason === FINISHED_CLOSE ? `${reason.slice(0, 1990)} (stopped)` : reason
}

function startRecord(op: string, thread: string, name?: string): StartRecord {
  return { op, thread, ...(name && { asked: name }), cancelled: false, answer: Promise.resolve({ refused: "unavailable", why: "" }) }
}

function parseQueued(record: string): QueuedStart | undefined {
  try {
    return QueuedStartSchema.parse(JSON.parse(record))
  } catch {
    return undefined
  }
}

/**
 * What a conversation runs with now: the last model asked of its active binding, else what that binding's session says.
 * A request that ran on another binding says nothing of it: after a move it's the source's model, not this one.
 */
export function settingsIn(snapshot: Pick<LiveSnapshot, "requests"> & { session: Pick<LiveSnapshot["session"], "settings">; control?: Pick<NonNullable<LiveSnapshot["control"]>, "activeBindingId" | "bindings"> }): SessionSettings | undefined {
  const active = snapshot.control?.activeBindingId
  const here = (request: LiveRequest) => !active || (request.nativeRun?.bindingId ?? request.targetBindingId ?? active) === active
  const chosen = snapshot.requests.filter((request) => request.tuning?.model && here(request)).at(-1)?.tuning
  const binding = snapshot.control?.bindings.find((candidate) => candidate.id === active)
  return chosen ?? snapshot.session.settings ?? binding?.tuning
}

function queuedLead(record: string): z.infer<typeof QueuedLeadSchema> | undefined {
  try {
    return QueuedLeadSchema.parse(JSON.parse(record))
  } catch {
    return undefined
  }
}

/** Consecutive reports retaining the same dependency and condition share its first registration, in durable store order. */
function pullWaitReports(reports: Report[], key: string): Report[] {
  const latest = reports.at(-1)
  const current = latest?.status !== "failed" && latest?.waitingOn?.flatMap((item) => waitedPull(item) ?? []).find((pull) => pull.key === key)
  if (!current) return []
  let first = reports.length - 1
  while (first >= 0) {
    const report = reports[first]!
    const retained = report.status !== "failed" && report.waitingOn?.some((item) => {
      const pull = waitedPull(item)
      return pull?.key === key && pull.until === current.until
    })
    if (!retained) break
    first -= 1
  }
  return reports.slice(first + 1)
}

/** A pull request a report waits on, by repository and number; undefined for another kind or an invalid reference. */
/** A listed Fin waiting on its Apex: a question or action open, blocked, or ended with a decision. */
function needsApex(strip: AgentStrip): boolean {
  const { state } = strip
  return Boolean(strip.pendingQuestions || strip.pendingActions || strip.custodyActions || strip.owes) || state.kind === "blocked" || (state.kind === "ended" && state.decision !== undefined)
}

/** A report's mark (`ReportMark`): what's kept of it once it's read. */
function reportMark(report: Report): ReportMark {
  return { at: report.at, status: report.status, ...(report.handoff && { handoff: report.handoff }), ...(report.awaits && { awaits: report.awaits }), ...(report.answers && { answers: report.answers }) }
}

/** What a listed Fin's change mark reads of its row (`FinChanges`). */
function stripChange(strip: AgentStrip): ChangeFacts {
  return { state: strip.state, ...(strip.report && { report: { status: strip.report.status, at: strip.report.at } }), ...(strip.openPRs && { pulls: strip.openPRs }), questions: strip.pendingQuestions ?? 0, actions: strip.pendingActions ?? 0, owes: strip.owes ?? 0 }
}

/**
 * Whether a Fin's reports since it took its Apex's question `request` at `at` answer it: any but progress, or progress
 * that hands work on, waits on someone else, or names it in `answers` (`docs/delivery-queue.md` rule 17).
 */
function answeredBy(reports: readonly ReportMark[], request: string, at: number): boolean {
  return reports.some((report) => report.at >= at && (report.status !== "progress" || report.handoff || report.awaits || report.answers?.includes(request)))
}

/**
 * How many of a Fin's turns its model answered since it took a message (`taken`): the turn it went in and those after,
 * each `completed`. One a limit, a failure or a stop cut owes nothing it couldn't answer, so it doesn't count toward a
 * reminder or its Apex's line.
 */
export function answeredTurns(requests: readonly LiveRequest[], taken: { at: number; into: string }): number {
  return requests.filter((each) => each.status === "completed" && (each.id === taken.into || (each.dispatchedAt ?? -1) >= taken.at)).length
}

/**
 * When a Fin's harness took `request`, and the turn it went in: its own turn once handed over, the turn it was folded into
 * (`joinedInto`) once that was, or the running turn a steer of it reached (`steer-queued`, accepted). Undefined while
 * it hasn't been taken.
 */
function takenAs(request: LiveRequest, requests: readonly LiveRequest[], actions: readonly LiveAction[]): { at: number; into: string } | undefined {
  if (request.status === "canceled") {
    if (request.joinedInto !== undefined) {
      const carrier = requests.find((each) => each.id === request.joinedInto)
      return carrier && handedOver(carrier) ? { at: carrier.dispatchedAt ?? carrier.createdAt ?? 0, into: carrier.id } : undefined
    }
    const steer = actions.find((action) => action.input.kind === "steer-queued" && action.input.queuedRequestId === request.id && action.state.kind === "accepted")
    return steer?.input.kind === "steer-queued" ? { at: steer.createdAt, into: steer.input.requestId } : undefined
  }
  return handedOver(request) ? { at: request.dispatchedAt ?? request.createdAt ?? 0, into: request.id } : undefined
}

/** The message a request ID went as: the one it was folded into when it went (`LiveRequest.joined`), else its own. */
function sentAs(requests: readonly LiveRequest[], id: string): LiveRequest | undefined {
  return requests.find((request) => request.joined?.some((joined) => joined.id === id)) ?? requests.find((request) => request.id === id)
}

function waitedPull(item: WaitingOn): { key: string; repository?: string; number: number; until?: PullWaitUntil } | undefined {
  if (item.kind !== "pull-request") return undefined
  const ref = pullRef(item.ref)
  const repository = item.repository ?? ref?.repository
  const number = item.number ?? ref?.number
  if (number === undefined) return undefined
  return { key: pullKey({ number, ...(repository && { repository }) }), ...(repository && { repository }), number, ...(item.until && { until: item.until }) }
}

function waitingItem(item: WaitingOn): WaitingOn {
  if (item.kind === "other") return { kind: "other", text: item.text.slice(0, 200) }
  if (item.kind === "person") return { kind: "person", what: item.what.slice(0, 200) }
  const ref = item.ref.slice(0, 400)
  const pull = pullRef(ref)
  return { kind: "pull-request", ref, ...(pull?.repository && { repository: pull.repository }), ...(pull && { number: pull.number }), ...(item.until && { until: item.until }) }
}

function waitedReport(report: Report): WaitedReport {
  return { status: report.status, ...(report.unfinished && { unfinished: true as const }), summary: report.summary, ...(report.artifacts?.length && { artifacts: report.artifacts }), ...(report.question && { question: report.question }), ...(report.decides && { decides: report.decides }) }
}

/** Who answers a Fin's ask: its Apex, within its access, or the person, whose ask it is. */
type Answerer = { kind: "apex"; apex: Apex } | { kind: "person" }

/** The tiers a harness's modes run on, in words: "full", "ask, edits, full". */
function offered(modes: readonly LiveSessionMode[] | undefined): string {
  return (modes ?? []).flatMap((mode) => mode.access ? [mode.access] : []).join(", ")
}

/** The report that tells an Apex its Fin's ask `line` is the person's too. */
function personsId(child: string, line: string): string {
  return `report:${child}:to-person:${namedUuid(line)}`
}

/** A wait in words: "a minute", "2 minutes", "30 seconds". */
function waitWords(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000)
    return minutes === 1 ? "a minute" : `${minutes} minutes`
  }
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds === 1 ? "a second" : `${seconds} seconds`
}

/** How an Apex answers a cut turn's question (`reportCut`); any other words go to the Fin as its next message. */
const CUT_CONTINUE = "Continue"
const CUT_STOP = "Stop"
const CUT_OPTIONS = [
  { label: CUT_CONTINUE, detail: "Mako continues its turn where it was cut, telling it what moved in its checkout and on its branch since." },
  { label: CUT_STOP, detail: "It pauses, its Thread and work kept; a message resumes it." },
] as const

/** The question a cut turn, or a followed run's unexplained end (`run:<startedAt>`), is to its Apex: one per cut. */
function cutReportId(child: string, cut: string): string {
  return `report:${child}:cut:${cut}`
}

/** Whether Mako's continuation of the cut turn `cut` is still on its way: a reconnect not yet committed or failed (`unsettled`). */
function continuationUnsettled(snapshot: Pick<LiveSnapshot, "control">, cut: string): boolean {
  return snapshot.control?.transfers.some((transfer) => transfer.continues?.requestId === cut && unsettled(transfer)) ?? false
}

/** The cut a cut turn's question names, from its id: a request, or `run:<startedAt>`. */
function cutOf(child: string, reportId: string): string | undefined {
  const prefix = `report:${child}:cut:`
  return reportId.startsWith(prefix) ? reportId.slice(prefix.length) : undefined
}

/** The report that leaves an ask to the person, one per ask. */
function passedId(child: string, ask: string): string {
  return `report:${child}:person:${namedUuid(ask)}`
}

function sameWords(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** A harness's ask as a Fin's: an approval's options, or its one open question's. */
function nativeAsk(pending: PendingAsk): FinAsk {
  const options = pending.kind === "approval"
    ? pending.options.map((option) => ({ label: option.name.slice(0, 200) }))
    : pending.questions.length === 1
      ? pending.questions[0]!.options.map((option) => ({ label: option.label.slice(0, 200), ...(option.description && { detail: option.description.slice(0, 600) }) }))
      : []
  return { kind: pending.kind, id: pending.request, ...(options.length && { options: options.filter((option) => option.label).slice(0, ASK_OPTIONS) }), ...(pending.named && { named: true as const }) }
}

/**
 * An answer as its harness takes it: an approval's option (one named by its
 * label, else its allow-once or refuse-once by `allow`), or the one open
 * question's answer, an option's value when it names one.
 */
function permissionAnswer(pending: PendingAsk, input: Pick<AgentsAnswerInput, "answer" | "allow">): LivePermissionResponse | AgentRefused {
  const words = input.answer?.trim()
  if (pending.kind === "approval") {
    const named = words ? pending.options.find((option) => sameWords(option.name, words)) : undefined
    const by = (kind: "allow" | "reject") => pending.options.find((option) => option.kind === `${kind}_once`) ?? pending.options.find((option) => option.kind?.startsWith(kind))
    const option = named ?? (input.allow === undefined ? undefined : by(input.allow ? "allow" : "reject"))
    if (!option) return { refused: "conflict", why: `It asks for an approval: say allow: true or false, or name one of its options: ${pending.options.map((each) => each.name).join(", ")}.` }
    const feedback = !named && input.allow === false && words && pending.feedbackOption === option.optionId ? words : undefined
    return { kind: "choice", optionId: option.optionId, ...(feedback && { feedback }) }
  }
  if (pending.questions.length !== 1)
    return { refused: "conflict", why: `It asks ${pending.questions.length} questions at once, which only its Thread answers: leave them to the person with person: true.` }
  const question = pending.questions[0]!
  if (!words) return { refused: "conflict", why: "Its question needs an answer: one of its options by its label, or your own words." }
  const picked = question.options.find((option) => sameWords(option.label, words))
  if (!picked && question.options.length && !question.allowOther)
    return { refused: "conflict", why: `Its question takes one of its options: ${question.options.map((option) => option.label).join(", ")}.` }
  return { kind: "answers", answers: { [question.id]: [picked ? picked.value ?? picked.label : words] } }
}

function unknownFin(ref: string): AgentRefused {
  return { refused: "unknown-child", why: `No ${FIN_WORD} of this Thread is named ${ref}. agents_list shows them.` }
}

/** A Fin as another Fin of its Apex reads it: the person's words to it directly stay its own. */
function crewMate(fin: FrontDoorChild): CrewMate {
  return { name: fin.name, harness: fin.harness, state: fin.state, topic: fin.topic, ...(fin.branch && { branch: fin.branch }), ...(fin.report && { report: fin.report }), ...(fin.idleFor !== undefined && { idleFor: fin.idleFor }), ...(fin.openPRs && { openPRs: fin.openPRs }) }
}

/** Words on one line of a note: the first sentence, cut at `max` characters. */
function noteLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence
}

function entryLine(entry: Entry): string {
  if (entry.type === "user") return `user: ${entry.text}`
  if (entry.type === "text") return `agent: ${entry.text}`
  if (entry.type === "tool") return `tool: ${entry.title ?? entry.name}`
  return ""
}
