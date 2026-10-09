import type { ApprovalOrigin } from "./approval-response.js"
import type { AccessEnforcement, AccessTier } from "./access.js"

/**
 * How a mid-turn message reaches the running agent. `step` folds it into the
 * running turn at the agent's next step; `interrupt` cancels the current step
 * and continues with the message. A provider that can only queue a message
 * behind the running turn advertises no steering at all.
 */
export type LiveSteering = "step" | "interrupt"

/**
 * One provider, described once. The desk renders every provider-shaped
 * surface from this — what it is called, whether a headless run can continue
 * its sessions, whether an interactive transport can drive it, and what the
 * running session can be asked to do. New capabilities are fields here, not
 * new channels.
 */
export interface HarnessDescriptor {
  provider: string
  displayName: string
  presentation?: import("./harness-presentation.js").HarnessPresentation
  /** Mako's model choices for this harness until the person makes their own. */
  defaults?: import("./harness-defaults.js").HarnessDefaults
  /** A headless native run can continue this provider's sessions. */
  resumable: boolean
  /** An interactive transport can drive this provider right now. */
  live: boolean
  /** What a live conversation with this harness can do, each with how or why not, as the harness declares it. */
  capabilities: import("./harness-capabilities.js").LiveCapabilities
  /** What the harness reports about usage, each with where or why not; the meter and account rows read it. */
  usage: import("./harness-usage.js").HarnessUsage
  /** The files the harness writes that the viewer previews, or why it writes none. */
  artifacts: import("./harness-unique.js").ArtifactCapability
  /** What only this harness has, each with where Mako shows it or why it doesn't. */
  unique: readonly import("./harness-unique.js").UniqueCapability[]
  /**
   * The access ladder a new session with this provider offers, known before
   * any process starts so the desk can take the choice with the first prompt.
   * A running session's own advertised list still governs that session.
   */
  modes?: LiveSessionMode[]
  /**
   * The adapter's factory default. Native user/project configuration may
   * override it; this is not an observed effective permission level.
   */
  defaultMode?: string
}

import type { SessionModel, SessionSettings } from "@mako/sessions/settings"
export type {
  ModelChoice as HarnessSelectValue,
  ModelOption as HarnessModelOption,
  ModelVariant as HarnessModelVariant,
  SessionModel as HarnessModel,
} from "@mako/sessions/settings"

export interface HarnessProfile {
  id: string
  label: string
  available: boolean
  transport: "acp" | "app-server" | "sdk" | "remote"
  models: SessionModel[]
  defaultModel?: string
  configuredModel?: string
  /** Provider-resolved defaults in the requested workspace. Never saved as user choices. */
  settings?: SessionSettings
  configurationError?: string
  error?: string
  /** Discovery is still running; nothing here is known yet. */
  pending?: boolean
}

/* ------------------------------------------------------------------ */
/* Interactive foreign agents (ACP)                                    */
/* ------------------------------------------------------------------ */

/**
 * One selectable mode. `access` places a provider's own mode on the shared
 * ladder; a mode without it is provider-specific and shown as named.
 */
export interface LiveSessionMode {
  id: string
  name: string
  access?: AccessTier
  enforcement?: AccessEnforcement
  description?: string
}

/**
 * A slash invocation the provider says this session accepts. `description`
 * and `hint` are only what the provider reported — a transport that lists
 * names alone (the Claude SDK) leaves them out rather than inventing copy.
 */
export interface LiveSessionCommand {
  name: string
  description?: string
  hint?: string
}

/**
 * Tokens by kind, the same meaning for every harness: `input` is what the
 * model read fresh, with cache reads and writes counted apart from it;
 * `output` is everything it wrote, `reasoning` included. Each harness's
 * reader converts its own convention (OpenAI-style counts include cached
 * input; OpenCode counts reasoning outside output) before anything is added.
 */
export interface TokenCounts {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** The part of `output` spent reasoning, when the harness says. */
  reasoning?: number
}

/**
 * What a session has used, from the harness's own numbers only. Every part
 * is optional because harnesses report different parts: Cursor reports
 * tokens per turn but nothing about how full the context is.
 */
export interface LiveSessionUsage {
  /** Tokens in the model's context at its last call; set with `size`. */
  used?: number
  /** The window `used` is measured against. */
  size?: number
  /**
   * The context was compacted after `used` was read. A harness that reports
   * the size after compaction replaces `used` and leaves this unset.
   */
  compacted?: boolean
  /** Tokens spent since this live session started, by kind. */
  tokens?: TokenCounts
  /** Spend since this live session started, as the harness reports it. */
  cost?: { amount: number; currency: string }
  /**
   * How many of the harness's reports said they left spend out: `tokens`
   * counts reports whose token counts miss calls, `cost` every report that
   * left cost out, those included. Either makes `tokens` or `cost` a floor,
   * not the total.
   */
  unrecorded?: { tokens: number; cost: number }
  /** The harness's own totals for the native session, from a harness whose totals outlive its process. */
  native?: NativeTotals
}

/** A harness's running totals for a native session across its processes: tokens by kind, and cost in USD. */
export interface NativeTotals {
  tokens: TokenCounts
  cost?: number
}

/** One part of what fills the context, from a harness that itemizes it (Claude). */
export interface ContextCategory {
  name: string
  tokens: number
  /** `free` is unused window; `buffer` is held back for compaction; `deferred` is listed but not in the window. */
  kind: "used" | "free" | "buffer" | "deferred"
}

export interface ContextBreakdown {
  used: number
  size: number
  categories: ContextCategory[]
  /** The largest single items inside the categories, such as one MCP server's tools or one memory file. */
  items: { group: "mcp" | "memory" | "agents" | "skills"; name: string; tokens: number }[]
}

export interface LiveSessionState {
  /** Reported by this launch; absent in journals written before context retention. */
  executionContext?: import("./execution-context.js").ExecutionContext
  nativeRunId?: string
  nativeForkId?: string
  nativePath?: string
  connection: "starting" | "connected" | "hibernated" | "disconnected"
  id: string
  nativeId?: string
  harness: string
  cwd: string
  title?: string
  status: "starting" | "ready" | "running" | "failed" | "closed"
  modes: LiveSessionMode[]
  currentMode: string | null
  /** The access level a launch-only harness's process runs under, whatever native mode, such as Plan, it is in now. */
  launchMode?: string
  /** Slash commands the provider advertised for this session, when it does. */
  commands?: LiveSessionCommand[]
  /** Exact context reading the provider last reported; absent until it does. */
  usage?: LiveSessionUsage
  configOptions: import("@mako/sessions/settings").ModelOption[]
  settings?: SessionSettings
  /**
   * How the last turn ended: the agent's own stop reason (`end_turn`,
   * `cancelled`, …), `failed`, or `CONNECTION_LOST_STOP` when the agent
   * ended the turn on a dropped backend connection it reported itself.
   */
  lastStop?: string
  error?: string
  /**
   * Background commands the provider's process still runs after its turn
   * ended, as the provider reports them. They die with that process, so
   * while this is above zero the session is busy and is never hibernated.
   */
  backgroundTasks?: number
}

/**
 * The `lastStop` of a turn the agent ended because its own connection to
 * its backend dropped. The session is `failed` with the agent's error text;
 * the request that ran it is recorded as interrupted and continuable rather
 * than as a message to send again, because the turn's work is kept.
 */
export const CONNECTION_LOST_STOP = "connection-lost"

/**
 * The `lastStop` of a turn the agent's own transport gave up on after
 * retrying it. Each of those retries already re-ran the turn, so the request
 * is failed and never continued by the host, whatever its error text says.
 */
export const RETRIES_EXHAUSTED_STOP = "retries-exhausted"

export interface PromptAttachment {
  name: string
  mimeType: string
  /** Absent when native history preserved only a source path. */
  size?: number
  data?: string
  path?: string
}

export type { LiveInputQuestion } from "./live-questions.js"
import type { LiveInputQuestion } from "./live-questions.js"

export interface LivePermissionRequest {
  /** Present only when the adapter established an exact native occurrence. */
  native?: import("./approval-response.js").NativeApprovalIdentity
  /** Adapter-minted occurrence, echoed by request-end evidence. Never a native ID. */
  observationId?: string
  /** Assigned by the host; absent on native events and legacy records. */
  origin?: ApprovalOrigin
  id: string
  sessionId: string
  title: string
  /** What a request that isn't for a tool asks, and what each answer does, in a sentence or three. */
  detail?: string
  kind?: string
  options: Array<{ optionId: string; name: string; kind?: string }>
  questions?: LiveInputQuestion[]
  /**
   * The adapter's statement that approving this request implements the
   * proposed plan `plan`, by answering `approve`. Building that plan answers
   * this request rather than sending a second prompt.
   */
  implementsPlan?: { plan: string; approve: string }
  /**
   * The option whose answer can carry what the person typed, which then
   * reaches the agent with the refusal instead of as the next message.
   */
  feedbackOption?: string
}

export type LivePermissionResponse =
  | { kind: "choice"; optionId: string | null; feedback?: string }
  | { kind: "answers"; answers: Record<string, string[]> }
