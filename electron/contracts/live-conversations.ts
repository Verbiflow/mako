import type { PromptDelivery } from "./prompt-delivery.js"
import type {
  NativeAgentObservation,
  NativeAgentRoster,
} from "./native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
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
  LiveUpdate,
} from "./providers-acp.js"
import type { LiveBlock } from "./live-content.js"
import type { NativeActivity, NativeActivityObservation } from "./native-activity.js"
import type { RunSnapshots } from "./workspace-snapshots.js"
import type { ProviderFailureKind } from "./provider-failure.js"
import type { LiveSessionUsage, TokenCounts } from "./providers-acp.js"
import type { Actor } from "./thread-identity.js"
import type { NativePromptReference } from "./native-prompt-identity.js"

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
}

/**
 * Why a turn stopped before the provider finished it. `stopped` is the user's
 * own Stop; the others are nobody's choice — Mako's exit or the provider's
 * own connection — and are what the transcript owns up to, with an offer to
 * continue the turn.
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
] as const
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number]

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
export const ACCOUNT_SWITCH_WAITS = ["background", "subagents", "children", "approval", "turn", "operation"] as const
export type AccountSwitchWait = (typeof ACCOUNT_SWITCH_WAITS)[number]

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
  /** Present on an `interrupted` or `uncertain` request that a Stop or a host exit cut short. */
  interruption?: Interruption
  /**
   * What `error` means, decided once on the host from the provider's text.
   * Shared recovery combines this cause with nativeDelivery evidence;
   * retriability alone does not establish safe replay.
   */
  failure?: ProviderFailureKind
  /** The session's usage reading when this request was dispatched; `spend` is measured from it. */
  usageFrom?: Pick<LiveSessionUsage, "tokens" | "cost">
  /** What answering this request spent, kept for harnesses whose own store records no usage. */
  spend?: { provider: string; model?: string; at: number; tokens?: TokenCounts; cost?: number }
  /** Set when this request continues an interrupted turn; see `TurnContinuation`. */
  continues?: TurnContinuation
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
  createdAt: number
  /** The Thread and Session this conversation belongs to, the same IDs a catalog row carries. */
  threadId?: string
  sessionId?: string
}

export interface LiveSnapshot extends LiveSummary {
  /** Renderer-only retained-history window; never persisted in the journal. */
  history?: import("./live-history.js").LiveHistoryWindow
  nativeAgents?: NativeAgentRoster
  control?: ConversationControl
  blocks: LiveBlock[]
  base: ThreadPage | null
  /** Prefix of retained live blocks already represented by the native base. */
  baseCoveredBlocks?: number
  permissions: LivePermissionRequest[]
  requests: LiveRequest[]
  /**
   * When the provider last showed it was working, in host epoch milliseconds:
   * a turn starting, streamed content or tool output, a question, a child
   * agent. A running turn quiet since then is shown as quiet, never ended.
   * Held by this host only; the journal does not keep it.
   */
  activityAt?: number
  /** Held by this host only, like `activityAt`; see `NativeActivity`. */
  nativeActivity?: NativeActivity
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
  control?: ConversationControl
  base?: ThreadPage | null
  baseCoveredBlocks?: number
  threadPath?: string | null
  id: string
  revision: number
  /** The host generation that numbered `revision`; see `LiveSummary.epoch`. */
  epoch?: string
  updates: LiveUpdate[]
  session?: LiveSessionState
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
  | { type: "live-permission"; request: LivePermissionRequest }
