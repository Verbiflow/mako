import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { publishFile } from "../base/published-files.js"
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
 * what follows it (a run recorded before its Thread starts) awaits its write.
 */

const AutomationEntrySchema = z.object({
  local: AutomationLocalSchema,
  runs: z.array(AutomationRunSchema).default([]),
})
const ProjectEntrySchema = z.object({
  automations: z.record(z.string(), AutomationEntrySchema).default({}),
  /** When a window last had it open: a project with nothing on is let go after a while. */
  seenAt: z.number().optional(),
})
const StateSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), ProjectEntrySchema).default({}),
  proposals: z.array(AutomationProposalSchema).default([]),
})
type State = z.infer<typeof StateSchema>
type Entry = z.infer<typeof AutomationEntrySchema>

const OFF: AutomationLocal = { enabled: false, failures: 0 }
/** Decided proposals kept for their rows. */
const PROPOSALS_KEPT = 200

export class AutomationStore {
  readonly #path: string
  #state: State = { version: 1, projects: {}, proposals: [] }
  #writing: Promise<void> = Promise.resolve()
  #loaded: Promise<void> | undefined

  constructor(folder: string) {
    this.#path = join(folder, "state.json")
  }

  get path(): string {
    return this.#path
  }

  /** Reads the file once; a file that can't be read starts empty and says so in the log. */
  load(): Promise<void> {
    this.#loaded ??= readFile(this.#path, "utf8").then(
      (text) => {
        const parsed = StateSchema.safeParse(JSON.parse(text))
        if (parsed.success) this.#state = parsed.data
        else hostWarn("automations", "the automations state couldn't be read; starting empty", { error: parsed.error.message.slice(0, 400) })
      },
      (error: Error) => {
        if (!("code" in error && error.code === "ENOENT")) hostWarn("automations", "the automations state couldn't be read; starting empty", { error: error.message })
      }
    )
    return this.#loaded
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
    this.#entry(project, id).local = local
  }

  /** Forgets an automation that left the file, its runs included. */
  forget(project: string, id: string): void {
    const entry = this.#state.projects[project]
    if (entry) delete entry.automations[id]
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
  putRun(run: AutomationRun): void {
    const entry = this.#entry(run.project, run.automation)
    const others = entry.runs.filter((each) => each.occurrence !== run.occurrence)
    const was = entry.runs.findIndex((each) => each.occurrence === run.occurrence)
    entry.runs = was < 0 ? [run, ...others].slice(0, AUTOMATION_RUNS_KEPT) : entry.runs.map((each) => (each.occurrence === run.occurrence ? run : each))
  }

  /** Every run still under way, across every project. */
  active(): AutomationRun[] {
    return Object.values(this.#state.projects).flatMap((project) => Object.values(project.automations).flatMap((entry) => entry.runs.filter((run) => run.status === "fired" || run.status === "queued")))
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

  putProposal(proposal: AutomationProposal): void {
    const others = this.#state.proposals.filter((each) => each.id !== proposal.id)
    const pending = others.filter((each) => each.status === "pending")
    const decided = others.filter((each) => each.status !== "pending").slice(0, PROPOSALS_KEPT)
    this.#state.proposals = [proposal, ...pending, ...decided]
  }

  /** Writes what's held; resolves once this and every earlier change is on disk. */
  save(): Promise<void> {
    const text = `${JSON.stringify(this.#state)}\n`
    this.#writing = this.#writing.then(() => publishFile(this.#path, text, { mode: 0o600, dirMode: 0o700 })).catch((error: Error) => {
      hostWarn("automations", "the automations state couldn't be written", { error: error.message })
    })
    return this.#writing
  }

  #project(project: string) {
    const kept = this.#state.projects[project]
    if (kept) return kept
    const made: State["projects"][string] = { automations: {} }
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
