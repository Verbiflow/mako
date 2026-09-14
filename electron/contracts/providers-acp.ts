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
  /** A headless native run can continue this provider's sessions. */
  resumable: boolean
  /** An interactive transport can drive this provider right now. */
  live: boolean
  canResume: boolean
  observesNativeAgents?: boolean
  canSteer?: boolean
  steering?: LiveSteering
  canCompact?: boolean
  /**
   * The access ladder a new session with this provider offers, known before
   * any process starts so the desk can take the choice with the first prompt.
   * A running session's own advertised list still governs that session.
   */
  modes?: LiveSessionMode[]
  /**
   * The mode a fresh session runs under when the user has not chosen one.
   * The desk reports it as the current level so no provider ever opens a
   * session whose access is unaccounted for.
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
  capabilities: string[]
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
 * The provider's own context reading, only when it reports exact numbers:
 * tokens in context out of the window size, and cumulative session cost.
 */
export interface LiveSessionUsage {
  used: number
  size: number
  cost?: { amount: number; currency: string }
}

export interface LiveSessionState {
  nativeRunId?: string
  nativeForkId?: string
  nativePath?: string
  connection: "starting" | "connected" | "disconnected"
  id: string
  nativeId?: string
  harness: string
  cwd: string
  title?: string
  status: "starting" | "ready" | "running" | "failed" | "closed"
  modes: LiveSessionMode[]
  currentMode: string | null
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
}

/**
 * The `lastStop` of a turn the agent ended because its own connection to
 * its backend dropped. The session is `failed` with the agent's error text;
 * the request that ran it is recorded as interrupted and continuable rather
 * than as a message to send again, because the turn's work is kept.
 */
export const CONNECTION_LOST_STOP = "connection-lost"

/** One streamed piece of an interactive turn, reduced for rendering. */
export type { LiveUpdate } from "./live-content.js"

export interface PromptAttachment {
  name: string
  mimeType: string
  size: number
  data?: string
  path?: string
}

export interface LiveInputQuestion {
  id: string
  header: string
  question: string
  isSecret: boolean
  allowOther: boolean
  required?: boolean
  valueType?: "string" | "number" | "integer" | "boolean" | "string-array"
  options: Array<{ label: string; description: string; value?: string }>
  defaultValues?: string[]
}

export interface LivePermissionRequest {
  id: string
  sessionId: string
  title: string
  kind?: string
  options: Array<{ optionId: string; name: string; kind?: string }>
  questions?: LiveInputQuestion[]
}

export type LivePermissionResponse =
  | { kind: "choice"; optionId: string | null }
  | { kind: "answers"; answers: Record<string, string[]> }
