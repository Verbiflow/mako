import { z } from "zod"
import { ACCESS_TIER_NAMES } from "./access.js"
import { sha256Hex } from "./sha256.js"
import { BriefSchema, PlaceSchema, ReportStatusSchema, type Brief } from "./agents.js"
import { knownTimezone, parseCron } from "./automation-cron.js"
import { automationClientKey, scheduleOccurrence } from "@mako/protocol/automations-cloud"
import type { JsonValue } from "./json.js"

/**
 * Automations: a stored `agents_start` and what starts it.
 *
 * An automation is the brief, harness, model, access, place and worktree an
 * Apex would pass `agents_start`, kept in the project's
 * `.mako/automations.json` (committed, reviewed like code), with triggers that
 * start it, an optional gate that decides cheaply whether there's anything to
 * do, and limits on what it may spend. Each run is a top-level Thread, started
 * under the client key `automation:<id>:<occurrence>`, so a repeat of one
 * occurrence (a retry, a restart, a second press) reaches the same Thread.
 *
 * What is the person's alone stays on this Mac, in the host's data root and
 * keyed by project and automation: whether it's on, when it runs next, and its
 * run records. Cloning a repository never switches an automation on, and a
 * definition that changes after the person turned it on (a pull, an edit
 * outside Mako) pauses until they turn it on again.
 *
 * An agent reads automations and runs them through the `automation` tool; what
 * it creates, changes, deletes or turns on is a proposal the person approves
 * (`AutomationProposal`), from the ask in its Thread, the Inbox, or the
 * Automations view.
 *
 * Shapes here are stable: later slices add to them (a trigger a cloud receiver
 * delivers, a run's place), never reshape them.
 */

/* ------------------------------------------------------------------ */
/* the definition, as the project's file keeps it                       */
/* ------------------------------------------------------------------ */

/** Where the definitions live, relative to the project folder. */
export const AUTOMATIONS_FILE = ".mako/automations.json"
/** The file's shape; a file without `version` is the first one (`LegacyAutomationSchema`). */
export const AUTOMATIONS_FILE_VERSION = 2

/** Lowercase words and dashes: it names the automation in its file, its client keys and its branch templates. */
export const AutomationIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "An automation's id is lowercase letters, digits, dots, dashes or underscores, at most 80.")

/** One sentence a fast model holds an incoming event to before a run starts ("only when the release is a major version"). */
export const RunWhenSchema = z.string().trim().min(1).max(500)

/** On a cron schedule, read in an IANA timezone (`UTC` when absent). */
export const ScheduleTriggerSchema = z.object({
  kind: z.literal("schedule"),
  cron: z.string().trim().min(1).max(120).refine((cron) => parseCron(cron).ok, { message: "Not a five-field cron schedule." }),
  timezone: z.string().min(1).max(64).default("UTC").refine(knownTimezone, { message: "Not an IANA timezone this Mac knows." }),
  runWhen: RunWhenSchema.optional(),
})

/** When the project's HEAD moves to another commit; `branch` only while that branch is checked out. */
export const CommitTriggerSchema = z.object({
  kind: z.literal("commit"),
  branch: z.string().min(1).max(200).optional(),
  runWhen: RunWhenSchema.optional(),
})

/** Run now only: the person's button or an agent's `run_now`. */
export const ManualTriggerSchema = z.object({ kind: z.literal("manual") })

/** Filters on an external event's fields, each a value or any of several. */
const EventFiltersSchema = z.record(z.string().min(1).max(80), z.union([z.string().max(400), z.array(z.string().max(400)).max(40)]))

/** A GitHub repository's event, delivered by the cloud account's receiver (a later slice). */
export const GithubTriggerSchema = z.object({
  kind: z.literal("github"),
  event: z.enum(["release", "push", "pull_request", "check_failed", "issue_comment", "issues", "workflow_run"]),
  /** `owner/name`. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  filters: EventFiltersSchema.optional(),
  runWhen: RunWhenSchema.optional(),
})

/** A Slack event, delivered by the cloud account's receiver (a later slice). */
export const SlackTriggerSchema = z.object({
  kind: z.literal("slack"),
  event: z.enum(["message", "mention", "reaction"]),
  channels: z.array(z.string().min(1).max(120)).max(40).default([]),
  filters: EventFiltersSchema.optional(),
  runWhen: RunWhenSchema.optional(),
})

/** A Linear event, delivered by the cloud account's receiver (a later slice). */
export const LinearTriggerSchema = z.object({
  kind: z.literal("linear"),
  event: z.enum(["issue_created", "issue_updated", "comment"]),
  team: z.string().min(1).max(120).optional(),
  filters: EventFiltersSchema.optional(),
  runWhen: RunWhenSchema.optional(),
})

/** A Sentry event, delivered by the cloud account's receiver (a later slice). */
export const SentryTriggerSchema = z.object({
  kind: z.literal("sentry"),
  event: z.enum(["issue_created", "issue_regressed", "alert"]),
  project: z.string().min(1).max(120).optional(),
  filters: EventFiltersSchema.optional(),
  runWhen: RunWhenSchema.optional(),
})

/** A signed HTTP call to the account's endpoint (a later slice). `secret` names a secret the account keeps, never its value: the file is committed. */
export const WebhookTriggerSchema = z.object({
  kind: z.literal("webhook"),
  secret: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/, "A webhook names its secret, never its value."),
  /** Deliveries within this window start one run, whose cause counts them (`batch`). */
  coalesce: z.object({ windowS: z.number().int().min(1).max(3600) }).optional(),
  filters: EventFiltersSchema.optional(),
  runWhen: RunWhenSchema.optional(),
})

/**
 * A trigger this build can't read (a kind from a newer Mako, or a shape it doesn't know), kept word for word so a save
 * never loses it. It never fires; `why` says what was wrong with it.
 */
export const UnsupportedTriggerSchema = z.object({
  kind: z.literal("unsupported"),
  raw: z.json(),
  why: z.string().max(400),
})

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  ScheduleTriggerSchema,
  CommitTriggerSchema,
  ManualTriggerSchema,
  GithubTriggerSchema,
  SlackTriggerSchema,
  LinearTriggerSchema,
  SentryTriggerSchema,
  WebhookTriggerSchema,
  UnsupportedTriggerSchema,
])
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>
export type AutomationTriggerKind = AutomationTrigger["kind"]

/** The triggers this host fires. */
export const LIVE_TRIGGER_KINDS = ["schedule", "commit", "manual"] as const satisfies readonly AutomationTriggerKind[]
/** The triggers the cloud account's receivers fire, once the automation is registered there (`AutomationLocal.cloudRegistered`). */
export const CLOUD_TRIGGER_KINDS = ["github", "slack", "linear", "sentry", "webhook"] as const satisfies readonly AutomationTriggerKind[]

/** Whether this host fires `trigger`. */
export function triggerFiresHere(trigger: AutomationTrigger): boolean {
  return LIVE_TRIGGER_KINDS.some((kind) => kind === trigger.kind)
}

/** Whether the cloud fires `trigger`, never this host. */
export function triggerFiresInCloud(trigger: AutomationTrigger): boolean {
  return CLOUD_TRIGGER_KINDS.some((kind) => kind === trigger.kind)
}

/** Whether `trigger` is live: this host's, or the cloud's once the automation is registered there. */
export function triggerLive(trigger: AutomationTrigger, cloudRegistered: boolean | undefined): boolean {
  return triggerFiresHere(trigger) || (cloudRegistered === true && triggerFiresInCloud(trigger))
}

/**
 * Where a run starts and what it runs on: `agents_start`'s own fields. `workspace.branch` is a template: `{date}`
 * (the occurrence's day, `YYYY-MM-DD`), `{time}` (`HHMM`), `{automation}` (its id) and `{run}` (the occurrence)
 * are filled in per run (`branchFor`).
 */
export const AutomationStartSchema = z.object({
  /** claude, codex, cursor, grok, opencode or devin; absent: the person's first harness with room. */
  harness: z.string().min(1).max(40).optional(),
  /** A model the harness lists, by id or name; absent: what the person uses there. */
  model: z.string().min(1).max(200).optional(),
  reasoning: z.string().min(1).max(40).optional(),
  /** The number of the person's rule for Fins it follows (Settings › Fins). */
  rule: z.number().int().positive().max(64).optional(),
  access: z.enum(ACCESS_TIER_NAMES).default("edits"),
  /** `here` (this Mac), `cloud`, or `device:<name>`. `cloud` always runs in the cloud. */
  place: PlaceSchema.default("here"),
  /**
   * What the cloud does when a trigger fires there while this Mac is off: `cloud` starts it as a cloud Fin, `queue`
   * (the default) hands it to the Mac when it's back (one catch-up within `AUTOMATION_CATCH_UP_GRACE_MS`), `skip`
   * records it skipped.
   */
  whenAway: z.enum(["cloud", "queue", "skip"]).default("queue"),
  /** Its own worktree: on `branch` if it exists, else a new branch from `base`. Absent: the project folder. */
  workspace: z.object({ base: z.string().min(1).max(200).optional(), branch: z.string().min(1).max(200).optional() }).optional(),
})
export type AutomationStart = z.infer<typeof AutomationStartSchema>

/** A cheap deterministic check before a run: exit 0 runs, exit 1 skips, anything else fails. */
export const AutomationGateSchema = z.object({
  /** Run with the login shell in the project folder. Its stdout, when a JSON object, is the run's context; its `key`, the dedupe key. */
  command: z.string().trim().min(1).max(2000),
  timeoutS: z.number().int().min(1).max(900).default(60),
})
export type AutomationGate = z.infer<typeof AutomationGateSchema>

export const AutomationLimitsSchema = z.object({
  /** What a trigger does while a run is still going: `skip` records it skipped, `queue` starts it when that run ends. */
  overlap: z.enum(["skip", "queue"]).default("skip"),
  /** Runs started in any 24 hours, at most. */
  maxRunsPerDay: z.number().int().min(1).max(96).optional(),
  /** A run still at work after this long is stopped and counts as failed. */
  timeoutMin: z.number().int().min(1).max(1440).default(60),
  /** Tokens one run may spend: its Thread runs as a goal with this budget, which stops it when spent. */
  tokenBudget: z.number().int().min(10_000).max(100_000_000).optional(),
})
export type AutomationLimits = z.infer<typeof AutomationLimitsSchema>

/** What a run leaves: a pull request, a report in its Thread, or changes it made (`act`). */
export const AutomationResultSchema = z.enum(["pull-request", "report", "act"])
export type AutomationResult = z.infer<typeof AutomationResultSchema>

/** `new`: a Thread a run. `standing`: one Thread every run writes to, each run its next message. */
export const AutomationThreadSchema = z.enum(["new", "standing"])

/** One automation as the project's file keeps it. */
export const AutomationDefinitionSchema = z.object({
  id: AutomationIdSchema,
  name: z.string().trim().min(1).max(120),
  /** `agents_start`'s brief: objective, doneWhen, boundaries, output. */
  prompt: BriefSchema,
  start: AutomationStartSchema.default({ access: "edits", place: "here", whenAway: "queue" }),
  thread: AutomationThreadSchema.default("new"),
  triggers: z.array(AutomationTriggerSchema).max(8).default([{ kind: "manual" }]),
  gate: AutomationGateSchema.optional(),
  limits: AutomationLimitsSchema.default({ overlap: "skip", timeoutMin: 60 }),
  result: AutomationResultSchema.default("report"),
})
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>
/** What a writer may leave out: every default filled on reading. */
export type AutomationDefinitionInput = z.input<typeof AutomationDefinitionSchema>

/** The file: `{ version: 2, automations: [...] }`. */
export const AutomationsFileSchema = z.object({
  version: z.literal(AUTOMATIONS_FILE_VERSION),
  automations: z.array(z.json()).max(100),
})

/**
 * The first shape, read and never written: a plain `prompt`, and `trigger` as `"files" | "commit" | "manual"` or
 * `{ kind, … }`. Read as `triggers[0]` with default start settings; `files` and the Slack, Gmail and Calendar stubs
 * become `unsupported`, since they can't fire.
 */
export const LegacyAutomationSchema = z.object({
  id: z.string().max(200).optional(),
  name: z.string().max(400).optional(),
  prompt: z.string().max(200_000).optional(),
  trigger: z.json().optional(),
  paths: z.json().optional(),
})

/* ------------------------------------------------------------------ */
/* what this Mac keeps of each                                          */
/* ------------------------------------------------------------------ */

/** Why an automation that's on doesn't run, and what turns it back on. */
export const AutomationPauseSchema = z.object({
  kind: z.enum(["failures", "changed", "invalid"]),
  /** In words, for its row: "Paused after 3 failed runs in a row: …". Turning it on again clears it. */
  reason: z.string().max(1000),
  at: z.number(),
})
export type AutomationPause = z.infer<typeof AutomationPauseSchema>

/** What this Mac keeps of one automation: never in the shared file. */
export const AutomationLocalSchema = z.object({
  enabled: z.boolean(),
  /**
   * The fingerprint (`automationFingerprint`) of the definition the person approved: turning it on, saving it in Mako,
   * approving an agent's proposal, or reviewing a change before Run now. Nothing runs any other definition: one whose
   * file says something else is paused until the person approves what it says now, seeing the change first.
   */
  approved: z.string().max(80).optional(),
  /** The definition itself as they approved it, so every card shows what changed since: the approved, then the current. */
  approvedDefinition: z.json().optional(),
  paused: AutomationPauseSchema.optional(),
  /** Failed runs in a row; a completed run sets it back to 0. */
  failures: z.number().int().min(0).default(0),
  /** When its schedule fires next. */
  nextRunAt: z.number().optional(),
  /** The last occurrence its schedule fired for, or passed over. */
  scheduledThrough: z.number().optional(),
  /** The commit its commit trigger last saw. */
  head: z.string().max(80).optional(),
  /** When it was turned on, which no catch-up reaches behind. */
  enabledAt: z.number().optional(),
  /**
   * The cloud account registered its GitHub, Slack, Linear, Sentry or webhook triggers: they fire there. Unset, those
   * triggers wait for the cloud, and its row says so.
   */
  cloudRegistered: z.boolean().optional(),
  /** Why the cloud account wouldn't register it (a repository Mako's GitHub App can't read), in its words; its row says so. */
  cloudIssue: z.string().max(1000).optional(),
})
export type AutomationLocal = z.infer<typeof AutomationLocalSchema>

/** Turns on after three failed runs in a row. */
export const AUTOMATION_PAUSE_AFTER_FAILURES = 3
/** A schedule missed while the Mac slept or Mako was closed runs once on waking, if it was due within this long. */
export const AUTOMATION_CATCH_UP_GRACE_MS = 12 * 60 * 60_000
/** Queued runs past this many are recorded skipped. */
export const AUTOMATION_QUEUE_LIMIT = 3
/** Run records kept for each automation. */
export const AUTOMATION_RUNS_KEPT = 100

/* ------------------------------------------------------------------ */
/* runs                                                                 */
/* ------------------------------------------------------------------ */

/**
 * How a run stands. `fired` while its Thread works; `completed` or `failed` once that Thread's turn ends, with its
 * result; `queued` until the run before it ends (`overlap: queue`). `skipped` (another run was going, the daily cap,
 * `runWhen`), `gate-skipped` (the gate's exit 1 or its key already ran) and `failed-to-start` never had a Thread.
 */
export const AutomationRunStatusSchema = z.enum(["queued", "fired", "skipped", "gate-skipped", "failed-to-start", "completed", "failed"])
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>

/** What started a run. */
export const AutomationCauseSchema = z.discriminatedUnion("kind", [
  /** Its schedule, for the occurrence at `at`; `catchUp` when it was missed while the Mac slept or Mako was closed. */
  z.object({ kind: z.literal("schedule"), at: z.number(), catchUp: z.literal(true).optional() }),
  z.object({ kind: z.literal("commit"), head: z.string().max(80), subject: z.string().max(400).optional() }),
  /** Run now, by the person. */
  z.object({ kind: z.literal("person") }),
  /** `run_now` by an agent: its conversation, and the ask its person allowed when it was below full access. */
  z.object({ kind: z.literal("agent"), conversation: z.string().max(200), ask: z.string().max(200).optional() }),
  /**
   * An external event the cloud's receiver took: `id` the provider's stable delivery, release or comment id; `batch` the
   * webhook deliveries one run coalesced. Its occurrence is named by the cloud only (`github-release-<id>`, …).
   */
  z.object({
    kind: z.literal("event"),
    source: z.enum(["github", "slack", "linear", "sentry", "webhook"]),
    event: z.string().max(80),
    id: z.string().max(200),
    summary: z.string().max(400),
    url: z.string().max(400).optional(),
    batch: z.number().int().min(1).max(500).optional(),
  }),
])
export type AutomationCause = z.infer<typeof AutomationCauseSchema>

/** One run, from its trigger to its Thread's result. */
export const AutomationRunSchema = z.object({
  /** Names the run within its automation: a schedule's slot (`2026-11-19T06:17Z`), `commit-<sha>`, `now-<key>`. */
  occurrence: z.string().min(1).max(200),
  automation: AutomationIdSchema,
  project: z.string().min(1).max(4096),
  /** `automation:<id>:<occurrence>`: the Thread a repeat of this run reaches. */
  clientKey: z.string().max(400),
  cause: AutomationCauseSchema,
  status: AutomationRunStatusSchema,
  /** When it was recorded. */
  at: z.number(),
  /** When its Thread started working. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** Why it was skipped, didn't start or failed, in words. */
  why: z.string().max(2000).optional(),
  /** A skipped run merged into the one that was going. */
  mergedInto: z.string().max(200).optional(),
  /**
   * The fingerprint of the approved definition it runs, fixed when it was recorded: a queued or recovered run starts only
   * while that is still the approved one, from the approved definition, never from what the file says by then.
   */
  approved: z.string().max(80).optional(),
  /** Its trigger's `runWhen`, checked: a skip keeps status `skipped` with `why` its reason; a pass says it was checked. */
  runWhen: z.object({ verdict: z.enum(["run", "skip"]), reason: z.string().max(400), model: z.string().max(80).optional() }).optional(),
  /** What its gate said: its dedupe key and the JSON object it printed. */
  gate: z.object({ key: z.string().max(400).optional(), context: z.json().optional() }).optional(),
  /** Its Thread: the conversation on this host, its Thread id once known, and the message this run sent. */
  thread: z.object({ conversation: z.string().max(200), thread: z.string().max(200).optional(), request: z.string().max(200), place: z.string().max(200).optional(), branch: z.string().max(200).optional() }).optional(),
  /** How its Thread's turn ended, in a Fin report's words: done, failed, blocked or needs-input, and its last reply. */
  result: z.object({ status: ReportStatusSchema, summary: z.string().max(4000), pullRequest: z.string().max(400).optional() }).optional(),
  /**
   * The cloud account holds this occurrence (`@mako/protocol/automations-cloud`): `seq` is its record's there, `thread`
   * its cloud Thread once made. Its record follows the account's (`AutomationCloud`'s runs feed), not this Mac's clock.
   */
  cloud: z.object({ seq: z.number().int().nonnegative(), thread: z.string().max(200).optional() }).optional(),
})
export type AutomationRun = z.infer<typeof AutomationRunSchema>

/**
 * A schedule occurrence's name (`2026-11-19T06:17Z`) and the client key every repeat of one occurrence starts under,
 * the same on this Mac and in the cloud: the open protocol's.
 */
export { automationClientKey, scheduleOccurrence }

/** A run's branch: the template with `{date}`, `{time}`, `{automation}` and `{run}` filled in; `at` read in `timezone`. */
export function branchFor(template: string, input: { id: string; occurrence: string; at: number; timezone?: string }): string {
  const zone = input.timezone ?? "UTC"
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(input.at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((each) => each.type === type)?.value ?? "00"
  const filled = template
    .replaceAll("{date}", `${part("year")}-${part("month")}-${part("day")}`)
    .replaceAll("{time}", `${part("hour")}${part("minute")}`)
    .replaceAll("{automation}", input.id)
    .replaceAll("{run}", input.occurrence)
  // A ref Git takes: no spaces, colons or doubled dots.
  return filled.replace(/[\s:~^?*[\\]+/g, "-").replace(/\.\.+/g, ".").replace(/\/+$/, "").slice(0, 200)
}

/* ------------------------------------------------------------------ */
/* proposals                                                            */
/* ------------------------------------------------------------------ */

/** What an agent asks to change. */
export const AutomationChangeSchema = z.enum(["create", "update", "delete", "enable"])
export type AutomationChange = z.infer<typeof AutomationChangeSchema>

/** A proposal no one decides on in this long expires. */
export const AUTOMATION_PROPOSAL_TTL_MS = 3 * 24 * 60 * 60_000

/**
 * An agent's create, update, delete or enable, saved pending until the person decides. Its agent isn't held: the call
 * answers `{ proposal, status: "pending" }` at once, and hears the decision as Mako's note in its Thread. `stale`: the
 * automation changed after it was proposed, so approving it would undo that change; it's never applied.
 */
export const AutomationProposalSchema = z.object({
  id: z.string().min(1).max(80),
  project: z.string().min(1).max(4096),
  automation: AutomationIdSchema,
  change: AutomationChangeSchema,
  /**
   * What its card shows the change from (absent for create): the definition the person approved, when there is one, so
   * an edit to the file before the proposal shows in its diff too; else the file's as it stood when proposed.
   */
  before: z.json().optional(),
  /** The definition it would write (absent for delete); for enable, the file's, which turning it on approves. */
  after: z.json().optional(),
  /** The fingerprint of the file's definition when proposed: one the file no longer has makes the proposal stale. */
  base: z.string().max(80).optional(),
  /** The agent's reason, in its words. */
  why: z.string().max(2000).optional(),
  by: z.object({
    /** The proposing agent's conversation, which hears the decision. */
    conversation: z.string().max(200),
    /** Its Thread's title, as the card names it. */
    title: z.string().max(200).optional(),
    harness: z.string().max(40).optional(),
  }),
  /** The ask in the proposer's conversation that carries it to the Inbox. */
  ask: z.string().max(80).optional(),
  at: z.number(),
  expiresAt: z.number(),
  status: z.enum(["pending", "approved", "declined", "expired", "stale"]),
  decidedAt: z.number().optional(),
  /** Why approving it didn't apply, or why it went stale. */
  note: z.string().max(1000).optional(),
  /** Whether its agent was told of the decision. */
  told: z.boolean().optional(),
  /**
   * On a cloud machine's host, whose agent proposed it in a cloud run: it's applied on the person's Mac, never in the
   * machine's clone. `awaiting` once decided here (from the ask's card in its Thread) until the Mac applies it;
   * `settled` once the Mac said how it went (`mako:automations-forward-settle`).
   */
  relay: z.enum(["awaiting", "settled"]).optional(),
  /** On the person's Mac: forwarded from the cloud Thread whose agent proposed it, which hears the decision. */
  from: z.object({ thread: z.string().max(200) }).optional(),
})
export type AutomationProposal = z.infer<typeof AutomationProposalSchema>

/** How a forwarded proposal went on the person's Mac, as its cloud Thread's host is told. */
export const ForwardedOutcomeSchema = z.object({ status: z.enum(["approved", "declined", "expired", "stale"]), note: z.string().max(1000).optional() })
export type ForwardedOutcome = z.infer<typeof ForwardedOutcomeSchema>

/** The parts of a definition a proposal's diff names, in the order a card shows them. */
export const AUTOMATION_DIFF_FIELDS = ["name", "prompt", "triggers", "start", "limits", "gate", "thread", "result"] as const
export type AutomationDiffField = (typeof AUTOMATION_DIFF_FIELDS)[number]

/** One part that changes, before and after; absent on a side that doesn't have it. */
export type AutomationDiffEntry = {
  field: AutomationDiffField
  before?: JsonValue
  after?: JsonValue
}

/** A JSON object, as a definition or a gate's output is one. */
const JsonRecordSchema = z.record(z.string(), z.json())

/** What changes between two definitions, part by part; every part for a create or a delete. */
export function automationDiff(before: JsonValue | undefined, after: JsonValue | undefined): AutomationDiffEntry[] {
  const record = (value: JsonValue | undefined): Record<string, JsonValue> => JsonRecordSchema.safeParse(value).data ?? {}
  const was = record(before)
  const now = record(after)
  return AUTOMATION_DIFF_FIELDS.flatMap((field) => {
    const a = was[field]
    const b = now[field]
    if (JSON.stringify(a) === JSON.stringify(b)) return []
    return [{ field, ...(a !== undefined && { before: a }), ...(b !== undefined && { after: b }) }]
  })
}

/* ------------------------------------------------------------------ */
/* what windows read                                                    */
/* ------------------------------------------------------------------ */

/**
 * How an automation stands: `off`; `on`; `paused` (on, but stopped by failures or a changed definition: `local.paused`
 * says why); `running` (a run's Thread works); `unsupported` (on, and none of its triggers fires here: its row says
 * which slice brings them).
 */
export const AutomationStandingSchema = z.enum(["off", "on", "paused", "running", "unsupported"])

/** One automation as a window shows it. */
export const AutomationViewSchema = z.object({
  project: z.string(),
  definition: AutomationDefinitionSchema,
  local: AutomationLocalSchema,
  standing: AutomationStandingSchema,
  /** The newest run, and the one at work. */
  lastRun: AutomationRunSchema.optional(),
  activeRun: AutomationRunSchema.optional(),
  /** Its definition's fingerprint now. */
  fingerprint: z.string(),
  /** What can't be read or won't fire, in words. */
  issues: z.array(z.string()).default([]),
})
export type AutomationView = z.infer<typeof AutomationViewSchema>

/** A project's automations, its proposals, and its file as read. */
export const AutomationProjectReadingSchema = z.object({
  project: z.string(),
  automations: z.array(AutomationViewSchema),
  /** Pending first, then the newest decided. */
  proposals: z.array(AutomationProposalSchema),
  file: z.object({
    exists: z.boolean(),
    /** The first shape, read as the new one: the next save writes the new shape. */
    legacy: z.boolean().optional(),
    /** Why the file couldn't be read: its automations don't run until it's fixed. */
    error: z.string().optional(),
    /** Entries that couldn't be read, kept in the file as they are. */
    skipped: z.array(z.string()).optional(),
  }),
})
export type AutomationProjectReading = z.infer<typeof AutomationProjectReadingSchema>

/** Every project this host keeps automations for: the open ones, and those with one on. */
export const AutomationsReadingSchema = z.object({ projects: z.array(AutomationProjectReadingSchema) })
export type AutomationsReading = z.infer<typeof AutomationsReadingSchema>

/** How Run now went: its run record, or why there's none. */
export type AutomationRunNowResult = { run: AutomationRun } | { refused: string }

/** A starting point the editor offers; `definition` has no id until the person names it. */
export interface AutomationTemplate {
  key: string
  name: string
  /** What it does, in a line. */
  summary: string
  definition: AutomationDefinitionInput
}

/** `mako:automations-run-of`: the run a Thread is, by its conversation; null for a Thread no automation started. */
export interface AutomationRunOf {
  project: string
  id: string
  occurrence: string
  /** The automation's name now, or its id once it left the project's file. */
  name: string
}

/** `mako:automations-hook`: a webhook the account takes deliveries at, its secret shown this once. */
export interface AutomationHook {
  name: string
  provider: "webhook" | "linear" | "sentry"
  /** The address to give the sender. */
  url: string
  /** Shown once, when it's made or rotated; the account keeps it sealed and never shows it again. */
  secret?: string
}

/** `mako:automations-draft`: an automation made from a Thread's first prompt and how it started, for the editor. */
export interface AutomationDraft {
  project: string
  definition: AutomationDefinitionInput
}

/* ------------------------------------------------------------------ */
/* host calls and events                                                */
/* ------------------------------------------------------------------ */

/**
 * The host calls, each `mako:automations-<verb>`:
 *
 * | call | arguments | answer |
 * | --- | --- | --- |
 * | `read` | `(project?: string)` | `AutomationsReading`: one project, or every one |
 * | `runs` | `(project: string, id?: string, limit?: number)` | `AutomationRun[]`, newest first |
 * | `save` | `(project: string, definition: JsonValue, replaces?: string, approve?: string)` | `AutomationProjectReading`: the person's edit, applied at once; `replaces` renames; `approve` (its fingerprint) approves it where the file had changed since their approval |
 * | `delete` | `(project: string, id: string)` | `AutomationProjectReading` |
 * | `enabled` | `(project: string, id: string, enabled: boolean, approve?: string)` | `AutomationProjectReading`; on again after a change needs `approve`, the current fingerprint, once the person saw the change |
 * | `run-now` | `(project: string, id: string, clientKey: string, approve?: string)` | `AutomationRunNowResult`; a repeat of `clientKey` is the same run; an unapproved definition runs only with `approve`, which approves it |
 * | `decide` | `(proposal: string, approve: boolean)` | `AutomationProposal` as decided |
 * | `draft` | `(conversationId: string)` | `AutomationDraft` |
 * | `templates` | `()` | `AutomationTemplate[]` |
 * | `run-of` | `(conversation: string)` | `AutomationRunOf \| null`: the run a Thread is, however old |
 * | `forwarded` | `()` | `AutomationProposal[]`: on a cloud machine's host, its agents' proposals the person's Mac takes |
 * | `forward-settle` | `(proposal: string, outcome: ForwardedOutcome)` | `AutomationProposal`: how one went on the Mac |
 * | `cloud-start` | `(launch: JsonValue)`, a `CloudRunStart` | `{ harness, modeId }`: on a cloud Thread's host, a cloud run started as one on the Mac |
 * | `hook` | `(name: string, provider?: "webhook" \| "linear" \| "sentry", rotate?: boolean, secret?: string)` | `AutomationHook`: made, or its secret rotated |
 *
 * and `mako:automations-act`, the agent's `automation` tool (`contracts/thread-tools.ts`).
 */
export const AUTOMATION_CALLS = {
  read: "mako:automations-read",
  runs: "mako:automations-runs",
  save: "mako:automations-save",
  delete: "mako:automations-delete",
  enabled: "mako:automations-enabled",
  runNow: "mako:automations-run-now",
  decide: "mako:automations-decide",
  draft: "mako:automations-draft",
  templates: "mako:automations-templates",
  runOf: "mako:automations-run-of",
  hook: "mako:automations-hook",
  forwarded: "mako:automations-forwarded",
  forwardSettle: "mako:automations-forward-settle",
  cloudStart: "mako:automations-cloud-start",
  act: "mako:automations-act",
} as const

/**
 * The events, window-wide:
 *
 *   * `{ type: "automations-changed", reading }`: a project's automations, local state or proposals changed; `reading`
 *     replaces that project's whole reading.
 *   * `{ type: "automation-run", run }`: a run was recorded or moved; the newest record of its occurrence.
 */
export type AutomationEvent = { type: "automations-changed"; reading: AutomationProjectReading } | { type: "automation-run"; run: AutomationRun }

/* ------------------------------------------------------------------ */
/* helpers both sides share                                             */
/* ------------------------------------------------------------------ */

/**
 * A definition's fingerprint: SHA-256 of its JSON with keys in order, 64 hex characters. Unchanged definition,
 * unchanged fingerprint, and no edit to the file can keep it: the person's approval rests on it.
 */
export function automationFingerprint(definition: AutomationDefinition): string {
  return sha256Hex(stableJson(JsonSchema.parse(JSON.parse(JSON.stringify(definition)))))
}

/**
 * The fingerprint before SHA-256 (two 32-bit FNV-1a hashes, 16 hex characters), read only to take an older approval
 * forward: one that still matches the file is that definition, approved; any other stays unapproved.
 */
export function legacyAutomationFingerprint(definition: AutomationDefinition): string {
  const text = stableJson(JsonSchema.parse(JSON.parse(JSON.stringify(definition))))
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`
}

const JsonSchema = z.json()

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const object = JsonRecordSchema.safeParse(value).data
  if (object) {
    const entries = Object.entries(object).filter(([, each]) => each !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${stableJson(each)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** The brief as one message, as `agents_start` writes a Fin's. */
export function automationBriefText(brief: Brief): string {
  return [
    brief.objective.trim(),
    ...(brief.doneWhen?.length ? ["", "Done when:", ...brief.doneWhen.map((line) => `- ${line}`)] : []),
    ...(brief.boundaries?.length ? ["", "Boundaries:", ...brief.boundaries.map((line) => `- ${line}`)] : []),
    ...(brief.output ? ["", `Output: ${brief.output}`] : []),
  ].join("\n")
}

/** A trigger in a few words, for a row. */
export function triggerWords(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "schedule":
      return `On schedule ${trigger.cron}${trigger.timezone === "UTC" ? " UTC" : ` (${trigger.timezone})`}`
    case "commit":
      return trigger.branch ? `On each commit to ${trigger.branch}` : "On each commit"
    case "manual":
      return "Run now only"
    case "github":
      return `GitHub ${trigger.event.replaceAll("_", " ")} on ${trigger.repo}`
    case "slack":
      return `Slack ${trigger.event}${trigger.channels.length ? ` in ${trigger.channels.join(", ")}` : ""}`
    case "linear":
      return `Linear ${trigger.event.replaceAll("_", " ")}`
    case "sentry":
      return `Sentry ${trigger.event.replaceAll("_", " ")}`
    case "webhook":
      return "Webhook"
    case "unsupported":
      return `Not readable here: ${trigger.why}`
  }
}

/** Why a cloud trigger doesn't fire yet, for its row; undefined once it does. */
export function cloudTriggerWaiting(trigger: AutomationTrigger, cloudRegistered: boolean | undefined): string | undefined {
  return triggerFiresInCloud(trigger) && cloudRegistered !== true ? `Its ${trigger.kind} trigger waits for the cloud account to register it.` : undefined
}
