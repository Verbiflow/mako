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

/**
 * Tokens and cost for one slice of local history. A harness's reported cost
 * and Mako's estimate stay apart; `cost` adds them only to rank and chart, and
 * the window marks any total with an estimate in it as one ("≈").
 */
export const UsageTotalsSchema = z.object({
  /** Reported plus estimated cost: an estimate whenever `estimatedCost` is above zero. */
  cost: z.number(),
  /** Cost recorded by the harness that made the request; what it priced the tokens at, not a bill. */
  reportedCost: z.number().optional(),
  /** Mako's API-equivalent cost from list prices, for tokens no harness priced; see `UsageSummary.priceTables`. */
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

/** What one period of a window's chart spent: its cost (an estimate wherever `estimatedCost` is above zero) and its tokens. */
export const UsageAmountSchema = z.object({
  cost: z.number(),
  estimatedCost: z.number(),
  tokens: z.number(),
})
export type UsageAmount = z.infer<typeof UsageAmountSchema>

/** One hour or one local day of a window, whole and by source, so the chart and its readout read the same numbers. */
export const UsagePeriodSchema = z.object({
  /** When the period starts, in milliseconds since the epoch: an hour, or midnight of a day on this machine's clock. */
  start: z.number(),
  total: UsageAmountSchema,
  /** Each source's part, under the name `UsageWindow.sources` lists it by; a source that spent nothing in the period is absent. */
  sources: z.record(z.string(), UsageAmountSchema),
})
export type UsagePeriod = z.infer<typeof UsagePeriodSchema>

/** The windows Settings › Usage reads, shortest first; the ledger keeps the longest. */
export const USAGE_WINDOWS = ["day", "week", "month"] as const
export type UsageWindowId = (typeof USAGE_WINDOWS)[number]

/**
 * Local usage over one window, every figure summed by the host in one pass
 * over the ledger, so no view adds up a total of its own. `day` is the last
 * 24 hours by the hour; `week` and `month` are the last 7 and 30 days by the
 * day, from midnight on this machine's clock.
 */
export const UsageWindowSchema = z.object({
  id: z.enum(USAGE_WINDOWS),
  since: z.number(),
  until: z.number(),
  resolution: z.enum(["hour", "day"]),
  total: UsageTotalsSchema,
  /** Sessions with a call in the window, Mako's own helper runs left out. */
  sessions: z.number(),
  /** Every period of the window, oldest first, the empty ones included. */
  periods: z.array(UsagePeriodSchema),
  /** `harness` names the harness a source counts, whose `usage.outsideMako` says whether its sessions outside Mako are in it. */
  sources: z.array(UsageTotalsSchema.extend({ source: z.string(), harness: z.string().optional(), sessions: z.number() })),
  /** Each model under each source that called it, all of them, by cost. */
  models: z.array(UsageTotalsSchema.extend({ model: z.string(), source: z.string() })),
  /** The projects that spent most; `otherProjects` sums the rest, so the list and the total agree. */
  projects: z.array(UsageTotalsSchema.extend({ cwd: z.string() })),
  otherProjects: UsageTotalsSchema.extend({ count: z.number() }).optional(),
  /** Harnesses whose own records say some of their usage in the window is missing, so the totals may be low. */
  incomplete: z.array(z.string()).optional(),
  /** The `PriceTable`s the estimated part of the cost was priced from; absent when nothing was estimated. */
  priceTables: z.array(z.string()).optional(),
})
export type UsageWindow = z.infer<typeof UsageWindowSchema>

/** Local usage from every supported session format on this machine, over each of `USAGE_WINDOWS`. */
export const UsageSummarySchema = z.object({
  /** One per `USAGE_WINDOWS` entry, in that order. */
  windows: z.array(UsageWindowSchema),
  /** True when some records in the window could not be read, so the totals may be low; the host log names them. */
  truncated: z.boolean(),
})
export type UsageSummary = z.infer<typeof UsageSummarySchema>

/** A summary's window by its id; a summary holds every one of `USAGE_WINDOWS`. */
export function usageWindow(summary: UsageSummary, id: UsageWindowId): UsageWindow {
  const window = summary.windows.find((candidate) => candidate.id === id)
  if (!window) throw new Error(`The usage summary has no ${id} window`)
  return window
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
