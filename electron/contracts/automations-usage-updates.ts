/**
 * Where the app is in the update cycle.
 *
 * `unsupported` is the normal state when running from a checkout: there is no
 * feed and never will be, and the UI should say that rather than sit on
 * "checking" forever. `ready` is the only state with a button attached — the
 * install is always a decision, never a surprise mid-turn.
 */
export interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "current"
    | "downloading"
    | "ready"
    | "error"
    | "unsupported"
  /** The version currently running. */
  version: string
  /** The version waiting, once there is one. */
  available?: string
  /** Download percentage, while downloading. */
  progress?: number
  notes?: string
  error?: string
}

/** Tokens and API-equivalent cost for one slice of local history. */
export interface UsageTotals {
  /** Reported plus estimated cost. */
  cost: number
  /** Cost recorded by the runtime that made the request. */
  reportedCost?: number
  /** API-equivalent cost calculated from model list prices. */
  estimatedCost?: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  messages: number
  /** Tokens covered by either reported cost or known model pricing. */
  pricedTokens?: number
  /** Tokens whose model has no matching price. */
  unpricedTokens?: number
}

/** Local usage from every supported session format on this machine. */
export interface UsageSummary {
  total: UsageTotals
  days: Array<{ date: string } & UsageTotals>
  models: Array<{ model: string } & UsageTotals>
  projects: Array<{ cwd: string } & UsageTotals>
  /** `recordedByMako` when the harness's own store keeps no counts and Mako measured the spend. */
  sources?: Array<{ source: string; recordedByMako?: true } & UsageTotals>
  sessions: number
  /** True when some records in the window could not be read, so the totals may be low; the host log names them. */
  truncated: boolean
  /** Harnesses whose own records say some of their usage in the window is missing, so the totals may be low. */
  incomplete?: string[]
}

/**
 * A saved prompt, with an optional trigger.
 *
 * `enabled` is local and never written to the shared file: an automation
 * arrives from a checkout with whatever its author set, and honouring that
 * would mean cloning a repository could start running an agent.
 */
export type AutomationTrigger =
  | { kind: "manual" }
  | {
      kind: "files"
      /** Globs, for the `files` trigger. `**` crosses directories, `*` does not. */
      paths: string[]
    }
  | { kind: "commit" }
  | {
      kind: "slack"
      event: "message_in_channel" | "reaction_added" | "channel_created"
      channels: string[]
      messageFilter?: string
    }
  | {
      kind: "gmail"
      event: "message_received"
      from: string[]
      to: string[]
      subjectFilter?: string
      labels: string[]
      hasAttachment: boolean
    }
  | {
      kind: "google_calendar"
      event:
        | "event_created"
        | "event_updated"
        | "event_cancelled"
        | "event_starting_soon"
        | "event_ended"
      calendars: string[]
      titleFilter?: string
    }
  | { kind: "webhook"; path: string }

export function automationTriggerAvailable(
  trigger: AutomationTrigger
): boolean {
  return (
    trigger.kind === "manual" ||
    trigger.kind === "files" ||
    trigger.kind === "commit"
  )
}

export interface Automation {
  id: string
  name: string
  prompt: string
  trigger: AutomationTrigger
  enabled: boolean
}

export interface AutomationRun {
  runId: string
  id: string
  name: string
  reason: AutomationTrigger["kind"]
  at: number
  status: "started" | "completed" | "failed"
  error?: string
}
