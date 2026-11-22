import { CloudAutomationSchema, type CloudAutomation, type CloudClaim, type CloudHook, type CloudRun, type CloudTrigger } from "@mako/protocol/automations-cloud"
import { hostLog, hostWarn } from "../base/host-log.js"
import { z } from "zod"
import {
  AutomationProposalSchema,
  automationBriefText,
  isApproved,
  automationFingerprint,
  triggerFiresInCloud,
  type AutomationDefinition,
  type AutomationLocal,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationTrigger,
  type ForwardedOutcome,
} from "../contracts/automations.js"
import type { FinTarget } from "../contracts/fin-tuning.js"
import type { JsonValue } from "../contracts/json.js"
import type { AutomationClaims, Automations } from "./automations.js"
import type { AutomationStore } from "./automation-store.js"
import { localWords } from "@mako/protocol/computer-words"

/**
 * This Mac's automations, linked to its Mako account (`@mako/protocol/automations-cloud`):
 *
 *   * Registration. Each automation that's on, approved, and has a trigger the account holds (GitHub, Slack, Linear,
 *     Sentry, a webhook, or a schedule that runs in the cloud or not only while this Mac is up) is registered under its
 *     project's stable key, the GitHub repository and the folder in it, never this Mac's path, so two Macs with the
 *     project hold one registration. Registered, `AutomationLocal.cloudRegistered` turns its cloud triggers live; refused
 *     (409), `cloudIssue` says why. Off, deleted, or changed: taken back, or registered again.
 *   * The runs feed. The account's runs, read on from the last this Mac took (`GET /runs?after=`), each kept as this
 *     Mac's record of it (`Automations.recordCloud`); one offered to this Mac is held to its own cap, overlap and gate,
 *     then claimed and run here, or declined (`Automations.offered`). Read every half minute while anything is
 *     registered, when the account's link opens, and when the account says runs changed.
 *   * Claims. A schedule's slot or an event of a registered automation is claimed before this Mac runs it
 *     (`AutomationClaims`), so of the Mac and the cloud only one ever does.
 *   * What the account stopped firing. A GitHub trigger whose repository its person can no longer read is found out in
 *     the cloud, as its event arrives: the account says so (`issues`), read with the feed when a run was skipped and
 *     every few minutes besides. Its `cloudIssue` then says why, and it's registered again, which the account takes
 *     only once its access holds.
 */

/** How often, besides when one of the account's runs was skipped, what it stopped firing is read. */
export const ISSUES_EVERY_MS = 5 * 60_000

/** The account's automations calls, through this Mac's device sign-in (`CloudAccount`). */
export interface AutomationCloudApi {
  deviceId(): Promise<string | undefined>
  register(automation: CloudAutomation): Promise<{ ok: true } | { conflict: string }>
  unregister(project: string, id: string): Promise<void>
  /** The registrations the account no longer fires, and why: a GitHub trigger whose access it found gone. */
  issues(): Promise<Array<{ project: string; id: string; issue: string }>>
  runs(after: number): Promise<{ runs: CloudRun[]; next: number }>
  claim(input: { project: string; id: string; occurrence: string; cause: CloudRun["cause"] }): Promise<CloudClaim>
  decline(input: { project: string; id: string; occurrence: string; why: string }): Promise<void>
  hook(input: { name: string; provider: "webhook" | "linear" | "sentry"; rotate?: boolean; secret?: string }): Promise<CloudHook>
}

/** A project's GitHub repository, as the account names it: its stable key, and what a cloud run clones. */
export interface ProjectRepository {
  key: string
  repository: { url: string; branch?: string }
}

export interface AutomationCloudDeps {
  /** The account's calls, while this Mac is signed in to one with the cloud; undefined otherwise. */
  api(): AutomationCloudApi | undefined
  automations: Automations
  store: AutomationStore
  /** The project's GitHub origin and the folder in it; undefined outside one. */
  repository(project: string): Promise<ProjectRepository | undefined>
  /** On while any automation here is registered: what the runs feed's job needs. */
  demand?: { set(on: boolean): void }
  /** What the person's rule for Fins number `rule` names now; undefined when they have no such rule. */
  ruleTarget?(rule: number): FinTarget | undefined
  /** A sync that couldn't reach the account is tried again after this long. */
  retryMs?: number
  /**
   * One host call to a cloud Thread's host, as this device, through the gateway. `passive`: a look that never wakes a
   * machine asleep (it answers at once that it sleeps, thrown here).
   */
  threadCall?(thread: string, channel: string, args: readonly JsonValue[], passive: boolean): Promise<JsonValue | undefined>
  now?(): number
}

/** How long after a cloud run ends its Thread's host is still asked for its agent's proposals. */
export const PROPOSALS_AFTER_RUN_MS = 60 * 60_000
const ForwardedSchema = z.array(AutomationProposalSchema).max(200)

/** `text` without its leading and trailing slashes, in one pass (a regular expression here backtracks on long runs of `/`). */
function trimSlashes(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && text[start] === "/") start++
  while (end > start && text[end - 1] === "/") end--
  return text.slice(start, end)
}

/** A project's stable key: `github.com/<owner>/<name>` lowercased, then the folder in the repository, if any. */
export function projectKey(githubUrl: string, prefix: string): string | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(githubUrl.trim())
  if (!match) return undefined
  const folder = trimSlashes(prefix.trim())
  return `github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}${folder ? `/${folder}` : ""}`
}

/** Whether the account holds one of its triggers: a cloud kind, or a schedule that runs in the cloud or not only here. */
export function wantsCloud(definition: AutomationDefinition): boolean {
  const { place, whenAway } = definition.start
  return definition.triggers.some((trigger) => triggerFiresInCloud(trigger) || (trigger.kind === "schedule" && (place === "cloud" || whenAway !== "queue")))
}

/** The triggers the account holds of a definition, as it reads them: a schedule and the cloud kinds, nothing of this Mac's own. */
function cloudTriggers(triggers: readonly AutomationTrigger[]): CloudTrigger[] {
  return triggers.flatMap((trigger): CloudTrigger[] => {
    switch (trigger.kind) {
      case "schedule":
      case "github":
      case "slack":
      case "linear":
      case "sentry":
      case "webhook":
        return [trigger]
      default:
        return []
    }
  })
}

/**
 * What this Mac registers of an automation that's on: with its start as a run here starts (harness, model, reasoning,
 * access, and its rule with what the rule names now, `ruled`), so its cloud Thread's host maps them the same way.
 */
export function registrationOf(definition: AutomationDefinition, local: AutomationLocal, project: ProjectRepository, now: number, ruled?: FinTarget): CloudAutomation {
  const { start, limits } = definition
  return CloudAutomationSchema.parse({
    project: project.key,
    id: definition.id,
    name: definition.name,
    fingerprint: automationFingerprint(definition),
    brief: automationBriefText(definition.prompt),
    repository: project.repository,
    start: {
      ...(start.harness && { harness: start.harness }),
      ...(start.model && { model: start.model }),
      ...(start.reasoning && { reasoning: start.reasoning }),
      ...(start.rule !== undefined && { rule: start.rule }),
      ...(ruled && { ruled }),
      access: start.access,
      place: start.place,
      whenAway: start.whenAway,
    },
    triggers: cloudTriggers(definition.triggers),
    limits: { overlap: limits.overlap, ...(limits.maxRunsPerDay !== undefined && { maxRunsPerDay: limits.maxRunsPerDay }), timeoutMin: limits.timeoutMin },
    enabledAt: local.enabledAt ?? now,
  })
}

const STATUS = {
  offered: "queued",
  queued: "queued",
  device: "fired",
  starting: "fired",
  fired: "fired",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  "failed-to-start": "failed-to-start",
} as const satisfies Record<CloudRun["status"], AutomationRunStatus>

/** The account's record of an occurrence as this Mac keeps it, under the Mac's project. */
export function cloudRunRecord(project: string, run: CloudRun, self?: string): AutomationRun {
  const elsewhere = run.status === "device" && run.place !== self
  const why = elsewhere ? "It runs on another of the account's devices." : run.status === "queued" ? (run.why ?? localWords("Waiting for its Mac to come back.")) : run.why
  return {
    occurrence: run.occurrence,
    automation: run.automation,
    project,
    clientKey: run.clientKey,
    cause: run.cause,
    status: elsewhere ? "skipped" : STATUS[run.status],
    at: run.at,
    ...(run.thread && { startedAt: run.at }),
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    ...(why && { why: why.slice(0, 2000) }),
    ...(run.runWhen && { runWhen: run.runWhen }),
    ...(run.thread && { thread: { conversation: run.conversation ?? run.clientKey, thread: run.thread, request: run.clientKey, place: "cloud" } }),
    ...(run.result && { result: run.result }),
    cloud: { seq: run.seq, ...(run.thread && { thread: run.thread }) },
  }
}

export class AutomationCloud {
  readonly #deps: AutomationCloudDeps
  #syncing: Promise<void> = Promise.resolve()
  #feeding: Promise<void> | undefined
  #issuesAt = Number.NEGATIVE_INFINITY
  #retry: NodeJS.Timeout | undefined

  constructor(deps: AutomationCloudDeps) {
    this.#deps = deps
  }

  /** What `Automations` asks before running an occurrence the account also holds. */
  readonly claims: AutomationClaims = {
    claim: async (project, run) => {
      const api = this.#deps.api()
      const registered = this.#registration(project, run.automation)
      if (!api || !registered) return { unreachable: !api ? localWords("this Mac isn't signed in to its cloud account") : "it isn't registered with the cloud account" }
      if (run.cause.kind !== "schedule" && run.cause.kind !== "event") return { claimed: true }
      const answer = await api.claim({ project: registered.key, id: run.automation, occurrence: run.occurrence, cause: run.cause })
      return answer.ok ? { claimed: true } : { held: answer.run }
    },
    decline: async (project, run, why) => {
      const api = this.#deps.api()
      const registered = this.#registration(project, run.automation)
      if (!api || !registered) return
      await api.decline({ project: registered.key, id: run.automation, occurrence: run.occurrence, why: why.slice(0, 2000) })
    },
    record: (project, run) => cloudRunRecord(project, run, this.#self),
  }

  #self: string | undefined

  #registration(project: string, id: string) {
    return this.#deps.store.cloudRegistrations().find((each) => each.project === project && each.id === id)
  }

  /**
   * Registers what should be, and takes back what shouldn't, for `project` or every project served and registered. One
   * sync at a time; one that couldn't reach the account is tried again shortly.
   */
  sync(project?: string): Promise<void> {
    this.#syncing = this.#syncing.then(() => this.#sync(project)).catch((error: Error) => {
      hostWarn("automations", "the cloud account's automations couldn't be brought up to date; tried again shortly", { error: error.message })
      clearTimeout(this.#retry)
      this.#retry = setTimeout(() => void this.sync(), this.#deps.retryMs ?? 60_000)
      this.#retry.unref?.()
    })
    return this.#syncing
  }

  async #sync(only?: string): Promise<void> {
    const api = this.#deps.api()
    if (!api) return
    const { automations, store } = this.#deps
    const registrations = store.cloudRegistrations()
    const projects = only !== undefined ? [only] : [...new Set([...automations.projects(), ...registrations.map((each) => each.project)])]
    for (const project of projects) {
      const reading = await automations.reading(project)
      const wanted = new Set<string>()
      for (const view of reading.automations) {
        const { definition, local } = view
        // Only what the person approved is registered: one never approved, or changed since, runs nowhere.
        const on = local.enabled && !local.paused && isApproved(local, view.fingerprint) && view.standing !== "paused" && view.standing !== "off"
        if (!on || !wantsCloud(definition)) continue
        wanted.add(definition.id)
        const repository = await this.#deps.repository(project)
        if (!repository) {
          await automations.setCloudRegistered(project, definition.id, { issue: "Its project has no GitHub origin, so the cloud account can't hold its triggers." })
          wanted.delete(definition.id)
          continue
        }
        const rule = definition.start.rule
        const ruled = rule === undefined ? undefined : this.#deps.ruleTarget?.(rule)
        if (rule !== undefined && !ruled) {
          // Never registered without what its rule names: its cloud run would start on something the rule doesn't say.
          await this.#unregister(api, project, definition.id)
          await automations.setCloudRegistered(project, definition.id, { issue: `It follows rule ${rule} for Fins, which you don't have now.` })
          wanted.delete(definition.id)
          continue
        }
        // What's registered changes with the definition and with what its rule names.
        const sent = ruled ? `${view.fingerprint}:${JSON.stringify(ruled)}` : view.fingerprint
        const held = this.#registration(project, definition.id)
        if (held && held.key === repository.key && held.fingerprint === sent && local.cloudRegistered) continue
        if (held && held.key !== repository.key) await api.unregister(held.key, definition.id)
        const answer = await api.register(registrationOf(definition, local, repository, Date.now(), ruled))
        if ("ok" in answer) {
          store.setCloudRegistration(project, definition.id, { key: repository.key, fingerprint: sent })
          await automations.setCloudRegistered(project, definition.id, { ok: true })
          hostLog("automations", "registered with the cloud account", { automation: definition.id })
        } else {
          store.setCloudRegistration(project, definition.id, undefined)
          await automations.setCloudRegistered(project, definition.id, { issue: answer.conflict })
          hostWarn("automations", "the cloud account wouldn't register an automation", { automation: definition.id, why: answer.conflict })
        }
      }
      for (const held of registrations.filter((each) => each.project === project && !wanted.has(each.id))) {
        await api.unregister(held.key, held.id)
        store.setCloudRegistration(project, held.id, undefined)
        await automations.setCloudRegistered(project, held.id, { off: true })
        hostLog("automations", "taken back from the cloud account", { automation: held.id })
      }
    }
    await store.save()
    this.#deps.demand?.set(store.cloudRegistrations().length > 0)
  }

  async #unregister(api: AutomationCloudApi, project: string, id: string): Promise<void> {
    const held = this.#registration(project, id)
    if (!held) return
    await api.unregister(held.key, id)
    this.#deps.store.setCloudRegistration(project, id, undefined)
  }

  /** Reads the account's runs on from the last this Mac took; one read at a time, a second joining it. */
  feed(): Promise<void> {
    this.#feeding ??= this.#feed().finally(() => {
      this.#feeding = undefined
    })
    return this.#feeding
  }

  async #feed(): Promise<void> {
    const api = this.#deps.api()
    if (!api) return
    const { store, automations } = this.#deps
    this.#self = await api.deviceId()
    let skipped = false
    for (let page = 0; page < 20; page++) {
      const after = store.cloudCursor()
      const { runs, next } = await api.runs(after)
      for (const run of runs) {
        if (run.status === "skipped") skipped = true
        const project = store.cloudRegistrations().find((each) => each.key === run.project && each.id === run.automation)?.project
        if (!project) continue
        try {
          if (run.status === "offered" && run.place !== undefined && run.place === this.#self) await automations.offered(project, run)
          else if (!(run.status === "device" && run.place === this.#self)) await automations.recordCloud(cloudRunRecord(project, run, this.#self))
        } catch (error) {
          hostWarn("automations", "a cloud run couldn't be taken here", { automation: run.automation, occurrence: run.occurrence, error: error instanceof Error ? error.message : String(error) })
        }
      }
      store.setCloudCursor(next)
      await store.save()
      if (!runs.length || next <= after) break
    }
    try {
      await this.#issues(api, skipped)
    } catch (error) {
      hostWarn("automations", "what the cloud account stopped firing couldn't be read", { error: error instanceof Error ? error.message : String(error) })
    }
    await this.#proposals()
  }

  /**
   * What the account stopped firing, said on this Mac: each registration it names is this Mac's no longer, its
   * `cloudIssue` saying why, and it's registered again (refused while its access is still gone, so the issue stays).
   */
  async #issues(api: AutomationCloudApi, skipped: boolean): Promise<void> {
    const now = this.#deps.now?.() ?? Date.now()
    if (!skipped && now - this.#issuesAt < ISSUES_EVERY_MS) return
    this.#issuesAt = now
    const issues = await api.issues()
    if (!issues.length) return
    const { store, automations } = this.#deps
    const again = new Set<string>()
    for (const held of store.cloudRegistrations()) {
      const issue = issues.find((each) => each.project === held.key && each.id === held.id)?.issue
      if (!issue) continue
      store.setCloudRegistration(held.project, held.id, undefined)
      await automations.setCloudRegistered(held.project, held.id, { issue })
      hostWarn("automations", "the cloud account stopped firing an automation", { automation: held.id, why: issue })
      again.add(held.project)
    }
    await store.save()
    for (const project of again) void this.sync(project)
  }

  /**
   * What a cloud run's agent proposed, read from its Thread's host while it works or soon after (a look that never wakes
   * its machine) and taken here, where the project's file is (`Automations.importForwarded`).
   */
  async #proposals(): Promise<void> {
    const call = this.#deps.threadCall
    if (!call) return
    const now = this.#deps.now?.() ?? Date.now()
    const asked = new Set<string>()
    for (const run of this.#deps.store.cloudThreads(now - PROPOSALS_AFTER_RUN_MS)) {
      const thread = run.cloud!.thread!
      if (asked.has(thread)) continue
      asked.add(thread)
      const answer = await call(thread, "mako:automations-forwarded", [], true).catch(() => undefined)
      const proposals = ForwardedSchema.safeParse(answer).data
      if (proposals?.length) await this.#deps.automations.importForwarded(run.project, thread, proposals)
    }
  }

  /** Tells a cloud Thread's host how a proposal forwarded from it went on this Mac (`Automations.#tell`). */
  readonly forward = {
    settle: async (thread: string, proposal: string, outcome: ForwardedOutcome): Promise<void> => {
      const call = this.#deps.threadCall
      if (!call) throw new Error(localWords("this Mac can't reach cloud Threads"))
      await call(thread, "mako:automations-forward-settle", [proposal, outcome], false)
    },
  }

  /** A webhook the account takes deliveries at, made or its secret rotated; the secret is shown this once. */
  async hook(name: string, provider: "webhook" | "linear" | "sentry" = "webhook", rotate?: boolean, secret?: string): Promise<{ name: string; provider: "webhook" | "linear" | "sentry"; url: string; secret?: string }> {
    const api = this.#deps.api()
    if (!api) throw new Error(localWords("This Mac isn't signed in to a Mako account with the cloud."))
    const made = await api.hook({ name, provider, ...(rotate && { rotate }), ...(secret && { secret }) })
    return { name: made.hook.name, provider: made.hook.provider, url: made.url, ...(made.secret && { secret: made.secret }) }
  }

  stop(): void {
    clearTimeout(this.#retry)
  }
}
