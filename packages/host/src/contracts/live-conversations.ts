import type { PromptDelivery } from "./prompt-delivery.js"
import type {
  NativeAgentObservation,
  NativeAgentRoster,
} from "./native-agents.js"
import type { ModelOption, SessionSettings, SettingValue } from "@mako/sessions/settings"
import type {
  ContextManifest,
  ConversationControl,
} from "./conversation-control.js"
import type { ThreadPage } from "@mako/sessions"
import type { ThreadPurposeKind } from "./thread-purposes.js"
import type { WorktreeStart } from "./thread-worktrees.js"
import type {
  LivePermissionRequest,
  PromptAttachment,
  LiveSessionState,
} from "./providers-acp.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { NativeActivity, NativeActivityObservation } from "./native-activity.js"
import type { RunSnapshots } from "./workspace-snapshots.js"
import type { RequestChanges } from "./turn-changes.js"
import type { TurnUndone } from "./turn-review.js"
import type { ProviderFailureKind } from "./provider-failure.js"
import type { LiveSessionUsage } from "./providers-acp.js"
import type { Actor } from "./thread-identity.js"
import type { NativePromptReference } from "./native-prompt-identity.js"
import type { Entry } from "@mako/sessions/entries"

export interface LiveStartOptions {
  initialRequest?: { id: string; text: string; attachments: PromptAttachment[] }
  conversationId: string
  resume?: string
  title?: string
  threadPath?: string
  displayPrompt?: string
  modeId?: string
  /** The access level to launch at when `modeId` is a native mode a launch-only harness enters live, such as Plan. */
  launchModeId?: string
  tuning?: SessionSettings
  /** The Thread-store Session this conversation starts in: an empty one a window's `+` tab created. */
  session?: string
  /** Start a new Thread in its own Git worktree of `cwd`'s repository, made on this first send. */
  worktree?: boolean
  /** Where that worktree starts, when the person chose: from another branch, or on an existing branch or pull request. */
  worktreeStart?: WorktreeStart
  /** Mako starts this new Thread for a job of its own; ignored for a resume or a `+` tab. */
  purpose?: ThreadPurposeKind
  /** A goal to set once the conversation starts, in place of a first message. */
  goal?: import("./live-goals.js").StartGoal
  /** A code review to start once the conversation starts, in place of a first message. */
  review?: import("./live-reviews.js").ReviewTarget
  /** Run this new conversation on a cloud machine instead, in a clone of the repository; `cwd` is then the machine's. */
  cloud?: import("./cloud-threads.js").CloudPlacement
}

/**
 * Why a turn stopped before the provider finished it. `stopped` is the user's
 * own Stop; the others are nobody's choice — Mako's exit or the provider's
 * own connection — and are what the transcript owns up to, with an offer to
 * continue the turn. A journal keeps a reason older builds don't know as one
 * they do, with the exact one beside it (`OLDER_READING`).
 */
export const INTERRUPTION_REASONS = [
  /** The user pressed Stop. */
  "stopped",
  /** Mako's host closed for a quit, restart or install while the turn ran. */
  "host-quit",
  /** The host died without closing; the next host found the turn still dispatching in the journal. */
  "host-crashed",
  /**
   * The provider's own connection to its backend dropped mid-turn and the
   * provider ended the turn on it (cursor-agent writes the error into the
   * transcript and reports `end_turn`). The work done so far is kept.
   */
  "connection-lost",
  /**
   * The provider's process ended mid-turn after it had accepted the prompt.
   * Its saved session holds the turn so far, so the turn resumes in a new
   * process rather than being sent again.
   */
  "provider-exited",
  /**
   * The provider's account signed out after it had accepted the prompt. The
   * turn so far stands in its session; it continues only when the user
   * resumes after signing in, never on its own.
   */
  "signed-out",
  /**
   * Mako stopped the turn to hand its Thread to another machine (the person
   * quit with agents running, or the Mac went to sleep). The turn so far
   * stands in its session, and Mako continues it where the Thread runs next:
   * in the cloud once it arrives, or here if the handoff couldn't finish.
   */
  "handed-off",
  /**
   * Mako couldn't write the conversation's journal (a full disk, a file it
   * can't write), so it stopped the turn rather than let the agent go on with
   * nothing saved. The turn so far stands in the provider's session; the
   * person continues it once Mako can save again, never Mako on its own.
   */
  "not-saved",
] as const
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number]

/**
 * The reasons every build reads. Builds before `not-saved` parse a saved
 * reason against these alone and refuse the whole journal for any other, so a
 * newer reason is never saved as `reason` itself.
 */
export const SAVED_REASONS = ["stopped", "host-quit", "host-crashed", "connection-lost", "provider-exited", "signed-out", "handed-off"] as const satisfies readonly InterruptionReason[]
export type SavedReason = (typeof SAVED_REASONS)[number]

/**
 * What a build that predates a reason should take it for: the nearest reason
 * it knows, chosen by the build that writes it. The journal saves that one as
 * `reason` and the exact one as `exactReason`, which older builds pass over
 * and newer ones read; a reason added later must say its older reading here.
 * `not-saved` reads as the person's Stop, which is how every build before it
 * recorded this stop.
 */
export const OLDER_READING = { "not-saved": "stopped" } as const satisfies Record<Exclude<InterruptionReason, SavedReason>, SavedReason>

function isSavedReason(reason: InterruptionReason): reason is SavedReason {
  return SAVED_REASONS.some((saved) => saved === reason)
}

/** A reason as a journal keeps it: one every build reads, with the exact one beside it when that is newer. */
export function savedReason(reason: InterruptionReason): { reason: SavedReason; exactReason?: InterruptionReason } {
  return isSavedReason(reason) ? { reason } : { reason: OLDER_READING[reason], exactReason: reason }
}

/** The reason a journal kept: its exact one when this build knows it, else the one every build reads. */
export function readReason(reason: InterruptionReason, exactReason: string | undefined): InterruptionReason {
  return INTERRUPTION_REASONS.find((known) => known === exactReason) ?? reason
}

export interface Interruption {
  reason: InterruptionReason
  at: number
  /**
   * Mako will pick this turn up itself: the continuation is scheduled for
   * `at` (epoch ms). Present only while it is pending — cleared when the
   * continuation is submitted or when something else (a prompt of the user's,
   * a close, a host exit) makes it moot. A dropped connection or an exited
   * provider process earns this; the turn's work stands on the provider's side.
   */
  autoContinue?: { at: number }
  /**
   * The calls the agent has no account of: ones cut off without a result,
   * and ones that finished after its last step. At most
   * `MAX_INTERRUPTED_CALLS`; `moreCalls` counts the rest.
   */
  calls?: InterruptedCall[]
  moreCalls?: number
  /** When the next prompt told the agent about `calls` (epoch ms). It is told once. */
  told?: number
  /**
   * The calls Mako itself closed when the turn ended, by id: nothing would
   * report on them now. Each keeps what it had produced; only its status is
   * Mako's.
   */
  closed?: string[]
  /**
   * The background work the cut stopped (a host exit, a handoff), in the
   * words the agent is told when the turn continues (`continueTurnPrompt`)
   * and the turn's footer names to the person: each command line or agent
   * prompt the roster held, and how many more the harness counted. Absent
   * when nothing was left running.
   */
  stopped?: string[]
}

export const MAX_INTERRUPTED_CALLS = 12

export interface InterruptedCall {
  id: string
  title: string
  /** `none`: it never returned. `unseen`: it returned after the agent's last step. */
  result: "none" | "unseen"
  /** Where Mako saved an unseen result in full, for the agent to read. */
  file?: string
}

/**
 * What a request that carries on an earlier, cut-short turn records about
 * it. `auto` is a continuation Mako words itself, sent on its own or on the
 * user's Resume; the transcript shows it as Mako's line rather than as the
 * user's words.
 */
export interface TurnContinuation {
  requestId: string
  reason: InterruptionReason
  auto: boolean
}

/**
 * The sign-out a session's work is paused on. It belongs to the session, so
 * every request it holds carries the same marker, and it persists with them.
 * `credential` is a one-way digest of the account's credentials when the
 * sign-out was seen; a different digest later means someone signed in.
 */
export interface SignInHold {
  harness: string
  account: string
  credential: string
  at: number
}

/** Whether a paused session can resume: the account was signed in again, or another one chosen. */
export type SignInReadiness = "signed-out" | "ready"

/** What Resume did: `resumed` also answers a pause that had already ended. */
export type SignInResume = "resumed" | "signed-out"

/** What keeps a session on its old account while a message waits to switch it. */
export const ACCOUNT_SWITCH_WAITS = ["background", "subagents", "approval", "turn", "operation"] as const
export type AccountSwitchWait = (typeof ACCOUNT_SWITCH_WAITS)[number]

/** When a held request sends itself, and the failed request it repeats. */
export interface RequestWake {
  at: number
  after: string
}

export interface LiveRequest {
  /**
   * Who sent it, assigned by the host at admission. Absent in older journals:
   * some of their requests came from the relay or an automatic continuation,
   * and the journal cannot say which.
   */
  actor?: Actor
  /** Native send evidence, independent of execution outcome; absent in older journals. */
  nativeDelivery?: PromptDelivery
  /** Exact request/native-message correspondence from a declared native receipt. */
  nativePrompt?: NativePromptReference
  targetBindingId?: string
  snapshots?: RunSnapshots
  /**
   * What its turn changed, as the attribution journal counted it once the
   * turn ended (`TurnChanges`): the one record the line under the answer,
   * its file links and "changes made" read. Absent for a turn from before
   * Mako counted them, which only its checkpoints can say.
   */
  changes?: RequestChanges
  /** Its turn was undone (`TurnUndone`): when, how much, and the ref the checkout before it is kept under. */
  undone?: TurnUndone
  tuning?: SessionSettings
  inputDigest?: string
  nativeRun?: { bindingId: string; runId: string; forkId?: string }
  id: string
  text: string
  attachments: PromptAttachment[]
  /**
   * `dispatching` is committed in the same batch as the request's user turn
   * (unless it has no text and no attachments). Renderers rely on this: a
   * dispatched request's prompt is in the transcript even when no loaded
   * history page holds it.
   */
  status:
    | "queued"
    | "held"
    | "canceled"
    | "dispatching"
    | "completed"
    | "failed"
    | "uncertain"
    | "interrupted"
  error?: string
  /**
   * A queued request the native process refused because the account changed
   * under it. It waits, unsent, until the session can reopen under the newly
   * selected account; `waitingFor` is what still holds the old process.
   */
  accountSwitch?: { reason: "selection" | "credentials"; waitingFor: AccountSwitchWait }
  /**
   * The sign-out this request waits on. A `held` request is unsent and goes
   * when the user resumes; the turn the sign-out cut short keeps its own
   * outcome and is continued, or left for review, on Resume.
   */
  signIn?: SignInHold
  /**
   * A `held` request that releases itself at `at` (epoch ms): a message the
   * person asked to send again once a usage limit resets. `after` is the
   * failed request it repeats. It waits like any held message, a Resume
   * sends it now and removing it cancels the wait; the host's held-wakes job
   * releases it when the time comes, across restarts, since the journal keeps it.
   */
  wake?: RequestWake
  /** Present on an `interrupted` or `uncertain` request that a Stop or a host exit cut short. */
  interruption?: Interruption
  /**
   * What `error` means, decided once on the host from the provider's text.
   * Shared recovery combines this cause with nativeDelivery evidence;
   * retriability alone does not establish safe replay.
   */
  failure?: ProviderFailureKind
  /** Where this request's spend counts from: the meter at the last turn's end (`spentThrough`), else when it was dispatched. */
  usageFrom?: UsageMark
  /**
   * What answering this request spent, as Mako measured it between the
   * harness's readings. Every harness's turns keep one; for harnesses whose
   * own store keeps no usage it is the only record.
   */
  spend?: import("./usage-ledger.js").TurnSpend
  /** Set when this request continues an interrupted turn; see `TurnContinuation`. */
  continues?: TurnContinuation
  /**
   * A message that waited here and went with its Thread to another machine (a move, a handoff), sent there under
   * the same id. It's `canceled` here: it runs there, never here.
   */
  carried?: { at: number; to: "cloud" }
  /** A message that sets, pauses, resumes or clears the goal, or the `turn`th continuation Mako's goal loop sent. */
  goal?: { step: import("./live-goals.js").GoalCommand["kind"] | "continue"; turn?: number }
  /** A code review of the target, sent the way the harness starts its review. */
  review?: import("./live-reviews.js").ReviewTarget
  /** A command the harness reads only at the start of the message: sent as written, without Mako's notes or pending context. */
  verbatim?: true
  displayText?: string
  context?: ContextManifest[]
}

export interface LiveSummary {
  /** Saved session questions keep their conversation controls available after process exit. */
  hasSessionQuestions?: boolean
  nativePaths?: string[]
  session: LiveSessionState
  revision: number
  /**
   * Which host generation numbered `revision`. Revisions climb within one
   * host's life and a restarted host continues from the journal, but a
   * recovering host rewrites what it reopens (interrupted requests, a dropped
   * connection) and two hosts never share a counter. A renderer holding state
   * from one epoch does not merge a batch from another onto it: it takes a
   * fresh snapshot instead.
   */
  epoch?: string
  threadPath?: string
  /**
   * Where its folder is when it isn't on this computer, in words (`a cloud machine`): a window shows its files and
   * Git as that host reads them, naming the conversation, since a path there can be another conversation's too.
   */
  elsewhere?: string
  /**
   * What a conversation listed from another device waits on, in a line ("Approve: npm test"), while it waits on a
   * person there: the row asks for them as a local one would.
   */
  waitingOn?: string
  /**
   * Read from the account's copy, its device being off: when that device wrote it. Nothing in it runs or answers until
   * the device is back; a window says so and how old it is.
   */
  copy?: { at: number }
  createdAt: number
  /** The soonest a held request here sends itself (`LiveRequest.wake`). */
  wakeAt?: number
  /** The Thread and Session this conversation belongs to, the same IDs a catalog row carries. */
  threadId?: string
  sessionId?: string
}

/** A native session, as the catalog reads it. */
export interface BaseSource {
  harness: string
  nativeId: string
  path: string
  /**
   * A conversation that went on in more than one session reads only part of
   * this one: its first `entries` record entries, whose ids hash to `ids`,
   * as Mako had captured them by `heldAt` (epoch ms). Read again, the session
   * gives them while it still begins so; once its harness has rewritten them,
   * the record store gives them as they were then (`ThreadPageOptions.asOf`).
   * Absent: the session whole, as its one binding goes on in it.
   */
  span?: BaseSpan
}

export interface BaseSpan {
  entries: number
  ids: string
  heldAt: number
}

/** A meter reading, as a turn's spend is measured between two. */
export type UsageMark = Pick<LiveSessionUsage, "tokens" | "cost" | "unrecorded">

export interface SpentThrough {
  bindingId: string
  usage: UsageMark
}

/**
 * Spend no request of Mako's holds: a turn the harness ran without one (on
 * a subagent's report, a finished command, a compaction), or, `after`,
 * what the session spent after its last turn before its process ended.
 */
export interface HarnessTurn {
  id: string
  kind: "turn" | "after"
  spend: import("./usage-ledger.js").TurnSpend
}

export interface LiveSnapshot extends LiveSummary {
  /** Renderer-only retained-history window; never persisted in the journal. */
  history?: import("./live-history.js").LiveHistoryWindow
  nativeAgents?: NativeAgentRoster
  /** The goal the conversation is working toward. */
  goal?: import("./live-goals.js").ConversationGoal
  control?: ConversationControl
  blocks: Entry[]
  /** Null while a base read from `baseSource` hasn't been read yet (`baseUnread`). */
  base: ThreadPage | null
  /**
   * The native session `base` is the whole history of, when that session's
   * records are in Mako's record store. The journal then keeps no copy of it
   * while the base meets every live block (`baseFromSource`); the base is
   * read again from the session when the conversation opens.
   */
  baseSource?: BaseSource
  /** Prefix of retained live blocks already represented by the native base. */
  baseCoveredBlocks?: number
  /**
   * The base's absolute entry index where the retained live blocks begin,
   * once it covers any of them: an earlier live turn's fork starts from the
   * native history before it, since the base also holds the turns after.
   */
  baseLiveStart?: number
  /**
   * How many entries before `baseLiveStart` a native fork's inherited turns
   * took from its parent's history (`mergedBase`): what its parent's stream
   * supplied, which its own record never held. Its record's live start is
   * `baseLiveStart` less this. Absent until those turns were merged.
   */
  baseSupplied?: number
  permissions: LivePermissionRequest[]
  requests: LiveRequest[]
  /** The turns Mako didn't send, and what was spent after the last turn, each with its spend; see `HarnessTurn`. */
  harnessTurns?: HarnessTurn[]
  /**
   * Where the next turn's spend counts from: the meter at the last turn's
   * end, in the process that read it. Spend between turns, a background
   * subagent working while its parent is idle, counts in the next turn,
   * Mako's or the harness's own. Held by this host only; a new process's
   * meter starts over, so it goes with the process.
   */
  spentThrough?: SpentThrough
  /**
   * When the provider last showed it was working, in host epoch milliseconds:
   * a turn starting, streamed content or tool output, a question, a child
   * agent. A running turn quiet since then is shown as quiet, never ended.
   * Held by this host only; the journal does not keep it.
   */
  activityAt?: number
  /** Held by this host only, like `activityAt`; see `NativeActivity`. */
  nativeActivity?: NativeActivity
  /** Held by this host only, like `activityAt`; see `SideConversation`. */
  side?: import("./live-side-questions.js").SideConversation
  /**
   * Why the history `baseSource` names could not be read, which neither its
   * harness nor the record store had. Held by this host only: the next load
   * reads it again. Messages still go to the harness meanwhile.
   */
  historyFailure?: string
}

export interface LiveBatch {
  activityAt?: number
  /** `null` when the activity ended; absent when it did not change. */
  nativeActivity?: NativeActivity | null
  /** Absolute retained-block coordinates for consumers holding a history window. */
  changedFrom?: number
  blockCount?: number
  /** The event is an invalidation; reread through the bounded history protocol. */
  historyChanged?: boolean
  nativeAgents?: NativeAgentRoster
  /** `null` when the goal went away; absent when it did not change. */
  goal?: import("./live-goals.js").ConversationGoal | null
  /** `null` when the side conversation closed; absent when it did not change. */
  side?: import("./live-side-questions.js").SideConversation | null
  /** `null` when the history was read after all; absent when it did not change. */
  historyFailure?: string | null
  /** Every turn Mako didn't send, when one was added; absent when none was. */
  harnessTurns?: HarnessTurn[]
  /** `null` when the process went; absent when it did not change. */
  spentThrough?: SpentThrough | null
  control?: ConversationControl
  base?: ThreadPage | null
  baseCoveredBlocks?: number
  threadPath?: string | null
  id: string
  revision: number
  /** The host generation that numbered `revision`; see `LiveSummary.epoch`. */
  epoch?: string
  updates: LiveUpdate[]
  /** The whole session, for a receiver that holds none; see `sessionAfter`. */
  session?: LiveSessionState
  /** The session fields that changed; the rest, as a harness's commands and models, are as the receiver has them. */
  sessionChanges?: Partial<LiveSessionState>
  /** The session fields that went away. */
  sessionCleared?: (keyof LiveSessionState)[]
  /**
   * New current values for the option list the receiver holds, by option id;
   * `null` where one no longer has a value. A harness's list can carry
   * hundreds of kilobytes of model choices, and choosing a mode moves one
   * value in it.
   */
  configCurrents?: Record<string, SettingValue | null>
  permissions?: LivePermissionRequest[]
  /** Every request, when one went away or they changed order; see `requestChanges`. */
  requests?: LiveRequest[]
  /** The requests that changed or were added since the last batch, the rest kept in order; see `requestsAfter`. */
  requestChanges?: LiveRequest[]
}

/** How a batch carries `next`: only what changed while the earlier requests keep their places. */
export function requestsDelta(previous: readonly LiveRequest[], next: LiveRequest[]): Pick<LiveBatch, "requests" | "requestChanges"> {
  if (previous === next) return {}
  if (next.length < previous.length || previous.some((request, index) => next[index]!.id !== request.id)) return { requests: next }
  return { requestChanges: next.filter((request, index) => request !== previous[index]) }
}

/** The fields a session object holds, as its producers typed it. */
function sessionKeys(session: LiveSessionState): (keyof LiveSessionState)[] {
  // SAFETY: sessions are built only from typed `LiveSessionState` values, so
  // every own key is one of its fields.
  return Object.keys(session) as (keyof LiveSessionState)[]
}

function copyField<Key extends keyof LiveSessionState>(target: Partial<LiveSessionState>, source: LiveSessionState, key: Key): void {
  target[key] = source[key]
}

type SessionDelta = Pick<LiveBatch, "sessionChanges" | "sessionCleared" | "configCurrents">

/** How a batch carries `next`: only the fields whose values are not `previous`'s; see `sharedSession`. */
export function sessionDelta(previous: LiveSessionState, next: LiveSessionState): SessionDelta {
  const delta: SessionDelta = {}
  if (previous === next) return delta
  const changes: Partial<LiveSessionState> = {}
  const cleared: (keyof LiveSessionState)[] = []
  let changed = false
  for (const key of sessionKeys(next)) {
    if (next[key] === undefined) {
      if (previous[key] !== undefined) cleared.push(key)
      continue
    }
    if (next[key] === previous[key]) continue
    const currents = key === "configOptions" ? currentsMoved(previous.configOptions, next.configOptions) : undefined
    if (currents) delta.configCurrents = currents
    else { copyField(changes, next, key); changed = true }
  }
  for (const key of sessionKeys(previous))
    if (!(key in next) && previous[key] !== undefined) cleared.push(key)
  if (changed) delta.sessionChanges = changes
  if (cleared.length) delta.sessionCleared = cleared
  return delta
}

/** The current values that moved, when they are all that differs between two option lists. */
function currentsMoved(previous: readonly ModelOption[] | undefined, next: readonly ModelOption[]): Record<string, SettingValue | null> | undefined {
  if (!previous?.length || previous.length !== next.length) return undefined
  const moved: Record<string, SettingValue | null> = {}
  let any = false
  for (const [index, option] of next.entries()) {
    const held = previous[index]!
    if (held === option) continue
    if (held.id !== option.id || canonicalJson(withoutCurrent(held)) !== canonicalJson(withoutCurrent(option))) return undefined
    if (held.current === option.current) continue
    moved[option.id] = option.current ?? null
    any = true
  }
  return any ? moved : undefined
}

function withoutCurrent<Option extends ModelOption>(option: Option): Option {
  const next = { ...option }
  delete next.current
  return next
}

function withCurrent(option: ModelOption, value: SettingValue | null): ModelOption {
  if (option.kind === "boolean") return value === true || value === false ? { ...option, current: value } : withoutCurrent(option)
  return value === null || value === true || value === false ? withoutCurrent(option) : { ...option, current: value }
}

/** `options` with `currents` applied, each by option id. */
function withCurrents(options: readonly ModelOption[], currents: Record<string, SettingValue | null>): ModelOption[] {
  return options.map((option) => {
    const value = currents[option.id]
    return value === undefined ? option : withCurrent(option, value)
  })
}

/** The session after `batch`, from the one the receiver held. */
export function sessionAfter(current: LiveSessionState, batch: Pick<LiveBatch, "session" | "sessionChanges" | "sessionCleared" | "configCurrents">): LiveSessionState {
  if (batch.session) return batch.session
  if (!batch.sessionChanges && !batch.sessionCleared && !batch.configCurrents) return current
  const next = { ...current, ...batch.sessionChanges }
  if (batch.configCurrents) next.configOptions = withCurrents(next.configOptions, batch.configCurrents)
  for (const key of batch.sessionCleared ?? []) delete next[key]
  return next
}

/** Whether `batch` changed the session at all. */
export function changesSession(batch: Pick<LiveBatch, "session" | "sessionChanges" | "sessionCleared" | "configCurrents">): boolean {
  return Boolean(batch.session || batch.sessionChanges || batch.sessionCleared || batch.configCurrents)
}

/**
 * `next` keeping `previous`'s value for every field equal in content. A
 * harness reports its whole session each time, and its commands and models
 * arrive as new arrays even when nothing in them changed.
 */
export function sharedSession(previous: LiveSessionState, next: LiveSessionState): LiveSessionState {
  let shared: LiveSessionState | undefined
  for (const key of sessionKeys(next))
    if (next[key] !== previous[key] && canonicalJson(next[key]) === canonicalJson(previous[key]))
      copyField(shared ??= { ...next }, previous, key)
  return shared ?? next
}

/** JSON text whatever order its producer wrote each object's keys in: a list restored from storage equals the one a harness reports again. */
function canonicalJson<Value>(value: Value): string | undefined {
  return JSON.stringify(value, (_key, field) =>
    field instanceof Object && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : field)
}

/** The requests after `batch`, from those the receiver held; `undefined` when the batch changed none. */
export function requestsAfter(current: readonly LiveRequest[] | undefined, batch: Pick<LiveBatch, "requests" | "requestChanges">): LiveRequest[] | undefined {
  if (batch.requests) return batch.requests
  if (!batch.requestChanges) return undefined
  const next = [...(current ?? [])]
  const index = new Map(next.map((request, at) => [request.id, at]))
  for (const request of batch.requestChanges) {
    const at = index.get(request.id)
    if (at === undefined) next.push(request)
    else next[at] = request
  }
  return next
}

export type LiveDriverEvent =
  | { type: "live-question-answered"; id: string; answer: import("./live-questions.js").NativeQuestionAnswer }
  | { type: "live-question"; id: string; question: import("./live-questions.js").NativeQuestion }
  | { type: "live-approval-decision"; id: string; decision: import("./approval-response.js").NativeApprovalDecision }
  | { type: "live-permission-ended"; id: string; requestId: string; observationId: string; source: import("./approval-response.js").ApprovalEndSource }
  | { type: "live-action-result"; id: string; actionId: string; result: import("./live-actions.js").LiveActionResult }
  | { type: "live-agent"; id: string; agent: NativeAgentObservation }
  /** `null`: whatever the provider was doing without output has ended. */
  | { type: "live-activity"; id: string; activity: NativeActivityObservation | null }
  | { type: "live-session"; session: LiveSessionState }
  | { type: "live-update"; id: string; update: LiveUpdate }
  | { type: "live-updates"; id: string; updates: LiveUpdate[] }
  /** The harness dropped its own history from the turn whose native run id is `run` on. */
  | { type: "live-rewound"; id: string; run: string }
  /** The goal the harness is working toward; `null` when it has none. */
  | { type: "live-goal"; id: string; goal: import("./live-goals.js").GoalObservation | null }
  | { type: "live-permission"; request: LivePermissionRequest }
