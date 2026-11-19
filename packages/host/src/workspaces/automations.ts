import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { MethodTable } from "../base/methods.js"
import type { AgentAskWant } from "../contracts/agent-asks.js"
import type { ReportStatus } from "../contracts/agents.js"
import { lastCronAtOrBefore, nextCron, parseCron } from "../contracts/automation-cron.js"
import {
  AUTOMATION_CATCH_UP_GRACE_MS,
  AUTOMATION_PAUSE_AFTER_FAILURES,
  AUTOMATION_PROPOSAL_TTL_MS,
  AUTOMATION_QUEUE_LIMIT,
  AutomationDefinitionSchema,
  ForwardedOutcomeSchema,
  automationBriefText,
  automationClientKey,
  automationDiff,
  automationFingerprint,
  branchFor,
  approvedDefinitionOf,
  isApproved,
  cloudTriggerWaiting,
  scheduleOccurrence,
  triggerFiresInCloud,
  triggerLive,
  type AutomationCause,
  type AutomationChange,
  type AutomationDefinition,
  type AutomationDiffEntry,
  type AutomationDraft,
  type AutomationLocal,
  type AutomationProjectReading,
  type AutomationProposal,
  type AutomationRun,
  type AutomationRunNowResult,
  type AutomationRunOf,
  type AutomationHook,
  type ForwardedOutcome,
  type AutomationsReading,
  type AutomationTemplate,
  type AutomationTrigger,
  type AutomationView,
  type ScheduleTrigger,
} from "../contracts/automations.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { CloudRunStartSchema, dataMarker, eventMarker, untrustedDataText, untrustedEventText, type CloudRun, type CloudRunStart } from "@mako/protocol/automations-cloud"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import { readAutomationFile, writeAutomationFile, type AutomationFileReading } from "./automation-file.js"
import type { AutomationStore } from "./automation-store.js"
import { AUTOMATION_TEMPLATES } from "./automation-templates.js"

/**
 * Automations: stored `agents_start`s and what starts them (`contracts/automations.ts`).
 *
 * The definitions are the project's file; on/off, next runs, run records and proposals are this Mac's
 * (`AutomationStore`). It serves every project a window has open and every one with an automation on, not only the
 * one in front: the scheduler ticks over all of them (`AutomationScheduler`, `HostJobs` here; the cloud account's
 * Durable Object in a later slice).
 *
 * A run goes: daily cap, overlap (one at a time; extras skipped, or queued with `overlap: queue`), the gate (exit 1
 * skips; its `key` dedupes), `runWhen` (a fast model's yes or no), then its record, kept before its Thread starts under
 * `automation:<id>:<occurrence>`, so a repeat reaches the same Thread. It's complete when that Thread's turn ends,
 * with what it said; three failures in a row pause it, saying why.
 */

/** What drives `tick`: here `HostJobs`; the cloud account's Durable Object once schedules move there. */
export interface AutomationScheduler {
  /** Calls `due` as time passes, about every half minute; the returned function stops it. */
  start(due: (now: number) => Promise<void>): () => void
}

/** A fast, cheap model's yes or no on whether an event meets a trigger's `runWhen`. */
export interface RunWhenJudge {
  judge(input: { condition: string; event: string }): Promise<{ run: boolean; why: string; model?: string } | { unavailable: string }>
}

/** What starts a run's Thread: `agents_start`'s fields, settled. */
export interface AutomationLaunch {
  project: string
  definition: AutomationDefinition
  run: AutomationRun
  /** The conversation this run's Thread is: fixed by its client key, so a repeat finds it. */
  conversationId: string
  /** The message it sends: the brief, with its gate's context. */
  requestId: string
  text: string
  /** Filled in from the template. */
  branch?: string
  /** A standing Thread that already exists takes the run as its next message. */
  standing: boolean
}

/** How a run's Thread stands, as the host holds it. */
export type AutomationThreadReading =
  | { state: "working" }
  | { state: "ended"; status: Exclude<ReportStatus, "progress">; summary: string }
  /** Not on this host now (not loaded, or another place's): the timeout still applies. */
  | { state: "unknown" }

export type GateOutcome = { exit: number; stdout: string; stderr: string } | { error: string }

/**
 * The cloud account's word on an occurrence it also holds (`AutomationCloud`): asked before this Mac runs a schedule's
 * slot or an event of an automation registered there, so of the Mac and the cloud only one ever runs it.
 */
export interface AutomationClaims {
  /** `claimed`: this Mac's to run. `held`: the cloud's or another's, as its record stands. `unreachable`: not asked, so not run here. */
  claim(project: string, run: AutomationRun): Promise<{ claimed: true } | { held: CloudRun } | { unreachable: string }>
  /** An occurrence offered to this Mac that it won't run, and why; the account records it skipped. */
  decline(project: string, run: AutomationRun, why: string): Promise<void>
  /** The cloud's record of an occurrence, as this Mac keeps it. */
  record(project: string, run: CloudRun): AutomationRun
}

/** An occurrence the cloud account offered this Mac: its event, which the run's agent reads only fenced as untrusted. */
export interface AutomationOffer {
  event?: unknown
}

/** Nothing started: no Thread exists for the run. Anything else thrown leaves that uncertain, so the run stays fired. */
export class AutomationNotStartedError extends Error {}

/** Who an agent's call is, as its proposal names it. */
export interface AutomationProposer {
  conversation: string
  title?: string
  harness?: string
}

/** What `mako:automations-draft` reads of a Thread. */
export interface ThreadDraftSource {
  cwd: string
  title?: string
  prompt: string
  harness?: string
  model?: string
  reasoning?: string
  access?: AutomationDefinition["start"]["access"]
  branch?: string
}

export interface AutomationsDeps {
  store: AutomationStore
  scheduler: AutomationScheduler
  emit(event: HostEvent): void
  /** The project folders windows have open now. */
  openProjects(): string[]
  /** `conversation`: the run went to another conversation than the launch named (a standing Thread's fresh session). */
  startThread(launch: AutomationLaunch): Promise<{ thread?: string; place?: string; conversation?: string }>
  threadOf(conversation: string, request: string): AutomationThreadReading
  stopThread(conversation: string): Promise<void>
  runGate(project: string, command: string, timeoutMs: number): Promise<GateOutcome>
  /** The project's HEAD, its branch and the commit's subject; undefined outside a repository. */
  head(project: string): Promise<{ head: string; branch?: string; subject?: string } | undefined>
  runWhen?: RunWhenJudge
  /** Mako's note to an agent's conversation, once, under `request`. */
  tell(conversation: string, request: string, text: string): Promise<void>
  /** The agent asks that carry proposals to the person (`AgentAskGate`). */
  asks: { raise(conversation: string, want: AgentAskWant): string; settle(conversation: string, ask: string): void }
  draftSource?(conversationId: string): ThreadDraftSource | undefined
  /** `<dataRoot>/automation-launches`: an older build's receipts for approved runs, read for one release. */
  legacyLaunches?: string
  /** The cloud account's claims, once this Mac is signed in to one (`AutomationCloud`). */
  claims?(): AutomationClaims | undefined
  /** A project's automations changed (an edit, on or off, a decision): what the cloud registers follows. */
  changed?(project: string): void
  /**
   * A cloud machine's host: what its agents propose is the person's Mac's to apply, never this clone's. A decision here
   * (the ask's card in its Thread) waits for the Mac (`relay: "awaiting"`), which reads them (`forwarded`) and says
   * how each went (`settleForwarded`); only then is the agent told.
   */
  relaysProposals?: boolean
  /** The person's Mac: tells a cloud Thread's host how a proposal forwarded from it went (`mako:automations-forward-settle`). */
  forward?(): { settle(thread: string, proposal: string, outcome: ForwardedOutcome): Promise<void> } | undefined
  /**
   * Starts a cloud run on this host (a cloud Thread's), asked by the account: harness, rule, model, reasoning and mode
   * settled as a run here settles them, and refused, saying why, where they can't be (`mako:automations-cloud-start`).
   */
  cloudStart?(launch: CloudRunStart): Promise<{ harness: string; modeId: string }>
  /** The account's webhooks (`AutomationCloud.hook`), once this Mac is signed in to one with the cloud. */
  hooks?(): { hook(name: string, provider?: AutomationHook["provider"], rotate?: boolean, secret?: string): Promise<AutomationHook> } | undefined
  now?(): number
}

interface Cached {
  mtimeMs: number | undefined
  reading: AutomationFileReading
}

const LegacyReceiptSchema = z.object({
  cwd: z.string(),
  id: z.string(),
  result: z.object({ status: z.enum(["started", "completed", "not-run", "unknown"]) }).loose(),
})
const GateContextSchema = z.record(z.string(), z.json())
/** A gate's dedupe key: a word, not blank. */
const GateKeySchema = z.string().trim().min(1)
const IdTextSchema = z.string()
const JsonSchema = z.json()

/** A name's UUID, the same each time: conversation and request ids a repeat finds again. */
export function automationUuid(name: string): string {
  const hex = createHash("sha256").update(`mako automation\0${name}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A schedule occurrence's name: the contract's, shared with the cloud. */
export const slotName = scheduleOccurrence

const DAY_MS = 24 * 60 * 60_000
/** A fired run younger than this whose Thread this host doesn't know starts again, under the same conversation. */
const RECOVER_WITHIN_MS = 10 * 60_000
/** Runs that count against `maxRunsPerDay`: every one that started, or waits to. */
const COUNTED = new Set<AutomationRun["status"]>(["queued", "fired", "completed", "failed"])
/** Runs a gate key already covers: one under way, waiting, or done. A failed one may run again. */
const COVERED = new Set<AutomationRun["status"]>(["queued", "fired", "completed"])

export class Automations {
  readonly #deps: AutomationsDeps
  readonly #files = new Map<string, Cached>()
  /** One change at a time per automation, so two triggers never both pass the overlap check. */
  readonly #turns = new Map<string, Promise<unknown>>()
  #stopScheduler: (() => void) | undefined
  #started: Promise<void> | undefined

  constructor(deps: AutomationsDeps) {
    this.#deps = deps
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  /** Reads what this Mac kept, takes up what an older build or a stopped host left, and starts the schedule. */
  start(): Promise<void> {
    this.#started ??= (async () => {
      await this.#deps.store.load()
      await this.#recover()
      this.#stopScheduler = this.#deps.scheduler.start((now) => this.tick(now))
    })()
    return this.#started
  }

  /** A window opened `project`: it's served from now, and its reading goes to every window. */
  async opened(project: string): Promise<void> {
    await this.start()
    this.#deps.store.seen(project, this.#now())
    await this.#changed(project)
  }

  stop(): void {
    this.#stopScheduler?.()
    this.#stopScheduler = undefined
  }

  /* ---------------------------------------------------------------- reading */

  /** The projects served: those open in a window, and those with an automation on or a proposal waiting. */
  projects(): string[] {
    const open = this.#deps.openProjects()
    const store = this.#deps.store
    const kept = store.projects().filter((project) => store.ids(project).some((id) => store.local(project, id).enabled) || store.proposals(project).some((proposal) => proposal.status === "pending"))
    return [...new Set([...open, ...kept])]
  }

  async #file(project: string): Promise<AutomationFileReading> {
    const cached = this.#files.get(project)
    const reading = await readAutomationFile(project)
    if (cached && reading.mtimeMs !== undefined && cached.mtimeMs === reading.mtimeMs) return cached.reading
    this.#files.set(project, { mtimeMs: reading.mtimeMs, reading })
    return reading
  }

  async read(project?: string): Promise<AutomationsReading> {
    await this.start()
    const projects = project === undefined ? this.projects() : [project]
    return { projects: await Promise.all(projects.map((each) => this.reading(each))) }
  }

  async reading(project: string): Promise<AutomationProjectReading> {
    await this.start()
    const file = await this.#file(project)
    const store = this.#deps.store
    for (const definition of file.definitions) this.#local(project, definition)
    const automations = file.definitions.map((definition) => this.#view(project, definition))
    const proposals = [...store.proposals(project)].sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.at - a.at).slice(0, 50)
    return {
      project,
      automations,
      proposals,
      file: { exists: file.exists, ...(file.legacy && { legacy: true }), ...(file.error && { error: file.error }), ...(file.skipped.length && { skipped: file.skipped }) },
    }
  }

  #view(project: string, definition: AutomationDefinition): AutomationView {
    const local = this.#deps.store.local(project, definition.id)
    const runs = this.#deps.store.runs(project, definition.id)
    const activeRun = runs.find((run) => run.status === "fired")
    const fingerprint = automationFingerprint(definition)
    const live = definition.triggers.filter((trigger) => triggerLive(trigger, local.cloudRegistered))
    const issues = [
      ...definition.triggers.flatMap((trigger) => trigger.kind === "unsupported" ? [`A trigger can't be read here: ${trigger.why}.`] : triggerFiresInCloud(trigger) ? [cloudTriggerWaiting(trigger, local.cloudRegistered)].filter((why) => why !== undefined) : []),
      ...(definition.start.place.startsWith("device:") ? ["A run on another device starts with the cloud slice; until then it can't start."] : []),
      ...(local.cloudIssue ? [`The cloud account didn't take it: ${local.cloudIssue}`] : []),
    ]
    // On, and never approved or changed since: it runs nothing, and reads paused until the person approves what it says.
    const approved = isApproved(local, fingerprint)
    const standing = !local.enabled ? "off" : activeRun ? "running" : local.paused || !approved ? "paused" : live.some((trigger) => trigger.kind !== "manual") ? "on" : "unsupported"
    const changed = local.enabled && !local.paused && !approved
    return {
      project,
      definition,
      local: changed ? { ...local, paused: { kind: "changed", reason: CHANGED_REASON, at: this.#now() } } : local,
      standing,
      ...(runs[0] && { lastRun: runs[0] }),
      ...(activeRun && { activeRun }),
      fingerprint,
      issues,
    }
  }

  async #definition(project: string, id: string): Promise<AutomationDefinition | undefined> {
    return (await this.#file(project)).definitions.find((definition) => definition.id === id)
  }

  /** What this Mac keeps of an automation. Its approval counts only as `isApproved` says: an older form never does. */
  #local(project: string, definition: AutomationDefinition): AutomationLocal {
    return this.#deps.store.local(project, definition.id)
  }

  /** The definition the person approved, as they approved it; undefined when none is kept, or it isn't the approved one. */
  #approvedDefinition(local: AutomationLocal): AutomationDefinition | undefined {
    return approvedDefinitionOf(local)
  }

  /** Runs still waiting their turn, passed over now: their automation was turned off or paused. */
  #dropQueued(project: string, id: string, why: string): void {
    for (const run of this.#deps.store.runs(project, id)) if (run.status === "queued" && !run.cloud) this.#deps.store.putRun({ ...run, status: "skipped", why, endedAt: this.#now() })
  }

  runs(project: string, id?: string, limit = 50): AutomationRun[] {
    const store = this.#deps.store
    const ids = id === undefined ? store.ids(project) : [id]
    return ids.flatMap((each) => store.runs(project, each)).sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.min(limit, 500)))
  }

  templates(): AutomationTemplate[] {
    return AUTOMATION_TEMPLATES
  }

  /** The run a Thread is, by its conversation, however old: for its "Run of <name>" line. */
  async runOf(conversation: string): Promise<AutomationRunOf | null> {
    await this.start()
    const run = this.#deps.store.runByConversation(conversation)
    if (!run) return null
    const definition = await this.#definition(run.project, run.automation).catch(() => undefined)
    return { project: run.project, id: run.automation, occurrence: run.occurrence, name: definition?.name ?? run.automation }
  }

  /**
   * The cloud's record of an occurrence, from its runs feed: kept as this Mac's record of it, unless this Mac runs it
   * itself (claimed, its own record is the one), and counted as one of its runs for its pause after failures.
   */
  async recordCloud(run: AutomationRun): Promise<AutomationRun | undefined> {
    await this.start()
    return this.#inTurn(run.project, run.automation, async () => {
      const store = this.#deps.store
      const kept = store.run(run.project, run.automation, run.occurrence)
      // This Mac's own record stands, unless it ran nothing and the cloud then did (its Mac away, or passed over).
      if (kept && !kept.cloud && (kept.status === "fired" || kept.status === "queued" || kept.status === "completed" || kept.status === "failed" || !(run.status === "fired" || run.status === "completed" || run.status === "failed"))) return kept
      if (kept?.cloud && kept.cloud.seq >= (run.cloud?.seq ?? 0)) return kept
      const recorded = await this.#record(run)
      const ended = run.status === "completed" || run.status === "failed"
      if (ended && kept?.status !== run.status) {
        if (run.status === "failed") await this.#failed(run.project, run.automation, run.why ?? "its cloud run failed")
        else {
          const local = store.local(run.project, run.automation)
          if (local.failures) store.setLocal(run.project, run.automation, { ...local, failures: 0 })
          await this.#changed(run.project)
        }
      }
      return recorded
    })
  }

  /** A webhook for a trigger, made or rotated in the account, its secret shown this once. */
  async hook(name: string, provider?: AutomationHook["provider"], rotate?: boolean, secret?: string): Promise<AutomationHook> {
    const hooks = this.#deps.hooks?.()
    if (!hooks) throw new Error("Webhooks are the cloud account's: sign in to Mako with the cloud on to make one.")
    return hooks.hook(name, provider, rotate, secret)
  }

  /** The cloud's registration of an automation: on, with what it's on with, or why not (`AutomationCloud`). */
  async setCloudRegistered(project: string, id: string, registered: { ok: true } | { issue: string } | { off: true }): Promise<void> {
    const store = this.#deps.store
    const local = store.local(project, id)
    const next: AutomationLocal = "ok" in registered ? { ...local, cloudRegistered: true, cloudIssue: undefined } : "issue" in registered ? { ...local, cloudRegistered: undefined, cloudIssue: registered.issue.slice(0, 1000) } : { ...local, cloudRegistered: undefined, cloudIssue: undefined }
    if (next.cloudRegistered === local.cloudRegistered && next.cloudIssue === local.cloudIssue) return
    store.setLocal(project, id, next)
    await store.save()
    const reading = await this.reading(project)
    this.#deps.emit({ type: "automations-changed", reading })
  }

  /** "Make this an automation": the Thread's first prompt and how it started, for the editor to open. */
  draft(conversationId: string): AutomationDraft {
    const source = this.#deps.draftSource?.(conversationId)
    if (!source) throw new Error("Mako can't find that Thread's first prompt here.")
    const title = source.title?.trim() || source.prompt.split("\n")[0]!.slice(0, 80)
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "automation"
    return {
      project: source.cwd,
      definition: {
        id,
        name: title.slice(0, 120),
        prompt: { objective: source.prompt.slice(0, 200_000) },
        start: {
          ...(source.harness && { harness: source.harness }),
          ...(source.model && { model: source.model }),
          ...(source.reasoning && { reasoning: source.reasoning }),
          access: source.access ?? "edits",
          place: "here",
          ...(source.branch && { workspace: { branch: `${id}/{date}` } }),
        },
        triggers: [{ kind: "manual" }],
      },
    }
  }

  /* ---------------------------------------------------------------- the person's edits */

  /**
   * The person's own edit: written at once. One that's on stays on with its new definition approved, when the file
   * held what they'd approved and this edit is the only change; otherwise (an edit outside Mako came first) only with
   * `approve`, the fingerprint of the definition saved, given after they saw what changed since their approval.
   * Unapproved, it stays paused, and its row shows that change.
   */
  async save(project: string, raw: JsonValue, replaces?: string, approveAs?: string): Promise<AutomationProjectReading> {
    await this.start()
    const definition = AutomationDefinitionSchema.parse(raw)
    const prior = await this.#definition(project, replaces ?? definition.id)
    const priorLocal = prior ? this.#local(project, prior) : this.#deps.store.local(project, replaces ?? definition.id)
    const clean = prior !== undefined && isApproved(priorLocal, automationFingerprint(prior))
    await this.#write(project, (definitions) => {
      const without = definitions.filter((each) => each.id !== definition.id && each.id !== replaces)
      const at = definitions.findIndex((each) => each.id === (replaces ?? definition.id))
      return at < 0 ? [...without, definition] : [...without.slice(0, at), definition, ...without.slice(at)]
    })
    const store = this.#deps.store
    if (replaces && replaces !== definition.id) {
      store.setLocal(project, definition.id, store.local(project, replaces))
      store.forget(project, replaces)
    }
    const local = store.local(project, definition.id)
    const fingerprint = automationFingerprint(definition)
    if (local.enabled && !isApproved(local, fingerprint) && (clean || approveAs === fingerprint)) store.setLocal(project, definition.id, { ...approve(local, definition), nextRunAt: this.#nextRun(definition, this.#now()) })
    return this.#changed(project)
  }

  async remove(project: string, id: string): Promise<AutomationProjectReading> {
    await this.#write(project, (definitions) => definitions.filter((each) => each.id !== id))
    this.#deps.store.setLocal(project, id, { ...this.#deps.store.local(project, id), enabled: false })
    return this.#changed(project)
  }

  /**
   * On or off. On approves the definition as it stands now and clears a pause: at once the first time, and after an
   * earlier approval only with `approve`, the fingerprint of what the file says now, given once the person saw what
   * changed since. Off passes over what was queued.
   */
  async setEnabled(project: string, id: string, enabled: boolean, approveAs?: string): Promise<AutomationProjectReading> {
    await this.start()
    const definition = await this.#definition(project, id)
    if (!definition) throw new Error(`No automation here has the id ${id}.`)
    const store = this.#deps.store
    const local = this.#local(project, definition)
    const fingerprint = automationFingerprint(definition)
    // Every approval, the first included, is of the definition the person was shown: its fingerprint, given back.
    if (enabled && !isApproved(local, fingerprint) && approveAs !== fingerprint)
      throw new Error(local.approvedDefinition === undefined ? `${definition.name} hasn't been approved: review all it says, then turn it on.` : `${definition.name} changed since you approved it. Review what changed, then turn it on.`)
    const now = this.#now()
    if (!enabled) this.#dropQueued(project, id, "It was turned off before its turn.")
    store.setLocal(project, id, enabled
      ? { ...approve(local, definition), enabled: true, paused: undefined, failures: 0, enabledAt: now, scheduledThrough: now, nextRunAt: this.#nextRun(definition, now) }
      : { ...local, enabled: false, nextRunAt: undefined })
    hostLog("automations", enabled ? "turned on" : "turned off", { automation: id })
    return this.#changed(project)
  }

  /**
   * Run now: the person's press, or an agent's `run_now`, under its caller's key. Only the approved definition runs: an
   * agent's run of one the file changed since (or never approved) is refused, and the person's runs it only with
   * `approve`, the fingerprint of what the file says now, given once they saw what changed, which approves it too.
   */
  async runNow(project: string, id: string, clientKey: string, cause: AutomationCause = { kind: "person" }, approveAs?: string): Promise<AutomationRunNowResult> {
    await this.start()
    const definition = await this.#definition(project, id)
    if (!definition) return { refused: `No automation in ${project} has the id ${id}.` }
    const local = this.#local(project, definition)
    const fingerprint = automationFingerprint(definition)
    if (!isApproved(local, fingerprint)) {
      const never = approvedDefinitionOf(local) === undefined
      if (cause.kind !== "person") return { refused: `${definition.name} runs only as the person approved it, and its definition ${never ? "was never approved" : "changed since they did"}. Ask them to review it in Automations.` }
      if (approveAs !== fingerprint) return { refused: `${definition.name} ${never ? "hasn't been approved yet" : "changed since you approved it"}: review it, then run it.` }
      this.#deps.store.setLocal(project, id, { ...approve(local, definition), ...(local.paused?.kind === "changed" && { paused: undefined }) })
      await this.#changed(project)
    }
    const occurrence = `now-${createHash("sha256").update(clientKey).digest("hex").slice(0, 16)}`
    return { run: await this.fire(project, definition, cause, occurrence) }
  }

  async #write(project: string, change: (definitions: AutomationDefinition[]) => AutomationDefinition[]): Promise<void> {
    const file = await this.#file(project)
    if (file.error && file.exists) throw new Error(`${file.error} Fix it before changing its automations here.`)
    await writeAutomationFile(project, change(file.definitions), file.kept)
    this.#files.delete(project)
  }

  async #changed(project: string): Promise<AutomationProjectReading> {
    await this.#deps.store.save()
    const reading = await this.reading(project)
    this.#deps.emit({ type: "automations-changed", reading })
    this.#deps.changed?.(project)
    return reading
  }

  /* ---------------------------------------------------------------- firing */

  /** One change at a time per automation. */
  #inTurn<T>(project: string, id: string, work: () => Promise<T>): Promise<T> {
    const key = `${project}\0${id}`
    const run = (this.#turns.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.#turns.set(key, run)
    void run.finally(() => {
      if (this.#turns.get(key) === run) this.#turns.delete(key)
    }).catch(() => undefined)
    return run
  }

  /**
   * One occurrence of an automation: its record, or the record a repeat of it already has. Whether it's on is the
   * caller's to check: Run now runs one that's off.
   */
  fire(project: string, definition: AutomationDefinition, cause: AutomationCause, occurrence: string, offer?: AutomationOffer): Promise<AutomationRun> {
    return this.#inTurn(project, definition.id, () => this.#fire(project, definition, cause, occurrence, offer))
  }

  /**
   * An occurrence the cloud account offered this Mac (its Mac is linked): held to the same daily cap, overlap and gate
   * as one of its own, then claimed and run here; one it won't run is declined, saying why, and the account records it.
   * One this Mac already decided (its own scheduler reached the slot first) is that decision.
   */
  async offered(project: string, cloudRun: CloudRun): Promise<AutomationRun | undefined> {
    await this.start()
    const claims = this.#deps.claims?.()
    const definition = await this.#definition(project, cloudRun.automation)
    const local = this.#deps.store.local(project, cloudRun.automation)
    const cause: AutomationCause = cloudRun.cause
    const asRun: AutomationRun = { occurrence: cloudRun.occurrence, automation: cloudRun.automation, project, clientKey: cloudRun.clientKey, cause, status: "skipped", at: this.#now() }
    if (!definition || !local.enabled || local.paused || !isApproved(local, automationFingerprint(definition))) {
      await claims?.decline(project, asRun, !definition ? "It isn't in the project's file on its Mac now." : !local.enabled ? "It's off on its Mac now." : local.paused ? "It's paused on its Mac." : "Its definition isn't one the person approved on its Mac.").catch(() => undefined)
      return undefined
    }
    return this.fire(project, definition, cause, cloudRun.occurrence, { event: cloudRun.event })
  }

  async #fire(project: string, definition: AutomationDefinition, cause: AutomationCause, occurrence: string, offer?: AutomationOffer): Promise<AutomationRun> {
    const store = this.#deps.store
    const id = definition.id
    const kept = store.run(project, id, occurrence)
    // A repeat is the same run; only one that certainly started nothing is tried again when asked again by hand.
    // The cloud's record of one queued for this Mac while it was away isn't a decision here: offered, it runs.
    const queuedForMac = kept?.cloud !== undefined && kept.status === "queued" && offer !== undefined
    if (kept && !queuedForMac && !(kept.status === "failed-to-start" && (cause.kind === "person" || cause.kind === "agent"))) {
      // The cloud offers what this Mac already passed over: it hears why, and records it so.
      if (offer && !kept.cloud && !COVERED.has(kept.status) && kept.status !== "fired") await this.#decline(project, kept, kept.why ?? `It was ${kept.status} on its Mac.`)
      return kept
    }
    const now = this.#now()
    const base: AutomationRun = { occurrence, automation: id, project, clientKey: automationClientKey(id, occurrence), cause, status: "fired", at: now, approved: automationFingerprint(definition) }
    const runs = store.runs(project, id)
    const limit = definition.limits.maxRunsPerDay
    if (limit !== undefined && runs.filter((run) => COUNTED.has(run.status) && run.at > now - DAY_MS).length >= limit)
      return this.#passOver(offer, { ...base, status: "skipped", why: `It started ${limit} run${limit === 1 ? "" : "s"} in the last 24 hours, its limit.` })
    const active = runs.find((run) => run.status === "fired" && !run.cloud)
    if (active) {
      const queued = runs.filter((run) => run.status === "queued" && !run.cloud).length
      if (definition.limits.overlap === "queue" && queued < AUTOMATION_QUEUE_LIMIT) {
        // Offered, it's claimed now and waits here; its own, it's claimed when its turn comes (`#admit`).
        if (offer) {
          const held = await this.#claim(project, definition, base)
          if (held) return held
        }
        return this.#record({ ...base, status: "queued", why: `It starts once run ${active.occurrence} ends.` })
      }
      return this.#passOver(offer, { ...base, status: "skipped", mergedInto: active.occurrence, why: `Run ${active.occurrence} was still going.` })
    }
    return this.#admit(project, definition, base, offer)
  }

  /** A run this Mac won't start: recorded, and if the cloud offered it, declined with the same words. */
  async #passOver(offer: AutomationOffer | undefined, run: AutomationRun): Promise<AutomationRun> {
    const recorded = await this.#record(run)
    if (offer) await this.#decline(run.project, run, run.why ?? `It was ${run.status} on its Mac.`)
    return recorded
  }

  async #decline(project: string, run: AutomationRun, why: string): Promise<void> {
    await this.#deps.claims?.()?.decline(project, run, why).catch((error: Error) => hostWarn("automations", "an offered run couldn't be declined; the cloud's offer runs out instead", { automation: run.automation, occurrence: run.occurrence, error: error.message }))
  }

  /** Whether the cloud also holds this occurrence: a schedule's slot or an event, of an automation registered there. */
  #claimable(project: string, definition: AutomationDefinition, cause: AutomationCause): boolean {
    return this.#deps.store.local(project, definition.id).cloudRegistered === true && (cause.kind === "schedule" || cause.kind === "event")
  }

  /**
   * Asks the cloud for an occurrence it also holds before this Mac runs it. Undefined: this Mac's to run. Otherwise
   * what stands instead: the cloud's run (recorded as this Mac keeps it), or, not asked, an unrecorded skip, so the
   * occurrence stays open for the cloud's own offer.
   */
  async #claim(project: string, definition: AutomationDefinition, run: AutomationRun): Promise<AutomationRun | undefined> {
    if (!this.#claimable(project, definition, run.cause)) return undefined
    const claims = this.#deps.claims?.()
    if (!claims) return { ...run, status: "skipped", why: "This Mac isn't signed in to the cloud account it registered this automation with, so it can't claim this run." }
    const answer = await claims.claim(project, run).catch((error: Error) => ({ unreachable: error.message }))
    if ("claimed" in answer) return undefined
    if ("unreachable" in answer) {
      hostWarn("automations", "a run the cloud also holds wasn't claimed, so it doesn't start here", { automation: run.automation, occurrence: run.occurrence, why: answer.unreachable })
      return { ...run, status: "skipped", why: `The cloud couldn't be asked whether it runs this, so this Mac didn't: ${answer.unreachable}` }
    }
    hostLog("automations", "a run the cloud holds", { automation: run.automation, occurrence: run.occurrence, status: answer.held.status, place: answer.held.place ?? "" })
    return this.#record(claims.record(project, answer.held))
  }

  /** The gate, the condition, the record, then the Thread. */
  async #admit(project: string, definition: AutomationDefinition, base: AutomationRun, offer?: AutomationOffer): Promise<AutomationRun> {
    const store = this.#deps.store
    const id = definition.id
    let gate: AutomationRun["gate"]
    if (definition.gate) {
      const outcome = await this.#deps.runGate(project, definition.gate.command, definition.gate.timeoutS * 1000)
      if ("error" in outcome) {
        // A command killed by a signal says so with everything it printed: only its last words are the reason.
        const error = outcome.error.trim().split("\n").slice(-3).join(" ").slice(-600)
        if (offer) await this.#decline(project, base, `Its gate couldn't run on its Mac: ${error}`)
        return this.#failedToStart({ ...base }, `Its gate couldn't run: ${error}`)
      }
      if (outcome.exit === 1) return this.#passOver(offer, { ...base, status: "gate-skipped", why: "Its gate found nothing to do (exit 1)." })
      if (outcome.exit !== 0) {
        const why = `Its gate failed with exit ${outcome.exit}${outcome.stderr.trim() ? `: ${outcome.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 600)}` : ""}.`
        if (offer) await this.#decline(project, base, why)
        return this.#failedToStart({ ...base }, why)
      }
      gate = gateContext(outcome.stdout)
      const key = gate?.key
      const covered = key === undefined ? undefined : store.runs(project, id).find((run) => run.gate?.key === key && COVERED.has(run.status))
      if (covered) return this.#passOver(offer, { ...base, status: "gate-skipped", gate, why: `It already ran for ${key} (run ${covered.occurrence}).` })
    }
    const trigger = triggerOf(definition, base.cause)
    const condition = trigger && "runWhen" in trigger ? trigger.runWhen : undefined
    if (condition && (base.cause.kind === "schedule" || base.cause.kind === "commit")) {
      const judged = this.#deps.runWhen
        ? await this.#deps.runWhen.judge({ condition, event: eventWords(definition, base.cause, gate) }).catch((error: Error) => ({ unavailable: error.message }))
        : { unavailable: "This Mac has no model to check it with." }
      if ("unavailable" in judged) return this.#record({ ...base, status: "skipped", ...(gate && { gate }), why: `Its condition couldn't be checked, so it didn't run: ${judged.unavailable} Connect an API key in Settings › Git for a model to check it.` })
      const runWhen = { verdict: judged.run ? "run" as const : "skip" as const, reason: judged.why.slice(0, 400), ...(judged.model && { model: judged.model.slice(0, 80) }) }
      if (!judged.run) return this.#record({ ...base, status: "skipped", ...(gate && { gate }), runWhen, why: runWhen.reason })
      return this.#claimThenLaunch(project, definition, { ...base, ...(gate && { gate }), runWhen }, offer)
    }
    return this.#claimThenLaunch(project, definition, { ...base, ...(gate && { gate }) }, offer)
  }

  async #claimThenLaunch(project: string, definition: AutomationDefinition, run: AutomationRun, offer?: AutomationOffer): Promise<AutomationRun> {
    const held = await this.#claim(project, definition, run)
    if (held) return held
    return this.#launch(project, definition, run, offer)
  }

  async #launch(project: string, definition: AutomationDefinition, base: AutomationRun, offer?: AutomationOffer): Promise<AutomationRun> {
    const now = this.#now()
    const standing = definition.thread === "standing"
    const conversationId = automationUuid(standing ? `${project}\0${definition.id}\0standing` : `${project}\0${base.clientKey}`)
    const requestId = automationUuid(`${project}\0${base.clientKey}\0prompt`)
    const template = definition.start.workspace?.branch
    const timezone = definition.triggers.find((trigger): trigger is ScheduleTrigger => trigger.kind === "schedule")?.timezone
    const branch = template ? branchFor(template, { id: definition.id, occurrence: base.occurrence, at: base.cause.kind === "schedule" ? base.cause.at : now, ...(timezone && { timezone }) }) : undefined
    if (definition.start.place.startsWith("device:")) return this.#failedToStart(base, "A run on another device starts with the cloud slice. Set its place to here or cloud.")
    // Kept before its Thread starts: a host that stops between the two starts the same Thread again (`#recover`).
    const run: AutomationRun = { ...base, status: "fired", startedAt: now, thread: { conversation: conversationId, request: requestId, ...(branch && { branch }), ...(definition.start.place !== "here" && { place: definition.start.place }) } }
    await this.#record(run)
    return this.#startThread(project, definition, run, offer)
  }

  async #startThread(project: string, definition: AutomationDefinition, run: AutomationRun, offer?: AutomationOffer): Promise<AutomationRun> {
    const thread = run.thread!
    try {
      const fenced = await fencedText(run, offer)
      const started = await this.#deps.startThread({
        project,
        definition,
        run,
        conversationId: thread.conversation,
        requestId: thread.request,
        text: fenced ? `${runText(definition, run)}\n\n---\n\n${fenced}` : runText(definition, run),
        ...(thread.branch && { branch: thread.branch }),
        standing: definition.thread === "standing",
      })
      hostLog("automations", "run started", { automation: definition.id, occurrence: run.occurrence, conversation: thread.conversation })
      const now = this.#deps.store.run(project, definition.id, run.occurrence) ?? run
      if (now.status !== "fired" || (!started.thread && !started.place && !started.conversation)) return now
      return this.#record({ ...now, thread: { ...thread, ...(started.conversation && { conversation: started.conversation }), ...(started.thread && { thread: started.thread }), ...(started.place && { place: started.place }) } })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      if (error instanceof AutomationNotStartedError) return this.#failedToStart(run, `Its Thread didn't start: ${why}`)
      // Something may have started: the run stays fired, and its timeout or its Thread's end settles it.
      hostWarn("automations", "a run's start failed after it may have begun", { automation: definition.id, occurrence: run.occurrence, error: why })
      return run
    }
  }

  async #record(run: AutomationRun): Promise<AutomationRun> {
    this.#deps.store.putRun(run)
    await this.#deps.store.save()
    this.#deps.emit({ type: "automation-run", run })
    if (run.status !== "fired") hostLog("automations", "run recorded", { automation: run.automation, occurrence: run.occurrence, status: run.status, ...(run.why && { why: run.why.slice(0, 200) }) })
    return run
  }

  async #failedToStart(run: AutomationRun, said: string): Promise<AutomationRun> {
    const why = said.slice(0, 2000)
    const kept = await this.#record({ ...run, status: "failed-to-start", why, endedAt: this.#now() })
    await this.#failed(run.project, run.automation, why.slice(0, 400))
    return kept
  }

  /** One more failure in a row; the third pauses it. */
  async #failed(project: string, id: string, why: string): Promise<void> {
    const store = this.#deps.store
    const local = store.local(project, id)
    const failures = local.failures + 1
    const paused = local.enabled && failures >= AUTOMATION_PAUSE_AFTER_FAILURES
      ? { kind: "failures" as const, reason: `Paused after ${failures} failed runs in a row. The last: ${why}`.slice(0, 1000), at: this.#now() }
      : local.paused
    store.setLocal(project, id, { ...local, failures, ...(paused && { paused }) })
    if (paused && !local.paused) {
      hostWarn("automations", "paused after failures", { automation: id, failures })
      this.#dropQueued(project, id, "It was paused before its turn.")
    }
    await this.#changed(project)
  }

  /* ---------------------------------------------------------------- runs ending */

  /** A conversation's turn ended: the run it is settles with what it said. */
  async turnEnded(conversation: string): Promise<void> {
    const run = this.#deps.store.runOf(conversation)
    if (!run) return
    await this.#settle(run)
  }

  async #settle(run: AutomationRun): Promise<void> {
    const reading = this.#deps.threadOf(run.thread!.conversation, run.thread!.request)
    if (reading.state !== "ended") return
    await this.#inTurn(run.project, run.automation, async () => {
      const now = this.#deps.store.run(run.project, run.automation, run.occurrence)
      if (now?.status !== "fired") return
      const failed = reading.status === "failed"
      await this.#record({ ...now, status: failed ? "failed" : "completed", endedAt: this.#now(), result: { status: reading.status, summary: reading.summary.slice(0, 4000), ...pullRequestOf(reading.summary) }, ...(failed && { why: reading.summary.split("\n")[0]?.slice(0, 400) }) })
      if (failed) await this.#failed(run.project, run.automation, reading.summary.split("\n")[0]?.slice(0, 400) ?? "its Thread failed")
      else {
        const store = this.#deps.store
        const local = store.local(run.project, run.automation)
        if (local.failures) store.setLocal(run.project, run.automation, { ...local, failures: 0 })
        await this.#changed(run.project)
      }
    })
    await this.#dequeue(run.project, run.automation)
  }

  /**
   * The oldest queued run starts once nothing else of its automation runs: from the definition approved when it was
   * queued, and only while that is still the approved one and the automation is on and unpaused (a person's Run now runs
   * on one that's off). Anything else passes it over, saying why; the file as it reads by then never runs.
   */
  async #dequeue(project: string, id: string): Promise<void> {
    await this.#inTurn(project, id, async () => {
      const store = this.#deps.store
      const runs = store.runs(project, id)
      if (runs.some((run) => run.status === "fired")) return
      // The cloud's queued records are its own to offer, never this Mac's queue.
      const next = runs.filter((run) => run.status === "queued" && !run.cloud).at(-1)
      if (!next) return
      const local = store.local(project, id)
      const approved = this.#approvedDefinition(local)
      const why = !approved || next.approved !== local.approved ? "Its definition changed after it was queued, so it didn't run."
        : local.paused ? "It was paused before its turn."
        : !local.enabled && next.cause.kind !== "person" ? "It was turned off before its turn."
        : undefined
      if (why || !approved) {
        await this.#record({ ...next, status: "skipped", why: why ?? "", endedAt: this.#now() })
        return
      }
      await this.#admit(project, approved, { ...next, status: "fired", at: this.#now() })
    })
  }

  /* ---------------------------------------------------------------- the tick */

  /** What's due, across every project: schedules, commits, runs past their time, proposals past theirs. */
  async tick(now = this.#now()): Promise<void> {
    await this.start()
    for (const project of this.projects()) {
      try {
        await this.#tickProject(project, now)
      } catch (error) {
        hostWarn("automations", "a project's automations couldn't be checked", { project, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await this.#watchRuns(now)
    await this.#expireProposals(now)
  }

  async #tickProject(project: string, now: number): Promise<void> {
    const file = await this.#file(project)
    const store = this.#deps.store
    for (const definition of file.definitions) {
      const local = this.#local(project, definition)
      if (!local.enabled || local.paused) continue
      if (!isApproved(local, automationFingerprint(definition))) {
        store.setLocal(project, definition.id, { ...local, paused: { kind: "changed", reason: CHANGED_REASON, at: now } })
        this.#dropQueued(project, definition.id, "Its definition changed before its turn.")
        hostWarn("automations", "paused: its definition changed since it was turned on", { automation: definition.id })
        await this.#changed(project)
        continue
      }
      await this.#schedule(project, definition, local, now)
      if (definition.triggers.some((trigger) => trigger.kind === "commit")) await this.noticeHead(project, undefined, definition)
    }
  }

  /** Fires the latest slot due since the last tick: late (asleep, closed) within the grace window, once. */
  async #schedule(project: string, definition: AutomationDefinition, local: AutomationLocal, now: number): Promise<void> {
    const schedules = definition.triggers.filter((trigger): trigger is ScheduleTrigger => trigger.kind === "schedule")
    if (!schedules.length) return
    const store = this.#deps.store
    const through = Math.max(local.scheduledThrough ?? local.enabledAt ?? now, local.enabledAt ?? 0)
    const graceStart = Math.max(through, now - AUTOMATION_CATCH_UP_GRACE_MS)
    let latest: number | undefined
    for (const trigger of schedules) {
      const parsed = parseCron(trigger.cron)
      if (!parsed.ok) continue
      const slot = lastCronAtOrBefore(parsed.spec, trigger.timezone, graceStart, now)
      if (slot !== undefined && (latest === undefined || slot > latest)) latest = slot
    }
    // A slot missed past the grace window is said once, never run.
    const missedOld = through < graceStart && schedules.some((trigger) => {
      const parsed = parseCron(trigger.cron)
      const slot = parsed.ok ? nextCron(parsed.spec, trigger.timezone, through) : undefined
      return slot !== undefined && slot <= graceStart
    })
    const nextRunAt = this.#nextRun(definition, now)
    store.setLocal(project, definition.id, { ...local, scheduledThrough: now, ...(nextRunAt !== undefined ? { nextRunAt } : { nextRunAt: undefined }) })
    await store.save()
    if (latest === undefined) {
      if (missedOld) hostLog("automations", "schedule missed past its grace window; not run", { automation: definition.id })
      return
    }
    const late = now - latest > 2 * 60_000
    await this.fire(project, definition, { kind: "schedule", at: latest, ...(late && { catchUp: true }) }, slotName(latest))
  }

  #nextRun(definition: AutomationDefinition, after: number): number | undefined {
    let next: number | undefined
    for (const trigger of definition.triggers) {
      if (trigger.kind !== "schedule") continue
      const parsed = parseCron(trigger.cron)
      const at = parsed.ok ? nextCron(parsed.spec, trigger.timezone, after) : undefined
      if (at !== undefined && (next === undefined || at < next)) next = at
    }
    return next
  }

  /**
   * HEAD moved in `project`: each automation on with a commit trigger runs for the new commit. The first HEAD seen is
   * only remembered. `head` comes from the git status a window already reads; undefined reads it here.
   */
  async noticeHead(project: string, head?: string, only?: AutomationDefinition): Promise<void> {
    const store = this.#deps.store
    const definitions = only ? [only] : (await this.#file(project)).definitions.filter((definition) => definition.triggers.some((trigger) => trigger.kind === "commit"))
    const enabled = definitions.filter((definition) => {
      const local = store.local(project, definition.id)
      return local.enabled && !local.paused && isApproved(local, automationFingerprint(definition))
    })
    if (!enabled.length) return
    const read = await this.#deps.head(project).catch(() => undefined)
    const current = head ?? read?.head
    if (!current) return
    for (const definition of enabled) {
      const local = store.local(project, definition.id)
      if (local.head === current) continue
      store.setLocal(project, definition.id, { ...local, head: current })
      await store.save()
      if (local.head === undefined) continue
      const trigger = definition.triggers.find((each): each is Extract<AutomationTrigger, { kind: "commit" }> => each.kind === "commit")
      if (trigger?.branch && read?.branch !== trigger.branch) continue
      await this.fire(project, definition, { kind: "commit", head: current, ...(read?.subject && { subject: read.subject.slice(0, 400) }) }, `commit-${current.slice(0, 40)}`)
    }
  }

  /** Runs whose Thread ended unheard, or ran past their time. */
  async #watchRuns(now: number): Promise<void> {
    for (const run of this.#deps.store.active()) {
      // A run the cloud holds settles by the cloud's record of it (`recordCloud`), never by this Mac's clock.
      if (run.status !== "fired" || !run.thread || run.cloud) continue
      const reading = this.#deps.threadOf(run.thread.conversation, run.thread.request)
      if (reading.state === "ended") {
        await this.#settle(run)
        continue
      }
      const definition = await this.#definition(run.project, run.automation)
      const timeoutMs = (definition?.limits.timeoutMin ?? 60) * 60_000
      if (now - (run.startedAt ?? run.at) < timeoutMs) continue
      await this.#deps.stopThread(run.thread.conversation).catch((error: Error) => hostWarn("automations", "a run past its time couldn't be stopped", { conversation: run.thread?.conversation, error: error.message }))
      const why = `Stopped after ${Math.round(timeoutMs / 60_000)} minutes, its limit.`
      await this.#inTurn(run.project, run.automation, async () => {
        const current = this.#deps.store.run(run.project, run.automation, run.occurrence)
        if (current?.status !== "fired") return
        await this.#record({ ...current, status: "failed", endedAt: now, why, result: { status: "failed", summary: why } })
        await this.#failed(run.project, run.automation, why)
      })
      await this.#dequeue(run.project, run.automation)
    }
  }

  /**
   * What a stopped host or an older build left: a fired run whose Thread may not have started starts it again under
   * the same conversation (a repeat finds it), and an older build's approved launches are recorded as runs.
   */
  async #recover(): Promise<void> {
    await this.#readLegacyLaunches()
    for (const run of this.#deps.store.active()) {
      if (run.status !== "fired" || !run.thread || run.cloud || this.#deps.threadOf(run.thread.conversation, run.thread.request).state !== "unknown") continue
      if (run.thread.place && run.thread.place !== "here") continue
      // Only a start a stopped host may have cut: an older one settles by its Thread's end or its timeout.
      if (this.#now() - (run.startedAt ?? run.at) > RECOVER_WITHIN_MS) continue
      // Started again only from the definition it was started with, while that is still the approved one; the file as
      // it reads now never runs.
      const local = this.#deps.store.local(run.project, run.automation)
      const definition = this.#approvedDefinition(local)
      if (!definition || run.approved !== local.approved || local.paused) {
        hostWarn("automations", "a cut-short run wasn't started again: its definition isn't the approved one now", { automation: run.automation, occurrence: run.occurrence })
        continue
      }
      void this.#startThread(run.project, definition, run).catch(() => undefined)
    }
  }

  /** `<dataRoot>/automation-launches/*.json`: each receipt an older build kept, as a run, so its approval never runs twice. */
  async #readLegacyLaunches(): Promise<void> {
    const folder = this.#deps.legacyLaunches
    if (!folder) return
    const names = await readdir(folder).catch((): string[] => [])
    let read = 0
    for (const name of names.filter((each) => each.endsWith(".json"))) {
      const receipt = LegacyReceiptSchema.safeParse(await readFile(join(folder, name), "utf8").then((text) => JSON.parse(text), () => undefined)).data
      if (!receipt || receipt.result.status === "not-run") continue
      const occurrence = `legacy-${name.slice(0, 16)}`
      if (this.#deps.store.run(receipt.cwd, receipt.id, occurrence)) continue
      this.#deps.store.putRun({
        occurrence, automation: legacyIdOf(receipt.id), project: receipt.cwd, clientKey: automationClientKey(legacyIdOf(receipt.id), occurrence), cause: { kind: "person" },
        status: receipt.result.status === "completed" ? "completed" : "failed", at: this.#now(),
        why: receipt.result.status === "completed" ? "Started by an older Mako." : "An older Mako couldn't confirm whether this run started. Check its Threads.",
      })
      read += 1
    }
    if (read) {
      await this.#deps.store.save()
      hostLog("automations", "older approved launches recorded as runs", { read })
    }
  }

  /** Whether an older build already launched the approved run `operation` names: its receipt, by the hash it was kept under. */
  async legacyLaunched(operation: string): Promise<boolean> {
    const folder = this.#deps.legacyLaunches
    if (!folder) return false
    const text = await readFile(join(folder, `${createHash("sha256").update(operation).digest("hex")}.json`), "utf8").catch(() => undefined)
    const receipt = text === undefined ? undefined : LegacyReceiptSchema.safeParse(JSON.parse(text)).data
    return receipt !== undefined && receipt.result.status !== "not-run"
  }

  /* ---------------------------------------------------------------- proposals */

  /**
   * An agent's create, update, delete or enable: saved pending, carried to the person by an ask in the agent's Thread,
   * and answered at once. A repeat of the same call (`clientKey`) is the same proposal.
   */
  async propose(by: AutomationProposer, input: { project: string; change: AutomationChange; id?: string; definition?: JsonValue; why?: string; clientKey: string }): Promise<AutomationProposal | { refused: "no-automation" | "invalid"; why: string }> {
    await this.start()
    const proposalId = automationUuid(`proposal\0${by.conversation}\0${input.clientKey}`)
    const kept = this.#deps.store.proposal(proposalId)
    if (kept) return kept
    const { project, change } = input
    const given = input.definition === undefined ? undefined : JsonObjectSchema.safeParse(input.definition).data
    if (input.definition !== undefined && !given) return { refused: "invalid", why: "definition is an object: {id, name, prompt, start, triggers, gate, limits, result}." }
    const id = input.id ?? IdTextSchema.safeParse(given?.id).data
    if (!id) return { refused: "invalid", why: "Name the automation: id, or definition.id for create." }
    const current = await this.#definition(project, id)
    let after: AutomationDefinition | undefined
    if (change === "create" || change === "update") {
      if (change === "create" && current) return { refused: "invalid", why: `${id} exists already: propose an update to it.` }
      if (change === "update" && !current) return { refused: "no-automation", why: `No automation in ${project} has the id ${id}: list gives each one's id.` }
      const merged = { ...(current && JsonObjectSchema.parse(JsonSchema.parse(JSON.parse(JSON.stringify(current))))), ...given, id }
      const parsed = AutomationDefinitionSchema.safeParse(merged)
      if (!parsed.success) return { refused: "invalid", why: parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "definition"}: ${issue.message}`).join("; ") }
      after = parsed.data
      if (current && automationFingerprint(current) === automationFingerprint(after)) return { refused: "invalid", why: "That changes nothing." }
    } else {
      if (!current) return { refused: "no-automation", why: `No automation in ${project} has the id ${id}: list gives each one's id.` }
      const local = this.#local(project, current)
      if (change === "enable" && local.enabled && !local.paused && isApproved(local, automationFingerprint(current))) return { refused: "invalid", why: `${id} is on already.` }
      // Turning it on approves what the file says now: that is what its card shows, against what was approved before.
      if (change === "enable") after = current
    }
    const now = this.#now()
    const name = after?.name ?? current?.name
    // Its card shows the change from what the person approved: an edit the file got before this proposal shows too.
    // Never approved: no `before`, and its card shows all it says, as never approved. A delete shows what it removes.
    const shown = current && change !== "create" ? (this.#approvedDefinition(this.#local(project, current)) ?? (change === "delete" ? current : undefined)) : undefined
    const proposal: AutomationProposal = {
      id: proposalId,
      project,
      automation: id,
      change,
      ...(shown && { before: definitionJson(shown) }),
      ...(after && { after: definitionJson(after) }),
      ...(current && { base: automationFingerprint(current) }),
      ...(input.why?.trim() && { why: input.why.trim().slice(0, 2000) }),
      by,
      at: now,
      expiresAt: now + AUTOMATION_PROPOSAL_TTL_MS,
      status: "pending",
    }
    proposal.ask = this.#deps.asks.raise(by.conversation, { kind: "automation-proposal", proposal: proposalId, change, id, ...(name && { name: name.slice(0, 120) }), cwd: project })
    this.#deps.store.putProposal(proposal)
    hostLog("automations", "proposal made", { proposal: proposalId, change, automation: id })
    await this.#changed(project)
    return proposal
  }

  proposal(id: string): AutomationProposal | undefined {
    return this.#deps.store.proposal(id)
  }

  /**
   * The person's decision, from the ask's card (`via: "ask"`, which settles that ask itself) or the Automations view.
   * Approving applies it, unless the automation changed since it was proposed (`stale`). Its agent hears either way.
   */
  async decide(id: string, approve: boolean, via: "ask" | "view" = "view"): Promise<AutomationProposal> {
    await this.start()
    const proposal = this.#deps.store.proposal(id)
    if (!proposal) throw new Error("Mako has no such proposal.")
    if (proposal.status !== "pending") return proposal
    const now = this.#now()
    if (this.#deps.relaysProposals) {
      // Decided in the cloud Thread: the person's Mac applies it, and its agent hears once the Mac says how it went.
      const relayed: AutomationProposal = { ...proposal, status: approve ? "approved" : "declined", decidedAt: now, relay: "awaiting" }
      if (via === "view" && proposal.ask) this.#deps.asks.settle(proposal.by.conversation, proposal.ask)
      this.#deps.store.putProposal(relayed)
      hostLog("automations", "proposal decided; its Mac applies it", { proposal: id, status: relayed.status })
      await this.#changed(proposal.project)
      return relayed
    }
    let decided: AutomationProposal = { ...proposal, status: approve ? "approved" : "declined", decidedAt: now }
    if (approve) {
      const current = await this.#definition(proposal.project, proposal.automation)
      const before = proposal.before === undefined ? undefined : AutomationDefinitionSchema.safeParse(proposal.before).data
      // What the file held when proposed: its `base`, or for an older proposal the definition it showed.
      const base = proposal.base ?? (before && automationFingerprint(before))
      const stale = proposal.change === "create" ? current !== undefined : !current || base === undefined || automationFingerprint(current) !== base
      const staleNote = "The automation changed after this was proposed, so approving it would undo that change. Nothing was applied."
      if (stale) decided = { ...decided, status: "stale", note: staleNote }
      else {
        // Bound to what its card showed: a file that changes between this check and the apply is refused there (an
        // enable approves only the definition the card showed, by its fingerprint), and the proposal goes stale.
        try {
          await this.#apply(proposal)
        } catch (error) {
          hostWarn("automations", "an approved proposal wasn't applied: its automation changed as it was", { proposal: id, error: error instanceof Error ? error.message : String(error) })
          decided = { ...decided, status: "stale", note: staleNote }
        }
      }
    }
    if (via === "view" && proposal.ask) this.#deps.asks.settle(proposal.by.conversation, proposal.ask)
    this.#deps.store.putProposal(decided)
    hostLog("automations", "proposal decided", { proposal: id, status: decided.status })
    await this.#changed(proposal.project)
    await this.#tell(decided)
    return this.#deps.store.proposal(id) ?? decided
  }

  async #apply(proposal: AutomationProposal): Promise<void> {
    const { project, automation } = proposal
    if (proposal.change === "delete") {
      await this.remove(project, automation)
      return
    }
    if (proposal.change === "enable") {
      // What they approved is the definition the card showed, which the stale check holds the file to.
      const shown = AutomationDefinitionSchema.parse(proposal.after)
      await this.setEnabled(project, automation, true, automationFingerprint(shown))
      return
    }
    const after = AutomationDefinitionSchema.parse(proposal.after)
    await this.#write(project, (definitions) => {
      const at = definitions.findIndex((each) => each.id === automation)
      return at < 0 ? [...definitions, after] : definitions.map((each) => (each.id === automation ? after : each))
    })
    // A create or update the person approved is the definition they approved, on or off: its card showed all of it, or
    // its change from what they'd approved. One that's on stays on with it.
    const local = this.#deps.store.local(project, automation)
    this.#deps.store.setLocal(project, automation, { ...approve(local, after), ...(local.enabled && { nextRunAt: this.#nextRun(after, this.#now()) }) })
  }

  async #expireProposals(now: number): Promise<void> {
    for (const proposal of this.#deps.store.proposals()) {
      if (proposal.status === "pending" && proposal.expiresAt <= now) {
        const expired: AutomationProposal = { ...proposal, status: "expired", decidedAt: now }
        if (proposal.ask) this.#deps.asks.settle(proposal.by.conversation, proposal.ask)
        this.#deps.store.putProposal(expired)
        await this.#changed(proposal.project)
        await this.#tell(expired)
      } else if (proposal.status !== "pending" && proposal.told === false) await this.#tell(proposal)
    }
  }

  /** Its agent hears the decision as Mako's note, once: a note that couldn't go is tried again at the next tick. */
  async #tell(proposal: AutomationProposal): Promise<void> {
    const text = decisionNote(proposal)
    try {
      if (proposal.from) {
        // Its agent is in a cloud Thread: that Thread's host hears how it went, and tells it.
        const forward = this.#deps.forward?.()
        if (!forward) throw new Error("this Mac can't reach the cloud Thread that proposed it now")
        if (proposal.status === "pending") return
        await forward.settle(proposal.from.thread, proposal.id, { status: proposal.status, ...(proposal.note && { note: proposal.note }) })
      } else await this.#deps.tell(proposal.by.conversation, automationUuid(`proposal\0${proposal.id}\0decided`), text)
      this.#deps.store.putProposal({ ...proposal, told: true })
    } catch (error) {
      hostWarn("automations", "a proposal's agent couldn't be told", { proposal: proposal.id, error: error instanceof Error ? error.message : String(error) })
      this.#deps.store.putProposal({ ...proposal, told: false })
    }
    await this.#deps.store.save()
  }

  /** A cloud run's start, asked by the account of this cloud Thread's host (`AutomationsDeps.cloudStart`). */
  async cloudStart(launch: JsonValue): Promise<{ harness: string; modeId: string }> {
    const start = this.#deps.cloudStart
    if (!start) throw new Error("This host doesn't start cloud runs.")
    const asked = CloudRunStartSchema.safeParse(launch)
    if (!asked.success) throw new Error(`A cloud run's start isn't one: ${asked.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`)
    return start(asked.data)
  }

  /** On a cloud machine's host: its agents' proposals the person's Mac hasn't settled, pending or decided here. */
  forwarded(): AutomationProposal[] {
    return this.#deps.store.proposals().filter((proposal) => proposal.status === "pending" || proposal.relay === "awaiting")
  }

  /**
   * On a cloud machine's host: how a proposal went on the person's Mac, its agent told once. A repeat (an answer the Mac
   * lost) finds it settled and answers the same.
   */
  async settleForwarded(id: string, outcome: ForwardedOutcome): Promise<AutomationProposal> {
    await this.start()
    const proposal = this.#deps.store.proposal(id)
    if (!proposal) throw new Error("Mako has no such proposal.")
    if (proposal.relay === "settled") return proposal
    if (proposal.ask && proposal.status === "pending") this.#deps.asks.settle(proposal.by.conversation, proposal.ask)
    const settled: AutomationProposal = { ...proposal, status: outcome.status, decidedAt: proposal.decidedAt ?? this.#now(), relay: "settled", ...(outcome.note && { note: outcome.note.slice(0, 1000) }) }
    this.#deps.store.putProposal(settled)
    hostLog("automations", "a proposal settled on its Mac", { proposal: id, status: settled.status })
    await this.#changed(proposal.project)
    await this.#tell(settled)
    return this.#deps.store.proposal(id) ?? settled
  }

  /**
   * On the person's Mac: proposals a cloud run's agent made, read from its cloud Thread's host (`thread`), taken under
   * the run's project here. A pending one waits for the person in Automations, as one of this Mac's; one decided in the
   * cloud Thread's card is applied now; one decided here whose Thread hasn't heard is told again.
   */
  async importForwarded(project: string, thread: string, proposals: readonly AutomationProposal[]): Promise<void> {
    await this.start()
    const store = this.#deps.store
    for (const remote of proposals) {
      const held = store.proposal(remote.id)
      if (held && !held.from) continue
      if (!held) {
        // Only the proposal is the cloud Thread's: its status, decision and note there are its host's word, which its
        // agent could have written itself, so it waits here, pending, for a decision made on this Mac. Its card shows
        // the change from what the person approved here; turning it on approves this Mac's file, as it reads now.
        const current = await this.#definition(project, remote.automation)
        const shown = current && remote.change !== "create" ? (this.#approvedDefinition(this.#local(project, current)) ?? (remote.change === "delete" ? current : undefined)) : undefined
        const after = remote.change === "enable" ? (current && definitionJson(current)) : remote.after
        const base = remote.change === "enable" ? (current && automationFingerprint(current)) : (remote.base ?? baseOf(remote.before))
        store.putProposal({
          id: remote.id, project, automation: remote.automation, change: remote.change,
          ...(shown && { before: definitionJson(shown) }), ...(after !== undefined && { after }), ...(base && { base }), ...(remote.why && { why: remote.why.slice(0, 2000) }),
          by: remote.by, at: this.#now(), expiresAt: this.#now() + AUTOMATION_PROPOSAL_TTL_MS, status: "pending", from: { thread },
        })
        hostLog("automations", "a cloud run's proposal came to this Mac", { proposal: remote.id, change: remote.change, automation: remote.automation })
        await this.#changed(project)
      }
      const now = store.proposal(remote.id)!
      // Decided here and not yet settled there: its cloud Thread hears again.
      if (now.status !== "pending" && remote.relay !== "settled") await this.#tell(now)
    }
  }

  /** The diff a proposal's card shows. */
  static diff(proposal: AutomationProposal): AutomationDiffEntry[] {
    return automationDiff(proposal.before, proposal.after)
  }
}

/** A definition as JSON, as a proposal or an approval keeps it. */
function definitionJson(definition: AutomationDefinition): JsonValue {
  return JsonSchema.parse(JSON.parse(JSON.stringify(definition)))
}

/** The fingerprint of a proposal's `before`, when it reads as a definition. */
function baseOf(before: JsonValue | undefined): string | undefined {
  const definition = AutomationDefinitionSchema.safeParse(before).data
  return definition && automationFingerprint(definition)
}

/** `local` approving `definition`: its fingerprint and the definition itself, and a pause for a change cleared. */
function approve(local: AutomationLocal, definition: AutomationDefinition): AutomationLocal {
  return { ...local, approved: automationFingerprint(definition), approvedDefinition: definitionJson(definition), ...(local.paused?.kind === "changed" && { paused: undefined }) }
}

const CHANGED_REASON = "Its definition changed after you turned it on (a pull, or an edit outside Mako). Turn it on again to run what it says now."
const JsonObjectSchema = z.record(z.string(), z.json())

function legacyIdOf(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80) || "automation"
}

/** A gate's stdout: a JSON object is its context, and its string `key` the dedupe key. */
export function gateContext(stdout: string): AutomationRun["gate"] {
  const text = stdout.trim()
  if (!text) return undefined
  let parsed: JsonObject | undefined
  try {
    parsed = GateContextSchema.safeParse(JSON.parse(text)).data
  } catch {
    parsed = undefined
  }
  if (!parsed) return undefined
  const key = GateKeySchema.safeParse(parsed.key).data?.slice(0, 400)
  // A context too large for a record is kept to its key.
  const fits = JSON.stringify(parsed).length <= 16_000
  return { ...(key && { key }), ...(fits && { context: parsed }) }
}

/** The trigger a cause came by. */
function triggerOf(definition: AutomationDefinition, cause: AutomationCause): AutomationTrigger | undefined {
  if (cause.kind === "schedule") return definition.triggers.find((trigger) => trigger.kind === "schedule")
  if (cause.kind === "commit") return definition.triggers.find((trigger) => trigger.kind === "commit")
  return undefined
}

/** The event as the `runWhen` model reads it. */
function eventWords(definition: AutomationDefinition, cause: AutomationCause, gate: AutomationRun["gate"]): string {
  const what = cause.kind === "schedule" ? `The schedule fired for ${new Date(cause.at).toISOString()}.` : cause.kind === "commit" ? `A commit landed: ${cause.head}${cause.subject ? ` "${cause.subject}"` : ""}.` : cause.kind === "event" ? `${cause.source} ${cause.event}: ${cause.summary}${cause.url ? ` (${cause.url})` : ""}.` : "Run now."
  return [`Automation: ${definition.name}.`, what, ...(gate?.context ? [`What its gate found: ${JSON.stringify(gate.context).slice(0, 6000)}`] : [])].join("\n")
}

/** An offered event's content, fenced as untrusted for its agent, the fence fixed by the event so a repeat is the same text. */
async function eventText(cause: AutomationCause, offer: AutomationOffer | undefined): Promise<string | undefined> {
  if (cause.kind !== "event") return undefined
  // Its summary and address came from outside the account, like its payload: all three only inside the fence.
  const event = { source: cause.source, event: cause.event, summary: cause.summary, ...(cause.url && { url: cause.url }), payload: offer?.event ?? null }
  return untrustedEventText(event, await eventMarker(event))
}

/**
 * Everything a run's agent reads that isn't the person's own words, each fenced as untrusted after the brief: an
 * event (its summary, address and payload), a commit's subject (anyone who lands a commit, a squashed pull request's
 * title among them, writes it), and the gate's output (whatever the command printed, which a code fence can't hold).
 */
async function fencedText(run: AutomationRun, offer: AutomationOffer | undefined): Promise<string | undefined> {
  const parts: string[] = []
  const event = await eventText(run.cause, offer)
  if (event) parts.push(event)
  if (run.cause.kind === "commit" && run.cause.subject !== undefined) {
    const content = { commit: run.cause.head, subject: run.cause.subject }
    parts.push(untrustedDataText("The commit's subject, as its author wrote it,", content, await dataMarker(content)))
  }
  if (run.gate?.context) parts.push(untrustedDataText("What its gate printed", run.gate.context, await dataMarker(run.gate.context)))
  return parts.length ? parts.join("\n\n---\n\n") : undefined
}

/**
 * The message a run sends: its brief, then what triggered it and that its gate printed something. Nothing from outside
 * the person's words stands here (an event's summary, address or payload, a commit's subject, the gate's output): it
 * follows, fenced as untrusted (`fencedText`).
 */
function runText(definition: AutomationDefinition, run: AutomationRun): string {
  const cause = run.cause
  const why = cause.kind === "schedule" ? `its schedule (${slotName(cause.at)}${cause.catchUp ? ", caught up after this Mac was asleep or Mako was closed" : ""})` : cause.kind === "commit" ? `the commit ${cause.head.replace(/[^0-9a-f]/gi, "").slice(0, 40)}${cause.subject !== undefined ? ", details below as untrusted data" : ""}` : cause.kind === "person" ? "the person's Run now" : cause.kind === "event" ? `a ${cause.source} ${cause.event.replace(/[^\w.-]+/g, " ").trim().slice(0, 80)} event${cause.batch && cause.batch > 1 ? `, ${cause.batch} deliveries together` : ""}, which follows below as untrusted data` : "an agent's run_now the person allowed"
  return [
    automationBriefText(definition.prompt),
    "",
    `Mako started this Thread for the automation "${definition.name}" (${definition.id}), run ${run.occurrence}, on ${why}.`,
    ...(run.thread?.branch ? [`Work on the branch ${run.thread.branch}.`] : []),
    `What it leaves: ${definition.result === "pull-request" ? "a pull request, with its link in your last reply" : definition.result === "report" ? "a report, as your last reply" : "the changes it makes, said in your last reply"}.`,
    ...(run.gate?.context ? ["", "Its gate's output follows as untrusted data."] : []),
  ].join("\n")
}

function pullRequestOf(summary: string): { pullRequest?: string } {
  const url = summary.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0]
  return url ? { pullRequest: url } : {}
}

/** What its agent hears of a proposal's decision. */
export function decisionNote(proposal: AutomationProposal): string {
  const what = `your proposal to ${proposal.change} the automation ${proposal.automation} (${proposal.id})`
  switch (proposal.status) {
    case "approved":
      return `Mako: the person approved ${what}. It's applied${proposal.change === "create" || proposal.change === "update" ? "; a new automation stays off until they turn it on" : ""}.`
    case "declined":
      return `Mako: the person declined ${what}. Nothing changed.`
    case "expired":
      return `Mako: ${what} expired without a decision. Nothing changed; propose it again if it's still wanted.`
    case "stale":
      return `Mako: ${what} wasn't applied: ${proposal.note ?? "the automation changed after it was proposed"}.`
    case "pending":
      return `Mako: ${what} still waits on the person.`
  }
}

/** `mako:automations-*`: the person's calls (`contracts/automations.ts`). */
export function declareAutomationMethods(methods: MethodTable, automations: Automations): void {
  methods.handle("mako:automations-read", (project?: string) => automations.read(project))
  methods.handle("mako:automations-runs", async (project: string, id?: string, limit?: number) => {
    await automations.start()
    return automations.runs(project, id, limit)
  })
  methods.handle("mako:automations-save", (project: string, definition: JsonValue, replaces?: string, approve?: string) => automations.save(project, definition, replaces, approve))
  methods.handle("mako:automations-delete", (project: string, id: string) => automations.remove(project, id))
  methods.handle("mako:automations-enabled", (project: string, id: string, enabled: boolean, approve?: string) => automations.setEnabled(project, id, enabled, approve))
  methods.handle("mako:automations-run-now", (project: string, id: string, clientKey: string, approve?: string) => automations.runNow(project, id, clientKey, { kind: "person" }, approve))
  methods.handle("mako:automations-decide", (proposal: string, approve: boolean) => automations.decide(proposal, approve, "view"))
  methods.handle("mako:automations-draft", (conversationId: string) => automations.draft(conversationId))
  methods.handle("mako:automations-templates", () => automations.templates())
  methods.handle("mako:automations-run-of", (conversation: string) => automations.runOf(conversation))
  methods.handle("mako:automations-cloud-start", (launch: JsonValue) => automations.cloudStart(launch))
  methods.handle("mako:automations-forwarded", async () => {
    await automations.start()
    return automations.forwarded()
  })
  methods.handle("mako:automations-forward-settle", (proposal: string, outcome: ForwardedOutcome) => automations.settleForwarded(proposal, ForwardedOutcomeSchema.parse(outcome)))
  methods.handle("mako:automations-hook", (name: string, provider?: AutomationHook["provider"], rotate?: boolean, secret?: string) => automations.hook(name, provider, rotate, secret))
}
