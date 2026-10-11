import { z } from "zod"

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

/** What the desktop app, which runs the updater, tells its host (`desktop-channel.ts`). */
export const UpdateStateSchema = z.object({
  status: z.enum(["idle", "checking", "current", "downloading", "ready", "error", "unsupported"]),
  version: z.string().max(100),
  available: z.string().max(100).optional(),
  progress: z.number().min(0).max(100).optional(),
  notes: z.string().max(4000).optional(),
  error: z.string().max(4000).optional(),
}) satisfies z.ZodType<UpdateState>

/** Tokens and API-equivalent cost for one slice of local history. */
export const UsageTotalsSchema = z.object({
  /** Reported plus estimated cost. */
  cost: z.number(),
  /** Cost recorded by the runtime that made the request. */
  reportedCost: z.number().optional(),
  /** API-equivalent cost calculated from model list prices. */
  estimatedCost: z.number().optional(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  messages: z.number(),
  /** Tokens covered by either reported cost or known model pricing. */
  pricedTokens: z.number().optional(),
  /** Tokens whose model has no matching price. */
  unpricedTokens: z.number().optional(),
})
export type UsageTotals = z.infer<typeof UsageTotalsSchema>

/** Local usage from every supported session format on this machine. */
export const UsageSummarySchema = z.object({
  total: UsageTotalsSchema,
  days: z.array(UsageTotalsSchema.extend({ date: z.string() })),
  models: z.array(UsageTotalsSchema.extend({ model: z.string() })),
  projects: z.array(UsageTotalsSchema.extend({ cwd: z.string() })),
  /** `harness` names the harness a source counts, whose `usage.outsideMako` says whether its sessions outside Mako are in it. */
  sources: z.array(UsageTotalsSchema.extend({ source: z.string(), harness: z.string().optional() })).optional(),
  sessions: z.number(),
  /** True when some records in the window could not be read, so the totals may be low; the host log names them. */
  truncated: z.boolean(),
  /** Harnesses whose own records say some of their usage in the window is missing, so the totals may be low. */
  incomplete: z.array(z.string()).optional(),
})
export type UsageSummary = z.infer<typeof UsageSummarySchema>

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
