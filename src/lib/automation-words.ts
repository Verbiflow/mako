import { nextCron, parseCron, wallAt } from "@mako/host/contracts/automation-cron"
import { z } from "zod"
import {
  AutomationTriggerSchema,
  automationBriefText,
  cloudTriggerWaiting,
  triggerFiresInCloud,
  triggerLive as contractTriggerLive,
  type AutomationCause,
  type AutomationDefinition,
  type AutomationDefinitionInput,
  type AutomationLimits,
  type AutomationProposal,
  type AutomationResult,
  type AutomationRun,
  type AutomationStart,
  type AutomationTrigger,
  type AutomationView,
} from "@mako/host/contracts/automations"
import { ACCESS_TIERS } from "@mako/host/contracts/access"
import type { Brief } from "@mako/host/contracts/agents"

/**
 * An automation in words: each trigger as a sentence ("Every weekday at 9:00 in Europe/London", "When a release is
 * published in Verbiflow/mako"), a schedule as the preset it is or the cron it says, a run's status, cause and result,
 * and the next times a schedule fires, read with the host's own cron (`automation-cron.ts`) so the editor's preview is
 * the schedule the host keeps. Pure: the Automations view, the editor, the Inbox's card and the Thread's line all say
 * an automation through here.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const

/* ------------------------------------------------------------------ */
/* schedules                                                            */
/* ------------------------------------------------------------------ */

/** A schedule as the picker offers it: each preset a sentence, anything else its cron. */
export type SchedulePreset =
  | { kind: "minutes"; every: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "monthly"; date: number; hour: number; minute: number }
  | { kind: "custom"; cron: string }

export type SchedulePresetKind = SchedulePreset["kind"]

export const PRESET_LABELS = {
  minutes: "Every few minutes",
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
  custom: "Custom cron",
} satisfies Record<SchedulePresetKind, string>

/** Minutes a "Every N minutes" schedule offers: divisors of an hour, so each hour runs alike. */
export const MINUTE_STEPS = [5, 10, 15, 20, 30] as const

const SHORTHANDS = new Map([
  ["@hourly", "0 * * * *"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@weekly", "0 0 * * 0"],
  ["@monthly", "0 0 1 * *"],
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
])

const NUMBER = /^\d{1,2}$/

/** The preset `cron` is, or `custom` with it as written. */
export function presetOf(cron: string): SchedulePreset {
  const text = (SHORTHANDS.get(cron.trim().toLowerCase()) ?? cron).trim()
  const parts = text.split(/\s+/)
  if (parts.length !== 5) return { kind: "custom", cron }
  const [minute = "", hour = "", date = "", month = "", weekday = ""] = parts
  const step = /^\*\/(\d{1,2})$/.exec(minute)
  if (step && hour === "*" && date === "*" && month === "*" && weekday === "*" && MINUTE_STEPS.some((each) => each === Number(step[1])))
    return { kind: "minutes", every: Number(step[1]) }
  if (!NUMBER.test(minute) || Number(minute) > 59 || month !== "*") return { kind: "custom", cron }
  const m = Number(minute)
  if (hour === "*" && date === "*" && weekday === "*") return { kind: "hourly", minute: m }
  if (!NUMBER.test(hour) || Number(hour) > 23) return { kind: "custom", cron }
  const h = Number(hour)
  if (date === "*" && weekday === "*") return { kind: "daily", hour: h, minute: m }
  if (date === "*" && (weekday === "1-5" || weekday === "mon-fri")) return { kind: "weekdays", hour: h, minute: m }
  if (date === "*" && /^[0-7]$/.test(weekday)) return { kind: "weekly", day: Number(weekday) % 7, hour: h, minute: m }
  if (weekday === "*" && NUMBER.test(date) && Number(date) >= 1 && Number(date) <= 28) return { kind: "monthly", date: Number(date), hour: h, minute: m }
  return { kind: "custom", cron }
}

/** The cron a preset writes. */
export function cronOf(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "minutes":
      return `*/${preset.every} * * * *`
    case "hourly":
      return `${preset.minute} * * * *`
    case "daily":
      return `${preset.minute} ${preset.hour} * * *`
    case "weekdays":
      return `${preset.minute} ${preset.hour} * * 1-5`
    case "weekly":
      return `${preset.minute} ${preset.hour} * * ${preset.day}`
    case "monthly":
      return `${preset.minute} ${preset.hour} ${preset.date} * *`
    case "custom":
      return preset.cron
  }
}

/** A preset of another kind, keeping the time of day the schedule had where it has one. */
export function switchPreset(from: SchedulePreset, kind: SchedulePresetKind): SchedulePreset {
  const hour = "hour" in from ? from.hour : 9
  const minute = "minute" in from ? from.minute : 0
  switch (kind) {
    case "minutes":
      return { kind, every: 15 }
    case "hourly":
      return { kind, minute }
    case "daily":
      return { kind, hour, minute }
    case "weekdays":
      return { kind, hour, minute }
    case "weekly":
      return { kind, day: "day" in from ? from.day : 1, hour, minute }
    case "monthly":
      return { kind, date: "date" in from ? from.date : 1, hour, minute }
    case "custom":
      return { kind, cron: cronOf(from) }
  }
}

/** "9:00", "14:30": a schedule's wall time, as the person wrote it in its timezone. */
export function clock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`
}

/** "on the 1st", "on the 22nd". */
export function ordinal(value: number): string {
  const tens = value % 100
  const suffix = tens >= 11 && tens <= 13 ? "th" : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th"
  return `${value}${suffix}`
}

/** A schedule's cadence in words, without its timezone: "Every weekday at 9:00". */
export function cadenceWords(cron: string): string {
  const preset = presetOf(cron)
  switch (preset.kind) {
    case "minutes":
      return `Every ${preset.every} minutes`
    case "hourly":
      return preset.minute === 0 ? "Every hour, on the hour" : `Every hour at :${String(preset.minute).padStart(2, "0")}`
    case "daily":
      return `Every day at ${clock(preset.hour, preset.minute)}`
    case "weekdays":
      return `Every weekday at ${clock(preset.hour, preset.minute)}`
    case "weekly":
      return `Every ${WEEKDAY_NAMES[preset.day]} at ${clock(preset.hour, preset.minute)}`
    case "monthly":
      return `On the ${ordinal(preset.date)} of every month at ${clock(preset.hour, preset.minute)}`
    case "custom":
      return `On the schedule ${preset.cron.trim()}`
  }
}

/** The timezone as a sentence ends with it: "in Europe/London", "UTC". */
export function zoneWords(timezone: string): string {
  return timezone === "UTC" ? "UTC" : `in ${timezone}`
}

/** The next `count` times `cron` fires in `timezone` after `after`; empty when it never does or doesn't parse. */
export function nextRuns(cron: string, timezone: string, count: number, after = Date.now()): number[] {
  const parsed = parseCron(cron)
  if (!parsed.ok) return []
  const found: number[] = []
  let cursor = after
  for (let index = 0; index < count; index++) {
    let next: number | undefined
    try {
      next = nextCron(parsed.spec, timezone, cursor)
    } catch {
      return found
    }
    if (next === undefined) break
    found.push(next)
    cursor = next
  }
  return found
}

/** Why a cron doesn't parse, or undefined when it does. */
export function cronProblem(cron: string): string | undefined {
  const parsed = parseCron(cron)
  return parsed.ok ? undefined : parsed.why
}

/** The timezone this Mac is in. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Every IANA timezone the runtime knows, this Mac's first; a short list where it can't say. */
export function knownZones(): string[] {
  const local = localZone()
  let all: string[]
  try {
    all = Intl.supportedValuesOf("timeZone")
  } catch {
    all = []
  }
  if (!all.length) all = ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Asia/Kolkata", "Australia/Sydney"]
  return [...new Set([local, "UTC", ...all])]
}

/* ------------------------------------------------------------------ */
/* when                                                                 */
/* ------------------------------------------------------------------ */

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" })
const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** A time to come, as this Mac's clock reads it: "in 12 min", "today 14:00", "tomorrow 9:00", "Fri 9:00", "24 Nov 9:00". */
export function whenAhead(at: number, now = Date.now()): string {
  const ahead = at - now
  if (ahead <= 0) return "now"
  if (ahead < 60 * MINUTE) return `in ${Math.max(1, Math.round(ahead / MINUTE))} min`
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY)
  const time = TIME.format(at)
  if (days === 0) return `today ${time}`
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${WEEKDAY.format(at)} ${time}`
  return `${DATE.format(at)} ${time}`
}

/** A time past, as a row says its age: "now", "4m ago", "3h ago", "2d ago", "12 Nov". */
export function whenAgo(at: number, now = Date.now()): string {
  const ago = now - at
  if (ago < MINUTE) return "just now"
  if (ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)}m ago`
  if (ago < DAY) return `${Math.floor(ago / (60 * MINUTE))}h ago`
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d ago`
  return DATE.format(at)
}

/** A full date and time, for a title: "Thu, 20 Nov, 09:00". */
export function whenExactly(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

/* ------------------------------------------------------------------ */
/* triggers                                                             */
/* ------------------------------------------------------------------ */

const GITHUB_EVENTS = {
  release: "When a release is published in",
  push: "When someone pushes to",
  pull_request: "When a pull request opens or changes in",
  check_failed: "When a check fails in",
  issue_comment: "When someone comments on an issue or pull request in",
  issues: "When an issue opens or changes in",
  workflow_run: "When a workflow run finishes in",
} satisfies Record<Extract<AutomationTrigger, { kind: "github" }>["event"], string>

export const GITHUB_EVENT_LABELS = {
  release: "a release is published",
  push: "someone pushes",
  pull_request: "a pull request opens or changes",
  check_failed: "a check fails",
  issue_comment: "someone comments",
  issues: "an issue opens or changes",
  workflow_run: "a workflow run finishes",
} satisfies Record<Extract<AutomationTrigger, { kind: "github" }>["event"], string>

export const SLACK_EVENT_LABELS = {
  message: "a message is posted",
  mention: "Mako is mentioned",
  reaction: "someone reacts",
} satisfies Record<Extract<AutomationTrigger, { kind: "slack" }>["event"], string>

export const LINEAR_EVENT_LABELS = {
  issue_created: "an issue is created",
  issue_updated: "an issue changes",
  comment: "someone comments",
} satisfies Record<Extract<AutomationTrigger, { kind: "linear" }>["event"], string>

export const SENTRY_EVENT_LABELS = {
  issue_created: "a new issue is seen",
  issue_regressed: "an issue regresses",
  alert: "an alert fires",
} satisfies Record<Extract<AutomationTrigger, { kind: "sentry" }>["event"], string>

function filterWords(filters: Record<string, string | string[]> | undefined): string {
  const entries = Object.entries(filters ?? {})
  if (!entries.length) return ""
  return ` where ${entries.map(([key, value]) => `${key.replaceAll("_", " ")} is ${Array.isArray(value) ? value.join(" or ") : value}`).join(" and ")}`
}

/** A trigger as a sentence, without its `runWhen`. */
export function triggerSentence(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "schedule":
      return `${cadenceWords(trigger.cron)} ${zoneWords(trigger.timezone)}`
    case "commit":
      return trigger.branch ? `When a commit lands on ${trigger.branch}` : "When a commit lands on any branch"
    case "manual":
      return "When you press Run now"
    case "github":
      return `${GITHUB_EVENTS[trigger.event]} ${trigger.repo}${filterWords(trigger.filters)}`
    case "slack": {
      const where = trigger.channels.length ? ` in ${trigger.channels.map((channel) => (channel.startsWith("#") ? channel : `#${channel}`)).join(", ")}` : " in any channel"
      return `When ${SLACK_EVENT_LABELS[trigger.event]} on Slack${where}${filterWords(trigger.filters)}`
    }
    case "linear":
      return `When ${LINEAR_EVENT_LABELS[trigger.event]} in Linear${trigger.team ? ` for ${trigger.team}` : ""}${filterWords(trigger.filters)}`
    case "sentry":
      return `When ${SENTRY_EVENT_LABELS[trigger.event]} in Sentry${trigger.project ? ` for ${trigger.project}` : ""}${filterWords(trigger.filters)}`
    case "webhook":
      return `When a webhook signed with ${trigger.secret} arrives${filterWords(trigger.filters)}${trigger.coalesce ? `, gathering ${trigger.coalesce.windowS} s of deliveries into one run` : ""}`
    case "unsupported":
      return `A trigger this Mako can't read: ${trigger.why}`
  }
}

/** The sentence and its condition: "When a release is published in acme/app, only if it's a major version". */
export function triggerWithCondition(trigger: AutomationTrigger): string {
  const runWhen = "runWhen" in trigger ? trigger.runWhen : undefined
  return runWhen ? `${triggerSentence(trigger)}, only if ${lowerFirst(runWhen)}` : triggerSentence(trigger)
}

/** Whether the trigger fires: this Mac's own, or the cloud's once the automation is registered there. */
export function triggerLive(trigger: AutomationTrigger, cloudRegistered?: boolean): boolean {
  return contractTriggerLive(trigger, cloudRegistered)
}

export function triggerInCloud(trigger: AutomationTrigger): boolean {
  return triggerFiresInCloud(trigger)
}

/** Why a trigger doesn't fire yet, or undefined when it does. */
export function triggerWaits(trigger: AutomationTrigger, cloudRegistered?: boolean): string | undefined {
  if (trigger.kind === "unsupported") return "Kept as written; it never fires."
  const waiting = cloudTriggerWaiting(trigger, cloudRegistered)
  return waiting ? `${waiting.replace(/\.$/, "")}; it doesn't fire until then.` : undefined
}

/** The triggers of a definition in one line, for its row: the first, and how many more. */
export function triggersLine(definition: Pick<AutomationDefinition, "triggers">): string {
  const triggers = definition.triggers.filter((trigger) => trigger.kind !== "manual")
  const first = triggers[0]
  if (!first) return "Only when you press Run now"
  return triggers.length > 1 ? `${triggerSentence(first)} · and ${triggers.length - 1} more` : triggerSentence(first)
}

export function lowerFirst(words: string): string {
  return words ? words.charAt(0).toLowerCase() + words.slice(1) : words
}

export function upperFirst(words: string): string {
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words
}

/* ------------------------------------------------------------------ */
/* start settings                                                       */
/* ------------------------------------------------------------------ */

export function accessWords(tier: string): string {
  return ACCESS_TIERS.find((info) => info.tier === tier)?.label ?? tier
}

export function placeWords(place: string): string {
  if (place === "here") return "This Mac"
  if (place === "cloud") return "Cloud"
  return place.startsWith("device:") ? place.slice("device:".length) : place
}

export const RESULT_WORDS = {
  "pull-request": { label: "Open a pull request", detail: "Each run's changes go up for review on their own branch" },
  report: { label: "Report back", detail: "Each run ends with a report in its Thread; nothing is pushed" },
  act: { label: "Act directly", detail: "Each run makes its changes where it works, with nothing to review first" },
} satisfies Record<AutomationResult, { label: string; detail: string }>

export function overlapWords(overlap: AutomationLimits["overlap"]): string {
  return overlap === "queue" ? "Queue behind the run that's going" : "Skip while a run is going"
}

/** Start settings as label and value pairs, in the order the editor shows them. */
export function startFacts(start: AutomationStart, harnessLabel: (id: string) => string): Array<[string, string]> {
  const facts: Array<[string, string]> = [
    ["Harness", start.harness ? harnessLabel(start.harness) : "Your first harness with room"],
    ["Model", start.model ?? "Its default"],
  ]
  if (start.reasoning) facts.push(["Reasoning", start.reasoning])
  if (start.rule) facts.push(["Rule", `Rule ${start.rule}`])
  facts.push(["Access", accessWords(start.access)], ["Runs on", placeWords(start.place)])
  if (start.place !== "cloud") facts.push(["If this Mac is off", WHEN_AWAY_WORDS[start.whenAway]])
  facts.push(["Worktree", start.workspace ? [start.workspace.branch ? `branch ${start.workspace.branch}` : "a new branch", start.workspace.base ? `from ${start.workspace.base}` : undefined].filter(Boolean).join(" ") : "The project folder"])
  return facts
}

export function limitFacts(limits: AutomationLimits): Array<[string, string]> {
  return [
    ["Overlap", overlapWords(limits.overlap)],
    ["Runs a day", limits.maxRunsPerDay ? `At most ${limits.maxRunsPerDay}` : "No cap"],
    ["Timeout", `${limits.timeoutMin} min`],
    ["Token budget", limits.tokenBudget ? `${compactNumber(limits.tokenBudget)} tokens` : "None"],
  ]
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimZero(value / 1_000)}K`
  return String(value)
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "")
}

export function briefText(brief: Brief): string {
  return automationBriefText(brief)
}

/* ------------------------------------------------------------------ */
/* runs                                                                 */
/* ------------------------------------------------------------------ */

export type RunTone = "working" | "positive" | "negative" | "caution" | "attention" | "faint"

/** A run's status in a word and the hue it carries. */
export interface RunStatusWords {
  label: string
  tone: RunTone
}

export function runStatus(run: AutomationRun): RunStatusWords {
  switch (run.status) {
    case "queued":
      return { label: "Queued", tone: "faint" }
    case "fired":
      return { label: "Running", tone: "working" }
    case "skipped":
      return { label: run.mergedInto ? "Merged" : "Skipped", tone: "faint" }
    case "gate-skipped":
      return { label: "Nothing to do", tone: "faint" }
    case "failed-to-start":
      return { label: "Didn't start", tone: "negative" }
    case "failed":
      return { label: "Failed", tone: "negative" }
    case "completed":
      switch (run.result?.status) {
        case "blocked":
          return { label: "Blocked", tone: "caution" }
        case "needs-input":
          return { label: "Needs you", tone: "attention" }
        case "failed":
          return { label: "Failed", tone: "negative" }
        default:
          return { label: "Done", tone: "positive" }
      }
  }
}

/** What started a run: "Scheduled 9:00", "Commit 1a2b3c4 · Fix the retry", "Run now by you", "Run by an agent". */
export function causeWords(cause: AutomationCause): string {
  switch (cause.kind) {
    case "schedule":
      return `${cause.catchUp ? "Caught up, scheduled" : "Scheduled"} ${TIME.format(cause.at)}`
    case "commit":
      return `Commit ${cause.head.slice(0, 7)}${cause.subject ? ` · ${cause.subject}` : ""}`
    case "person":
      return "Run now, by you"
    case "agent":
      return "Run now, by an agent"
    case "event":
      return cause.batch && cause.batch > 1 ? `${cause.summary} · ${cause.batch} events` : cause.summary
  }
}

export const EVENT_SOURCE_WORDS = { github: "GitHub", slack: "Slack", linear: "Linear", sentry: "Sentry", webhook: "Webhook" } as const

/** What its `runWhen` check said, for a run's row: "Checked: …" for a pass; a skip says it as its why. */
export function runWhenWords(run: AutomationRun): string | undefined {
  if (!run.runWhen) return undefined
  return run.runWhen.verdict === "run" ? `Checked “only if”: ${run.runWhen.reason}` : `Skipped by “only if”: ${run.runWhen.reason}`
}

export const WHEN_AWAY_WORDS = {
  queue: "Run when this Mac is back",
  cloud: "Run in the cloud",
  skip: "Skip it",
} as const

/** The line a run's row says under its status: the result's summary, or why it didn't run. */
export function runLine(run: AutomationRun): string | undefined {
  if (run.result?.summary) return run.result.summary
  if (run.status === "skipped" && run.runWhen?.verdict === "skip") return `Not worth a run: ${run.runWhen.reason}`
  if (run.why) return run.why
  if (run.mergedInto) return `Folded into the run for ${run.mergedInto}`
  if (run.status === "fired") return "At work in its Thread"
  if (run.status === "queued") return "Starts when the run before it ends"
  return undefined
}

/** A run's newest moment: when it ended, started or was recorded. */
export function runAt(run: AutomationRun): number {
  return run.endedAt ?? run.startedAt ?? run.at
}

/** Skipped runs in a row folded into one entry ("Skipped 4 times"), the others as they are. */
export type RunEntry = { kind: "run"; run: AutomationRun } | { kind: "skips"; runs: AutomationRun[] }

export function foldSkips(runs: readonly AutomationRun[]): RunEntry[] {
  const entries: RunEntry[] = []
  for (const run of runs) {
    const skip = run.status === "skipped" || run.status === "gate-skipped"
    const last = entries.at(-1)
    if (skip && last?.kind === "skips" && last.runs[0]?.status === run.status) last.runs.push(run)
    else if (skip && last?.kind === "run" && last.run.status === run.status) entries[entries.length - 1] = { kind: "skips", runs: [last.run, run] }
    else entries.push({ kind: "run", run })
  }
  return entries
}

/* ------------------------------------------------------------------ */
/* an automation as its row stands                                      */
/* ------------------------------------------------------------------ */

/** Whether the automation waits on the person: a proposal, a pause, a failure, an issue. */
export function needsYou(view: AutomationView, proposals: readonly AutomationProposal[]): boolean {
  if (proposals.some((proposal) => proposal.status === "pending" && proposal.automation === view.definition.id)) return true
  if (view.standing === "paused") return true
  if (view.issues.length) return true
  const last = view.lastRun
  return Boolean(last && (last.status === "failed" || last.status === "failed-to-start" || (last.status === "completed" && last.result && last.result.status !== "done")))
}

export function hasSchedule(definition: Pick<AutomationDefinition, "triggers">): boolean {
  return definition.triggers.some((trigger) => trigger.kind === "schedule")
}

/** The automation's next run from its local state, else from its schedules. */
export interface NextRun {
  at: number
  /** The timezone of the schedule it comes from, which its words are read in. */
  zone: string
}

export function nextRunOf(view: AutomationView, now = Date.now()): NextRun | undefined {
  if (view.standing === "off" || view.standing === "paused" || view.standing === "unsupported") return undefined
  const times = view.definition.triggers.flatMap((trigger) => (trigger.kind === "schedule" ? nextRuns(trigger.cron, trigger.timezone, 1, now).map((at) => ({ at, zone: trigger.timezone })) : []))
  const soonest = times.sort((a, b) => a.at - b.at)[0]
  const kept = view.local.nextRunAt
  if (kept && kept > now) return { at: kept, zone: times.find((each) => each.at === kept)?.zone ?? soonest?.zone ?? localZone() }
  return soonest
}

/* ------------------------------------------------------------------ */
/* a schedule's times, in its own timezone first                        */
/* ------------------------------------------------------------------ */

const ZONE_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const ZONE_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

function zoneParts(at: number, zone: string) {
  const wall = wallAt(at, zone)
  const weekday = ZONE_WEEKDAY[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()] ?? ""
  return { ...wall, weekday, monthName: ZONE_MONTH[wall.month - 1] ?? "", clock: clock(wall.hour, wall.minute) }
}

/** A run's time as its schedule says it, in the schedule's timezone: "Mon 23 Nov, 7:00". */
export function zoneDate(at: number, zone: string): string {
  const parts = zoneParts(at, zone)
  return `${parts.weekday} ${parts.day} ${parts.monthName}, ${parts.clock}`
}

/** The same moment on this Mac's clock, when it reads differently there: "11:00 PM Sun your time"; else undefined. */
export function localTime(at: number, zone: string): string | undefined {
  const local = localZone()
  if (local === zone) return undefined
  const there = wallAt(at, zone)
  const here = wallAt(at, local)
  if (there.year === here.year && there.month === here.month && there.day === here.day && there.hour === here.hour && there.minute === here.minute) return undefined
  return `${TIME.format(at)} ${WEEKDAY.format(at)} your time`
}

/** A time to come in the schedule's own words and timezone: "in 12 min", "today 7:00", "tomorrow 7:00", "Mon 7:00", "23 Nov 7:00". */
export function whenAheadIn(at: number, zone: string, now = Date.now()): string {
  const ahead = at - now
  if (ahead <= 0) return "now"
  if (ahead < 60 * MINUTE) return `in ${Math.max(1, Math.round(ahead / MINUTE))} min`
  const there = zoneParts(at, zone)
  const today = wallAt(now, zone)
  const days = Math.round((Date.UTC(there.year, there.month - 1, there.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY)
  if (days === 0) return `today ${there.clock}`
  if (days === 1) return `tomorrow ${there.clock}`
  if (days < 7) return `${there.weekday} ${there.clock}`
  return `${there.day} ${there.monthName} ${there.clock}`
}

/** A next run in full, for a title: "Mon 23 Nov, 7:00 in Europe/London · 11:00 PM Sun your time". */
export function nextRunTitle(next: NextRun): string {
  const local = localTime(next.at, next.zone)
  return `${zoneDate(next.at, next.zone)} ${zoneWords(next.zone)}${local ? ` · ${local}` : ""}`
}

/** A project's folder as a name: its last part. */
export function projectName(project: string): string {
  return project.split("/").filter(Boolean).at(-1) ?? project
}

/** An id from a name: "Nightly triage" is `nightly-triage`. */
export function idFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 80)
  return slug || "automation"
}

/** An id not yet taken in `taken`: `name`, then `name-2`, `name-3`. */
export function freeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let index = 2; ; index++) {
    const next = `${base.slice(0, 76)}-${index}`
    if (!taken.has(next)) return next
  }
}

/** What approving does, as its button says it: the ask's own words (`agentAskWords`). */
export const APPROVE_WORDS = { create: "Approve", update: "Approve", delete: "Delete", enable: "Turn on" } satisfies Record<AutomationProposal["change"], string>

/** A copy of `value` without `key`. */
export function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const next = { ...value }
  Reflect.deleteProperty(next, key)
  return next
}

/** A record's entries with its keys' own type. */
export function entriesOf<K extends string, V>(record: Readonly<Record<K, V>>): Array<[K, V]> {
  // SAFETY: `record` is a `Record<K, V>` literal of this module's, so its own enumerable keys are exactly the `K`s.
  return Object.entries(record) as Array<[K, V]>
}

/** The key of `record` that `value` names, or undefined: a select's value read back as the choice it is. */
export function keyOf<K extends string, V>(record: Readonly<Record<K, V>>, value: string): K | undefined {
  return entriesOf(record).find(([key]) => key === value)?.[0]
}

const TRIGGER_LIST = z.array(AutomationTriggerSchema)

/** Triggers as written (a template's, a draft's), read with their defaults; none when they don't read. */
export function readTriggers(triggers: AutomationDefinitionInput["triggers"]): AutomationTrigger[] | undefined {
  if (triggers === undefined) return undefined
  const parsed = TRIGGER_LIST.safeParse(triggers)
  return parsed.success ? parsed.data : undefined
}

/** Why an automation that's on doesn't run, or what it waits on, in words and the hue they carry; undefined when all's well. */
export function standingNote(view: AutomationView): { text: string; tone: "caution" | "negative" | "faint" } | undefined {
  const waiting = view.definition.triggers.map((trigger) => cloudTriggerWaiting(trigger, view.local.cloudRegistered)).find(Boolean)
  if (view.standing === "paused" && view.local.paused) return { text: view.local.paused.reason, tone: "caution" }
  if (view.local.cloudIssue) return { text: `Your cloud account didn’t register it: ${view.local.cloudIssue}`, tone: "negative" }
  if (view.standing === "unsupported") return { text: waiting ?? view.issues[0] ?? "None of its triggers fires on this Mac.", tone: "faint" }
  if (view.issues.length) return { text: view.issues.join(" "), tone: "caution" }
  if (view.local.enabled && waiting) return { text: waiting, tone: "faint" }
  return undefined
}

export const PROPOSAL_CHANGE_WORDS = {
  create: "Proposes a new automation",
  update: "Proposes a change",
  delete: "Proposes deleting it",
  enable: "Proposes turning it on",
} satisfies Record<AutomationProposal["change"], string>

export const PROPOSAL_STATUS_WORDS = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
  stale: "Out of date",
} satisfies Record<AutomationProposal["status"], string>

export { scheduleOccurrence as scheduleOccurrenceOf } from "@mako/host/contracts/automations"
