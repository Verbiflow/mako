import type { AccessEnforcement, AccessTier } from "./access.js"

/**
 * How a mid-turn message reaches the running agent. `step` folds it into the
 * running turn at the agent's next step; `interrupt` cancels the current step
 * and continues with the message. A provider that can only queue a message
 * behind the running turn advertises no steering at all.
 */
export type LiveSteering = "step" | "interrupt"

export interface LiveCapability {
  provider: string
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
