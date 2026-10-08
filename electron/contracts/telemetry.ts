/**
 * What this install tells Mako about how it is used, and what the person
 * allows. Both kinds are on until they turn them off in Settings → Privacy.
 *
 * `usage`: which harnesses, models, modes and features are used, and how turns
 * end, as counts, durations and code identifiers. `errors`: crash reports and
 * the kinds of native records no decoder understood, with paths, emails and
 * secrets scrubbed out. Neither ever carries a prompt, a reply, a file, a
 * path, a title, a repository or branch name, or a session ID.
 */
export interface TelemetryChoice {
  usage: boolean
  errors: boolean
}

/**
 * Why nothing is sent whatever the choice: `DO_NOT_TRACK` or
 * `MAKO_TELEMETRY=off` in the environment, a fixture desk, or a build that
 * names no Mako cloud to send to.
 */
export type TelemetryOff = "environment" | "fixture" | "no-cloud"

export interface TelemetryState extends TelemetryChoice {
  off?: TelemetryOff
}

/** Mako's access tiers, as `contracts/access.ts` names them. */
type Access = "plan" | "chat" | "ask" | "edits" | "auto" | "full" | "deny"

export interface TurnTuning {
  harness: string
  model?: string
  /** The value of the harness's reasoning option, such as `high`. */
  effort?: string
  /** The harness's own mode ID, such as `plan` or `acceptEdits`. */
  mode?: string
  access?: Access
}

export interface TelemetryTokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning?: number
}

/**
 * The events and their properties. The gateway accepts these names and
 * fields and drops anything else; a change here needs the same change there.
 */
export interface ProductEvents {
  "app.started": { startupMs?: number; firstRun: boolean; signedIn: boolean }
  /** Once a day while a window is open: what this install has, for adoption and harness share. */
  "app.heartbeat": { harnesses: Array<{ harness: string; version?: string }>; threads: number; signedIn: boolean }
  "thread.created": { harness: string; origin: "new" | "resume"; worktree: boolean; purpose?: string }
  "turn.started": TurnTuning & { attachments: number; actor?: "person" | "agent" | "service"; continuation: boolean }
  "turn.completed": TurnTuning & {
    status: "completed" | "failed" | "interrupted" | "uncertain"
    failure?: string
    interruption?: string
    durationMs?: number
    tokens?: TelemetryTokens
    costUsd?: number
    usage: "complete" | "partial" | "none"
    subagents: number
  }
  "feature.used": { feature: TelemetryFeature; harness?: string }
}

export type TelemetryFeature =
  | "thread.forked"
  | "harness.switched"
  | "turn.rewound"
  | "automation.ran"
  | "cloud.signed-in"

export interface DiagnosticEvents {
  "error.reported": { kind: string; name?: string; message: string; stack?: string; breadcrumbs?: string[] }
  "native.unknown": { harness: string; kind: string; reason: "unknown" | "unreadable"; count: number }
}

export interface TelemetryApp {
  version: string
  build?: string
  distribution: "signed" | "unsigned" | "local" | "development"
  os: "macOS" | "Windows" | "Linux" | "other"
  osVersion?: string
  arch: "arm64" | "x64" | "other"
}

export type TelemetryName = keyof ProductEvents | keyof DiagnosticEvents
export type TelemetryProps = ProductEvents[keyof ProductEvents] | DiagnosticEvents[keyof DiagnosticEvents]

export interface TelemetryEvent {
  id: string
  at: number
  name: TelemetryName
  props: TelemetryProps
}

/** `POST /v1/telemetry`. */
export interface TelemetryBatch {
  install: string
  sentAt: number
  app: TelemetryApp
  consent: { product: boolean; diagnostics: boolean }
  events: TelemetryEvent[]
}

export const MAX_BATCH_EVENTS = 100
