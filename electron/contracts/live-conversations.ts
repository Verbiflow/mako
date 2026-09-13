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
 * own Stop; the other two are Mako's doing and are what the transcript owns
 * up to, with an offer to continue the turn.
 */
export const INTERRUPTION_REASONS = [
  /** The user pressed Stop. */
  "stopped",
  /** Mako's host closed for a quit, restart or install while the turn ran. */
  "host-quit",
  /** The host died without closing; the next host found the turn still dispatching in the journal. */
  "host-crashed",
] as const
export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number]

export interface Interruption {
  reason: InterruptionReason
  at: number
}

export interface LiveRequest {
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
   * The renderer describes it with the provider's name and offers Send again
   * only when the kind is retriable.
   */
  failure?: ProviderFailureKind
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
  permissions: LivePermissionRequest[]
  requests: LiveRequest[]
}

export interface LiveBatch {
  nativeAgents?: NativeAgentRoster
  control?: ConversationControl
  base?: ThreadPage | null
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
  | { type: "acp-agent"; id: string; agent: NativeAgentObservation }
  | { type: "acp-session"; session: LiveSessionState }
  | { type: "acp-update"; id: string; update: LiveUpdate }
  | { type: "acp-updates"; id: string; updates: LiveUpdate[] }
  | { type: "acp-permission"; request: LivePermissionRequest }
