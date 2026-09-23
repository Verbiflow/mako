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
import type {
  LivePermissionRequest,
  PromptAttachment,
  LiveSessionState,
  LiveUpdate,
} from "./providers-acp.js"
import type { LiveBlock } from "./live-content.js"
import type { RunSnapshots } from "./workspace-snapshots.js"
import type { ProviderFailureKind } from "./provider-failure.js"

export interface LiveStartOptions {
  initialRequest?: { id: string; text: string; attachments: PromptAttachment[] }
  conversationId: string
  resume?: string
  title?: string
  threadPath?: string
  displayPrompt?: string
  modeId?: string
  tuning?: SessionSettings
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
] as const
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number]

export interface Interruption {
  reason: InterruptionReason
  at: number
  /**
   * Mako will pick this turn up itself: the continuation is scheduled for
   * `at` (epoch ms). Present only while it is pending — cleared when the
   * continuation is submitted or when something else (a prompt of the user's,
   * a close, a host exit) makes it moot. A dropped connection is the one
   * reason that earns this; the turn's work stands on the provider's side.
   */
  autoContinue?: { at: number }
}

/**
 * What a request that carries on an earlier, cut-short turn records about
 * it. `auto` is Mako's own continuation, sent without the user; the
 * transcript shows it as Mako's line rather than as the user's words.
 */
export interface TurnContinuation {
  requestId: string
  reason: InterruptionReason
  auto: boolean
}

export interface LiveRequest {
  /** Native send evidence, independent of execution outcome; absent in older journals. */
  nativeDelivery?: PromptDelivery
  targetBindingId?: string
  snapshots?: RunSnapshots
  tuning?: SessionSettings
  inputDigest?: string
  nativeRun?: { bindingId: string; runId: string; forkId?: string }
  id: string
  text: string
  attachments: PromptAttachment[]
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
  /** Present on an `interrupted` or `uncertain` request that a Stop or a host exit cut short. */
  interruption?: Interruption
  /**
   * What `error` means, decided once on the host from the provider's text.
   * Shared recovery combines this cause with nativeDelivery evidence;
   * retriability alone does not establish safe replay.
   */
  failure?: ProviderFailureKind
  /** Set when this request continues an interrupted turn; see `TurnContinuation`. */
  continues?: TurnContinuation
  displayText?: string
  context?: ContextManifest[]
}

export interface LiveSummary {
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
}

export interface LiveSnapshot extends LiveSummary {
  nativeAgents?: NativeAgentRoster
  control?: ConversationControl
  blocks: LiveBlock[]
  base: ThreadPage | null
  /** Prefix of retained live blocks already represented by the native base. */
  baseCoveredBlocks?: number
  permissions: LivePermissionRequest[]
  requests: LiveRequest[]
}

export interface LiveBatch {
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
  requests?: LiveRequest[]
}

export type LiveDriverEvent =
  | { type: "live-action-result"; id: string; actionId: string; result: import("./live-actions.js").LiveActionResult }
  | { type: "live-agent"; id: string; agent: NativeAgentObservation }
  | { type: "live-session"; session: LiveSessionState }
  | { type: "live-update"; id: string; update: LiveUpdate }
  | { type: "live-updates"; id: string; updates: LiveUpdate[] }
  | { type: "live-permission"; request: LivePermissionRequest }
