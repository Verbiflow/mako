import { copyFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { publishFile } from "../base/published-files.js"
import type { JsonValue } from "../contracts/json.js"
import { hostWarn } from "../base/host-log.js"
import {
  AUTOMATION_RUNS_KEPT,
  AutomationLocalSchema,
  AutomationProposalSchema,
  AutomationRunSchema,
  type AutomationLocal,
  type AutomationProposal,
  type AutomationRun,
} from "../contracts/automations.js"

/**
 * What this Mac keeps of every project's automations, in the host's data root: on or off, when each runs next, its run
 * records and the agents' proposals. Never in the project's file, which is shared: enabling is a local decision.
 *
 * One file, written whole and atomically (`publishFile`) after each change, in order; a change that must be kept before
 * what follows it (a run recorded before its Thread starts) awaits its write. Every record is held to its schema as it's
 * written (its words clamped to their room first), and read back one by one: a record that can't be read is passed over
 * and the rest kept, the file copied aside before anything is written over it, so one bad record never costs the rest.
 */

/** One automation: what this Mac keeps of it, and its run records, newest first. */
interface Entry {
  local: AutomationLocal
  runs: AutomationRun[]
}
/** One project: its automations by id, and when a window last had it open (one with nothing on is let go after a while). */
interface ProjectEntry {
  automations: Record<string, Entry>
  seenAt?: number
}
/** One automation this Mac registered with the cloud account, under the project's stable key and its fingerprint then. */
const CloudRegistrationSchema = z.object({ project: z.string(), id: z.string(), key: z.string(), fingerprint: z.string() })
export type CloudRegistration = z.infer<typeof CloudRegistrationSchema>
/** What `readState` kept of a file, and what it passed over. */
export interface StateReading {
  state: State
  dropped: string[]
}

/** The file: read record by record (`readState`), each held to its schema as it's written. */
interface State {
  version: 1
  projects: Record<string, ProjectEntry>
  proposals: AutomationProposal[]
  /** What this Mac told the cloud account (`AutomationCloud`): its registrations, and how far it read the runs. */
  cloud: { cursor: number; registrations: CloudRegistration[] }
}

const OFF: AutomationLocal = { enabled: false, failures: 0 }

const RecordSchema = z.record(z.string(), z.unknown())
const JsonSchema = z.json()
const UnknownListSchema = z.array(z.unknown())
const CursorSchema = z.number().int().nonnegative()
const NumberSchema = z.number()

/** A run's words clamped to the room its schema gives them: a gate's stderr or a Thread's reply can be any length. */
export function clampRun(run: AutomationRun): AutomationRun {
  return {
    ...run,
    ...(run.why !== undefined && { why: run.why.slice(0, 2000) }),
    ...(run.mergedInto !== undefined && { mergedInto: run.mergedInto.slice(0, 200) }),
    ...(run.runWhen && { runWhen: { ...run.runWhen, reason: run.runWhen.reason.slice(0, 400), ...(run.runWhen.model !== undefined && { model: run.runWhen.model.slice(0, 80) }) } }),
    ...(run.gate && { gate: { ...run.gate, ...(run.gate.key !== undefined && { key: run.gate.key.slice(0, 400) }) } }),
    ...(run.result && { result: { ...run.result, summary: run.result.summary.slice(0, 4000), ...(run.result.pullRequest !== undefined && { pullRequest: run.result.pullRequest.slice(0, 400) }) } }),
  }
}

/**
 * What's kept, read record by record: every project, automation, run, proposal and registration that reads is kept;
 * `dropped` names the rest. An automation whose own state can't be read is dropped whole, so it reads as off.
 */
export function readState(raw: JsonValue): StateReading {
  const dropped: string[] = []
  const state: State = { version: 1, projects: {}, proposals: [], cloud: { cursor: 0, registrations: [] } }
  const top = RecordSchema.safeParse(raw).data
  if (!top) return { state, dropped: ["the whole file: it isn't an object"] }
  for (const [project, value] of Object.entries(RecordSchema.safeParse(top.projects).data ?? {})) {
    const entry = RecordSchema.safeParse(value).data
    if (!entry) {
      dropped.push(`project ${project}`)
      continue
    }
    const seenAt = NumberSchema.safeParse(entry.seenAt).data
    const automations: Record<string, Entry> = {}
    for (const [id, held] of Object.entries(RecordSchema.safeParse(entry.automations).data ?? {})) {
      const record = RecordSchema.safeParse(held).data
      const local = AutomationLocalSchema.safeParse(record?.local)
      if (!local.success) {
        dropped.push(`automation ${id} in ${project}`)
        continue
      }
      const runs: AutomationRun[] = []
      for (const run of UnknownListSchema.safeParse(record?.runs).data ?? []) {
        const parsed = AutomationRunSchema.safeParse(run)
        if (parsed.success) runs.push(parsed.data)
        else dropped.push(`a run of ${id} in ${project}`)
      }
      automations[id] = { local: local.data, runs }
    }
    state.projects[project] = { automations, ...(seenAt !== undefined && { seenAt }) }
  }
  for (const proposal of UnknownListSchema.safeParse(top.proposals).data ?? []) {
    const parsed = AutomationProposalSchema.safeParse(proposal)
    if (parsed.success) state.proposals.push(parsed.data)
    else dropped.push("a proposal")
  }
  const cloud = RecordSchema.safeParse(top.cloud).data
  state.cloud.cursor = CursorSchema.safeParse(cloud?.cursor).data ?? 0
  for (const registration of UnknownListSchema.safeParse(cloud?.registrations).data ?? []) {
    const parsed = CloudRegistrationSchema.safeParse(registration)
    if (parsed.success) state.cloud.registrations.push(parsed.data)
    else dropped.push("a cloud registration")
  }
  return { state, dropped }
}
/** Decided proposals kept for their rows. */
const PROPOSALS_KEPT = 200

export class AutomationStore {
  readonly #path: string
  #state: State = { version: 1, projects: {}, proposals: [], cloud: { cursor: 0, registrations: [] } }
  /** Each run with a Thread, by that Thread's conversation: what `mako:automations-run-of` reads, however old. */
  #byConversation: Map<string, AutomationRun> | undefined
  #writing: Promise<void> = Promise.resolve()
  #loaded: Promise<void> | undefined
  /** The file exists but couldn't be read at all (not a missing one): nothing is written over it. */
  #unreadable = false

  constructor(folder: string) {
    this.#path = join(folder, "state.json")
  }

  get path(): string {
    return this.#path
  }

  /**
   * Reads the file once, record by record (`readState`). One with records that don't read, or that isn't JSON, is copied
   * aside first (`state.json.unread-<time>`), so what's written after never loses it; one that can't be read at all is
   * never written over. It always settles: a host that read nothing starts as one with nothing kept.
   */
  load(): Promise<void> {
    this.#loaded ??= (async () => {
      let text: string
      try {
        text = await readFile(this.#path, "utf8")
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return
        this.#unreadable = true
        hostWarn("automations", "the automations state couldn't be read; nothing is written over it", { error: error instanceof Error ? error.message : String(error) })
        return
      }
      let raw: JsonValue
      try {
        raw = JsonSchema.parse(JSON.parse(text))
      } catch (error) {
        await this.#quarantine(`it isn't JSON: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const { state, dropped } = readState(raw)
      this.#state = state
      this.#byConversation = undefined
      if (dropped.length) await this.#quarantine(`${dropped.length} record${dropped.length === 1 ? "" : "s"} didn't read: ${dropped.slice(0, 5).join(", ")}`)
    })()
    return this.#loaded
  }

  /** The file copied aside before anything is written over it; one that can't be copied is never written over. */
  async #quarantine(why: string): Promise<void> {
    const aside = `${this.#path}.unread-${Date.now()}`
    try {
      await copyFile(this.#path, aside)
      hostWarn("automations", "the automations state had records that couldn't be read; the file was copied aside, the rest kept", { why: why.slice(0, 400), aside })
    } catch (error) {
      this.#unreadable = true
      hostWarn("automations", "the automations state couldn't be copied aside; nothing is written over it", { why: why.slice(0, 400), error: error instanceof Error ? error.message : String(error) })
    }
  }

  projects(): string[] {
    return Object.keys(this.#state.projects)
  }

  /** Remembers a project a window opened. */
  seen(project: string, at: number): void {
    const entry = this.#project(project)
    entry.seenAt = at
  }

  local(project: string, id: string): AutomationLocal {
    return this.#state.projects[project]?.automations[id]?.local ?? OFF
  }

  setLocal(project: string, id: string, local: AutomationLocal): void {
    this.#entry(project, id).local = AutomationLocalSchema.parse({ ...local, ...(local.paused && { paused: { ...local.paused, reason: local.paused.reason.slice(0, 1000) } }), ...(local.cloudIssue !== undefined && { cloudIssue: local.cloudIssue.slice(0, 1000) }) })
  }

  /** Forgets an automation that left the file, its runs included. */
  forget(project: string, id: string): void {
    const entry = this.#state.projects[project]
    if (entry) delete entry.automations[id]
    this.#byConversation = undefined
  }

  ids(project: string): string[] {
    return Object.keys(this.#state.projects[project]?.automations ?? {})
  }

  /** Newest first. */
  runs(project: string, id: string): readonly AutomationRun[] {
    return this.#state.projects[project]?.automations[id]?.runs ?? []
  }

  run(project: string, id: string, occurrence: string): AutomationRun | undefined {
    return this.runs(project, id).find((run) => run.occurrence === occurrence)
  }

  /** Records a run, or its newer state: one record per occurrence, newest first. */
  putRun(given: AutomationRun): void {
    // Held to its schema as it's written: a record the next start couldn't read is never kept.
    const run = AutomationRunSchema.parse(clampRun(given))
    const entry = this.#entry(run.project, run.automation)
    const others = entry.runs.filter((each) => each.occurrence !== run.occurrence)
    const was = entry.runs.findIndex((each) => each.occurrence === run.occurrence)
    const dropped = was < 0 ? entry.runs.slice(AUTOMATION_RUNS_KEPT - 1) : []
    entry.runs = was < 0 ? [run, ...others].slice(0, AUTOMATION_RUNS_KEPT) : entry.runs.map((each) => (each.occurrence === run.occurrence ? run : each))
    if (!this.#byConversation) return
    for (const gone of dropped) if (gone.thread && this.#byConversation.get(gone.thread.conversation) === gone) this.#byConversation.delete(gone.thread.conversation)
    if (run.thread) this.#byConversation.set(run.thread.conversation, run)
  }

  /**
   * The newest run whose Thread is `conversation`, kept or settled, from an index built once and kept with each record. A
   * standing Thread is every run's: its newest is the one named.
   */
  runByConversation(conversation: string): AutomationRun | undefined {
    if (!this.#byConversation) {
      const index = new Map<string, AutomationRun>()
      const runs = Object.values(this.#state.projects).flatMap((project) => Object.values(project.automations).flatMap((entry) => entry.runs))
      for (const run of runs.sort((a, b) => a.at - b.at)) if (run.thread) index.set(run.thread.conversation, run)
      this.#byConversation = index
    }
    return this.#byConversation.get(conversation)
  }

  /** How far this Mac read the cloud account's runs. */
  cloudCursor(): number {
    return this.#state.cloud.cursor
  }

  setCloudCursor(cursor: number): void {
    this.#state.cloud.cursor = Math.max(this.#state.cloud.cursor, cursor)
  }

  /** What this Mac registered with the cloud account. */
  cloudRegistrations(): readonly CloudRegistration[] {
    return this.#state.cloud.registrations
  }

  /** Records a registration (`fingerprint`), or with `undefined` that it was taken back. */
  setCloudRegistration(project: string, id: string, registered: { key: string; fingerprint: string } | undefined): void {
    const others = this.#state.cloud.registrations.filter((each) => !(each.project === project && each.id === id))
    this.#state.cloud.registrations = registered ? [...others, { project, id, ...registered }] : others
  }

  /** Every run still under way, across every project. */
  active(): AutomationRun[] {
    return Object.values(this.#state.projects).flatMap((project) => Object.values(project.automations).flatMap((entry) => entry.runs.filter((run) => run.status === "fired" || run.status === "queued")))
  }

  /** Runs the cloud holds whose Thread works, or ended since `since`: the cloud Threads whose agents may have proposed something. */
  cloudThreads(since: number): AutomationRun[] {
    return Object.values(this.#state.projects).flatMap((project) => Object.values(project.automations).flatMap((entry) => entry.runs.filter((run) => run.cloud?.thread !== undefined && (run.status === "fired" || (run.endedAt ?? run.at) >= since))))
  }

  /** The run whose Thread is `conversation`. */
  runOf(conversation: string): AutomationRun | undefined {
    return this.active().find((run) => run.status === "fired" && run.thread?.conversation === conversation)
  }

  proposals(project?: string): readonly AutomationProposal[] {
    return project === undefined ? this.#state.proposals : this.#state.proposals.filter((proposal) => proposal.project === project)
  }

  proposal(id: string): AutomationProposal | undefined {
    return this.#state.proposals.find((proposal) => proposal.id === id)
  }

  putProposal(given: AutomationProposal): void {
    const proposal = AutomationProposalSchema.parse({ ...given, ...(given.why !== undefined && { why: given.why.slice(0, 2000) }), ...(given.note !== undefined && { note: given.note.slice(0, 1000) }) })
    const others = this.#state.proposals.filter((each) => each.id !== proposal.id)
    const pending = others.filter((each) => each.status === "pending")
    const decided = others.filter((each) => each.status !== "pending").slice(0, PROPOSALS_KEPT)
    this.#state.proposals = [proposal, ...pending, ...decided]
  }

  /** Writes what's held; resolves once this and every earlier change is on disk. */
  save(): Promise<void> {
    if (this.#unreadable) return this.#writing
    const text = `${JSON.stringify(this.#state)}\n`
    this.#writing = this.#writing.then(() => publishFile(this.#path, text, { mode: 0o600, dirMode: 0o700 })).catch((error: Error) => {
      hostWarn("automations", "the automations state couldn't be written", { error: error.message })
    })
    return this.#writing
  }

  #project(project: string) {
    const kept = this.#state.projects[project]
    if (kept) return kept
    const made: ProjectEntry = { automations: {} }
    this.#state.projects[project] = made
    return made
  }

  #entry(project: string, id: string): Entry {
    const automations = this.#project(project).automations
    const kept = automations[id]
    if (kept) return kept
    const made: Entry = { local: { ...OFF }, runs: [] }
    automations[id] = made
    return made
  }
}
